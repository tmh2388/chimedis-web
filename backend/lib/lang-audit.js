/**
 * lang-audit.js — RÀ SOÁT NGÔN NGỮ tự chủ động: quét kho tìm ô thiếu/quá ngắn/trùng ngôn ngữ khác → AI dịch đề xuất → HÀNG CHỜ → admin duyệt (áp dụng qua editTerm).
 * Không bao giờ tự ghi vào kho. Bảng `term_lang_queue` (term_id, field_key, lang_target) duy nhất; trạng thái: todo (chưa dịch) → pending (đã có bản đề xuất, chờ duyệt) → applied | dismissed.
 */
import { translateItems } from './term-ai-fill.js';
import { editTerm } from './term-learn.js';
import { detectLang, cleanEnName } from './term-contract.js';

const LANGS = ['vi', 'zh', 'en'];
const VITRI_GROUPS = new Set(['Tổng hợp', 'Bệnh lý', 'Giải phẫu', 'Sinh lý']); // Dược liệu/Huyệt có `vitri` cũ trùng trường khác → bỏ qua
const sfx3 = (base) => ({ vi: `${base}_vi`, zh: `${base}_zh`, en: `${base}_en` });
const CN3 = (base) => ({ vi: base, zh: `${base}_cn`, en: `${base}_en` });
/** Các trường nội dung ba ngôn ngữ cần rà (khoá cột theo từng ngôn ngữ). */
export const FIELD_DEFS = [
  { key: 'vitri', cols: CN3('vitri'), groups: VITRI_GROUPS },
  { key: 'congnang', cols: CN3('congnang') }, { key: 'tcm', cols: CN3('tcm') }, { key: 'lamsang', cols: CN3('lamsang') },
  ...['action', 'indication', 'dose_text', 'caution', 'location', 'anatomy'].map((b) => ({ key: b, cols: sfx3(b) })),
  ...['functions', 'indications', 'cautions', 'analysis'].map((b) => ({ key: b, cols: sfx3(b) })),
  { key: 'meaning', cols: { vi: 'meaning', en: 'meaning_en' }, langs: ['vi', 'en'] }, // Từ ghép Y Khoa: không có nghĩa tiếng Trung theo thiết kế
];
const str = (v) => String(v == null ? '' : v).trim();
const HAN = /[㐀-鿿]/;

export async function ensureTable(pool) {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS term_lang_queue (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, term_id VARCHAR(64) NOT NULL, hz VARCHAR(64) NULL, vi_name VARCHAR(190) NULL, group1 VARCHAR(48) NULL,
    field_key VARCHAR(40) NOT NULL, lang_target CHAR(2) NOT NULL, source_lang CHAR(2) NOT NULL, source_text TEXT NOT NULL, current_text TEXT NULL,
    reason VARCHAR(16) NOT NULL, proposed_text TEXT NULL, status VARCHAR(12) NOT NULL DEFAULT 'todo',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, proposed_at DATETIME NULL, handled_at DATETIME NULL,
    UNIQUE KEY uq_item (term_id, field_key, lang_target), KEY idx_status (status, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

/** Tìm các ô cần bổ sung. terms: mảng thuật ngữ ĐÃ áp dụng ghi đè (đúng như người dùng thấy). Trả mảng item (chưa có bản dịch). */
export function findGaps(terms) {
  const out = [];
  for (const t of terms) {
    const base = { term_id: String(t.id), hz: t.hz || '', vi_name: t.vi || '', group1: t.group1 || '' };
    for (const def of FIELD_DEFS) {
      if (def.groups && !def.groups.has(t.group1)) continue;
      if (def.key === 'meaning' && t.category !== 'word_element') continue;
      if (def.key !== 'meaning' && t.category === 'word_element') continue;
      const langs = def.langs || LANGS;
      // Xếp lại theo ngôn ngữ THỰC của chữ (vd. định nghĩa tiếng Trung nằm nhầm ô tiếng Việt)
      const raw = {}; langs.forEach((l) => { raw[l] = str(t[def.cols[l]]); });
      const val = {}; const moved = [];
      for (const l of langs) {
        if (!raw[l]) continue;
        const real = detectLang(raw[l], l);
        if (real !== l && langs.includes(real) && !raw[real]) { val[real] = raw[l]; moved.push({ from: l, to: real, text: raw[l] }); }
        else val[l] = raw[l];
      }
      const have = langs.filter((l) => val[l]);
      if (!have.length) continue;
      const src = have[0]; const srcText = val[src]; if (srcText.length > 800) continue;
      for (const m of moved) if (m.text.length <= 800) // nội dung đúng nhưng nằm sai ô: đề xuất đặt vào đúng ô (không cần AI)
        out.push({ ...base, field_key: def.key, lang_target: m.to, source_lang: m.to, source_text: m.text, current_text: raw[m.to] || null, reason: 'misplaced' });
      for (const l of langs) {
        if (l === src) continue;
        let reason = null;
        if (!val[l]) reason = raw[l] ? 'wrong_lang' : 'missing';
        else if (src === 'vi' && l === 'en' && srcText.length > 60 && val.en.length < srcText.length * 0.3) reason = 'short';
        else if (src === 'vi' && l === 'zh' && srcText.length > 80 && val.zh.length < srcText.length * 0.12) reason = 'short';
        else if (l === 'zh' && val.zh && !HAN.test(val.zh)) reason = 'wrong_lang';
        if (reason) out.push({ ...base, field_key: def.key, lang_target: l, source_lang: src, source_text: srcText.slice(0, 800), current_text: raw[l] || null, reason });
      }
    }
    // Tên tiếng Anh trùng nguyên văn tên Việt (chưa dịch?) — bỏ qua viết tắt ngắn
    const vn = str(t.vi), en = str(t.en);
    if (en && cleanEnName(en) && cleanEnName(en) !== en) // tên Anh kèm pinyin/chữ Hán trong ngoặc → đề xuất bản đã bỏ (không cần AI)
      out.push({ ...base, field_key: 'name', lang_target: 'en', source_lang: 'vi', source_text: `${t.hz || ''} · ${vn}`.slice(0, 300), current_text: en, reason: 'pinyin_in_en' });
    else if (en && vn && en.toLowerCase() === vn.toLowerCase() && vn.length > 8 && /[^\x00-\x7F]/.test(vn) && t.hz)
      out.push({ ...base, field_key: 'name', lang_target: 'en', source_lang: 'vi', source_text: `${t.hz} · ${vn}`.slice(0, 300), current_text: en, reason: 'same_as_vi' });
  }
  return out;
}

export async function scan(pool, terms) {
  const gaps = findGaps(terms); let added = 0;
  for (let i = 0; i < gaps.length; i += 200) {
    const chunk = gaps.slice(i, i + 200);
    const vals = chunk.map((g) => [g.term_id, g.hz.slice(0, 64), g.vi_name.slice(0, 190), g.group1.slice(0, 48), g.field_key, g.lang_target, g.source_lang, g.source_text, g.current_text, g.reason]);
    const [r] = await pool.query('INSERT IGNORE INTO term_lang_queue (term_id, hz, vi_name, group1, field_key, lang_target, source_lang, source_text, current_text, reason) VALUES ?', [vals]);
    added += (r && r.affectedRows) || 0;
  }
  // Mục đã được sửa xong (không còn lỗ hổng) mà còn todo/pending → đóng
  const live = new Set(gaps.map((g) => `${g.term_id}|${g.field_key}|${g.lang_target}`));
  const [open] = await pool.query("SELECT id, term_id, field_key, lang_target FROM term_lang_queue WHERE status IN ('todo','pending')");
  const stale = open.filter((o) => !live.has(`${o.term_id}|${o.field_key}|${o.lang_target}`)).map((o) => o.id);
  if (stale.length) await pool.query("UPDATE term_lang_queue SET status = 'applied', handled_at = NOW() WHERE id IN (?)", [stale]);
  return { gaps: gaps.length, added, closed: stale.length };
}

/** Dịch đề xuất cho tối đa `limit` mục todo (mỗi lượt gọi AI ≤ 8 mục). Trả { done, costUsd }. */
export async function generate(pool, { limit = 40 } = {}) {
  limit = Math.max(1, Math.min(120, Number(limit) || 40));
  const [all] = await pool.query("SELECT * FROM term_lang_queue WHERE status = 'todo' ORDER BY id LIMIT ?", [limit]);
  let done = 0, cost = 0;
  // Hai loại sửa được ngay, không tốn AI: đặt đúng ô (misplaced) và bỏ pinyin khỏi tên Anh (pinyin_in_en)
  const rows = [];
  for (const r of all) {
    const local = r.reason === 'misplaced' ? r.source_text : r.reason === 'pinyin_in_en' ? cleanEnName(r.current_text) : null;
    if (r.reason === 'misplaced' || r.reason === 'pinyin_in_en') {
      if (local) { await pool.query("UPDATE term_lang_queue SET proposed_text = ?, status = 'pending', proposed_at = NOW() WHERE id = ?", [local.slice(0, 800), r.id]); done++; }
    } else rows.push(r);
  }
  for (let i = 0; i < rows.length; i += 8) {
    const batch = rows.slice(i, i + 8);
    const items = batch.map((r) => ({ key: String(r.id), source: r.source_lang, text: { vi: r.source_lang === 'vi' ? r.source_text : '', zh: r.source_lang === 'zh' ? r.source_text : '', en: r.source_lang === 'en' ? r.source_text : '' },
      targets: [r.lang_target], ctx: `${r.hz || ''} ${r.vi_name || ''}`.trim() }));
    let res;
    try { res = await translateItems(items, {}); } catch (e) { console.error('[lang-audit] dịch:', e.message); break; }
    cost += res.costUsd || 0;
    for (const r of batch) {
      const v = ((res.items || {})[String(r.id)] || {})[r.lang_target];
      if (v && v !== r.current_text) { await pool.query("UPDATE term_lang_queue SET proposed_text = ?, status = 'pending', proposed_at = NOW() WHERE id = ?", [v.slice(0, 800), r.id]); done++; }
    }
  }
  return { done, tried: rows.length, costUsd: cost };
}

export async function list(pool, { status = 'pending', limit = 100, offset = 0 } = {}) {
  const [rows] = await pool.query('SELECT * FROM term_lang_queue WHERE status = ? ORDER BY group1, id LIMIT ? OFFSET ?', [status, Math.min(200, Number(limit) || 100), Number(offset) || 0]);
  const [cnt] = await pool.query('SELECT status, COUNT(*) AS n FROM term_lang_queue GROUP BY status');
  return { rows, counts: Object.fromEntries(cnt.map((c) => [c.status, Number(c.n)])) };
}

/** Áp dụng các mục đã duyệt (ids; text tuỳ chọn = bản admin đã sửa). Trả { applied, failed:[{id,error}] }. */
export async function apply(pool, admin, items) {
  const applied = [], failed = [];
  for (const it of (Array.isArray(items) ? items : []).slice(0, 60)) {
    const [[r]] = await pool.query("SELECT * FROM term_lang_queue WHERE id = ? AND status IN ('pending','todo')", [Number(it.id)]).catch(() => [[null]]);
    if (!r) { failed.push({ id: it.id, error: 'not_found' }); continue; }
    const text = str(it.text != null ? it.text : r.proposed_text).slice(0, 800);
    if (!text) { failed.push({ id: r.id, error: 'empty' }); continue; }
    const l = r.lang_target; let edit = { term_id: r.term_id, note: `Rà soát ngôn ngữ (${r.reason}), admin duyệt` };
    if (r.field_key === 'name') edit.en = text;
    else {
      const def = FIELD_DEFS.find((d) => d.key === r.field_key); if (!def) { failed.push({ id: r.id, error: 'bad_field' }); continue; }
      const col = def.cols[l];
      // Trước hết thử ghi vào bảng thuật ngữ (Tổng hợp/Giải phẫu: định nghĩa position_*); không được thì ghi đè theo trường.
      let res = null;
      if (r.field_key === 'vitri') res = await editTerm(pool, admin, { ...edit, ...(l === 'vi' ? { definition: text } : l === 'zh' ? { def_zh: text } : { def_en: text }) });
      if (!res || (!res.ok && res.error === 'definition_not_editable_here')) res = await editTerm(pool, admin, { ...edit, fields: { [col]: text } });
      if (!res.ok) { failed.push({ id: r.id, error: res.error || 'edit_failed' }); continue; }
      await pool.query("UPDATE term_lang_queue SET status = 'applied', handled_at = NOW(), proposed_text = ? WHERE id = ?", [text, r.id]);
      applied.push(r.id); continue;
    }
    const res = await editTerm(pool, admin, edit);
    if (!res.ok) { failed.push({ id: r.id, error: res.error || 'edit_failed' }); continue; }
    await pool.query("UPDATE term_lang_queue SET status = 'applied', handled_at = NOW(), proposed_text = ? WHERE id = ?", [text, r.id]);
    applied.push(r.id);
  }
  return { applied, failed };
}

export async function dismiss(pool, ids) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Boolean).slice(0, 200);
  if (!list.length) return { dismissed: 0 };
  const [r] = await pool.query("UPDATE term_lang_queue SET status = 'dismissed', handled_at = NOW() WHERE id IN (?) AND status IN ('todo','pending')", [list]);
  return { dismissed: (r && r.affectedRows) || 0 };
}
