/**
 * import-pathology-terms.js
 *
 * Reads backend/data/pathology-raw.json — Bệnh Lý (TCM disease/pathology
 * category) terms, hand-composed from standard TCM curriculum knowledge
 * (中医内科学/外科学/妇科学/儿科学/五官科学/骨伤科学 nosology, plus the
 * readable source textbooks in Drive folder 1kob-z4R-70KKWWwfi38XcNPQdgmrGqvJ:
 * 温病学 第五版, 金匮要略 第五版, 伤寒论选读 第五版 — the primary internal-
 * medicine/diagnostics scans in that folder have NO OCR layer and could not
 * be read directly, per user's explicit go-ahead 2026-08-19 to proceed with
 * readable sources + standard TCM knowledge instead of blocking on OCR).
 *
 * Reuses the EXISTING `anatomy_terms` table/schema — it already has a
 * `domain` column ('Giải phẫu' | 'Sinh lý') and the frontend already treats
 * 'Bệnh lý' as a third value via ANATOMY_GROUPS (see frontend/index.html),
 * so no new table/schema is needed. The 4 shared field slots are repurposed
 * for this domain (see PATHOLOGY_LABELS in frontend/index.html for the
 * relabeled UI text — data shape is unchanged):
 *   position  -> Định nghĩa (definition)
 *   function  -> Bệnh nhân — Bệnh cơ (etiology & pathogenesis)
 *   tcm_note  -> Thể bệnh / biện chứng (syndrome-type differentiation)
 *   clinical  -> Triệu chứng lâm sàng & Pháp trị (symptoms & treatment principle)
 *
 * All vi/zh/en content in the JSON is hand-authored (no MyMemory batch
 * translation — this is high-visibility professional terminology, per the
 * "dịch tay cho thuật ngữ chuyên môn" rule) — machine_translated=FALSE.
 * verify=TRUE with a note: this is phase 1, synthesized from standard
 * textbook knowledge (not transcribed from a specific vetted core DB like
 * herbs/acupoints have), so Hạ Vân Y Đạo should spot-check before treating
 * it as fully authoritative.
 *
 * Safe to re-run (idempotent upsert by term_id). To add more terms later,
 * append entries to pathology-raw.json and re-run.
 *
 * Required env vars: MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
 *   (MYSQL_PORT optional, default 3306)
 *
 * Usage: node import-pathology-terms.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SLUG_MAP = {
  '呼吸系统': 'resp', '循环系统': 'circ', '消化系统': 'dige', '泌尿系统': 'urin',
  '内分泌系统': 'endo', '神经系统': 'nerv',
  '气血津液病证': 'qixue', '肢体经络病证': 'jingluo', '妇科病证': 'fuke',
  '儿科病证': 'nhike', '五官科病证': 'nguquan', '外科病证': 'ngoaikhoa',
  '骨伤科病证': 'cotthuong', '温病': 'onbenh', '伤寒六经病': 'thuonghan',
  '金匮杂病': 'kimquy',
};
function slug(zhSystemName) { return SLUG_MAP[zhSystemName] || 'misc'; }

async function run() {
  const rawPath = path.join(__dirname, 'data', 'pathology-raw.json');
  const terms = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  console.log(`📖 Đọc ${terms.length} bệnh danh từ pathology-raw.json`);

  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
  });

  const bySystemCounter = {};
  const rows = terms.map((t) => {
    bySystemCounter[t.organ_system_zh] = (bySystemCounter[t.organ_system_zh] || 0) + 1;
    const termId = `benh-${slug(t.organ_system_zh)}-${String(bySystemCounter[t.organ_system_zh]).padStart(3, '0')}`;
    return [
      termId, 'Bệnh lý', t.organ_system_zh, t.organ_system_vi || null, t.organ_system_en || null,
      t.hz, t.py || null, t.vi || null, t.en || null,
      t.position_zh || null, t.position || null, t.position_en || null,
      t.function_zh || null, t.function || null, t.function_en || null,
      t.tcm_zh || null, t.tcm || null, t.tcm_en || null,
      t.lamsang_zh || null, t.lamsang || null, t.lamsang_en || null,
      'Tổng hợp giáo trình Trung Y chuẩn (Ôn bệnh học/Kim Quỹ Yếu Lược/Thương hàn luận + kiến thức nội khoa/ngoại khoa/phụ khoa/nhi khoa/ngũ quan/cốt thương TCM chuẩn)',
      false, // machine_translated — hand-authored
      true, // verify — phase 1, cần Hạ Vân Y Đạo đối chiếu
      'Nội dung tổng hợp từ kiến thức TCM chuẩn (giáo trình Nội khoa/Chẩn đoán học gốc là bản scan chưa có OCR, không đọc trực tiếp được) — cần đối chiếu lại trước khi coi là chính thức. Xem project_chimedis_pathology_domain.',
      true,
    ];
  });

  console.log(`📝 Đang ghi ${rows.length} bệnh danh vào MySQL (1 lệnh bulk insert)...`);
  if (rows.length > 0) {
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
         tcm_note_zh=VALUES(tcm_note_zh), tcm_note_vi=VALUES(tcm_note_vi), tcm_note_en=VALUES(tcm_note_en),
         clinical_zh=VALUES(clinical_zh), clinical_vi=VALUES(clinical_vi), clinical_en=VALUES(clinical_en),
         source=VALUES(source), machine_translated=VALUES(machine_translated), verify=VALUES(verify), verify_note=VALUES(verify_note),
         is_active=VALUES(is_active)`,
      [rows]
    );
  }

  await conn.execute(
    `INSERT INTO import_log (source_key, domain, spreadsheet_id, row_count) VALUES ('pathology_v1', 'pathology', ?, ?)
     ON DUPLICATE KEY UPDATE spreadsheet_id=VALUES(spreadsheet_id), row_count=VALUES(row_count), imported_at=CURRENT_TIMESTAMP`,
    ['drive:1kob-z4R-70KKWWwfi38XcNPQdgmrGqvJ', rows.length]
  );

  await conn.end();
  console.log(`\n✨ Hoàn tất: đã import ${rows.length} bệnh danh vào MySQL (domain='Bệnh lý').`);
}

run().catch((err) => {
  console.error('❌ Import thất bại:', err);
  process.exit(1);
});
