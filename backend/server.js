import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { runImport } from './import-herbal-sheets.js';
import { buildAPI } from './build-api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
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
function acupointRowToTerm(a) {
  return {
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

// Frontend static assets live in backend/public/ (synced from ../frontend via
// `npm run build` locally — see sync-frontend.js) so a deploy that only ships
// the backend/ directory still serves the PWA.
const PUBLIC_DIR = path.join(__dirname, 'public');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

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
    const terms = [...sheetTerms, ...herbTerms, ...anatomyTerms, ...wordElementTerms, ...acupointTerms];

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
    const terms = [...sheetTerms, ...herbTerms, ...anatomyTerms, ...wordElementTerms, ...acupointTerms];

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
