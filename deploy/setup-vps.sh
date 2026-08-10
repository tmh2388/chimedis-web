#!/bin/bash
# One-time VPS provisioning for Chimedis (Ubuntu/Debian).
# Run as root or with sudo. Idempotent-ish: safe to re-run.
set -euo pipefail

DOMAIN="chimedis.vn"
REPO_URL="https://github.com/tmh2388/chimedis-web.git"
APP_DIR="/var/www/chimedis"

echo "==> Updating system packages"
apt-get update -y
apt-get install -y curl git nginx

if ! command -v node >/dev/null 2>&1; then
  echo "==> Installing Node.js 20 LTS"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "==> Installing PM2"
  npm install -g pm2
fi

echo "==> Cloning/updating repository"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull origin main
else
  git clone "$REPO_URL" "$APP_DIR"
fi

echo "==> Installing backend dependencies"
cd "$APP_DIR/backend"
npm ci --omit=dev

if [ ! -f "$APP_DIR/backend/.env" ]; then
  echo "!! $APP_DIR/backend/.env not found."
  echo "   Create it manually (see backend/.env.example) with real"
  echo "   GOOGLE_SHEETS_ID, GOOGLE_CREDENTIALS_JSON path, WEBHOOK_SECRET."
  echo "   Also place credentials.json in $APP_DIR/backend/."
  echo "   Skipping first build until that's done."
else
  echo "==> Building API from Google Sheets"
  node build-api.js || echo "Build failed — check .env and credentials.json"
fi

echo "==> Configuring Nginx"
cp "$APP_DIR/deploy/nginx-chimedis.conf" /etc/nginx/sites-available/chimedis.conf
ln -sf /etc/nginx/sites-available/chimedis.conf /etc/nginx/sites-enabled/chimedis.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "==> Starting backend with PM2"
cd "$APP_DIR"
pm2 startOrReload deploy/ecosystem.config.cjs
pm2 save
pm2 startup systemd -u "$(whoami)" --hp "$HOME" | tail -n 1 || true

echo "==> Setting up hourly Google Sheets sync via cron"
CRON_CMD="cd $APP_DIR/backend && /usr/bin/node build-api.js >> /var/log/chimedis-sync.log 2>&1"
( crontab -l 2>/dev/null | grep -v 'chimedis-sync' ; echo "0 * * * * $CRON_CMD # chimedis-sync" ) | crontab -

echo "==> Done. Next: point DNS A record for $DOMAIN to this server's IP,"
echo "    then run: certbot --nginx -d $DOMAIN -d www.$DOMAIN"
