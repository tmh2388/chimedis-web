#!/usr/bin/env node
/**
 * Đẩy một bài Luyện nghe (JSON + mp3) lên máy chủ — KHÔNG cần commit/redeploy.
 *   LESSON_PUSH_KEY=... node backend/push-listening-lesson.mjs <file-bài.json> [thư-mục-audio] [https://dict.chimedis.vn]
 * thư-mục-audio mặc định: backend/public/audio/listening/<category>/<id> (chứa NN-<lang>.mp3 và thư mục giọng như aoede/).
 * Xoá bài:  LESSON_PUSH_KEY=... node backend/push-listening-lesson.mjs --delete <id> [https://dict.chimedis.vn]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const key = process.env.LESSON_PUSH_KEY;
if (!key) { console.error('Thiếu biến môi trường LESSON_PUSH_KEY'); process.exit(1); }
const args = process.argv.slice(2);
if (args[0] === '--delete') {
  const base = args[2] || 'https://dict.chimedis.vn';
  const r = await fetch(`${base}/api/admin/listening/lesson/${encodeURIComponent(args[1])}`, { method: 'DELETE', headers: { 'x-lesson-key': key } });
  console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1);
}
const [file, audioDirArg, baseArg] = args;
if (!file) { console.error('Dùng: node backend/push-listening-lesson.mjs <bài.json> [thư-mục-audio] [url]'); process.exit(1); }
const lesson = JSON.parse(fs.readFileSync(file, 'utf8'));
const audioDir = audioDirArg && !audioDirArg.startsWith('http') ? audioDirArg : path.join(here, 'public', 'audio', 'listening', lesson.category, lesson.id);
const base = [audioDirArg, baseArg].find((x) => x && x.startsWith('http')) || 'https://dict.chimedis.vn';
const audio = {};
const walk = (dir, rel) => {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (f.isDirectory()) walk(path.join(dir, f.name), `${rel}${f.name}/`);
    else if (f.name.endsWith('.mp3')) audio[`${lesson.category}/${lesson.id}/${rel}${f.name}`] = fs.readFileSync(path.join(dir, f.name)).toString('base64');
  }
};
walk(audioDir, '');
console.log(`Đẩy ${lesson.id}: ${lesson.segments.length} câu, ${Object.keys(audio).length} file âm thanh → ${base}`);
const r = await fetch(`${base}/api/admin/listening/lesson`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-lesson-key': key }, body: JSON.stringify({ lesson, audio }) });
console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1);
