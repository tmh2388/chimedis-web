import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'chimedis-secret-key';

const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(FRONTEND_DIR));

// ===== API ENDPOINTS =====

/**
 * GET /api/terms
 * Fetch all terms with optional filters
 * Filters: ?group=Giải phẫu&verified=true&search=phế
 */
app.get('/api/terms', (req, res) => {
  try {
    const termsPath = path.join(__dirname, 'public', 'data', 'terms.json');

    if (!fs.existsSync(termsPath)) {
      return res.status(404).json({
        success: false,
        error: 'Terms data not found. Run: npm run build',
      });
    }

    const terms = JSON.parse(fs.readFileSync(termsPath, 'utf8'));

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
app.get('/api/groups', (req, res) => {
  try {
    const termsPath = path.join(__dirname, 'public', 'data', 'terms.json');

    if (!fs.existsSync(termsPath)) {
      return res.status(404).json({
        success: false,
        error: 'Terms data not found',
      });
    }
    
    const terms = JSON.parse(fs.readFileSync(termsPath, 'utf8'));
    
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
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'), (err) => {
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
