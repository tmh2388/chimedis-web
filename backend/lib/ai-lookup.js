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
import { styleBlock, termByHz, relatedFromKho, crossGroupRefs } from './tcm-style.js';
import { searchTerms, factsFor, termById } from './csdl-lessons.js';
import { costFromUsage } from './ai-budget.js';
import { learnTermDirect } from './term-learn.js';
import { fixLangs, LOOKUP_SPECS } from './term-contract.js';

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
  // cột mới (bảng do dict sở hữu): loại truy vấn + nghĩa thông thường + ngữ cảnh Trung y
  try {
    const [cols] = await pool.query("SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_lookup'");
    const have = new Set(cols.map((c) => c.n));
    const add = [['kind', 'VARCHAR(24) NULL'], ['meaning_vi', 'TEXT NULL'], ['meaning_zh', 'TEXT NULL'], ['meaning_en', 'TEXT NULL'], ['tcm_context', 'TEXT NULL'], ['tcm_context_zh', 'TEXT NULL'], ['tcm_context_en', 'TEXT NULL'], ['ml', 'TINYINT NOT NULL DEFAULT 0']];
    for (const [c, def] of add) if (!have.has(c)) await pool.query(`ALTER TABLE ai_lookup ADD COLUMN ${c} ${def}`);
  } catch (e) { console.error('[ai-lookup] cột mới:', e.message); }
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_lookup_usage (
    firebase_uid VARCHAR(128) NOT NULL, day DATE NOT NULL, n INT NOT NULL DEFAULT 0, PRIMARY KEY (firebase_uid, day)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

function rowToData(r, source) {
  let related = []; try { related = JSON.parse(r.related_json || '[]'); } catch (_) { /* bỏ qua */ }
  return { q: r.q_display, kind: r.kind || (r.is_medical ? 'tcm_term' : 'general_word'), is_medical: !!r.is_medical, hz: r.hz, py: r.py, vi: r.vi, en: r.en,
    def_vi: r.def_vi, def_zh: r.def_zh, def_en: r.def_en, meaning_vi: r.meaning_vi, meaning_zh: r.meaning_zh, meaning_en: r.meaning_en, tcm_context: r.tcm_context, tcm_context_zh: r.tcm_context_zh, tcm_context_en: r.tcm_context_en, ml: Number(r.ml) === 1 ? 1 : 0,
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
    + 'Phân loại cụm đó (kind): "tcm_term" = thuật ngữ Trung y/y khoa/giải phẫu/bệnh học; "general_word" = từ phổ thông không thuộc y khoa; '
    + '"symptom_or_topic" = cách nói đời thường về triệu chứng/cảm giác/vấn đề (vd. 心疼, mất ngủ, đau đầu) mà người học muốn biết LIÊN QUAN gì trong Trung y. '
    + 'LUÔN cho nghĩa thông thường của cụm (meaning_*), không từ chối vì "không phải thuật ngữ". Nếu có liên hệ với Trung y, nêu ngắn trong tcm_context '
    + 'và liệt kê thuật ngữ liên quan (related) kèm loại: huyet (huyệt vị), benh (bệnh/chứng/pháp trị), phuong (phương/bài thuốc), duoc (vị thuốc), thucduong (món ăn/thực dưỡng/dưỡng sinh), khac. '
    + 'Khi nói về pháp trị/bệnh chứng, hãy ĐỦ các mặt: bài thuốc, vị thuốc, HUYỆT, và thực dưỡng/dưỡng sinh nếu có. '
    + 'Chỉ nêu những thuật ngữ BẠN CHẮC CHẮN có thật, ưu tiên đúng tên Hán chuẩn (giản thể). KHÔNG bịa; không chắc thì bỏ. '
    + 'Không chẩn đoán/kê đơn: chỉ là thông tin tra cứu học tập. BẮT BUỘC điền ĐỦ cả ba ngôn ngữ cho mọi trường *_vi, *_zh, *_en (không để trống): *_vi viết BẰNG TIẾNG VIỆT, *_zh bằng tiếng Trung giản thể, *_en bằng tiếng Anh; tên tiếng Anh KHÔNG kèm pinyin hay chữ Hán. Chỉ trả JSON.\n\n' + ctxText;
  const user = `Cụm cần tra: "${q}"\nTrả JSON: {"kind":"tcm_term|general_word|symptom_or_topic","hz":"<chữ Hán giản thể của cụm hoặc tương đương, 1-12 chữ, nếu có>","py":"","vi":"<tên/nghĩa ngắn tiếng Việt (Hán-Việt nếu là thuật ngữ Trung y)>","en":"<English>",`
    + '"meaning_vi":"<nghĩa thông thường ≤ 200 ký tự>","meaning_zh":"<cùng nội dung bằng tiếng Trung giản thể>","meaning_en":"<same in English>",'
    + '"tcm_context":"<liên hệ Trung y bằng tiếng Việt ≤ 260 ký tự, hoặc rỗng>","tcm_context_zh":"<cùng nội dung bằng tiếng Trung giản thể>","tcm_context_en":"<same in English>",'
    + '"def_vi":"<định nghĩa thuật ngữ nếu kind=tcm_term>","def_zh":"<tiếng Trung giản thể>","def_en":"<English>",'
    + '"group":"ly_luan|chan_doan|benh_chung|thuoc|cham_cuu|giai_phau|nghien_cuu|khac",'
    + '"related":[{"hz":"","vi":"","en":"","type":"huyet|benh|phuong|duoc|thucduong|khac"}],"confidence":0.0,"note":"<lưu ý ngắn nếu nhiều nghĩa>"}';
  const r = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      response_format: { type: 'json_object' }, max_completion_tokens: 4000, reasoning_effort: 'low' }),
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
  if (cached && cached.ml === 1) return { ok: true, data: cached };
  // bản cũ chỉ có tiếng Việt (ml=0): tra lại một lần để bổ sung đủ Việt/Trung/Anh rồi ghi đè

  const day = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  const lim = PER_USER_DAILY[plan] || PER_USER_DAILY.free;
  const [[u]] = await pool.query('SELECT COALESCE(SUM(n),0) AS n FROM ai_lookup_usage WHERE firebase_uid = ? AND day = ?', [uid, day]);
  if (Number(u.n) >= lim) return { ok: false, error: 'user_limit', limit: lim };
  const [[g]] = await pool.query("SELECT COUNT(*) AS n FROM ai_lookup WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)");
  if (Number(g.n) >= GLOBAL_DAILY_CAP) return { ok: false, error: 'global_limit' };
  await pool.query('INSERT INTO ai_lookup_usage (firebase_uid, day, n) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE n = n + 1', [uid, day]);

  // Nối đất: mục liên quan trong kho + bảng thuật ngữ bắt buộc của các chữ có mặt trong cụm
  const refs = [...searchTerms(display, 3), ...crossGroupRefs(display, 2)].filter((t, i, a) => a.findIndex((x) => x.id === t.id) === i).slice(0, 8);
  const refText = refs.length ? 'CÁC MỤC LIÊN QUAN TRONG KHO CHIMEDIS (dùng để đối chiếu Hán-Việt/Anh):\n' + refs.map((t) => factsFor(t, 2)).join('\n\n') : '';
  const ctx = [styleBlock([display], { max: 25 }), refText].filter(Boolean).join('\n\n');
  const { parsed, costUsd } = await askModel(display, ctx);
  if (chargeSystem && costUsd) chargeSystem(costUsd);

  const kind = ['tcm_term', 'general_word', 'symptom_or_topic'].includes(parsed.kind) ? parsed.kind : (parsed.is_medical ? 'tcm_term' : 'general_word');
  const isMed = kind === 'tcm_term';
  const hz = String(parsed.hz || '').replace(/[^㐀-鿿]/g, '').slice(0, 24);
  let py = String(parsed.py || '').slice(0, 160);
  if (hz) { try { py = pinyin(hz, { style: 'tone' }).map((a) => a[0]).join(' '); } catch (_) { /* giữ bản của mô hình */ } }
  const conf = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
  // Thuật ngữ liên quan: đối chiếu với KHO — mục có trong kho dùng tên chuẩn của kho và dẫn tới mục đó; mục chưa có chỉ là gợi ý của AI.
  const related = (Array.isArray(parsed.related) ? parsed.related : []).slice(0, 8).map((x) => {
    const rhz = String(x.hz || '').replace(/[^㐀-鿿]/g, '').slice(0, 24);
    const hit = rhz ? termByHz(rhz) : null;
    return { hz: rhz, vi: String((hit && hit.vi) || x.vi || '').slice(0, 80), en: String((hit && hit.en) || x.en || '').slice(0, 80),
      type: ['huyet', 'benh', 'phuong', 'duoc', 'thucduong', 'khac'].includes(x.type) ? x.type : 'khac', term_id: hit ? hit.id : null, in_kho: !!hit };
  }).filter((x) => x.hz);
  // Làm giàu bằng CHÍNH nội dung kho: các mục kho liên quan (huyệt/dược/bệnh) được nhắc trong định nghĩa của những mục đã khớp.
  try {
    const seeds = [...related.filter((x) => x.term_id).map((x) => termById(String(x.term_id).replace(/^db-/, ''))), ...refs].filter(Boolean);
    const dedupSeeds = seeds.filter((t, i, a) => a.findIndex((x) => x.id === t.id) === i).slice(0, 6);
    if (dedupSeeds.length) {
      const mined = relatedFromKho(dedupSeeds, { perType: 3 });
      const have = new Set(related.map((x) => x.hz));
      for (const [ty, arr] of Object.entries(mined)) for (const m of arr) {
        if (!m.hz || have.has(m.hz) || related.length >= 14) continue;
        have.add(m.hz);
        related.push({ hz: m.hz, vi: String(m.vi || '').slice(0, 80), en: String(m.en || '').slice(0, 80), type: ty, term_id: m.id, in_kho: true, from: 'kho' });
      }
    }
  } catch (e) { console.error('[ai-lookup] mined:', e.message); }
  const row = {
    q_display: display, is_medical: isMed ? 1 : 0, kind, hz: hz || null, py: py || null,
    vi: String(parsed.vi || '').slice(0, 190) || null, en: String(parsed.en || '').slice(0, 190) || null,
    def_vi: String(parsed.def_vi || '').slice(0, 600) || null, def_zh: String(parsed.def_zh || '').slice(0, 600) || null, def_en: String(parsed.def_en || '').slice(0, 600) || null,
    meaning_vi: String(parsed.meaning_vi || '').slice(0, 600) || null, meaning_zh: String(parsed.meaning_zh || '').slice(0, 600) || null, meaning_en: String(parsed.meaning_en || '').slice(0, 600) || null,
    tcm_context: String(parsed.tcm_context || '').slice(0, 800) || null, tcm_context_zh: String(parsed.tcm_context_zh || '').slice(0, 800) || null, tcm_context_en: String(parsed.tcm_context_en || '').slice(0, 800) || null,
    related_json: JSON.stringify(related), confidence: conf, note: String(parsed.note || '').slice(0, 250) || null,
  };
  // HỢP ĐỒNG THUẬT NGỮ: mỗi ô đúng ngôn ngữ, đủ Việt/Trung/Anh (ô đặt nhầm được xếp lại, thiếu thì dịch một lần, sai không cứu được thì bỏ)
  try {
    const fx = await fixLangs(row, LOOKUP_SPECS, { hint: { hz } });
    Object.assign(row, fx.rec);
    if (chargeSystem && fx.costUsd) chargeSystem(fx.costUsd);
    if (fx.incomplete.length) console.log('[ai-lookup] ô còn thiếu sau khi sửa:', fx.incomplete.join(','), 'cho', display);
  } catch (e) { console.error('[ai-lookup] contract:', e.message); }
  let termId = (cached && cached.term_id) || null;
  if (!termId && isMed && conf >= 0.6 && hz && row.vi && row.en) {
    try { const l = await learnTermDirect(pool, { ...row, group: parsed.group }, `tra cứu AI "${display}"`); termId = l ? l.termId : null; if (l && l.costUsd && chargeSystem) chargeSystem(l.costUsd); } catch (e) { console.error('[ai-lookup] learn:', e.message); }
  }
  const cols = '(qkey, q_display, is_medical, kind, hz, py, vi, en, def_vi, def_zh, def_en, meaning_vi, meaning_zh, meaning_en, tcm_context, related_json, confidence, note, term_id, created_by, tcm_context_zh, tcm_context_en, ml)';
  const vals = (k, d) => [k, d, row.is_medical, row.kind, row.hz, row.py, row.vi, row.en, row.def_vi, row.def_zh, row.def_en, row.meaning_vi, row.meaning_zh, row.meaning_en, row.tcm_context, row.related_json, row.confidence, row.note, termId, uid, row.tcm_context_zh, row.tcm_context_en, 1];
  await pool.query(`INSERT INTO ai_lookup ${cols} VALUES (${new Array(23).fill('?').join(',')}) ON DUPLICATE KEY UPDATE hits = hits + 1, def_vi = VALUES(def_vi), def_zh = VALUES(def_zh), def_en = VALUES(def_en), meaning_vi = VALUES(meaning_vi), meaning_zh = VALUES(meaning_zh), meaning_en = VALUES(meaning_en), tcm_context = VALUES(tcm_context), tcm_context_zh = VALUES(tcm_context_zh), tcm_context_en = VALUES(tcm_context_en), ml = 1`, vals(key, row.q_display));
  // Cùng một thuật ngữ có thể được tra bằng nhiều cách viết → thêm khoá theo chữ Hán để lần sau trúng cache.
  if (hz && normKey(hz) !== key) {
    await pool.query(`INSERT IGNORE INTO ai_lookup ${cols} VALUES (${new Array(23).fill('?').join(',')})`, vals(normKey(hz), hz)).catch(() => {});
  }
  return { ok: true, data: { ...rowToData({ ...row, term_id: termId }, 'ai'), term_id: termId } };
}
