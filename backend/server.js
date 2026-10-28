import express from 'express';
import dns from 'dns';
import cors from 'cors';
import { mountAppBundle } from './lib/app-bundle.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { mysqlPool, onDbUp, dbStatus } from './lib/db.js';
import { runImport } from './import-herbal-sheets.js';
import { buildAPI } from './build-api.js';
import { verifyFirebaseToken, isFirebaseConfigured, deleteFirebaseUser, verifyIdTokenValue } from './firebase-admin.js';
import { deleteAccountData } from './lib/account-delete.js';
import { analyzeInterpretation, buildVocabHint, normalize as normalizeInterp } from './lib/interpret-check.js';
import { syncGeneralTerms } from './lib/general-terms-sync.js';
import { resolvePlan, requirePlan, ensurePlanColumns, LIMITS, atLeast, planInfo, isAdmin } from './lib/plan.js';
import * as billing from './lib/billing.js';
import * as laoshi from './lib/laoshi.js';
import * as laoshiLearn from './lib/laoshi-learn.js';
import * as speech from './lib/speech.js';
import { quickEval, dominantLang, isMixed as isMixedText } from './lib/quick-eval.js';
import { pinyin } from 'pinyin';
import * as laoshiFaq from './lib/laoshi-faq.js';
import * as termLearn from './lib/term-learn.js';
import * as aiLookup from './lib/ai-lookup.js';
import * as termAiFill from './lib/term-ai-fill.js';
import * as langAudit from './lib/lang-audit.js';
import * as listeningDb from './lib/listening-db.js';
import * as webDefine from './lib/web-define.js';
import * as aiBudget from './lib/ai-budget.js';
import { scoreChinese, scoreWords, ensureUsageTable, consumeServerAsr } from './lib/quick-score.js';
import crypto from 'node:crypto';
import { signTicket, verifyTicket, TICKET_TTL_SEC } from './lib/media-ticket.js';
import * as userDocs from './lib/user-docs.js';
import * as csdl from './lib/csdl-lessons.js';
import * as csdlAudio from './lib/csdl-audio.js';
import { extractText, MAX_UPLOAD_BYTES } from './lib/doc-extract.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Remote MySQL của Hostinger cho phép theo IP cố định (IPv4). Hostname máy chủ MySQL có cả bản ghi AAAA nên
// Node mặc định có thể kết nối qua IPv6 và bị từ chối "Access denied" dù đã khai báo đúng IPv4 → ưu tiên IPv4.
dns.setDefaultResultOrder('ipv4first');

const app = express();
process.on('unhandledRejection', (err) => { console.error('[unhandledRejection]', err && err.message ? err.message : err); });
process.on('uncaughtException', (err) => { console.error('[uncaughtException]', err && err.message ? err.message : err); });

// CORS + JSON phải đứng TRƯỚC mọi route /api/*: app iOS chạy ở capacitor://localhost nên gọi API chéo origin;
// route đặt trước cors() sẽ không có header CORS (app bị chặn) và route POST/PUT trước express.json() nhận req.body rỗng.
// /api/pronunciation-score có parser riêng giới hạn 25mb (audio base64) nên loại khỏi parser mặc định 100kb.
const defaultJson = express.json();
app.use(cors());

// ===== Cổng chuyển tiếp API đăng nhập Firebase (2026-10-11) =====
// Người dùng ở Trung Quốc đại lục không truy cập được *.googleapis.com / gstatic.com nên không đăng nhập được. SDK Firebase bản
// tự phục vụ (frontend/vendor/firebase, đã vá bởi scripts/vendor-firebase.mjs) gọi API qua CHÍNH tên miền này:
// /__fb/idtk → identitytoolkit.googleapis.com, /__fb/stk → securetoken.googleapis.com; máy chủ (ở Mỹ) chuyển tiếp.
// Chỉ cho phép đúng các đường dẫn đăng nhập, có giới hạn tần suất. PHẢI đứng TRƯỚC express.json() (body cần ở dạng thô,
// endpoint token gửi form-urlencoded). Cùng quy ước với chimedis-home (docs/DICT-china-login.md).
const FB_TARGETS = {
  idtk: { host: 'https://identitytoolkit.googleapis.com', allow: /^\/(v1\/accounts[:/]|v1\/projects$|v1\/projects\/[^/]+\/(config|accounts)|v2\/(projects\/[^/]+\/)?(accounts|recaptchaConfig|passwordPolicy)|v1\/recaptchaParams|v2\/passwordPolicy)/ },
  stk: { host: 'https://securetoken.googleapis.com', allow: /^\/v1\/token$/ },
};
const fbRate = new Map();
app.all(/^\/__fb\/(idtk|stk)(\/.*)$/, express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
  const [, which, rest] = req.path.match(/^\/__fb\/(idtk|stk)(\/.*)$/);
  const tgt = FB_TARGETS[which];
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const hits = (fbRate.get(ip) || []).filter((t) => now - t < 60_000);
  if (hits.length >= 120) return res.status(429).json({ error: { message: 'TOO_MANY_ATTEMPTS_TRY_LATER' } });
  hits.push(now); fbRate.set(ip, hits);
  if (fbRate.size > 5000) for (const [k, v] of fbRate) if (!v.length || now - v[v.length - 1] > 60_000) fbRate.delete(k);
  if (!tgt.allow.test(rest) || !['GET', 'POST'].includes(req.method)) return res.status(404).json({ error: { message: 'NOT_FOUND' } });
  try {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    // Khoá API có thể giới hạn referrer — dùng cùng referrer đã được cho phép với chimedis-home.
    const headers = { Referer: 'https://chimedis.vn/', Origin: 'https://chimedis.vn' };
    for (const h of ['content-type', 'x-client-version', 'x-firebase-locale', 'x-firebase-gmpid', 'x-firebase-client']) if (req.headers[h]) headers[h] = req.headers[h];
    const r = await fetch(tgt.host + rest + qs, {
      method: req.method, headers,
      body: req.method === 'POST' && Buffer.isBuffer(req.body) && req.body.length ? req.body : undefined,
    });
    res.status(r.status);
    res.set('content-type', r.headers.get('content-type') || 'application/json');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error('fb proxy:', e.message);
    res.status(502).json({ error: { message: 'PROXY_ERROR' } });
  }
});
// Mọi đường dẫn /__fb/ còn lại (ngoài idtk/stk) → 404 JSON, không rơi về trang chủ (SPA fallback).
app.all(/^\/__fb(\/|$)/, (req, res) => res.status(404).json({ error: { message: 'NOT_FOUND' } }));
app.use((req, res, next) => (['/api/pronunciation-score', '/api/interpret-check', '/api/quick-check', '/api/laoshi/transcribe', '/api/admin/listening/lesson'].includes(req.path) ? next() : defaultJson(req, res, next)));
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'chimedis-secret-key';

// MySQL is optional — herb data (from Google Sheets via import-herbal-sheets.js)
// only appears in /api/terms once MYSQL_HOST etc. are configured. Without it,
// /api/terms still works with just the Giải phẫu data from public/data/terms.json.
// (lib/db.js: thử MYSQL_HOST → MYSQL_HOST_FALLBACK → localhost, nối IPv4, tự thử lại mỗi 30s.)

// Gieo/cập nhật thuật ngữ "Tổng hợp" từ backend/data/general-terms/*.json vào MySQL mỗi khi DB sẵn sàng
// (lúc khởi động và cả khi tự phục hồi sau sự cố).
if (mysqlPool) {
  userDocs.ttsSelfTest().catch(() => {});
  onDbUp(() => ensurePlanColumns(mysqlPool).catch(() => {}));
  onDbUp(() => userDocs.initUserDocs(mysqlPool).catch((e) => console.error('[user-docs] init:', e.message)));
  onDbUp(() => syncGeneralTerms(mysqlPool, path.join(__dirname, 'data', 'general-terms'))
    .then((r) => console.log(`[general-terms] đồng bộ: ${r.total} thuật ngữ trong file, ${r.written} dòng thay đổi`))
    .catch((err) => console.error('⚠️  Không đồng bộ được thuật ngữ Tổng hợp:', err.message)));
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
    return await verifyIdTokenValue(token); // (firebase-admin ≥13: không còn `import('firebase-admin').default.auth()`)
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
     ON DUPLICATE KEY UPDATE email = COALESCE(VALUES(email), email), display_name = COALESCE(VALUES(display_name), display_name),
       photo_url = COALESCE(VALUES(photo_url), photo_url), last_login_at = CURRENT_TIMESTAMP`,
    // COALESCE: phiên đăng nhập bằng custom token (SSO từ chimedis.vn) có thể thiếu claim — không được ghi đè thông tin cũ bằng rỗng.
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

const summarizeDialogue = (data) => ({
  id: data.id, category: data.category, title: data.title, level: data.level || null,
  title_vi: data.title_vi || data.title, title_zh: data.title_zh || data.title, title_en: data.title_en || data.title,
  created_at: data.created_at || null, updated_at: data.updated_at || data.created_at || null,
  source_lang: data.source_lang || undefined,
  seqs: Array.isArray(data.segments) ? data.segments.map((x) => x.seq) : [],
});
// Bài lưu trong MySQL (thêm không cần redeploy) gộp với bài trong file; trùng id → bản MySQL thắng.
function listListeningDialogues(category) {
  const fromDb = listeningDb.dbLessons(category).map((d) => ({ ...summarizeDialogue(d), db: true }));
  const ids = new Set(fromDb.map((x) => x.id));
  return [...fromDb, ...listFileDialogues(category).filter((x) => !ids.has(x.id))];
}
function listFileDialogues(category) {
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
        created_at: data.created_at || null, updated_at: data.updated_at || data.created_at || null,
        source_lang: data.source_lang || undefined,
        // Danh sách câu: để nút phát/dừng ngay trên thẻ ở trang danh sách nghe được cả bài mà không cần mở bài.
        seqs: Array.isArray(data.segments) ? data.segments.map((x) => x.seq) : [],
      });
    }
  }
  return result;
}

function findListeningDialogue(id) {
  const fromDb = listeningDb.dbLesson(id); if (fromDb) return fromDb;
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

// Giọng thực sự CÓ SẴN cho bài (đủ file mọi câu) — app chỉ hiện các giọng này, không để người học chọn giọng "chết".
function availableVoices(d) {
  const lang = d.source_lang === 'en' ? 'text_en' : 'text_zh';
  const base = path.join(PUBLIC_DIR, 'audio', 'listening', String(d.category), String(d.id));
  const has = (sub) => (d.segments || []).every((s) => {
    const file = `${String(s.seq).padStart(2, '0')}-${lang}.mp3`;
    if (listeningDb.hasDbAudio(`${d.category}/${d.id}/${sub ? sub + '/' : ''}${file}`)) return true;
    try { return fs.statSync(path.join(base, sub, file)).size > 0; } catch { return false; }
  });
  return ['default', 'aoede'].filter((v) => has(v === 'default' ? '' : v));
}

app.get('/api/listening/dialogues/:id', (req, res) => {
  const dialogue = findListeningDialogue(req.params.id);
  if (!dialogue) return res.status(404).json({ success: false, error: 'not_found' });
  res.json({ success: true, data: { ...dialogue, voices: availableVoices(dialogue) } });
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
  // v3 (2026-10-13): đánh giá CHÍNH lời nói (phát âm · ngữ pháp · mạch lạc/đủ ý · thuật ngữ), không chấm theo văn mẫu.
  // Bản phiên âm do hệ thống cố định nên mô hình KHÔNG phiên âm lại → ít token, ít credit.
  return `Bạn là giám khảo nói cho người học Trung Y (nói tiếng Trung/Việt/Anh). Bạn đánh giá CHÍNH lời nói của người học, KHÔNG chấm theo văn mẫu hay bản dịch nào.
Bản phiên âm đã được hệ thống CỐ ĐỊNH (ghi ở cuối). Mọi nhận xét viết BẰNG ${langName}; chữ/từ được trích giữ nguyên ngôn ngữ người nói.
Nhiệm vụ:
1. "transcript_marked": chép lại transcript, bọc ((...)) các từ/cụm PHÁT ÂM chưa chuẩn (sai âm, sai thanh điệu, nuốt âm); không có lỗi thì giống hệt transcript.
2. "pronunciation_score" 0-100 (âm, thanh điệu với tiếng Trung, nhấn nhả, trôi chảy) + "pronunciation_feedback": 1-2 câu nêu CỤ THỂ từ/âm cần sửa và cách sửa.
3. "grammar_score" 0-100 + "grammar_feedback" (đúng ngữ pháp thì 100 và nói rõ). Từ ngoại ngữ xen vào (vd 穴位 trong câu Anh) là hợp lệ, không trừ điểm.
4. "coherence_score" 0-100 + "coherence_feedback": câu/đoạn có đủ nghĩa, rõ chủ đề, các ý nối với nhau mạch lạc, không lủng củng/cụt ý hay không.
5. "terminology_feedback": nếu có thuật ngữ y học cổ truyền, nhận xét dùng đúng/chuẩn chưa (1 câu); không có thuật ngữ thì "".
6. "strengths": 1 câu khen điều làm tốt nhất (cụ thể).
7. "corrected_text": bản sửa lỗi ngữ pháp/từ vựng nhưng giữ nguyên ý, cùng ngôn ngữ/chữ viết với transcript; đã đúng thì giống transcript.
8. "issues": tối đa 8 điểm CÓ THẬT: {"text": từ/chữ liên quan, "kind": "tone|pronunciation|extra|wrong|grammar|term", "note": gợi ý sửa ngắn}. Nói đúng hết thì [].
Nếu có "câu mẫu cùng ngôn ngữ" ở phần ngữ cảnh, chỉ dùng để biết người học định nói gì (độ phủ ý) — KHÔNG trừ điểm vì nói khác câu mẫu nếu vẫn đúng và đủ nghĩa.
Audio không có tiếng người rõ ràng: mọi điểm = 0 và giải thích.
CHỈ trả một object JSON hợp lệ, không markdown:
{"transcript": "", "transcript_marked": "...", "transcript_pinyin": "", "language": "", "pronunciation_score": 0, "pronunciation_feedback": "...", "grammar_score": 0, "grammar_feedback": "...", "coherence_score": 0, "coherence_feedback": "...", "terminology_feedback": "", "strengths": "...", "corrected_text": "...", "issues": [{"text": "...", "kind": "tone", "note": "..."}]}`;
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

app.post('/api/pronunciation-score', verifyFirebaseToken, requirePlan(mysqlPool, 'pro'), express.json({ limit: '25mb' }), requireOpenAI, async (req, res) => {
  try {
    const { audio_base64, format, reference_zh, reference, reference_lang, ui_lang, transcript: tIn, language: langIn } = req.body || {};
    if (!audio_base64) return res.status(400).json({ success: false, error: 'missing_audio' });
    const feedbackLang = FEEDBACK_LANG_NAME[ui_lang] ? ui_lang : 'vi';
    const refText = String(reference || reference_zh || '').slice(0, 1500);
    const refLangName = ({ zh: 'tiếng Trung', vi: 'tiếng Việt', en: 'tiếng Anh' })[reference_lang] || (reference ? '' : 'tiếng Trung');
    const buf = Buffer.from(audio_base64, 'base64');

    // 1) BẢN PHIÊN ÂM CHUẨN DUY NHẤT: do chấm nhanh đã nhận dạng (gửi lên), hoặc lấy từ kho theo mã băm âm thanh (nhận dạng một lần).
    let canonical = typeof tIn === 'string' ? tIn.trim().slice(0, 1500) : '';
    let canonLang = ['zh', 'vi', 'en'].includes(langIn) ? langIn : null;
    const hash = speech.audioHash(buf);
    if (!canonical) {
      const r = await speech.canonicalRecognize(mysqlPool, buf, { expect: ['zh', 'vi', 'en'].includes(reference_lang) ? reference_lang : null });
      if (r.unclear || !r.text.trim()) return res.json({ success: true, data: { unclear: true, reason: r.reason || 'unclear', audio_hash: r.hash, cost_credits: 0 } });
      canonical = r.text.trim(); canonLang = r.language || canonLang;
    }
    // Ngôn ngữ chủ đạo theo NỘI DUNG (câu Anh xen thuật ngữ Hán vẫn là Anh); nhãn của nơi gọi chỉ dùng khi không đếm được.
    canonLang = dominantLang(canonical, detectViEn, ['zh', 'vi', 'en'].includes(reference_lang) ? reference_lang : null) || canonLang || (['zh', 'vi', 'en'].includes(reference_lang) ? reference_lang : 'vi');

    // 2) Cùng âm thanh + cùng câu mẫu + cùng ngôn ngữ nhận xét → dùng lại kết quả đã có (miễn phí, và LUÔN cho cùng một kết quả).
    // Văn mẫu chỉ làm căn cứ khi CÙNG ngôn ngữ với lời nói; khác ngôn ngữ thì bỏ (so chéo ngôn ngữ là vô nghĩa).
    const useRef = refText && (!reference_lang || reference_lang === canonLang) ? refText : '';
    const key = crypto.createHash('sha256').update(`v3|${hash}|${canonical}|${canonLang}|${useRef}|${feedbackLang}`).digest('hex');
    const hit = await speech.analysisCacheGet(mysqlPool, key);
    if (hit) return res.json({ success: true, data: { ...hit, cached: true, cost_credits: 0, audio_hash: hash } });

    if (!(await budgetGate(req, res))) return;

    const userText = useRef
      ? `[NGỮ CẢNH — KHÔNG đưa vào "transcript"]\nCâu mẫu cùng ngôn ngữ (chỉ để biết ý định nói): ${useRef}\n[HẾT NGỮ CẢNH]\nĐánh giá lời nói trong đoạn ghi âm.`
      : 'Đánh giá lời nói trong đoạn ghi âm sau.';
    const fixed = `\n\nLƯU Ý QUAN TRỌNG (ghi đè bước 1): bản phiên âm ĐÃ ĐƯỢC HỆ THỐNG NHẬN DẠNG VÀ CỐ ĐỊNH, KHÔNG phiên âm lại:\n<<<${canonical}>>>\nNgôn ngữ nói: ${canonLang}. Trường "transcript" PHẢI đúng y chuỗi trên; "language" = "${canonLang}". Dùng audio CHỈ để đánh giá phát âm, thanh điệu, trôi chảy. "transcript_marked" = chính chuỗi trên, bọc ((...)) quanh chỗ phát âm chưa chuẩn.`;

    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-audio-mini',
        modalities: ['text'],
        max_completion_tokens: 1200,
        messages: [
          { role: 'system', content: buildPronunciationPrompt(feedbackLang) + fixed },
          { role: 'user', content: [
            { type: 'text', text: userText },
            { type: 'input_audio', input_audio: { data: audio_base64, format: format === 'wav' ? 'wav' : 'mp3' } },
          ] },
        ],
      }),
    });
    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      console.error('OpenAI pronunciation-score lỗi:', openaiRes.status, errText.slice(0, 500));
      return res.status(502).json({ success: false, error: 'openai_error' });
    }
    const data = await openaiRes.json();
    const costUsd = aiBudget.costFromUsage('gpt-audio-mini', data.usage);
    aiBudget.charge({ uid: req.firebaseUser.uid, app: 'dict', feature: 'phan_tich_phat_am', costUsd });
    const parsed = extractJsonObject(data.choices[0].message.content) || {};
    // Cưỡng bức: bản chữ CHUẨN không bị mô hình đổi; pinyin tính bằng thư viện (chắc hơn mô hình).
    parsed.transcript = canonical;
    parsed.language = canonLang;
    const stripMarks = (x) => String(x || '').replace(/\(\(|\)\)/g, '');
    if (stripMarks(parsed.transcript_marked).replace(/\s+/g, '') !== canonical.replace(/\s+/g, '')) parsed.transcript_marked = canonical;
    if (canonLang === 'zh') { try { parsed.transcript_pinyin = pinyin(canonical, { style: 'tone' }).map((a) => a[0]).join(' '); } catch (_) { /* giữ nguyên */ } }
    else parsed.transcript_pinyin = '';
    for (const k of ['pronunciation_score', 'grammar_score', 'coherence_score']) parsed[k] = Math.max(0, Math.min(100, Math.round(Number(parsed[k]) || 0)));
    parsed.overall = Math.round(0.4 * parsed.pronunciation_score + 0.3 * parsed.grammar_score + 0.3 * parsed.coherence_score);
    parsed.issues = Array.isArray(parsed.issues) ? parsed.issues.filter((x) => x && x.text).slice(0, 8) : [];
    parsed.cost_credits = Math.round(costUsd * aiBudget.CREDITS_PER_USD * 10) / 10; // 1 credit = 0,001 USD; làm tròn 0,1
    parsed.audio_hash = hash;
    speech.analysisCachePut(mysqlPool, key, { ...parsed, cost_credits: 0 });
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
// Nhận biết người nói tiếng Anh hay tiếng Việt từ văn bản (chỉ chữ Latin). Trả 'vi' | 'en' | null (không chắc).
const VI_DIAC = /[ăâđêôơưĂÂĐÊÔƠƯàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/g;
const EN_STOP = new Set('the of and is are to in a an for with that this it on as by be was were have has not you we they from at or which will can their there what when how'.split(' '));
const VI_STOP = new Set('la va cua cho cac mot nhung duoc trong khi co khong nay nhu den voi tu da se bi ve nguoi thi hay neu ma de'.split(' '));
function detectViEn(text) {
  const t = String(text || '');
  const latin = (t.match(/[A-Za-zÀ-ỹ]/g) || []).length;
  if (latin < 6) return null;
  if (((t.match(VI_DIAC) || []).length) >= 2) return 'vi';
  const words = t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').split(/[^a-z]+/).filter(Boolean);
  if (words.length < 3) return null;
  let en = 0, vi = 0;
  for (const w of words) { if (EN_STOP.has(w)) en++; if (VI_STOP.has(w)) vi++; }
  if (en >= 2 && en > vi) return 'en';
  if (vi >= 2 && vi > en) return 'vi';
  return null;
}
async function transcribeWithOpenAI(buf, lang, hint, bias = '') {
  // zh: KHÔNG đưa câu mẫu vào prompt — làm vậy mô hình sẽ "tự sửa" theo câu mẫu và che mất lỗi phát âm của người học.
  const prompt = lang === 'auto'
    ? 'Thảo luận y học cổ truyền / Traditional Chinese Medicine discussion.'
    : lang === 'zh'
    ? (bias ? `中医学习对话，请用简体中文转写。可能出现的中医术语：${bias}` : '中医学习，请用简体中文逐字转写，不要纠正发音。')
    : lang === 'en'
      ? `Traditional Chinese Medicine case discussion. Terms: ${hint}`
      : `Thảo luận ca bệnh y học cổ truyền bằng tiếng Việt. Thuật ngữ: ${hint}`;
  const models = ['gpt-4o-mini-transcribe', 'whisper-1'];
  let lastErr = null;
  for (const model of models) {
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'audio/wav' }), 'speech.wav');
    form.append('model', model);
    if (lang !== 'auto') form.append('language', lang);
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

app.post('/api/interpret-check', verifyFirebaseToken, requirePlan(mysqlPool, 'pro'), express.json({ limit: '25mb' }), requireOpenAI, async (req, res) => {
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
    if (!(await budgetGate(req, res))) return;
    if (buf.length < 2000) return res.json({ success: true, data: { transcript: '', lang_ok: false, lang_reason: 'empty', units: [], counts: { ok: 0, partial: 0, missed: 0 }, total: seg.key_units.length, fluency: null } });
    const cr = await speech.canonicalRecognize(mysqlPool, buf, { vocab: `${buildVocabHint(seg.key_units, 'vi')} ${buildVocabHint(seg.key_units, 'en')}`.slice(0, 700), expect: lang });
    const text = cr.unclear ? '' : cr.text, model = cr.model;
    // Chỉ tính phí khi thật sự nhận dạng mới (dùng lại bản chuẩn đã có thì miễn phí). ~ $0,003/phút, ước lượng thời lượng từ kích thước.
    if (!cr.cached) aiBudget.charge({ uid: req.firebaseUser.uid, app: 'dict', feature: 'dich_phien_am', costUsd: Math.max(5, buf.length / 32000) / 60 * 0.006 });
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
// ===== Audio chỉ cho người đã đăng nhập: vé ngắn hạn ?t= (xem lib/media-ticket.js) =====
app.use('/audio/listening', (req, res, next) => {
  if (process.env.AUDIO_AUTH === 'off') return next();
  if (!verifyTicket(req.query.t)) return res.status(401).json({ success: false, error: 'login_required' });
  res.set('Cache-Control', 'private, max-age=3600');
  next();
});

// Âm thanh bài nghe lưu trong MySQL: chỉ dùng khi KHÔNG có file cùng đường dẫn trong public/ (bài cũ vẫn phục vụ tĩnh như trước). Hỗ trợ Range cho iOS.
app.get(/^\/audio\/listening\/(.+\.mp3)$/, async (req, res, next) => {
  try {
    const rel = decodeURIComponent(req.params[0]);
    if (!listeningDb.hasDbAudio(rel) || fs.existsSync(path.join(PUBLIC_DIR, 'audio', 'listening', rel))) return next();
    const buf = await listeningDb.getAudio(mysqlPool, rel); if (!buf) return next();
    res.set({ 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes' });
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0; const end = m[2] ? Math.min(parseInt(m[2], 10), buf.length - 1) : buf.length - 1;
      if (start > end || start >= buf.length) return res.status(416).set('Content-Range', `bytes */${buf.length}`).end();
      res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${buf.length}`, 'Content-Length': end - start + 1 }).end(buf.subarray(start, end + 1));
    } else res.set('Content-Length', buf.length).end(buf);
  } catch (e) { next(); }
});

app.get('/api/me', verifyFirebaseToken, async (req, res) => {
  const info = await planInfo(mysqlPool, req.firebaseUser);
  const plan = info.plan;
  res.json({ success: true, data: { plan_expires_at: info.expires_at, plan_source: info.source, is_admin: isAdmin(req.firebaseUser), uid: req.firebaseUser.uid, email: req.firebaseUser.email, email_verified: !!req.firebaseUser.emailVerified, plan, limits: LIMITS[plan] || LIMITS.free } });
});

app.post('/api/media-ticket', verifyFirebaseToken, async (req, res) => {
  const plan = await resolvePlan(mysqlPool, req.firebaseUser);
  res.json({ success: true, data: { ticket: signTicket(req.firebaseUser.uid, TICKET_TTL_SEC, plan), expires_in: TICKET_TTL_SEC } });
});

// ===== Tự Thêm: tài liệu riêng của người dùng Pro (AI tự biên tập + tạo audio) =====
const requireDocsDb = (req, res, next) => (mysqlPool ? next() : res.status(503).json({ success: false, error: 'db_unavailable' }));
const proOnly = [verifyFirebaseToken, requirePlan(mysqlPool, 'pro')];

app.get('/api/my-docs', ...proOnly, requireDocsDb, async (req, res) => {
  try { res.json({ success: true, data: await userDocs.listDocs(mysqlPool, req.firebaseUser.uid) }); }
  catch (e) { res.status(500).json({ success: false, error: 'list_failed' }); }
});

// Đọc chữ từ tệp Word/PDF/TXT người dùng chọn (chưa tạo bài — client hiển thị để kiểm tra rồi mới gửi POST /api/my-docs).
app.post('/api/my-docs/extract', ...proOnly, express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), async (req, res) => {
  try {
    const name = String(req.query.name || '').slice(0, 200);
    const out = await extractText(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), name);
    res.json({ success: true, data: { text: out.text, total_chars: out.total_chars, kind: out.kind } });
  } catch (e) {
    const known = ['unsupported_type', 'scanned_pdf', 'empty_file', 'extract_failed'];
    res.status(known.includes(e.code) ? 422 : 500).json({ success: false, error: known.includes(e.code) ? e.code : 'extract_failed' });
  }
});

app.post('/api/my-docs', ...proOnly, requireDocsDb, requireOpenAI, async (req, res) => {
  try {
    const { title, text, voice } = req.body || {};
    const t = String(text || '');
    if (t.trim().length < 20) return res.status(400).json({ success: false, error: 'too_short' });
    if (!(await budgetGate(req, res))) return;
    const q = await userDocs.quotaCheck(mysqlPool, req.firebaseUser.uid, req.plan, t.length);
    if (!q.ok) return res.status(q.code === 'pro_required' ? 403 : 429).json({ success: false, error: q.code, max: q.max });
    const id = await userDocs.createDoc(mysqlPool, req.firebaseUser.uid, { title, text: t, voice });
    res.status(202).json({ success: true, data: { id } });
  } catch (e) { console.error('my-docs create:', e.message); res.status(500).json({ success: false, error: 'create_failed' }); }
});

app.get('/api/my-docs/:id', ...proOnly, requireDocsDb, async (req, res) => {
  try {
    const row = await userDocs.getDocRow(mysqlPool, req.firebaseUser.uid, req.params.id);
    if (!row) return res.status(404).json({ success: false, error: 'not_found' });
    if (row.status !== 'ready') return res.json({ success: true, data: { id: `my-${row.id}`, status: row.status, progress: row.progress, error: row.error } });
    res.json({ success: true, data: { ...userDocs.toDialogue(row), status: 'ready' } });
  } catch (e) { res.status(500).json({ success: false, error: 'get_failed' }); }
});

app.delete('/api/my-docs/:id', ...proOnly, requireDocsDb, async (req, res) => {
  try {
    const ok = await userDocs.deleteDoc(mysqlPool, req.firebaseUser.uid, req.params.id);
    res.status(ok ? 200 : 404).json({ success: ok });
  } catch (e) { res.status(500).json({ success: false, error: 'delete_failed' }); }
});

// Audio tài liệu riêng: vé ?t= (chủ vé phải là chủ tài liệu), giọng ?voice=default|aoede (tạo lần đầu, lưu DB).
app.get('/api/my-docs/:id/audio/:seq', requireDocsDb, async (req, res) => {
  try {
    const tk = verifyTicket(req.query.t);
    if (!tk) return res.status(401).json({ success: false, error: 'login_required' });
    const row = await userDocs.getDocRow(mysqlPool, tk.uid, req.params.id);
    if (!row || row.status !== 'ready') return res.status(404).json({ success: false, error: 'not_found' });
    const mp3 = await userDocs.getOrMakeAudio(mysqlPool, row, Number(req.params.seq), String(req.query.voice || row.voice), async () => {
      const b = await aiBudget.getBudget({ uid: tk.uid, plan: tk.plan });
      if (b.state !== 'ok') throw Object.assign(new Error('budget'), { code: 'budget', budget: aiBudget.publicView(b) });
    });
    if (!mp3) return res.status(404).json({ success: false, error: 'not_found' });
    res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=3600' });
    res.send(mp3);
  } catch (e) {
    if (e.code === 'budget') return res.status(429).json({ success: false, error: 'budget', reason: e.budget.state, budget: e.budget });
    console.error('my-docs audio:', e.message); res.status(500).json({ success: false, error: 'audio_failed' });
  }
});

// ===== Học Thuật: bài nghe dựng tự động từ kho CSDL (xem lib/csdl-lessons.js) =====
// Công khai: danh sách lĩnh vực + bài trong ngày (mỗi lĩnh vực 1 bài). Pro: duyệt/tìm mọi mục và nghe bất kỳ mục nào.
// Công thức dựng KHÔNG gọi AI; audio sinh theo yêu cầu bằng Google TTS rồi lưu đệm (lib/csdl-audio.js).
let lessonIndexAt = 0, lessonIndexPromise = null;
async function ensureLessonIndex() {
  if (csdl.hasIndex() && Date.now() - lessonIndexAt < 30 * 60 * 1000) return;
  if (!lessonIndexPromise) {
    lessonIndexPromise = (async () => {
      if (process.env.CSDL_TERMS_FILE) { // chỉ để kiểm thử cục bộ với bản sao dữ liệu /api/terms
        const raw = JSON.parse(fs.readFileSync(process.env.CSDL_TERMS_FILE, 'utf8'));
        csdl.buildIndex(Array.isArray(raw) ? raw : raw.data);
        lessonIndexAt = Date.now();
        return;
      }
      const termsPath = path.join(__dirname, 'public', 'data', 'terms.json');
      const sheetTerms = fs.existsSync(termsPath) ? JSON.parse(fs.readFileSync(termsPath, 'utf8')) : [];
      // Thang phương nay công khai cùng /api/terms → nạp để Bác sĩ/Lão Sư tra cứu và gợi ý được bài thuốc (ghi chú #36).
      const baseTerms = [
        ...sheetTerms, ...(await getHerbTerms()), ...(await getAnatomyTerms()), ...(await getAcupointTerms()), ...(await getApprovedCandidateTerms()), ...(await getFormulaTerms()),
      ];
      const terms = [...baseTerms, ...dedupeGeneralTerms(await getGeneralTerms(), baseTerms)];
      csdl.buildIndex(terms);
      lessonIndexAt = Date.now();
    })().finally(() => { lessonIndexPromise = null; });
  }
  await lessonIndexPromise;
}
const withLessonIndex = (handler) => async (req, res) => {
  try { await ensureLessonIndex(); return await handler(req, res); }
  catch (e) { console.error('csdl:', e.message); res.status(500).json({ success: false, error: 'csdl_failed' }); }
};
onDbUp(() => csdlAudio.ensureTable(mysqlPool).catch((e) => console.error('[csdl-audio] init:', e.message)));

app.get('/api/csdl/fields', withLessonIndex((req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ success: true, data: { fields: csdl.stats(), day: csdl.dayIso() } });
}));

app.get('/api/csdl/daily', withLessonIndex((req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ success: true, data: csdl.dailyPicks().map((t) => csdl.meta(t)) });
}));

app.get('/api/csdl/list', ...proOnly, withLessonIndex((req, res) => {
  const { field, group2, q, offset, limit } = req.query;
  res.json({ success: true, data: csdl.browse({ field, group2, q, offset: Number(offset) || 0, limit: Number(limit) || 30 }) });
}));

app.get('/api/csdl/lesson/:id', withLessonIndex(async (req, res) => {
  const id = String(req.params.id);
  if (!csdl.dailyIds().has(id)) {
    const decoded = await optionalFirebaseUser(req);
    const user = decoded ? { uid: decoded.uid, email: decoded.email || null, emailVerified: decoded.email_verified === true } : null;
    const plan = await resolvePlan(mysqlPool, user);
    if (!user) return res.status(401).json({ success: false, error: 'login_required' });
    if (!atLeast(plan, 'pro')) return res.status(403).json({ success: false, error: 'pro_required', plan, required: 'pro' });
  }
  const lesson = csdl.lessonById(id);
  if (!lesson) return res.status(404).json({ success: false, error: 'not_found' });
  res.json({ success: true, data: lesson });
}));

// Nghe bài theo ngôn ngữ khác (vi/en) — tổng hợp giọng đọc cho câu đó, đệm dùng chung trong MySQL (cùng bảng tts của Lão Sư).
app.get('/api/listen-tts', withLessonIndex(async (req, res) => {
  try {
    const tk = verifyTicket(req.query.t);
    if (!tk) return res.status(401).json({ success: false, error: 'login_required' });
    if (!atLeast(tk.plan, 'pro')) return res.status(403).json({ success: false, error: 'pro_required' });
    const lang = ['vi', 'en', 'zh'].includes(req.query.lang) ? req.query.lang : null;
    if (!lang) return res.status(400).json({ success: false, error: 'bad_lang' });
    const id = String(req.query.id || ''), seq = Number(req.query.seq);
    let text = '';
    if (id.startsWith('db-')) {
      const lesson = csdl.lessonById(id);
      const sg = lesson && lesson.segments.find((x) => Number(x.seq) === seq);
      text = sg ? String(sg['text_' + lang] || '') : '';
    } else {
      const d = findListeningDialogue(id);
      const sg = d && (d.segments || []).find((x) => Number(x.seq) === seq);
      text = sg ? String(sg['text_' + lang] || '') : '';
    }
    text = lsSpeechText(text);
    if (!text) return res.status(404).json({ success: false, error: 'not_found' });
    const voice = userDocs.VOICE_KEYS.includes(req.query.voice) ? req.query.voice : 'default';
    const key = laoshiLearn.ttsKey(lang, voice, text);
    const cached = await laoshiLearn.ttsGetMany(mysqlPool, [key]);
    let audio = cached.get(key);
    if (!audio) {
      audio = await userDocs.synthesize(text, lang, voice, { uid: tk.uid });
      laoshiLearn.ttsPut(mysqlPool, key, { lang, voice, chars: text.length, audio });
    }
    res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=86400' }).send(audio);
  } catch (e) {
    console.error('listen-tts:', e.message);
    res.status(502).json({ success: false, error: 'tts_failed' });
  }
}));

app.get('/api/csdl/audio/:id/:seq', withLessonIndex(async (req, res) => {
  const tk = verifyTicket(req.query.t);
  if (!tk) return res.status(401).json({ success: false, error: 'login_required' });
  const id = String(req.params.id);
  if (!csdl.dailyIds().has(id) && !atLeast(tk.plan, 'pro')) return res.status(403).json({ success: false, error: 'pro_required' });
  const lesson = csdl.lessonById(id);
  const text = csdl.segmentText(lesson, req.params.seq);
  if (!text) return res.status(404).json({ success: false, error: 'not_found' });
  try {
    // Kho Học Thuật là tài sản của nền tảng: người dùng KHÔNG bị trừ ngân sách khi nghe (cả bài trong ngày lẫn bài Pro duyệt).
    // Toàn kho chỉ ~237 nghìn ký tự (~$11 nếu sinh hết cả hai giọng, một lần), mỗi câu sinh một lần rồi dùng chung → chi phí
    // nhỏ và có trần; chống lạm dụng bằng giới hạn tần suất sinh mới theo người dùng/toàn hệ thống (lib/csdl-audio.js).
    const mp3 = await csdlAudio.getAudio(mysqlPool, {
      lessonId: id, seq: Number(req.params.seq), text, voice: String(req.query.voice || 'default'), uid: tk.uid, chargeUser: false,
    });
    res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=86400' });
    res.send(mp3);
  } catch (e) {
    if (e.code === 'rate_limited') return res.status(429).json({ success: false, error: 'rate_limited' });
    if (e.code === 'budget') return res.status(429).json({ success: false, error: 'budget', reason: e.budget.state, budget: e.budget });
    console.error('csdl audio:', e.message);
    res.status(500).json({ success: false, error: 'audio_failed' });
  }
}));

// ===== Ngân sách AI/TTS dùng chung dict + workbench (xem lib/ai-budget.js) =====
// Trả null (và đã trả lời 429) nếu hết hạn mức giờ/ngày/tháng; ngược lại trả trạng thái để dùng tiếp.
async function budgetGate(req, res, plan) {
  try {
    const p = plan || req.plan || await resolvePlan(mysqlPool, req.firebaseUser);
    const b = await aiBudget.getBudget({ uid: req.firebaseUser.uid, plan: p });
    if (b.state !== 'ok') { res.status(429).json({ success: false, error: 'budget', reason: b.state, budget: aiBudget.publicView(b) }); return null; }
    return b;
  } catch (e) { console.error('budgetGate:', e.message); return {}; } // lỗi ghi sổ không được chặn tính năng
}
app.get('/api/budget', verifyFirebaseToken, async (req, res) => {
  try {
    const plan = await resolvePlan(mysqlPool, req.firebaseUser);
    const b = await aiBudget.getBudget({ uid: req.firebaseUser.uid, plan });
    res.json({ success: true, data: { ...aiBudget.publicView(b), packs: billing.PACKS } });
  } catch (e) { res.status(500).json({ success: false, error: 'budget_failed' }); }
});

// ===== CHẤM NHANH (tầng 1) — mọi tài khoản đăng nhập, không dùng AI để chấm (lib/quick-score.js) =====
// Văn bản nói ra lấy từ nhận dạng giọng nói của trình duyệt (miễn phí, client gửi `transcript`), hoặc — khi thiết bị không có
// (app iOS/WKWebView) — từ dịch vụ phiên âm rẻ phía máy chủ (giới hạn dùng công bằng theo ngày). Việc chấm là thuật toán.
onDbUp(() => ensureUsageTable(mysqlPool).catch((e) => console.error('[quick-check] init:', e.message)));
app.post('/api/quick-check', verifyFirebaseToken, express.json({ limit: '25mb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const { dialogue_id, seq, transcript: tIn, audio_base64 } = b;
    // alt_references: { zh, vi, en } — các bản căn cứ ở ba ngôn ngữ. Chúng chỉ là CĂN CỨ để đo "đủ ý" khi người học nói đúng ngôn ngữ đó;
    // chấm nhanh KHÔNG bắt buộc có văn mẫu (vẫn chấm rõ ràng + mạch lạc).
    const refs = {};
    for (const k of ['zh', 'vi', 'en']) {
      const v = b.alt_references && typeof b.alt_references[k] === 'string' ? b.alt_references[k].slice(0, 1500) : '';
      if (v.trim()) refs[k] = v;
    }
    const expect = ['zh', 'vi', 'en'].includes(b.lang) ? b.lang : null;                 // ngôn ngữ giao diện (gợi ý khi không nhận ra)
    if (expect && !refs[expect] && typeof b.reference === 'string' && b.reference.trim()) refs[expect] = b.reference.slice(0, 1500);
    const explicitLang = ['zh', 'vi', 'en'].includes(b.lang_pref) ? b.lang_pref : null; // người học CHỌN ngôn ngữ muốn chấm

    const dlg = dialogue_id ? findListeningDialogue(dialogue_id) : null;
    const seg = dlg && (dlg.segments || []).find((x) => x.seq === Number(seq));

    let transcript = typeof tIn === 'string' ? tIn.slice(0, 1500) : null;
    let source = 'browser', confidence = null, model = null, audioHashOut = null;
    if (transcript === null) {
      if (!audio_base64) return res.status(400).json({ success: false, error: 'missing_audio' });
      if (!process.env.OPENAI_API_KEY) return res.status(503).json({ success: false, error: 'asr_unavailable' });
      const cap = Number(process.env.QUICK_ASR_DAILY) || 150;
      if (mysqlPool) {
        const u = await consumeServerAsr(mysqlPool, req.firebaseUser.uid, cap);
        if (!u.ok) return res.status(429).json({ success: false, error: 'quick_daily_limit', limit: cap });
      }
      const buf = Buffer.from(audio_base64, 'base64');
      if (buf.length < 3000) return res.json({ success: true, data: { unclear: true, reason: 'too_short', source: 'server', heard: '' } });
      const unitsHint = seg && Array.isArray(seg.key_units) ? buildVocabHint(seg.key_units, 'vi') + ' ' + buildVocabHint(seg.key_units, 'en') : '';
      const r = await speech.canonicalRecognize(mysqlPool, buf, { vocab: `${unitsHint} ${laoshi.ASR_BIAS}`.trim().slice(0, 700), expect: explicitLang || expect });
      source = 'server'; model = r.model; confidence = r.confidence; audioHashOut = r.hash;
      if (r.unclear) return res.json({ success: true, data: { unclear: true, reason: r.reason || 'unclear', source, heard: '', model, confidence, audio_hash: r.hash } });
      transcript = r.text;
    }
    if (!String(transcript).trim()) return res.json({ success: true, data: { unclear: true, reason: 'empty', source, heard: '' } });

    // NGÔN NGỮ ĐƯỢC CHẤM = ngôn ngữ chủ đạo của chính lời nói (đếm từ/chữ), không theo giao diện, không theo nhãn của bộ nhận dạng.
    // Câu tiếng Anh có vài từ tiếng Trung vẫn là tiếng Anh (chữ hiển thị đúng như đã nói).
    const spoken = dominantLang(transcript, detectViEn, expect) || expect || 'en';
    const mixed = isMixedText(transcript);
    // Người học chọn một ngôn ngữ nhưng nói ngôn ngữ khác → KHÔNG chấm chéo (vô nghĩa); chấm theo ngôn ngữ đã nói, bỏ chiều "đủ ý" và báo rõ.
    const mismatch = (explicitLang && explicitLang !== spoken) ? { expected: explicitLang, spoken } : null;
    const ref = !mismatch ? refs[spoken] : undefined;
    const base = { source, model, confidence, audio_hash: audioHashOut, transcript_used: transcript, lang_used: spoken, lang_spoken: spoken, mixed, lang_mismatch: mismatch, switched: !!(expect && spoken !== expect), reference_used: ref || '' };

    // Chiều "đủ ý": chỉ khi có căn cứ cùng ngôn ngữ nói
    let core = { mode: 'free' }, contentScore = null;
    if (ref) {
      if (spoken === 'zh') {
        core = { mode: 'zh', ...scoreChinese(ref, transcript) };
        contentScore = core.score;
      } else if (seg && Array.isArray(seg.key_units) && seg.key_units.length) {
        const data = analyzeInterpretation({ units: seg.key_units, transcript, lang: spoken, fluencyStats: null });
        core = { mode: 'units', ...data };
        contentScore = data.total ? Math.round(100 * (data.counts.ok + 0.5 * data.counts.partial) / data.total) : null;
      } else {
        core = { mode: 'words', ...scoreWords(ref, transcript) };
        contentScore = core.score;
      }
    }
    const fl = b.fluency && typeof b.fluency === 'object' ? {
      speech_ms: Number(b.fluency.speech_ms) || 0, pause_count: Number(b.fluency.pause_count) || 0, longest_pause_ms: Number(b.fluency.longest_pause_ms) || 0 } : null;
    const ev = quickEval({ transcript, lang: spoken, confidence, fluency: fl, contentScore });
    // `score`/`level` tổng thể = điểm tổng hợp nhiều chiều (giữ tên cũ để giao diện cũ vẫn chạy)
    return res.json({ success: true, data: { ...core, ...base, eval: ev, score: ev.overall, level: ev.level, heard: core.heard || transcript.trim() } });
  } catch (err) {
    console.error('quick-check lỗi:', err.message);
    res.status(500).json({ success: false, error: 'quick_check_failed' });
  }
});

// ===== Lão Sư Trung Y: thầy giáo AI (gói Max) — xem lib/laoshi.js =====
onDbUp(() => laoshi.ensureTable(mysqlPool).catch((e) => console.error('[laoshi] init:', e.message)));
onDbUp(() => laoshiFaq.ensureTable(mysqlPool).catch((e) => console.error('[laoshi-faq] init:', e.message)));
onDbUp(() => termLearn.ensureTables(mysqlPool).then(() => termLearn.startPromoteJob(mysqlPool)).catch((e) => console.error('[term-learn] init:', e.message)));
onDbUp(() => webDefine.ensureTables(mysqlPool).catch((e) => console.error('[web-define] init:', e.message)));
onDbUp(() => aiLookup.ensureTables(mysqlPool).catch((e) => console.error('[ai-lookup] init:', e.message)));
onDbUp(() => speech.ensureTables(mysqlPool).catch((e) => console.error('[speech] init:', e.message)));
onDbUp(() => laoshiLearn.ensureTables(mysqlPool).then(() => laoshiLearn.loadLearned(mysqlPool, true)).catch((e) => console.error('[laoshi-learn] init:', e.message)));
const maxOnly = [verifyFirebaseToken, requirePlan(mysqlPool, 'max')];
app.get('/api/laoshi/opening', ...maxOnly, withLessonIndex((req, res) => {
  const field = String(req.query.field || '');
  res.json({ success: true, data: laoshi.opening({ lang: String(req.query.lang || 'vi'), field: csdl.FIELDS.some((f) => f.key === field) ? field : '', fresh: req.query.fresh === '1' || req.query.fresh === 'true' }) });
}));
app.post('/api/laoshi/chat', ...maxOnly, requireDocsDb, requireOpenAI, withLessonIndex(async (req, res) => {
  // Kho câu hỏi đã duyệt: câu hỏi tự đầy đủ khớp → trả thẳng, không gọi AI, không trừ ngân sách/lượt.
  try {
    const b = req.body || {};
    const ms = Array.isArray(b.messages) ? b.messages : [];
    const lastMsg = ms[ms.length - 1];
    const fl = ['vi', 'zh', 'en'].includes(b.lang) ? b.lang : 'vi';
    if (lastMsg && lastMsg.role !== 'assistant' && !b.quiz && !b.talk && !laoshi.isSmallTalk(lastMsg.content)) {
      const hit = await laoshiFaq.lookup(mysqlPool, fl, lastMsg.content);
      if (hit) return res.json({ success: true, data: { text: hit.answer, refs: [], from_bank: true } });
    }
  } catch (e) { console.error('faq lookup:', e.message); }
  if (!(await budgetGate(req, res, req.plan))) return;
  const lim = (LIMITS.max && LIMITS.max.laoshiPerDay) || 60;
  const use = await laoshi.consume(mysqlPool, req.firebaseUser.uid, lim);
  if (!use.ok) return res.status(429).json({ success: false, error: 'daily_limit', limit: lim });
  try {
    const { messages, quiz, lang } = req.body || {};
    const talk = !!(req.body && req.body.talk); // chế độ Trò chuyện tự do (nói)
    // Đã học: cặp nghe-nhầm → đúng (đồng âm, được ≥2 người hoặc quản trị viên xác nhận) tự sửa trong lượt người dùng cuối.
    await laoshiLearn.loadLearned(mysqlPool);
    let msgs = Array.isArray(messages) ? messages : [];
    let corrections = [];
    if (msgs.length && msgs[msgs.length - 1] && msgs[msgs.length - 1].role !== 'assistant') {
      const last = msgs[msgs.length - 1];
      const fx = laoshiLearn.applyLearned(String(last.content || ''));
      if (fx.applied.length) { corrections = fx.applied; msgs = [...msgs.slice(0, -1), { ...last, content: fx.text }]; }
    }
    const out = await laoshi.reply({ messages: msgs, quiz: talk ? null : quiz, lang: ['vi', 'zh', 'en'].includes(lang) ? lang : 'vi', corrections, talk });
    // Tự lọc câu hỏi/đáp đáng lưu vào kho (không cần người dùng bấm): quy tắc và ngưỡng nằm trong lib/laoshi-faq.js.
    if (!talk && msgs.length && msgs[msgs.length - 1].role !== 'assistant' && !quiz && !laoshi.isSmallTalk(msgs[msgs.length - 1].content)) {
      laoshiFaq.observe(mysqlPool, { uid: req.firebaseUser.uid, lang: ['vi', 'zh', 'en'].includes(lang) ? lang : 'vi', question: msgs[msgs.length - 1].content, answer: out.text, refs: out.refs }).catch(() => {});
    }
    aiBudget.charge({ uid: req.firebaseUser.uid, app: 'dict', feature: 'laoshi', costUsd: out.costUsd });
    res.json({ success: true, data: { text: out.text, refs: out.refs, used: use.used, limit: lim } });
  } catch (e) {
    if (e.code === 'empty') return res.status(400).json({ success: false, error: 'empty' });
    console.error('laoshi:', e.message);
    res.status(502).json({ success: false, error: 'upstream' });
  }
}));

// Đọc to câu trả lời của thầy (Google TTS; nhiều ngôn ngữ trong cùng câu → tách theo chữ Hán / còn lại, ghép MP3). Tính vào ngân sách người dùng.
const LS_TTS_MAX = 3600; // đủ cho một câu trả lời dài; từng đoạn được cắt nhỏ ở lsSplitRuns để không vượt giới hạn của dịch vụ đọc
const isHanCh = (c) => /[㐀-鿿豈-﫿]/.test(c);
// Chữ cái chỉ có trong tiếng Việt (không có trong pinyin/tiếng Anh): ă â đ ê ô ơ ư và các nguyên âm có dấu hỏi/ngã/nặng/mũ+dấu…
const VI_ONLY = /[ăâđêôơưĂÂĐÊÔƠƯảạãầấẩẫậằắẳẵặẻẹẽềếểễệỉịĩỏọõồốổỗộờớởỡợủụũừứửữựỳỷỵỹẢẠÃẦẤẨẪẬẰẮẲẴẶẺẸẼỀẾỂỄỆỈỊĨỎỌÕỒỐỔỖỘỜỚỞỠỢỦỤŨỪỨỬỮỰỲỶỴỸ]/g;
/** Ngôn ngữ nền của câu (không phụ thuộc ngôn ngữ giao diện): có chữ Việt đặc trưng → vi; còn lại theo giao diện (zh → en cho phần Latin). */
function lsDetectBase(text, uiLang) {
  const vi = (String(text).match(VI_ONLY) || []).length;
  if (vi >= 2) return 'vi';
  return uiLang === 'vi' ? 'vi' : 'en';
}
// Pinyin đi kèm chữ Hán (ví dụ "麻黄 (má huáng)", "麻黄, má huáng") KHÔNG đọc: giọng Mandarin đã đọc chữ Hán rồi, còn giọng Việt/Anh đọc pinyin sẽ sai.
const PINYIN = "[a-zA-ZüÜāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ'’·\\-]+(?:\\s+[a-zA-ZüÜāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ'’·\\-]+){0,7}";
const RE_PY_PAREN = new RegExp('([\\u3400-\\u9fff]+)\\s*[（(]\\s*' + PINYIN + '\\s*[)）]', 'g');
const RE_PY_COMMA = new RegExp('([\\u3400-\\u9fff]+)\\s*[,，、:：]\\s*' + PINYIN + '(?=\\s*[)）\\]。.;；,，]|\\s*$)', 'g');
const RE_PY_IN = new RegExp('([\\u3400-\\u9fff]+)\\s*[,，、]\\s*' + PINYIN + '(?=\\s*[)）])', 'g');
// Pinyin KHÔNG đọc (giọng Việt/Anh đọc pinyin sai; chữ Hán đã được đọc bằng giọng Mandarin). Chỉ xoá chuỗi âm tiết hợp lệ có dấu thanh,
// và cần dấu đặc trưng của pinyin (ā ē ī ō ū ǎ ě ǐ ǒ ǔ ǚ…) hoặc đứng ngay sau chữ Hán/dấu "(" — để không xoá nhầm từ tiếng Việt như "là".
const PY_SYL = /^(?:b|p|m|f|d|t|n|l|g|k|h|j|q|x|zh|ch|sh|r|z|c|s|y|w)?(?:a|o|e|ai|ei|ao|ou|an|en|ang|eng|ong|er|i|ia|ie|iao|iu|ian|in|iang|ing|iong|u|ua|uo|uai|ui|uan|un|uang|ueng|ü|üe|üan|ün)$/;
const PY_TONE = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜüÜ]/i;
const PY_SPECIAL = /[āēīōūǖǎěǐǒǔǚǘǜ]/i;
const toneless = (w) => w.normalize('NFD').replace(/[\u0300-\u036f]/g, (m) => '').normalize('NFC').toLowerCase();
function lsStripPinyin(t) {
  const re = /[\p{L}]+/gu; const toks = []; let m;
  while ((m = re.exec(t))) { const w = m[0]; const plain = /^[a-z]+$/i.test(w); const ok = (PY_TONE.test(w) || plain) && PY_SYL.test(toneless(w).replace(/ǖ|ǘ|ǚ|ǜ/g, 'ü')); toks.push({ w, s: m.index, e: m.index + w.length, ok }); }
  const cuts = [];
  for (let i = 0; i < toks.length;) {
    if (!toks[i].ok) { i++; continue; }
    let j = i; while (j + 1 < toks.length && toks[j + 1].ok && /^\s+$/.test(t.slice(toks[j].e, toks[j + 1].s))) j++;
    const run = toks.slice(i, j + 1); const before = t.slice(0, run[0].s).replace(/\s+$/, '').slice(-1);
    const hasTone = run.some((x) => PY_TONE.test(x.w));
    if (run.some((x) => PY_SPECIAL.test(x.w)) || (run.length >= 2 && /[㐀-鿿(（]/.test(before) && (hasTone || run.length >= 2))) cuts.push([run[0].s, run[run.length - 1].e]);
    i = j + 1;
  }
  for (let k = cuts.length - 1; k >= 0; k--) t = t.slice(0, cuts[k][0]) + t.slice(cuts[k][1]);
  return t.replace(/\(\s*\)|（\s*）/g, '').replace(/\s{2,}/g, ' ');
}
function lsSpeechText(raw) {
  // Tiếng cười ("haha", "hì hì", "哈哈", biểu tượng cười) KHÔNG đọc ra — nghe không hay (ghi chú admin #3).
  let t = String(raw || '')
    .replace(/(?<![\p{L}])(?:ha\s?ha(?:\s?ha)*|hà\s?hà|hì\s?hì|hi\s?hi|hê\s?hê|he\s?he|hô\s?hô|hehe+|hihi+|kk+)(?![\p{L}])/giu, ' ')
    .replace(/[哈嘿呵]{2,}/g, ' ').replace(/[\u{1F600}-\u{1F64F}]/gu, ' ');
  t = t.replace(/\*\*/g, '').replace(/[`#>_~]/g, '').replace(/\p{Extended_Pictographic}|\uFE0F/gu, '');
  t = t.replace(RE_PY_PAREN, '$1').replace(RE_PY_IN, '$1').replace(RE_PY_COMMA, '$1');
  t = lsStripPinyin(t);
  t = t.replace(/\(\s*([㐀-鿿][㐀-鿿\s,，、]*)\)/g, '（$1）').replace(/([.!?。！？:：])\s*\n\s*/g, '$1 ').replace(/\s*\n\s*/g, '. ').replace(/\s{2,}/g, ' ').trim();
  if (t.length > LS_TTS_MAX) { const cut = t.slice(0, LS_TTS_MAX); const k = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('。'), cut.lastIndexOf('? '), cut.lastIndexOf('! ')); t = (k > 200 ? cut.slice(0, k + 1) : cut); }
  return t;
}
function lsSplitRuns(text, baseLang) {
  const runs = [];
  for (const ch of text) {
    const han = isHanCh(ch);
    const neutral = !han && !/[\p{L}\p{N}]/u.test(ch);
    const lang = han ? 'zh' : baseLang;
    const last = runs[runs.length - 1];
    if (last && (neutral || last.lang === lang)) last.text += ch;
    else runs.push({ lang, text: ch });
  }
  // cắt mỗi đoạn dài thành các khúc ≤ 700 ký tự ở chỗ ngắt câu (giới hạn dịch vụ đọc), KHÔNG bỏ bớt đoạn nào → đọc hết toàn bộ
  const out = [];
  for (const r of runs.filter((x) => /[\p{L}\p{N}]/u.test(x.text))) {
    let rest = r.text;
    while (rest.length > 700) {
      const cut = rest.slice(0, 700); const k = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('。'), cut.lastIndexOf('? '), cut.lastIndexOf('! '), cut.lastIndexOf('；'), cut.lastIndexOf('，'), cut.lastIndexOf(', '));
      const at = k > 200 ? k + 1 : 700; out.push({ lang: r.lang, text: rest.slice(0, at) }); rest = rest.slice(at);
    }
    if (/[\p{L}\p{N}]/u.test(rest)) out.push({ lang: r.lang, text: rest });
  }
  return out.slice(0, 80);
}
app.post('/api/laoshi/tts', ...maxOnly, async (req, res) => {
  try {
    if (!(await budgetGate(req, res, req.plan))) return;
    const lang = ['vi', 'zh', 'en'].includes(req.body && req.body.lang) ? req.body.lang : 'vi';
    const voice = userDocs.VOICE_KEYS.includes(req.body && req.body.voice) ? req.body.voice : 'default';
    const text = lsSpeechText(req.body && req.body.text);
    if (!text) return res.status(400).json({ success: false, error: 'empty' });
    const runs = lsSplitRuns(text, lsDetectBase(text, lang));
    // Đệm DÙNG CHUNG theo từng đoạn (MySQL): đoạn đã có thì không tạo lại, không tốn chi phí; chỉ đoạn mới mới tính vào ngân sách người dùng.
    const keys = runs.map((r) => laoshiLearn.ttsKey(r.lang, voice, r.text));
    const cached = await laoshiLearn.ttsGetMany(mysqlPool, [...new Set(keys)]);
    const parts = await Promise.all(runs.map(async (r, i) => {
      const hit = cached.get(keys[i]);
      if (hit) return hit;
      const audio = await userDocs.synthesize(r.text, r.lang, voice, { uid: req.firebaseUser.uid });
      laoshiLearn.ttsPut(mysqlPool, keys[i], { lang: r.lang, voice, chars: r.text.length, audio });
      return audio;
    }));
    res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, no-store' }).send(Buffer.concat(parts));
  } catch (e) {
    console.error('laoshi tts:', e.message);
    res.status(502).json({ success: false, error: 'tts_failed' });
  }
});
// Người dùng sửa chữ nhận dạng sai đồng âm → ghi phiếu (MySQL). Chỉ nhận cặp thật sự đồng âm; ≥2 người hoặc quản trị viên → tự áp dụng.
app.post('/api/laoshi/asr-fix', ...maxOnly, requireDocsDb, withLessonIndex(async (req, res) => {
  try {
    const raw = req.body && Array.isArray(req.body.pairs) ? req.body.pairs : (req.body && req.body.heard ? [req.body] : []);
    // Chọn cặp đầu tiên thật sự ĐỒNG ÂM và có vế đúng là thuật ngữ đã biết (kho CSDL / danh sách cốt lõi) → ngăn "dạy" từ tuỳ ý.
    const pair = raw.slice(0, 4).map((p) => ({ heard: String((p && p.heard) || '').trim(), meant: String((p && p.meant) || '').trim() }))
      .find((p) => laoshiLearn.validPair(p.heard, p.meant) && csdl.isKnownTerm(p.meant, laoshi.CORE_TERMS));
    if (!pair) return res.status(400).json({ success: false, error: 'not_learnable' });
    const ok = await laoshiLearn.recordFix(mysqlPool, { uid: req.firebaseUser.uid, heard: pair.heard, meant: pair.meant, isAdmin: isAdmin(req.firebaseUser) });
    res.json({ success: ok, heard: pair.heard, meant: pair.meant });
  } catch (e) {
    console.error('asr-fix:', e.message);
    res.status(500).json({ success: false, error: 'fix_failed' });
  }
}));
// Nhận dạng giọng nói phía máy chủ (thiết bị không có Web Speech, vd. app iOS): WAV → văn bản. Giới hạn dùng chung với Chấm nhanh.
app.post('/api/laoshi/transcribe', ...maxOnly, express.json({ limit: '25mb' }), async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ success: false, error: 'asr_unavailable' });
    if (!(await budgetGate(req, res, req.plan))) return;
    const lang = ['vi', 'zh', 'en'].includes(req.body && req.body.lang) ? req.body.lang : 'vi';
    const buf = Buffer.from(String((req.body && req.body.audio_base64) || ''), 'base64');
    if (buf.length < 2000) return res.json({ success: true, data: { text: '' } });
    if (buf.length > 12 * 1024 * 1024) return res.status(413).json({ success: false, error: 'too_large' });
    if (mysqlPool) {
      const cap = Number(process.env.LAOSHI_ASR_DAILY) || 200;
      const u = await consumeServerAsr(mysqlPool, req.firebaseUser.uid, cap);
      if (!u.ok) return res.status(429).json({ success: false, error: 'quick_daily_limit', limit: cap });
    }
    const out = await transcribeWithOpenAI(buf, lang, lang === 'zh' ? '' : laoshi.ASR_BIAS, lang === 'zh' ? laoshi.ASR_BIAS : '');
    aiBudget.charge({ uid: req.firebaseUser.uid, app: 'dict', feature: 'laoshi_asr', costUsd: 0.002 });
    // Im lặng/tiếng ồn: mô hình hay "đọc lại" danh sách thuật ngữ gợi ý (ASR_BIAS) làm bản chép. Chặn: văn bản chủ yếu gồm các thuật ngữ trong danh sách gợi ý → coi như không có lời.
    const heard = String(out.text || '').trim();
    const items = heard.split(/[、,，;；\s。.]+/).filter(Boolean);
    const inBias = items.filter((x) => laoshi.ASR_BIAS.includes(x)).length;
    const echoed = items.length >= 5 && inBias / items.length >= 0.7;
    res.json({ success: true, data: { text: echoed ? '' : heard.slice(0, 800) } });
  } catch (e) {
    console.error('laoshi transcribe:', e.message);
    res.status(502).json({ success: false, error: 'asr_failed' });
  }
});

// ===== Góp ý thuật ngữ (⭐ ở mục Tổng hợp) =====
app.post('/api/term-feedback', verifyFirebaseToken, requireDocsDb, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.term_id || !(String(b.comment || '').trim() || b.suggested_vi || b.suggested_en || b.suggested_def || b.suggested_hz || b.suggested_def_zh || b.suggested_def_en)) return res.status(400).json({ success: false, error: 'empty' });
    const r = await termLearn.addFeedback(mysqlPool, { uid: req.firebaseUser.uid, email: req.firebaseUser.email, term_id: b.term_id, hz: b.hz, vi: b.vi, en: b.en, group1: b.group1, comment: b.comment, suggested_vi: b.suggested_vi, suggested_en: b.suggested_en, suggested_def: b.suggested_def, suggested_hz: b.suggested_hz, suggested_def_zh: b.suggested_def_zh, suggested_def_en: b.suggested_def_en, field_key: b.field_key });
    res.status(r.ok ? 200 : 429).json({ success: r.ok, error: r.error });
  } catch (e) { console.error('term-feedback:', e.message); res.status(500).json({ success: false, error: 'feedback_failed' }); }
});

// ===== Gói & thanh toán chuyển khoản (xem lib/billing.js) — chỉ giao diện web có nút mua =====
onDbUp(() => billing.ensureTables(mysqlPool).catch((e) => console.error('[billing] init:', e.message)));
aiBudget.init(mysqlPool);
onDbUp(() => aiBudget.ensureTables(mysqlPool).catch((e) => console.error('[ai-budget] init:', e.message)));
const adminOnly = [verifyFirebaseToken, (req, res, next) => (isAdmin(req.firebaseUser) ? next() : res.status(403).json({ success: false, error: 'admin_required' }))];
const orderView = (o) => o && {
  code: o.code, plan: o.plan, period: o.plan_period, amount: o.amount, status: o.status, method: o.method, note: o.note,
  kind: o.kind || 'plan', credits: o.credits || null,
  created_at: o.created_at, expires_at: o.expires_at, paid_at: o.paid_at, qr_url: billing.qrUrl(o),
};

app.get('/api/billing/config', (req, res) => {
  const b = billing.bankConfig();
  res.json({ success: true, data: { configured: b.configured, auto_confirm: !!process.env.SEPAY_API_KEY, prices: billing.PRICES, bank_name: b.bankName, account_name: b.accountName, account: b.configured ? b.account : '' } });
});

app.post('/api/orders', verifyFirebaseToken, requireDocsDb, async (req, res) => {
  if (!billing.bankConfig().configured) return res.status(503).json({ success: false, error: 'payments_not_configured' });
  try {
    const { plan, period, kind, pack } = req.body || {};
    const u = { uid: req.firebaseUser.uid, email: req.firebaseUser.email };
    const o = kind === 'topup'
      ? await billing.createTopupOrder(mysqlPool, u, String(pack))
      : await billing.createOrder(mysqlPool, u, String(plan), String(period));
    res.status(201).json({ success: true, data: orderView(o) });
  } catch (e) {
    if (e.code === 'bad_plan' || e.code === 'bad_pack') return res.status(400).json({ success: false, error: e.code });
    console.error('orders create:', e.message);
    res.status(500).json({ success: false, error: 'order_failed' });
  }
});
app.get('/api/orders', verifyFirebaseToken, requireDocsDb, async (req, res) => {
  try { res.json({ success: true, data: (await billing.listMine(mysqlPool, req.firebaseUser.uid)).map(orderView) }); }
  catch (e) { res.status(500).json({ success: false, error: 'list_failed' }); }
});
app.get('/api/orders/:code', verifyFirebaseToken, requireDocsDb, async (req, res) => {
  try {
    const o = await billing.getOrder(mysqlPool, req.params.code);
    if (!o || o.firebase_uid !== req.firebaseUser.uid) return res.status(404).json({ success: false, error: 'not_found' });
    res.json({ success: true, data: orderView(o) });
  } catch (e) { res.status(500).json({ success: false, error: 'get_failed' }); }
});
app.post('/api/orders/:code/cancel', verifyFirebaseToken, requireDocsDb, async (req, res) => {
  try {
    const ok = await billing.cancelOwnOrder(mysqlPool, req.params.code, req.firebaseUser.uid);
    res.status(ok ? 200 : 409).json({ success: ok, error: ok ? undefined : 'not_pending' });
  } catch (e) { res.status(500).json({ success: false, error: 'cancel_failed' }); }
});
app.post('/api/redeem', verifyFirebaseToken, requireDocsDb, async (req, res) => {
  try {
    const r = await billing.redeem(mysqlPool, { uid: req.firebaseUser.uid, email: req.firebaseUser.email }, (req.body || {}).code);
    if (!r) return res.status(400).json({ success: false, error: 'invalid_code' });
    res.json({ success: true, data: { plan: r.plan, months: r.months, expires_at: r.expires } });
  } catch (e) { console.error('redeem:', e.message); res.status(500).json({ success: false, error: 'redeem_failed' }); }
});

// Webhook dịch vụ theo dõi giao dịch ngân hàng (định dạng SePay: Authorization: Apikey <khoá>; body có transferType/transferAmount/content).
app.post('/api/payments/sepay', requireDocsDb, async (req, res) => {
  const key = process.env.SEPAY_API_KEY;
  const given = String(req.headers.authorization || '').replace(/^Apikey\s+/i, '');
  if (!key || !given || given.length !== key.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key))) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }
  try {
    const b = req.body || {};
    if (String(b.transferType).toLowerCase() === 'in') {
      const r = await billing.handleIncomingTransfer(mysqlPool, { content: `${b.content || ''} ${b.code || ''} ${b.description || ''}`, amount: b.transferAmount, ref: b.referenceCode || (b.id != null ? `sepay-${b.id}` : null) });
      console.log('[billing] sepay', r.status, r.code || '');
    }
    res.status(200).json({ success: true });
  } catch (e) {
    console.error('sepay webhook:', e.message);
    res.status(500).json({ success: false });
  }
});

// Email "biến động số dư" của ngân hàng, do Google Apps Script trong hộp thư nhận tiền chuyển lên (xem docs/payments-email-appsscript.md).
app.post('/api/payments/email', requireDocsDb, async (req, res) => {
  const key = process.env.EMAIL_WEBHOOK_SECRET;
  const given = String(req.headers['x-webhook-secret'] || '');
  if (!key || !given || given.length !== key.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key))) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }
  try {
    const b = req.body || {};
    const r = await billing.handleBankEmail(mysqlPool, { messageId: b.messageId, subject: String(b.subject || '').slice(0, 300), body: String(b.body || '').slice(0, 20000) });
    console.log('[billing] email', r.status, r.code || '');
    res.status(200).json({ success: true, status: r.status });
  } catch (e) {
    console.error('email webhook:', e.code || '', e.message);
    res.status(500).json({ success: false, error: String(e.code || 'error'), detail: String(e.message || '').slice(0, 160) });
  }
});

// ---- Tra cứu bằng AI cho thuật ngữ kho chưa có (tự học; chi phí do hệ thống chịu) ----
app.post('/api/ai-lookup', express.json({ limit: '4kb' }), verifyFirebaseToken, requireDocsDb, async (req, res) => {
  try {
    const b = req.body || {};
    const q = String(b.q || '').trim().slice(0, 60);
    if (!q) return res.status(400).json({ success: false, error: 'empty' });
    if (b.cache_only) {
      const hit = await aiLookup.getCached(mysqlPool, q);
      return res.json({ success: true, data: hit || null });
    }
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ success: false, error: 'openai_not_configured' });
    const plan = await resolvePlan(mysqlPool, req.firebaseUser);
    const out = await aiLookup.lookup(mysqlPool, {
      q, uid: req.firebaseUser.uid, plan,
      chargeSystem: (costUsd) => aiBudget.charge({ uid: 'system', app: 'dict', feature: 'ai_lookup', costUsd }),
    });
    if (!out.ok) return res.status(out.error === 'not_a_term' ? 400 : 429).json({ success: false, error: out.error, limit: out.limit });
    res.json({ success: true, data: out.data });
  } catch (e) {
    console.error('ai-lookup:', e.message);
    res.status(502).json({ success: false, error: 'upstream' });
  }
});
// Định nghĩa từ phổ thông từ nguồn mở (Wiktionary) — không AI, không credit; chỉ cho người dùng đã đăng nhập (chống lạm dụng).
app.get('/api/web-define', verifyFirebaseToken, async (req, res) => {
  try {
    const out = await webDefine.define(mysqlPool, String(req.query.q || ''));
    res.json({ success: true, data: out && out.entries && out.entries.length ? out : null });
  } catch (e) { res.status(502).json({ success: false, error: 'upstream' }); }
});
// ===== Xoá tài khoản (Apple 5.1.1(v) / Google Play) — người dùng tự xoá trong app: dữ liệu MySQL + tài khoản Firebase =====
const accountDeleteHits = new Map();
app.post('/api/account/delete', verifyFirebaseToken, requireDocsDb, async (req, res) => {
  try {
    const uid = req.firebaseUser.uid, now = Date.now();
    if (!req.body || req.body.confirm !== 'DELETE') return res.status(400).json({ success: false, error: 'confirm_required' });
    if (isAdmin(req.firebaseUser)) return res.status(403).json({ success: false, error: 'admin_cannot_delete' }); // tránh lỡ tay xoá tài khoản quản trị
    const hits = (accountDeleteHits.get(uid) || []).filter((t) => now - t < 3600e3);
    if (hits.length >= 3) return res.status(429).json({ success: false, error: 'rate_limited' });
    hits.push(now); accountDeleteHits.set(uid, hits);
    const summary = await deleteAccountData(mysqlPool, uid);
    await deleteFirebaseUser(uid);
    console.log('[account-delete] đã xoá tài khoản', uid.slice(0, 6) + '…', JSON.stringify(summary));
    res.json({ success: true });
  } catch (e) {
    console.error('account delete:', e.message);
    res.status(500).json({ success: false, error: 'delete_failed' });
  }
});
// Tìm kiếm online (Wiktionary + Wikipedia): đăng nhập, không AI, không credit; giới hạn tần suất theo người dùng để không bị lạm dụng.
const webSearchHits = new Map();
app.get('/api/web-search', verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.firebaseUser.uid, now = Date.now();
    const hits = (webSearchHits.get(uid) || []).filter((t) => now - t < 600e3);
    if (hits.length >= 40) return res.status(429).json({ success: false, error: 'rate_limited' });
    hits.push(now); webSearchHits.set(uid, hits);
    if (webSearchHits.size > 5000) for (const [k, v] of webSearchHits) if (!v.some((t) => now - t < 600e3)) webSearchHits.delete(k);
    const lang = ['vi', 'zh', 'en'].includes(req.query.lang) ? req.query.lang : 'vi';
    const out = await webDefine.webSearch(mysqlPool, String(req.query.q || ''), lang);
    res.json({ success: true, data: out });
  } catch (e) { res.status(502).json({ success: false, error: 'upstream' }); }
});
// ---- Ghi chú của admin → GitHub Issue (nhãn claude-todo) để Claude Code xử lý từ xa ----
// Cần env: GITHUB_NOTES_TOKEN (fine-grained PAT, quyền Issues: write) và tuỳ chọn GITHUB_NOTES_REPO (mặc định tmh2388/chimedis-web).
app.post('/api/admin/dev-note', ...adminOnly, async (req, res) => {
  try {
    const token = process.env.GITHUB_NOTES_TOKEN;
    if (!token) return res.status(503).json({ success: false, error: 'not_configured' });
    const b = req.body || {};
    const note = String(b.note || '').trim().slice(0, 4000);
    if (note.length < 5) return res.status(400).json({ success: false, error: 'too_short' });
    const ctx = b.context && typeof b.context === 'object' ? b.context : {};
    const lines = Object.entries(ctx).slice(0, 14).map(([k, v]) => `- **${String(k).slice(0, 30)}**: ${String(v).slice(0, 200)}`);
    const body = `${note}\n\n---\n_Ghi bởi ${req.firebaseUser.email || req.firebaseUser.uid} qua Chimedis (admin)._\n${lines.join('\n')}`;
    const repo = process.env.GITHUB_NOTES_REPO || 'tmh2388/chimedis-web';
    const title = String(b.title || note.split('\n')[0]).slice(0, 90);
    const r = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'ChimedisDict', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `[Ghi chú admin] ${title}`, body, labels: ['claude-todo'] }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ success: false, error: 'github_failed', detail: String(j.message || r.status).slice(0, 80) });
    // Tuỳ chọn: đánh thức NGAY "routine" của Claude Code trên cloud (không cần chờ tác vụ định kỳ). Cần CLAUDE_ROUTINE_FIRE_URL + CLAUDE_ROUTINE_TOKEN.
    // Routine chạy bằng gói thuê bao Claude (không dùng khoá API); prompt của routine phải tham chiếu khối <routine-fire-payload>.
    let fired = false;
    if (process.env.CLAUDE_ROUTINE_FIRE_URL && process.env.CLAUDE_ROUTINE_TOKEN) {
      try {
        const fr = await fetch(process.env.CLAUDE_ROUTINE_FIRE_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.CLAUDE_ROUTINE_TOKEN}`, 'anthropic-beta': 'experimental-cc-routine-2026-04-01', 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `Repo: ${repo}\nIssue: #${j.number} ${j.html_url}\nGhi chú của admin:\n${note}` }),
        });
        fired = fr.ok;
      } catch (_) { /* không chặn: Issue đã tạo, tác vụ định kỳ sẽ nhặt */ }
    }
    res.json({ success: true, data: { number: j.number, url: j.html_url, routine_fired: fired } });
  } catch (e) { console.error('dev-note:', e.message); res.status(500).json({ success: false, error: 'note_failed' }); }
});
// ---- Quản trị: góp ý thuật ngữ / thuật ngữ mới tự học / kho câu hỏi Lão Sư ----
const adminJson = (fn) => async (req, res) => { try { res.json({ success: true, data: await fn(req) }); } catch (e) { console.error('admin:', e.message); res.status(500).json({ success: false, error: 'admin_failed' }); } };
app.get('/api/admin/term-feedback', ...adminOnly, requireDocsDb, adminJson((req) => termLearn.listFeedback(mysqlPool, String(req.query.status || 'new'))));
app.post('/api/admin/term-feedback/:id', ...adminOnly, requireDocsDb, adminJson((req) => termLearn.resolveFeedback(mysqlPool, Number(req.params.id), req.body || {})));
// ---- Màn duyệt "từ vựng người dùng báo sai" ngay trong app (chỉ quản trị viên) ----
app.get('/api/admin/term-reports', ...adminOnly, requireDocsDb, adminJson(() => termLearn.listReports(mysqlPool)));
app.get('/api/admin/term-reports/count', ...adminOnly, requireDocsDb, adminJson(async () => ({ count: await termLearn.countReports(mysqlPool) })));
// AI ĐỀ XUẤT bổ sung nội dung thuật ngữ (admin) — không ghi CSDL; chi phí do hệ thống chịu; tối đa 60 lượt/giờ/admin.
const termFillHits = new Map();
app.post('/api/admin/term-ai-fill', ...adminOnly, requireOpenAI, async (req, res) => {
  try {
    const uid = req.firebaseUser.uid, now = Date.now();
    const hits = (termFillHits.get(uid) || []).filter((t) => now - t < 3600e3);
    if (hits.length >= 60) return res.status(429).json({ success: false, error: 'rate_limited' });
    hits.push(now); termFillHits.set(uid, hits);
    const out = await termAiFill.suggestFill(req.body || {});
    if (out.costUsd) aiBudget.charge({ uid: 'system', app: 'dict', feature: 'term_ai_fill', costUsd: out.costUsd });
    delete out.costUsd;
    res.json({ success: true, data: out });
  } catch (e) {
    console.error('term-ai-fill:', e.message);
    res.status(e.code === 'bad_request' ? 400 : 502).json({ success: false, error: e.code === 'bad_request' ? 'bad_request' : 'upstream' });
  }
});
// ===== Rà soát ngôn ngữ tự chủ động: quét ô thiếu/quá ngắn → AI dịch đề xuất → HÀNG CHỜ → admin duyệt (không tự ghi vào kho) =====
async function loadTermsForAudit() { // đúng thứ tự ghép như /api/terms (đã áp dụng ghi đè) nhưng gồm cả Thang phương
  const termsPath = path.join(__dirname, 'public', 'data', 'terms.json');
  const sheetTerms = fs.existsSync(termsPath) ? JSON.parse(fs.readFileSync(termsPath, 'utf8')) : [];
  const baseTerms = [...sheetTerms, ...(await getHerbTerms()), ...(await getAnatomyTerms()), ...(await getWordElementTerms()), ...(await getAcupointTerms()), ...(await getApprovedCandidateTerms()), ...(await getFormulaTerms())];
  const generalTerms = dedupeGeneralTerms(await getGeneralTerms(), baseTerms);
  return termLearn.applyOverrides([...baseTerms, ...generalTerms], await termLearn.getOverrides(mysqlPool));
}
onDbUp(() => langAudit.ensureTable(mysqlPool).catch((e) => console.error('[lang-audit] init:', e.message)));
app.get('/api/admin/lang-audit', ...adminOnly, requireDocsDb, adminJson((req) => langAudit.list(mysqlPool, { status: ['todo', 'pending', 'applied', 'dismissed'].includes(req.query.status) ? req.query.status : 'pending', offset: req.query.offset })));
app.post('/api/admin/lang-audit/scan', ...adminOnly, requireDocsDb, adminJson(async () => langAudit.scan(mysqlPool, await loadTermsForAudit())));
app.post('/api/admin/lang-audit/run', ...adminOnly, requireDocsDb, requireOpenAI, adminJson(async (req) => {
  const r = await langAudit.generate(mysqlPool, { limit: (req.body || {}).limit });
  if (r.costUsd) aiBudget.charge({ uid: 'system', app: 'dict', feature: 'lang_audit', costUsd: r.costUsd });
  return { done: r.done, tried: r.tried };
}));
app.post('/api/admin/lang-audit/apply', ...adminOnly, requireDocsDb, adminJson((req) => langAudit.apply(mysqlPool, { uid: req.firebaseUser.uid, email: req.firebaseUser.email }, (req.body || {}).items)));
app.post('/api/admin/lang-audit/dismiss', ...adminOnly, requireDocsDb, adminJson((req) => langAudit.dismiss(mysqlPool, (req.body || {}).ids)));
// Công việc nền: mỗi 6 giờ — quét (không tốn AI) nếu quá 20 giờ chưa quét; rồi dịch đề xuất tối đa LANG_AUDIT_BATCH mục/lượt khi hàng chờ duyệt còn dưới 200. Tắt bằng LANG_AUDIT_JOB=off.
if (process.env.LANG_AUDIT_JOB !== 'off') {
  let lastScan = 0;
  const tick = async () => {
    if (!mysqlPool || !process.env.OPENAI_API_KEY) return;
    try {
      if (Date.now() - lastScan > 20 * 3600e3) { const r = await langAudit.scan(mysqlPool, await loadTermsForAudit()); lastScan = Date.now(); console.log('[lang-audit] quét', JSON.stringify(r)); }
      const [[c]] = await mysqlPool.query("SELECT COUNT(*) AS n FROM term_lang_queue WHERE status = 'pending'");
      if (Number(c.n) < 200) { const r = await langAudit.generate(mysqlPool, { limit: Number(process.env.LANG_AUDIT_BATCH) || 40 }); if (r.costUsd) aiBudget.charge({ uid: 'system', app: 'dict', feature: 'lang_audit', costUsd: r.costUsd }); if (r.done) console.log('[lang-audit] đề xuất', r.done); }
    } catch (e) { console.error('[lang-audit] job:', e.message); }
  };
  setTimeout(() => { onDbUp(() => { tick(); setInterval(tick, 6 * 3600e3).unref?.(); }); }, 3 * 60e3).unref?.();
}
// Dịch tự động các ngôn ngữ còn thiếu/lệch khi admin sửa thuật ngữ (admin chỉ duyệt trước khi lưu). Không ghi CSDL; chi phí do hệ thống chịu; dùng chung trần 60 lượt/giờ với AI bổ sung.
app.post('/api/admin/term-ai-translate', ...adminOnly, requireOpenAI, async (req, res) => {
  try {
    const uid = req.firebaseUser.uid, now = Date.now();
    const hits = (termFillHits.get(uid) || []).filter((t) => now - t < 3600e3);
    if (hits.length >= 60) return res.status(429).json({ success: false, error: 'rate_limited' });
    hits.push(now); termFillHits.set(uid, hits);
    const b = req.body || {};
    const out = await termAiFill.translateItems(b.items, { hz: b.hz, vi: b.vi, en: b.en });
    if (out.costUsd) aiBudget.charge({ uid: 'system', app: 'dict', feature: 'term_ai_translate', costUsd: out.costUsd });
    res.json({ success: true, data: out.items });
  } catch (e) {
    console.error('term-ai-translate:', e.message);
    res.status(502).json({ success: false, error: 'upstream' });
  }
});
app.post('/api/admin/term-edit', ...adminOnly, requireDocsDb, async (req, res) => {
  try {
    const r = await termLearn.editTerm(mysqlPool, { uid: req.firebaseUser.uid, email: req.firebaseUser.email }, req.body || {});
    res.status(r.ok ? 200 : (r.error === 'edit_failed' ? 500 : 400)).json({ success: r.ok, ...r });
  } catch (e) { // không để lỗi bất ngờ làm sập tiến trình (Express 4 không tự bắt lỗi async)
    console.error('term-edit:', e.message);
    res.status(500).json({ success: false, error: 'edit_failed', detail: String((e && (e.code || e.message)) || '').slice(0, 80) });
  }
});
app.post('/api/admin/term-edit-batch', ...adminOnly, requireDocsDb, async (req, res) => {
  try {
    const out = await termLearn.editTermsBatch(mysqlPool, { uid: req.firebaseUser.uid, email: req.firebaseUser.email }, (req.body || {}).edits);
    res.json({ success: true, data: out });
  } catch (e) { console.error('term-edit-batch:', e.message); res.status(500).json({ success: false, error: 'edit_failed', detail: String((e && (e.code || e.message)) || '').slice(0, 80) }); }
});
// Thêm một thuật ngữ MỚI vào kho theo đề nghị của người dùng (báo "kho chưa có") — admin duyệt rồi mới vào.
app.post('/api/admin/term-add', ...adminOnly, requireDocsDb, async (req, res) => {
  try {
    const b = req.body || {};
    const l = await termLearn.learnTermDirect(mysqlPool, { hz: b.hz, py: b.py, vi: b.vi, en: b.en, def_vi: b.def_vi, def_zh: b.def_zh, def_en: b.def_en, group: b.group }, 'đề nghị người dùng (admin duyệt)');
    if (!l) return res.status(400).json({ success: false, error: 'invalid_term' });
    if (l.costUsd) aiBudget.charge({ uid: req.firebaseUser.uid, app: 'dict', feature: 'term_add', costUsd: l.costUsd });
    if (l.inserted) mysqlPool.query('UPDATE ai_lookup SET term_id = ? WHERE hz = ? AND term_id IS NULL', [l.termId, String(b.hz || '').trim()]).catch(() => {}); // thẻ Bác sĩ trỏ về mục mới
    if (b.report_term_id) await termLearn.dismissReports(mysqlPool, String(b.report_term_id), `đã thêm vào kho (${l.termId})`);
    res.json({ success: true, data: { term_id: l.termId, inserted: l.inserted, filled: l.filled || [], incomplete: l.incomplete || [] } });
  } catch (e) { console.error('term-add:', e.message); res.status(500).json({ success: false, error: 'add_failed', detail: String(e.message || '').slice(0, 80) }); }
});
app.post('/api/admin/term-reports/dismiss', ...adminOnly, requireDocsDb, adminJson((req) => termLearn.dismissReports(mysqlPool, String((req.body || {}).term_id || ''), (req.body || {}).note)));
// ---- Rà soát thuật ngữ máy dịch theo QUY ƯỚC dịch (đề xuất → admin duyệt → ghi bằng /api/admin/term-edit) ----
app.get('/api/admin/term-restyle', ...adminOnly, requireDocsDb, adminJson(() => termLearn.restyleList(mysqlPool)));
app.post('/api/admin/term-restyle/run', ...adminOnly, requireDocsDb, requireOpenAI, async (req, res) => {
  try {
    if (!(await budgetGate(req, res, req.plan))) return;
    const out = await termLearn.restyleScan(mysqlPool, { limit: Number((req.body || {}).limit) || 25 });
    if (out.costUsd) aiBudget.charge({ uid: req.firebaseUser.uid, app: 'dict', feature: 'term_restyle', costUsd: out.costUsd });
    res.json({ success: true, data: { scanned: out.scanned, proposed: out.proposed, remaining: out.remaining, cost_credits: Math.round(out.costUsd * aiBudget.CREDITS_PER_USD * 10) / 10 } });
  } catch (e) { console.error('restyle:', e.message); res.status(500).json({ success: false, error: 'restyle_failed', detail: String(e.message || '').slice(0, 80) }); }
});
app.post('/api/admin/term-restyle/resolve', ...adminOnly, requireDocsDb, adminJson((req) => ((req.body || {}).term_ids ? termLearn.restyleResolveMany(mysqlPool, (req.body || {}).term_ids, (req.body || {}).status) : termLearn.restyleResolve(mysqlPool, String((req.body || {}).term_id || ''), (req.body || {}).status))));
app.get('/api/admin/auto-terms', ...adminOnly, requireDocsDb, adminJson(() => termLearn.listAutoTerms(mysqlPool)));
app.post('/api/admin/auto-terms/:id', ...adminOnly, requireDocsDb, adminJson((req) => termLearn.reviewAutoTerm(mysqlPool, String(req.params.id), req.body || {})));
app.post('/api/admin/term-promote/run', ...adminOnly, requireDocsDb, adminJson(() => termLearn.promoteBatch(mysqlPool)));
app.get('/api/admin/laoshi-faq', ...adminOnly, requireDocsDb, adminJson((req) => laoshiFaq.list(mysqlPool, String(req.query.status || 'pending'), req.query.auto === '1')));
app.post('/api/admin/laoshi-faq/:id', ...adminOnly, requireDocsDb, adminJson(async (req) => ({ ok: await laoshiFaq.review(mysqlPool, Number(req.params.id), req.body || {}) })));

app.get('/api/admin/orders', ...adminOnly, requireDocsDb, async (req, res) => {
  try { res.json({ success: true, data: (await billing.listAdmin(mysqlPool, String(req.query.status || 'pending'))).map((o) => ({ ...orderView(o), email: o.email, uid: o.firebase_uid, bank_ref: o.bank_ref })) }); }
  catch (e) { res.status(500).json({ success: false, error: 'list_failed' }); }
});
app.post('/api/admin/orders/:code/approve', ...adminOnly, requireDocsDb, async (req, res) => {
  try {
    const r = await billing.approveOrder(mysqlPool, req.params.code, { method: 'admin', note: `Duyệt bởi ${req.firebaseUser.email}` });
    if (!r) return res.status(409).json({ success: false, error: 'not_pending' });
    res.json({ success: true, data: { code: r.order.code, plan: r.order.plan, expires_at: r.expires } });
  } catch (e) { console.error('approve:', e.message); res.status(500).json({ success: false, error: 'approve_failed' }); }
});
app.post('/api/admin/orders/:code/reject', ...adminOnly, requireDocsDb, async (req, res) => {
  const ok = await billing.rejectOrder(mysqlPool, req.params.code, `Từ chối bởi ${req.firebaseUser.email}`).catch(() => false);
  res.status(ok ? 200 : 409).json({ success: ok, error: ok ? undefined : 'not_pending' });
});
app.post('/api/admin/grant', ...adminOnly, requireDocsDb, async (req, res) => {
  try {
    const { email, plan, months } = req.body || {};
    const [[u]] = await mysqlPool.query('SELECT firebase_uid, email FROM users WHERE email = ? ORDER BY id DESC LIMIT 1', [String(email || '').trim().toLowerCase()]);
    if (!u) return res.status(404).json({ success: false, error: 'user_not_found' });
    const exp = await billing.grantPlan(mysqlPool, { uid: u.firebase_uid, email: u.email, plan: String(plan), months: Number(months) });
    res.json({ success: true, data: { expires_at: exp } });
  } catch (e) { res.status(400).json({ success: false, error: 'grant_failed' }); }
});
// Tra cứu một tài khoản theo email: gói hiện hiệu lực, hạn, các đơn gần nhất, số dư credit, mức đã dùng tháng này (để đối soát nạp tiền).
app.get('/api/admin/user', ...adminOnly, requireDocsDb, async (req, res) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ success: false, error: 'email_required' });
    const [[u]] = await mysqlPool.query('SELECT * FROM users WHERE email = ? ORDER BY id DESC LIMIT 1', [email]);
    if (!u) return res.status(404).json({ success: false, error: 'user_not_found' });
    const uid = u.firebase_uid;
    const exp = u.plan_expires_at ? new Date(u.plan_expires_at) : null;
    const effective = String(u.role || '').toLowerCase() === 'admin' ? 'max' : (exp && exp.getTime() < Date.now() ? 'free' : String(u.plan || 'free'));
    const [orders] = await mysqlPool.query(
      'SELECT code, kind, plan, plan_period, amount, credits, status, method, paid_amount, note, created_at, paid_at FROM orders WHERE firebase_uid = ? ORDER BY created_at DESC LIMIT 12', [uid]);
    const b = await aiBudget.getBudget({ uid, plan: effective === 'max' || effective === 'pro' ? effective : 'free', pool: mysqlPool });
    res.json({ success: true, data: {
      email: u.email, uid, role: u.role || null, plan_stored: u.plan || 'free', plan_effective: effective,
      plan_expires_at: exp ? exp.toISOString() : null, expired: !!(exp && exp.getTime() < Date.now()),
      email_note: 'Gói theo email (PRO_EMAILS/MAX_EMAILS) chỉ áp dụng khi email đã xác minh — không hiện ở đây.',
      budget: aiBudget.publicView(b), orders,
    } });
  } catch (e) { console.error('admin user:', e.message); res.status(500).json({ success: false, error: 'lookup_failed' }); }
});
app.post('/api/admin/credits', ...adminOnly, requireDocsDb, async (req, res) => {
  try {
    const { email, credits } = req.body || {};
    const [[u]] = await mysqlPool.query('SELECT firebase_uid FROM users WHERE email = ? ORDER BY id DESC LIMIT 1', [String(email || '').trim().toLowerCase()]);
    if (!u) return res.status(404).json({ success: false, error: 'user_not_found' });
    const n = Number(credits);
    if (!Number.isFinite(n) || n === 0 || Math.abs(n) > 1000000) return res.status(400).json({ success: false, error: 'bad_credits' });
    await aiBudget.addCredits({ uid: u.firebase_uid, credits: n, reason: 'admin', ref: `admin-${Date.now()}`, pool: mysqlPool });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ success: false, error: 'credits_failed' }); }
});
app.post('/api/admin/codes', ...adminOnly, requireDocsDb, async (req, res) => {
  try {
    const { plan, months, count } = req.body || {};
    res.status(201).json({ success: true, data: await billing.createCodes(mysqlPool, { plan: String(plan), months: Number(months), count: Number(count) || 1, by: req.firebaseUser.email }) });
  } catch (e) { res.status(400).json({ success: false, error: 'codes_failed' }); }
});
app.get('/api/admin/codes', ...adminOnly, requireDocsDb, async (req, res) => {
  try { res.json({ success: true, data: await billing.listCodes(mysqlPool) }); }
  catch (e) { res.status(500).json({ success: false, error: 'list_failed' }); }
});

// ===== Thêm/sửa/xoá bài Luyện nghe KHÔNG cần redeploy =====
// Xác thực: tài khoản admin (Firebase) HOẶC khoá LESSON_PUSH_KEY (biến môi trường) gửi ở header x-lesson-key — dùng cho script/pipeline tự động.
const lessonAuth = (req, res, next) => {
  const key = process.env.LESSON_PUSH_KEY;
  if (key && String(req.headers['x-lesson-key'] || '') === key) return next();
  return verifyFirebaseToken(req, res, () => (isAdmin(req.firebaseUser) ? next() : res.status(403).json({ success: false, error: 'admin_required' })));
};
app.put('/api/admin/listening/lesson', express.json({ limit: '80mb' }), lessonAuth, requireDocsDb, async (req, res) => {
  try { res.json({ success: true, data: await listeningDb.upsert(mysqlPool, (req.body || {}).lesson, (req.body || {}).audio) }); }
  catch (e) { res.status(e.code === 'bad_request' ? 400 : 500).json({ success: false, error: e.message }); }
});
app.delete('/api/admin/listening/lesson/:id', lessonAuth, requireDocsDb, async (req, res) => {
  try { res.json({ success: true, data: await listeningDb.remove(mysqlPool, req.params.id) }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
onDbUp(() => listeningDb.ensureTables(mysqlPool).catch((e) => console.error('[listening-db] init:', e.message)));

app.use(express.static(PUBLIC_DIR, {
  // Hình huyệt/biểu tượng đổi rất hiếm (tên tệp cố định): cho trình duyệt/CDN giữ 30 ngày thay vì hỏi lại máy chủ mỗi lần (max-age=0 trước đây).
  setHeaders(res, filePath) {
    if (/[\\/](figures|icons)[\\/]/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=2592000');
    else if (/[\\/]vendor[\\/]/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=86400');
  },
}));
// Gói giao diện cho app iOS (live update) — dựng từ chính PUBLIC_DIR, xem lib/app-bundle.js.
// Chẩn đoán live-update: ghi lại mỗi lần app hỏi/tải gói giao diện (để biết app thật có đang cập nhật không).
// Nhật ký trong RAM (200 dòng gần nhất) để xem app thật có hỏi/tải gói không: GET /app-bundle/log.json (chỉ thời gian, đường dẫn, mã trả về, số byte đã gửi, loại máy).
const bundleLog = [];
app.use('/app-bundle', (req, res, next) => {
  const ua = String(req.headers['user-agent'] || '').slice(0, 90);
  console.log('[app-bundle]', req.method, req.originalUrl, ua);
  if (req.path === '/log.json') return next();
  const t0 = Date.now();
  res.on('close', () => {
    bundleLog.push({ at: new Date(t0 + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) + '+08', m: req.method, url: req.originalUrl.slice(0, 120), status: res.statusCode,
      sent: Number(res.getHeader('content-length')) || undefined, finished: res.writableFinished, ms: Date.now() - t0, range: req.headers.range ? String(req.headers.range).slice(0, 40) : undefined, ua });
    if (bundleLog.length > 200) bundleLog.shift();
  });
  next();
});
app.post('/app-bundle/report', express.text({ type: '*/*', limit: '2kb' }), (req, res) => {
  bundleLog.push({ at: new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) + '+08', report: String(req.body || '').slice(0, 300), ua: String(req.headers['user-agent'] || '').slice(0, 90) });
  if (bundleLog.length > 200) bundleLog.shift();
  res.json({ ok: true });
});
app.get('/app-bundle/log.json', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ now: new Date().toISOString(), n: bundleLog.length, log: bundleLog.slice().reverse() }); });
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

    // Thang Phương hiển thị cho MỌI người dùng cùng hệ thống, không cần đăng nhập (quyết định của admin 2026-10-27;
    // trước đó là domain gated). Dạng JSON của endpoint này không đổi — chỉ có thêm các mục group1 'Thang phương'.
    const formulaTerms = await getFormulaTerms();

    const baseTerms = [...sheetTerms, ...herbTerms, ...anatomyTerms, ...wordElementTerms, ...acupointTerms, ...autoTerms, ...formulaTerms];
    const generalTerms = dedupeGeneralTerms(await getGeneralTerms(), baseTerms);
    const terms = termLearn.applyOverrides([...baseTerms, ...generalTerms], await termLearn.getOverrides(mysqlPool));

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
 * GET /api/health — trạng thái kết nối MySQL (không lộ host, user, mật khẩu).
 */
app.get('/api/health', (req, res) => {
  const db = dbStatus();
  res.json({ status: db.configured && !db.ok ? 'degraded' : 'ok', timestamp: new Date().toISOString(), dbStatus: db, tts: userDocs.ttsStatus });
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
