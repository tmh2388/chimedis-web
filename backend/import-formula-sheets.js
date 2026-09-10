/**
 * import-formula-sheets.js
 *
 * Đọc "HVYD Formula Core DB v2.0.0｜Clean Baseline" (Google Sheet
 * GOOGLE_FORMULA_CORE_SPREADSHEET_ID, mặc định
 * 1cuGEQV7wAZ-ldl8tRQsbDYk2WS5cbXvepTuvo0hRf7w) — join các tab con
 * (kb_formulas + versions + ingredients + ingredient_roles +
 * classification_map + source_claims + safety_rules + aliases + ref_codes)
 * thành 1 dòng/thang phương, upsert vào MySQL bảng `formulas`.
 *
 * Nguồn: 《方剂学》第五版 2021. Trạng thái nguồn: EXTRACTED / NOT_RELEASED,
 * bản dịch vi/en đều AI_TRANSLATED → machine_translated=TRUE, verify=TRUE.
 * ~451 phương có tên; nội dung (thành phần/công dụng/chủ trị/kiêng kỵ) chỉ
 * phủ 1 phần — phương thiếu vẫn được import với tên + loại phương.
 *
 * Required env vars:
 *   GOOGLE_CREDENTIALS_JSON_B64 (hoặc GOOGLE_CREDENTIALS_JSON)
 *   MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE (MYSQL_PORT optional)
 *   GOOGLE_FORMULA_CORE_SPREADSHEET_ID (optional — có default)
 *
 * Usage: node import-formula-sheets.js
 */
import { google } from 'googleapis';
import mysql from 'mysql2/promise';
import { createGoogleAuth } from './google-auth.js';

const SPREADSHEET_ID = process.env.GOOGLE_FORMULA_CORE_SPREADSHEET_ID
  || '1cuGEQV7wAZ-ldl8tRQsbDYk2WS5cbXvepTuvo0hRf7w';

const auth = createGoogleAuth(['https://www.googleapis.com/auth/spreadsheets.readonly']);
const sheets = google.sheets({ version: 'v4', auth });

async function readTab(tab) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${tab}!A:AZ` });
  const values = res.data.values || [];
  if (values.length < 2) return [];
  const headers = values[0];
  return values.slice(1)
    .filter((r) => r.some((c) => c !== undefined && c !== ''))
    .map((r) => { const o = {}; headers.forEach((h, i) => { o[h] = r[i] ?? ''; }); return o; });
}

const ROLE_VI = { JUN: 'quân', CHEN: 'thần', ZUO: 'tá', SHI: 'sứ' };
const ROLE_EN = { JUN: 'chief', CHEN: 'deputy', ZUO: 'assistant', SHI: 'envoy' };

function joinClaims(list, key) {
  // Nối nhiều claim cùng loại (thường chỉ 1) bằng khoảng trắng, bỏ rỗng.
  return list.map((c) => c[key]).filter(Boolean).join(' ') || null;
}

async function main() {
  console.log('📖 Đọc Formula Core DB v2.0.0...');
  const [
    formulas, versions, ingredients, roles, classMap, claims, safety, aliases, refCodes,
  ] = await Promise.all([
    readTab('kb_formulas'),
    readTab('kb_formula_versions'),
    readTab('kb_formula_ingredients'),
    readTab('kb_formula_ingredient_roles'),
    readTab('kb_formula_classification_map'),
    readTab('kb_source_claims'),
    readTab('kb_formula_safety_rules'),
    readTab('kb_formula_aliases'),
    readTab('ref_codes'),
  ]);
  console.log(`   formulas=${formulas.length} versions=${versions.length} ingredients=${ingredients.length} claims=${claims.length}`);

  // formula_id -> formula_version_id (1:1 trong v2)
  const fverByFormula = new Map();
  for (const v of versions) if (v.formula_id && v.formula_version_id) fverByFormula.set(v.formula_id, v.formula_version_id);

  // ref_codes: classification code -> nhãn {zh,vi,en}
  const classLabel = new Map();
  for (const rc of refCodes) {
    if (rc.code_set === 'CLASSIFICATION_TEXTBOOK_FUNCTION_21') {
      classLabel.set(rc.code, { zh: rc.label_zh || null, vi: rc.label_vi || null, en: rc.label_en || null });
    }
  }

  // ingredient_id -> role_code
  const roleByIng = new Map();
  for (const r of roles) if (r.formula_ingredient_id && r.role_code) roleByIng.set(r.formula_ingredient_id, r.role_code);

  // fver -> [ingredient rows] (giữ thứ tự sequence_no)
  const ingByFver = new Map();
  for (const ig of ingredients) {
    if (!ig.formula_version_id) continue;
    const list = ingByFver.get(ig.formula_version_id) || [];
    list.push(ig);
    ingByFver.set(ig.formula_version_id, list);
  }
  for (const list of ingByFver.values()) list.sort((a, b) => (+a.sequence_no || 0) - (+b.sequence_no || 0));

  // fver -> classification code (lấy cái đầu)
  const classByFver = new Map();
  for (const cm of classMap) if (cm.formula_version_id && !classByFver.has(cm.formula_version_id)) classByFver.set(cm.formula_version_id, cm.classification_code);

  // fver -> {FUNCTION:[], INDICATION:[], USE:[]}
  const claimsByFver = new Map();
  for (const c of claims) {
    if (!['FUNCTION', 'INDICATION', 'USE'].includes(c.claim_type_code)) continue;
    const o = claimsByFver.get(c.formula_version_id) || { FUNCTION: [], INDICATION: [], USE: [] };
    o[c.claim_type_code].push({
      zh: c.normalized_text_zh || c.claim_text_original || null,
      vi: c.text_vi || null,
      en: c.text_en || null,
    });
    claimsByFver.set(c.formula_version_id, o);
  }

  // fver -> [safety {zh,vi,en}]
  const safetyByFver = new Map();
  for (const s of safety) {
    if (!s.formula_version_id) continue;
    const list = safetyByFver.get(s.formula_version_id) || [];
    list.push({ zh: s.safety_text_zh || null, vi: s.safety_text_vi || null, en: s.safety_text_en || null });
    safetyByFver.set(s.formula_version_id, list);
  }

  // formula_id -> [alias zh]
  const aliasByFormula = new Map();
  for (const a of aliases) {
    if (!a.formula_id || !a.alias_name_zh) continue;
    const list = aliasByFormula.get(a.formula_id) || [];
    list.push(a.alias_name_zh);
    aliasByFormula.set(a.formula_id, list);
  }

  function buildComposition(fver) {
    const list = ingByFver.get(fver);
    if (!list || !list.length) return { zh: null, vi: null, en: null };
    const partZh = [], partVi = [], partEn = [];
    for (const ig of list) {
      const role = roleByIng.get(ig.formula_ingredient_id);
      const doseZh = ig.dose_text_original || (ig.dose_value ? `${ig.dose_value}${(ig.dose_unit_code || '').toLowerCase() === 'g' ? 'g' : ''}` : '');
      const doseNum = ig.dose_value ? `${ig.dose_value}${(ig.dose_unit_code || '').toLowerCase() === 'g' ? 'g' : ''}` : '';
      partZh.push(`${ig.ingredient_name_zh || ig.ingredient_name_source}${doseZh ? ' ' + doseZh : ''}${role ? `（${refCodeZh(role)}）` : ''}`);
      partVi.push(`${ig.ingredient_name_vi || ig.ingredient_name_zh}${doseNum ? ' ' + doseNum : ''}${role ? ` (${ROLE_VI[role] || role})` : ''}`);
      partEn.push(`${ig.ingredient_name_en || ig.ingredient_name_zh}${doseNum ? ' ' + doseNum : ''}${role ? ` (${ROLE_EN[role] || role})` : ''}`);
    }
    return { zh: partZh.join('；'), vi: partVi.join('; '), en: partEn.join('; ') };
  }
  const ROLE_ZH = { JUN: '君', CHEN: '臣', ZUO: '佐', SHI: '使' };
  function refCodeZh(role) { return ROLE_ZH[role] || role; }

  const rows = formulas.map((f) => {
    const fver = fverByFormula.get(f.formula_id);
    const cls = fver ? classLabel.get(classByFver.get(fver)) : null;
    const comp = fver ? buildComposition(fver) : { zh: null, vi: null, en: null };
    const cl = fver ? (claimsByFver.get(fver) || { FUNCTION: [], INDICATION: [], USE: [] }) : { FUNCTION: [], INDICATION: [], USE: [] };
    const saf = fver ? (safetyByFver.get(fver) || []) : [];
    const aliasZh = (aliasByFormula.get(f.formula_id) || []).join('、') || null;
    return [
      f.formula_id,
      f.canonical_name_zh, null, // v2 kb_formulas không có cột phồn thể
      f.canonical_name_pinyin || null, f.canonical_name_vi || null, f.canonical_name_en || null,
      cls ? cls.zh : null, cls ? cls.vi : null, cls ? cls.en : null,
      null, null, null, // origin — v2 chưa tách trường xuất xứ riêng
      comp.zh, comp.vi, comp.en,
      joinClaims(cl.FUNCTION, 'zh'), joinClaims(cl.FUNCTION, 'vi'), joinClaims(cl.FUNCTION, 'en'),
      joinClaims(cl.INDICATION, 'zh'), joinClaims(cl.INDICATION, 'vi'), joinClaims(cl.INDICATION, 'en'),
      joinClaims(cl.USE, 'zh'), joinClaims(cl.USE, 'vi'), joinClaims(cl.USE, 'en'), // analysis ~ cách dùng / vận dụng
      saf.map((s) => s.zh).filter(Boolean).join(' ') || null,
      saf.map((s) => s.vi).filter(Boolean).join(' ') || null,
      saf.map((s) => s.en).filter(Boolean).join(' ') || null,
      aliasZh,
      'HVYD Formula Core DB v2.0.0 — trích 《方剂学》第五版 (中国中医药出版社, 2021); bản dịch vi/en do AI, CHƯA rà soát tay',
      true, true,
      `review_status nguồn=${f.review_status_code || 'EXTRACTED'}; localization=AI_TRANSLATED. Nhiều phương chỉ có tên + loại (nguồn v2 mới extract 1 phần) — thành phần/công dụng/chủ trị có thể trống.`,
      true,
    ];
  });

  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST, port: process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE,
  });

  console.log(`📝 Ghi ${rows.length} thang phương vào MySQL...`);
  const BATCH = 150;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await conn.query(
      `INSERT INTO formulas (
         formula_id, name_zh, name_zh_traditional, py, name_vi, name_en,
         category_zh, category_vi, category_en, origin_zh, origin_vi, origin_en,
         composition_zh, composition_vi, composition_en,
         functions_zh, functions_vi, functions_en,
         indications_zh, indications_vi, indications_en,
         analysis_zh, analysis_vi, analysis_en,
         cautions_zh, cautions_vi, cautions_en,
         aliases_zh, source, machine_translated, verify, verify_note, is_active
       ) VALUES ?
       ON DUPLICATE KEY UPDATE
         name_zh=VALUES(name_zh), name_zh_traditional=VALUES(name_zh_traditional), py=VALUES(py),
         name_vi=VALUES(name_vi), name_en=VALUES(name_en),
         category_zh=VALUES(category_zh), category_vi=VALUES(category_vi), category_en=VALUES(category_en),
         origin_zh=VALUES(origin_zh), origin_vi=VALUES(origin_vi), origin_en=VALUES(origin_en),
         composition_zh=VALUES(composition_zh), composition_vi=VALUES(composition_vi), composition_en=VALUES(composition_en),
         functions_zh=VALUES(functions_zh), functions_vi=VALUES(functions_vi), functions_en=VALUES(functions_en),
         indications_zh=VALUES(indications_zh), indications_vi=VALUES(indications_vi), indications_en=VALUES(indications_en),
         analysis_zh=VALUES(analysis_zh), analysis_vi=VALUES(analysis_vi), analysis_en=VALUES(analysis_en),
         cautions_zh=VALUES(cautions_zh), cautions_vi=VALUES(cautions_vi), cautions_en=VALUES(cautions_en),
         aliases_zh=VALUES(aliases_zh), source=VALUES(source), machine_translated=VALUES(machine_translated),
         verify=VALUES(verify), verify_note=VALUES(verify_note), is_active=VALUES(is_active)`,
      [chunk]
    );
    console.log(`   ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }

  await conn.execute(
    `INSERT INTO import_log (source_key, domain, spreadsheet_id, row_count) VALUES ('formula_core_v2.0.0', 'formula', ?, ?)
     ON DUPLICATE KEY UPDATE spreadsheet_id=VALUES(spreadsheet_id), row_count=VALUES(row_count), imported_at=CURRENT_TIMESTAMP`,
    [SPREADSHEET_ID, rows.length]
  );
  await conn.end();
  console.log(`\n✨ Hoàn tất: đã import ${rows.length} thang phương vào MySQL.`);
}

main().catch((err) => { console.error('❌ Lỗi:', err); process.exit(1); });
