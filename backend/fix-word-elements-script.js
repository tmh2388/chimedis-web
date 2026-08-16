/**
 * fix-word-elements-script.js
 *
 * One-off repair: nguồn gốc dữ liệu domain "Từ ghép Y Khoa" (med-terms.html,
 * 本草詞根) được soạn bằng chữ Hán PHỒN THỂ trong cột `zh` và `example_zh` —
 * khác với Dược liệu/Giải phẫu vốn lưu GIẢN THỂ làm dạng chính (xem
 * hz_traditional ở herbs, và frontend hzOf()/toTraditional() giả định `hz`
 * luôn là giản thể). Script này chuyển `zh`/`example_zh` về giản thể để
 * nhất quán quy ước trên toàn hệ thống, cho phép nút "Chữ Hán hiển thị"
 * (giản thể/phồn thể) trong app hoạt động đúng cho domain này.
 *
 * Bảng chuyển đổi: rút gọn từ opencc-js TSCharacters (phồn thể -> giản thể,
 * theo từng ký tự, không xử lý ngữ cảnh cụm từ — đủ dùng cho glosses/ví dụ
 * ngắn ở domain này).
 *
 * An toàn để chạy lại nhiều lần (idempotent — ký tự đã là giản thể sẽ không
 * đổi gì thêm khi chạy lại, vì bảng map theo phồn thể không khớp).
 *
 * Cần env vars: MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
 * (MYSQL_PORT optional).
 *
 * Usage: node fix-word-elements-script.js
 */
import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const T2S_RAW = fs.readFileSync(path.join(__dirname, 'data', 'han-t2s.txt'), 'utf8');

const t2sMap = new Map();
T2S_RAW.split('|').forEach(pair => {
  const [t, s] = pair.split(' ');
  if (t && s) t2sMap.set(t, s);
});

function toSimplified(str) {
  if (!str) return str;
  let out = '';
  for (const ch of str) out += (t2sMap.get(ch) || ch);
  return out;
}

async function main() {
  const pool = mysql.createPool({
    host: process.env.MYSQL_HOST,
    port: process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    connectionLimit: 5,
  });

  const [rows] = await pool.query('SELECT element_id, zh, example_zh FROM word_elements');
  console.log(`📖 Đang xử lý ${rows.length} mục Từ ghép Y Khoa...`);

  let updated = 0;
  let unchanged = 0;
  for (const r of rows) {
    const newZh = toSimplified(r.zh);
    const newExampleZh = toSimplified(r.example_zh);
    if (newZh === r.zh && newExampleZh === r.example_zh) {
      unchanged++;
      continue;
    }
    await pool.execute(
      'UPDATE word_elements SET zh=?, example_zh=? WHERE element_id=?',
      [newZh, newExampleZh, r.element_id]
    );
    updated++;
    if (updated % 200 === 0) console.log(`   ${updated}/${rows.length}`);
  }

  await pool.end();
  console.log(`✅ Đã chuyển ${updated} mục sang giản thể (${unchanged} mục đã sẵn giản thể, không đổi).`);
}

main().catch((err) => { console.error(err); process.exit(1); });
