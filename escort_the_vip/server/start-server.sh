#!/bin/bash
# Escort Game — Colyseus server startup script
# Used by systemd ExecStart or manual launch

set -e
cd "$(dirname "$0")"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Building server..."
npm run build

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting Colyseus server..."
exec node dist/main.js
