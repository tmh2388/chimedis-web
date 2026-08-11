/**
 * import-anatomy-terms.js
 *
 * Reads backend/data/anatomy-raw.json — Giải phẫu (Anatomy) + Sinh lý
 * (Physiology) terms manually extracted/curated from the Chinese-teaching
 * course "《实用医学汉语基础篇》" (Drive folder 1iLXo3SawcvvmhefxtdXNlBV_Vz7MKvUj)
 * plus a small set of carried-over seed entries for the respiratory system —
 * and upserts a denormalized "dictionary view" into MySQL, mirroring the
 * herbs pipeline (import-herbal-sheets.js). Safe to re-run: existing rows
 * are updated, not duplicated.
 *
 * Unlike herbs, there is no Google Sheet source here — the raw JSON IS the
 * source of truth going forward (edit backend/data/anatomy-raw.json and
 * re-run this script to update MySQL).
 *
 * Required env vars:
 *   MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
 *   MYSQL_PORT (optional, default 3306)
 *   TRANSLATE_CONTACT_EMAIL (optional, raises MyMemory's free daily quota)
 *
 * Usage: node import-anatomy-terms.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { translateBatch } from './translate.js';
import { ORGAN_SYSTEM_TRANSLATIONS } from './organ-system-translations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  const rawPath = path.join(__dirname, 'data', 'anatomy-raw.json');
  const terms = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  console.log(`📖 Đọc ${terms.length} thuật ngữ từ anatomy-raw.json`);

  // Trường nào thiếu vi/en thì dịch máy — hầu hết bài (trừ ~90 mục cơ hệ đã
  // có sẵn tiếng Việt từ PDF nguồn) đều thiếu vi/en hoàn toàn, vì nguồn chỉ
  // là tài liệu dạy tiếng Trung (chỉ có hz/py/định nghĩa tiếng Trung).
  const fieldsToTranslate = ['vi_name', 'position', 'function', 'clinical'];
  const progress = (label) => (done, total) => {
    if (done === total) console.log(`   ${label}: ${done}/${total}`);
  };

  console.log('🌐 Đang dịch các trường còn thiếu (MyMemory)...');

  // Tên thuật ngữ (vi/en) — chỉ dịch những mục chưa có sẵn, dịch từ hz gốc để
  // nhất quán (tránh dịch chồng qua vi rồi qua en làm sai nghĩa thêm).
  const nameZhForMissingVi = terms.map((t) => (t.vi ? null : t.hz));
  const nameZhForMissingEn = terms.map((t) => (t.en ? null : t.hz));
  const [nameViTranslated, nameEnTranslated] = await Promise.all([
    translateBatch(nameZhForMissingVi.map((v) => v || ''), 'vi', progress('tên→vi')),
    translateBatch(nameZhForMissingEn.map((v) => v || ''), 'en', progress('tên→en')),
  ]);

  const positionZh = terms.map((t) => t.position_zh || '');
  const functionZh = terms.map((t) => t.function_zh || '');
  const clinicalZh = terms.map((t) => t.clinical_zh || '');
  const tcmZh = terms.map((t) => t.tcm_zh || '');

  const [
    positionVi, positionEn,
    functionVi, functionEn,
    clinicalVi, clinicalEn,
    tcmVi, tcmEn,
  ] = await Promise.all([
    translateBatch(positionZh, 'vi', progress('vị trí→vi')),
    translateBatch(positionZh, 'en', progress('vị trí→en')),
    translateBatch(functionZh, 'vi', progress('công năng→vi')),
    translateBatch(functionZh, 'en', progress('công năng→en')),
    translateBatch(clinicalZh, 'vi', progress('lâm sàng→vi')),
    translateBatch(clinicalZh, 'en', progress('lâm sàng→en')),
    translateBatch(tcmZh, 'vi', progress('Trung Y→vi')),
    translateBatch(tcmZh, 'en', progress('Trung Y→en')),
  ]);

  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
  });

  const bySystemCounter = {};
  const rows = terms.map((t, i) => {
    const sysTr = ORGAN_SYSTEM_TRANSLATIONS[t.organ_system_zh] || [null, null];
    const prefix = (t.organ_system_zh || 'gen').slice(0, 2);
    bySystemCounter[t.organ_system_zh] = (bySystemCounter[t.organ_system_zh] || 0) + 1;
    const termId = `an-${slug(t.organ_system_zh)}-${String(bySystemCounter[t.organ_system_zh]).padStart(3, '0')}`;

    const vi = t.vi || (nameViTranslated[i] || null);
    const en = t.en || (nameEnTranslated[i] || null);

    return [
      termId, t.domain, t.organ_system_zh, sysTr[0], sysTr[1],
      t.hz, t.py || null, vi, en,
      t.position_zh || null, t.position_vi || positionVi[i] || null, t.position_en || positionEn[i] || null,
      t.function_zh || null, t.function_vi || functionVi[i] || null, t.function_en || functionEn[i] || null,
      t.tcm_zh || null, t.tcm_vi || tcmVi[i] || null, t.tcm_en || tcmEn[i] || null,
      t.clinical_zh || null, t.clinical_vi || clinicalVi[i] || null, t.clinical_en || clinicalEn[i] || null,
      t.source || null,
      t.machine_translated !== false,
      t.verify !== false,
      t.verify_note || null,
      true,
    ];
  });

  console.log(`📝 Đang ghi ${rows.length} thuật ngữ vào MySQL (1 lệnh bulk insert)...`);
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
    `INSERT INTO import_log (source_key, domain, spreadsheet_id, row_count) VALUES ('anatomy_course_v1', 'anatomy', ?, ?)
     ON DUPLICATE KEY UPDATE spreadsheet_id=VALUES(spreadsheet_id), row_count=VALUES(row_count), imported_at=CURRENT_TIMESTAMP`,
    ['drive:1iLXo3SawcvvmhefxtdXNlBV_Vz7MKvUj', rows.length]
  );

  await conn.end();
  console.log(`\n✨ Hoàn tất: đã import ${rows.length} thuật ngữ Giải phẫu/Sinh lý vào MySQL.`);
}

function slug(zhSystemName) {
  const map = {
    '解剖学总论': 'gen', '运动系统': 'musc', '呼吸系统': 'resp', '循环系统': 'circ',
    '消化系统': 'dige', '内分泌系统': 'endo', '神经系统': 'nerv', '泌尿系统': 'urin',
    '生殖系统': 'repro', '组织学与胚胎学': 'hist', '皮肤': 'skin',
  };
  return map[zhSystemName] || 'misc';
}

run().catch((err) => {
  console.error('❌ Import thất bại:', err);
  process.exit(1);
});
