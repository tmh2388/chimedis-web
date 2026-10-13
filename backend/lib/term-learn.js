/**
 * term-learn.js — KHO THUẬT NGỮ CHUNG dict ⇄ workbench (tự học, lưu MySQL).
 *
 * Luồng duy nhất:
 *   1. Workbench (và bất kỳ nơi nào) ghi cụm AI vừa dịch vào dict_candidates (đã có sẵn, dùng chung MySQL). Không đổi gì ở workbench.
 *   2. promoteBatch() (job nền của dict, mỗi cụm chỉ xử lý MỘT lần, có trần ngày):
 *        - bỏ cụm đã có trong kho (general_terms + CSDL) → không tốn AI;
 *        - hỏi AI MỘT lần theo lô: có phải thuật ngữ y khoa không? chữ Hán giản thể, pinyin, tiếng Việt, tiếng Anh, định nghĩa ngắn;
 *        - thuật ngữ y khoa → general_terms ("Tổng hợp", verify=0, machine_translated=1, nhóm "Mới (tự học)") → hiện ngay trên app;
 *        - không phải y khoa → đánh dấu is_medical=0, KHÔNG dịch lại lần sau.
 *   3. Người dùng đánh dấu ⭐ + góp ý (term_feedback) → trang admin → sửa/duyệt → ghi ngược vào general_terms VÀ dict_candidates
 *      (workbench tìm kiếm bằng bản đã sửa).
 */
import crypto from 'node:crypto';
import { CORE_TERMS } from './laoshi.js';

const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
const MODEL = process.env.TERM_PROMOTE_MODEL || 'gpt-5-mini';
const DAILY_CAP = Number(process.env.TERM_PROMOTE_DAILY) || 60;
const BATCH = 15;
const SOURCE = 'Tự học (AI) — chưa duyệt';

const GROUPS = {
  ly_luan: { zh: '理论', vi: 'Lý luận', en: 'Theory' },
  chan_doan: { zh: '诊断', vi: 'Chẩn đoán', en: 'Diagnosis' },
  benh_chung: { zh: '病证', vi: 'Bệnh chứng', en: 'Disease & syndrome' },
  thuoc: { zh: '药物方剂', vi: 'Dược liệu & phương', en: 'Herbs & formulas' },
  cham_cuu: { zh: '针灸推拿', vi: 'Châm cứu & xoa bóp', en: 'Acupuncture & tuina' },
  giai_phau: { zh: '解剖生理', vi: 'Giải phẫu & sinh lý', en: 'Anatomy & physiology' },
  nghien_cuu: { zh: '研究方法', vi: 'Phương pháp nghiên cứu', en: 'Research methods' },
  khac: { zh: '其他', vi: 'Khác', en: 'Other' },
};
export const termIdOf = (hz) => 'tq-' + crypto.createHash('sha1').update(hz).digest('hex').slice(0, 10);
const HAN_TERM = /^[㐀-鿿]{1,24}$/;

async function columnsOf(pool, table) {
  const [cols] = await pool.query('SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
  return new Set(cols.map((c) => c.n));
}

export async function ensureTables(pool) {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS term_feedback (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, term_id VARCHAR(64) NOT NULL, hz VARCHAR(64) NULL, vi VARCHAR(190) NULL, en VARCHAR(190) NULL,
    firebase_uid VARCHAR(128) NOT NULL, email VARCHAR(255) NULL, comment TEXT NULL, suggested_vi VARCHAR(190) NULL, suggested_en VARCHAR(190) NULL,
    status ENUM('new','applied','dismissed') NOT NULL DEFAULT 'new', admin_note VARCHAR(255) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, handled_at DATETIME NULL,
    KEY idx_status (status, created_at), KEY idx_term (term_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // Mở rộng dict_candidates (do workbench tạo) bằng cột mới — kiểm tra trước rồi mới ALTER; workbench liệt kê cột tường minh nên không bị ảnh hưởng.
  try {
    const have = await columnsOf(pool, 'dict_candidates');
    if (have.size) {
      const add = [['hz', 'VARCHAR(64) NULL'], ['py', 'VARCHAR(128) NULL'], ['vi_name', 'VARCHAR(190) NULL'], ['definition_vi', 'TEXT NULL'],
        ['is_medical', 'TINYINT NULL'], ['promoted_term_id', 'VARCHAR(64) NULL'], ['promoted_at', 'DATETIME NULL'], ['enrich_note', 'VARCHAR(255) NULL']];
      for (const [c, def] of add) if (!have.has(c)) await pool.query(`ALTER TABLE dict_candidates ADD COLUMN ${c} ${def}`);
    }
  } catch (e) { console.error('[term-learn] mở rộng dict_candidates:', e.message); }
  await pool.query(`CREATE TABLE IF NOT EXISTS term_overrides (
    term_id VARCHAR(64) NOT NULL PRIMARY KEY, vi VARCHAR(190) NULL, en VARCHAR(190) NULL, definition_vi TEXT NULL,
    updated_by VARCHAR(255) NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS term_edit_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, term_id VARCHAR(64) NOT NULL, admin_uid VARCHAR(128) NULL, admin_email VARCHAR(255) NULL,
    source VARCHAR(24) NOT NULL, before_json MEDIUMTEXT NULL, after_json MEDIUMTEXT NULL, feedback_ids VARCHAR(255) NULL, note VARCHAR(255) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, KEY idx_term (term_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  try {
    const fb = await columnsOf(pool, 'term_feedback');
    if (!fb.has('group1')) await pool.query('ALTER TABLE term_feedback ADD COLUMN group1 VARCHAR(48) NULL');
    if (!fb.has('suggested_def')) await pool.query('ALTER TABLE term_feedback ADD COLUMN suggested_def TEXT NULL');
  } catch (e) { console.error('[term-learn] mở rộng term_feedback:', e.message); }
}

// ---------- Nhận biết đã có trong kho ----------
let namesCache = { at: 0, set: null };
async function knownNameSet(pool) {
  if (namesCache.set && Date.now() - namesCache.at < 10 * 60e3) return namesCache.set;
  const set = new Set();
  const add = (s) => { if (s) set.add(String(s).trim().toLowerCase()); };
  try {
    const [rows] = await pool.query('SELECT hz, vi, en FROM general_terms');
    for (const r of rows) { add(r.hz); add(r.vi); add(r.en); }
  } catch (_) { /* chưa có bảng */ }
  for (const [hz, vi] of CORE_TERMS) { add(hz); add(vi); }
  namesCache = { at: Date.now(), set };
  return set;
}
export const invalidateNames = () => { namesCache = { at: 0, set: null }; };

// ---------- Hỏi AI (một lần / cụm, theo lô) ----------
async function askModel(items) {
  const sys = 'Bạn là biên tập viên thuật ngữ Y học cổ truyền Trung Hoa và y sinh. Với mỗi cụm, quyết định có phải THUẬT NGỮ Y KHOA có giá trị tra cứu hay không '
    + '(bệnh, chứng, huyệt, dược liệu, phương, phép chẩn trị, giải phẫu/sinh lý, lý luận Trung y, phương pháp nghiên cứu y học). Từ thông thường/động từ/từ nối → medical=false. '
    + 'KHÔNG bịa: không chắc thì medical=false. Chữ Hán dùng GIẢN THỂ. Chỉ trả JSON.';
  const user = `Cụm cần xử lý (JSON): ${JSON.stringify(items.map((x) => ({ id: x.id, term: x.term, en: x.en })))}\n`
    + 'Trả JSON dạng {"items":[{"id":<id>,"medical":true|false,"hz":"<chữ Hán giản thể, 1-12 chữ, nếu có>","py":"<pinyin có dấu thanh>",'
    + '"vi":"<tên tiếng Việt chuẩn y học (Hán-Việt nếu là thuật ngữ Trung y)>","en":"<tiếng Anh chuẩn PubMed/WHO>",'
    + '"def_vi":"<định nghĩa tiếng Việt ≤ 200 ký tự, trung tính, không chẩn đoán/kê đơn>","group":"ly_luan|chan_doan|benh_chung|thuoc|cham_cuu|giai_phau|nghien_cuu|khac"}]}';
  const r = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], response_format: { type: 'json_object' }, max_completion_tokens: 3000 }),
  });
  if (!r.ok) throw new Error(`term_llm ${r.status} ${(await r.text()).slice(0, 120)}`);
  const j = await r.json();
  const txt = String(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '');
  const parsed = JSON.parse(txt);
  return { items: Array.isArray(parsed.items) ? parsed.items : [], usage: j.usage };
}

/** Xử lý một lô ứng viên chưa thăng cấp. Trả { examined, promoted, skippedKnown, notMedical }. */
export async function promoteBatch(pool, { limit = BATCH } = {}) {
  const out = { examined: 0, promoted: 0, skippedKnown: 0, notMedical: 0, error: null };
  if (!pool || !process.env.OPENAI_API_KEY) return out;
  try {
    const have = await columnsOf(pool, 'dict_candidates');
    if (!have.has('promoted_at')) return out; // chưa có bảng/cột (workbench chưa tạo)
    const [[used]] = await pool.query('SELECT COUNT(*) AS n FROM dict_candidates WHERE promoted_at >= CURDATE()');
    const room = Math.max(0, DAILY_CAP - Number(used.n));
    if (room <= 0) return out;
    const [rows] = await pool.query(
      `SELECT id, term_norm, term_display, lang, en FROM dict_candidates
        WHERE promoted_at IS NULL AND status <> 'rejected'
          AND (status IN ('approved','auto_active') OR seen_count >= 2)
        ORDER BY (status = 'approved') DESC, seen_count DESC LIMIT ?`, [Math.min(limit, room)]);
    if (!rows.length) return out;
    out.examined = rows.length;
    const names = await knownNameSet(pool);
    const todo = [];
    for (const r of rows) {
      const known = [r.term_display, r.term_norm, r.en].some((s) => s && names.has(String(s).trim().toLowerCase()));
      if (known) {
        out.skippedKnown++;
        await pool.query("UPDATE dict_candidates SET promoted_at = NOW(), enrich_note = 'đã có trong kho' WHERE id = ?", [r.id]);
      } else todo.push({ id: r.id, term: r.term_display, en: r.en });
    }
    if (!todo.length) return out;
    const { items } = await askModel(todo);
    const byId = new Map(items.map((x) => [Number(x.id), x]));
    for (const c of todo) {
      const it = byId.get(c.id);
      if (!it) continue; // thiếu kết quả: để lượt sau thử lại
      if (!it.medical) {
        out.notMedical++;
        await pool.query("UPDATE dict_candidates SET is_medical = 0, promoted_at = NOW(), enrich_note = 'AI: không phải thuật ngữ y khoa' WHERE id = ?", [c.id]);
        continue;
      }
      const hz = String(it.hz || '').trim(), vi = String(it.vi || '').trim().slice(0, 150), en = String(it.en || c.en || '').trim().slice(0, 150);
      if (!HAN_TERM.test(hz) || !vi || !en) {
        await pool.query("UPDATE dict_candidates SET is_medical = 1, promoted_at = NOW(), enrich_note = 'thiếu chữ Hán/tên — cần người bổ sung' WHERE id = ?", [c.id]);
        continue;
      }
      if (names.has(hz.toLowerCase())) {
        out.skippedKnown++;
        await pool.query("UPDATE dict_candidates SET is_medical = 1, hz = ?, promoted_at = NOW(), enrich_note = 'đã có trong kho (theo chữ Hán)' WHERE id = ?", [hz, c.id]);
        continue;
      }
      const g = GROUPS[it.group] || GROUPS.khac;
      const termId = termIdOf(hz);
      const note = `AI đề xuất ${new Date().toISOString().slice(0, 10)} từ cụm "${c.term}" (ứng viên #${c.id}) — chờ chuyên gia duyệt`;
      await pool.query(
        `INSERT IGNORE INTO general_terms (term_id, domain, organ_system_zh, organ_system_vi, organ_system_en, hz, py, vi, en, position_vi, source, verify, machine_translated, verify_note)
         VALUES (?, 'Tổng hợp', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)`,
        [termId, `新增·${g.zh}`, `Mới (tự học) · ${g.vi}`, `New (auto-learned) · ${g.en}`, hz, String(it.py || '').slice(0, 120) || null, vi, en,
          String(it.def_vi || '').slice(0, 400) || null, SOURCE, note]);
      await pool.query(
        'UPDATE dict_candidates SET is_medical = 1, hz = ?, py = ?, vi_name = ?, definition_vi = ?, promoted_term_id = ?, promoted_at = NOW(), enrich_note = ? WHERE id = ?',
        [hz, String(it.py || '').slice(0, 120) || null, vi, String(it.def_vi || '').slice(0, 400) || null, termId, 'đã đưa vào Tổng hợp', c.id]);
      names.add(hz.toLowerCase());
      out.promoted++;
    }
    invalidateNames();
  } catch (e) {
    out.error = e.message;
    console.error('[term-learn] promoteBatch:', e.message);
  }
  return out;
}

let timer = null;
export function startPromoteJob(pool, everyMs = 30 * 60e3) {
  if (timer || !pool) return;
  const tick = () => promoteBatch(pool).then((r) => { if (r.promoted || r.notMedical || r.error) console.log('[term-learn]', JSON.stringify(r)); }).catch(() => {});
  setTimeout(tick, 2 * 60e3).unref?.();
  timer = setInterval(tick, everyMs); timer.unref?.();
}

// ---------- Góp ý của người dùng ----------
export async function addFeedback(pool, { uid, email, term_id, hz, vi, en, group1, comment, suggested_vi, suggested_en, suggested_def }) {
  const [[c]] = await pool.query("SELECT COUNT(*) AS n FROM term_feedback WHERE firebase_uid = ? AND created_at >= NOW() - INTERVAL 1 DAY", [uid]);
  if (Number(c.n) >= 20) return { ok: false, error: 'rate_limited' };
  const cut = (s, n) => (s == null ? null : String(s).trim().slice(0, n) || null);
  await pool.query(
    'INSERT INTO term_feedback (term_id, hz, vi, en, group1, firebase_uid, email, comment, suggested_vi, suggested_en, suggested_def) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [cut(term_id, 64), cut(hz, 64), cut(vi, 190), cut(en, 190), cut(group1, 48), uid, cut(email, 255), cut(comment, 1000), cut(suggested_vi, 190), cut(suggested_en, 190), cut(suggested_def, 1000)]);
  return { ok: true };
}
export async function listFeedback(pool, status = 'new') {
  const [rows] = await pool.query('SELECT * FROM term_feedback WHERE status = ? ORDER BY created_at DESC LIMIT 200', [status]);
  return rows;
}
/** action: 'apply' (sửa general_terms nếu là thuật ngữ Tổng hợp + ghi ngược dict_candidates) | 'dismiss'. */
export async function resolveFeedback(pool, id, { action, vi, en, definition, adminNote }) {
  const [[fb]] = await pool.query('SELECT * FROM term_feedback WHERE id = ?', [id]);
  if (!fb) return { ok: false, error: 'not_found' };
  if (action === 'dismiss') {
    await pool.query("UPDATE term_feedback SET status = 'dismissed', handled_at = NOW(), admin_note = ? WHERE id = ?", [adminNote || null, id]);
    return { ok: true };
  }
  const newVi = (vi || fb.suggested_vi || '').trim(), newEn = (en || fb.suggested_en || '').trim();
  definition = (definition && String(definition).trim()) || (fb.suggested_def || '').trim() || '';
  let applied = false;
  if (fb.term_id && (newVi || newEn || definition)) {
    const sets = [], p = [];
    if (newVi) { sets.push('vi = ?'); p.push(newVi.slice(0, 160)); }
    if (newEn) { sets.push('en = ?'); p.push(newEn.slice(0, 160)); }
    if (definition) { sets.push('position_vi = ?'); p.push(String(definition).slice(0, 600)); }
    sets.push('verify = 1', 'machine_translated = 0', "verify_note = CONCAT(COALESCE(verify_note, ''), ' | Đã sửa theo góp ý người dùng ', CURDATE())");
    for (const table of ['general_terms', 'anatomy_terms']) { // cùng tên cột term_id/vi/en/position_vi/verify…
      try {
        const [r] = await pool.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE term_id = ?`, [...p, fb.term_id]);
        if (r.affectedRows > 0) { applied = true; break; }
      } catch (_) { /* bảng không có/khác cột: thử bảng kế */ }
    }
    if (applied && newEn) {
      await pool.query("UPDATE dict_candidates SET en = ?, status = 'approved', reviewed_at = NOW() WHERE promoted_term_id = ?", [newEn.slice(0, 200), fb.term_id]).catch(() => {});
    }
  }
  await pool.query("UPDATE term_feedback SET status = 'applied', handled_at = NOW(), admin_note = ? WHERE id = ?", [adminNote || (applied ? 'đã sửa trong Tổng hợp' : 'ghi nhận (không thuộc Tổng hợp — sửa tay ở nguồn)'), id]);
  invalidateNames();
  return { ok: true, applied };
}
// ---------- Thuật ngữ mới tự học ----------
export async function listAutoTerms(pool) {
  const [rows] = await pool.query(
    `SELECT term_id, hz, py, vi, en, position_vi AS definition, verify_note, updated_at FROM general_terms
      WHERE is_active = 1 AND verify = 0 AND source LIKE 'Tự học%' ORDER BY updated_at DESC LIMIT 150`);
  return rows;
}
export async function reviewAutoTerm(pool, termId, { action, vi, en, definition }) {
  if (action === 'hide') {
    await pool.query('UPDATE general_terms SET is_active = 0 WHERE term_id = ?', [termId]);
    await pool.query("UPDATE dict_candidates SET status = 'rejected', reviewed_at = NOW() WHERE promoted_term_id = ?", [termId]).catch(() => {});
    return { ok: true };
  }
  const sets = ['verify = 1', 'machine_translated = 0', "verify_note = CONCAT(COALESCE(verify_note, ''), ' | Admin duyệt ', CURDATE())"], p = [];
  if (vi) { sets.unshift('vi = ?'); p.push(String(vi).slice(0, 160)); }
  if (en) { sets.unshift('en = ?'); p.push(String(en).slice(0, 160)); }
  if (definition) { sets.unshift('position_vi = ?'); p.push(String(definition).slice(0, 600)); }
  await pool.query(`UPDATE general_terms SET ${sets.join(', ')} WHERE term_id = ?`, [...p, termId]);
  await pool.query("UPDATE dict_candidates SET status = 'approved', reviewed_at = NOW()" + (en ? ', en = ?' : '') + ' WHERE promoted_term_id = ?', en ? [String(en).slice(0, 200), termId] : [termId]).catch(() => {});
  return { ok: true };
}

// ================= Quản trị viên xem & SỬA thuật ngữ do người dùng báo sai (ngay trong app) =================
// Nguyên tắc: chỉ quản trị viên (route adminOnly); mọi sửa đổi nằm trong MỘT giao dịch MySQL: khoá hàng → ghi → nhật ký (trước/sau) → đóng các báo cáo.
// Nguồn sửa: general_terms / anatomy_terms (đúng bảng gốc, verify=1, bỏ cờ máy dịch). Các bảng khác (dược liệu, huyệt, từ ghép…) → term_overrides
// (chồng lên lúc trả /api/terms; chỉ đổi tên Việt/Anh, định nghĩa của các nhóm đó nằm ở trường khác nên KHÔNG sửa ở đây).
const EDITABLE_TABLES = ['general_terms', 'anatomy_terms'];
const cleanText = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export async function countReports(pool) {
  const [[r]] = await pool.query("SELECT COUNT(DISTINCT term_id) AS n FROM term_feedback WHERE status = 'new'");
  return Number(r.n) || 0;
}
/** Báo cáo chưa xử lý, gom theo thuật ngữ (mới nhất trước). */
export async function listReports(pool) {
  const [rows] = await pool.query(
    "SELECT id, term_id, hz, vi, en, group1, email, comment, suggested_vi, suggested_en, suggested_def, created_at FROM term_feedback WHERE status = 'new' ORDER BY created_at DESC LIMIT 400");
  const by = new Map();
  for (const r of rows) {
    let g = by.get(r.term_id);
    if (!g) { g = { term_id: r.term_id, hz: r.hz, vi: r.vi, en: r.en, group1: r.group1, count: 0, last_at: r.created_at, reports: [] }; by.set(r.term_id, g); }
    g.count++;
    g.reports.push({ id: r.id, email: r.email, comment: r.comment, suggested_vi: r.suggested_vi, suggested_en: r.suggested_en, suggested_def: r.suggested_def, at: r.created_at });
  }
  return [...by.values()];
}
let overridesCache = { at: 0, map: new Map() };
export async function getOverrides(pool) {
  if (!pool) return new Map();
  if (Date.now() - overridesCache.at < 30e3) return overridesCache.map;
  try {
    const [rows] = await pool.query('SELECT term_id, vi, en FROM term_overrides');
    overridesCache = { at: Date.now(), map: new Map(rows.map((r) => [String(r.term_id), { vi: r.vi, en: r.en }])) };
  } catch (_) { /* chưa có bảng */ }
  return overridesCache.map;
}
export function applyOverrides(terms, map) {
  if (!map || !map.size) return terms;
  for (const t of terms) { const o = map.get(String(t.id)); if (o) { if (o.vi) t.vi = o.vi; if (o.en) t.en = o.en; } }
  return terms;
}
/**
 * @param admin {uid, email}
 * @param {{term_id:string, vi?:string, en?:string, definition?:string, note?:string}} edit
 * @returns {{ok:boolean, source?:string, error?:string, definition_ignored?:boolean, before?:object, after?:object}}
 */
export async function editTerm(pool, admin, edit) {
  const term_id = cleanText(edit && edit.term_id, 64);
  const vi = edit && edit.vi != null ? cleanText(edit.vi, 160) : null;
  const en = edit && edit.en != null ? cleanText(edit.en, 160) : null;
  let definition = edit && edit.definition != null ? cleanText(edit.definition, 600) : null;
  const note = cleanText(edit && edit.note, 200) || null;
  if (!term_id) return { ok: false, error: 'term_required' };
  if (!vi && !en && !definition) return { ok: false, error: 'nothing_to_change' };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let source = null, before = null, after = null, definitionIgnored = false;
    for (const table of EDITABLE_TABLES) {
      let rows;
      try { [rows] = await conn.query(`SELECT term_id, hz, vi, en, position_vi FROM ${table} WHERE term_id = ? FOR UPDATE`, [term_id]); }
      catch (_) { continue; } // bảng không có / khác cột
      if (!rows.length) continue;
      const cur = rows[0];
      before = { vi: cur.vi, en: cur.en, definition: cur.position_vi }; // chụp TRƯỚC khi ghi (nhật ký chính xác)
      const nv = vi || before.vi, ne = en || before.en, nd = definition || before.definition;
      await conn.query(
        `UPDATE ${table} SET vi = ?, en = ?, position_vi = ?, verify = 1, machine_translated = 0,
           verify_note = CONCAT(COALESCE(verify_note, ''), ' | Admin sửa ', CURDATE(), ' (', ?, ')') WHERE term_id = ?`,
        [nv, ne, nd, cleanText(admin && admin.email, 60) || 'admin', term_id]);
      source = table; after = { vi: nv, en: ne, definition: nd };
      break;
    }
    if (!source) {
      if (definition) { definitionIgnored = true; definition = null; }
      if (!vi && !en) { await conn.rollback(); return { ok: false, error: 'definition_not_editable_here' }; }
      const [ex] = await conn.query('SELECT vi, en FROM term_overrides WHERE term_id = ? FOR UPDATE', [term_id]);
      before = ex.length ? { vi: ex[0].vi, en: ex[0].en } : null;
      await conn.query(
        'INSERT INTO term_overrides (term_id, vi, en, updated_by) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE vi = COALESCE(VALUES(vi), vi), en = COALESCE(VALUES(en), en), updated_by = VALUES(updated_by)',
        [term_id, vi, en, cleanText(admin && admin.email, 120) || null]);
      after = { vi: vi || (before && before.vi) || null, en: en || (before && before.en) || null };
      source = 'override';
    }
    const [fbRows] = await conn.query("SELECT id FROM term_feedback WHERE term_id = ? AND status = 'new'", [term_id]);
    const ids = fbRows.map((r) => r.id);
    await conn.query(
      'INSERT INTO term_edit_log (term_id, admin_uid, admin_email, source, before_json, after_json, feedback_ids, note) VALUES (?,?,?,?,?,?,?,?)',
      [term_id, (admin && admin.uid) || null, (admin && admin.email) || null, source, JSON.stringify(before), JSON.stringify(after), ids.join(',').slice(0, 250), note]);
    if (ids.length) {
      await conn.query("UPDATE term_feedback SET status = 'applied', handled_at = NOW(), admin_note = ? WHERE term_id = ? AND status = 'new'",
        [note || `đã sửa (${source})`, term_id]);
    }
    await conn.commit();
    overridesCache.at = 0; invalidateNames();
    if (after && after.en) {
      pool.query("UPDATE dict_candidates SET en = ?, status = 'approved', reviewed_at = NOW() WHERE promoted_term_id = ?", [after.en.slice(0, 200), term_id]).catch(() => {});
    }
    return { ok: true, source, before, after, definition_ignored: definitionIgnored, closed_reports: ids.length };
  } catch (e) {
    try { await conn.rollback(); } catch (_) { /* bỏ qua */ }
    console.error('[term-learn] editTerm:', e.message);
    return { ok: false, error: 'edit_failed' };
  } finally {
    conn.release();
  }
}
export async function dismissReports(pool, term_id, note) {
  const [r] = await pool.query("UPDATE term_feedback SET status = 'dismissed', handled_at = NOW(), admin_note = ? WHERE term_id = ? AND status = 'new'", [cleanText(note, 200) || 'bỏ qua', cleanText(term_id, 64)]);
  return { ok: true, closed: r.affectedRows };
}

