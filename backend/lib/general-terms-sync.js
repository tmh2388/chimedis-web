/**
 * general-terms-sync.js — đưa thuật ngữ nhóm "Tổng hợp" từ backend/data/general-terms/*.json vào bảng
 * MySQL general_terms mỗi lần server khởi động (idempotent). JSON chỉ là phương tiện gieo dữ liệu; nguồn
 * sự thật là CSDL. Dòng đã được chuyên gia duyệt (verify = 1) không bị ghi đè.
 * Định dạng file và công thức term_id khớp scripts/build-general-terms.mjs của repo chimedis-web-home.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const NOTE = 'Claude đề xuất 2026-10-10 — chờ chuyên gia duyệt';
const SOURCE = 'Chimedis — mục Tổng hợp (đề xuất, chờ duyệt)';

const COLS = [
  'term_id', 'domain', 'organ_system_zh', 'organ_system_vi', 'organ_system_en', 'hz', 'py', 'vi', 'en',
  'position_zh', 'position_vi', 'position_en', 'function_zh', 'function_vi', 'function_en',
  'tcm_note_zh', 'tcm_note_vi', 'tcm_note_en', 'clinical_zh', 'clinical_vi', 'clinical_en',
  'source', 'verify', 'machine_translated', 'verify_note',
];

export function termId(hz) {
  return 'tq-' + crypto.createHash('sha1').update(hz).digest('hex').slice(0, 10);
}

export function loadGeneralTermRows(dir) {
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  const seen = new Set();
  for (const f of fs.readdirSync(dir).filter((n) => /^\d.*\.json$/.test(n)).sort()) {
    const { group, terms } = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const t of terms || []) {
      if (!t.hz || seen.has(t.hz)) continue;
      seen.add(t.hz);
      const [dVi, dZh, dEn] = t.d || [];
      const u = t.u || [];
      rows.push([
        termId(t.hz), 'Tổng hợp', group.zh, group.vi, group.en, t.hz, t.py || null, t.vi || null, t.en || null,
        dZh || null, dVi || null, dEn || null, null, null, null, null, null, null,
        u[1] || null, u[0] || null, u[2] || null, SOURCE, 0, 1, NOTE,
      ]);
    }
  }
  return rows;
}

export async function syncGeneralTerms(pool, dir) {
  const rows = loadGeneralTermRows(dir);
  if (!pool || !rows.length) return { total: rows.length, written: 0 };
  const updatable = COLS.slice(1).filter((c) => !['verify', 'machine_translated'].includes(c));
  const upd = updatable.map((c) => `${c} = IF(verify = 0, VALUES(${c}), ${c})`).join(', ');
  const sql = `INSERT INTO general_terms (${COLS.join(', ')}) VALUES ? ON DUPLICATE KEY UPDATE ${upd}`;
  const [res] = await pool.query(sql, [rows]);
  return { total: rows.length, written: res.affectedRows };
}
