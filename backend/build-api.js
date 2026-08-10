/**
 * build-api.js
 * Read from Google Sheets and generate JSON files for API
 * 
 * Usage:
 *   node build-api.js [--sheets-id=...] [--output=./public/data]
 * 
 * Environment variables needed:
 *   - GOOGLE_SHEETS_ID (required): Spreadsheet ID
 *   - GOOGLE_CREDENTIALS_JSON (required): Path to credentials.json from Google Cloud
 */

import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createGoogleAuth, hasGoogleCredentials } from './google-auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration
const SHEET_ID = process.env.GOOGLE_SHEETS_ID || '1wXldDsL7Zs3GYEXx7o1n3y7T1KHiWkasAgWNhBIUHaI';
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(__dirname, 'public', 'data');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Initialize Google Auth
const auth = createGoogleAuth(['https://www.googleapis.com/auth/spreadsheets.readonly']);

const sheets = google.sheets({ version: 'v4', auth });

function writePlaceholderData(reason) {
  console.warn(`⚠️  ${reason}`);
  console.warn('   Bỏ qua đồng bộ Google Sheets — ứng dụng sẽ dùng dữ liệu nhúng sẵn trong frontend cho tới khi được cấu hình.');
  console.warn('   Hướng dẫn kết nối: docs/google-sheets-setup.md');

  fs.writeFileSync(path.join(OUTPUT_DIR, 'terms.json'), JSON.stringify([], null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'groups.json'), JSON.stringify({ group1: [], group2: [] }, null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'metadata.json'), JSON.stringify({
    lastBuilt: new Date().toISOString(),
    totalTerms: 0,
    verified: 0,
    unverified: 0,
    version: '1.0.0',
    note: 'placeholder — Google Sheets chưa được cấu hình',
  }, null, 2));

  console.log('✅ Đã ghi dữ liệu placeholder (rỗng). Deploy tiếp tục bình thường.');
}

export async function buildAPI() {
  console.log('🔄 Starting API build from Google Sheets...');
  console.log(`📊 Sheet ID: ${SHEET_ID}`);
  console.log(`📁 Output: ${OUTPUT_DIR}`);

  if (!hasGoogleCredentials()) {
    writePlaceholderData('Không tìm thấy Google credentials (GOOGLE_CREDENTIALS_JSON_B64 / GOOGLE_CREDENTIALS_JSON đều trống, không có credentials.json).');
    return;
  }

  try {
    // 1. Fetch TERMS sheet
    console.log('\n📖 Fetching TERMS...');
    const termsResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'TERMS!A:Z',
    });

    const termsData = termsResponse.data.values || [];
    
    if (termsData.length === 0) {
      throw new Error('No data found in TERMS sheet');
    }

    const headers = termsData[0];
    console.log(`✅ Found ${termsData.length - 1} terms (headers: ${headers.length} columns)`);

    // Parse terms with proper index mapping
    const terms = termsData.slice(1).map((row, idx) => {
      // Map columns based on Google Sheet structure
      // Adjust indices if your sheet structure is different
      return {
        id: row[0] || `term_${idx + 1}`,
        hz: row[1] || '',           // Chinese
        py: row[2] || '',           // Pinyin
        vi: row[3] || '',           // Vietnamese
        en: row[4] || '',           // English
        group1: row[5] || '',       // Group 1 (e.g., Giải phẫu)
        group2: row[6] || '',       // Group 2 (e.g., Hệ hô hấp)
        vitri: row[7] || '',        // Location/Position
        vitri_cn: row[8] || '',
        congnang: row[9] || '',     // Function
        congnang_cn: row[10] || '',
        tcm: row[11] || '',         // TCM theory
        tcm_cn: row[12] || '',
        lamsang: row[13] || '',     // Clinical
        lamsang_cn: row[14] || '',
        nguon: row[15] || '',       // Source
        verify: row[16] !== '⚠️ Cần xác thực', // Flag if verified
        verify_note: row[17] || '', // Verification note
        cn_machine: row[18] === 'true' || row[18] === true, // Machine translated flag
      };
    }).filter(t => t.hz); // Filter out empty rows

    console.log(`✅ Parsed ${terms.length} valid terms`);

    // 2. Extract statistics
    const verified = terms.filter(t => t.verify === true).length;
    const unverified = terms.length - verified;
    const group1List = [...new Set(terms.map(t => t.group1))];
    const group2List = [...new Set(terms.map(t => t.group2))];

    console.log(`   - Verified: ${verified}`);
    console.log(`   - Unverified: ${unverified}`);
    console.log(`   - Group1 categories: ${group1List.length}`);
    console.log(`   - Group2 categories: ${group2List.length}`);

    // 3. Write JSON files
    console.log('\n📝 Writing output files...');

    // terms.json
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'terms.json'),
      JSON.stringify(terms, null, 2),
      'utf8'
    );
    console.log(`✅ Wrote terms.json (${terms.length} terms)`);

    // groups.json
    const groups = {
      group1: group1List.sort(),
      group2: group2List.sort(),
    };
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'groups.json'),
      JSON.stringify(groups, null, 2),
      'utf8'
    );
    console.log(`✅ Wrote groups.json`);

    // metadata.json
    const metadata = {
      lastBuilt: new Date().toISOString(),
      totalTerms: terms.length,
      verified: verified,
      unverified: unverified,
      categories: {
        group1: group1List.length,
        group2: group2List.length,
      },
      version: '1.0.0',
    };
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'metadata.json'),
      JSON.stringify(metadata, null, 2),
      'utf8'
    );
    console.log(`✅ Wrote metadata.json`);

    console.log('\n✨ API build completed successfully!');
    console.log(`\n📊 Summary:`);
    console.log(`   Total terms: ${terms.length}`);
    console.log(`   Verified: ${verified} (${Math.round(verified/terms.length*100)}%)`);
    console.log(`   Unverified: ${unverified} (${Math.round(unverified/terms.length*100)}%)`);
    console.log(`   Groups: ${group1List.length} primary, ${group2List.length} secondary`);
    console.log(`   Built at: ${new Date().toLocaleString()}`);

  } catch (error) {
    console.error('❌ Build failed:');
    console.error(`   Error: ${error.message}`);

    if (error.message.includes('ENOENT')) {
      console.error('\n💡 Tip: credentials.json not found.');
      console.error('   1. Download from Google Cloud Console');
      console.error('   2. Place in backend/ folder');
      console.error('   3. Set GOOGLE_CREDENTIALS_JSON env var if using different path');
    }

    throw error;
  }
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  buildAPI().catch(() => process.exit(1));
}
