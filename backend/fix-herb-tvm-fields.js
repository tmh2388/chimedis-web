/**
 * fix-herb-tvm-fields.js
 *
 * One-off repair for existing herbs rows (does NOT need Google Sheets —
 * reconstructs from the already-stored temperature_zh/taste_zh/meridian_zh
 * text, which is reliable for taste/meridian and mostly reliable for
 * temperature except 2 codes that fell through the old label map):
 *
 * 1. Fixes temperature_zh/temperature_vi that got stuck as the raw source
 *    code ('WEI_HAN'/'WEI_WEN') instead of the decoded Chinese label — the
 *    old TEMPERATURE_LABELS map in import-herbal-sheets.js only had the
 *    no-underscore spelling (WEIHAN/WEIWEN), so the underscored variant used
 *    by some Sheet rows fell through to "keep the code as-is" (28 rows).
 * 2. Backfills temperature_en/taste_en/meridian_en, which never existed in
 *    the schema before (schema.sql updated 2026-08-11 to add these columns —
 *    run that ALTER/CREATE first) — every herb needs this, not just the 28
 *    broken ones.
 *
 * Safe to re-run. Required env vars: MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD,
 * MYSQL_DATABASE (MYSQL_PORT optional).
 *
 * Usage: node fix-herb-tvm-fields.js
 */
import mysql from 'mysql2/promise';

// [zh, vi, en] — chỉ cần liệt kê 1 lần cho mỗi khái niệm, script tự build
// reverse-lookup theo cả zh THẬT lẫn mã thô còn sót (WEI_HAN kiểu cũ).
const TEMPERATURE = [
  ['寒', 'Hàn', 'Cold'], ['微寒', 'Hơi hàn', 'Slightly cold'], ['凉', 'Lương', 'Cool'],
  ['平', 'Bình', 'Neutral'], ['温', 'Ôn', 'Warm'], ['微温', 'Hơi ôn', 'Slightly warm'],
  ['热', 'Nhiệt', 'Hot'], ['大热', 'Đại nhiệt', 'Very hot'], ['大寒', 'Đại hàn', 'Extremely cold'],
];
// Âm Hán Việt chuẩn TCM (không phải nghĩa thường) — sửa 2026-08-19, xem
// TASTE_LABELS trong import-herbal-sheets.js + project_chimedis_translation_qa.
const TASTE = [
  ['辛', 'Tân', 'Pungent'], ['甘', 'Cam', 'Sweet'], ['苦', 'Khổ', 'Bitter'],
  ['酸', 'Toan', 'Sour'], ['咸', 'Hàm', 'Salty'], ['淡', 'Đạm', 'Bland'], ['涩', 'Sáp', 'Astringent'],
  ['微辛', 'Hơi tân', 'Slightly pungent'], ['微甘', 'Hơi cam', 'Slightly sweet'],
  ['微苦', 'Hơi khổ', 'Slightly bitter'], ['微酸', 'Hơi toan', 'Slightly sour'],
];
const MERIDIAN = [
  ['肺', 'Phế', 'Lung'], ['心', 'Tâm', 'Heart'], ['脾', 'Tỳ', 'Spleen'], ['肝', 'Can', 'Liver'],
  ['肾', 'Thận', 'Kidney'], ['胃', 'Vị', 'Stomach'], ['胆', 'Đởm', 'Gallbladder'],
  ['大肠', 'Đại trường', 'Large intestine'], ['小肠', 'Tiểu trường', 'Small intestine'],
  ['膀胱', 'Bàng quang', 'Bladder'], ['三焦', 'Tam tiêu', 'Triple burner'], ['心包', 'Tâm bào', 'Pericardium'],
];
// Mã thô còn sót trong DB (bug cũ) — ánh xạ thẳng sang [zh, vi, en] đúng.
const RAW_CODE_FIXES = {
  WEI_HAN: ['微寒', 'Hơi hàn', 'Slightly cold'],
  WEI_WEN: ['微温', 'Hơi ôn', 'Slightly warm'],
};

function buildLookup(list) {
  const byZh = new Map(list.map(([zh, vi, en]) => [zh, [zh, vi, en]]));
  return (token) => byZh.get(token) || RAW_CODE_FIXES[token] || null;
}
const lookupTemperature = buildLookup(TEMPERATURE);
const lookupTaste = buildLookup(TASTE);
const lookupMeridian = buildLookup(MERIDIAN);

// Tách theo '、', tra từng token, ghép lại — token nào không nhận diện được
// thì giữ nguyên nhưng CẢNH BÁO ra console để anh biết cần bổ sung tay.
function rebuild(zhField, lookup, herbId, label) {
  if (!zhField) return { zh: null, vi: null, en: null };
  const tokens = zhField.split('、').map((s) => s.trim()).filter(Boolean);
  const zh = [], vi = [], en = [];
  for (const tok of tokens) {
    const found = lookup(tok);
    if (found) {
      zh.push(found[0]); vi.push(found[1]); en.push(found[2]);
    } else {
      console.warn(`   ⚠️  ${herbId}: không nhận diện được mã "${tok}" (${label}) — giữ nguyên, cần anh xác nhận nghĩa.`);
      zh.push(tok); vi.push(tok); en.push(tok);
    }
  }
  return { zh: zh.join('、'), vi: vi.join(', '), en: en.join(', ') };
}

// Pool thay vì 1 connection đơn — tự lấy connection mới nếu cái cũ rớt giữa
// chừng (đã gặp ENETDOWN/ECONNRESET khi chạy 567 UPDATE tuần tự). Mỗi UPDATE
// còn tự retry 1 lần nếu lỗi.
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

  const [rows] = await pool.query('SELECT herb_id, temperature_zh, taste_zh, meridian_zh FROM herbs');
  console.log(`📖 Đang xử lý ${rows.length} vị thuốc...`);

  let updated = 0;
  for (const r of rows) {
    const temp = rebuild(r.temperature_zh, lookupTemperature, r.herb_id, 'tính');
    const taste = rebuild(r.taste_zh, lookupTaste, r.herb_id, 'vị');
    const meridian = rebuild(r.meridian_zh, lookupMeridian, r.herb_id, 'quy kinh');
    await updateWithRetry(pool,
      `UPDATE herbs SET
         temperature_zh=?, temperature_vi=?, temperature_en=?,
         taste_zh=?, taste_vi=?, taste_en=?,
         meridian_zh=?, meridian_vi=?, meridian_en=?
       WHERE herb_id=?`,
      [temp.zh, temp.vi, temp.en, taste.zh, taste.vi, taste.en, meridian.zh, meridian.vi, meridian.en, r.herb_id]
    );
    updated++;
    if (updated % 100 === 0) console.log(`   ${updated}/${rows.length}`);
  }

  await pool.end();
  console.log(`✅ Đã cập nhật ${updated} vị thuốc (tính/vị/quy kinh, đủ 3 ngôn ngữ).`);
}

main().catch((err) => { console.error(err); process.exit(1); });
