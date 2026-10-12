/**
 * quick-score.js — "CHẤM NHANH" (tầng 1): chấm lời nói bằng THUẬT TOÁN, không dùng mô hình ngôn ngữ lớn.
 *
 * Đầu vào là văn bản người dùng vừa nói (do nhận dạng giọng nói của trình duyệt hoặc dịch vụ phiên âm rẻ trả về) so với câu mẫu.
 *  - Tiếng Trung: căn từng chữ giữa câu mẫu và bản nhận dạng bằng quy hoạch động; chữ khác nhau được chia mức theo pinyin
 *    (đồng âm cùng thanh / cùng âm khác thanh = lỗi thanh điệu / khác hẳn / bỏ sót).
 *  - Tiếng Việt/Anh (dịch): độ phủ từ theo LCS khi không có key_units (khi có thì dùng interpret-check đã sẵn).
 * Giới hạn (nói rõ với người dùng): nhận dạng giọng nói có xu hướng "tự sửa" về từ phổ biến nên che bớt lỗi, và không nghe
 * được ngữ điệu — phần đó thuộc "Phân tích sâu bằng AI".
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinyin } from 'pinyin';

const here = path.dirname(fileURLToPath(import.meta.url));
let t2s = null;
function loadT2S() {
  if (t2s) return t2s;
  t2s = new Map();
  try {
    const raw = fs.readFileSync(path.join(here, '..', 'data', 'han-t2s.txt'), 'utf8');
    for (const pair of raw.split('|')) {
      const [a, b] = pair.trim().split(/\s+/);
      if (a && b && [...a].length === 1) t2s.set(a, b);
    }
  } catch (_) { /* không có bảng: bỏ qua, vẫn chấm được */ }
  return t2s;
}

const HAN = /[㐀-鿿]/;
/** Chuẩn hoá: về giản thể, bỏ dấu câu/khoảng trắng; chỉ giữ chữ Hán, chữ số, chữ Latin. */
export function normalizeZh(s) {
  const m = loadT2S();
  return [...String(s || '').normalize('NFKC')].map((c) => m.get(c) || c).filter((c) => HAN.test(c) || /[A-Za-z0-9]/.test(c)).join('');
}

function syllables(str) {
  // Mỗi chữ → { base, tone } từ pinyin (tone2: số thanh ngay sau nguyên âm).
  const chars = [...str];
  const py = pinyin(str, { style: 'tone2', heteronym: false });
  return chars.map((c, i) => {
    if (!HAN.test(c)) return { c, base: c.toLowerCase(), tone: 0 };
    const p = String((py[i] && py[i][0]) || '');
    const m = p.match(/^(.*?)(\d)(.*)$/);
    if (m) return { c, base: (m[1] + m[3]).toLowerCase(), tone: Number(m[2]) };
    return { c, base: p.toLowerCase(), tone: 5 }; // thanh nhẹ
  });
}

/** Chi phí thay thế giữa hai chữ (0 = giống hệt). */
function subCost(a, b) {
  if (a.c === b.c) return { cost: 0, kind: 'ok' };
  if (HAN.test(a.c) && HAN.test(b.c) && a.base && a.base === b.base) {
    if (a.tone === b.tone) return { cost: 0.2, kind: 'homophone' };
    return { cost: 0.5, kind: 'tone' };
  }
  return { cost: 1, kind: 'wrong' };
}

/**
 * @returns {{score:number, level:'good'|'fair'|'poor', chars:Array<{c:string,status:string,heard?:string}>, extra:string[],
 *   counts:object, heard:string, heard_pinyin:string, ref_pinyin:string}}
 */
export function scoreChinese(reference, transcript) {
  const ref = normalizeZh(reference), hyp = normalizeZh(transcript);
  const R = syllables(ref), H = syllables(hyp);
  const n = R.length, m = H.length;
  const D = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const B = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1)); // 1 = chéo, 2 = bỏ sót (xoá ref), 3 = thừa (chèn hyp)
  for (let i = 1; i <= n; i++) { D[i][0] = i; B[i][0] = 2; }
  for (let j = 1; j <= m; j++) { D[0][j] = j; B[0][j] = 3; }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = D[i - 1][j - 1] + subCost(R[i - 1], H[j - 1]).cost;
      const del = D[i - 1][j] + 1, ins = D[i][j - 1] + 1;
      if (diag <= del && diag <= ins) { D[i][j] = diag; B[i][j] = 1; }
      else if (del <= ins) { D[i][j] = del; B[i][j] = 2; }
      else { D[i][j] = ins; B[i][j] = 3; }
    }
  }
  const chars = new Array(n), extra = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const b = B[i][j];
    if (i > 0 && j > 0 && b === 1) {
      const s = subCost(R[i - 1], H[j - 1]);
      chars[i - 1] = { c: R[i - 1].c, status: s.kind, ...(s.kind === 'ok' ? {} : { heard: H[j - 1].c }) };
      i--; j--;
    } else if (i > 0 && (j === 0 || b === 2)) { chars[i - 1] = { c: R[i - 1].c, status: 'missed' }; i--; }
    else { extra.unshift(H[j - 1].c); j--; }
  }
  const counts = { ok: 0, homophone: 0, tone: 0, wrong: 0, missed: 0, extra: extra.length };
  for (const c of chars) counts[c.status]++;
  const dist = D[n][m];
  const score = n ? Math.max(0, Math.round(100 * (1 - dist / Math.max(n, m)))) : 0;
  return {
    score, level: score >= 85 ? 'good' : score >= 60 ? 'fair' : 'poor', chars, extra, counts,
    heard: hyp, heard_pinyin: H.map((x) => (HAN.test(x.c) ? x.base + (x.tone && x.tone !== 5 ? x.tone : '') : x.c)).join(' '),
    ref_pinyin: R.map((x) => (HAN.test(x.c) ? x.base + (x.tone && x.tone !== 5 ? x.tone : '') : x.c)).join(' '),
  };
}

// ---- Tiếng Việt / Anh: độ phủ từ (LCS) ----
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
const words = (s) => fold(s).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

export function scoreWords(reference, transcript) {
  const R = words(reference), H = words(transcript);
  const n = R.length, m = H.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) L[i][j] = R[i - 1] === H[j - 1] ? L[i - 1][j - 1] + 1 : Math.max(L[i - 1][j], L[i][j - 1]);
  const hit = new Array(n).fill(false);
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (R[i - 1] === H[j - 1]) { hit[i - 1] = true; i--; j--; }
    else if (L[i - 1][j] >= L[i][j - 1]) i--; else j--;
  }
  const lcs = L[n][m];
  const score = n + m ? Math.round(100 * (2 * lcs) / (n + m)) : 0;
  // Hiển thị theo từ gốc của câu mẫu (còn dấu) để người học dễ đối chiếu.
  const display = String(reference || '').trim().split(/\s+/).filter(Boolean);
  const refTokens = display.length === n ? display : R;
  return {
    score, level: score >= 80 ? 'good' : score >= 55 ? 'fair' : 'poor',
    words: R.map((w, k) => ({ w: refTokens[k], status: hit[k] ? 'ok' : 'missed' })),
    counts: { ok: hit.filter(Boolean).length, missed: hit.filter((x) => !x).length, total: n }, heard: String(transcript || '').trim(),
  };
}

// ===== Giới hạn dùng công bằng cho nhánh phiên âm phía máy chủ (nhánh trình duyệt không tốn chi phí nên không giới hạn) =====
export async function ensureUsageTable(pool) {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS quick_usage (
    firebase_uid VARCHAR(128) NOT NULL, day DATE NOT NULL, n INT NOT NULL DEFAULT 0, PRIMARY KEY (firebase_uid, day)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}
export async function consumeServerAsr(pool, uid, limit) {
  const day = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  await pool.query('INSERT INTO quick_usage (firebase_uid, day, n) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE n = n + 1', [uid, day]);
  const [[row]] = await pool.query('SELECT n FROM quick_usage WHERE firebase_uid = ? AND day = ?', [uid, day]);
  return { ok: row.n <= limit, used: row.n, limit };
}
