/**
 * tcm-vocabulary.js
 *
 * Loader cho backend/data/tcm-vocabulary.json — nguồn chân lý DUY NHẤT cho
 * thuật ngữ TCM chuẩn (Hán Việt), thay cho các bảng từng hardcode rải rác
 * độc lập trong import-herbal-sheets.js / fix-herb-tvm-fields.js /
 * import-acupoint-sheets.js (bug TASTE_LABELS 2026-08-19 xuất phát từ chính
 * kiểu kiến trúc "mỗi nơi tự khai 1 bảng" này — xem project_chimedis_translation_qa).
 * Frontend đọc CÙNG file này qua GET /api/tcm-vocabulary (xem server.js).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VOCAB_PATH = path.join(__dirname, 'data', 'tcm-vocabulary.json');

let _cache = null;
export function loadVocabulary() {
  if (!_cache) {
    _cache = JSON.parse(fs.readFileSync(VOCAB_PATH, 'utf8'));
  }
  return _cache;
}

// Một số mã ghép (WEIHAN, DARE...) từng có 2 biến thể khoá trong nguồn Sheet
// (có/không gạch dưới: WEIHAN vs WEI_HAN) — bug cũ (2026-08-11) là do bảng
// hardcode thiếu 1 biến thể. Sinh tự động biến thể gạch dưới từ 1 mã CHUẨN
// DUY NHẤT trong vocabulary, không cần liệt kê tay cả 2 kiểu nữa.
// ⚠️ DÙNG ALLOWLIST TƯỜNG MINH, KHÔNG DÙNG REGEX ĐOÁN TIỀN TỐ: thử heuristic
// "chèn _ sau WEI/DA" ban đầu đã lỗi thật — "DAN" (Đạm, vị nhạt) bị hiểu nhầm
// thành "DA"+"N" rồi tự sinh khoá rác "DA_N" (phát hiện khi test 2026-08-19,
// trước khi push). Danh sách dưới đây khớp 1:1 các cặp WEI_HAN/WEI_WEN/...
// đã có trong TEMPERATURE_LABELS/TASTE_LABELS gốc trước khi gộp vào đây.
const UNDERSCORE_VARIANTS = {
  WEIHAN: 'WEI_HAN', WEIWEN: 'WEI_WEN', DARE: 'DA_RE', DAHAN: 'DA_HAN',
  WEIXIN: 'WEI_XIN', WEIGAN: 'WEI_GAN', WEIKU: 'WEI_KU', WEISUAN: 'WEI_SUAN',
  DACHANG: 'DA_CHANG', XIAOCHANG: 'XIAO_CHANG', PANGGUANG: 'PANG_GUANG',
  SANJIAO: 'SAN_JIAO', XINBAO: 'XIN_BAO',
};
function underscoreVariant(code) {
  return UNDERSCORE_VARIANTS[code] || null;
}
// {CODE: [hz, vi, en], CODE_VARIANT: [...]} — dùng cho decodeCodes() kiểu
// "tra theo mã nguồn" (import-herbal-sheets.js).
export function buildLabelMap(sectionName) {
  const map = {};
  (loadVocabulary()[sectionName] || []).forEach(({ code, hz, vi, en }) => {
    map[code] = [hz, vi, en];
    const alt = underscoreVariant(code);
    if (alt) map[alt] = [hz, vi, en];
  });
  return map;
}

// (token) => [hz, vi, en] | null — tra theo CHỮ HÁN đã lưu (trường hợp bình
// thường) HOẶC theo mã thô còn sót trong DB cũ (trường hợp fix-herb-tvm-fields.js
// gặp phải, vd. "WEI_HAN" nằm lẫn trong cột lẽ ra chỉ chứa chữ Hán) — gộp 2
// nguồn tra cứu lại thay cho RAW_CODE_FIXES tách riêng trước đây.
export function buildZhLookup(sectionName) {
  const byCode = buildLabelMap(sectionName);
  const byZh = new Map();
  (loadVocabulary()[sectionName] || []).forEach(({ hz, vi, en }) => {
    byZh.set(hz, [hz, vi, en]);
  });
  return (token) => byZh.get(token) || byCode[token] || null;
}

// Danh sách 14 kinh mạch đầy đủ (Huyệt vị) — {LU: 'Kinh Thủ Thái Âm Phế', ...}
export function getMeridianChannelStandard() {
  const map = {};
  (loadVocabulary().meridian_channel || []).forEach(({ code, vi }) => {
    map[code] = vi;
  });
  return map;
}

// Nhóm đồng nghĩa pháp trị/công năng TCM — dùng cho search (frontend) qua
// GET /api/tcm-vocabulary, cũng export ở đây để dùng thử/kiểm tra từ backend.
export function getActionTerms() {
  return loadVocabulary().action_terms || [];
}
