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
// ---- Tự lọc: KHÔNG dựa vào người dùng bấm. Mỗi cặp hỏi–đáp đi qua bộ lọc quy tắc; câu đạt được ghi nhận, và chỉ khi NHIỀU người
// KHÁC NHAU cùng hỏi (nhu cầu thật) mới lên hàng chờ / tự duyệt. Một người hỏi đi hỏi lại không làm tăng số lần.
const PENDING_ASKS = Number(process.env.FAQ_PENDING_ASKS) || 2;
const AUTO_ASKS = Number(process.env.FAQ_AUTO_ASKS) || 3;
const PERSONAL = /(tôi|em|mình|con tôi|mẹ tôi|bố tôi|ba tôi|chồng tôi|vợ tôi|bà tôi|ông tôi)\s+(đang\s+)?(bị|mắc|hay bị|có triệu chứng)|triệu chứng của (tôi|em|mình)|我(有|得了|最近|的.{0,6}(病|痛|症))|(my|our)\s+(mother|father|mom|dad|wife|husband|child|son|daughter|baby)|\bI\s+(have|am suffering|feel)\b/i;
const DOSE = /\d+\s*(mg|g\b|gam|ml|mcg|viên|lần\/ngày|lần mỗi ngày|克|毫升|片|粒|钱)/i;
const PII = /[\w.+-]+@[\w-]+\.[\w.]+|(?:\+?\d[\s().-]?){9,}/;
const UNSURE = /(không chắc|chưa chắc|không rõ|kiểm tra lại giáo trình|不确定|不太确定|没有把握|not sure|not certain|can't be sure|cannot be sure)/i;
const ERRORISH = /(卡壳|nghẹn chữ|hết lượt|khản cả giọng|lost their voice|choked)/i;
const FOLLOWUP = /^\s*(còn|vậy|thế|nó|cái đó|cái này|đó|và|nữa|tiếp|ý em|ý là|那|它|这个|那个|还有|然后|所以|and\b|what about|so\b|then\b|it\b|that\b|this\b)/i;
const ASKISH = /(\?|？|là gì|là sao|nào|sao|thế nào|như thế nào|gì|tại sao|vì sao|khác nhau|khác gì|quy kinh|tính vị|công dụng|tác dụng|cách dùng|nghĩa|什么|哪|为什么|怎么|如何|是否|吗|区别|作用|归经|what|which|how|why|difference|meaning|function)/i;

/** Có đáng đưa vào kho không? Trả { ok, grounded, why }. Thuần quy tắc, không gọi AI. */
export function qualifies({ question, answer, refs }) {
  const q = String(question || '').trim(), a = String(answer || '').trim();
  if (q.length < 8 || q.length > 200) return { ok: false, why: 'độ dài câu hỏi' };
  if (tokens(q).size < 3) return { ok: false, why: 'quá chung chung' };
  if (FOLLOWUP.test(q)) return { ok: false, why: 'câu hỏi nối tiếp' };
  if (!ASKISH.test(q)) return { ok: false, why: 'không phải câu hỏi tra cứu' };
  if (PERSONAL.test(q)) return { ok: false, why: 'chuyện cá nhân/sức khoẻ' };
  if (a.length < 40 || a.length > 1200) return { ok: false, why: 'độ dài câu trả lời' };
  if (DOSE.test(a) || DOSE.test(q)) return { ok: false, why: 'có liều lượng' };
  if (PII.test(q) || PII.test(a)) return { ok: false, why: 'có thông tin cá nhân' };
  if (UNSURE.test(a) || ERRORISH.test(a)) return { ok: false, why: 'trả lời không chắc/lỗi' };
  // "Nối đất": câu trả lời nhắc đúng thuật ngữ của mục kho đã dùng làm tham chiếu.
  const grounded = (refs || []).some((r) => (r.hz && a.includes(r.hz)) || (r.vi && a.toLowerCase().includes(String(r.vi).toLowerCase())));
  return { ok: true, grounded };
}

let schemaChecked = false;
async function ensureObserveSchema(pool) {
  if (schemaChecked) return;
  const [[col]] = await pool.query("SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'laoshi_faq' AND COLUMN_NAME = 'status'");
  if (col && !String(col.t).includes('observed')) await pool.query("ALTER TABLE laoshi_faq MODIFY COLUMN status ENUM('observed','pending','approved','rejected') NOT NULL DEFAULT 'observed'");
  const [cols] = await pool.query("SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'laoshi_faq'");
  const have = new Set(cols.map((c) => c.n));
  if (!have.has('asks')) await pool.query('ALTER TABLE laoshi_faq ADD COLUMN asks INT NOT NULL DEFAULT 0');
  if (!have.has('grounded')) await pool.query('ALTER TABLE laoshi_faq ADD COLUMN grounded TINYINT NOT NULL DEFAULT 0');
  if (!have.has('source')) await pool.query("ALTER TABLE laoshi_faq ADD COLUMN source VARCHAR(8) NOT NULL DEFAULT 'user'");
  await pool.query(`CREATE TABLE IF NOT EXISTS laoshi_faq_askers (
    lang CHAR(2) NOT NULL, q_hash CHAR(40) NOT NULL, firebase_uid VARCHAR(128) NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (lang, q_hash, firebase_uid)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  schemaChecked = true;
}

/**
 * Ghi nhận một cặp hỏi–đáp (gọi sau mỗi câu trả lời của AI, không chặn người dùng).
 *  asks = số NGƯỜI KHÁC NHAU đã hỏi câu tương tự;  ≥ PENDING_ASKS → hàng chờ duyệt;  ≥ AUTO_ASKS và có nối đất → tự duyệt (admin vẫn gỡ được).
 */
export async function observe(pool, { uid, lang, question, answer, refs }) {
  if (!pool || !uid) return { ok: false };
  const f = qualifies({ question, answer, refs });
  if (!f.ok) return { ok: false, why: f.why };
  await ensureObserveSchema(pool);
  const q = String(question).trim().slice(0, 400), a = String(answer).trim().slice(0, 4000);
  const h = hashOf(lang, q);
  await pool.query(
    "INSERT IGNORE INTO laoshi_faq (lang, q_hash, question, answer, status, ups, source, grounded) VALUES (?,?,?,?,'observed',0,'auto',?)",
    [lang, h, q, a, f.grounded ? 1 : 0]);
  await pool.query('INSERT IGNORE INTO laoshi_faq_askers (lang, q_hash, firebase_uid) VALUES (?,?,?)', [lang, h, uid]);
  const [[c]] = await pool.query('SELECT COUNT(*) AS n FROM laoshi_faq_askers WHERE lang = ? AND q_hash = ?', [lang, h]);
  const asks = Number(c.n);
  await pool.query('UPDATE laoshi_faq SET asks = ?, grounded = GREATEST(grounded, ?) WHERE lang = ? AND q_hash = ?', [asks, f.grounded ? 1 : 0, lang, h]);
  const [[row]] = await pool.query('SELECT status, grounded FROM laoshi_faq WHERE lang = ? AND q_hash = ?', [lang, h]);
  if (row && row.status === 'observed' && asks >= PENDING_ASKS) {
    await pool.query("UPDATE laoshi_faq SET status = 'pending' WHERE lang = ? AND q_hash = ? AND status = 'observed'", [lang, h]);
    row.status = 'pending';
  }
  if (row && row.status === 'pending' && asks >= AUTO_ASKS && Number(row.grounded) === 1) {
    await pool.query("UPDATE laoshi_faq SET status = 'approved', source = 'auto', reviewed_at = NOW() WHERE lang = ? AND q_hash = ? AND status = 'pending'", [lang, h]);
    await loadBank(pool, true);
  }
  return { ok: true, asks };
}
export async function list(pool, status = 'pending', autoOnly = false) {
  await ensureObserveSchema(pool).catch(() => {});
  const [rows] = await pool.query(
    `SELECT id, lang, question, answer, status, asks, grounded, source, uses, created_at FROM laoshi_faq
      WHERE status = ? ${autoOnly ? "AND source = 'auto'" : ''} ORDER BY asks DESC, created_at DESC LIMIT 150`, [status]);
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
