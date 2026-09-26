/**
 * setup-tcm-neike-workbook.mjs
 * Tạo khung tối thiểu (tab hướng dẫn + tab dữ liệu với header gợi ý) cho workbook
 * "Bệnh Lý Trung Y (Nội khoa) - Workbook nhập liệu" — công cụ AI khác sẽ đọc
 * 15. 中医内科学 第五版.pdf và tự thiết kế/mở rộng cấu trúc nếu cần (kinh nghiệm
 * từ workbook Tây y trước: công cụ tự thiết kế lại tốt hơn khung cứng ban đầu),
 * nhưng cần có sẵn 1 tab để không bắt đầu từ hoàn toàn trống.
 */
import { google } from 'googleapis';
import { createGoogleAuth } from './google-auth.js';

const SPREADSHEET_ID = '18zyWAQcy2dXoZ_nqiri10MRcHm0JjKbTp7riySVTV6s';
const auth = createGoogleAuth(['https://www.googleapis.com/auth/spreadsheets']);
const sheets = google.sheets({ version: 'v4', auth });

const HEADERS = [
  'term_id', 'disease_zh', 'pinyin', 'disease_vi_hanviet', 'disease_en',
  'chapter_ref', 'definition_zh', 'definition_vi', 'definition_en',
  'etiology_pathogenesis_zh', 'etiology_pathogenesis_vi', 'etiology_pathogenesis_en',
  'syndrome_differentiation_zh', 'syndrome_differentiation_vi', 'syndrome_differentiation_en',
  'symptoms_treatment_zh', 'symptoms_treatment_vi', 'symptoms_treatment_en',
  'review_status',
];

async function main() {
  // Đổi tên Sheet1 -> pathology_tcm_terms, thêm 1 sheet hướng dẫn.
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const firstSheetId = meta.data.sheets[0].properties.sheetId;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        { updateSheetProperties: { properties: { sheetId: firstSheetId, title: 'pathology_tcm_terms' }, fields: 'title' } },
        { addSheet: { properties: { title: 'README' } } },
      ],
    },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: 'pathology_tcm_terms!A1',
    valueInputOption: 'RAW',
    requestBody: { values: [HEADERS] },
  });

  const readme = [
    ['Xem đầy đủ yêu cầu tại: docs/pathology-tcm-neike-extraction-prompt.md trong repo tmh2388/chimedis-web'],
    [''],
    ['Nguồn: 15. 中医内科学 第五版.pdf (Drive > BOOK > 3. Giáo trình Trung Y tiêu chuẩn)'],
    [''],
    ['Có thể tự thiết kế lại cấu trúc bảng nếu hợp lý hơn (như lần workbook Bệnh Lý Tây y trước) —'],
    ['miễn là giữ đủ ý nghĩa 4 field: Định nghĩa / Bệnh nhân-Bệnh cơ / Thể bệnh (biện chứng) / Triệu chứng & Pháp trị,'],
    ['và cột tên bệnh bằng ÂM HÁN VIỆT CHUẨN (bắt buộc, xem chi tiết trong prompt).'],
  ];
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: 'README!A1',
    valueInputOption: 'RAW',
    requestBody: { values: readme },
  });

  console.log('✅ Đã tạo khung workbook:', `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`);
}
main().catch((e) => { console.error(e); process.exit(1); });
