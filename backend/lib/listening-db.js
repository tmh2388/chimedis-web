/**
 * listening-db.js — bài Luyện nghe lưu trong MySQL (thêm/sửa/xoá bài KHÔNG cần đẩy code → KHÔNG phải redeploy Hostinger).
 *
 * Bài trong thư mục data/listening (file JSON, âm thanh ở public/audio/listening) vẫn chạy như cũ.
 * Bài trong MySQL được gộp vào cùng danh sách (trùng id → bản MySQL thắng). Danh sách giữ trong bộ nhớ (làm mới sau mỗi lần
 * ghi và mỗi 60 giây) nên các hàm đọc vẫn đồng bộ, không đổi cách route cũ gọi.
 * Âm thanh mp3 lưu MEDIUMBLOB theo đường dẫn tương đối "<category>/<id>/[giọng/]NN-<lang>.mp3".
 */
const LESSON_ID_RE = /^[A-Za-z0-9_-]{3,80}$/;
const CATEGORY_RE = /^[a-z0-9_]{2,40}$/;
const AUDIO_PATH_RE = /^[a-z0-9_]{2,40}\/[A-Za-z0-9_-]{3,80}\/([a-z0-9_]{1,20}\/)?\d{1,3}-[a-z_]{2,12}\.mp3$/;

let lessons = new Map();      // id → data
let audioPaths = new Set();   // đường dẫn tương đối có trong MySQL
let timer = null;

export async function ensureTables(pool) {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS listening_lessons (
    id VARCHAR(80) NOT NULL PRIMARY KEY, category VARCHAR(40) NOT NULL, data_json MEDIUMTEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, KEY idx_cat (category)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS listening_audio (
    path VARCHAR(190) NOT NULL PRIMARY KEY, mp3 MEDIUMBLOB NOT NULL, size INT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await refresh(pool);
  if (!timer) { timer = setInterval(() => refresh(pool).catch(() => {}), 60000); timer.unref && timer.unref(); }
}

export async function refresh(pool) {
  const [rows] = await pool.query('SELECT id, category, data_json FROM listening_lessons');
  const m = new Map();
  for (const r of rows) { try { const d = JSON.parse(r.data_json); d.id = r.id; d.category = r.category; m.set(r.id, d); } catch (_) { /* bỏ bản hỏng */ } }
  lessons = m;
  const [ap] = await pool.query('SELECT path FROM listening_audio');
  audioPaths = new Set(ap.map((x) => x.path));
}

export const dbLessons = (category) => [...lessons.values()].filter((d) => !category || d.category === category);
export const dbLesson = (id) => lessons.get(String(id)) || null;
export const hasDbAudio = (rel) => audioPaths.has(rel);

export async function getAudio(pool, rel) {
  if (!AUDIO_PATH_RE.test(rel) || !audioPaths.has(rel)) return null;
  const [rows] = await pool.query('SELECT mp3 FROM listening_audio WHERE path = ?', [rel]);
  return rows.length ? rows[0].mp3 : null;
}

/** lesson: object bài (đúng định dạng file JSON hiện có); audio: { "<đường dẫn tương đối>": base64 } */
export async function upsert(pool, lesson, audio = {}) {
  if (!lesson || !LESSON_ID_RE.test(String(lesson.id || ''))) throw Object.assign(new Error('bad_id'), { code: 'bad_request' });
  if (!CATEGORY_RE.test(String(lesson.category || ''))) throw Object.assign(new Error('bad_category'), { code: 'bad_request' });
  if (!Array.isArray(lesson.segments) || !lesson.segments.length) throw Object.assign(new Error('no_segments'), { code: 'bad_request' });
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const data = { ...lesson, created_at: lesson.created_at || now, updated_at: now };
  let n = 0;
  for (const [rel, b64] of Object.entries(audio || {})) {
    if (!AUDIO_PATH_RE.test(rel) || !rel.startsWith(`${lesson.category}/${lesson.id}/`)) throw Object.assign(new Error('bad_audio_path:' + rel), { code: 'bad_request' });
    const buf = Buffer.from(String(b64 || ''), 'base64');
    if (buf.length < 200) throw Object.assign(new Error('audio_too_small:' + rel), { code: 'bad_request' });
    await pool.query('INSERT INTO listening_audio (path, mp3, size) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE mp3 = VALUES(mp3), size = VALUES(size)', [rel, buf, buf.length]);
    n++;
  }
  await pool.query('INSERT INTO listening_lessons (id, category, data_json) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE category = VALUES(category), data_json = VALUES(data_json)', [data.id, data.category, JSON.stringify(data)]);
  await refresh(pool);
  return { id: data.id, audio_saved: n };
}

export async function remove(pool, id) {
  const lesson = lessons.get(String(id)); if (!lesson) return { deleted: 0 };
  await pool.query('DELETE FROM listening_audio WHERE path LIKE ?', [`${lesson.category}/${lesson.id}/%`]);
  await pool.query('DELETE FROM listening_lessons WHERE id = ?', [lesson.id]);
  await refresh(pool);
  return { deleted: 1 };
}
export { AUDIO_PATH_RE };
