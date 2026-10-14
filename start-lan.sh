#!/bin/sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required on the host computer. See README.md."
  echo "Install a maintained Node.js LTS release from the official Node.js website."
  exit 1
fi
node -e "if(Number(process.versions.node.split('.')[0])<18) process.exit(1)" || { echo "Node.js 18 or later is required."; exit 1; }
exec node server.cjs "$@"
