/**
 * import-pathology-tcm-neike.mjs
 *
 * Nhập 61 bệnh chứng Trung Y Nội khoa từ Google Sheet "Bệnh Lý Trung Y (Nội khoa) - Workbook nhập liệu"
 * (id 18zyWAQcy2dXoZ_nqiri10MRcHm0JjKbTp7riySVTV6s, trích từ 中医内科学 第五版, do công cụ AI khác điền)
 * vào anatomy_terms (domain='Bệnh lý'). Ánh xạ cột → trường popup (nhãn Bệnh lý trong frontend PATHOLOGY_LABELS):
 *   definition → position (Định nghĩa) · etiology_pathogenesis → function (Bệnh nhân—Bệnh cơ)
 *   syndrome_differentiation → tcm_note (Thể bệnh/biện chứng) · symptoms_treatment → clinical (Triệu chứng & Pháp trị)
 * Nhóm (organ_system) theo chương sách: 肺系/心系/脑系/脾胃系/肝胆系/肾系/气血津液/肢体经络 病证.
 *
 * 20 bệnh chứng đã có sẵn từ đợt 1 (30 mục TCM viết tay từ kiến thức chung, term_id 'benh-…') → GHI ĐÈ đúng dòng đó
 * bằng nội dung trích từ sách (đầy đủ hơn nhiều: có 辨证分型 + 治法/方药), giữ nguyên term_id. Bệnh chứng mới → term_id = TCMNK-xxx.
 * Cố ý KHÔNG đụng 2.186 mục Tây y (term_id PATH-TERM-…); trùng tên với mục Tây y chỉ được BÁO CÁO.
 *
 * Kiểm tra bắt buộc (dừng nếu vi phạm — các lỗi từng gặp ở đợt Tây y): ô rỗng ở trường cốt lõi, placeholder
 * "NOT_VERIFIED", Hán Việt rỗng, cùng 1 câu zh dùng cho 2 trường.
 *
 * Env: GOOGLE_CREDENTIALS_JSON(_B64), MYSQL_HOST/USER/PASSWORD/DATABASE.   Usage: node import-pathology-tcm-neike.mjs [--dry]
 * --dry: chỉ đọc + kiểm tra + in kế hoạch, KHÔNG kết nối MySQL.
 */
import { google } from 'googleapis';
import mysql from 'mysql2/promise';
import { createGoogleAuth } from './google-auth.js';

const SPREADSHEET_ID = '18zyWAQcy2dXoZ_nqiri10MRcHm0JjKbTp7riySVTV6s';
const DRY = process.argv.includes('--dry');
const sheets = google.sheets({ version: 'v4', auth: createGoogleAuth(['https://www.googleapis.com/auth/spreadsheets.readonly']) });

const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const cnNum = (s) => (s === '十' ? 10 : s.startsWith('十') ? 10 + CN[s[1]] : s.length === 2 && s[1] === '十' ? CN[s[0]] * 10 : s.length === 2 ? 10 + CN[s[1]] : CN[s]);
const SYSTEMS = {
  4: ['肺系病证', 'Bệnh chứng Phế hệ', 'Lung-system disorders'],
  5: ['心系病证', 'Bệnh chứng Tâm hệ', 'Heart-system disorders'],
  6: ['脑系病证', 'Bệnh chứng Não hệ', 'Brain-system disorders'],
  7: ['脾胃系病证', 'Bệnh chứng Tỳ Vị hệ', 'Spleen-Stomach-system disorders'],
  8: ['肝胆系病证', 'Bệnh chứng Can Đởm hệ', 'Liver-Gallbladder-system disorders'],
  9: ['肾系病证', 'Bệnh chứng Thận hệ', 'Kidney-system disorders'],
  10: ['气血津液病证', 'Bệnh chứng Khí huyết tân dịch', 'Qi, blood and body-fluid disorders'],
  11: ['肢体经络病证', 'Bệnh chứng Chi thể kinh lạc', 'Limb and meridian disorders'],
};
const CORE = ['term_id', 'disease_zh', 'pinyin', 'disease_vi_hanviet', 'disease_en', 'chapter_ref',
  'definition_zh', 'definition_vi', 'definition_en', 'etiology_pathogenesis_zh', 'etiology_pathogenesis_vi', 'etiology_pathogenesis_en',
  'syndrome_differentiation_zh', 'syndrome_differentiation_vi', 'syndrome_differentiation_en',
  'symptoms_treatment_zh', 'symptoms_treatment_vi', 'symptoms_treatment_en'];

const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'pathology_tcm_terms!A:AZ' });
const v = res.data.values || [];
const head = v[0];
const rows = v.slice(1).filter((r) => r.some((c) => c)).map((r) => Object.fromEntries(head.map((k, i) => [k, (r[i] ?? '').trim()])));
console.log(`📖 ${rows.length} bệnh chứng`);

const errors = [];
for (const r of rows) {
  for (const k of CORE) if (!r[k]) errors.push(`${r.term_id}: thiếu ${k}`);
  for (const k of Object.keys(r)) if (/NOT_VERIFIED|TODO|TBD/.test(r[k])) errors.push(`${r.term_id}: placeholder ở ${k}`);
  const zhCols = ['definition_zh', 'etiology_pathogenesis_zh', 'syndrome_differentiation_zh', 'symptoms_treatment_zh'];
  for (let i = 0; i < zhCols.length; i++) for (let j = i + 1; j < zhCols.length; j++) if (r[zhCols[i]] && r[zhCols[i]] === r[zhCols[j]]) errors.push(`${r.term_id}: ${zhCols[i]} = ${zhCols[j]}`);
  const m = (r.chapter_ref.match(/第([一二三四五六七八九十]+)章/) || [])[1];
  r._sys = SYSTEMS[m ? cnNum(m) : 0];
  if (!r._sys) errors.push(`${r.term_id}: không nhận ra chương "${r.chapter_ref}"`);
}
if (new Set(rows.map((r) => r.disease_zh)).size !== rows.length) errors.push('trùng disease_zh trong workbook');
if (errors.length) { console.error('❌ Kiểm tra lỗi:\n  ' + errors.join('\n  ')); process.exit(1); }
const bySys = {};
for (const r of rows) bySys[r._sys[1]] = (bySys[r._sys[1]] || 0) + 1;
console.log('✅ Kiểm tra dữ liệu đạt. Theo nhóm:', bySys);

let conn = null, existing = new Map(), western = [];
if (!DRY) {
  conn = await mysql.createConnection({ host: process.env.MYSQL_HOST, port: process.env.MYSQL_PORT || 3306, user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE });
  const zh = rows.map((r) => r.disease_zh);
  const [ex] = await conn.query("SELECT term_id, hz FROM anatomy_terms WHERE domain='Bệnh lý' AND hz IN (?)", [zh]);
  for (const e of ex) {
    if (e.term_id.startsWith('benh-')) existing.set(e.hz, e.term_id);
    else if (e.term_id.startsWith('PATH-TERM-')) western.push(`${e.hz} (${e.term_id})`);
  }
  console.log(`🔗 Ghi đè ${existing.size} mục TCM viết tay cũ; trùng tên với mục Tây y (giữ cả hai): ${western.length ? western.join(', ') : 'không'}`);
}

const out = rows.map((r) => [
  existing.get(r.disease_zh) || r.term_id, 'Bệnh lý', r._sys[0], r._sys[1], r._sys[2],
  r.disease_zh, r.pinyin, r.disease_vi_hanviet, r.disease_en,
  r.definition_zh, r.definition_vi, r.definition_en,
  r.etiology_pathogenesis_zh, r.etiology_pathogenesis_vi, r.etiology_pathogenesis_en,
  r.syndrome_differentiation_zh, r.syndrome_differentiation_vi, r.syndrome_differentiation_en,
  r.symptoms_treatment_zh, r.symptoms_treatment_vi, r.symptoms_treatment_en,
  'HVYD Pathology TCM Workbook — trích 中医内科学 第五版 (中国中医药出版社), qua công cụ AI đọc+dịch',
  true, r.review_status !== 'REVIEWED', `${r.chapter_ref}; review_status nguồn=${r.review_status}`, true,
]);
if (DRY) { console.log('— DRY: không ghi MySQL. Mẫu dòng 1:', JSON.stringify(out[0]).slice(0, 400)); process.exit(0); }

await conn.query(
  `INSERT INTO anatomy_terms (term_id, domain, organ_system_zh, organ_system_vi, organ_system_en, hz, py, vi, en,
     position_zh, position_vi, position_en, function_zh, function_vi, function_en,
     tcm_note_zh, tcm_note_vi, tcm_note_en, clinical_zh, clinical_vi, clinical_en,
     source, machine_translated, verify, verify_note, is_active) VALUES ?
   ON DUPLICATE KEY UPDATE domain=VALUES(domain), organ_system_zh=VALUES(organ_system_zh), organ_system_vi=VALUES(organ_system_vi), organ_system_en=VALUES(organ_system_en),
     hz=VALUES(hz), py=VALUES(py), vi=VALUES(vi), en=VALUES(en),
     position_zh=VALUES(position_zh), position_vi=VALUES(position_vi), position_en=VALUES(position_en),
     function_zh=VALUES(function_zh), function_vi=VALUES(function_vi), function_en=VALUES(function_en),
     tcm_note_zh=VALUES(tcm_note_zh), tcm_note_vi=VALUES(tcm_note_vi), tcm_note_en=VALUES(tcm_note_en),
     clinical_zh=VALUES(clinical_zh), clinical_vi=VALUES(clinical_vi), clinical_en=VALUES(clinical_en),
     source=VALUES(source), machine_translated=VALUES(machine_translated), verify=VALUES(verify), verify_note=VALUES(verify_note), is_active=VALUES(is_active)`,
  [out]
);
await conn.execute(
  `INSERT INTO import_log (source_key, domain, spreadsheet_id, row_count) VALUES ('pathology_tcm_neike_v1', 'pathology', ?, ?)
   ON DUPLICATE KEY UPDATE spreadsheet_id=VALUES(spreadsheet_id), row_count=VALUES(row_count), imported_at=CURRENT_TIMESTAMP`,
  [SPREADSHEET_ID, out.length]
);
const [chk] = await conn.query("SELECT COUNT(*) n, SUM(tcm_note_vi IS NOT NULL AND tcm_note_vi<>'') syn FROM anatomy_terms WHERE source LIKE 'HVYD Pathology TCM Workbook%'");
console.log(`✨ Đã ghi ${out.length} bệnh chứng. Kiểm tra lại từ MySQL:`, chk[0]);
await conn.end();
