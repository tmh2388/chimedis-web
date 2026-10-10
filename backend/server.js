import express from 'express';
import cors from 'cors';
import { mountAppBundle } from './lib/app-bundle.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { runImport } from './import-herbal-sheets.js';
import { buildAPI } from './build-api.js';
import { verifyFirebaseToken, isFirebaseConfigured } from './firebase-admin.js';
import { analyzeInterpretation, buildVocabHint, normalize as normalizeInterp } from './lib/interpret-check.js';
import { syncGeneralTerms } from './lib/general-terms-sync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// CORS + JSON phải đứng TRƯỚC mọi route /api/*: app iOS chạy ở capacitor://localhost nên gọi API chéo origin;
// route đặt trước cors() sẽ không có header CORS (app bị chặn) và route POST/PUT trước express.json() nhận req.body rỗng.
// /api/pronunciation-score có parser riêng giới hạn 25mb (audio base64) nên loại khỏi parser mặc định 100kb.
const defaultJson = express.json();
app.use(cors());
app.use((req, res, next) => (['/api/pronunciation-score', '/api/interpret-check'].includes(req.path) ? next() : defaultJson(req, res, next)));
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'chimedis-secret-key';

// MySQL is optional — herb data (from Google Sheets via import-herbal-sheets.js)
// only appears in /api/terms once MYSQL_HOST etc. are configured. Without it,
// /api/terms still works with just the Giải phẫu data from public/data/terms.json.
const mysqlPool = process.env.MYSQL_HOST
  ? mysql.createPool({
      host: process.env.MYSQL_HOST,
      port: process.env.MYSQL_PORT || 3306,
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
      connectionLimit: 5,
    })
  : null;

// Gieo/cập nhật thuật ngữ "Tổng hợp" từ backend/data/general-terms/*.json vào MySQL mỗi lần khởi động.
if (mysqlPool) {
  syncGeneralTerms(mysqlPool, path.join(__dirname, 'data', 'general-terms'))
    .then((r) => console.log(`[general-terms] đồng bộ: ${r.total} thuật ngữ trong file, ${r.written} dòng thay đổi`))
    .catch((err) => console.error('⚠️  Không đồng bộ được thuật ngữ Tổng hợp:', err.message));
}

/**
 * Maps a `herbs` MySQL row into the same shape /api/terms already returns
 * for Giải phẫu, so the frontend's existing list/search code works
 * unchanged. Herb-specific fields (taste, meridian, dose...) ride along
 * for the detail view to use.
 */
function herbRowToTerm(h) {
  return {
    id: h.herb_id,
    hz: h.name_zh,
    hz_traditional: h.name_zh_traditional,
    py: h.pinyin,
    vi: h.name_vi,
    en: h.latin_name,
    group1: 'Dược liệu',
    // group2 luôn giữ nguyên tiếng Trung làm khoá lọc ổn định (không đổi khi
    // chuyển ngôn ngữ hiển thị) — group2_vi/en chỉ dùng để hiển thị nhãn.
    group2: h.section_zh || h.chapter_zh,
    group2_vi: h.section_vi || h.chapter_vi,
    group2_en: h.section_en || h.chapter_en,
    vitri: h.medicinal_part,
    // "Nguồn" ghi tên bộ dữ liệu do Hạ Vân Y Đạo tự xây dựng (không phải loài thực vật gốc —
    // đó là thông tin khác, không phải "nguồn" theo ý nghĩa quyền sở hữu dữ liệu). Quyết định
    // 2026-08-17, áp dụng thống nhất cho mọi domain có Core DB riêng (xem acupoints tương tự).
    nguon: 'HVYD Herbal Core DB',
    verify: false,
    category: 'herb',
    temperature_vi: h.temperature_vi,
    temperature_zh: h.temperature_zh,
    temperature_en: h.temperature_en,
    taste_vi: h.taste_vi,
    taste_zh: h.taste_zh,
    taste_en: h.taste_en,
    meridian_vi: h.meridian_vi,
    meridian_zh: h.meridian_zh,
    meridian_en: h.meridian_en,
    action_zh: h.action_text_zh,
    action_vi: h.action_text_vi,
    action_en: h.action_text_en,
    indication_zh: h.indication_text_zh,
    indication_vi: h.indication_text_vi,
    indication_en: h.indication_text_en,
    dose_text_zh: h.dose_text_zh,
    dose_text_vi: h.dose_text_vi,
    dose_text_en: h.dose_text_en,
    dose_min_g: h.dose_min_g,
    dose_max_g: h.dose_max_g,
    caution_zh: h.caution_text_zh,
    caution_vi: h.caution_text_vi,
    caution_en: h.caution_text_en,
    cn_machine: !!h.machine_translated,
  };
}

async function getHerbTerms() {
  if (!mysqlPool) return [];
  try {
    const [rows] = await mysqlPool.query('SELECT * FROM herbs WHERE is_active = TRUE');
    return rows.map(herbRowToTerm);
  } catch (err) {
    console.error('⚠️  Không đọc được dữ liệu dược liệu từ MySQL:', err.message);
    return [];
  }
}

/**
 * Maps an `anatomy_terms` MySQL row (Giải phẫu/Sinh lý) into the same flat
 * term shape /api/terms already returns — field names (vitri/congnang/tcm/
 * lamsang + _cn/_en variants) match what the frontend's non-herb popup
 * branch expects (see frontend/index.html openPopup()).
 */
function anatomyRowToTerm(a) {
  return {
    id: a.term_id,
    hz: a.hz,
    py: a.py,
    vi: a.vi,
    en: a.en,
    group1: a.domain,
    // group2 luôn giữ nguyên tiếng Trung làm khoá lọc ổn định, giống Dược liệu —
    // group2_vi/group2_en chỉ dùng để hiển thị nhãn.
    group2: a.organ_system_zh,
    group2_vi: a.organ_system_vi,
    group2_en: a.organ_system_en,
    vitri: a.position_vi,
    vitri_cn: a.position_zh,
    vitri_en: a.position_en,
    congnang: a.function_vi,
    congnang_cn: a.function_zh,
    congnang_en: a.function_en,
    tcm: a.tcm_note_vi,
    tcm_cn: a.tcm_note_zh,
    tcm_en: a.tcm_note_en,
    lamsang: a.clinical_vi,
    lamsang_cn: a.clinical_zh,
    lamsang_en: a.clinical_en,
    nguon: a.source,
    verify: !!a.verify,
    verify_note: a.verify_note,
    cn_machine: !!a.machine_translated,
  };
}

async function getAnatomyTerms() {
  if (!mysqlPool) return [];
  try {
    const [rows] = await mysqlPool.query('SELECT * FROM anatomy_terms WHERE is_active = TRUE');
    return rows.map(anatomyRowToTerm);
  } catch (err) {
    console.error('⚠️  Không đọc được dữ liệu Giải phẫu/Sinh lý từ MySQL:', err.message);
    return [];
  }
}

/**
 * "Tổng hợp" — bảng general_terms (cùng cột với anatomy_terms, domain luôn 'Tổng hợp').
 * Nội dung do repo chimedis-web-home quản lý (scripts/build-general-terms.mjs) — dict chỉ
 * ĐỌC, không ghi. Quy ước ô: position_* = Định nghĩa, clinical_* = Ứng dụng, function_ và tcm_note_ (mọi ngôn ngữ) để NULL. Tái dùng anatomyRowToTerm nên cờ verify/machine_translated chỉ để nội bộ.
 */
async function getGeneralTerms() {
  if (!mysqlPool) return [];
  try {
    const [rows] = await mysqlPool.query('SELECT * FROM general_terms WHERE is_active = 1');
    return rows.map(r => ({ ...anatomyRowToTerm(r), group1: 'Tổng hợp' }));
  } catch (err) {
    console.error('⚠️  Không đọc được dữ liệu Tổng hợp từ MySQL:', err.message);
    return [];
  }
}

/**
 * Bỏ các mục Tổng hợp trùng với thuật ngữ ĐÃ CÓ ở nhóm khác (cùng id hoặc cùng chữ Hán)
 * và trùng lẫn nhau — mục đã có được giữ, mục Tổng hợp trùng bị bỏ qua.
 */
function dedupeGeneralTerms(generalTerms, existingTerms) {
  const seenId = new Set(existingTerms.map(t => t.id));
  const seenHz = new Set(existingTerms.map(t => t.hz).filter(Boolean));
  return generalTerms.filter(t => {
    if (seenId.has(t.id) || (t.hz && seenHz.has(t.hz))) return false;
    seenId.add(t.id);
    if (t.hz) seenHz.add(t.hz);
    return true;
  });
}

/**
 * Maps an `acupoints` MySQL row (Huyệt vị) into the same flat term shape
 * /api/terms returns for other domains — reuses herb's field names
 * (action_* and indication_*) since the popup template branch for 'acupoint'
 * follows the same layout as 'herb'. Unlike herbs, none of these fields are
 * machine translated (the source already ships real vi/zh/en translations),
 * so there is no cn_machine flag here.
 */
// Bảo vệ tạm thời (2026-08-17): MyMemory bị rate-limit đã trả về NGUYÊN VĂN chữ Hán làm
// "bản dịch" EN cho ~335/404 huyệt (xem translate.js/isUntranslatedEcho, fix-acupoint-en-echo.js)
// — ẩn các trường này khỏi API thay vì hiện nhầm tiếng Trung dưới nhãn tiếng Anh, cho tới khi
// chạy lại được fix-acupoint-en-echo.js (đợi MyMemory reset quota). Không sửa DB ở đây, chỉ lọc
// lúc trả API — DB giữ nguyên để fix-acupoint-en-echo.js còn nhận diện được hàng nào cần dịch lại.
function safeEn(en) {
  return (en && /[a-zA-ZÀ-ỹ]/.test(en)) ? en : null;
}
// Hình nguồn kinh mạch/định vị huyệt (87 hình trích từ 《经络腧穴学》, xem build-acupoint-figures.mjs).
// ⚠️ Core DB đánh dấu COPYRIGHTED_SOURCE_REFERENCE/internal_use_only — founder quyết định dùng TẠM
// (2026-10-07). Tắt nhanh không cần deploy code: đặt env SOURCE_FIGURES_ENABLED=false trên Hostinger.
const SOURCE_FIGURES_ENABLED = process.env.SOURCE_FIGURES_ENABLED !== 'false';
let ACUPOINT_FIGURES = { media: {}, byPoint: {} };
try {
  ACUPOINT_FIGURES = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'acupoint-figures.json'), 'utf8'));
} catch { /* chưa build hình — popup đơn giản không có khối hình */ }
// Mỗi hình trả về: src, fig (số hình), cap (chú thích zh), w/h (px gốc), hl ('text' = bôi đỏ chữ, 'box' =
// khung đỏ khi nền là ảnh chụp), box ([x,y,w,h] px gốc của TÊN huyệt này trong hình — từ
// locate-figure-labels.mjs; không có = không bôi đỏ).
function figEntry(mediaId, acupointId) {
  const m = ACUPOINT_FIGURES.media[mediaId];
  if (!m) return null;
  const box = ACUPOINT_FIGURES.labels && ACUPOINT_FIGURES.labels[mediaId] && ACUPOINT_FIGURES.labels[mediaId][acupointId];
  return { src: m.src, fig: m.figure, cap: m.caption_zh, w: m.w, h: m.h, hl: m.hl, box: box || undefined };
}
// Hình CỦA HUYỆT (chi tiết vị trí). Hình cả đường kinh KHÔNG nằm ở đây — xem meridianFiguresFor().
function figuresFor(acupointId) {
  if (!SOURCE_FIGURES_ENABLED) return undefined;
  const ids = ACUPOINT_FIGURES.byPoint[acupointId];
  if (!ids || !ids.length) return undefined;
  return ids.map((id) => figEntry(id, acupointId)).filter(Boolean);
}
// Hình cả đường kinh (14 hình, mỗi kinh 1 hình) — popup huyệt chỉ hiện NÚT "Hình đường kinh", bấm mới mở.
function meridianFiguresFor(acupointId) {
  if (!SOURCE_FIGURES_ENABLED) return undefined;
  const ids = ACUPOINT_FIGURES.byMeridian && ACUPOINT_FIGURES.byMeridian[acupointId.split('-')[0]];
  if (!ids || !ids.length) return undefined;
  return ids.map((id) => figEntry(id, acupointId)).filter(Boolean);
}
// Đặc tính huyệt đặc hiệu kèm chi tiết (giao hội với kinh nào, lạc sang kinh nào...) — xem build-acupoint-class-detail.mjs.
let ACUPOINT_CLASS_DETAIL = { byPoint: {} };
try {
  ACUPOINT_CLASS_DETAIL = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'acupoint-class-detail.json'), 'utf8'));
} catch { /* chưa build — popup chỉ có nhãn loại huyệt */ }
function acupointRowToTerm(a) {
  return {
    class_detail: ACUPOINT_CLASS_DETAIL.byPoint[a.acupoint_id],
    figures: figuresFor(a.acupoint_id),
    mfigures: meridianFiguresFor(a.acupoint_id),
    id: a.acupoint_id,
    hz: a.name_zh,
    py: a.py || '', // pinyin có dấu, tự sinh khi import (xem import-acupoint-sheets.js) —
                     // fallback '' (không phải null/undefined) để tránh in chữ "undefined"
                     // trong các mẫu `${term.py}` ở frontend nếu vì lý do gì đó bị thiếu.
    vi: a.name_vi,
    en: a.name_en,
    group1: 'Huyệt vị',
    // group2 = kinh lạc (tiếng Trung làm khoá lọc ổn định), giống quy ước Dược liệu/Giải phẫu.
    group2: a.meridian_zh,
    group2_vi: a.meridian_vi,
    group2_en: a.meridian_en,
    sequence_number: a.sequence_number,
    vitri: a.body_region_vi,
    category: 'acupoint',
    entity_type: a.entity_type,
    laterality: a.laterality,
    location_zh: a.location_text_zh,
    location_vi: a.location_text_vi,
    location_en: safeEn(a.location_text_en),
    indication_zh: a.indication_text_zh,
    indication_vi: a.indication_text_vi,
    indication_en: safeEn(a.indication_text_en),
    action_zh: a.action_text_zh,
    action_vi: a.action_text_vi,
    action_en: a.action_text_en,
    special_class_zh: a.special_class_zh,
    special_class_vi: a.special_class_vi,
    special_class_en: a.special_class_en,
    // Bổ sung 2026-09-28 từ Core DB v2.0: giải phẫu (mô tả lớp cấu trúc, KHÔNG phải hướng dẫn
    // thao tác châm) + cảnh báo an toàn ngắn. Xem import-acupoint-sheets.js đầu file cho lý do
    // vì sao KHÔNG có trường thao tác/độ sâu kim (procedure_claims cố ý không nhập vào DB).
    anatomy_zh: a.anatomy_text_zh,
    anatomy_vi: a.anatomy_text_vi,
    anatomy_en: safeEn(a.anatomy_text_en),
    caution_zh: a.caution_text_zh,
    caution_vi: a.caution_text_vi,
    caution_en: safeEn(a.caution_text_en),
    // "Nguồn" ghi tên bộ dữ liệu Hạ Vân Y Đạo tự xây dựng, KHÔNG phải trích dẫn giáo trình gốc
    // từng trang — xem ghi chú trong import-acupoint-sheets.js/schema.sql (quyết định 2026-08-17).
    nguon: 'HVYD Acupoint Core DB',
    verify: false,
    // Chỉ location_en/indication_en có thể là dịch máy (vi/zh luôn là nội dung thật) — mtNote
    // trong popup vì vậy chỉ nên đáng tin khi đang xem tiếng Anh, nhưng dùng chung cờ với các
    // domain khác cho đơn giản (xem renderMultiLang/mtNote trong frontend).
    cn_machine: !!a.en_machine_translated,
  };
}

async function getAcupointTerms() {
  if (!mysqlPool) return [];
  try {
    const [rows] = await mysqlPool.query('SELECT * FROM acupoints WHERE is_active = TRUE');
    return rows.map(acupointRowToTerm);
  } catch (err) {
    console.error('⚠️  Không đọc được dữ liệu Huyệt vị từ MySQL:', err.message);
    return [];
  }
}

/**
 * Maps a `formulas` MySQL row (Thang Phương / 方剂) into the same flat term
 * shape /api/terms returns for other domains. Popup dùng nhánh riêng
 * `category === 'formula'` (layout: Thành phần / Công năng / Chủ trị /
 * Vận dụng / Kiêng kỵ) — xem frontend/index.html.
 *
 * ⚠️ GATED: domain này chỉ được đưa vào /api/terms khi request có Firebase
 * ID token hợp lệ (user đã đăng nhập) — xem lọc trong GET /api/terms.
 */
function formulaRowToTerm(f) {
  return {
    id: f.formula_id,
    hz: f.name_zh,
    hz_traditional: f.name_zh_traditional,
    py: f.py,
    vi: f.name_vi,
    en: f.name_en,
    group1: 'Thang phương',
    // group2 = loại phương (zh làm khoá lọc ổn định), giống quy ước Dược liệu/Huyệt vị.
    group2: f.category_zh,
    group2_vi: f.category_vi,
    group2_en: f.category_en,
    aliases_zh: f.aliases_zh,
    origin_zh: f.origin_zh, origin_vi: f.origin_vi, origin_en: f.origin_en,
    composition_zh: f.composition_zh, composition_vi: f.composition_vi, composition_en: f.composition_en,
    functions_zh: f.functions_zh, functions_vi: f.functions_vi, functions_en: f.functions_en,
    indications_zh: f.indications_zh, indications_vi: f.indications_vi, indications_en: f.indications_en,
    analysis_zh: f.analysis_zh, analysis_vi: f.analysis_vi, analysis_en: f.analysis_en,
    cautions_zh: f.cautions_zh, cautions_vi: f.cautions_vi, cautions_en: f.cautions_en,
    nguon: f.source || 'HVYD Formula Core DB v2.0.0',
    verify: !!f.verify,
    verify_note: f.verify_note,
    category: 'formula',
    cn_machine: !!f.machine_translated,
  };
}

async function getFormulaTerms() {
  if (!mysqlPool) return [];
  try {
    const [rows] = await mysqlPool.query('SELECT * FROM formulas WHERE is_active = TRUE');
    return rows.map(formulaRowToTerm);
  } catch (err) {
    if (err.code !== 'ER_NO_SUCH_TABLE') {
      console.error('⚠️  Không đọc được dữ liệu Thang phương từ MySQL:', err.message);
    }
    return [];
  }
}

/**
 * Xác thực Firebase token TÙY CHỌN cho các route public (vd. /api/terms): nếu có
 * `Authorization: Bearer <token>` hợp lệ → trả về decoded user; nếu thiếu/sai/chưa
 * cấu hình Firebase → trả null (KHÔNG lỗi, route vẫn chạy bình thường cho khách).
 */
async function optionalFirebaseUser(req) {
  if (!isFirebaseConfigured()) return null;
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  try {
    const admin = (await import('firebase-admin')).default;
    return await admin.auth().verifyIdToken(token);
  } catch { return null; }
}

/**
 * Maps a `word_elements` MySQL row ("Từ ghép Y Khoa" — English prefix/
 * suffix/root/compound-term) into the same flat term shape /api/terms
 * returns for other domains. Unlike everywhere else, `en` is the headword
 * here, not a translation — hz/zh is just a 1-word gloss (see schema.sql).
 * group2 is element_type (prefix/suffix/root/term), the "Loại" filter in
 * dropdown 2 — NOT organ_system, which barely varies for prefix/suffix.
 *
 * meaning/example split vi vs en explicitly at this layer (not left mixed)
 * per the "trường cần định vị rõ ràng" rule — source data's `gloss` field
 * is Vietnamese for prefix/suffix/root entries but English for `term`
 * entries (its own quirk, see schema.sql comment), so the split must
 * happen here rather than trusting a single ambiguous field downstream.
 */
function wordElementRowToTerm(w) {
  return {
    id: w.element_id,
    hz: w.zh,
    py: w.py,
    vi: w.vi,
    en: w.en,
    ipa: w.ipa,
    group1: 'Từ ghép Y Khoa',
    group2: w.element_type,
    category: 'word_element',
    element_type: w.element_type,
    organ_system: w.organ_system,
    meaning: w.element_type === 'term' ? null : w.gloss,
    meaning_en: w.element_type === 'term' ? w.gloss : null,
    example: w.example_vi,
    example_cn: w.example_zh,
    example_en: w.example_en,
    example_ipa: w.example_ipa,
    nguon: '本草詞根 — Y Học Anh Văn',
    verify: false,
  };
}

async function getWordElementTerms() {
  if (!mysqlPool) return [];
  try {
    const [rows] = await mysqlPool.query('SELECT * FROM word_elements WHERE is_active = TRUE');
    return rows.map(wordElementRowToTerm);
  } catch (err) {
    console.error('⚠️  Không đọc được dữ liệu Từ ghép Y Khoa từ MySQL:', err.message);
    return [];
  }
}

/**
 * GĐ2 (từ điển tự học của cổng chimedis.vn): những cụm do LLM dịch từ lưu lượng tìm y văn thật
 * và đã được editor DUYỆT (dict_candidates.status='approved') — đưa vào /api/terms để làm giàu
 * kho từ điển. Nhóm riêng "Thuật ngữ bổ sung", verify=true (đã có người duyệt).
 * Bảng dict_candidates do repo chimedis-home tạo; ở đây chỉ ĐỌC (không lỗi nếu bảng chưa tồn tại).
 */
async function getApprovedCandidateTerms() {
  if (!mysqlPool) return [];
  try {
    const [rows] = await mysqlPool.query(
      "SELECT id, term_display, term_norm, lang, en, syn FROM dict_candidates WHERE status = 'approved'"
    );
    return rows.map((r) => {
      let syn = [];
      try { syn = Array.isArray(r.syn) ? r.syn : JSON.parse(r.syn || '[]'); } catch { syn = []; }
      const isHan = /[㐀-鿿]/.test(r.term_display || '');
      return {
        id: `AUTO-${String(r.id).padStart(6, '0')}`,
        hz: isHan ? r.term_display : null,
        hz_traditional: null,
        py: r.lang === 'zh' ? null : null,
        vi: isHan ? null : r.term_display,
        en: r.en,
        group1: 'Thuật ngữ bổ sung',
        group2: null,
        group2_vi: null,
        group2_en: null,
        vitri: null,
        nguon: 'Tự học (LLM) — đã duyệt',
        verify: true,
        category: null,
        en_synonyms: syn,
      };
    });
  } catch (err) {
    // ER_NO_SUCH_TABLE khi chưa chạy schema bên chimedis-home → coi như rỗng.
    if (err.code !== 'ER_NO_SUCH_TABLE') {
      console.error('⚠️  Không đọc được dict_candidates:', err.message);
    }
    return [];
  }
}

/**
 * Tìm hoặc tạo bản ghi `users` ứng với 1 firebase_uid đã xác thực — gọi ngay sau khi
 * verifyFirebaseToken pass, trước khi dùng user.id cho favorites/settings. Cập nhật lại
 * email/display_name/photo_url mỗi lần gọi (đồng bộ nếu user đổi thông tin bên Firebase/
 * Google/Facebook) và bump last_login_at.
 */
async function getOrCreateUser(firebaseUser) {
  const { uid, email, name, picture } = firebaseUser;
  await mysqlPool.query(
    `INSERT INTO users (firebase_uid, email, display_name, photo_url)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE email = VALUES(email), display_name = VALUES(display_name),
       photo_url = VALUES(photo_url), last_login_at = CURRENT_TIMESTAMP`,
    [uid, email, name, picture]
  );
  const [rows] = await mysqlPool.query('SELECT * FROM users WHERE firebase_uid = ?', [uid]);
  return rows[0];
}

// Middleware dùng chung cho mọi route /api/auth/*, /api/favorites, /api/settings — yêu cầu
// MySQL đã cấu hình (users/favorites/settings đều sống trong MySQL, không có bản offline).
function requireMysql(req, res, next) {
  if (!mysqlPool) {
    return res.status(503).json({ success: false, error: 'Tính năng đăng nhập chưa sẵn sàng (MySQL chưa cấu hình)' });
  }
  next();
}

/**
 * POST /api/auth/sync
 * Gọi ngay sau khi client đăng nhập thành công qua Firebase — đảm bảo có bản ghi `users`
 * tương ứng trước khi dùng các API favorites/settings bên dưới.
 */
app.post('/api/auth/sync', requireMysql, verifyFirebaseToken, async (req, res) => {
  try {
    const user = await getOrCreateUser(req.firebaseUser);
    res.json({ success: true, data: user });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/favorites
 * Danh sách term_id/term_category đã lưu của user hiện tại.
 */
app.get('/api/favorites', requireMysql, verifyFirebaseToken, async (req, res) => {
  try {
    const user = await getOrCreateUser(req.firebaseUser);
    const [rows] = await mysqlPool.query(
      'SELECT term_id, term_category, created_at FROM user_favorites WHERE user_id = ? ORDER BY created_at DESC',
      [user.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/favorites
 * Body: { term_id, term_category }. Idempotent (UNIQUE KEY uniq_user_term).
 */
app.post('/api/favorites', requireMysql, verifyFirebaseToken, async (req, res) => {
  const { term_id, term_category } = req.body || {};
  if (!term_id || !term_category) {
    return res.status(400).json({ success: false, error: 'Thiếu term_id hoặc term_category' });
  }
  try {
    const user = await getOrCreateUser(req.firebaseUser);
    await mysqlPool.query(
      'INSERT IGNORE INTO user_favorites (user_id, term_id, term_category) VALUES (?, ?, ?)',
      [user.id, term_id, term_category]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/favorites/:termId
 */
app.delete('/api/favorites/:termId', requireMysql, verifyFirebaseToken, async (req, res) => {
  try {
    const user = await getOrCreateUser(req.firebaseUser);
    await mysqlPool.query(
      'DELETE FROM user_favorites WHERE user_id = ? AND term_id = ?',
      [user.id, req.params.termId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/settings
 * Cài đặt hiển thị đã đồng bộ của user (lang/content_langs/han_script) — null nếu user
 * chưa từng lưu (client giữ nguyên localStorage hiện tại làm mặc định).
 */
app.get('/api/settings', requireMysql, verifyFirebaseToken, async (req, res) => {
  try {
    const user = await getOrCreateUser(req.firebaseUser);
    const [rows] = await mysqlPool.query('SELECT * FROM user_settings WHERE user_id = ?', [user.id]);
    res.json({ success: true, data: rows[0] || null });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/settings
 * Body: { lang, content_langs, han_script, tts_autoplay, daily_goal } — content_langs là mảng,
 * lưu dạng chuỗi "a,b,c". tts_autoplay/daily_goal có thể vắng mặt (giữ giá trị cũ trong DB).
 */
app.put('/api/settings', requireMysql, verifyFirebaseToken, async (req, res) => {
  const { lang, content_langs, han_script, tts_autoplay, daily_goal } = req.body || {};
  try {
    const user = await getOrCreateUser(req.firebaseUser);
    const contentLangsStr = Array.isArray(content_langs) ? content_langs.join(',') : content_langs;
    const ttsVal = (tts_autoplay === undefined || tts_autoplay === null) ? null : (tts_autoplay ? 1 : 0);
    const goalVal = (daily_goal === undefined || daily_goal === null) ? null : Number(daily_goal);
    await mysqlPool.query(
      `INSERT INTO user_settings (user_id, lang, content_langs, han_script, tts_autoplay, daily_goal)
       VALUES (?, ?, ?, ?, COALESCE(?, FALSE), COALESCE(?, 10))
       ON DUPLICATE KEY UPDATE lang = VALUES(lang), content_langs = VALUES(content_langs),
         han_script = VALUES(han_script),
         tts_autoplay = COALESCE(?, tts_autoplay),
         daily_goal = COALESCE(?, daily_goal)`,
      [user.id, lang || null, contentLangsStr || null, han_script || null, ttsVal, goalVal, ttsVal, goalVal]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/progress
 * Toàn bộ tiến độ ôn luyện của user hiện tại (spaced repetition). Mảng rỗng nếu chưa học từ nào.
 */
app.get('/api/progress', requireMysql, verifyFirebaseToken, async (req, res) => {
  try {
    const user = await getOrCreateUser(req.firebaseUser);
    const [rows] = await mysqlPool.query(
      `SELECT term_id, status, cycle_idx, wrong_count, next_review_at, updated_at
         FROM user_progress WHERE user_id = ?`,
      [user.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/progress
 * Body: { items: [{ term_id, status, cycle_idx, wrong_count, next_review_at, updated_at }] }
 * Upsert theo lô, HỢP NHẤT last-write-wins theo updated_at TỪNG TỪ (một máy offline lâu ngày
 * đẩy bản cũ lên sẽ không đè bản mới hơn ở máy khác). updated_at/next_review_at nhận ISO string.
 */
app.put('/api/progress', requireMysql, verifyFirebaseToken, async (req, res) => {
  const items = (req.body && Array.isArray(req.body.items)) ? req.body.items : null;
  if (!items) return res.status(400).json({ success: false, error: 'Thiếu items[]' });
  try {
    const user = await getOrCreateUser(req.firebaseUser);
    const toDate = (v) => {
      if (!v) return null;
      const d = new Date(v);
      return isNaN(d.getTime()) ? null : d;
    };
    for (const it of items) {
      if (!it || !it.term_id) continue;
      const upd = toDate(it.updated_at) || new Date();
      await mysqlPool.query(
        `INSERT INTO user_progress (user_id, term_id, status, cycle_idx, wrong_count, next_review_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           status         = IF(VALUES(updated_at) >= updated_at, VALUES(status), status),
           cycle_idx      = IF(VALUES(updated_at) >= updated_at, VALUES(cycle_idx), cycle_idx),
           wrong_count    = IF(VALUES(updated_at) >= updated_at, VALUES(wrong_count), wrong_count),
           next_review_at = IF(VALUES(updated_at) >= updated_at, VALUES(next_review_at), next_review_at),
           updated_at     = IF(VALUES(updated_at) >= updated_at, VALUES(updated_at), updated_at)`,
        [
          user.id, String(it.term_id),
          String(it.status || 'new'),
          Number.isFinite(it.cycle_idx) ? it.cycle_idx : 0,
          Number.isFinite(it.wrong_count) ? it.wrong_count : 0,
          toDate(it.next_review_at),
          upd,
        ]
      );
    }
    res.json({ success: true, count: items.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===== Luyện nghe (module Listening) =====
// Nội dung hội thoại lưu JSON tĩnh (không qua MySQL — số lượng ít, soạn tay,
// không cần full-text search), audio mp3 serve tĩnh qua express.static bên dưới
// (backend/public/audio/listening/...). Điểm chấm "Nghe & nhắc lại" mới cần MySQL.
const LISTENING_DATA_DIR = path.join(__dirname, 'data', 'listening');

function listListeningDialogues(category) {
  if (!fs.existsSync(LISTENING_DATA_DIR)) return [];
  const categories = category
    ? [category]
    : fs.readdirSync(LISTENING_DATA_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  const result = [];
  for (const cat of categories) {
    const dir = path.join(LISTENING_DATA_DIR, cat);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      // File trạng thái nội bộ các pipeline tự động (.processed_*.json) cũng kết thúc
      // bằng .json — bỏ qua mọi file bắt đầu bằng "." để không lẫn vào danh sách bài học.
      if (!file.endsWith('.json') || file.startsWith('.')) continue;
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
      result.push({
        id: data.id, category: data.category, title: data.title, level: data.level || null,
        title_vi: data.title_vi || data.title, title_zh: data.title_zh || data.title, title_en: data.title_en || data.title,
      });
    }
  }
  return result;
}

function findListeningDialogue(id) {
  if (!fs.existsSync(LISTENING_DATA_DIR)) return null;
  const categories = fs.readdirSync(LISTENING_DATA_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  for (const cat of categories) {
    const dir = path.join(LISTENING_DATA_DIR, cat);
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json') || file.startsWith('.')) continue;
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
      if (data.id === id) return data;
    }
  }
  return null;
}

app.get('/api/listening/dialogues', (req, res) => {
  res.json({ success: true, data: listListeningDialogues(req.query.category) });
});

app.get('/api/listening/dialogues/:id', (req, res) => {
  const dialogue = findListeningDialogue(req.params.id);
  if (!dialogue) return res.status(404).json({ success: false, error: 'not_found' });
  res.json({ success: true, data: dialogue });
});

// ===== Chấm điểm phát âm (luyện dịch cabin, chế độ tự do) =====
// Dùng OpenAI (model nghe-hiểu audio) để vừa phiên âm vừa chấm phát âm/trôi chảy —
// quyết định 2026-10-09: dùng chung OPENAI_API_KEY đã có (cần set thêm làm env var
// RUNTIME trên hPanel Hostinger, khác với secret GitHub Actions dùng cho các pipeline
// tự động — 2 nơi lưu riêng biệt, xem ghi chú requireOpenAI()). Audio gửi lên dạng WAV
// base64, đã được trình duyệt tự cắt khoảng lặng >3s trước khi gửi.
function requireOpenAI(req, res, next) {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ success: false, error: 'openai_not_configured' });
  }
  next();
}

// gpt-audio-mini (model nghe-hiểu audio hiện tại, đã verify 2026-10-09 — model cũ
// "gpt-4o-audio-preview" không còn khả dụng) KHÔNG hỗ trợ response_format/json_schema
// (trả lỗi 400 "not supported with this model") — phải ép JSON qua prompt rồi tự parse
// phòng thủ (extractJsonObject bên dưới).
//
// Đổi sang chấm theo TỪNG CÂU (quyết định 2026-10-09, sau khi user báo bug chấm theo cả
// bài dài ra kết quả sai lệch/không chính xác) — audio ngắn giúp model phiên âm chính xác
// hơn hẳn. Thêm "transcript_marked": model tự đánh dấu từ/cụm phát âm chưa chuẩn bằng
// cặp ((...)) ngay trong transcript, để frontend tô màu — KHÔNG dùng danh sách từ riêng
// vì dễ lệch khỏi transcript thật (sai chính tả, dấu câu khác nhau).
const FEEDBACK_LANG_NAME = { vi: 'tiếng Việt', zh: '中文', en: 'English' };

function buildPronunciationPrompt(feedbackLang) {
  const langName = FEEDBACK_LANG_NAME[feedbackLang] || 'tiếng Việt';
  return `Bạn là giám khảo chấm phát âm VÀ ngữ pháp cho người luyện dịch cabin Trung Y, \
đang luyện dịch TỪNG CÂU NGẮN (nghe 1 câu tiếng Trung, nói lại bản dịch bằng tiếng Việt \
hoặc tiếng Anh, hoặc ngược lại). Nhiệm vụ, PHẢI làm đúng thứ tự:
1. Phiên âm CHÍNH XÁC TUYỆT ĐỐI những gì nghe được trong file audio — đây là phần quan \
trọng nhất, phải phản ánh ĐÚNG THẬT những gì người này nói, không được bịa, không được \
đoán theo ngữ cảnh nếu nghe không rõ (ghi "..." ở chỗ không nghe rõ thay vì đoán). NẾU \
NGÔN NGỮ NÓI LÀ TIẾNG TRUNG: PHẢI phiên âm bằng CHỮ HÁN (汉字), TUYỆT ĐỐI KHÔNG được \
chuyển thành pinyin/romanization trong trường "transcript" — đây là lỗi hay gặp, phải \
tránh.
2. Xác định ngôn ngữ chính được nói (vi / zh / en — dùng đúng 1 trong 3 mã này cho \
trường "language").
3. NẾU ngôn ngữ nói là tiếng Trung (zh): tạo thêm "transcript_pinyin" — phiên âm pinyin \
có dấu thanh của transcript (ví dụ "nǐ hǎo"). NẾU không phải tiếng Trung, để \
"transcript_pinyin" là chuỗi rỗng.
4. Tạo "transcript_marked": CHÉP LẠI y nguyên transcript ở bước 1 (chữ Hán nếu là tiếng \
Trung, KHÔNG phải pinyin), nhưng bọc các từ/cụm từ PHÁT ÂM chưa chuẩn (sai âm, nuốt âm, \
ngữ điệu sai — KHÔNG phải lỗi ngữ pháp) trong cặp ((...)), ví dụ: "The ((breath)) was \
short" nếu từ "breath" phát âm chưa chuẩn. Nếu không có lỗi phát âm rõ ràng, \
transcript_marked giống hệt transcript (không bọc gì).
5. Chấm điểm PHÁT ÂM + độ trôi chảy từ 0-100 ("pronunciation_score"), kèm nhận xét ngắn \
gọn (1-2 câu, nêu CỤ THỂ từ/âm nào cần sửa) trong "pronunciation_feedback" — BẰNG ${langName}.
6. Chấm điểm NGỮ PHÁP + cách dùng từ từ 0-100 ("grammar_score") — đánh giá câu nói (dựa \
trên transcript, không liên quan phát âm) có đúng ngữ pháp của ngôn ngữ đó không, kèm \
nhận xét ngắn gọn trong "grammar_feedback" — BẰNG ${langName}. Nếu câu đã đúng ngữ pháp, \
grammar_score = 100 và ghi rõ trong feedback (bằng ${langName}) rằng ngữ pháp đã đúng.
7. Viết lại câu đó cho ĐÚNG NGỮ PHÁP hoàn toàn (giữ nguyên Ý người nói muốn diễn đạt, chỉ \
sửa lỗi ngữ pháp/từ vựng dùng sai, KHÔNG đổi sang cách diễn đạt khác) vào "corrected_text" \
— cùng ngôn ngữ/chữ viết với transcript (chữ Hán nếu transcript là tiếng Trung). Nếu câu \
đã đúng, corrected_text giống hệt transcript.
QUAN TRỌNG: "pronunciation_feedback" và "grammar_feedback" LUÔN viết bằng ${langName}, bất \
kể transcript là ngôn ngữ gì — đây là 2 trường DUY NHẤT bắt buộc theo ngôn ngữ này.
Nếu audio không có tiếng nói rõ ràng (toàn im lặng/tạp âm/không phải giọng người), trả \
về transcript/transcript_marked/transcript_pinyin/corrected_text rỗng, cả 2 score = 0, \
feedback (bằng ${langName}) giải thích không nghe được.
CHỈ trả về một object JSON hợp lệ duy nhất, không kèm markdown/giải thích, đúng dạng:
{"transcript": "...", "transcript_marked": "...", "transcript_pinyin": "...", "language": "vi|zh|en", \
"pronunciation_score": 0-100, "pronunciation_feedback": "...", \
"grammar_score": 0-100, "grammar_feedback": "...", "corrected_text": "..."}`;
}

function extractJsonObject(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Không tìm thấy JSON trong phản hồi');
  // gpt-audio-mini thỉnh thoảng chèn ký tự xuống dòng THÔ (chưa escape) bên trong giá trị
  // chuỗi feedback dài — JSON.parse vỡ vì đây là ký tự control không hợp lệ trong string
  // literal. Thay bằng khoảng trắng trước khi parse (phát hiện thật 2026-10-09).
  const jsonSlice = cleaned.slice(start, end + 1).replace(/[\n\r\t]+/g, ' ');
  return JSON.parse(jsonSlice);
}

app.post('/api/pronunciation-score', express.json({ limit: '25mb' }), requireOpenAI, async (req, res) => {
  try {
    const { audio_base64, format, reference_zh, ui_lang } = req.body || {};
    if (!audio_base64) return res.status(400).json({ success: false, error: 'missing_audio' });
    const feedbackLang = FEEDBACK_LANG_NAME[ui_lang] ? ui_lang : 'vi';

    const userText = reference_zh
      ? `[CHỈ ĐỂ BẠN HIỂU NGỮ CẢNH — KHÔNG được đưa câu này vào trường "transcript"]\nĐoạn gốc tiếng Trung người này đang luyện dịch: ${reference_zh}\n[HẾT NGỮ CẢNH]\nChấm điểm phát âm đoạn ghi âm đính kèm — "transcript" CHỈ chứa đúng những gì nghe được trong audio, không chứa đoạn gốc tiếng Trung ở trên.`
      : 'Chấm điểm phát âm đoạn ghi âm sau.';

    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-audio-mini',
        modalities: ['text'],
        messages: [
          { role: 'system', content: buildPronunciationPrompt(feedbackLang) },
          {
            role: 'user',
            content: [
              { type: 'text', text: userText },
              { type: 'input_audio', input_audio: { data: audio_base64, format: format === 'wav' ? 'wav' : 'mp3' } },
            ],
          },
        ],
      }),
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      console.error('OpenAI pronunciation-score lỗi:', openaiRes.status, errText.slice(0, 500));
      return res.status(502).json({ success: false, error: 'openai_error' });
    }
    const data = await openaiRes.json();
    const parsed = extractJsonObject(data.choices[0].message.content);
    res.json({ success: true, data: parsed });
  } catch (err) {
    console.error('Lỗi chấm phát âm:', err);
    res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ===== Chấm bài dịch theo đơn vị ý (key_units) =====
// AI CHỈ dùng để phiên âm giọng nói (model phiên âm rẻ, ngôn ngữ đích cố định, gợi ý từ vựng từ chính
// bài học). Việc quyết định đúng/sót là đối chiếu xác định trong lib/interpret-check.js. Kết quả chỉ
// gồm mã trạng thái; giao diện tự lấy câu chữ từ bảng I18N nên ngôn ngữ nhận xét luôn đúng.
async function transcribeWithOpenAI(buf, lang, hint) {
  const prompt = lang === 'en'
    ? `Traditional Chinese Medicine case discussion. Terms: ${hint}`
    : `Thảo luận ca bệnh y học cổ truyền bằng tiếng Việt. Thuật ngữ: ${hint}`;
  const models = ['gpt-4o-mini-transcribe', 'whisper-1'];
  let lastErr = null;
  for (const model of models) {
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'audio/wav' }), 'speech.wav');
    form.append('model', model);
    form.append('language', lang);
    form.append('response_format', 'json');
    form.append('temperature', '0');
    form.append('prompt', prompt.slice(0, 900));
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });
    if (r.ok) {
      const j = await r.json();
      let text = String(j.text || '').trim();
      // Phiên âm đôi khi "nhại lại" prompt khi audio gần như im lặng — coi như không nghe được.
      const nt = normalizeInterp(text), np = normalizeInterp(prompt);
      if (nt && (np.includes(nt) || nt.includes(np))) text = '';
      return { text, model };
    }
    lastErr = `${model}: ${r.status} ${(await r.text()).slice(0, 200)}`;
    if (![400, 404].includes(r.status)) break;
  }
  throw new Error(lastErr || 'transcription_failed');
}

app.post('/api/interpret-check', express.json({ limit: '25mb' }), requireOpenAI, async (req, res) => {
  try {
    const { dialogue_id, seq, target_lang, audio_base64, fluency } = req.body || {};
    if (!audio_base64) return res.status(400).json({ success: false, error: 'missing_audio' });
    const lang = target_lang === 'en' ? 'en' : 'vi';
    const dialogue = findListeningDialogue(dialogue_id);
    const seg = dialogue && (dialogue.segments || []).find((x) => x.seq === Number(seq));
    if (!seg || !Array.isArray(seg.key_units) || !seg.key_units.length) {
      return res.status(400).json({ success: false, error: 'no_key_units' });
    }
    const buf = Buffer.from(audio_base64, 'base64');
    if (buf.length < 2000) return res.json({ success: true, data: { transcript: '', lang_ok: false, lang_reason: 'empty', units: [], counts: { ok: 0, partial: 0, missed: 0 }, total: seg.key_units.length, fluency: null } });
    const { text, model } = await transcribeWithOpenAI(buf, lang, buildVocabHint(seg.key_units, lang));
    const stats = fluency && typeof fluency === 'object' ? {
      speech_ms: Number(fluency.speech_ms) || 0,
      pause_count: Number(fluency.pause_count) || 0,
      longest_pause_ms: Number(fluency.longest_pause_ms) || 0,
    } : null;
    const data = analyzeInterpretation({ units: seg.key_units, transcript: text, lang, fluencyStats: stats });
    res.json({ success: true, data: { ...data, stt_model: model } });
  } catch (err) {
    console.error('interpret-check lỗi:', err.message);
    res.status(500).json({ success: false, error: 'interpret_check_failed' });
  }
});

app.get('/api/listening-progress', requireMysql, verifyFirebaseToken, async (req, res) => {
  try {
    const user = await getOrCreateUser(req.firebaseUser);
    const [rows] = await mysqlPool.query(
      `SELECT dialogue_id, line_seq, target_lang, spoken_text, score, attempt_count, updated_at
         FROM user_listening_progress WHERE user_id = ?`,
      [user.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/listening-progress
 * Body: { dialogue_id, line_seq, target_lang, spoken_text, score }
 * Upsert 1 lần chấm — same last-write-wins idiom as /api/progress, nhưng chấm
 * điểm xảy ra ngay lúc gọi (không cần so sánh updated_at phía client).
 */
app.put('/api/listening-progress', requireMysql, verifyFirebaseToken, async (req, res) => {
  const { dialogue_id, line_seq, target_lang, spoken_text, score } = req.body || {};
  if (!dialogue_id || !line_seq || !target_lang) {
    return res.status(400).json({ success: false, error: 'missing_fields' });
  }
  try {
    const user = await getOrCreateUser(req.firebaseUser);
    await mysqlPool.query(
      `INSERT INTO user_listening_progress (user_id, dialogue_id, line_seq, target_lang, spoken_text, score, attempt_count)
       VALUES (?, ?, ?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE
         spoken_text = VALUES(spoken_text),
         score = VALUES(score),
         attempt_count = attempt_count + 1`,
      [user.id, String(dialogue_id), Number(line_seq), String(target_lang), spoken_text || '', Number(score) || 0]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Frontend static assets live in backend/public/ (synced from ../frontend via
// `npm run build` locally — see sync-frontend.js) so a deploy that only ships
// the backend/ directory still serves the PWA.
const PUBLIC_DIR = path.join(__dirname, 'public');

// Middleware
app.use(express.static(PUBLIC_DIR));
// Gói giao diện cho app iOS (live update) — dựng từ chính PUBLIC_DIR, xem lib/app-bundle.js.
// Chẩn đoán live-update: ghi lại mỗi lần app hỏi/tải gói giao diện (để biết app thật có đang cập nhật không).
app.use('/app-bundle', (req, res, next) => {
  console.log('[app-bundle]', req.method, req.originalUrl, String(req.headers['user-agent'] || '').slice(0, 90));
  next();
});
mountAppBundle(app, PUBLIC_DIR);

// ===== API ENDPOINTS =====

/**
 * GET /api/terms
 * Fetch all terms with optional filters
 * Filters: ?group=Giải phẫu&verified=true&search=phế
 */
app.get('/api/terms', async (req, res) => {
  try {
    const termsPath = path.join(__dirname, 'public', 'data', 'terms.json');

    const sheetTerms = fs.existsSync(termsPath)
      ? JSON.parse(fs.readFileSync(termsPath, 'utf8'))
      : [];
    const herbTerms = await getHerbTerms();
    const anatomyTerms = await getAnatomyTerms();
    const wordElementTerms = await getWordElementTerms();
    const acupointTerms = await getAcupointTerms();
    const autoTerms = await getApprovedCandidateTerms(); // GĐ2: cụm tự học đã duyệt

    // Thang Phương là domain GATED: chỉ trả về khi request có Firebase token hợp lệ
    // (user đã đăng nhập). Khách chưa đăng nhập KHÔNG nhận được dữ liệu này trong payload
    // (không chỉ ẩn ở frontend — lọc luôn ở server để nội dung không bị crawl).
    const authUser = await optionalFirebaseUser(req);
    const formulaTerms = authUser ? await getFormulaTerms() : [];

    const baseTerms = [...sheetTerms, ...herbTerms, ...anatomyTerms, ...wordElementTerms, ...acupointTerms, ...autoTerms, ...formulaTerms];
    const generalTerms = dedupeGeneralTerms(await getGeneralTerms(), baseTerms);
    const terms = [...baseTerms, ...generalTerms];

    if (terms.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Terms data not found. Run: npm run build',
      });
    }

    // Filters
    const { group1, group2, verified, search } = req.query;
    
    let filtered = terms;
    
    if (group1) {
      filtered = filtered.filter(t => t.group1 === group1);
    }
    
    if (group2) {
      filtered = filtered.filter(t => t.group2 === group2);
    }
    
    if (verified === 'true') {
      filtered = filtered.filter(t => t.verify === true);
    } else if (verified === 'false') {
      filtered = filtered.filter(t => t.verify === false);
    }
    
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(t => 
        (t.vi && t.vi.toLowerCase().includes(q)) ||
        (t.en && t.en.toLowerCase().includes(q)) ||
        (t.hz && t.hz.toLowerCase().includes(q)) ||
        (t.py && t.py.toLowerCase().includes(q))
      );
    }
    
    res.json({
      success: true,
      count: filtered.length,
      data: filtered,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/groups
 * Fetch unique groups
 */
app.get('/api/groups', async (req, res) => {
  try {
    const termsPath = path.join(__dirname, 'public', 'data', 'terms.json');

    const sheetTerms = fs.existsSync(termsPath)
      ? JSON.parse(fs.readFileSync(termsPath, 'utf8'))
      : [];
    const herbTerms = await getHerbTerms();
    const anatomyTerms = await getAnatomyTerms();
    const wordElementTerms = await getWordElementTerms();
    const acupointTerms = await getAcupointTerms();
    const autoTerms = await getApprovedCandidateTerms(); // GĐ2: cụm tự học đã duyệt
    const baseTerms = [...sheetTerms, ...herbTerms, ...anatomyTerms, ...wordElementTerms, ...acupointTerms, ...autoTerms];
    const terms = [...baseTerms, ...dedupeGeneralTerms(await getGeneralTerms(), baseTerms)];

    if (terms.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Terms data not found',
      });
    }

    // Extract unique groups
    const group1Set = new Set();
    const group2Set = new Set();
    
    terms.forEach(t => {
      if (t.group1) group1Set.add(t.group1);
      if (t.group2) group2Set.add(t.group2);
    });
    
    res.json({
      success: true,
      data: {
        group1: Array.from(group1Set).sort(),
        group2: Array.from(group2Set).sort(),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/tcm-vocabulary
 * Từ vựng TCM chuẩn (tính vị/quy kinh/pháp trị) — nguồn chân lý DUY NHẤT dùng chung giữa
 * script import và search phía frontend (SYNONYM_GROUPS), xem backend/tcm-vocabulary.js.
 */
app.get('/api/tcm-vocabulary', (req, res) => {
  try {
    const vocabPath = path.join(__dirname, 'data', 'tcm-vocabulary.json');
    const vocab = JSON.parse(fs.readFileSync(vocabPath, 'utf8'));
    res.json({ success: true, data: vocab });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/metadata
 * Fetch API metadata (last build, stats)
 */
app.get('/api/metadata', (req, res) => {
  try {
    const metadataPath = path.join(__dirname, 'public', 'data', 'metadata.json');
    
    if (!fs.existsSync(metadataPath)) {
      return res.status(404).json({
        success: false,
        error: 'Metadata not found',
      });
    }
    
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    
    res.json({
      success: true,
      data: metadata,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/import-herbs-now
 * Trigger a re-sync of the herbal dictionary from Google Sheets into MySQL
 * (with webhook secret). Runs in-process — some managed Node hosts (e.g.
 * Hostinger's Web App) sandbox child_process.spawn and crash the whole
 * app when a spawned process errors, so this must not shell out.
 */
app.post('/api/import-herbs-now', async (req, res) => {
  const secret = req.query.secret || req.body.secret;

  if (secret !== WEBHOOK_SECRET) {
    return res.status(403).json({ success: false, error: 'Unauthorized' });
  }

  try {
    const count = await runImport();
    res.json({ success: true, message: `Herb import completed: ${count} herbs` });
  } catch (err) {
    console.error('Herb import failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/build-now
 * Trigger an immediate rebuild of the Giải phẫu terms from Google Sheets
 * (with webhook secret). Runs in-process for the same reason as
 * /api/import-herbs-now above.
 */
app.post('/api/build-now', async (req, res) => {
  const secret = req.query.secret || req.body.secret;

  if (secret !== WEBHOOK_SECRET) {
    return res.status(403).json({
      success: false,
      error: 'Unauthorized',
    });
  }

  try {
    await buildAPI();
    res.json({ success: true, message: 'Build completed successfully' });
  } catch (err) {
    console.error('Build failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /health
 * Health check
 */
/**
 * GET /api/db-check — chẩn đoán kết nối MySQL (không lộ bí mật): mã lỗi + số dòng các bảng chính.
 */
app.get('/api/db-check', async (req, res) => {
  if (!mysqlPool) return res.json({ configured: false });
  const out = { configured: true, tables: {} };
  try {
    await mysqlPool.query('SELECT 1');
    out.connect = 'ok';
  } catch (err) {
    out.connect = { code: err.code, errno: err.errno, message: String(err.message).replace(/'[^']*'@'[^']*'/g, "'***'@'***'").slice(0, 160) };
    return res.json(out);
  }
  for (const t of ['herbs', 'anatomy_terms', 'general_terms', 'acupoints', 'word_elements', 'formulas']) {
    try {
      const [[row]] = await mysqlPool.query(`SELECT COUNT(*) AS n FROM ${t}`);
      out.tables[t] = row.n;
    } catch (err) {
      out.tables[t] = { code: err.code, message: String(err.message).slice(0, 120) };
    }
  }
  res.json(out);
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api
 * API documentation
 */
app.get('/api', (req, res) => {
  res.json({
    name: 'Chimedis API',
    version: '1.0.0',
    description: 'Chinese Medical Terminology Discovery API',
    endpoints: {
      'GET /api/terms': 'Fetch all terms (filters: group1, group2, verified, search)',
      'GET /api/groups': 'Fetch unique groups',
      'GET /api/metadata': 'Fetch API metadata',
      'POST /api/build-now': 'Trigger build (requires webhook_secret)',
      'POST /api/auth/sync': 'Sync Firebase user into MySQL (requires Bearer ID token)',
      'GET /api/favorites': 'List current user favorites (requires Bearer ID token)',
      'POST /api/favorites': 'Add a favorite (requires Bearer ID token)',
      'DELETE /api/favorites/:termId': 'Remove a favorite (requires Bearer ID token)',
      'GET /api/settings': 'Get synced display settings (requires Bearer ID token)',
      'PUT /api/settings': 'Update synced display settings (requires Bearer ID token)',
      'GET /api/progress': 'List spaced-repetition progress (requires Bearer ID token)',
      'PUT /api/progress': 'Bulk-upsert spaced-repetition progress, last-write-wins (requires Bearer ID token)',
      'GET /health': 'Health check',
    },
    documentation: 'https://github.com/tmh2388/chimedis-web',
  });
});

/**
 * SPA fallback — any other GET request serves the PWA shell
 */
app.get(/^(?!\/api).*/, (req, res, next) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => {
    if (err) next(err);
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({
    success: false,
    error: err.message,
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Chimedis API running on port ${PORT}`);
  console.log(`📊 API documentation: http://localhost:${PORT}/`);
  console.log(`🏥 Terms: http://localhost:${PORT}/api/terms`);
  console.log(`📍 Groups: http://localhost:${PORT}/api/groups`);
  console.log(`✅ Health: http://localhost:${PORT}/health`);
});
