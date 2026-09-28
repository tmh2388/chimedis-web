/**
 * import-acupoint-sheets.js
 *
 * Reads the HVYD Acupoint Core DB (Google Sheets — kb_acupoints, kb_acupoint_names,
 * kb_meridians, kb_acupoint_meridian_map, kb_acupoint_locations, kb_acupoint_indication_claims,
 * kb_acupoint_action_claims, ref_action_codes, kb_acupoint_class_map, ref_acupoint_class_codes,
 * ref_body_regions, kb_acupoint_anatomy_claims, kb_acupoint_safety_rules) and upserts a
 * denormalized "dictionary view" into MySQL, mirroring import-herbal-sheets.js. Safe to
 * re-run: existing rows are updated, not duplicated.
 *
 * The source provides real vi/zh translations for name/location/indication/anatomy/caution
 * (translation_vi/translation_zh or normalized_summary_vi/zh columns) but EN is only filled
 * for a handful of rows — the corresponding *_text_en columns are machine-translated
 * (MyMemory, same pipeline as herbs/anatomy) as a fallback when the source has no EN, flagged
 * via en_machine_translated. vi/zh are NEVER machine translated here — both are always
 * real/reviewed content from the source.
 *
 * action_text_* (tác dụng lâm sàng, 功效/general point action) is genuinely incomplete in the
 * source itself as of 2026-09 (only the Lung meridian batch done, 9 claims total) — left NULL
 * for points without a claim, by design, not a bug.
 *
 * ⚠️ 2026-09-28 — Core DB v2.0 (fileId 1k0A6WPfU8RHaZ8mK52lh8c93S3Iaaq7-2uTq0HctM9c): full
 * schema/content upgrade, ALL 362/362 canonical points (12 chính kinh + Nhâm + Đốc) now have
 * complete location/anatomy/indication/procedure/safety data — see
 * project_chimedis_acupoint_atlas.md mục "2026-09-28" cho toàn bộ quá trình review + quyết định
 * phạm vi. 2 điểm quan trọng CỐ Ý không đưa vào import này:
 *   1. `kb_acupoint_procedure_claims` (độ sâu/hướng kim/chống chỉ định thao tác) — Core DB tự
 *      khoá `patient_export_allowed=FALSE` cho toàn bộ 362 dòng; đây là rủi ro an toàn lâm
 *      sàng thật (app công khai không nên hướng dẫn kỹ thuật châm cho người không giám sát),
 *      không phải "chưa rà soát dịch máy" như các domain khác.
 *   2. `kb_source_media_assets`/`kb_source_media_acupoint_map` (87 ảnh scan trực tiếp từ sách
 *      có bản quyền 《经络腧穴学》) — README Core DB ghi rõ "Copyrighted original figures
 *      retained internal; product atlas must be separately redesigned" — CHỈ dùng đối chiếu
 *      nội bộ khi vẽ lại atlas AI (Lớp B), KHÔNG đưa thẳng lên app.
 * Có đưa vào (an toàn, đúng bản chất mô tả y khoa thuần tuý, không phải hướng dẫn thao tác):
 *   `kb_acupoint_anatomy_claims` (giải phẫu mô tả lớp cấu trúc — anatomy_text_*) và
 *   `kb_acupoint_safety_rules.caution_text_*` (cảnh báo an toàn NGẮN dạng tổng hợp, vd. "phụ nữ
 *   mang thai thận trọng" — không có chi tiết kỹ thuật).
 * Nhiều bảng claim (locations/indications) còn lẫn cả bản ghi cũ (content_version 0.1.x, từ
 * đợt v1.1.2 trước) VÀ bản ghi mới (2.0.0) cho CÙNG 1 acupoint_id (chưa dọn/archive bản cũ bên
 * phía Core DB) — LUÔN ưu tiên bản `content_version==='2.0.0'` khi có, chỉ dùng bản cũ cho các
 * kỳ huyệt (42 điểm) mà đợt v2.0 chưa làm tới.
 *
 * "Nguồn" (nguon, in server.js) is hardcoded to "HVYD Acupoint Core DB" —
 * NOT a citation of the underlying textbook page — because the Core DB
 * itself (compiled/curated by Hạ Vân Y Đạo) is what the app credits as the
 * source, mirroring the herbs convention (decision 2026-08-17, reversing an
 * earlier attempt to cite the raw textbook per claim).
 *
 * Required env vars:
 *   GOOGLE_CREDENTIALS_JSON(_B64)        service account key (see google-auth.js)
 *   GOOGLE_ACUPOINT_CORE_SPREADSHEET_ID  the "HVYD Acupoint Core DB vX.Y.Z" file's ID
 *   MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
 *   MYSQL_PORT (optional, default 3306)
 *   TRANSLATE_CONTACT_EMAIL (optional, raises MyMemory's free daily quota)
 *
 * Usage: node import-acupoint-sheets.js
 */
import { google } from 'googleapis';
import mysql from 'mysql2/promise';
import { pinyin } from 'pinyin';
import { createGoogleAuth } from './google-auth.js';
import { translateBatch } from './translate.js';
import { getMeridianChannelStandard } from './tcm-vocabulary.js';

// name_en trong kb_acupoint_names (locale 'en') thực chất là romanization KHÔNG dấu thanh
// (vd. "Zusanli"), không phải pinyin chuẩn — tự sinh pinyin CÓ dấu từ name_zh bằng thư viện
// `pinyin`, cùng định dạng cách nhau bởi khoảng trắng như cột `pinyin` của Dược liệu
// (vd. "zú sān lǐ") để card/popup hiện đúng màu cam giống Dược liệu (yêu cầu 2026-08-17).
//
// ⚠️ Thư viện `pinyin` là từ điển tần suất tiếng Trung PHỔ THÔNG, không biết ngữ cảnh
// thuật ngữ Trung Y — sai âm đọc cho các chữ đa âm quen thuộc trong tên huyệt. Phát hiện
// 2026-08-17 (user báo "Bàng Quang Du" đọc "yú" là sai) — rà soát toàn bộ 404 tên huyệt,
// xác nhận 6 chữ bị đọc sai và override thủ công theo đúng quy ước TCM chuẩn:
const PINYIN_OVERRIDES = {
  '俞': 'shù',  // KHÔNG phải 'yú' (họ người) — trong "背俞穴"/tên huyệt luôn là 'shù'.
                // Ảnh hưởng 25 huyệt: 肺俞/心俞/脾俞/肾俞/胃俞/膀胱俞... (BL-13~30, KI-16, KI-27, SI-10/14/15, GV-2, EX-B-3).
  '少': 'shào', // KHÔNG phải 'shǎo' ("ít") — nghĩa "thiếu/trẻ" (như 少阴/少阳) luôn là 'shào'.
                // Ảnh hưởng: 少商 LU-11, 少泽 SI-1, 少冲 HT-9, 少府 HT-8, 少海 HT-3.
  '血': 'xuè',  // KHÔNG phải 'xiě' (khẩu ngữ) — thuật ngữ y khoa/trang trọng luôn là 'xuè'.
                // Ảnh hưởng: 血海 SP-10.
  '行': 'xíng', // KHÔNG phải 'háng' ("hàng/dòng") — nghĩa "đi/vận hành" luôn là 'xíng'.
                // Ảnh hưởng: 行间 LR-2.
  '舍': 'shè',  // KHÔNG phải 'shě' ("từ bỏ") — nghĩa danh từ "nơi ở/trú" luôn là 'shè'.
                // Ảnh hưởng: 意舍 BL-49, 府舍 SP-13, 气舍 ST-11.
  '郄': 'xì',   // KHÔNG phải 'qiè' — "郄穴" (huyệt khích) luôn đọc 'xì'.
                // Ảnh hưởng: 浮郄 BL-38, 阴郄 HT-6, 郄门 PC-4.
};
function toPinyin(hanzi) {
  if (!hanzi) return null;
  const chars = Array.from(hanzi);
  const syllables = pinyin(hanzi, { style: 'tone' }).map((syll) => syll[0]);
  return chars.map((ch, i) => PINYIN_OVERRIDES[ch] || syllables[i]).join(' ');
}

const auth = createGoogleAuth(['https://www.googleapis.com/auth/spreadsheets.readonly']);
const sheets = google.sheets({ version: 'v4', auth });

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

// Kỳ huyệt (EXTRA_ACUPOINT) không thuộc kinh chính nào trong kb_acupoint_meridian_map —
// gán 1 "kinh giả" để vẫn lọc được theo group2 trên UI thay vì rơi ra khỏi mọi bộ lọc.
const EXTRA_POINT_GROUP = { zh: '奇穴', vi: 'Kỳ Huyệt', en: 'Extra points' };

// Tên kinh lạc tiếng Việt CHUẨN (Thủ/Túc + Âm-Dương + Tạng phủ, viết hoa từng chữ) — nguồn
// (kb_meridians.label_vi) viết theo thứ tự ngược (Tạng phủ trước, Thủ/Túc sau, không viết
// hoa) nên KHÔNG dùng thẳng, thay bằng bảng tra cứu chuẩn theo đúng quy ước Trung Y (yêu cầu
// 2026-08-17: "Kinh Thủ Thái Dương Tiểu Trường", viết hoa chữ cái đầu mỗi từ, áp dụng cả cho
// Nhâm mạch/Đốc mạch) — đọc từ backend/data/tcm-vocabulary.json, nguồn chân lý DUY NHẤT dùng
// chung với import-herbal-sheets.js/fix-herb-tvm-fields.js/frontend search (xem
// project_chimedis_translation_qa).
const MERIDIAN_VI_STANDARD = getMeridianChannelStandard();

export async function runImport() {
  const spreadsheetId = process.env.GOOGLE_ACUPOINT_CORE_SPREADSHEET_ID;
  if (!spreadsheetId) {
    throw new Error('Thiếu GOOGLE_ACUPOINT_CORE_SPREADSHEET_ID (ID file "HVYD Acupoint Core DB vX.Y.Z").');
  }

  console.log('📖 Đang đọc dữ liệu từ Acupoint Core DB...');
  const [
    acupoints, names, meridians, meridianMap,
    locations, indications, actionClaims, actionCodes,
    classMap, classCodes, bodyRegions,
    anatomyClaims, safetyRules,
  ] = await Promise.all([
    readTab(spreadsheetId, 'kb_acupoints'),
    readTab(spreadsheetId, 'kb_acupoint_names'),
    readTab(spreadsheetId, 'kb_meridians'),
    readTab(spreadsheetId, 'kb_acupoint_meridian_map'),
    readTab(spreadsheetId, 'kb_acupoint_locations'),
    readTab(spreadsheetId, 'kb_acupoint_indication_claims'),
    readTab(spreadsheetId, 'kb_acupoint_action_claims'),
    readTab(spreadsheetId, 'ref_action_codes'),
    readTab(spreadsheetId, 'kb_acupoint_class_map'),
    readTab(spreadsheetId, 'ref_acupoint_class_codes'),
    readTab(spreadsheetId, 'ref_body_regions'),
    readTab(spreadsheetId, 'kb_acupoint_anatomy_claims'),
    readTab(spreadsheetId, 'kb_acupoint_safety_rules'),
  ]);
  console.log(`   acupoints=${acupoints.length} names=${names.length} meridians=${meridians.length} meridian_map=${meridianMap.length} locations=${locations.length} indications=${indications.length} action_claims=${actionClaims.length} class_map=${classMap.length} anatomy_claims=${anatomyClaims.length} safety_rules=${safetyRules.length}`);

  // Nhiều bảng claim (locations/indications) có CẢ bản ghi cũ (content_version 0.1.x, đợt
  // v1.1.2) lẫn bản mới (2.0.0) cho cùng 1 acupoint_id — nhóm theo acupoint_id rồi ưu tiên
  // đúng 1 bản '2.0.0' nếu có, else lấy bản có sẵn bất kỳ (đa số các kỳ huyệt v2.0 chưa làm tới).
  function pickLatestByAcupointId(claimRows) {
    const groups = new Map();
    for (const r of claimRows) {
      if (!r.acupoint_id) continue;
      const list = groups.get(r.acupoint_id) || [];
      list.push(r);
      groups.set(r.acupoint_id, list);
    }
    const result = new Map();
    for (const [id, list] of groups) {
      const v2 = list.find((r) => r.content_version === '2.0.0');
      if (!v2) { result.set(id, list[0]); continue; }
      // ⚠️ Phát hiện 2026-09-28: batch nào sau LU/LI (Phế, Đại Trường) trong Core DB v2.0 CHƯA
      // dịch tiếng Việt (translation_vi/patient_position_vi/normalized_summary_vi rỗng) dù
      // tiếng Trung đã đủ và README ghi "CLOSED"/"content enrichment complete" — README chỉ
      // theo dõi độ đầy đủ trích xuất tiếng Trung, KHÔNG phải độ đầy đủ dịch Việt. Bản ghi CŨ
      // (content_version khác 2.0.0, còn sót lại trong Sheet) lại CÓ sẵn bản dịch Việt thật từ
      // đợt trước (v1.1.2) — xác nhận qua khảo sát: 373/373 huyệt ngoài LU/LI có bản cũ đều có
      // translation_vi. Merge: giữ MỌI field của bản 2.0.0 (mới/đúng hơn, kể cả tiếng Trung đã
      // sửa), nhưng field nào tên kết thúc "_vi" mà bản 2.0.0 để trống thì lấy từ bản cũ thay vì
      // bỏ trống — tránh làm MẤT bản dịch Việt đã có sẵn (lỗi thật đã gặp phải ở lần chạy đầu).
      const legacy = list.find((r) => r !== v2);
      if (!legacy) { result.set(id, v2); continue; }
      const merged = { ...v2 };
      for (const key of Object.keys(v2)) {
        if (key.endsWith('_vi') && (!merged[key] || !String(merged[key]).trim()) && legacy[key]) {
          merged[key] = legacy[key];
        }
      }
      result.set(id, merged);
    }
    return result;
  }

  const acupointIdSet = new Set(acupoints.map((a) => a.acupoint_id));
  const meridianById = new Map(meridians.map((m) => [m.meridian_id, m]));
  const meridianByAcupointId = new Map(meridianMap.filter((m) => m.is_primary === true || m.is_primary === 'TRUE').map((m) => [m.acupoint_id, meridianById.get(m.meridian_id)]));

  const namesByAcupointId = new Map();
  for (const n of names) {
    if (!n.acupoint_id) continue;
    const list = namesByAcupointId.get(n.acupoint_id) || [];
    list.push(n);
    namesByAcupointId.set(n.acupoint_id, list);
  }
  function nameFor(acupointId, locale) {
    const list = namesByAcupointId.get(acupointId) || [];
    const row = list.find((n) => n.locale === locale && (n.is_canonical === true || n.is_canonical === 'TRUE')) || list.find((n) => n.locale === locale);
    return row ? row.name_text : null;
  }

  // Văn bản tiếng Việt (vị trí/chủ trị) nhắc tới huyệt khác chỉ bằng MÃ (vd. "ST-35"), thiếu
  // hẳn tên Việt — trong khi bản tiếng Trung nguồn LUÔN có cả tên lẫn mã, vd. "犊鼻（ST35）".
  // Chèn lại tên Việt trước mã để nhất quán, vd. "ST-35" -> "Độc Tỵ (ST-35)" (yêu cầu 2026-08-17).
  const POINT_CODE_RE = /\b[A-Z]{2,3}(?:-[A-Z]{2,3})?-\d+\b/g;
  function annotatePointCodes(text) {
    if (!text) return text;
    return text.replace(POINT_CODE_RE, (code) => {
      if (!acupointIdSet.has(code)) return code;
      const viName = nameFor(code, 'vi-VN');
      return viName ? `${viName} (${code})` : code;
    });
  }

  const locationByAcupointId = pickLatestByAcupointId(locations);
  const indicationByAcupointId = pickLatestByAcupointId(indications);
  const anatomyByAcupointId = pickLatestByAcupointId(anatomyClaims); // 1:1, không có bản cũ để lẫn
  const bodyRegionById = new Map(bodyRegions.map((b) => [b.body_region_id, b]));

  // An toàn: 1 huyệt có thể có NHIỀU luật (vd. LI-4 vừa cảnh báo thai phụ vừa cảnh báo khác) —
  // nối lại bằng "; " thay vì chỉ lấy 1 dòng. Chỉ lấy caution_text_* (câu tổng hợp ngắn cho
  // người đọc thường) — KHÔNG lấy prohibited_action/anatomical_risk_structure/technique_scope
  // (chi tiết kỹ thuật, xem ghi chú đầu file).
  const safetyByAcupointId = new Map();
  for (const s of safetyRules) {
    if (!s.acupoint_id) continue;
    const list = safetyByAcupointId.get(s.acupoint_id) || [];
    list.push(s);
    safetyByAcupointId.set(s.acupoint_id, list);
  }
  function buildCaution(acupointId) {
    const rules = safetyByAcupointId.get(acupointId);
    if (!rules || rules.length === 0) return { zh: null, vi: null, en: null };
    const zh = rules.map((r) => r.caution_text_zh).filter(Boolean).join('; ');
    const vi = rules.map((r) => r.caution_text_vi).filter(Boolean).join('; ');
    const en = rules.map((r) => r.caution_text_en).filter(Boolean).join('; ');
    return { zh: zh || null, vi: vi || null, en: en || null };
  }

  const actionClaimsByAcupointId = new Map();
  for (const c of actionClaims) {
    if (!c.acupoint_id) continue;
    const list = actionClaimsByAcupointId.get(c.acupoint_id) || [];
    list.push(c);
    actionClaimsByAcupointId.set(c.acupoint_id, list);
  }
  function buildAction(acupointId) {
    const claims = actionClaimsByAcupointId.get(acupointId);
    if (!claims || claims.length === 0) return { zh: null, vi: null, en: null };
    // translation_vi/zh/en trên chính claim đã là câu văn đầy đủ (lý giải vì sao huyệt
    // có tác dụng đó) — nối nhiều claim bằng xuống dòng, không cần tra thêm ref_action_codes
    // (bảng đó chỉ cho nhãn ngắn của action_code, dùng làm chú thích phụ nếu cần sau này).
    const zh = claims.map((c) => c.source_text).filter(Boolean).join('\n');
    const vi = claims.map((c) => annotatePointCodes(c.translation_vi)).filter(Boolean).join('\n');
    const en = claims.map((c) => c.translation_en).filter(Boolean).join('\n');
    return { zh: zh || null, vi: vi || null, en: en || null };
  }

  const classCodeById = new Map(classCodes.map((c) => [c.class_code, c]));
  const classMapByAcupointId = new Map();
  for (const m of classMap) {
    if (!m.acupoint_id || !m.class_code) continue;
    const list = classMapByAcupointId.get(m.acupoint_id) || [];
    list.push(m.class_code);
    classMapByAcupointId.set(m.acupoint_id, list);
  }
  function buildSpecialClass(acupointId) {
    const codes = classMapByAcupointId.get(acupointId) || [];
    const zh = [], vi = [], en = [];
    for (const code of codes) {
      const c = classCodeById.get(code);
      if (!c) continue;
      if (c.label_zh) zh.push(c.label_zh);
      if (c.label_vi) vi.push(c.label_vi);
      if (c.label_en) en.push(c.label_en);
    }
    return { zh: zh.join('、') || null, vi: vi.join(', ') || null, en: en.join(', ') || null };
  }

  // ----- Bù EN bằng dịch máy cho những huyệt nguồn không có sẵn (đa số) -----
  const locList = acupoints.map((a) => locationByAcupointId.get(a.acupoint_id) || {});
  const indList = acupoints.map((a) => indicationByAcupointId.get(a.acupoint_id) || {});
  const anatList = acupoints.map((a) => anatomyByAcupointId.get(a.acupoint_id) || {});
  const cautionList = acupoints.map((a) => buildCaution(a.acupoint_id));
  const locNeedsEn = locList.map((l) => !l.translation_en && l.source_text);
  const indNeedsEn = indList.map((i) => !i.translation_en && i.source_text);
  // anatomy: dùng normalized_summary_zh làm nguồn dịch (giống normalized_summary_vi đã dùng cho
  // cột vi) — translation_en/normalized_summary_en gần như luôn trống ở đợt v2.0 hiện tại.
  const anatNeedsEn = anatList.map((x) => !x.translation_en && !x.normalized_summary_en && x.normalized_summary_zh);
  const cautionNeedsEn = cautionList.map((c, i) => !c.en && c.zh);
  const locCount = locNeedsEn.filter(Boolean).length;
  const indCount = indNeedsEn.filter(Boolean).length;
  const anatCount = anatNeedsEn.filter(Boolean).length;
  const cautionCount = cautionNeedsEn.filter(Boolean).length;
  console.log(`🌐 Dịch máy bù EN: vị trí ${locCount}, chủ trị ${indCount}, giải phẫu ${anatCount}, an toàn ${cautionCount} / ${acupoints.length} (MyMemory)...`);
  const progress = (label) => (done, total) => { if (done === total) console.log(`   ${label}: ${done}/${total}`); };
  const [locEnTranslated, indEnTranslated, anatEnTranslated, cautionEnTranslated] = await Promise.all([
    translateBatch(locList.map((l, i) => (locNeedsEn[i] ? l.source_text : '')), 'en', progress('vị trí→en')),
    translateBatch(indList.map((i2, i) => (indNeedsEn[i] ? i2.source_text : '')), 'en', progress('chủ trị→en')),
    translateBatch(anatList.map((x, i) => (anatNeedsEn[i] ? x.normalized_summary_zh : '')), 'en', progress('giải phẫu→en')),
    translateBatch(cautionList.map((c, i) => (cautionNeedsEn[i] ? c.zh : '')), 'en', progress('an toàn→en')),
  ]);

  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
  });

  const rows = [];
  acupoints.forEach((a, i) => {
    if (a.is_active === false || a.is_active === 'FALSE') return;

    const meridian = meridianByAcupointId.get(a.acupoint_id);
    const isExtra = a.entity_type === 'EXTRA_ACUPOINT';
    const meridianZh = meridian ? meridian.label_zh : (isExtra ? EXTRA_POINT_GROUP.zh : null);
    const meridianVi = meridian ? (MERIDIAN_VI_STANDARD[meridian.canonical_code] || meridian.label_vi) : (isExtra ? EXTRA_POINT_GROUP.vi : null);
    const meridianEn = meridian ? meridian.label_en : (isExtra ? EXTRA_POINT_GROUP.en : null);

    const loc = locList[i];
    const ind = indList[i];
    const anat = anatList[i];
    const caution = cautionList[i];
    const bodyRegion = bodyRegionById.get(loc.body_region_id) || {};
    const action = buildAction(a.acupoint_id);
    const specialClass = buildSpecialClass(a.acupoint_id);

    const locationEn = loc.translation_en || (locNeedsEn[i] ? locEnTranslated[i] : null) || null;
    const indicationEn = ind.translation_en || (indNeedsEn[i] ? indEnTranslated[i] : null) || null;
    const anatomyZh = anat.normalized_summary_zh || anat.translation_zh || null;
    const anatomyVi = anat.normalized_summary_vi || anat.translation_vi || null;
    const anatomyEn = anat.translation_en || anat.normalized_summary_en || (anatNeedsEn[i] ? anatEnTranslated[i] : null) || null;
    const cautionEn = caution.en || (cautionNeedsEn[i] ? cautionEnTranslated[i] : null) || null;
    const enMachineTranslated = (locNeedsEn[i] && !!locEnTranslated[i]) || (indNeedsEn[i] && !!indEnTranslated[i])
      || (anatNeedsEn[i] && !!anatEnTranslated[i]) || (cautionNeedsEn[i] && !!cautionEnTranslated[i]);

    const nameZh = nameFor(a.acupoint_id, 'zh-CN');
    if (!nameZh) return; // tên là bắt buộc — bỏ qua nếu thiếu, tránh vi phạm NOT NULL

    rows.push([
      a.acupoint_id, a.entity_type, a.sequence_number ? parseInt(a.sequence_number, 10) : null, a.laterality_policy || null,
      meridian ? meridian.canonical_code : null, meridianZh, meridianVi, meridianEn,
      bodyRegion.label_zh || null, bodyRegion.label_vi || null, bodyRegion.label_en || null,
      nameZh, toPinyin(nameZh), nameFor(a.acupoint_id, 'vi-VN'), nameFor(a.acupoint_id, 'en'),
      loc.source_text || null, annotatePointCodes(loc.translation_vi) || null, locationEn,
      ind.source_text || null, annotatePointCodes(ind.translation_vi) || null, indicationEn,
      action.zh, action.vi, action.en,
      specialClass.zh, specialClass.vi, specialClass.en,
      anatomyZh, annotatePointCodes(anatomyVi), anatomyEn,
      caution.zh, caution.vi, cautionEn,
      enMachineTranslated,
      true,
    ]);
  });

  console.log(`📝 Đang ghi ${rows.length} huyệt vào MySQL (1 lệnh bulk insert)...`);
  if (rows.length > 0) {
    await conn.query(
      `INSERT INTO acupoints (
         acupoint_id, entity_type, sequence_number, laterality,
         meridian_code, meridian_zh, meridian_vi, meridian_en,
         body_region_zh, body_region_vi, body_region_en,
         name_zh, py, name_vi, name_en,
         location_text_zh, location_text_vi, location_text_en,
         indication_text_zh, indication_text_vi, indication_text_en,
         action_text_zh, action_text_vi, action_text_en,
         special_class_zh, special_class_vi, special_class_en,
         anatomy_text_zh, anatomy_text_vi, anatomy_text_en,
         caution_text_zh, caution_text_vi, caution_text_en,
         en_machine_translated,
         is_active
       ) VALUES ?
       ON DUPLICATE KEY UPDATE
         entity_type=VALUES(entity_type), sequence_number=VALUES(sequence_number), laterality=VALUES(laterality),
         meridian_code=VALUES(meridian_code), meridian_zh=VALUES(meridian_zh), meridian_vi=VALUES(meridian_vi), meridian_en=VALUES(meridian_en),
         body_region_zh=VALUES(body_region_zh), body_region_vi=VALUES(body_region_vi), body_region_en=VALUES(body_region_en),
         name_zh=VALUES(name_zh), py=VALUES(py), name_vi=VALUES(name_vi), name_en=VALUES(name_en),
         location_text_zh=VALUES(location_text_zh), location_text_vi=VALUES(location_text_vi), location_text_en=VALUES(location_text_en),
         indication_text_zh=VALUES(indication_text_zh), indication_text_vi=VALUES(indication_text_vi), indication_text_en=VALUES(indication_text_en),
         action_text_zh=VALUES(action_text_zh), action_text_vi=VALUES(action_text_vi), action_text_en=VALUES(action_text_en),
         special_class_zh=VALUES(special_class_zh), special_class_vi=VALUES(special_class_vi), special_class_en=VALUES(special_class_en),
         anatomy_text_zh=VALUES(anatomy_text_zh), anatomy_text_vi=VALUES(anatomy_text_vi), anatomy_text_en=VALUES(anatomy_text_en),
         caution_text_zh=VALUES(caution_text_zh), caution_text_vi=VALUES(caution_text_vi), caution_text_en=VALUES(caution_text_en),
         en_machine_translated=VALUES(en_machine_translated),
         is_active=VALUES(is_active)`,
      [rows]
    );
  }

  await conn.execute(
    `INSERT INTO import_log (source_key, domain, spreadsheet_id, row_count) VALUES ('acupoint_core_db', 'acupoint', ?, ?)
     ON DUPLICATE KEY UPDATE spreadsheet_id=VALUES(spreadsheet_id), row_count=VALUES(row_count), imported_at=CURRENT_TIMESTAMP`,
    [spreadsheetId, rows.length]
  );

  await conn.end();
  console.log(`\n✨ Hoàn tất: đã import ${rows.length} huyệt vào MySQL.`);
  return rows.length;
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  runImport().catch((err) => {
    console.error('❌ Import thất bại:', err);
    process.exit(1);
  });
}
