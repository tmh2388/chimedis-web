/**
 * laoshi-learn.js — "hệ thống tự tích luỹ" cho Lão Sư, LƯU TRONG MYSQL (không dùng file: triển khai lại sẽ xoá file ghi lúc chạy).
 *
 *  1) laoshi_tts_cache — đệm giọng đọc DÙNG CHUNG cho mọi người dùng, theo từng đoạn (ngôn ngữ + giọng + chữ). Đoạn nào đã được
 *     tạo một lần thì các lần sau (của bất kỳ ai) không tốn chi phí TTS nữa.
 *  2) asr_fix_votes — người dùng sửa chữ nhận dạng sai đồng âm (学位 → 穴位). Cặp nào có ≥ 2 người khác nhau xác nhận
 *     (hoặc quản trị viên xác nhận) thì được TỰ ĐỘNG sửa ở các lần sau, và luôn được báo cho mô hình.
 *     Chỉ nhận cặp thật sự ĐỒNG ÂM (cùng pinyin + thanh) — chặn việc dạy hệ thống thay từ tuỳ ý.
 */
import crypto from 'node:crypto';
import { pinyin } from 'pinyin';

export async function ensureTables(pool) {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS laoshi_tts_cache (
    hash CHAR(64) NOT NULL PRIMARY KEY, lang VARCHAR(4) NOT NULL, voice VARCHAR(16) NOT NULL, chars INT NOT NULL,
    audio MEDIUMBLOB NOT NULL, hits INT NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_hit DATETIME DEFAULT CURRENT_TIMESTAMP,
    KEY idx_last_hit (last_hit)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS asr_fix_votes (
    heard VARCHAR(24) NOT NULL, meant VARCHAR(24) NOT NULL, firebase_uid VARCHAR(128) NOT NULL, is_admin TINYINT NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (heard, meant, firebase_uid)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // Dọn đệm giọng đọc không ai nghe lại trong 90 ngày (giữ dung lượng DB gọn).
  await pool.query('DELETE FROM laoshi_tts_cache WHERE last_hit < NOW() - INTERVAL 90 DAY').catch(() => {});
}

// ---------- Đệm giọng đọc ----------
export const ttsKey = (lang, voice, text) => crypto.createHash('sha256').update(`v2|${lang}|${voice}|${text}`).digest('hex');

/** Trả Map(hash → Buffer) cho các khoá đã có; cộng lượt dùng lại. Lỗi DB → rỗng (rơi về tạo giọng mới). */
export async function ttsGetMany(pool, keys) {
  const out = new Map();
  if (!pool || !keys.length) return out;
  try {
    const [rows] = await pool.query('SELECT hash, audio FROM laoshi_tts_cache WHERE hash IN (?)', [keys]);
    for (const r of rows) out.set(r.hash, Buffer.isBuffer(r.audio) ? r.audio : Buffer.from(r.audio));
    if (rows.length) pool.query('UPDATE laoshi_tts_cache SET hits = hits + 1, last_hit = NOW() WHERE hash IN (?)', [rows.map((r) => r.hash)]).catch(() => {});
  } catch (e) { console.error('[laoshi-tts-cache] get:', e.message); }
  return out;
}
export async function ttsPut(pool, key, { lang, voice, chars, audio }) {
  if (!pool || !audio || !audio.length || audio.length > 4 * 1024 * 1024) return;
  try {
    await pool.query('INSERT IGNORE INTO laoshi_tts_cache (hash, lang, voice, chars, audio) VALUES (?,?,?,?,?)', [key, String(lang).slice(0, 4), String(voice).slice(0, 16), chars, audio]);
  } catch (e) { console.error('[laoshi-tts-cache] put:', e.message); }
}

// ---------- Học sửa nhận dạng đồng âm ----------
const HAN_ONLY = /^[㐀-鿿]{2,6}$/;
const pyKey = (s) => { try { return pinyin(s, { style: 'tone2' }).map((a) => a[0]).join('|'); } catch (_) { return ''; } };
export function validPair(heard, meant) {
  return typeof heard === 'string' && typeof meant === 'string' && heard !== meant && HAN_ONLY.test(heard) && HAN_ONLY.test(meant)
    && heard.length === meant.length && pyKey(heard) !== '' && pyKey(heard) === pyKey(meant);
}
let learned = new Map(), loadedAt = 0;
export async function loadLearned(pool, force = false) {
  if (!pool) return learned;
  if (!force && Date.now() - loadedAt < 5 * 60e3) return learned;
  try {
    const [rows] = await pool.query(
      `SELECT heard, meant, COUNT(*) AS n, MAX(is_admin) AS adm FROM asr_fix_votes GROUP BY heard, meant
       HAVING n >= 2 OR adm = 1 ORDER BY n DESC, adm DESC`);
    const m = new Map();
    for (const r of rows) if (!m.has(r.heard)) m.set(r.heard, r.meant); // một "nghe nhầm" → cặp được nhiều phiếu nhất
    learned = m; loadedAt = Date.now();
  } catch (e) { console.error('[laoshi-learn] load:', e.message); }
  return learned;
}
export async function recordFix(pool, { uid, heard, meant, isAdmin = false }) {
  if (!pool || !uid || !validPair(heard, meant)) return false;
  await pool.query('INSERT INTO asr_fix_votes (heard, meant, firebase_uid, is_admin) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE is_admin = GREATEST(is_admin, VALUES(is_admin))',
    [heard, meant, uid, isAdmin ? 1 : 0]);
  await loadLearned(pool, true);
  return true;
}
/** Áp các cặp đã học vào câu người dùng. Trả { text, applied: [{heard, meant}] }. */
export function applyLearned(text) {
  let out = String(text || ''); const applied = [];
  for (const [heard, meant] of learned) {
    if (out.includes(heard)) { out = out.split(heard).join(meant); applied.push({ heard, meant }); }
  }
  return { text: out, applied };
}
