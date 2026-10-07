/**
 * fix-acupoint-pinyin-class.mjs — sửa TẠI CHỖ trên MySQL (không dịch máy, không đọc Sheets):
 *  1. py: tính lại từ name_zh bằng toPinyin() đã bổ sung PINYIN_OVERRIDES (2026-10-07).
 *  2. special_class_zh/vi/en: khử nhãn lặp ("Bối du huyệt, Bối du huyệt" → 1 lần), 163 huyệt.
 * An toàn chạy lại (idempotent). Chạy: MYSQL_* node fix-acupoint-pinyin-class.mjs [--dry]
 */
import mysql from 'mysql2/promise';
import { toPinyin } from './import-acupoint-sheets.js';

const dry = process.argv.includes('--dry');
const conn = await mysql.createConnection({
  host: process.env.MYSQL_HOST, port: process.env.MYSQL_PORT || 3306,
  user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE,
});
const dedupe = (s, sep) => {
  if (!s) return s;
  const parts = s.split(/\s*[,，、]\s*/).filter(Boolean);
  return [...new Set(parts)].join(sep);
};
const [rows] = await conn.query('SELECT acupoint_id, name_zh, py, special_class_zh, special_class_vi, special_class_en FROM acupoints');
let pyChanged = 0, clsChanged = 0;
for (const r of rows) {
  const py = toPinyin(r.name_zh);
  const zh = dedupe(r.special_class_zh, '、');
  const vi = dedupe(r.special_class_vi, ', ');
  const en = dedupe(r.special_class_en, ', ');
  const pyDiff = py !== r.py;
  const clsDiff = zh !== r.special_class_zh || vi !== r.special_class_vi || en !== r.special_class_en;
  if (pyDiff) { pyChanged++; console.log(`py  ${r.acupoint_id} ${r.name_zh}: ${r.py} → ${py}`); }
  if (clsDiff) { clsChanged++; if (clsChanged <= 5) console.log(`cls ${r.acupoint_id}: ${r.special_class_vi} → ${vi}`); }
  if ((pyDiff || clsDiff) && !dry) {
    await conn.execute('UPDATE acupoints SET py=?, special_class_zh=?, special_class_vi=?, special_class_en=? WHERE acupoint_id=?', [py, zh, vi, en, r.acupoint_id]);
  }
}
console.log(`${dry ? '[DRY] ' : ''}py đổi: ${pyChanged} · special_class đổi: ${clsChanged} / ${rows.length}`);
await conn.end();
