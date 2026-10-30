/**
 * term-ipa.js — IPA (phiên âm) cho tên tiếng Anh của thuật ngữ, CHỈ ĐỂ HIỂN THỊ (không đọc thành tiếng).
 * Lưu riêng ở bảng `term_ipa` (term_id, en, ipa) — không ghi vào bảng nội dung kho; khớp theo đúng chuỗi `en` hiện tại,
 * nên khi admin đổi tên Anh thì IPA cũ tự ẩn cho tới khi được tạo lại. Từ ghép Y Khoa đã có `ipa` soạn tay thì giữ nguyên.
 */
import { costFromUsage } from './ai-budget.js';

const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
const MODEL = process.env.AI_IPA_MODEL || process.env.AI_LOOKUP_MODEL || 'gpt-5-mini';
const HAN = /[㐀-鿿]/;
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
export const eligible = (t) => !!t && !t.ipa && t.category !== 'word_element' && typeof t.en === 'string' && /[A-Za-z]/.test(t.en) && !HAN.test(t.en) && t.en.trim().length <= 80;

export async function ensureTable(pool) {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS term_ipa (
    term_id VARCHAR(64) NOT NULL PRIMARY KEY, en VARCHAR(190) NOT NULL, ipa VARCHAR(190) NOT NULL, source VARCHAR(8) NOT NULL DEFAULT 'ai',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

let cache = { at: 0, map: new Map() };
export async function getMap(pool) {
  if (!pool) return new Map();
  if (Date.now() - cache.at < 60e3) return cache.map;
  try {
    const [rows] = await pool.query('SELECT term_id, en, ipa FROM term_ipa');
    cache = { at: Date.now(), map: new Map(rows.map((r) => [String(r.term_id), { en: norm(r.en), ipa: r.ipa }])) };
  } catch (_) { /* chưa có bảng */ }
  return cache.map;
}
/** Gắn `ipa` vào các thuật ngữ (tại chỗ) khi chuỗi Anh còn khớp với lúc tạo IPA. */
export function attach(terms, map) {
  if (!map || !map.size) return terms;
  for (const t of terms) {
    if (t.ipa || t.category === 'word_element') continue;
    const m = map.get(String(t.id));
    if (m && m.en === norm(t.en)) t.ipa = m.ipa;
  }
  return terms;
}
export const missing = (terms, map) => terms.filter((t) => eligible(t) && !(map.get(String(t.id)) && map.get(String(t.id)).en === norm(t.en)));

const cleanIpa = (v) => {
  const s = String(v || '').trim().replace(/^\/+|\/+$/g, '').replace(/\s+/g, ' ');
  return s && s.length <= 190 && !HAN.test(s) && /[^\x00-\x7F]|[ˈˌ]/.test(s) ? s : ''; // phải có ký tự IPA thật, không phải chữ Latin trần
};

async function ask(items) {
  const sys = 'Bạn là chuyên gia ngữ âm. Với MỖI cụm tiếng Anh (thuật ngữ y khoa), viết phiên âm IPA kiểu General American (có dấu trọng âm ˈ ˌ), KHÔNG kèm dấu gạch chéo / /. '
    + 'Cụm nhiều từ: phiên âm cả cụm. Danh sách ngăn bởi dấu phẩy: phiên âm từng phần, cách nhau ", ". Viết tắt (vd. GSH): đọc từng chữ cái. '
    + 'Không chắc cách đọc thì để rỗng — KHÔNG bịa. Chỉ trả JSON.';
  const user = `Danh sách: ${JSON.stringify(items.map((x) => ({ id: x.id, en: x.en })))}\nTrả JSON {"items":[{"id":"<id>","ipa":"<IPA hoặc rỗng>"}]}`;
  const r = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], response_format: { type: 'json_object' }, max_completion_tokens: 6000, reasoning_effort: 'low' }),
  });
  if (!r.ok) throw new Error(`ipa_llm ${r.status}`);
  const j = await r.json();
  const p = JSON.parse(String(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '{}'));
  return { items: Array.isArray(p.items) ? p.items : [], costUsd: costFromUsage(MODEL, j.usage) };
}

/** Tạo IPA cho tối đa `limit` thuật ngữ còn thiếu (60/lượt gọi AI). terms: mảng thuật ngữ đang hiển thị. → { done, tried, remaining, costUsd } */
export async function generate(pool, terms, { limit = 180 } = {}) {
  const map = await getMap(pool);
  const todo = missing(terms, map);
  const pick = todo.slice(0, Math.max(1, Math.min(600, Number(limit) || 180)));
  let done = 0, cost = 0;
  for (let i = 0; i < pick.length; i += 60) {
    const batch = pick.slice(i, i + 60);
    let res;
    try { res = await ask(batch.map((t) => ({ id: String(t.id), en: t.en.trim() }))); } catch (e) { console.error('[term-ipa]', e.message); break; }
    cost += res.costUsd || 0;
    const byId = new Map(batch.map((t) => [String(t.id), t]));
    const vals = [];
    for (const it of res.items) {
      const t = byId.get(String(it.id)); const ipa = cleanIpa(it.ipa);
      if (t && ipa) vals.push([String(t.id), t.en.trim().slice(0, 190), ipa]);
    }
    if (vals.length) {
      await pool.query('INSERT INTO term_ipa (term_id, en, ipa) VALUES ? ON DUPLICATE KEY UPDATE en = VALUES(en), ipa = VALUES(ipa), source = \'ai\'', [vals]);
      done += vals.length;
    }
  }
  if (done) cache.at = 0;
  return { done, tried: pick.length, remaining: Math.max(0, todo.length - done), costUsd: cost };
}
