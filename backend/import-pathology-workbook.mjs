/**
 * import-pathology-workbook.mjs
 *
 * Nhập 2.156 thuật ngữ Bệnh Lý từ Google Sheet "Bệnh Lý - Workbook nhập liệu"
 * (id 1_CdWvjAuc2cv20iPTrSkU64hXD-8-aJOO6gy4u6DfuE, do 1 công cụ AI khác điền
 * từ sách 内科学 第5版 2021, theo prompt docs/pathology-extraction-prompt.md)
 * vào bảng anatomy_terms (domain='Bệnh lý'), CỘNG THÊM (không xoá) 30 mục TCM
 * cổ điển đã có từ đợt 1 (pathology-raw.json) — 2 bộ khác register (Tây y
 * hiện đại vs TCM cổ điển), không xung đột term_id.
 *
 * organ_system suy ra từ SỐ CHƯƠNG (第N章) trong pathology_term_occurrences,
 * theo đúng 9 phần của sách (đã xác nhận qua mục lục OCR trước đó):
 *   1-12=呼吸 13-20=循环 21-32=消化 33-37=泌尿 38-44=血液
 *   45-52=内分泌 53-55=风湿 56-60=神经 61-65=理化损伤
 *
 * vi = term_vi_hanviet nếu có, else term_vi_standard (quyết định user 2026-08-19
 * vì cột hanviet trống 100% — toàn bộ dataset là WESTERN_MEDICINE, term_vi_standard
 * đã là tiếng Việt y khoa chuẩn phù hợp).
 *
 * Required env vars: MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
 * Usage: node import-pathology-workbook.mjs
 */
import { google } from 'googleapis';
import mysql from 'mysql2/promise';
import { createGoogleAuth } from './google-auth.js';

const SPREADSHEET_ID = '1_CdWvjAuc2cv20iPTrSkU64hXD-8-aJOO6gy4u6DfuE';

const auth = createGoogleAuth(['https://www.googleapis.com/auth/spreadsheets.readonly']);
const sheets = google.sheets({ version: 'v4', auth });

async function readTab(tab) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${tab}!A:Z` });
  const values = res.data.values || [];
  if (values.length < 2) return [];
  const headers = values[0];
  return values.slice(1)
    .filter((r) => r.some((c) => c !== undefined && c !== ''))
    .map((r) => { const o = {}; headers.forEach((h, i) => { o[h] = r[i] ?? ''; }); return o; });
}

// "第三十三章" -> 33 (chỉ cần số Hán từ 1-99, đủ dùng cho 65 chương của sách này)
const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnNumToInt(s) {
  if (!s.includes('十')) return CN_DIGIT[s] ?? null;
  const [tensPart, onesPart] = s.split('十');
  const tens = tensPart === '' ? 1 : (CN_DIGIT[tensPart] ?? 0);
  const ones = onesPart === '' ? 0 : (CN_DIGIT[onesPart] ?? 0);
  return tens * 10 + ones;
}
function chapterNumber(chapterStr) {
  const m = (chapterStr || '').match(/第([零一二三四五六七八九十]+)章/);
  if (!m) return null;
  return cnNumToInt(m[1]);
}
function organSystemFor(chNum) {
  if (chNum == null) return ['内科学杂项', 'Nội khoa (chưa phân loại)', 'Internal Medicine (unclassified)'];
  if (chNum <= 12) return ['呼吸系统', 'Hệ hô hấp', 'Respiratory system'];
  if (chNum <= 20) return ['循环系统', 'Hệ tuần hoàn', 'Circulatory system'];
  if (chNum <= 32) return ['消化系统', 'Hệ tiêu hoá', 'Digestive system'];
  if (chNum <= 37) return ['泌尿系统', 'Hệ tiết niệu', 'Urinary system'];
  if (chNum <= 44) return ['血液系统', 'Hệ huyết học', 'Hematologic system'];
  if (chNum <= 52) return ['内分泌及代谢', 'Nội tiết & Chuyển hoá', 'Endocrine & Metabolic'];
  if (chNum <= 55) return ['风湿性疾病', 'Thấp khớp', 'Rheumatic diseases'];
  if (chNum <= 60) return ['神经系统', 'Hệ thần kinh', 'Nervous system'];
  return ['理化损伤性疾病', 'Tổn thương lý hoá', 'Physical & Chemical Injuries'];
}

async function main() {
  console.log('📖 Đọc workbook...');
  const [terms, occurrences] = await Promise.all([
    readTab('pathology_terms'),
    readTab('pathology_term_occurrences'),
  ]);
  console.log(`   terms=${terms.length} occurrences=${occurrences.length}`);

  // term_id -> số chương của occurrence ĐẦU TIÊN gặp (đủ dùng để phân nhóm hệ cơ quan)
  const chapterByTermId = new Map();
  for (const o of occurrences) {
    if (!chapterByTermId.has(o.term_id)) chapterByTermId.set(o.term_id, chapterNumber(o.chapter));
  }

  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
  });

  // Bản cập nhật lần 2 của workbook (sau yêu cầu xử lý lại, xem docs/pathology-workbook-assessment.md)
  // đã điền context_note cho mọi dòng DISEASE, NHƯNG 229/399 dòng công cụ tự chèn placeholder nội
  // bộ "NOT_VERIFIED — Đoạn nguồn hiện liên kết với thuật ngữ này chỉ hỗ trợ..." thay vì để trống
  // khi không đủ bằng chứng nguồn — đây là ghi chú QA của công cụ, KHÔNG phải nội dung y khoa, và
  // từ khi bỏ badge "cần rà soát" khỏi UI (chimedis-web@97a6c5f) thì không còn cảnh báo nào che
  // chắn nếu lọt ra production. Coi các dòng này như trống (giữ đúng tinh thần quyết định trước
  // "để trống nếu chưa có") thay vì nhập nguyên văn placeholder vào field function hiển thị cho user.
  const isPlaceholder = (s) => typeof s === 'string' && s.startsWith('NOT_VERIFIED');
  const clean = (s) => (isPlaceholder(s) ? null : (s || null));

  const rows = terms.map((t) => {
    const [sysZh, sysVi, sysEn] = organSystemFor(chapterByTermId.get(t.term_id));
    const vi = t.term_vi_hanviet || t.term_vi_standard || null;
    return [
      t.term_id, 'Bệnh lý', sysZh, sysVi, sysEn,
      t.term_zh, t.pinyin || null, vi, t.term_en || null,
      t.definition_short_zh || null, t.definition_short_vi || null, t.definition_short_en || null, // position=Định nghĩa
      clean(t.context_note_zh), clean(t.context_note_vi), clean(t.context_note_en), // function=Bệnh nhân-Bệnh cơ
      null, null, null, // tcm_note=Thể bệnh — chưa có dữ liệu
      null, null, null, // clinical=Triệu chứng&Pháp trị — chưa có dữ liệu
      'HVYD Pathology Workbook — trích 内科学 第5版 (中国中医药出版社, 2021), qua công cụ AI đọc+dịch, CHƯA rà soát tay',
      true, // machine_translated — dịch bởi công cụ AI khác, chưa xác thực
      true, // verify — cần Hạ Vân Y Đạo rà soát
      `term_type=${t.term_type}; review_status nguồn=${t.review_status}. Định nghĩa/bệnh cơ có thể trống — xem pathology_term_occurrences trong Sheet gốc để tra trích dẫn nguyên văn nếu cần đối chiếu.`,
      true,
    ];
  });

  console.log(`📝 Ghi ${rows.length} thuật ngữ vào MySQL...`);
  // Chia batch 300 dòng/lần tránh gói tin quá lớn.
  const BATCH = 300;
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await conn.query(
      `INSERT INTO anatomy_terms (
         term_id, domain, organ_system_zh, organ_system_vi, organ_system_en,
         hz, py, vi, en,
         position_zh, position_vi, position_en,
         function_zh, function_vi, function_en,
         tcm_note_zh, tcm_note_vi, tcm_note_en,
         clinical_zh, clinical_vi, clinical_en,
         source, machine_translated, verify, verify_note, is_active
       ) VALUES ?
       ON DUPLICATE KEY UPDATE
         domain=VALUES(domain), organ_system_zh=VALUES(organ_system_zh), organ_system_vi=VALUES(organ_system_vi), organ_system_en=VALUES(organ_system_en),
         hz=VALUES(hz), py=VALUES(py), vi=VALUES(vi), en=VALUES(en),
         position_zh=VALUES(position_zh), position_vi=VALUES(position_vi), position_en=VALUES(position_en),
         function_zh=VALUES(function_zh), function_vi=VALUES(function_vi), function_en=VALUES(function_en),
         source=VALUES(source), machine_translated=VALUES(machine_translated), verify=VALUES(verify), verify_note=VALUES(verify_note),
         is_active=VALUES(is_active)`,
      [chunk]
    );
    done += chunk.length;
    console.log(`   ${done}/${rows.length}`);
  }

  await conn.execute(
    `INSERT INTO import_log (source_key, domain, spreadsheet_id, row_count) VALUES ('pathology_workbook_v1', 'pathology', ?, ?)
     ON DUPLICATE KEY UPDATE spreadsheet_id=VALUES(spreadsheet_id), row_count=VALUES(row_count), imported_at=CURRENT_TIMESTAMP`,
    [SPREADSHEET_ID, rows.length]
  );

  await conn.end();
  console.log(`\n✨ Hoàn tất: đã import ${rows.length} thuật ngữ Bệnh Lý (workbook) vào MySQL.`);
}

main().catch((err) => { console.error('❌ Lỗi:', err); process.exit(1); });
