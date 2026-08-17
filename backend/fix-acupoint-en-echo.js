/**
 * fix-acupoint-en-echo.js
 *
 * One-off fix: import-acupoint-sheets.js's 2nd run today hit MyMemory rate
 * limiting, which returned the ORIGINAL Chinese text unchanged as a "200 OK"
 * translation (no error, no MYMEMORY WARNING string — just an untranslated
 * echo) for ~235/403 rows. translate.js now detects this
 * (isUntranslatedEcho), but this script re-translates only the already-
 * broken rows in MySQL rather than re-running the full import.
 *
 * Safe to re-run. Required env vars: same as import-acupoint-sheets.js
 * (minus Google Sheets ones — this only touches MySQL).
 */
import mysql from 'mysql2/promise';
import { translateBatch } from './translate.js';

function connect() {
  return mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
  });
}

let conn = await connect();
const [locRows] = await conn.query(
  `SELECT acupoint_id, location_text_zh FROM acupoints WHERE location_text_en = location_text_zh AND location_text_zh IS NOT NULL`
);
const [indRows] = await conn.query(
  `SELECT acupoint_id, indication_text_zh FROM acupoints WHERE indication_text_en = indication_text_zh AND indication_text_zh IS NOT NULL`
);
await conn.end();
console.log(`Cần dịch lại: vị trí ${locRows.length}, chủ trị ${indRows.length}`);

const progress = (label) => (done, total) => { if (done % 20 === 0 || done === total) console.log(`   ${label}: ${done}/${total}`); };
const [locEn, indEn] = await Promise.all([
  translateBatch(locRows.map((r) => r.location_text_zh), 'en', progress('vị trí→en')),
  translateBatch(indRows.map((r) => r.indication_text_zh), 'en', progress('chủ trị→en')),
]);

// Dịch mất nhiều phút (bị rate-limit, retry có backoff) — kết nối MySQL mở từ đầu
// có thể đã bị server đóng do idle timeout, mở kết nối MỚI trước khi ghi (phát hiện
// 2026-08-17: "Can't add new command when connection is in closed state").
conn = await connect();

let stillBroken = 0;
for (let i = 0; i < locRows.length; i++) {
  const en = locEn[i];
  if (!en || !/[a-zA-ZÀ-ỹ]/.test(en)) { stillBroken++; continue; }
  await conn.execute(`UPDATE acupoints SET location_text_en=?, en_machine_translated=TRUE WHERE acupoint_id=?`, [en, locRows[i].acupoint_id]);
}
for (let i = 0; i < indRows.length; i++) {
  const en = indEn[i];
  if (!en || !/[a-zA-ZÀ-ỹ]/.test(en)) { stillBroken++; continue; }
  await conn.execute(`UPDATE acupoints SET indication_text_en=?, en_machine_translated=TRUE WHERE acupoint_id=?`, [en, indRows[i].acupoint_id]);
}

await conn.end();
console.log(`\n✨ Xong. Vẫn còn lỗi (giữ nguyên, cần chạy lại sau): ${stillBroken}`);
