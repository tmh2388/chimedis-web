/**
 * import-word-elements.js
 *
 * Reads backend/data/word-elements-raw.json — "Từ ghép Y Khoa" (English
 * medical prefix/suffix/root/compound-term vocabulary), extracted from a
 * standalone reference file (med-terms.html, "本草詞根") that was already
 * fully trilingual (zh/vi/en) — unlike herbs/anatomy, NO machine translation
 * is needed here, this is a straight import. Safe to re-run: existing rows
 * are updated, not duplicated (upsert on element_id).
 *
 * The raw JSON IS the source of truth going forward — edit
 * backend/data/word-elements-raw.json and re-run this script to update.
 *
 * Required env vars: MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
 *   (MYSQL_PORT optional, default 3306)
 *
 * Usage: node import-word-elements.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  const rawPath = path.join(__dirname, 'data', 'word-elements-raw.json');
  const items = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  console.log(`📖 Đọc ${items.length} mục từ word-elements-raw.json`);

  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
  });

  const byTypeCounter = {};
  const rows = items.map((it) => {
    byTypeCounter[it.t] = (byTypeCounter[it.t] || 0) + 1;
    const elementId = `we-${it.t}-${String(byTypeCounter[it.t]).padStart(3, '0')}`;
    return [
      elementId, it.t, it.sys || 'gen',
      it.en, it.ipa || null, it.zh || null, it.py || null, it.vi || null,
      it.meaning || null,
      it.ex || null, it.exZh || null, it.exVi || null, it.exIpa || null,
      true,
    ];
  });

  console.log(`📝 Đang ghi ${rows.length} mục vào MySQL (1 lệnh bulk insert)...`);
  if (rows.length > 0) {
    await conn.query(
      `INSERT INTO word_elements (
         element_id, element_type, organ_system,
         en, ipa, zh, py, vi,
         gloss,
         example_en, example_zh, example_vi, example_ipa,
         is_active
       ) VALUES ?
       ON DUPLICATE KEY UPDATE
         element_type=VALUES(element_type), organ_system=VALUES(organ_system),
         en=VALUES(en), ipa=VALUES(ipa), zh=VALUES(zh), py=VALUES(py), vi=VALUES(vi),
         gloss=VALUES(gloss),
         example_en=VALUES(example_en), example_zh=VALUES(example_zh), example_vi=VALUES(example_vi), example_ipa=VALUES(example_ipa),
         is_active=VALUES(is_active)`,
      [rows]
    );
  }

  await conn.execute(
    `INSERT INTO import_log (source_key, domain, spreadsheet_id, row_count) VALUES ('word_elements_v1', 'word_elements', ?, ?)
     ON DUPLICATE KEY UPDATE spreadsheet_id=VALUES(spreadsheet_id), row_count=VALUES(row_count), imported_at=CURRENT_TIMESTAMP`,
    ['local:med-terms.html', rows.length]
  );

  await conn.end();
  console.log('✅ Xong.');
}

run().catch((err) => { console.error(err); process.exit(1); });
