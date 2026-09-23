#!/bin/bash
# Expose the running CSKH service through a Cloudflare quick tunnel.
#
# The service must ALREADY be running under PM2 (only one writer may open the
# SQLite file). This script deliberately does NOT start a second instance:
#     pm2 start src/service.mjs --name page-cskh-webhook --interpreter node -- --config config.local.json
#
# Quick tunnels get a random *.trycloudflare.com hostname on every run, so after
# starting this, update Meta's webhook URL and publicWebhookUrl in the config.
set -euo pipefail
cd "$(dirname "$0")"

CONFIG="${1:-config.local.json}"
PORT=$(node -e "const c=require('./${CONFIG}');process.stdout.write(String(c.edgePort||29192))")

if ! ss -tln 2>/dev/null | grep -q "127.0.0.1:${PORT} "; then
  echo "Cảnh báo: không thấy listener trên 127.0.0.1:${PORT}."
  echo "Kiểm tra: pm2 status && ss -tlnp | grep :${PORT}"
fi

echo "Tunnel trỏ tới http://127.0.0.1:${PORT}"
exec cloudflared tunnel --url "http://127.0.0.1:${PORT}"
