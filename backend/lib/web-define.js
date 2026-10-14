/**
 * web-define.js — định nghĩa từ phổ thông từ NGUỒN MỞ trên mạng (Wiktionary), chạy phía máy chủ, không tốn credit/AI.
 * Dùng cho từ không liên quan y khoa mà kho Chimedis không có (vd. 报到). Chỉ hiển thị ở bản web (không hiện trong app); luôn ghi rõ nguồn.
 */
const UA = 'ChimedisDict/1.0 (+https://dict.chimedis.vn)';
const strip = (h) => String(h || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

export async function ensureTables(pool) {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS web_define_cache (
    qkey VARCHAR(120) NOT NULL PRIMARY KEY, json MEDIUMTEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

async function fetchWiktionary(host, term) {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(`https://${host}/api/rest_v1/page/definition/${encodeURIComponent(term)}`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
    if (!r.ok) return [];
    const j = await r.json();
    const out = [];
    for (const [lang, entries] of Object.entries(j)) {
      for (const e of entries || []) {
        const defs = (e.definitions || []).map((d) => strip(d.definition)).filter(Boolean).slice(0, 3);
        if (defs.length) out.push({ lang, language: e.language || lang, pos: e.partOfSpeech || '', defs });
      }
    }
    return out;
  } catch (_) { return []; } finally { clearTimeout(to); }
}

/** @returns {Promise<{q,source,url,entries:[{language,pos,defs[]}],cached:boolean}|null>} */
export async function define(pool, q) {
  const term = String(q || '').trim().slice(0, 40);
  if (!term) return null;
  const key = term.toLowerCase();
  if (pool) {
    try {
      const [rows] = await pool.query('SELECT json FROM web_define_cache WHERE qkey = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)', [key]);
      if (rows.length) return { ...JSON.parse(rows[0].json), cached: true };
    } catch (_) { /* chưa có bảng */ }
  }
  const han = /[㐀-鿿]/.test(term);
  const hosts = han ? ['en.wiktionary.org'] : ['vi.wiktionary.org', 'en.wiktionary.org'];
  let entries = [], host = hosts[0];
  for (const h of hosts) { entries = await fetchWiktionary(h, term); host = h; if (entries.length) break; }
  const hit = han ? entries.filter((e) => /chinese|mandarin|cantonese|trung/i.test(e.language)) : entries;
  const use = (hit.length ? hit : entries).slice(0, 3);
  const data = { q: term, source: 'Wiktionary', url: `https://${host}/wiki/${encodeURIComponent(term)}`, entries: use.map((e) => ({ language: e.language, pos: e.pos, defs: e.defs })) };
  if (pool && use.length) pool.query('INSERT INTO web_define_cache (qkey, json) VALUES (?, ?) ON DUPLICATE KEY UPDATE json = VALUES(json), created_at = NOW()', [key, JSON.stringify(data)]).catch(() => {});
  return { ...data, cached: false };
}
