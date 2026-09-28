/**
 * review-acupoint-coredb-v2.mjs
 * Khảo sát HVYD Acupoint Core DB v2.0 (schema mới, mở rộng nhiều so với v1.1.2)
 * TRƯỚC khi quyết định cách nhập/cập nhật vào Chimedis. Đọc thẳng Sheets API
 * (KHÔNG dùng read_file_content — đã biết bug âm thầm cắt dòng với sheet lớn,
 * xem project_chimedis_acupoint_atlas.md).
 *
 * In ra: header + số dòng dữ liệu thật (đếm cột A không rỗng, KHÔNG tin
 * gridProperties.rowCount vì luôn đệm sẵn 1000).
 */
import { google } from 'googleapis';
import { createGoogleAuth } from './google-auth.js';
import fs from 'fs';

const SPREADSHEET_ID = '1k0A6WPfU8RHaZ8mK52lh8c93S3Iaaq7-2uTq0HctM9c';
const auth = createGoogleAuth(['https://www.googleapis.com/auth/spreadsheets.readonly']);
const sheets = google.sheets({ version: 'v4', auth });

const TABS = [
  'README', 'kb_acupoints', 'kb_acupoint_names', 'kb_acupoint_aliases',
  'kb_meridians', 'kb_acupoint_meridian_map', 'ref_acupoint_class_codes', 'kb_acupoint_class_map',
  'kb_acupoint_locations', 'ref_anatomical_landmarks', 'kb_location_landmark_map',
  'kb_acupoint_location_methods',
  'ref_action_codes', 'kb_acupoint_action_claims',
  'ref_indication_concepts', 'kb_acupoint_indication_claims', 'kb_acupoint_indication_items', 'kb_acupoint_indication_map',
  'kb_acupoint_anatomy_claims', 'kb_acupoint_procedure_claims', 'kb_acupoint_safety_rules',
  'ref_body_regions',
  'kb_atlas_assets', 'kb_atlas_markers',
  'kb_source_media_assets', 'kb_source_media_atlas_map', 'kb_source_media_acupoint_map',
  'kb_sources', 'kb_source_passages', 'kb_source_claims',
  'kb_ingestion_batches', 'table_registry', 'field_dictionary', 'relationship_registry',
];

async function main() {
  const out = {};
  for (const tab of TABS) {
    try {
      // Cột A (đủ để đếm số dòng thật không tin gridProperties) + 3 dòng đầu đủ cột để xem header/mẫu.
      const [colA, sample] = await Promise.all([
        sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${tab}!A:A` }),
        sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${tab}!A1:Z3` }),
      ]);
      const rows = colA.data.values || [];
      const nonEmpty = rows.filter((r) => r[0] !== undefined && r[0] !== '').length;
      out[tab] = {
        header: (sample.data.values && sample.data.values[0]) || [],
        sample_row2: (sample.data.values && sample.data.values[1]) || [],
        data_row_count: Math.max(0, nonEmpty - 1), // trừ header
      };
    } catch (e) {
      out[tab] = { error: e.message };
    }
  }
  const path = '/private/tmp/claude-501/-Users-mac-hvdq-chimedis/b2941e31-eca0-428d-bdb6-c36dc4200892/scratchpad/acupoint-coredb-v2-review.json';
  fs.writeFileSync(path, JSON.stringify(out, null, 2));
  for (const [tab, info] of Object.entries(out)) {
    if (info.error) { console.log(`❌ ${tab}: ${info.error}`); continue; }
    console.log(`\n=== ${tab} (${info.data_row_count} dòng dữ liệu) ===`);
    console.log('header:', info.header.join(' | '));
  }
  console.log('\n📄 Đã lưu chi tiết đầy đủ (kèm 1 dòng mẫu/tab):', path);
}
main().catch((e) => { console.error(e); process.exit(1); });
