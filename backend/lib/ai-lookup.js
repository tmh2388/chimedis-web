/**
 * ai-lookup.js — TRA CỨU BẰNG AI cho một thuật ngữ mà kho không có, và TỰ HỌC (lưu lại để lần sau không cần AI).
 *
 * Luồng: (1) bộ nhớ đệm MySQL `ai_lookup` → có thì trả ngay, không tốn gì; (2) giới hạn lượt/ngày theo gói + trần toàn hệ thống;
 * (3) hỏi mô hình kèm QUY ƯỚC dịch Trung Y + các mục liên quan trong kho (nối đất, Hán-Việt); (4) lưu kết quả + nếu là thuật ngữ y
 * khoa thì đưa vào kho "Tổng hợp" (chưa duyệt) → lần sau tìm thấy ngay trong từ điển. Chi phí do HỆ THỐNG chịu (ghi vào sổ app=dict,
 * uid='system'), không trừ hạn mức cá nhân — đó là quyền lợi người dùng.
 */
import crypto from 'node:crypto';
import { pinyin } from 'pinyin';
import { styleBlock } from './tcm-style.js';
import { searchTerms, factsFor } from './csdl-lessons.js';
import { costFromUsage } from './ai-budget.js';
import { learnTermDirect } from './term-learn.js';

const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
const MODEL = process.env.AI_LOOKUP_MODEL || 'gpt-5-mini';
const GLOBAL_DAILY_CAP = Number(process.env.AI_LOOKUP_DAILY_CAP) || 400;
const PER_USER_DAILY = { free: 12, pro: 40, max: 100 };
const HAN = /[㐀-鿿]/g;

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
export function normKey(q) {
  const s = String(q || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if ((s.match(HAN) || []).length) return s.replace(/[^㐀-鿿]/g, '');
  return fold(s).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
/** Chỉ nhận cụm ngắn (thuật ngữ). Câu/đoạn dài dành cho "Hỏi Chimedis". */
export function isTermQuery(q) {
  const s = String(q || '').trim();
  const han = (s.match(HAN) || []).length;
  if (han) return han >= 1 && han <= 12 && s.length <= 20;
  return s.length >= 3 && s.split(/\s+/).length <= 6 && s.length <= 48;
}

export async function ensureTables(pool) {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_lookup (
    qkey VARCHAR(120) NOT NULL PRIMARY KEY, q_display VARCHAR(80) NOT NULL, is_medical TINYINT NOT NULL DEFAULT 1,
    hz VARCHAR(64) NULL, py VARCHAR(160) NULL, vi VARCHAR(190) NULL, en VARCHAR(190) NULL,
    def_vi TEXT NULL, def_zh TEXT NULL, def_en TEXT NULL, related_json TEXT NULL, confidence DECIMAL(3,2) NULL, note VARCHAR(255) NULL,
    term_id VARCHAR(64) NULL, hits INT NOT NULL DEFAULT 0, created_by VARCHAR(128) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, KEY idx_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_lookup_usage (
    firebase_uid VARCHAR(128) NOT NULL, day DATE NOT NULL, n INT NOT NULL DEFAULT 0, PRIMARY KEY (firebase_uid, day)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

function rowToData(r, source) {
  let related = []; try { related = JSON.parse(r.related_json || '[]'); } catch (_) { /* bỏ qua */ }
  return { q: r.q_display, is_medical: !!r.is_medical, hz: r.hz, py: r.py, vi: r.vi, en: r.en, def_vi: r.def_vi, def_zh: r.def_zh, def_en: r.def_en,
    related, confidence: r.confidence == null ? null : Number(r.confidence), note: r.note, term_id: r.term_id, source };
}

export async function getCached(pool, q) {
  const key = normKey(q); if (!key) return null;
  const [rows] = await pool.query('SELECT * FROM ai_lookup WHERE qkey = ?', [key]);
  if (!rows.length) return null;
  pool.query('UPDATE ai_lookup SET hits = hits + 1 WHERE qkey = ?', [key]).catch(() => {});
  return rowToData(rows[0], 'cache');
}

async function askModel(q, ctxText) {
  const sys = 'Bạn là biên tập viên từ điển Trung y – y khoa Việt/Trung/Anh của Chimedis. Người dùng tra một cụm mà kho chưa có. '
    + 'Hãy cho biết đó là gì: chữ Hán giản thể, pinyin, tên tiếng Việt (HÁN-VIỆT chuẩn nếu là thuật ngữ Trung y), tiếng Anh chuẩn, định nghĩa ngắn gọn (≤ 220 ký tự mỗi ngôn ngữ), '
    + 'và vài thuật ngữ liên quan. KHÔNG bịa: không chắc thì confidence thấp. Không phải thuật ngữ y khoa/Trung y/sinh lý/bệnh học thì is_medical=false. '
    + 'Không chẩn đoán/kê đơn. Chỉ trả JSON.\n\n' + ctxText;
  const user = `Cụm cần tra: "${q}"\nTrả JSON: {"is_medical":true|false,"hz":"<chữ Hán giản thể, 1-12 chữ>","py":"<pinyin có thanh>","vi":"<tên Việt>","en":"<tên Anh>",`
    + '"def_vi":"<định nghĩa Việt>","def_zh":"<定义>","def_en":"<English definition>","group":"ly_luan|chan_doan|benh_chung|thuoc|cham_cuu|giai_phau|nghien_cuu|khac",'
    + '"related":[{"hz":"","vi":"","en":""}],"confidence":0.0,"note":"<lưu ý ngắn nếu có nhiều nghĩa>"}';
  const r = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      response_format: { type: 'json_object' }, max_completion_tokens: 3500, reasoning_effort: 'low' }),
  });
  if (!r.ok) throw Object.assign(new Error(`lookup_llm ${r.status}`), { code: 'upstream' });
  const j = await r.json();
  const txt = String(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '');
  if (!txt.trim()) throw Object.assign(new Error('lookup_empty'), { code: 'upstream' });
  return { parsed: JSON.parse(txt), costUsd: costFromUsage(MODEL, j.usage) };
}

/**
 * @returns {Promise<{ok:true,data:object}|{ok:false,error:string,retryAfter?:number}>}
 */
export async function lookup(pool, { q, uid, plan = 'free', chargeSystem }) {
  const display = String(q || '').trim().slice(0, 60);
  const key = normKey(display);
  if (!key || !isTermQuery(display)) return { ok: false, error: 'not_a_term' };
  const cached = await getCached(pool, display);
  if (cached) return { ok: true, data: cached };

  const day = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  const lim = PER_USER_DAILY[plan] || PER_USER_DAILY.free;
  const [[u]] = await pool.query('SELECT COALESCE(SUM(n),0) AS n FROM ai_lookup_usage WHERE firebase_uid = ? AND day = ?', [uid, day]);
  if (Number(u.n) >= lim) return { ok: false, error: 'user_limit', limit: lim };
  const [[g]] = await pool.query("SELECT COUNT(*) AS n FROM ai_lookup WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)");
  if (Number(g.n) >= GLOBAL_DAILY_CAP) return { ok: false, error: 'global_limit' };
  await pool.query('INSERT INTO ai_lookup_usage (firebase_uid, day, n) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE n = n + 1', [uid, day]);

  // Nối đất: mục liên quan trong kho + bảng thuật ngữ bắt buộc của các chữ có mặt trong cụm
  const refs = searchTerms(display, 4);
  const refText = refs.length ? 'CÁC MỤC LIÊN QUAN TRONG KHO CHIMEDIS (dùng để đối chiếu Hán-Việt/Anh):\n' + refs.map((t) => factsFor(t, 2)).join('\n\n') : '';
  const ctx = [styleBlock([display], { max: 25 }), refText].filter(Boolean).join('\n\n');
  const { parsed, costUsd } = await askModel(display, ctx);
  if (chargeSystem && costUsd) chargeSystem(costUsd);

  const hz = String(parsed.hz || '').replace(/[^㐀-鿿]/g, '').slice(0, 24);
  const isMed = !!parsed.is_medical;
  let py = String(parsed.py || '').slice(0, 160);
  if (hz) { try { py = pinyin(hz, { style: 'tone' }).map((a) => a[0]).join(' '); } catch (_) { /* giữ bản của mô hình */ } }
  const conf = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
  const row = {
    q_display: display, is_medical: isMed ? 1 : 0, hz: hz || null, py: py || null,
    vi: String(parsed.vi || '').slice(0, 190) || null, en: String(parsed.en || '').slice(0, 190) || null,
    def_vi: String(parsed.def_vi || '').slice(0, 600) || null, def_zh: String(parsed.def_zh || '').slice(0, 600) || null, def_en: String(parsed.def_en || '').slice(0, 600) || null,
    related_json: JSON.stringify((Array.isArray(parsed.related) ? parsed.related : []).slice(0, 6).map((x) => ({ hz: String(x.hz || '').slice(0, 24), vi: String(x.vi || '').slice(0, 80), en: String(x.en || '').slice(0, 80) }))),
    confidence: conf, note: String(parsed.note || '').slice(0, 250) || null,
  };
  let termId = null;
  if (isMed && conf >= 0.6 && hz && row.vi && row.en) {
    try { const l = await learnTermDirect(pool, { ...row, group: parsed.group }, `tra cứu AI "${display}"`); termId = l ? l.termId : null; } catch (e) { console.error('[ai-lookup] learn:', e.message); }
  }
  await pool.query(
    `INSERT INTO ai_lookup (qkey, q_display, is_medical, hz, py, vi, en, def_vi, def_zh, def_en, related_json, confidence, note, term_id, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE hits = hits + 1`,
    [key, row.q_display, row.is_medical, row.hz, row.py, row.vi, row.en, row.def_vi, row.def_zh, row.def_en, row.related_json, row.confidence, row.note, termId, uid]);
  // Cùng một thuật ngữ có thể được tra bằng nhiều cách viết (vd. tiếng Việt và chữ Hán) → thêm khoá theo chữ Hán để lần sau trúng cache.
  if (hz && normKey(hz) !== key) {
    await pool.query(
      `INSERT IGNORE INTO ai_lookup (qkey, q_display, is_medical, hz, py, vi, en, def_vi, def_zh, def_en, related_json, confidence, note, term_id, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [normKey(hz), hz, row.is_medical, row.hz, row.py, row.vi, row.en, row.def_vi, row.def_zh, row.def_en, row.related_json, row.confidence, row.note, termId, uid]).catch(() => {});
  }
  return { ok: true, data: { ...rowToData({ ...row, term_id: termId }, 'ai'), term_id: termId } };
}
