'use strict';
// Little Trouble LAN server. Node.js 18+, built-in modules only.
// The HTML contains the single shared physics engine; no client is authoritative.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { performance } = require('node:perf_hooks');

const PORT = Number(process.argv[2] || process.env.PORT || 8080);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('Use a port between 1 and 65535. Example: node server.cjs 8080');
  process.exit(1);
}
const source = fs.readFileSync(path.join(__dirname, 'worms-battle.html'), 'utf8');
const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!script || !script.includes('globalThis.LittleTroubleEngine')) {
  throw new Error('Keep the updated worms-battle.html beside server.cjs.');
}
const page = source.replace('const LAN_HOSTED = false;', 'const LAN_HOSTED = true;');
const rooms = new Map();
const addresses = [...new Set(Object.values(os.networkInterfaces()).flat()
  .filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address))];
const allowedHosts = new Set(['localhost', '127.0.0.1', ...addresses]);
const noop = () => {};
function engine() {
  const elements = {};
  const canvas = new Proxy({ measureText: s => ({ width: s.length * 6 }) }, {
    get: (o, k) => k in o ? o[k] : noop,
    set: (o, k, v) => { o[k] = v; return true; }
  });
  function element(id) {
    if (!elements[id]) elements[id] = {
      hidden: ['helpOverlay', 'winOverlay', 'lanOverlay', 'netBar', 'lanConnected', 'lanHostSettings'].includes(id),
      value: ({ teamCount: '2', difficulty: 'normal', turnTime: '45', lanTeams: '2', lanDifficulty: 'normal', lanTime: '45' })[id] || '',
      textContent: '', innerHTML: '', style: {}, tagName: id === 'arena' ? 'CANVAS' : 'BUTTON',
      classList: { toggle: noop }, setAttribute: noop, querySelectorAll: () => [],
      querySelector: () => ({ focus: noop }), focus: noop, getContext: () => canvas,
      setPointerCapture: noop, isConnected: true
    };
    return elements[id];
  }
  const document = {
    getElementById: element, createElement: () => element('offscreen'),
    activeElement: element('arena'), addEventListener: noop, querySelector: () => null
  };
  const context = {
    LITTLE_TROUBLE_HEADLESS: true, document,
    window: { addEventListener: noop }, matchMedia: () => ({ matches: true }),
    requestAnimationFrame: noop, setTimeout: noop, clearTimeout: noop,
    performance, console, Uint8Array, Math
  };
  vm.createContext(context);
  vm.runInContext(script, context, { timeout: 5000, filename: 'shared-game-engine.js' });
  return context.LittleTroubleEngine;
}
function fail(status, message) { const e = new Error(message); e.status = status; throw e; }
function nickname(name) { return typeof name === 'string' ? name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24) || 'Player' : 'Player'; }
function validSlots(slots) {
  if (!Array.isArray(slots) || slots.length < 2 || slots.length > 4 || slots.some(s => !['local', 'remote', 'bot'].includes(s))) fail(400, 'Choose 2 to 4 valid team controllers.');
  return slots.slice();
}
function newPlayer(room, name, host = false) {
  if (room.players.size >= 16) fail(409, 'This room is full, including spectators.');
  const p = { token: crypto.randomBytes(24).toString('hex'), name: nickname(name), host, lastSeen: Date.now() };
  room.players.set(p.token, p);
  if (host) room.hostToken = p.token;
  return p;
}
function seats(room) {
  const now = Date.now(), taken = new Set();
  room.owners.length = room.slots.length;
  room.slots.forEach((mode, i) => {
    if (mode === 'local') room.owners[i] = room.hostToken;
    else if (mode === 'bot') room.owners[i] = null;
    else {
      const owner = room.players.get(room.owners[i]);
      if (!owner || owner.host || now - owner.lastSeen >= 30000 || taken.has(owner.token)) room.owners[i] = null;
      else taken.add(owner.token);
    }
  });
  const waiting = [...room.players.values()].filter(p => !p.host && now - p.lastSeen < 5000 && !taken.has(p.token));
  room.slots.forEach((mode, i) => { if (mode === 'remote' && !room.owners[i] && waiting.length) room.owners[i] = waiting.shift().token; });
}
function pauseStatus(room) {
  if (!room.started) return { paused: true, reason: 'Waiting for the host to start.' };
  if (room.manualPause) return { paused: true, reason: 'The host has paused the match.' };
  const host = room.players.get(room.hostToken);
  if (!host || Date.now() - host.lastSeen > 5000) return { paused: true, reason: 'Host disconnected. Waiting for reconnection…' };
  for (let i = 0; i < room.slots.length; i++) {
    if (room.slots[i] !== 'remote') continue;
    // An eliminated team's disconnected player cannot block a surviving match.
    const state = room.engine.snapshot();
    if (state.phase !== 'setup' && !state.worms.some(w => w.team === i && w.hp > 0)) continue;
    const p = room.players.get(room.owners[i]);
    if (!p || Date.now() - p.lastSeen > 5000) return { paused: true, reason: 'Waiting for a LAN player to reconnect. Vacant seats reopen after 30 seconds.' };
  }
  return { paused: false, reason: '' };
}
function authenticate(roomCode, token) {
  const room = rooms.get(String(roomCode || '').toUpperCase());
  if (!room) fail(404, 'Room not found. Check the code or create a new room.');
  const player = room.players.get(token);
  if (!player) fail(401, 'Session expired. Leave this room and join again.');
  player.lastSeen = Date.now(); room.lastSeen = Date.now(); seats(room);
  return { room, player };
}
function publicState(room, player, revision) {
  const pause = pauseStatus(room);
  const current = room.engine.snapshot();
  const state = room.engine.snapshot(Number(revision) !== current.terrainRevision);
  return {
    room: room.code, host: player.host, matchId: room.matchId, slots: room.slots,
    myTeams: room.owners.flatMap((token, i) => token === player.token ? [i] : []),
    paused: pause.paused, pauseReason: pause.reason, manualPause: room.manualPause,
    players: [...room.players.values()].map(p => ({ name: p.name, host: p.host,
      connected: Date.now() - p.lastSeen < 5000,
      teams: room.owners.flatMap((token, i) => token === p.token ? [i] : []) })), state
  };
}
function validateInput(input) {
  if (!input || !Number.isFinite(input.angle) || !Number.isFinite(input.power) || ![-1, 0, 1].includes(input.dir) || !['bazooka', 'grenade'].includes(input.weapon)) fail(400, 'Invalid controls.');
  return { angle: Math.max(5, Math.min(175, input.angle)), power: Math.max(15, Math.min(100, input.power)), dir: input.dir, weapon: input.weapon };
}
function action(body) {
  const { room, player } = authenticate(body.room, body.token);
  const type = body.type, state = room.engine.snapshot();
  if (['start', 'configure', 'pause'].includes(type) && !player.host) fail(403, 'Only the host can change match settings.');
  if (type === 'configure') {
    if (room.started && state.phase !== 'over') fail(409, 'Wait for the match to finish before changing teams.');
    room.slots = validSlots(body.slots); seats(room); return { ok: true, slots: room.slots };
  }
  if (type === 'start') {
    if (room.started && state.phase !== 'over') fail(409, 'A match is already in progress.');
    const slots = validSlots(body.slots);
    if (!['easy', 'normal', 'hard'].includes(body.difficulty) || ![45, 60, 90].includes(body.turnLength)) fail(400, 'Invalid match settings.');
    room.slots = slots; seats(room);
    if (room.slots.some((s, i) => s === 'remote' && (!room.owners[i] || Date.now() - room.players.get(room.owners[i]).lastSeen > 5000))) fail(409, 'Each remote team needs an online player. Ask friends to join, or choose Host device / Computer bot.');
    room.engine.start({ slots, difficulty: body.difficulty, turnLength: body.turnLength });
    room.started = true; room.manualPause = false; room.matchId++; room.controlUntil = 0;
    return { ok: true };
  }
  if (type === 'pause') {
    room.manualPause = !room.manualPause; room.engine.stop(); return { ok: true };
  }
  if (!['controls', 'fire', 'skip', 'jump'].includes(type)) fail(400, 'Unknown action.');
  const stale = body.matchId !== room.matchId || body.turn !== state.turns || state.phase !== 'aim';
  if (stale) { if (type === 'controls') return { ok: false, stale: true }; fail(409, 'Your turn has changed. Try again on your next turn.'); }
  if (room.owners[state.teamIndex] !== player.token) fail(403, 'You can control only your own team on its turn.');
  if (pauseStatus(room).paused) { if (type === 'controls') return { ok: false, paused: true }; fail(409, 'The match is paused.'); }
  room.engine.input(validateInput(body.input)); room.controlUntil = Date.now() + 220;
  if (type !== 'controls') room.engine.act(type);
  return { ok: true };
}
async function readBody(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'Send JSON.');
  let body = '', size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 8192) fail(413, 'Request too large.'); body += chunk; }
  try { const data = JSON.parse(body); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(); return data; } catch { fail(400, 'Invalid JSON.'); }
}
function send(req, res, status, data, type = 'application/json; charset=utf-8') {
  if (res.destroyed) return;
  let buffer = Buffer.from(type.startsWith('application/json') ? JSON.stringify(data) : data);
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  if (type.startsWith('text/html')) headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'";
  if (buffer.length > 1000 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { buffer = zlib.gzipSync(buffer); headers['Content-Encoding'] = 'gzip'; headers.Vary = 'Accept-Encoding'; }
  headers['Content-Length'] = buffer.length; res.writeHead(status, headers); res.end(buffer);
}
const server = http.createServer(async (req, res) => {
  try {
    const host = (req.headers.host || '').split(':')[0].toLowerCase();
    if (!allowedHosts.has(host)) fail(403, 'Use localhost or a LAN address printed by this server.');
    if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) fail(403, 'Cross-origin access is not allowed.');
    const url = new URL(req.url, 'http://' + req.headers.host);
    if (req.method === 'GET' && ['/', '/worms-battle.html'].includes(url.pathname)) return send(req, res, 200, page, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const { room, player } = authenticate(url.searchParams.get('room'), url.searchParams.get('token'));
      return send(req, res, 200, publicState(room, player, url.searchParams.get('revision')));
    }
    if (req.method !== 'POST') fail(404, 'Not found.');
    const body = await readBody(req);
    if (url.pathname === '/api/create') {
      if (rooms.size >= 8) fail(503, 'This server has eight rooms already. Close an unused room.');
      let code; do { code = crypto.randomBytes(6).toString('hex').slice(0, 6).toUpperCase(); } while (rooms.has(code));
      const room = { code, engine: engine(), slots: ['local', 'remote'], owners: [], players: new Map(), started: false, manualPause: false, matchId: 0, lastSeen: Date.now(), controlUntil: 0 };
      const player = newPlayer(room, body.name, true); rooms.set(code, room); seats(room);
      return send(req, res, 201, { room: code, token: player.token, host: true, slots: room.slots });
    }
    if (url.pathname === '/api/join') {
      const room = rooms.get(String(body.room || '').toUpperCase());
      if (!room) fail(404, 'Room not found. Check the room code.');
      const player = newPlayer(room, body.name); seats(room);
      return send(req, res, 201, { room: room.code, token: player.token, host: false, slots: room.slots });
    }
    if (url.pathname === '/api/leave') {
      const { room, player } = authenticate(body.room, body.token);
      if (player.host) rooms.delete(room.code); else { room.players.delete(player.token); seats(room); }
      return send(req, res, 200, { ok: true });
    }
    if (url.pathname === '/api/action') return send(req, res, 200, action(body));
    fail(404, 'Not found.');
  } catch (error) {
    if (!error.status) console.error(error);
    send(req, res, error.status || 500, { error: error.status ? error.message : 'Server error. Check the server terminal.' });
  }
});
server.requestTimeout = 5000; server.headersTimeout = 7000;
let previousTick = performance.now();
setInterval(() => {
  const now = performance.now();
  // Bounded fixed-size substeps protect collision detection after an event-loop stall.
  let delta = Math.min(.12, (now - previousTick) / 1000); previousTick = now;
  for (const room of rooms.values()) {
    if (Date.now() - room.lastSeen > 30 * 60 * 1000) { rooms.delete(room.code); continue; }
    seats(room);
    if (!room.started || pauseStatus(room).paused || room.engine.snapshot().phase === 'over') { room.engine.stop(); continue; }
    if (Date.now() > room.controlUntil) room.engine.stop();
    let remaining = delta;
    while (remaining > 0) { const dt = Math.min(.02, remaining); room.engine.step(dt); remaining -= dt; }
  }
}, 20);
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${PORT} is busy. Try: node server.cjs ${PORT + 1}` : error.message); process.exit(1);
});
server.listen(PORT, '0.0.0.0', () => {
  console.log('\nLittle Trouble - LAN artillery club\n');
  console.log(`Host:    http://localhost:${PORT}`);
  for (const address of addresses) console.log(`Friends: http://${address}:${PORT}`);
  if (!addresses.length) console.log('No LAN address found. Connect to Wi-Fi/Ethernet first.');
  console.log('\nOpen the game, choose LAN play, create a room, then share its code.');
  console.log('Keep this terminal open. Ctrl+C stops the server.');
  console.log('Trusted private LAN only. No npm install needed.\n');
});
