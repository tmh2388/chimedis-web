/**
 * export-mt-review-sheet.js
 *
 * Xuất các trường đang dịch máy (MyMemory) ra Google Sheet để anh rà
 * soát/sửa tay thay vì tin máy dịch — thay cho việc thao tác trực tiếp
 * trên MySQL. Sau khi sửa xong trên Sheet, chạy import-mt-review-sheet.js
 * để nhập lại vào database.
 *
 * Sheet đích PHẢI do anh tự tạo trước (service account không có dung
 * lượng Drive riêng nên không thể tự tạo file mới — lỗi 403 nếu thử):
 *   1. Tạo 1 Google Sheet trống, đặt tên tuỳ ý.
 *   2. Share quyền Editor cho: chimedis-sheets-reader@chimedis-api.iam.gserviceaccount.com
 *   3. Copy ID sheet trong URL (đoạn giữa /d/ và /edit) → set MT_REVIEW_SPREADSHEET_ID.
 * Script tự tạo 2 tab "herbs_mt_review" / "anatomy_mt_review" trong sheet đó.
 *
 * Ghi vào 3 tab:
 *   - herbs_mt_review    (indication/dose/caution của 567 vị Dược liệu)
 *   - anatomy_mt_review  (position/function/tcm_note/clinical của 329
 *                         thuật ngữ Giải phẫu/Sinh lý)
 *   - acupoint_mt_review (location/indication EN của Huyệt vị — CHỈ EN, vì
 *                         zh/vi của Huyệt vị luôn là nội dung thật từ nguồn,
 *                         không bao giờ dịch máy — chỉ lọc huyệt có
 *                         en_machine_translated=TRUE, xem schema.sql)
 * Mỗi hàng = 1 thuật ngữ. Mỗi trường có 3 cột zh (nguồn, không sửa) / vi / en
 * (sửa trực tiếp ở đây). Cột "reviewed" cuối hàng: tick TRUE khi đã rà soát
 * xong hàng đó — import-mt-review-sheet.js dùng cột này để đánh dấu
 * machine_translated = FALSE cho Giải phẫu/Sinh lý (herbs không có cờ này).
 *
 * Required env vars:
 *   GOOGLE_CREDENTIALS_JSON / GOOGLE_CREDENTIALS_JSON_B64  (xem google-auth.js)
 *   MT_REVIEW_SPREADSHEET_ID   ID sheet đã tạo & share theo hướng dẫn trên
 *   MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
 *   MYSQL_PORT (optional, default 3306)
 *
 * Usage: node export-mt-review-sheet.js
 */
import { google } from 'googleapis';
import mysql from 'mysql2/promise';
import { createGoogleAuth } from './google-auth.js';

const spreadsheetId = process.env.MT_REVIEW_SPREADSHEET_ID;
if (!spreadsheetId) {
  console.error('Thiếu env var MT_REVIEW_SPREADSHEET_ID. Xem hướng dẫn tạo/share sheet ở đầu file này.');
  process.exit(1);
}

const auth = createGoogleAuth(['https://www.googleapis.com/auth/spreadsheets']);
const sheets = google.sheets({ version: 'v4', auth });

const HERB_FIELDS = [
  ['indication_text', 'Chủ trị'],
  ['dose_text', 'Liều dùng'],
  ['caution_text', 'Kiêng kỵ'],
];
const ANATOMY_FIELDS = [
  ['position', 'Vị trí'],
  ['function', 'Công năng'],
  ['tcm_note', 'Ghi chú Trung Y'],
  ['clinical', 'Lâm sàng'],
];
const ACUPOINT_FIELDS = [
  ['location_text', 'Vị trí'],
  ['indication_text', 'Chủ trị'],
];

function fieldHeaders(fields) {
  const h = [];
  for (const [key, label] of fields) h.push(`${label} (zh)`, `${label} (vi)`, `${label} (en)`);
  return h;
}

async function fetchHerbs(conn) {
  const cols = ['herb_id', 'name_zh', 'name_vi', ...HERB_FIELDS.flatMap(([k]) => [`${k}_zh`, `${k}_vi`, `${k}_en`])];
  const [rows] = await conn.query(`SELECT ${cols.join(',')} FROM herbs WHERE is_active = TRUE ORDER BY herb_id`);
  return rows;
}
async function fetchAnatomy(conn) {
  const cols = ['term_id', 'hz', 'vi', ...ANATOMY_FIELDS.flatMap(([k]) => [`${k}_zh`, `${k}_vi`, `${k}_en`])];
  const [rows] = await conn.query(`SELECT ${cols.join(',')} FROM anatomy_terms WHERE is_active = TRUE AND machine_translated = TRUE ORDER BY term_id`);
  return rows;
}
async function fetchAcupoints(conn) {
  const cols = ['acupoint_id', 'name_zh', 'name_vi', ...ACUPOINT_FIELDS.flatMap(([k]) => [`${k}_zh`, `${k}_vi`, `${k}_en`])];
  const [rows] = await conn.query(`SELECT ${cols.join(',')} FROM acupoints WHERE is_active = TRUE AND en_machine_translated = TRUE ORDER BY acupoint_id`);
  return rows;
}

function toSheetRows(rows, fields, idKey, zhNameKey, viNameKey) {
  return rows.map((r) => {
    const row = [r[idKey], r[zhNameKey], r[viNameKey] || ''];
    for (const [key] of fields) row.push(r[`${key}_zh`] || '', r[`${key}_vi`] || '', r[`${key}_en`] || '');
    row.push(false); // reviewed
    return row;
  });
}

async function writeTab(spreadsheetId, tabName, headerRow, dataRows) {
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabName}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [headerRow, ...dataRows] },
  });
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
  });

  console.log('Đang đọc dữ liệu từ MySQL...');
  const herbs = await fetchHerbs(conn);
  const anatomy = await fetchAnatomy(conn);
  const acupoints = await fetchAcupoints(conn);
  await conn.end();
  console.log(`  Dược liệu: ${herbs.length} hàng`);
  console.log(`  Giải phẫu/Sinh lý (machine_translated=TRUE): ${anatomy.length} hàng`);
  console.log(`  Huyệt vị (en_machine_translated=TRUE): ${acupoints.length} hàng`);

  console.log('Đang kiểm tra tab trong sheet...');
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existingTitles = meta.data.sheets.map((s) => s.properties.title);
  const wantedTabs = ['herbs_mt_review', 'anatomy_mt_review', 'acupoint_mt_review'];
  const missing = wantedTabs.filter((t) => !existingTitles.includes(t));
  if (missing.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) },
    });
  }

  await writeTab(
    spreadsheetId, 'herbs_mt_review',
    ['herb_id', 'Tên (zh)', 'Tên (vi)', ...fieldHeaders(HERB_FIELDS), 'reviewed'],
    toSheetRows(herbs, HERB_FIELDS, 'herb_id', 'name_zh', 'name_vi'),
  );
  await writeTab(
    spreadsheetId, 'anatomy_mt_review',
    ['term_id', 'Tên (zh)', 'Tên (vi)', ...fieldHeaders(ANATOMY_FIELDS), 'reviewed'],
    toSheetRows(anatomy, ANATOMY_FIELDS, 'term_id', 'hz', 'vi'),
  );
  await writeTab(
    spreadsheetId, 'acupoint_mt_review',
    ['acupoint_id', 'Tên (zh)', 'Tên (vi)', ...fieldHeaders(ACUPOINT_FIELDS), 'reviewed'],
    toSheetRows(acupoints, ACUPOINT_FIELDS, 'acupoint_id', 'name_zh', 'name_vi'),
  );

  console.log('\nXong! Mở sheet tại:');
  console.log(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);
}

main().catch((err) => { console.error(err); process.exit(1); });
