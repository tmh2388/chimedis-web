/**
 * fix-mt-warning-herbs.js
 *
 * One-off repair: some herbs rows were imported before translate.js learned
 * to detect MyMemory's HTTP-200 quota-warning response, so the literal
 * warning string ("MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE
 * TRANSLATIONS...") got saved as the vi/en translation instead of falling
 * back to the Chinese source. This finds every affected cell and
 * re-translates just that field from its zh source — cheaper than a full
 * re-import since it skips rows that are already fine.
 *
 * Required env vars: MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
 *   (MYSQL_PORT optional), TRANSLATE_CONTACT_EMAIL (optional, raises MyMemory quota)
 *
 * Usage: node fix-mt-warning-herbs.js
 */
import mysql from 'mysql2/promise';
import { translateBatch } from './translate.js';

const FIELDS = ['indication_text', 'dose_text', 'caution_text'];
const WARNING_RE = /MYMEMORY WARNING|QUOTA|LIMIT/i;

// Pool (không phải 1 connection đơn) để tự động lấy connection mới nếu cái cũ bị
// host drop giữa lúc dịch (đã gặp ECONNRESET vì batch dịch 253 câu mất vài phút,
// lâu hơn wait_timeout của MySQL). update() dưới đây còn tự retry 1 lần nếu lỗi.
async function updateWithRetry(pool, sql, params) {
  try {
    await pool.execute(sql, params);
  } catch (err) {
    console.warn(`   ⚠️  Ghi lỗi, thử lại: ${err.message}`);
    await pool.execute(sql, params);
  }
}

async function main() {
  const pool = mysql.createPool({
    host: process.env.MYSQL_HOST,
    port: process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    connectionLimit: 5,
  });

  const cols = ['herb_id', ...FIELDS.flatMap((f) => [`${f}_zh`, `${f}_vi`, `${f}_en`])];
  const [rows] = await pool.query(`SELECT ${cols.join(',')} FROM herbs`);

  for (const target of ['vi', 'en']) {
    for (const field of FIELDS) {
      const affected = rows.filter((r) => WARNING_RE.test(r[`${field}_${target}`] || ''));
      if (!affected.length) continue;
      console.log(`${field}_${target}: ${affected.length} hàng cần dịch lại...`);
      const zhTexts = affected.map((r) => r[`${field}_zh`]);
      const translated = await translateBatch(zhTexts, target, (done, total) => {
        process.stdout.write(`\r  ${done}/${total}`);
      });
      process.stdout.write('\n');
      for (let i = 0; i < affected.length; i++) {
        await updateWithRetry(pool, `UPDATE herbs SET ${field}_${target} = ? WHERE herb_id = ?`, [translated[i], affected[i].herb_id]);
      }
      console.log(`  ✅ Đã ghi xong ${field}_${target}`);
    }
  }

  await pool.end();
  console.log('Xong.');
}

main().catch((err) => { console.error(err); process.exit(1); });
