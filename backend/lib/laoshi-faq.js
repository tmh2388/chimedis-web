/**
 * laoshi-faq.js — KHO CÂU HỎI THƯỜNG GẶP của Lão Sư (MySQL).
 *  - Người dùng bấm 👍 một câu trả lời → vào hàng chờ (status 'pending').
 *  - Quản trị viên duyệt/sửa → 'approved'. Chỉ câu ĐÃ DUYỆT mới được dùng lại.
 *  - Câu hỏi tương tự (cùng chuẩn hoá hoặc độ trùng từ ≥ 0.85) → trả thẳng từ kho, KHÔNG gọi AI, không trừ ngân sách.
 */
import crypto from 'node:crypto';

const HAN = /[㐀-鿿]/;
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
/** Tập "từ" của câu hỏi: chữ Latin đã bỏ dấu + cặp chữ Hán liền kề. */
export function tokens(q) {
  const t = new Set();
  const s = String(q || '');
  for (const w of fold(s).split(/[^a-z0-9]+/)) if (w.length >= 2) t.add(w);
  const han = [...s].filter((c) => HAN.test(c)).join('');
  for (let i = 0; i + 1 < han.length; i++) t.add(han.slice(i, i + 2));
  return t;
}
export const normKey = (q) => [...tokens(q)].sort().join(' ');
export const hashOf = (lang, q) => crypto.createHash('sha1').update(`${lang}|${normKey(q)}`).digest('hex');
const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };

export async function ensureTable(pool) {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS laoshi_faq (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, lang CHAR(2) NOT NULL, q_hash CHAR(40) NOT NULL, question VARCHAR(400) NOT NULL, answer TEXT NOT NULL,
    status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending', ups INT NOT NULL DEFAULT 1, downs INT NOT NULL DEFAULT 0, uses INT NOT NULL DEFAULT 0,
    created_by VARCHAR(128) NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, reviewed_at DATETIME NULL, last_used DATETIME NULL,
    UNIQUE KEY uq_lang_q (lang, q_hash), KEY idx_status (status, ups)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

let bank = { at: 0, rows: [] };
async function loadBank(pool, force = false) {
  if (!force && Date.now() - bank.at < 5 * 60e3) return bank.rows;
  try {
    const [rows] = await pool.query("SELECT id, lang, q_hash, question, answer FROM laoshi_faq WHERE status = 'approved'");
    bank = { at: Date.now(), rows: rows.map((r) => ({ ...r, tok: tokens(r.question) })) };
  } catch (e) { console.error('[laoshi-faq] load:', e.message); }
  return bank.rows;
}
/** Tìm câu đã duyệt khớp câu hỏi. Chỉ dùng cho câu hỏi tự đầy đủ (≥ 6 ký tự có nghĩa). */
export async function lookup(pool, lang, question) {
  const q = String(question || '').trim();
  if (!pool || q.length < 6 || q.length > 300) return null;
  const tok = tokens(q);
  if (tok.size < 2) return null;
  const h = hashOf(lang, q);
  let best = null, bestScore = 0;
  for (const r of await loadBank(pool)) {
    if (r.lang !== lang) continue;
    if (r.q_hash === h) { best = r; bestScore = 1; break; }
    const sc = jaccard(tok, r.tok);
    if (sc >= 0.85 && sc > bestScore) { best = r; bestScore = sc; }
  }
  if (best) pool.query('UPDATE laoshi_faq SET uses = uses + 1, last_used = NOW() WHERE id = ?', [best.id]).catch(() => {});
  return best ? { id: best.id, answer: best.answer } : null;
}
/** 👍/👎 từ người dùng. 👍 → vào hàng chờ duyệt (nếu chưa có). */
export async function vote(pool, { uid, lang, question, answer, up }) {
  const q = String(question || '').trim().slice(0, 400), a = String(answer || '').trim().slice(0, 4000);
  if (!pool || q.length < 6 || a.length < 10 || tokens(q).size < 2) return false;
  const h = hashOf(lang, q);
  if (up) {
    await pool.query(
      `INSERT INTO laoshi_faq (lang, q_hash, question, answer, created_by) VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE ups = ups + 1`, [lang, h, q, a, uid]);
  } else {
    await pool.query('UPDATE laoshi_faq SET downs = downs + 1 WHERE lang = ? AND q_hash = ?', [lang, h]);
  }
  return true;
}
export async function list(pool, status = 'pending') {
  const [rows] = await pool.query('SELECT id, lang, question, answer, status, ups, downs, uses, created_at FROM laoshi_faq WHERE status = ? ORDER BY ups DESC, created_at DESC LIMIT 150', [status]);
  return rows;
}
export async function review(pool, id, { action, answer }) {
  const st = { approve: 'approved', reject: 'rejected', reset: 'pending' }[action];
  if (!st) return false;
  const sets = ['status = ?', 'reviewed_at = NOW()'], p = [st];
  if (typeof answer === 'string' && answer.trim()) { sets.push('answer = ?'); p.push(answer.trim().slice(0, 4000)); }
  const [r] = await pool.query(`UPDATE laoshi_faq SET ${sets.join(', ')} WHERE id = ?`, [...p, id]);
  await loadBank(pool, true);
  return r.affectedRows > 0;
}
