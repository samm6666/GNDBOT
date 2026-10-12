#!/usr/bin/env bash
# Installs the GND Control agent on the VPS and starts it under pm2.
#   bash control/agent/setup.sh
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "pm2 is not installed (npm i -g pm2)" >&2
  exit 1
fi

npm ci --omit=dev --no-audit --no-fund

if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
fi
npm run --silent keygen

if pm2 describe gnd-control >/dev/null 2>&1; then
  pm2 restart gnd-control --update-env
else
  pm2 start src/index.js --name gnd-control --cwd "$PWD" --max-memory-restart 200M
fi
pm2 save

echo
echo "Agent is running under pm2 as gnd-control (port 7420)."
echo "Next: expose it through the reverse proxy (see control/README.md), then connect the desktop app."
