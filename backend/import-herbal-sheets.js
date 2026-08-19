/**
 * import-herbal-sheets.js
 *
 * Reads the HVYD Herbal Core DB (Google Sheets, in
 * HVDQ_ConsultDB/herbal_medicine_db/03_master_data) and upserts a
 * denormalized "dictionary view" into MySQL — one row per herb, with
 * coded fields (temperature/taste/meridian) resolved to Vietnamese and
 * Chinese labels. Safe to re-run: existing rows are updated, not duplicated.
 *
 * Required env vars:
 *   GOOGLE_CREDENTIALS_JSON        path to the service account key (docs/google-sheets-setup.md)
 *   GOOGLE_HERBAL_CORE_SPREADSHEET_ID  the "HVYD Herbal Core DB vX.Y.Z" file's ID
 *   MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
 *   MYSQL_PORT (optional, default 3306)
 *
 * Usage: node import-herbal-sheets.js
 */
import { google } from 'googleapis';
import mysql from 'mysql2/promise';
import { createGoogleAuth } from './google-auth.js';
import { translateBatch } from './translate.js';
import { CATEGORY_TRANSLATIONS } from './category-translations.js';

const auth = createGoogleAuth(['https://www.googleapis.com/auth/spreadsheets.readonly']);
const sheets = google.sheets({ version: 'v4', auth });

// Standard TCM vocabulary — these code sets are fixed/universal, not
// specific to this dataset, so it's safe to hardcode the VI/ZH/EN labels
// here rather than depending on a lookup tab that doesn't exist in the source.
// Mỗi mã có 2 biến thể khoá (có/không gạch dưới, vd. WEIWEN/WEI_WEN) vì nguồn
// Sheet dùng lẫn lộn cả 2 kiểu — thiếu 1 biến thể nào sẽ khiến mã đó lọt qua
// không dịch được, hiện nguyên mã thô ra UI (bug đã gặp với WEI_HAN/WEI_WEN,
// 28 vị thuốc, phát hiện 2026-08-11 — xem fix-herb-tvm-fields.js để sửa dữ
// liệu cũ, file này chỉ áp dụng cho lần import tiếp theo).
const TEMPERATURE_LABELS = {
  HAN: ['寒', 'Hàn', 'Cold'],
  WEIHAN: ['微寒', 'Hơi hàn', 'Slightly cold'], WEI_HAN: ['微寒', 'Hơi hàn', 'Slightly cold'],
  LIANG: ['凉', 'Lương', 'Cool'],
  PING: ['平', 'Bình', 'Neutral'],
  WEN: ['温', 'Ôn', 'Warm'],
  WEIWEN: ['微温', 'Hơi ôn', 'Slightly warm'], WEI_WEN: ['微温', 'Hơi ôn', 'Slightly warm'],
  RE: ['热', 'Nhiệt', 'Hot'],
  DARE: ['大热', 'Đại nhiệt', 'Very hot'], DA_RE: ['大热', 'Đại nhiệt', 'Very hot'],
  DAHAN: ['大寒', 'Đại hàn', 'Extremely cold'], DA_HAN: ['大寒', 'Đại hàn', 'Extremely cold'],
};
// Âm Hán Việt chuẩn TCM (không phải nghĩa thường) — Core DB (ref_codes) không có
// bảng nhãn cho mã vị, chỉ lưu mã thô (XIN/GAN/KU...), nên bảng này đối chiếu
// theo giáo trình TCM chuẩn, đã user xác nhận trực tiếp (quyết định 2026-08-19,
// vd. 甘 = Cam chứ không phải "Ngọt" — xem project_chimedis_translation_qa).
const TASTE_LABELS = {
  XIN: ['辛', 'Tân', 'Pungent'], GAN: ['甘', 'Cam', 'Sweet'], KU: ['苦', 'Khổ', 'Bitter'],
  SUAN: ['酸', 'Toan', 'Sour'], XIAN: ['咸', 'Hàm', 'Salty'], DAN: ['淡', 'Đạm', 'Bland'],
  SE: ['涩', 'Sáp', 'Astringent'],
  WEIXIN: ['微辛', 'Hơi tân', 'Slightly pungent'], WEI_XIN: ['微辛', 'Hơi tân', 'Slightly pungent'],
  WEIGAN: ['微甘', 'Hơi cam', 'Slightly sweet'], WEI_GAN: ['微甘', 'Hơi cam', 'Slightly sweet'],
  WEIKU: ['微苦', 'Hơi khổ', 'Slightly bitter'], WEI_KU: ['微苦', 'Hơi khổ', 'Slightly bitter'],
  WEISUAN: ['微酸', 'Hơi toan', 'Slightly sour'], WEI_SUAN: ['微酸', 'Hơi toan', 'Slightly sour'],
};
const MERIDIAN_LABELS = {
  FEI: ['肺', 'Phế', 'Lung'], XIN: ['心', 'Tâm', 'Heart'], PI: ['脾', 'Tỳ', 'Spleen'],
  GAN: ['肝', 'Can', 'Liver'], SHEN: ['肾', 'Thận', 'Kidney'], WEI: ['胃', 'Vị', 'Stomach'],
  DAN: ['胆', 'Đởm', 'Gallbladder'],
  DACHANG: ['大肠', 'Đại trường', 'Large intestine'], DA_CHANG: ['大肠', 'Đại trường', 'Large intestine'],
  XIAOCHANG: ['小肠', 'Tiểu trường', 'Small intestine'], XIAO_CHANG: ['小肠', 'Tiểu trường', 'Small intestine'],
  PANGGUANG: ['膀胱', 'Bàng quang', 'Bladder'], PANG_GUANG: ['膀胱', 'Bàng quang', 'Bladder'],
  SANJIAO: ['三焦', 'Tam tiêu', 'Triple burner'], SAN_JIAO: ['三焦', 'Tam tiêu', 'Triple burner'],
  XINBAO: ['心包', 'Tâm bào', 'Pericardium'], XIN_BAO: ['心包', 'Tâm bào', 'Pericardium'],
};

function decodeCodes(codeStr, labelMap) {
  if (!codeStr || codeStr === 'NOT_STATED_IN_SOURCE') return { zh: null, vi: null, en: null };
  const codes = String(codeStr).split('|').map((c) => c.trim()).filter(Boolean);
  const zh = codes.map((c) => (labelMap[c] || [c, c, c])[0]).join('、');
  const vi = codes.map((c) => (labelMap[c] || [c, c, c])[1]).join(', ');
  const en = codes.map((c) => (labelMap[c] || [c, c, c])[2]).join(', ');
  return { zh, vi, en };
}

function rowsToObjects(values) {
  if (!values || values.length < 2) return [];
  const headers = values[0];
  return values.slice(1)
    .filter((row) => row.some((cell) => cell !== undefined && cell !== ''))
    .map((row) => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i] !== undefined ? row[i] : null; });
      return obj;
    });
}

async function readTab(spreadsheetId, tabName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!A:Z`,
  });
  return rowsToObjects(res.data.values);
}

function toDecimal(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isNaN(n) ? null : n;
}

export async function runImport() {
  const spreadsheetId = process.env.GOOGLE_HERBAL_CORE_SPREADSHEET_ID;
  if (!spreadsheetId) {
    throw new Error('Thiếu GOOGLE_HERBAL_CORE_SPREADSHEET_ID (ID file "HVYD Herbal Core DB vX.Y.Z").');
  }

  console.log('📖 Đang đọc dữ liệu từ Herbal Core DB...');
  const [herbs, categories, profiles, forms, useRules, safetyRules, actionCodes, actionMap] = await Promise.all([
    readTab(spreadsheetId, 'kb_herbs'),
    readTab(spreadsheetId, 'kb_categories'),
    readTab(spreadsheetId, 'kb_herb_clinical_profiles'),
    readTab(spreadsheetId, 'kb_herb_forms'),
    readTab(spreadsheetId, 'kb_herb_use_rules'),
    readTab(spreadsheetId, 'kb_herb_safety_rules'),
    readTab(spreadsheetId, 'ref_action_codes'),
    readTab(spreadsheetId, 'kb_herb_action_map'),
  ]);
  console.log(`   herbs=${herbs.length} categories=${categories.length} profiles=${profiles.length} forms=${forms.length} use_rules=${useRules.length} safety_rules=${safetyRules.length} action_codes=${actionCodes.length} action_map=${actionMap.length}`);

  const categoryById = new Map(categories.map((c) => [c.category_id, c]));
  const profileByHerbId = new Map(profiles.map((p) => [p.herb_id, p]));
  const defaultFormByHerbId = new Map();
  for (const f of forms) {
    if (f.is_default === true || f.is_default === 'TRUE' || f.is_default === 'true') {
      defaultFormByHerbId.set(f.herb_id, f);
    }
  }
  const useRuleByFormId = new Map(useRules.map((u) => [u.herb_form_id, u]));
  const safetyByHerbId = new Map();
  for (const s of safetyRules) {
    if (!s.herb_id || !s.safety_text_zh) continue;
    const set = safetyByHerbId.get(s.herb_id) || new Set();
    set.add(s.safety_text_zh); // multiple herb_form_ids often repeat the same herb-level caution text
    safetyByHerbId.set(s.herb_id, set);
  }

  // 功能/công năng already has a real (source-provided, AI-reviewed) VI/EN
  // translation via ref_action_codes — build ordered per-herb action lists
  // from kb_herb_action_map (priority order) instead of machine-translating.
  const actionCodeById = new Map(actionCodes.map((a) => [a.action_code, a]));
  const actionsByHerbId = new Map();
  for (const m of actionMap) {
    if (!m.herb_id || !m.action_code) continue;
    const list = actionsByHerbId.get(m.herb_id) || [];
    list.push({ priority: parseInt(m.priority, 10) || 0, code: m.action_code });
    actionsByHerbId.set(m.herb_id, list);
  }
  function buildAction(herbId) {
    const list = (actionsByHerbId.get(herbId) || []).slice().sort((a, b) => a.priority - b.priority);
    const zh = [], vi = [], en = [];
    for (const { code } of list) {
      const a = actionCodeById.get(code);
      if (!a) continue;
      if (a.name_zh) zh.push(a.name_zh);
      if (a.name_vi) vi.push(a.name_vi);
      if (a.name_en) en.push(a.name_en);
    }
    return { zh: zh.join('；') || null, vi: vi.join('; ') || null, en: en.join('; ') || null };
  }

  // indication/dose/caution/category names have no translation in the source —
  // machine-translate them via Google Cloud Translation API (see translate.js).
  console.log('🌐 Đang dịch chủ trị/liều dùng/kiêng kỵ (MyMemory)...');
  const indicationTexts = herbs.map((h) => (profileByHerbId.get(h.herb_id) || {}).indication_text_zh || '');
  const doseTexts = herbs.map((h) => {
    const form = defaultFormByHerbId.get(h.herb_id);
    const useRule = form ? useRuleByFormId.get(form.herb_form_id) : null;
    return useRule ? (useRule.preparation_text_zh || '') : '';
  });
  const cautionTexts = herbs.map((h) => Array.from(safetyByHerbId.get(h.herb_id) || []).join(' '));

  const progress = (label) => (done, total) => console.log(`   ${label}: ${done}/${total}`);
  const [indicationVi, indicationEn, doseVi, doseEn, cautionVi, cautionEn] = await Promise.all([
    translateBatch(indicationTexts, 'vi', progress('chủ trị→vi')),
    translateBatch(indicationTexts, 'en', progress('chủ trị→en')),
    translateBatch(doseTexts, 'vi', progress('liều dùng→vi')),
    translateBatch(doseTexts, 'en', progress('liều dùng→en')),
    translateBatch(cautionTexts, 'vi', progress('kiêng kỵ→vi')),
    translateBatch(cautionTexts, 'en', progress('kiêng kỵ→en')),
  ]);

  // Tên chương/tiết dùng bảng thuật ngữ 中药学 chuẩn đã kiểm tra tay (xem
  // category-translations.js) thay vì dịch máy — dịch máy dịch sai be bét
  // các thuật ngữ Trung Y chuyên môn (vd. 解表药 "giải biểu" bị dịch thành
  // "thuốc giải độc"/"antidote"). Category lạ chưa có trong bảng thì fallback
  // dịch máy để không bị bỏ trắng.
  const categoryTranslation = new Map();
  const categoryList = categories.filter((c) => c.chapter_zh || c.section_zh);
  const unknownCategories = categoryList.filter((c) => !CATEGORY_TRANSLATIONS[c.category_id]);
  if (unknownCategories.length) {
    console.log(`🌐 ${unknownCategories.length} category chưa có trong bảng chuẩn, dịch máy tạm...`);
    const chTexts = unknownCategories.map((c) => c.chapter_zh || '');
    const seTexts = unknownCategories.map((c) => c.section_zh || '');
    const [chVi, chEn, seVi, seEn] = await Promise.all([
      translateBatch(chTexts, 'vi'), translateBatch(chTexts, 'en'),
      translateBatch(seTexts, 'vi'), translateBatch(seTexts, 'en'),
    ]);
    unknownCategories.forEach((c, i) => {
      categoryTranslation.set(c.category_id, { chapterVi: chVi[i], chapterEn: chEn[i], sectionVi: seVi[i], sectionEn: seEn[i] });
    });
  }
  for (const c of categoryList) {
    const known = CATEGORY_TRANSLATIONS[c.category_id];
    if (known) {
      categoryTranslation.set(c.category_id, { chapterVi: known[0], chapterEn: known[1], sectionVi: known[2], sectionEn: known[3] });
    }
  }

  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
  });

  const rows = [];
  herbs.forEach((h, i) => {
    // CORE and RELATED_HERB are both standalone dictionary entries with their
    // own full clinical profile (e.g. 紫苏叶 core vs. 紫苏梗/紫苏子 related) —
    // RELATED_HERB just flags "a variant/other part of a plant", not a duplicate.
    if (h.is_active === false || h.is_active === 'FALSE') return;

    const cat = categoryById.get(h.category_id) || {};
    const catTr = categoryTranslation.get(h.category_id) || {};
    const profile = profileByHerbId.get(h.herb_id) || {};
    const form = defaultFormByHerbId.get(h.herb_id);
    const useRule = form ? useRuleByFormId.get(form.herb_form_id) : null;
    const cautions = cautionTexts[i];

    const temperature = decodeCodes(profile.temperature_code, TEMPERATURE_LABELS);
    const taste = decodeCodes(profile.taste_codes, TASTE_LABELS);
    const meridian = decodeCodes(profile.meridian_codes, MERIDIAN_LABELS);
    const action = buildAction(h.herb_id);

    rows.push([
      h.herb_id, h.category_id,
      cat.chapter_zh || null, catTr.chapterVi || null, catTr.chapterEn || null,
      cat.section_zh || null, catTr.sectionVi || null, catTr.sectionEn || null,
      h.name_zh, h.name_zh_traditional, h.name_vi, h.pinyin, h.latin_name,
      h.medicinal_part, h.source_species,
      temperature.zh, temperature.vi, temperature.en, taste.zh, taste.vi, taste.en, meridian.zh, meridian.vi, meridian.en,
      action.zh, action.vi, action.en,
      profile.indication_text_zh || null, indicationVi[i], indicationEn[i],
      useRule ? useRule.preparation_text_zh : null, doseVi[i], doseEn[i],
      useRule ? toDecimal(useRule.dose_min_g) : null,
      useRule ? toDecimal(useRule.dose_max_g) : null,
      cautions || null, cautionVi[i], cautionEn[i],
      true,
    ]);
  });

  console.log(`📝 Đang ghi ${rows.length} vị thuốc vào MySQL (1 lệnh bulk insert)...`);
  if (rows.length > 0) {
    await conn.query(
      `INSERT INTO herbs (
         herb_id, category_id, chapter_zh, chapter_vi, chapter_en, section_zh, section_vi, section_en,
         name_zh, name_zh_traditional, name_vi, pinyin, latin_name, medicinal_part, source_species,
         temperature_zh, temperature_vi, temperature_en, taste_zh, taste_vi, taste_en, meridian_zh, meridian_vi, meridian_en,
         action_text_zh, action_text_vi, action_text_en,
         indication_text_zh, indication_text_vi, indication_text_en,
         dose_text_zh, dose_text_vi, dose_text_en, dose_min_g, dose_max_g,
         caution_text_zh, caution_text_vi, caution_text_en, is_active
       ) VALUES ?
       ON DUPLICATE KEY UPDATE
         category_id=VALUES(category_id), chapter_zh=VALUES(chapter_zh), chapter_vi=VALUES(chapter_vi), chapter_en=VALUES(chapter_en),
         section_zh=VALUES(section_zh), section_vi=VALUES(section_vi), section_en=VALUES(section_en),
         name_zh=VALUES(name_zh), name_zh_traditional=VALUES(name_zh_traditional), name_vi=VALUES(name_vi),
         pinyin=VALUES(pinyin), latin_name=VALUES(latin_name), medicinal_part=VALUES(medicinal_part),
         source_species=VALUES(source_species), temperature_zh=VALUES(temperature_zh), temperature_vi=VALUES(temperature_vi), temperature_en=VALUES(temperature_en),
         taste_zh=VALUES(taste_zh), taste_vi=VALUES(taste_vi), taste_en=VALUES(taste_en), meridian_zh=VALUES(meridian_zh), meridian_vi=VALUES(meridian_vi), meridian_en=VALUES(meridian_en),
         action_text_zh=VALUES(action_text_zh), action_text_vi=VALUES(action_text_vi), action_text_en=VALUES(action_text_en),
         indication_text_zh=VALUES(indication_text_zh), indication_text_vi=VALUES(indication_text_vi), indication_text_en=VALUES(indication_text_en),
         dose_text_zh=VALUES(dose_text_zh), dose_text_vi=VALUES(dose_text_vi), dose_text_en=VALUES(dose_text_en),
         dose_min_g=VALUES(dose_min_g), dose_max_g=VALUES(dose_max_g),
         caution_text_zh=VALUES(caution_text_zh), caution_text_vi=VALUES(caution_text_vi), caution_text_en=VALUES(caution_text_en),
         is_active=VALUES(is_active)`,
      [rows]
    );
  }

  await conn.execute(
    `INSERT INTO import_log (source_key, domain, spreadsheet_id, row_count) VALUES ('herbal_core_db', 'herb', ?, ?)
     ON DUPLICATE KEY UPDATE spreadsheet_id=VALUES(spreadsheet_id), row_count=VALUES(row_count), imported_at=CURRENT_TIMESTAMP`,
    [spreadsheetId, rows.length]
  );

  await conn.end();
  console.log(`\n✨ Hoàn tất: đã import ${rows.length} vị thuốc vào MySQL.`);
  return rows.length;
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  runImport().catch((err) => {
    console.error('❌ Import thất bại:', err);
    process.exit(1);
  });
}
