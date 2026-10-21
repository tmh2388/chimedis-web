/**
 * csdl-audio.js — giọng đọc theo yêu cầu cho bài "Học Thuật", lưu đệm trong MySQL (dùng chung cho mọi người dùng).
 * Lần nghe đầu của một câu sinh bằng Google TTS (qua user-docs.synthesize), các lần sau lấy từ đệm. Có giới hạn tần suất
 * sinh mới theo người dùng và toàn hệ thống để không bị lạm dụng chi phí, và tự dọn khi đệm quá lớn.
 */
import { synthesize, zhSpeechFix } from './user-docs.js';

const VOICES = ['default', 'aoede']; // nam (Wavenet) + nữ (Chirp 3 HD)
const MAX_ROWS = Number(process.env.CSDL_AUDIO_MAX_ROWS) || 12000; // ~ 24KB/câu → khoảng 300MB
const PER_USER_PER_HOUR = Number(process.env.CSDL_TTS_PER_USER_HOUR) || 200;
const GLOBAL_PER_HOUR = Number(process.env.CSDL_TTS_GLOBAL_HOUR) || 3000;

let tableReady = false;
export async function ensureTable(pool) {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS csdl_audio (
    lesson_id VARCHAR(80) NOT NULL, seq INT NOT NULL, voice VARCHAR(16) NOT NULL,
    mp3 MEDIUMBLOB NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (lesson_id, seq, voice), KEY idx_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // fixv=1: bản đã sinh SAU khi sửa cách đọc 腧/俞…; bản cũ có chữ cần sửa sẽ được sinh lại đúng một lần.
  try {
    const [c] = await pool.query("SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'csdl_audio' AND COLUMN_NAME = 'fixv'");
    if (!Number(c[0].n)) await pool.query('ALTER TABLE csdl_audio ADD COLUMN fixv TINYINT NOT NULL DEFAULT 0');
  } catch (e) { console.error('[csdl-audio] cột fixv:', e.message); }
  tableReady = true;
}

const userHits = new Map();
let globalHits = [];
const recent = (arr, now) => arr.filter((t) => now - t < 3600e3);
function allow(uid) {
  const now = Date.now();
  globalHits = recent(globalHits, now);
  const u = recent(userHits.get(uid) || [], now);
  if (globalHits.length >= GLOBAL_PER_HOUR || u.length >= PER_USER_PER_HOUR) return false;
  u.push(now); globalHits.push(now); userHits.set(uid, u);
  if (userHits.size > 5000) for (const [k, v] of userHits) if (!recent(v, now).length) userHits.delete(k);
  return true;
}

const inflight = new Map();
let inserts = 0;

/** @returns {Promise<Buffer>} mp3. Ném Error có .code = 'rate_limited' | 'db_unavailable' | lỗi TTS. */
export async function getAudio(pool, { lessonId, seq, text, voice, uid, chargeUser = true, beforeGenerate = null }) {
  if (!pool || !tableReady) throw Object.assign(new Error('db_unavailable'), { code: 'db_unavailable' });
  const v = VOICES.includes(voice) ? voice : 'default';
  const [rows] = await pool.query('SELECT mp3, fixv FROM csdl_audio WHERE lesson_id = ? AND seq = ? AND voice = ?', [lessonId, seq, v]);
  const needsFix = !!(rows[0] && Number(rows[0].fixv) !== 1 && zhSpeechFix(text) !== text);
  if (rows[0] && !needsFix) return rows[0].mp3;
  const key = `${lessonId}|${seq}|${v}`;
  if (inflight.has(key)) return inflight.get(key);
  if (!allow(uid)) throw Object.assign(new Error('rate_limited'), { code: 'rate_limited' });
  if (beforeGenerate) await beforeGenerate(); // ngân sách người dùng (bài trong ngày thì miễn — nền tảng chịu)
  const p = (async () => {
    const mp3 = await synthesize(text, 'zh', v, { uid: chargeUser ? uid : null });
    await pool.query('INSERT INTO csdl_audio (lesson_id, seq, voice, mp3, fixv) VALUES (?,?,?,?,1) ON DUPLICATE KEY UPDATE mp3 = VALUES(mp3), fixv = 1', [lessonId, seq, v, mp3]);
    if (++inserts % 100 === 0) prune(pool).catch(() => {});
    return mp3;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function prune(pool) {
  const [[c]] = await pool.query('SELECT COUNT(*) AS n FROM csdl_audio');
  if (c.n <= MAX_ROWS) return;
  await pool.query('DELETE FROM csdl_audio ORDER BY created_at ASC LIMIT ?', [Math.ceil(MAX_ROWS * 0.2)]);
}
