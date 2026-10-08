/**
 * build-acupoint-class-detail.mjs
 *
 * Sinh data/acupoint-class-detail.json: với mỗi huyệt, danh sách loại huyệt đặc hiệu KÈM CHI TIẾT
 * (giao hội với kinh nào, lạc sang kinh nào, bối du/mộ của tạng phủ nào, bát mạch thông mạch nào...).
 * Nguồn: kb_acupoint_class_map.scope (chuỗi Trung văn của sách) + ref_acupoint_class_codes (nhãn 3 ngữ).
 * Phần dịch VI/EN của `scope` làm bằng quy tắc xác định (bảng thuật ngữ kinh mạch/tạng phủ cố định),
 * không dùng dịch máy; chuỗi không khớp quy tắc → bỏ chi tiết (chỉ giữ nhãn loại) thay vì đoán.
 * server.js nạp file này lúc khởi động (class_detail trong term huyệt).
 *
 * Env: GOOGLE_CREDENTIALS_JSON(_B64), GOOGLE_ACUPOINT_CORE_SPREADSHEET_ID
 * Usage: node build-acupoint-class-detail.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { createGoogleAuth } from './google-auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'data', 'acupoint-class-detail.json');
const spreadsheetId = process.env.GOOGLE_ACUPOINT_CORE_SPREADSHEET_ID;
if (!spreadsheetId) throw new Error('Thiếu GOOGLE_ACUPOINT_CORE_SPREADSHEET_ID');
const sheets = google.sheets({ version: 'v4', auth: createGoogleAuth(['https://www.googleapis.com/auth/spreadsheets.readonly']) });
async function readTab(tab) {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A:Z` });
  const v = r.data.values || [];
  return v.slice(1).filter((x) => x[0]).map((x) => Object.fromEntries(v[0].map((k, i) => [k, x[i] ?? ''])));
}

// ---- Bảng thuật ngữ cố định ----
const HAND = { '手足': ['Thủ Túc', 'Hand and Foot'], '手': ['Thủ', 'Hand'], '足': ['Túc', 'Foot'] };
const YY = { '三阴': ['Tam Âm', 'three Yin'], '三阳': ['Tam Dương', 'three Yang'], '太阴': ['Thái Âm', 'Taiyin'], '阳明': ['Dương Minh', 'Yangming'],
  '少阴': ['Thiếu Âm', 'Shaoyin'], '太阳': ['Thái Dương', 'Taiyang'], '厥阴': ['Quyết Âm', 'Jueyin'], '少阳': ['Thiếu Dương', 'Shaoyang'] };
const VESSEL = { '阳维脉': ['Dương Duy mạch', 'Yang Linking vessel'], '阴维脉': ['Âm Duy mạch', 'Yin Linking vessel'],
  '阳跷脉': ['Dương Kiểu mạch', 'Yang Heel vessel'], '阴跷脉': ['Âm Kiểu mạch', 'Yin Heel vessel'], '冲脉': ['Xung mạch', 'Penetrating vessel'],
  '带脉': ['Đới mạch', 'Belt vessel'], '任脉': ['Nhâm mạch', 'Conception vessel'], '督脉': ['Đốc mạch', 'Governing vessel'] };
const ORGAN = { '肺': ['Phế', 'Lung'], '大肠': ['Đại trường', 'Large Intestine'], '胃': ['Vị', 'Stomach'], '脾': ['Tỳ', 'Spleen'], '心包': ['Tâm bào', 'Pericardium'],
  '心': ['Tâm', 'Heart'], '小肠': ['Tiểu trường', 'Small Intestine'], '膀胱': ['Bàng quang', 'Bladder'], '肾': ['Thận', 'Kidney'], '三焦': ['Tam tiêu', 'San Jiao'],
  '胆': ['Đởm', 'Gallbladder'], '肝': ['Can', 'Liver'] };
const HUI = { '脉': ['Mạch hội', 'vessels'], '血': ['Huyết hội', 'blood'], '骨': ['Cốt hội', 'bone'], '筋': ['Cân hội', 'sinews'], '髓': ['Tủy hội', 'marrow'],
  '脏': ['Tạng hội', 'zang organs'], '腑': ['Phủ hội', 'fu organs'], '气': ['Khí hội', 'qi'] };
// Kinh chính theo tiền tố mã huyệt (để suy ra "lạc sang kinh nào": kinh biểu-lý đối ứng)
const MER = { LU: ['手太阴肺经', 'Thủ Thái Âm Phế kinh', 'Hand Taiyin Lung channel'], LI: ['手阳明大肠经', 'Thủ Dương Minh Đại Trường kinh', 'Hand Yangming Large Intestine channel'],
  ST: ['足阳明胃经', 'Túc Dương Minh Vị kinh', 'Foot Yangming Stomach channel'], SP: ['足太阴脾经', 'Túc Thái Âm Tỳ kinh', 'Foot Taiyin Spleen channel'],
  HT: ['手少阴心经', 'Thủ Thiếu Âm Tâm kinh', 'Hand Shaoyin Heart channel'], SI: ['手太阳小肠经', 'Thủ Thái Dương Tiểu Trường kinh', 'Hand Taiyang Small Intestine channel'],
  BL: ['足太阳膀胱经', 'Túc Thái Dương Bàng Quang kinh', 'Foot Taiyang Bladder channel'], KI: ['足少阴肾经', 'Túc Thiếu Âm Thận kinh', 'Foot Shaoyin Kidney channel'],
  PC: ['手厥阴心包经', 'Thủ Quyết Âm Tâm Bào kinh', 'Hand Jueyin Pericardium channel'], TE: ['手少阳三焦经', 'Thủ Thiếu Dương Tam Tiêu kinh', 'Hand Shaoyang San Jiao channel'],
  GB: ['足少阳胆经', 'Túc Thiếu Dương Đởm kinh', 'Foot Shaoyang Gallbladder channel'], LR: ['足厥阴肝经', 'Túc Quyết Âm Can kinh', 'Foot Jueyin Liver channel'],
  CV: ['任脉', 'Nhâm mạch', 'Conception vessel'], GV: ['督脉', 'Đốc mạch', 'Governing vessel'] };
const PAIR = { LU: 'LI', LI: 'LU', ST: 'SP', SP: 'ST', HT: 'SI', SI: 'HT', BL: 'KI', KI: 'BL', PC: 'TE', TE: 'PC', GB: 'LR', LR: 'GB' };

function chan(tok) {
  tok = tok.trim();
  if (VESSEL[tok]) return VESSEL[tok];
  const m = tok.match(/^(手足|手|足)(三阴|三阳|太阴|阳明|少阴|太阳|厥阴|少阳)/);
  if (!m) return null;
  const rest = tok.slice(m[0].length).replace(/经$/, '');
  if (rest && ![...Object.keys(ORGAN)].includes(rest)) return null; // vd. 足太阴脾经 → rest='脾'
  const h = HAND[m[1]], y = YY[m[2]];
  return [`${h[0]} ${y[0]} kinh`, `${h[1]} ${y[1]} ${m[1] === '手足' || m[2].startsWith('三') ? 'channels' : 'channel'}`];
}
const joinVi = (a) => (a.length > 1 ? a.slice(0, -1).join(', ') + ' và ' + a[a.length - 1] : a[0]);
const joinEn = (a) => (a.length > 1 ? a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1] : a[0]);

// → { zh, vi, en } hoặc null
function detailOf(code, scope, acuId) {
  const pre = acuId.split('-')[0];
  const D = (zh, vi, en) => ({ zh, vi, en });
  if (code === 'CROSSING_POINT') {
    const body = scope.replace(/的?交会穴$/, '').replace('手、足', '手足');
    const toks = body.split(/[、与]/).filter(Boolean).map(chan);
    if (!toks.length || toks.some((x) => !x)) return null;
    return D(scope.replace(/的?交会穴$/, '') + '交会', 'Giao hội của ' + joinVi(toks.map((x) => x[0])), 'Crossing of ' + joinEn(toks.map((x) => x[1])));
  }
  if (code === 'HUI_MEETING_POINT') {
    const h = HUI[scope.replace(/八会穴[之（(]?/, '').replace(/[会）)]/g, '')];
    return h ? D(scope, h[0] + ' (trong Bát hội huyệt)', `Influential point of ${h[1]}`) : null;
  }
  if (code === 'EIGHT_CONFLUENT_POINT') {
    const v = Object.keys(VESSEL).find((k) => scope.includes(k));
    return v ? D(scope, `Thông với ${VESSEL[v][0]}`, `Opens to the ${VESSEL[v][1]}`) : null;
  }
  const organRe = (suffix) => { const m = scope.match(new RegExp(`^(.+?)之${suffix}$`)); return m && ORGAN[m[1]] ? ORGAN[m[1]] : null; };
  if (code === 'BACK_SHU_POINT') { const o = organRe('背俞穴'); return o ? D(scope, `Bối du huyệt của ${o[0]}`, `Back-shu point of the ${o[1]}`) : null; }
  if (code === 'FRONT_MU_POINT') { const o = organRe('募穴'); return o ? D(scope, `Mộ huyệt của ${o[0]}`, `Front-mu point of the ${o[1]}`) : null; }
  if (code === 'LOWER_HE_SEA_POINT') { const o = organRe('下合穴'); return o ? D(scope, `Hạ hợp huyệt của ${o[0]}`, `Lower he-sea point of the ${o[1]}`) : null; }
  if (code === 'XI_CLEFT_POINT') {
    const v = Object.keys(VESSEL).find((k) => scope.startsWith(k));
    if (v) return D(scope, `Khích huyệt của ${VESSEL[v][0]}`, `Xi-cleft point of the ${VESSEL[v][1]}`);
    return null; // "郄穴" thường: đã là khích huyệt của chính kinh này
  }
  if (code === 'YUAN_SOURCE_POINT' && scope === '肓之原穴') return D(scope, 'Nguyên huyệt của Hoang (肓)', 'Source point of the Huang (membrane)');
  if (code === 'LUO_CONNECTING_POINT') {
    if (scope === '脾之大络') return D(scope, 'Đại lạc của Tỳ', 'Great luo of the Spleen');
    if (PAIR[pre]) { const a = MER[pre], b = MER[PAIR[pre]]; return D(`${a[0]}别出联络${b[0]}`, `Từ ${a[1]} lạc sang ${b[1]}`, `Connects the ${a[2]} to the ${b[2]}`); }
    if (MER[pre]) return D(`${MER[pre][0]}之络穴`, `Lạc huyệt của ${MER[pre][1]}`, `Luo-connecting point of the ${MER[pre][2]}`);
  }
  return null;
}

const codes = Object.fromEntries((await readTab('ref_acupoint_class_codes')).map((c) => [c.class_code, c]));
const rows = (await readTab('kb_acupoint_class_map')).filter((r) => String(r.is_active).toUpperCase() === 'TRUE');
const byPoint = {};
const seen = new Set();
let withDetail = 0, skipped = [];
for (const r of rows) {
  const key = `${r.acupoint_id}|${r.class_code}|${r.scope}`;
  if (seen.has(key) || !codes[r.class_code]) continue;
  seen.add(key);
  const c = codes[r.class_code];
  const d = detailOf(r.class_code, r.scope, r.acupoint_id);
  if (d) withDetail++; else if (/交会|会穴|之|通/.test(r.scope)) skipped.push(`${r.acupoint_id} ${r.class_code} ${r.scope}`);
  (byPoint[r.acupoint_id] ||= []).push({ c: r.class_code, zh: c.label_zh, vi: c.label_vi, en: c.label_en, ...(d ? { d } : {}) });
}
// Cùng 1 huyệt có cả bản scope chung ("络穴") lẫn scope riêng → giữ 1 mục/loại (ưu tiên mục có chi tiết)
for (const [id, list] of Object.entries(byPoint)) {
  const best = new Map();
  for (const x of list) { const o = best.get(x.c); if (!o || (!o.d && x.d)) best.set(x.c, x); }
  // một huyệt có thể có nhiều mục cùng loại, scope khác nhau (vd. 2 bát hội) → gộp ở frontend nếu cần; ở đây giữ mỗi loại một mục
  byPoint[id] = [...best.values()];
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ byPoint }));
console.log(`✅ ${Object.keys(byPoint).length} huyệt · ${withDetail} mục có chi tiết → ${OUT}`);
if (skipped.length) console.log('⚠️  Không dịch được:', skipped.join(' | '));
