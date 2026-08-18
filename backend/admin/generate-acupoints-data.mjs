/**
 * generate-acupoints-data.mjs
 *
 * Regenerates admin/acupoints-data.js — the embedded (not fetched, so the
 * calibration tool works via plain file:// double-click too, no CORS issue)
 * dataset powering the "Kinh mạch → Huyệt" dropdown in atlas-calibrate.html.
 * Groups all acupoints by meridian_vi, sorted by sequence_number.
 *
 * Re-run this whenever `acupoints` MySQL data changes (new points, name/
 * location edits) so the calibration tool's dropdown stays in sync.
 *
 * Usage: MYSQL_HOST=... MYSQL_USER=... MYSQL_PASSWORD=... MYSQL_DATABASE=... node generate-acupoints-data.mjs
 */
import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ORDER_CODES = ['LU','LI','ST','SP','HT','SI','BL','KI','PC','SJ','TE','GB','LR','CV','GV'];

const conn = await mysql.createConnection({
  host: process.env.MYSQL_HOST,
  port: process.env.MYSQL_PORT || 3306,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
});

const [rows] = await conn.query(
  `SELECT acupoint_id, name_zh, name_vi, meridian_code, meridian_vi, sequence_number, location_text_vi
   FROM acupoints WHERE is_active = TRUE ORDER BY meridian_code, sequence_number`
);
await conn.end();

const groups = {};
const codeByMer = {};
for (const r of rows) {
  const mer = r.meridian_vi || 'Kỳ Huyệt';
  if (!codeByMer[mer]) codeByMer[mer] = r.meridian_code || 'ZZZ';
  (groups[mer] = groups[mer] || []).push({
    id: r.acupoint_id, vi: r.name_vi, zh: r.name_zh, seq: r.sequence_number,
    loc: (r.location_text_vi || '').slice(0, 60),
  });
}

function sortKey(mer) {
  const code = codeByMer[mer];
  if (ORDER_CODES.includes(code)) return [0, ORDER_CODES.indexOf(code)];
  if (mer === 'Kỳ Huyệt') return [2, 0];
  return [1, mer];
}
const sortedMers = Object.keys(groups).sort((a, b) => {
  const ka = sortKey(a), kb = sortKey(b);
  return ka[0] - kb[0] || (typeof ka[1] === 'string' ? ka[1].localeCompare(kb[1]) : ka[1] - kb[1]);
});

const out = {};
for (const mer of sortedMers) {
  out[mer] = groups[mer].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

const js = `// Tự sinh bởi generate-acupoints-data.mjs — KHÔNG sửa tay, chạy lại script khi acupoints đổi.\nconst ACUPOINTS_BY_MERIDIAN = ${JSON.stringify(out)};\n`;
fs.writeFileSync(path.join(__dirname, 'acupoints-data.js'), js, 'utf8');
console.log(`Đã ghi ${rows.length} huyệt / ${sortedMers.length} nhóm kinh mạch vào acupoints-data.js`);
