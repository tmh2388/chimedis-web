/**
 * export-app-bundle.mjs <thư-mục-đích> — ghi các file giao diện của gói app (cùng danh sách + bundle-version.txt như
 * /app-bundle/bundle.zip) ra thư mục, dùng để làm www/ của repo chimedis-ios.
 * Usage: node export-app-bundle.mjs ../../chimedis-ios/www
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAppBundle } from './lib/app-bundle.js';
const out = process.argv[2];
if (!out) { console.error('Thiếu thư mục đích'); process.exit(1); }
const b = getAppBundle(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public'));
fs.rmSync(out, { recursive: true, force: true });
for (const [name, data] of b.files) { const p = path.join(out, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); }
console.log(`✅ ${b.files.length} file · phiên bản ${b.version} → ${out}`);
