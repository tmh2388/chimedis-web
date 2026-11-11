/**
 * kb.js — KHO TRI THỨC Chimedis (giai đoạn 1): gom các câu hỏi–đáp ĐÃ DUYỆT của Lão Sư (laoshi_faq) thành mục tri thức có cấu trúc.
 *  Cây:  Module → Môn → Chương → Tiết  (bảng kb_nodes, mã `code` ổn định, 3 ngôn ngữ).
 *  Mục:  kb_entries — MỘT bản chuẩn / khái niệm, đủ Việt–Trung–Anh, trạng thái draft → review → approved (admin biên tập).
 *  Lọc trùng: khoá khái niệm (concept_key = các thuật ngữ Hán đã chuẩn hoá) — trùng khoá hoặc độ giống ≥ 0.8 thì GỘP nguồn vào mục sẵn có.
 *  AI chỉ SOẠN NHÁP (xếp vào cây, chuẩn hoá 3 ngôn ngữ); KHÔNG tự duyệt, người dùng chỉ thấy mục 'approved'.
 */
import { costFromUsage } from './ai-budget.js';

const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
const MODEL = process.env.KB_MODEL || 'gpt-5-mini';

// Khung ban đầu (admin có thể thêm/sửa qua API): module → môn.
export const SEED = [
  ['LL', 'Cơ sở lý luận', '基础理论', 'Foundations', [['LL.AD', 'Âm dương – Ngũ hành', '阴阳五行', 'Yin-yang & Five Phases'], ['LL.TP', 'Tạng phủ – Kinh lạc', '脏腑经络', 'Zang-fu & Meridians'], ['LL.KH', 'Khí – Huyết – Tân dịch', '气血津液', 'Qi, Blood & Fluids'], ['LL.BC', 'Bệnh nhân – Bệnh cơ', '病因病机', 'Etiology & Pathogenesis']]],
  ['CD', 'Chẩn đoán', '诊断学', 'Diagnosis', [['CD.TC', 'Tứ chẩn', '四诊', 'Four examinations'], ['CD.BC', 'Biện chứng', '辨证', 'Pattern differentiation']]],
  ['DD', 'Trung dược', '中药学', 'Materia medica', [['DD.GB', 'Giải biểu – Thanh nhiệt', '解表清热药', 'Exterior-releasing & Heat-clearing'], ['DD.BO', 'Bổ ích – Hoạt huyết', '补益活血药', 'Tonifying & Blood-invigorating'], ['DD.KH', 'Khác', '其他药物', 'Other herbs']]],
  ['PT', 'Phương tễ', '方剂学', 'Formulas', [['PT.GB', 'Giải biểu – Thanh nhiệt tễ', '解表清热剂', 'Exterior & Heat formulas'], ['PT.BO', 'Bổ ích – Lý huyết tễ', '补益理血剂', 'Tonifying & Blood formulas'], ['PT.KH', 'Khác', '其他方剂', 'Other formulas']]],
  ['CC', 'Châm cứu – Huyệt vị', '针灸腧穴', 'Acupuncture & Points', [['CC.HV', 'Huyệt vị', '腧穴', 'Acupoints'], ['CC.KT', 'Kỹ thuật châm cứu', '刺灸法', 'Techniques']]],
  ['NK', 'Bệnh chứng lâm sàng', '临床病证', 'Clinical conditions', [['NK.NK', 'Nội khoa', '内科', 'Internal medicine'], ['NK.PK', 'Phụ khoa – Nhi khoa', '妇儿科', 'Gynecology & Pediatrics'], ['NK.KH', 'Khác', '其他病证', 'Other conditions']]],
  ['TD', 'Thực dưỡng – Dưỡng sinh', '食疗养生', 'Diet & Wellness', [['TD.TD', 'Thực dưỡng', '食疗', 'Dietary therapy']]],
  ['NN', 'Ngoại ngữ y khoa', '医学语言', 'Medical language', [['NN.TN', 'Thuật ngữ', '术语', 'Terminology']]],
];

export async function ensureTables(pool) {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS kb_nodes (
    id INT AUTO_INCREMENT PRIMARY KEY, code VARCHAR(32) NOT NULL UNIQUE, parent_code VARCHAR(32) NULL, kind ENUM('module','subject','chapter','section') NOT NULL,
    title_vi VARCHAR(200) NOT NULL, title_zh VARCHAR(200) NULL, title_en VARCHAR(200) NULL, sort INT NOT NULL DEFAULT 0, KEY idx_parent (parent_code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kb_entries (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, node_code VARCHAR(32) NOT NULL, status ENUM('draft','review','approved','archived') NOT NULL DEFAULT 'draft',
    concept_key VARCHAR(400) NOT NULL, title_vi VARCHAR(300) NULL, title_zh VARCHAR(300) NULL, title_en VARCHAR(300) NULL,
    body_vi MEDIUMTEXT NULL, body_zh MEDIUMTEXT NULL, body_en MEDIUMTEXT NULL, term_ids TEXT NULL, source ENUM('laoshi','manual') NOT NULL DEFAULT 'laoshi',
    n_sources INT NOT NULL DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    reviewed_by VARCHAR(128) NULL, reviewed_at DATETIME NULL, KEY idx_node (node_code, status), KEY idx_status (status), KEY idx_key (concept_key(190))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kb_entry_sources (
    faq_id BIGINT NOT NULL PRIMARY KEY, entry_id BIGINT NOT NULL, merged TINYINT NOT NULL DEFAULT 0, KEY idx_entry (entry_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const [[c]] = await pool.query('SELECT COUNT(*) AS n FROM kb_nodes');
  if (!Number(c.n)) {
    let s = 0;
    for (const [code, vi, zh, en, subs] of SEED) {
      await pool.query("INSERT IGNORE INTO kb_nodes (code, parent_code, kind, title_vi, title_zh, title_en, sort) VALUES (?,NULL,'module',?,?,?,?)", [code, vi, zh, en, s++]);
      for (const [sc, sv, sz, se] of subs) await pool.query("INSERT IGNORE INTO kb_nodes (code, parent_code, kind, title_vi, title_zh, title_en, sort) VALUES (?,?,'subject',?,?,?,?)", [sc, code, sv, sz, se, s++]);
    }
  }
}

const HAN = /[㐀-鿿]/g;
/** Khoá khái niệm: tập chữ Hán (≥2 ký tự liền) đã sắp xếp, ví dụ "桂枝|麻黄". Rỗng nếu không có chữ Hán → dùng tiêu đề Việt đã bỏ dấu. */
export function conceptKey(zhTerms, fallbackVi = '') {
  const set = new Set((zhTerms || []).map((x) => (String(x).match(HAN) || []).join('')).filter((x) => x.length >= 2));
  if (set.size) return [...set].sort().join('|').slice(0, 380);
  return 'vi:' + String(fallbackVi).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 300);
}
export function similarity(a, b) {
  const A = new Set(String(a).split('|')), B = new Set(String(b).split('|'));
  if (!A.size || !B.size) return 0;
  let i = 0; for (const x of A) if (B.has(x)) i++;
  return i / (A.size + B.size - i);
}

async function organize(batch, nodes) {
  const codes = nodes.filter((n) => n.kind === 'subject').map((n) => `${n.code}=${n.title_vi}`).join('; ');
  const sys = 'Bạn là biên tập viên kho tri thức Trung y của Chimedis. Với MỖI cặp hỏi–đáp (do Lão Sư AI trả lời và đã được admin duyệt), hãy soạn NHÁP một mục tri thức: '
    + `(1) chọn node_code phù hợp nhất trong: ${codes}; (2) title_vi/title_zh/title_en: tên khái niệm chính, ngắn; (3) zh_terms: các thuật ngữ chính bằng chữ Hán giản thể (tối đa 6); `
    + '(4) body_vi/body_zh/body_en: nội dung chuẩn, gọn, đúng chuyên môn, ba ngôn ngữ ĐỒNG NGHĨA (dựa trên câu trả lời, KHÔNG thêm ý mới, KHÔNG bịa liều/quy kinh); danh từ chuyên môn kèm chữ Hán. '
    + 'Chỉ trả JSON {"items":[{"i":0,"node_code":"","title_vi":"","title_zh":"","title_en":"","zh_terms":[],"body_vi":"","body_zh":"","body_en":""}]}.';
  const user = JSON.stringify(batch.map((r, i) => ({ i, lang: r.lang, question: r.question, answer: String(r.answer).slice(0, 2500) })));
  const r = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], response_format: { type: 'json_object' }, max_completion_tokens: 12000, reasoning_effort: 'low' }),
  });
  if (!r.ok) throw Object.assign(new Error(`kb_ai_${r.status}`), { code: 'upstream' });
  const j = await r.json();
  let p = {}; try { p = JSON.parse(j.choices[0].message.content || '{}'); } catch (_) { /* bỏ qua */ }
  return { items: Array.isArray(p.items) ? p.items : [], costUsd: costFromUsage(MODEL, j.usage) };
}

/** Gom tối đa `limit` câu FAQ đã duyệt CHƯA vào kho tri thức. Trả { processed, created, merged, skipped, costUsd }. */
export async function ingestFromFaq(pool, limit = 10) {
  await ensureTables(pool);
  const [rows] = await pool.query(
    `SELECT f.id, f.lang, f.question, f.answer FROM laoshi_faq f LEFT JOIN kb_entry_sources s ON s.faq_id = f.id
      WHERE f.status = 'approved' AND s.faq_id IS NULL ORDER BY f.uses DESC, f.id ASC LIMIT ?`, [Math.min(20, Math.max(1, limit | 0))]);
  if (!rows.length) return { processed: 0, created: 0, merged: 0, skipped: 0, costUsd: 0 };
  const [nodes] = await pool.query('SELECT code, kind, title_vi FROM kb_nodes');
  const valid = new Set(nodes.map((n) => n.code));
  const { items, costUsd } = await organize(rows, nodes);
  let created = 0, merged = 0, skipped = 0;
  for (const it of items) {
    const row = rows[it.i]; if (!row) continue;
    const body_vi = String(it.body_vi || '').trim(), title_vi = String(it.title_vi || '').trim();
    if (!title_vi || !body_vi) { skipped++; continue; }
    const key = conceptKey(it.zh_terms, title_vi);
    const node = valid.has(it.node_code) ? it.node_code : 'NN.TN';
    const [cands] = await pool.query("SELECT id, concept_key FROM kb_entries WHERE status <> 'archived' AND node_code = ?", [node]);
    const hit = cands.find((c) => c.concept_key === key || similarity(c.concept_key, key) >= 0.8);
    if (hit) {
      await pool.query('UPDATE kb_entries SET n_sources = n_sources + 1 WHERE id = ?', [hit.id]);
      await pool.query('INSERT IGNORE INTO kb_entry_sources (faq_id, entry_id, merged) VALUES (?,?,1)', [row.id, hit.id]);
      merged++; continue;
    }
    const [ins] = await pool.query(
      "INSERT INTO kb_entries (node_code, status, concept_key, title_vi, title_zh, title_en, body_vi, body_zh, body_en, source) VALUES (?,'draft',?,?,?,?,?,?,?, 'laoshi')",
      [node, key, title_vi.slice(0, 300), String(it.title_zh || '').slice(0, 300) || null, String(it.title_en || '').slice(0, 300) || null, body_vi, String(it.body_zh || '') || null, String(it.body_en || '') || null]);
    await pool.query('INSERT IGNORE INTO kb_entry_sources (faq_id, entry_id, merged) VALUES (?,?,0)', [row.id, ins.insertId]);
    created++;
  }
  return { processed: rows.length, created, merged, skipped, costUsd };
}

export async function tree(pool) {
  await ensureTables(pool);
  const [nodes] = await pool.query('SELECT code, parent_code, kind, title_vi, title_zh, title_en, sort FROM kb_nodes ORDER BY sort');
  const [cnt] = await pool.query('SELECT node_code, status, COUNT(*) AS n FROM kb_entries GROUP BY node_code, status');
  const by = new Map(); for (const c of cnt) { const m = by.get(c.node_code) || {}; m[c.status] = Number(c.n); by.set(c.node_code, m); }
  return nodes.map((n) => ({ ...n, counts: by.get(n.code) || {} }));
}
export async function listEntries(pool, { status = 'draft', node = '' } = {}) {
  await ensureTables(pool);
  const w = ['status = ?'], p = [status]; if (node) { w.push('node_code = ?'); p.push(node); }
  const [rows] = await pool.query(`SELECT id, node_code, status, concept_key, title_vi, title_zh, title_en, body_vi, body_zh, body_en, n_sources, updated_at FROM kb_entries WHERE ${w.join(' AND ')} ORDER BY n_sources DESC, id DESC LIMIT 200`, p);
  return rows;
}
/** Admin biên tập: sửa trường, chuyển node, đổi trạng thái. Chỉ 'approved' mới hiện cho người dùng. */
export async function updateEntry(pool, admin, id, b) {
  const set = [], p = [];
  for (const k of ['title_vi', 'title_zh', 'title_en', 'body_vi', 'body_zh', 'body_en']) if (typeof b[k] === 'string') { set.push(`${k} = ?`); p.push(b[k].slice(0, k.startsWith('title') ? 300 : 20000)); }
  if (typeof b.node_code === 'string') { const [[n]] = await pool.query('SELECT 1 AS ok FROM kb_nodes WHERE code = ?', [b.node_code]); if (n) { set.push('node_code = ?'); p.push(b.node_code); } }
  if (['draft', 'review', 'approved', 'archived'].includes(b.status)) { set.push('status = ?', 'reviewed_by = ?', 'reviewed_at = NOW()'); p.push(b.status, String(admin.email || admin.uid || '').slice(0, 128)); }
  if (!set.length) return false;
  const [r] = await pool.query(`UPDATE kb_entries SET ${set.join(', ')} WHERE id = ?`, [...p, id]);
  return r.affectedRows > 0;
}
/** Người dùng: chỉ mục ĐÃ DUYỆT. */
export async function publicEntries(pool, node = '') {
  await ensureTables(pool);
  const w = ["status = 'approved'"], p = []; if (node) { w.push('node_code LIKE ?'); p.push(node.replace(/[%_]/g, '') + '%'); }
  const [rows] = await pool.query(`SELECT id, node_code, title_vi, title_zh, title_en, body_vi, body_zh, body_en FROM kb_entries WHERE ${w.join(' AND ')} ORDER BY node_code, id LIMIT 500`, p);
  return rows;
}

/** Cây cho người dùng: chỉ các nhánh có mục ĐÃ DUYỆT (kèm số mục). */
export async function publicTree(pool) {
  await ensureTables(pool);
  const [nodes] = await pool.query('SELECT code, parent_code, kind, title_vi, title_zh, title_en, sort FROM kb_nodes ORDER BY sort');
  const [cnt] = await pool.query("SELECT node_code, COUNT(*) AS n FROM kb_entries WHERE status = 'approved' GROUP BY node_code");
  const own = new Map(cnt.map((c) => [c.node_code, Number(c.n)]));
  const total = new Map(nodes.map((n) => [n.code, own.get(n.code) || 0]));
  for (const n of nodes) if (n.parent_code && own.get(n.code)) total.set(n.parent_code, (total.get(n.parent_code) || 0) + own.get(n.code));
  return nodes.filter((n) => total.get(n.code) > 0).map((n) => ({ ...n, count: total.get(n.code) }));
}
/** Gộp tay: chuyển nguồn của mục `fromId` sang `intoId`, cộng n_sources, lưu trữ mục cũ. */
export async function mergeEntries(pool, admin, fromId, intoId) {
  if (!fromId || !intoId || fromId === intoId) return false;
  const [[a]] = await pool.query('SELECT n_sources FROM kb_entries WHERE id = ?', [fromId]);
  const [[b]] = await pool.query('SELECT id FROM kb_entries WHERE id = ?', [intoId]);
  if (!a || !b) return false;
  await pool.query('UPDATE kb_entry_sources SET entry_id = ?, merged = 1 WHERE entry_id = ?', [intoId, fromId]);
  await pool.query('UPDATE kb_entries SET n_sources = n_sources + ? WHERE id = ?', [Number(a.n_sources) || 1, intoId]);
  await pool.query("UPDATE kb_entries SET status = 'archived', reviewed_by = ?, reviewed_at = NOW() WHERE id = ?", [String(admin.email || admin.uid || '').slice(0, 128), fromId]);
  return true;
}
/** Thêm/sửa nút Chương/Tiết (hoặc Môn mới) của cây. */
export async function upsertNode(pool, b) {
  const code = String(b.code || '').trim().toUpperCase().replace(/[^A-Z0-9.]/g, '').slice(0, 32);
  const parent = String(b.parent_code || '').trim().toUpperCase().replace(/[^A-Z0-9.]/g, '').slice(0, 32) || null;
  const title_vi = String(b.title_vi || '').trim().slice(0, 200);
  if (!code || !title_vi) return false;
  let kind = 'module';
  if (parent) { const [[p]] = await pool.query('SELECT kind FROM kb_nodes WHERE code = ?', [parent]); if (!p) return false; kind = { module: 'subject', subject: 'chapter', chapter: 'section' }[p.kind] || 'section'; }
  const [[mx]] = await pool.query('SELECT COALESCE(MAX(sort),0) AS m FROM kb_nodes');
  await pool.query(
    'INSERT INTO kb_nodes (code, parent_code, kind, title_vi, title_zh, title_en, sort) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE title_vi = VALUES(title_vi), title_zh = VALUES(title_zh), title_en = VALUES(title_en)',
    [code, parent, kind, title_vi, String(b.title_zh || '').slice(0, 200) || null, String(b.title_en || '').slice(0, 200) || null, Number(mx.m) + 1]);
  return true;
}
