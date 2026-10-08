/**
 * app-bundle.js — gói giao diện cho app iOS/Android (live update).
 *
 * App Capacitor đóng gói SẴN giao diện (www/) để mở được khi mất mạng; khi có bản giao diện mới, app tải
 * gói này từ máy chủ (plugin @capgo/capacitor-updater, chế độ thủ công, KHÔNG dùng dịch vụ Capgo Cloud) và
 * áp dụng — không cần gửi App Store duyệt lại. Gói luôn được dựng từ ĐÚNG các file đang phục vụ ở backend/public,
 * nên sau mỗi lần Redeploy là app tự nhận bản mới, không có bước build thủ công nào để quên.
 *
 * Gói = các file giao diện (index.html, manifest, icon, favicon, privacy) + bundle-version.txt. KHÔNG gồm hình
 * (figures/), âm thanh (audio/) và service-worker.js — những thứ đó vẫn tải từ máy chủ / kho offline.
 * Zip tự viết bằng zlib (không thêm dependency): deflate + CRC32 chuẩn, index.html ở gốc zip.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';

const TOP_FILES = ['index.html', 'manifest.json', 'favicon.ico', 'privacy.html'];
const DIRS = ['icons'];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** Danh sách [tên-trong-gói, Buffer] của gói giao diện, thứ tự cố định (để băm ổn định). */
export function collectBundleFiles(publicDir) {
  const out = [];
  for (const f of TOP_FILES) {
    const p = path.join(publicDir, f);
    if (fs.existsSync(p)) out.push([f, fs.readFileSync(p)]);
  }
  for (const d of DIRS) {
    const dir = path.join(publicDir, d);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isFile()) out.push([`${d}/${f}`, fs.readFileSync(p)]);
    }
  }
  if (!out.some(([n]) => n === 'index.html')) throw new Error('Thiếu index.html trong ' + publicDir);
  return out;
}

/** Phiên bản = băm nội dung (semver hợp lệ: 1.0.<số>). Cùng nội dung → cùng phiên bản. */
export function bundleVersion(files) {
  const h = crypto.createHash('sha256');
  for (const [n, b] of files) { h.update(n); h.update('\0'); h.update(b); h.update('\0'); }
  return '1.0.' + (parseInt(h.digest('hex').slice(0, 7), 16) + 1);
}

function makeZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  const dosTime = 0, dosDate = (1 << 5) | 1 | ((2026 - 1980) << 9); // cố định để zip tất định
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

let cache = null;
/** Dựng (và nhớ) gói. Lỗi → ném ra để route trả 503, không làm sập server. */
export function getAppBundle(publicDir) {
  if (cache && cache.dir === publicDir) return cache;
  const files = collectBundleFiles(publicDir);
  const version = bundleVersion(files);
  const withVersion = [...files, ['bundle-version.txt', Buffer.from(version)]];
  cache = { dir: publicDir, version, zip: makeZip(withVersion), files: withVersion };
  return cache;
}

/** Gắn 2 route: /app-bundle/latest.json và /app-bundle/bundle.zip. */
export function mountAppBundle(app, publicDir, origin = 'https://dict.chimedis.vn') {
  app.get('/app-bundle/latest.json', (req, res) => {
    try {
      const b = getAppBundle(publicDir);
      res.set('Cache-Control', 'no-cache');
      res.json({ version: b.version, url: `${origin}/app-bundle/bundle.zip?v=${b.version}`, size: b.zip.length });
    } catch (e) { console.error('app-bundle:', e.message); res.status(503).json({ error: 'unavailable' }); }
  });
  app.get('/app-bundle/bundle.zip', (req, res) => {
    try {
      const b = getAppBundle(publicDir);
      res.set({ 'Content-Type': 'application/zip', 'Cache-Control': 'public, max-age=31536000, immutable' });
      res.send(b.zip);
    } catch (e) { console.error('app-bundle:', e.message); res.status(503).end(); }
  });
}
