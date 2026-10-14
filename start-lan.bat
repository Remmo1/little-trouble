@echo off
setlocal
cd /d "%~dp0"
title Little Trouble - LAN Server
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required on the host computer.
  echo Install a maintained Node.js LTS release from the official Node.js website.
  echo See README.md for setup instructions.
  pause
  exit /b 1
)
node -e "if(Number(process.versions.node.split('.')[0])<18) process.exit(1)"
if errorlevel 1 (
  echo Node.js 18 or later is required.
  pause
  exit /b 1
)
node server.cjs
pause
