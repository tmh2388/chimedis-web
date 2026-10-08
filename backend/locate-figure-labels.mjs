/**
 * locate-figure-labels.mjs — định vị TÊN HUYỆT trong 87 hình nguồn để "bôi đỏ" khi hiển thị.
 *
 * KHÔNG trích nội dung y khoa từ ảnh: tên huyệt của mỗi hình đã biết sẵn từ Core DB (bảng map
 * hình↔huyệt); script chỉ tìm VỊ TRÍ (bbox) của tên đó. Cách làm (không cần OCR — OCR chi_sim đọc nhãn
 * nhỏ không ổn định, thử rồi bỏ):
 *  1. Tìm các chấm đỏ sẫm (vị trí huyệt). Nhãn nằm ở đầu kia của đường chấm gạch bắt nguồn từ chấm.
 *  2. Với mỗi nhãn, lấy khung chữ (cột có điểm tối ngoài dải ±5px quanh đường gạch).
 *  3. Khớp MẪU: vẽ từng tên ứng viên bằng chữ Tống (STSong) rồi trượt mẫu trên khung nhãn, tính tương
 *     quan chuẩn hoá (NCC); gán tên↔nhãn theo điểm cao nhất (tham lam, mỗi tên/nhãn dùng 1 lần).
 *  Không khớp đủ tin cậy → không bôi đỏ (hiển thị hình bình thường).
 * Ghi vào data/acupoint-figures.json: labels[mediaId][acupointId] = [x,y,w,h] (px ảnh gốc),
 * media[id].hl = 'text' (nền trắng: chữ đen → đỏ bằng mix-blend-mode) | 'box' (nền ảnh chụp: khung đỏ).
 * Hình đường kinh (nền ảnh chụp, chấm xanh) không có chấm đỏ → không định vị (hl='box', không có box).
 *
 * Chạy (dev-time; sharp không nằm trong package.json): npm i --no-save sharp
 *   GOOGLE_*, GOOGLE_ACUPOINT_CORE_SPREADSHEET_ID node locate-figure-labels.mjs   (DEBUG_DIR=... để xuất ảnh kiểm tra)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { google } from 'googleapis';
import { createGoogleAuth } from './google-auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JSON_PATH = path.join(__dirname, 'data', 'acupoint-figures.json');
const DEBUG_DIR = process.env.DEBUG_DIR;
const THRESH = parseFloat(process.env.NCC_MIN || '0.65');
const spreadsheetId = process.env.GOOGLE_ACUPOINT_CORE_SPREADSHEET_ID;
const auth = createGoogleAuth(['https://www.googleapis.com/auth/spreadsheets.readonly']);
const sheets = google.sheets({ version: 'v4', auth });
async function readTab(tab) {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A:Z` });
  const v = r.data.values || []; const h = v[0] || [];
  return v.slice(1).filter((x) => x[0]).map((x) => Object.fromEntries(h.map((k, i) => [k, x[i] ?? ''])));
}

const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
const names = await readTab('kb_acupoint_names');
const maps = await readTab('kb_source_media_acupoint_map');
const zhName = {};
for (const n of names) if (n.locale === 'zh-CN') zhName[n.acupoint_id] = n.name_text;
const targets = {};
for (const m of maps) {
  if (!data.media[m.source_media_id] || !zhName[m.acupoint_id]) continue;
  (targets[m.source_media_id] ||= []).push({ id: m.acupoint_id, name: zhName[m.acupoint_id], rel: m.relation_type });
}

// ---------- mẫu chữ Tống ----------
const tplDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-'));
const uniqNames = [...new Set(Object.values(targets).flat().filter((t) => t.rel !== 'MERIDIAN_CONTEXT').map((t) => t.name))];
const fnOf = Object.fromEntries(uniqNames.map((n, i) => [n, 't' + i]));
fs.writeFileSync(path.join(tplDir, 'names.json'), JSON.stringify(fnOf));
execFileSync('/usr/bin/python3', [path.join(__dirname, 'render-name-templates.py'), path.join(tplDir, 'names.json'), tplDir], { stdio: 'inherit' });

// Mẫu đã cắt sát nét, dạng độ đậm 0..1, chiều cao chuẩn 64.
const tplCache = {};
async function template(name) {
  if (tplCache[name]) return tplCache[name];
  const { data: g, info } = await sharp(path.join(tplDir, fnOf[name] + '.png')).greyscale().raw().toBuffer({ resolveWithObject: true });
  let x0 = info.width, x1 = 0, y0 = info.height, y1 = 0;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) if (g[y * info.width + x] < 128) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const buf = await sharp(path.join(tplDir, fnOf[name] + '.png')).greyscale().extract({ left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }).png().toBuffer();
  tplCache[name] = { buf, ratio: (x1 - x0 + 1) / (y1 - y0 + 1), n: [...name].length };
  return tplCache[name];
}
async function scaled(name, h) {
  const t = await template(name);
  const w = Math.max(4, Math.round(h * t.ratio));
  const { data: g } = await sharp(t.buf).greyscale().resize(w, h, { fit: 'fill', kernel: 'lanczos3' }).blur(1.6).raw().toBuffer({ resolveWithObject: true });
  const d = new Float32Array(w * h); for (let i = 0; i < w * h; i++) d[i] = 1 - g[i] / 255;
  return { w, h, d };
}
// NCC lớn nhất khi trượt mẫu T trên vùng nhãn R (rw×rh), tìm cả lệch ngang lẫn lệch dọc.
function bestNcc(R, rw, rh, T) {
  const { w: tw, h: th, d: td } = T; if (tw > rw || th > rh) return { score: -1, off: 0, vo: 0 };
  let tm = 0; for (let i = 0; i < td.length; i++) tm += td[i]; tm /= td.length;
  let tn = 0; for (let i = 0; i < td.length; i++) tn += (td[i] - tm) ** 2; tn = Math.sqrt(tn) || 1;
  let best = { score: -1, off: 0, vo: 0 };
  for (let vo = 0; vo + th <= rh; vo++) for (let off = 0; off + tw <= rw; off++) {
    let rm = 0; for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) rm += R[(y + vo) * rw + off + x]; rm /= tw * th;
    let num = 0, rn = 0;
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { const rv = R[(y + vo) * rw + off + x] - rm; num += rv * (td[y * tw + x] - tm); rn += rv * rv; }
    const sc = num / (tn * (Math.sqrt(rn) || 1));
    if (sc > best.score) best = { score: sc, off, vo };
  }
  return best;
}

// ---------- hình ----------
function components(mask, W, H) {
  const lab = new Int32Array(W * H); const comps = []; let next = 1; const stack = [];
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] || lab[i]) continue;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, area = 0; stack.push(i); lab[i] = next;
    while (stack.length) {
      const p = stack.pop(); const x = p % W, y = (p / W) | 0; area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q = ny * W + nx; if (mask[q] && !lab[q]) { lab[q] = next; stack.push(q); }
      }
    }
    comps.push({ x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, area }); next++;
  }
  return comps;
}

const SC = {}; const labels = {}; let expected = 0, found = 0; const missing = [];
for (const [mid, m] of Object.entries(data.media)) {
  if (process.env.ONLY && !mid.includes(process.env.ONLY)) continue;
  const file = path.join(__dirname, 'public', m.src);
  const { data: rgb, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const gray = (x, y) => (rgb[(y * W + x) * 3] + rgb[(y * W + x) * 3 + 1] + rgb[(y * W + x) * 3 + 2]) / 3;
  const mask = new Uint8Array(W * H), red = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    mask[i] = (r < 160 && g < 160 && b < 165 && Math.abs(r - b) < 50) ? 1 : 0;
    red[i] = (r > 110 && r < 215 && g < 75 && b < 85 && r - g > 70) ? 1 : 0;
  }
  let edge = 0, ec = 0; for (let x = 0; x < W; x += 7) for (const y of [2, H - 3]) { edge += gray(x, y); ec++; }
  m.hl = edge / ec > 235 ? 'text' : 'box';
  const wanted = (targets[mid] || []).filter((t) => t.rel !== 'MERIDIAN_CONTEXT');
  const L = {};
  const dots = components(red, W, H).filter((k) => k.area >= 90 && k.w >= 10 && k.w <= 40 && Math.abs(k.w - k.h) <= 6);
  const dark = (x, y) => x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x] === 1;

  // 1+2: khung nhãn cho từng chấm
  const boxes = [];
  for (const d of dots) {
    const cy = Math.round((d.y0 + d.y1) / 2), cx = Math.round((d.x0 + d.x1) / 2);
    for (const dir of [-1, 1]) {
      let far = null;
      for (let x = cx + dir * 14; x >= 0 && x < W; x += dir) for (let y = cy - 5; y <= cy + 5; y++) if (dark(x, y)) { far = x; break; }
      if (far == null || Math.abs(far - cx) < 40) continue;
      const textCol = (x) => { for (let y = cy - 24; y <= cy + 24; y++) { if (Math.abs(y - cy) < 5) continue; if (dark(x, y)) return true; } return false; };
      let xb = far, gap = 0, started = false;
      for (let x = far; x >= 0 && x < W; x -= dir) {
        if (textCol(x)) { xb = x; gap = 0; started = true; } else if (started && ++gap > 15) break;
        if (Math.abs(x - cx) < 12) break;
      }
      const x0 = Math.min(far, xb), x1 = Math.max(far, xb);
      if (!started || x1 - x0 < 18 || x1 - x0 > 300) continue;
      let y0 = H, y1 = 0;
      for (let y = cy - 26; y <= cy + 26; y++) for (let x = x0; x <= x1; x++) if (dark(x, y)) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (y1 - y0 < 12) continue;
      boxes.push({ x0, y0, x1, y1 });
    }
  }
  // 2b: hộp nhãn không dựa vào chấm (nhãn có thước/đường gạch xiên): gom các mảnh nét đen thành dòng,
  // rồi nới ngang để bắt nét mảnh bị lọc (vd. 二, 三) — chỉ tính cột có nét ngoài dải giữa dòng (tránh men theo đường gạch).
  {
    const comps = components(mask, W, H).filter((k) => k.h >= 10 && k.h <= 64 && k.w >= 3 && k.w <= 72 && k.area >= 18).sort((a, b) => a.x0 - b.x0);
    const parent = comps.map((_, i) => i); const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < comps.length; i++) for (let j = i + 1; j < comps.length; j++) {
      const a = comps[i], c = comps[j];
      if (c.x0 - a.x1 > 26) { if (c.x0 - a.x1 > 60) break; continue; }
      const ov = Math.min(a.y1, c.y1) - Math.max(a.y0, c.y0);
      if (ov >= 0.5 * Math.min(a.h, c.h) && Math.abs(a.h - c.h) < 30) parent[find(j)] = find(i);
    }
    const groups = {}; comps.forEach((k, i) => { (groups[find(i)] ||= []).push(k); });
    for (const g of Object.values(groups)) {
      let x0 = Math.min(...g.map((k) => k.x0)), y0 = Math.min(...g.map((k) => k.y0)), x1 = Math.max(...g.map((k) => k.x1)), y1 = Math.max(...g.map((k) => k.y1));
      if (g.length < 2 || y1 - y0 < 14 || y1 - y0 > 70) continue;
      const cyy = (y0 + y1) / 2;
      const colHas = (x) => { for (let y = y0; y <= y1; y++) { if (Math.abs(y - cyy) < 5) continue; if (dark(x, y)) return true; } return false; };
      for (let gap = 0, x = x0 - 1; x > 0 && gap <= 10; x--) { if (colHas(x)) { x0 = x; gap = 0; } else gap++; }
      for (let gap = 0, x = x1 + 1; x < W && gap <= 10; x++) { if (colHas(x)) { x1 = x; gap = 0; } else gap++; }
      if (x1 - x0 < 22 || x1 - x0 > 320) continue;
      if (boxes.some((b) => Math.abs(b.x0 - x0) < 6 && Math.abs(b.x1 - x1) < 6 && Math.abs(b.y0 - y0) < 6)) continue;
      boxes.push({ x0, y0, x1, y1 });
    }
  }
  if (process.env.VERBOSE) console.log('  boxes', JSON.stringify(boxes));
  // 3: khớp mẫu — điểm cho mọi cặp (nhãn, tên)
  const pairs = [];
  for (let bi = 0; bi < boxes.length; bi++) {
    const b = boxes[bi]; const pad = 2;
    const rx0 = Math.max(0, b.x0 - pad), ry0 = Math.max(0, b.y0 - pad);
    const rw = Math.min(W - rx0, b.x1 - b.x0 + 1 + 2 * pad), rh = Math.min(H - ry0, b.y1 - b.y0 + 1 + 2 * pad);
    // vùng nhãn dạng độ đậm (1 = đen) từ mặt nạ, làm mờ nhẹ cho mẫu 'mịn' giống nét chữ
    const { data: rg } = await sharp(file).removeAlpha().extract({ left: rx0, top: ry0, width: rw, height: rh }).greyscale().normalise().blur(1.6).raw().toBuffer({ resolveWithObject: true });
    const R = new Float32Array(rw * rh); for (let i = 0; i < rw * rh; i++) R[i] = 1 - rg[i] / 255;
    for (const t of wanted) {
      let best = { score: -1 };
      const bh = b.y1 - b.y0 + 1;
      for (const k of [0.82, 0.86, 0.9, 0.94, 0.98]) {
        const T = await scaled(t.name, Math.min(rh, Math.max(10, Math.round(bh * k))));
        const r = bestNcc(R, rw, rh, T);
        if (process.env.VERBOSE && t.name === '合谷' && bi === 1 && k === 0.9) { await sharp(Buffer.from(Float32Array.from(R, (v) => Math.round((1 - v) * 255))), { raw: { width: rw, height: rh, channels: 1 } }).resize(rw * 4, rh * 4).png().toFile('/tmp/dbgR.png'); await sharp(Buffer.from(Float32Array.from(T.d, (v) => Math.round((1 - v) * 255))), { raw: { width: T.w, height: T.h, channels: 1 } }).resize(T.w * 4, T.h * 4).png().toFile('/tmp/dbgT.png'); }
        if (process.env.VERBOSE && t.name === '合谷' && bi === 1) console.log('   k', k, 'T', T.w, T.h, 'R', rw, rh, 'score', r.score.toFixed(3), r.off, r.vo);
        if (r.score > best.score) best = { ...r, tw: T.w, th: T.h };
      }
      if (process.env.VERBOSE && t.name === '合谷') console.log('  合谷 vs box', bi, JSON.stringify({ x0: b.x0, y0: b.y0 }), best.score.toFixed(2), 'th', best.th);
      if (best.score > 0) pairs.push({ bi, t, score: best.score, off: best.off, vo: best.vo, tw: best.tw, th: best.th, rx0, ry0 });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  if (process.env.VERBOSE) console.log('  dots', dots.length, 'boxes', boxes.length, 'pairs', pairs.length, 'top', pairs.slice(0, 6).map((p) => `${p.t.name}:${p.score.toFixed(2)}`).join(' '));
  const usedB = new Set(), usedT = new Set();
  for (const p of pairs) {
    if (p.score < THRESH || usedB.has(p.bi) || usedT.has(p.t.id)) continue;
    usedB.add(p.bi); usedT.add(p.t.id);
    const b = boxes[p.bi];
    L[p.t.id] = [p.rx0 + p.off - 2, p.ry0 + p.vo - 2, p.tw + 4, p.th + 4];
    SC[mid + '|' + p.t.id] = +p.score.toFixed(2);
    if (process.env.VERBOSE) console.log('  ', p.t.id, p.t.name, p.score.toFixed(2));
  }
  // Lần hai — cùng 1 tên xuất hiện NHIỀU lần trong hình (vd. hình lưng ghi tên ở cả hai bên): gán thêm các
  // khung còn trống có điểm ≥ DUP_MIN, bỏ qua khung trùng vị trí với khung đã gán (cùng 1 nhãn bị tìm ra 2 lần).
  const DUP_MIN = parseFloat(process.env.NCC_DUP || '0.62');
  // Tên cùng bộ chữ (肺俞/脾俞/肝俞…) có mẫu rất giống nhau → 'vay' nhãn của nhau. Khung trùng CHỈ nhận khi tên đó là
  // tên khớp NHẤT với chính khung đó (trong mọi tên của hình), nếu không sẽ bôi nhầm sang nhãn của huyệt khác.
  const bestOfBox = {};
  for (const q of pairs) if (!bestOfBox[q.bi] || q.score > bestOfBox[q.bi].score) bestOfBox[q.bi] = q;
  const iou = (a, b) => { const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]), x1 = Math.min(a[0] + a[2], b[0] + b[2]), y1 = Math.min(a[1] + a[3], b[1] + b[3]); const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0); return i / (a[2] * a[3] + b[2] * b[3] - i || 1); };
  for (const p of pairs) {
    if (p.score < DUP_MIN || usedB.has(p.bi) || !L[p.t.id] || bestOfBox[p.bi].t.id !== p.t.id) continue;
    // Khung trùng phải phủ gần TRỌN nhãn (mẫu rộng 80–125% khung chữ) — tránh khớp một phần, vd. mẫu '肺俞'
    // trượt lên nửa '阴俞' của nhãn '厥阴俞' (cùng chữ 俞) rồi sinh khung thừa.
    const bw = boxes[p.bi].x1 - boxes[p.bi].x0 + 1;
    if (p.tw < 0.8 * bw || p.tw > 1.25 * bw) continue;
    const nb = [p.rx0 + p.off - 2, p.ry0 + p.vo - 2, p.tw + 4, p.th + 4];
    const have = Array.isArray(L[p.t.id][0]) ? L[p.t.id] : [L[p.t.id]];
    if (have.some((h) => iou(h, nb) > 0.15)) continue;
    usedB.add(p.bi); L[p.t.id] = [...have, nb];
    if (process.env.VERBOSE) console.log('   + trùng tên', p.t.id, p.t.name, p.score.toFixed(2));
  }
  labels[mid] = L;
  for (const t of wanted) { expected++; if (L[t.id]) found++; else missing.push(`${t.id}(${t.name})@${m.figure}`); }
  process.stdout.write(`${m.figure} ${Object.keys(L).length}/${wanted.length} · `);
  if (DEBUG_DIR) {
    const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${boxes.map((b) => `<rect x="${b.x0}" y="${b.y0}" width="${b.x1 - b.x0}" height="${b.y1 - b.y0}" fill="none" stroke="blue" stroke-width="2"/>`).join('')}${Object.values(L).flatMap((v) => (Array.isArray(v[0]) ? v : [v])).map(([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="red" stroke-width="3"/>`).join('')}</svg>`;
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    await sharp(file).composite([{ input: Buffer.from(svg) }]).jpeg().toFile(path.join(DEBUG_DIR, path.basename(file)));
  }
}
if (!process.env.ONLY) { data.labels = labels; fs.writeFileSync(JSON_PATH, JSON.stringify(data)); }
fs.writeFileSync(path.join(os.tmpdir(), 'label-scores.json'), JSON.stringify(SC));
console.log(`\n✅ Định vị được ${found}/${expected} cặp (huyệt, hình) = ${(100 * found / expected).toFixed(1)}%`);
console.log('Thiếu:', missing.slice(0, 40).join(', '), missing.length > 40 ? `… (+${missing.length - 40})` : '');
