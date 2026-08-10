#!/bin/bash
# Redeploy after pushing new commits to GitHub. Run on the VPS.
set -euo pipefail
APP_DIR="/var/www/chimedis"

cd "$APP_DIR"
git pull origin main

cd "$APP_DIR/backend"
npm ci --omit=dev
node build-api.js || echo "Build skipped/failed — check .env and credentials.json"

pm2 reload chimedis-api

sudo nginx -t && sudo systemctl reload nginx

echo "==> Redeploy complete"
