/**
 * sync-frontend.js
 * Copy frontend/ static assets into backend/public/ so a deploy that only
 * ships the backend/ directory (e.g. Hostinger Web App) still serves the PWA.
 * Run locally after editing frontend/, before committing.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'frontend');
const DEST = path.join(__dirname, 'public');

if (!fs.existsSync(SRC)) {
  console.log('ℹ️  Không tìm thấy ../frontend (bình thường nếu chỉ backend/ được deploy) — bỏ qua sync.');
  process.exit(0);
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

fs.mkdirSync(DEST, { recursive: true });
for (const entry of fs.readdirSync(SRC)) {
  copyRecursive(path.join(SRC, entry), path.join(DEST, entry));
}

console.log('✅ Đã đồng bộ frontend/ → backend/public/');
