/**
 * import-mt-review-sheet.js
 *
 * Đọc Google Sheet đã rà soát (tạo bởi export-mt-review-sheet.js) và ghi
 * đè các cột vi/en đã sửa tay vào MySQL. Chỉ ghi các ô KHÔNG rỗng — bỏ
 * trống nghĩa là chưa xem lại, giữ nguyên bản dịch máy cũ. Hàng có cột
 * "reviewed" = TRUE thì đánh dấu machine_translated = FALSE cho thuật ngữ
 * đó (chỉ áp dụng cho Giải phẫu/Sinh lý — bảng herbs không có cờ này).
 *
 * Chạy nhiều lần an toàn (idempotent) — sheet vẫn giữ nguyên, chỉ cần sửa
 * tiếp và chạy lại để đồng bộ thêm.
 *
 * Required env vars:
 *   GOOGLE_CREDENTIALS_JSON / GOOGLE_CREDENTIALS_JSON_B64
 *   MT_REVIEW_SPREADSHEET_ID   ID sheet in ra từ export-mt-review-sheet.js
 *   MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
 *   MYSQL_PORT (optional, default 3306)
 *
 * Usage: node import-mt-review-sheet.js
 */
import { google } from 'googleapis';
import mysql from 'mysql2/promise';
import { createGoogleAuth } from './google-auth.js';

const spreadsheetId = process.env.MT_REVIEW_SPREADSHEET_ID;
if (!spreadsheetId) {
  console.error('Thiếu env var MT_REVIEW_SPREADSHEET_ID (ID sheet in ra từ export-mt-review-sheet.js).');
  process.exit(1);
}

const auth = createGoogleAuth(['https://www.googleapis.com/auth/spreadsheets.readonly']);
const sheets = google.sheets({ version: 'v4', auth });

const HERB_FIELDS = ['indication_text', 'dose_text', 'caution_text'];
const ANATOMY_FIELDS = ['position', 'function', 'tcm_note', 'clinical'];

function truthy(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'x' || s === 'yes';
}

async function readTab(tabName) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tabName}!A:Z` });
  const values = res.data.values || [];
  if (values.length < 2) return [];
  const headers = values[0];
  return values.slice(1)
    .filter((row) => row.some((c) => c !== undefined && c !== ''))
    .map((row) => { const o = {}; headers.forEach((h, i) => { o[h] = row[i]; }); return o; });
}

// Cột trong sheet là "Nhãn (vi)"/"Nhãn (en)" — parseRow đọc lại theo vị trí cố định
// (3 cột id/zh_name/vi_name, rồi bộ ba zh/vi/en cho mỗi field, rồi reviewed) thay vì
// tên cột, vì tên cột tiếng Việt có dấu khó khớp lại chính xác với field key.
function parseRow(rawRow, fieldKeys, idKey) {
  const values = Object.values(rawRow);
  const id = values[0];
  const out = { [idKey]: id };
  let i = 3; // bỏ qua id, tên(zh), tên(vi)
  for (const key of fieldKeys) {
    out[`${key}_vi`] = values[i + 1];
    out[`${key}_en`] = values[i + 2];
    i += 3;
  }
  out.reviewed = truthy(values[i]);
  return out;
}

async function importHerbs(conn) {
  const rows = (await readTab('herbs_mt_review')).map((r) => parseRow(r, HERB_FIELDS, 'herb_id'));
  let updated = 0;
  for (const row of rows) {
    const sets = [];
    const params = [];
    for (const key of HERB_FIELDS) {
      if (row[`${key}_vi`]) { sets.push(`${key}_vi = ?`); params.push(row[`${key}_vi`]); }
      if (row[`${key}_en`]) { sets.push(`${key}_en = ?`); params.push(row[`${key}_en`]); }
    }
    if (!sets.length) continue;
    params.push(row.herb_id);
    await conn.execute(`UPDATE herbs SET ${sets.join(', ')} WHERE herb_id = ?`, params);
    updated++;
  }
  console.log(`Dược liệu: cập nhật ${updated} hàng.`);
}

async function importAnatomy(conn) {
  const rows = (await readTab('anatomy_mt_review')).map((r) => parseRow(r, ANATOMY_FIELDS, 'term_id'));
  let updated = 0, markedReviewed = 0;
  for (const row of rows) {
    const sets = [];
    const params = [];
    for (const key of ANATOMY_FIELDS) {
      if (row[`${key}_vi`]) { sets.push(`${key}_vi = ?`); params.push(row[`${key}_vi`]); }
      if (row[`${key}_en`]) { sets.push(`${key}_en = ?`); params.push(row[`${key}_en`]); }
    }
    if (row.reviewed) { sets.push('machine_translated = FALSE'); markedReviewed++; }
    if (!sets.length) continue;
    params.push(row.term_id);
    await conn.execute(`UPDATE anatomy_terms SET ${sets.join(', ')} WHERE term_id = ?`, params);
    updated++;
  }
  console.log(`Giải phẫu/Sinh lý: cập nhật ${updated} hàng (${markedReviewed} đã đánh dấu reviewed).`);
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
  });
  await importHerbs(conn);
  await importAnatomy(conn);
  await conn.end();
  console.log('Xong.');
}

main().catch((err) => { console.error(err); process.exit(1); });
