import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import mysql from 'mysql2/promise';

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
    group2: h.section_zh || h.chapter_zh,
    vitri: h.medicinal_part,
    congnang: h.action_text_zh,
    lamsang: h.indication_text_zh,
    nguon: h.source_species,
    verify: true,
    category: 'herb',
    temperature_vi: h.temperature_vi,
    temperature_zh: h.temperature_zh,
    taste_vi: h.taste_vi,
    taste_zh: h.taste_zh,
    meridian_vi: h.meridian_vi,
    meridian_zh: h.meridian_zh,
    dose_text: h.dose_text_zh,
    dose_min_g: h.dose_min_g,
    dose_max_g: h.dose_max_g,
    caution: h.caution_text_zh,
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
    const terms = [...sheetTerms, ...herbTerms];

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
    const terms = [...sheetTerms, ...herbTerms];

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

function runScript(scriptFile, onDone) {
  const proc = spawn('node', [scriptFile], { cwd: __dirname, stdio: 'pipe' });
  let output = '';
  let errorOutput = '';
  proc.stdout.on('data', (data) => { output += data.toString(); });
  proc.stderr.on('data', (data) => { errorOutput += data.toString(); });
  proc.on('close', (code) => onDone(code, output, errorOutput));
}

/**
 * POST /api/import-herbs-now
 * Trigger a re-sync of the herbal dictionary from Google Sheets into MySQL
 * (with webhook secret)
 */
app.post('/api/import-herbs-now', (req, res) => {
  const secret = req.query.secret || req.body.secret;

  if (secret !== WEBHOOK_SECRET) {
    return res.status(403).json({ success: false, error: 'Unauthorized' });
  }

  runScript('import-herbal-sheets.js', (code, output, errorOutput) => {
    if (code === 0) {
      res.json({ success: true, message: 'Herb import triggered successfully', output });
    } else {
      res.status(500).json({ success: false, error: 'Import failed', output, errorOutput });
    }
  });
});

/**
 * POST /api/build-now
 * Trigger immediate build (with webhook secret)
 */
app.post('/api/build-now', (req, res) => {
  const secret = req.query.secret || req.body.secret;

  if (secret !== WEBHOOK_SECRET) {
    return res.status(403).json({
      success: false,
      error: 'Unauthorized',
    });
  }

  // Trigger build
  const build = spawn('node', ['build-api.js'], {
    cwd: __dirname,
    stdio: 'pipe',
  });

  let output = '';
  let errorOutput = '';

  build.stdout.on('data', (data) => {
    output += data.toString();
  });

  build.stderr.on('data', (data) => {
    errorOutput += data.toString();
  });

  build.on('close', (code) => {
    if (code === 0) {
      res.json({
        success: true,
        message: 'Build triggered successfully',
        output: output,
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Build failed',
        output: output,
        errorOutput: errorOutput,
      });
    }
  });
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
