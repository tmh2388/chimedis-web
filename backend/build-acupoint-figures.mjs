/**
 * build-acupoint-figures.mjs
 *
 * Tải bộ hình nguồn (kb_source_media_assets, 87 hình kinh mạch/định vị huyệt trích từ
 * 《经络腧穴学》新世纪第五版) từ Google Drive về backend/public/figures/ và sinh bản đồ
 * huyệt → hình vào backend/data/acupoint-figures.json (server.js nạp lúc khởi động).
 *
 * ⚠️ Bản quyền: Core DB ghi rights_status=COPYRIGHTED_SOURCE_REFERENCE, internal_use_only=TRUE
 * (README: "product atlas must be separately redesigned and linked later"). Founder quyết định
 * (2026-10-07) DÙNG TẠM các hình này trên app trong lúc chưa có atlas riêng — đây là quyết định
 * của chủ sở hữu, rủi ro bản quyền do họ chịu; code luôn kèm dòng ghi nguồn và có công tắc tắt
 * nhanh bằng env SOURCE_FIGURES_ENABLED=false (server.js) mà không cần deploy code mới.
 *
 * Thứ tự hình cho mỗi huyệt: POINT_LOCATION_DETAIL → LOCATION_REFERENCE. Hình cả đường kinh
 * (MERIDIAN_CONTEXT) tách riêng thành byMeridian.
 *
 * Env: GOOGLE_CREDENTIALS_JSON(_B64), GOOGLE_ACUPOINT_CORE_SPREADSHEET_ID
 * Usage: node build-acupoint-figures.mjs
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { createGoogleAuth } from './google-auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'public', 'figures');
const OUT_JSON = path.join(__dirname, 'data', 'acupoint-figures.json');
const spreadsheetId = process.env.GOOGLE_ACUPOINT_CORE_SPREADSHEET_ID;
if (!spreadsheetId) throw new Error('Thiếu GOOGLE_ACUPOINT_CORE_SPREADSHEET_ID');

const auth = createGoogleAuth([
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
]);
const sheets = google.sheets({ version: 'v4', auth });
const drive = google.drive({ version: 'v3', auth });

async function readTab(tab) {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A:Z` });
  const v = r.data.values || [];
  const h = v[0] || [];
  return v.slice(1).filter((row) => row[0]).map((row) => Object.fromEntries(h.map((k, i) => [k, row[i] ?? ''])));
}
const isTrue = (x) => x === true || String(x).toUpperCase() === 'TRUE';
const driveId = (uri) => {
  if (/^[A-Za-z0-9_-]{25,}$/.test(uri)) return uri;
  const m = uri.match(/\/d\/([A-Za-z0-9_-]{25,})/) || uri.match(/[?&]id=([A-Za-z0-9_-]{25,})/);
  return m ? m[1] : null;
};
const RANK = { POINT_LOCATION_DETAIL: 0, LOCATION_REFERENCE: 1, MERIDIAN_CONTEXT: 2 };

const media = (await readTab('kb_source_media_assets')).filter((m) => isTrue(m.is_active));
const maps = (await readTab('kb_source_media_acupoint_map')).filter((m) => isTrue(m.is_active));
console.log(`📖 media=${media.length} maps=${maps.length}`);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });

const mediaOut = {};
let bytes = 0;
for (const m of media) {
  const id = driveId(m.storage_uri);
  if (!id) { console.warn('⚠️  Không đọc được Drive ID:', m.source_media_id, m.storage_uri); continue; }
  const slug = m.source_media_id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const file = `${slug}.jpg`;
  const dest = path.join(OUT_DIR, file);
  if (!fs.existsSync(dest)) {
    const res = await drive.files.get({ fileId: id, alt: 'media' }, { responseType: 'arraybuffer' });
    fs.writeFileSync(dest, Buffer.from(res.data));
  }
  const buf = fs.readFileSync(dest);
  bytes += buf.length;
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (m.sha256 && sha !== m.sha256) console.warn(`⚠️  sha256 lệch (file Drive khác bản đã đăng ký): ${m.source_media_id}`);
  mediaOut[m.source_media_id] = {
    src: `/figures/${file}`,
    figure: m.figure_number,
    caption_zh: m.caption_zh,
    w: parseInt(m.width_px, 10) || null,
    h: parseInt(m.height_px, 10) || null,
  };
}

// Hình CỦA HUYỆT (POINT_LOCATION_DETAIL / LOCATION_REFERENCE) → byPoint.
// Hình CẢ ĐƯỜNG KINH (MERIDIAN_CONTEXT, 14 hình — mỗi kinh 1 hình) KHÔNG hiện trong popup huyệt (founder
// 2026-10-07: "chỉ để ảnh của huyệt") mà tách riêng → byMeridian, xem qua nút "Hình đường kinh".
const byPoint = {};
const byMeridian = {};
for (const mp of maps) {
  if (!mediaOut[mp.source_media_id]) continue;
  if (mp.relation_type === 'MERIDIAN_CONTEXT') {
    const code = mp.acupoint_id.split('-')[0]; // LU, LI, ... CV, GV
    (byMeridian[code] ||= new Set()).add(mp.source_media_id);
    continue;
  }
  (byPoint[mp.acupoint_id] ||= []).push([mp.source_media_id, mp.relation_type]);
}
for (const list of Object.values(byPoint)) {
  list.sort((a, b) => (RANK[a[1]] ?? 9) - (RANK[b[1]] ?? 9) || a[0].localeCompare(b[0]));
}
const byPointIds = Object.fromEntries(Object.entries(byPoint).map(([k, v]) => [k, [...new Set(v.map((x) => x[0]))]]));
const byMeridianIds = Object.fromEntries(Object.entries(byMeridian).map(([k, v]) => [k, [...v]]));

fs.writeFileSync(OUT_JSON, JSON.stringify({ media: mediaOut, byPoint: byPointIds, byMeridian: byMeridianIds }));
console.log(`✅ ${Object.keys(mediaOut).length} hình (${(bytes / 1048576).toFixed(1)} MB) · ${Object.keys(byPointIds).length} huyệt có hình → ${OUT_JSON}`);
