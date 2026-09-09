# Đánh giá Workbook Bệnh Lý (đợt 2) + Yêu cầu xử lý lại

Ngày đánh giá: 2026-08-19 (nhập vào MySQL production 2026-09-09).
Workbook: [Bệnh Lý - Workbook nhập liệu](https://docs.google.com/spreadsheets/d/1_CdWvjAuc2cv20iPTrSkU64hXD-8-aJOO6gy4u6DfuE/edit)

## 1. Đã nhập vào hệ thống

2.156 thuật ngữ (bảng `pathology_terms`) + 154 quan hệ + 2.209 trích dẫn nguồn → MySQL bảng `anatomy_terms` (`domain='Bệnh lý'`). Tổng cộng với 30 mục TCM cổ điển soạn tay trước đó: **2.186 mục**.

## 2. Vấn đề chất lượng phát hiện được — CẦN XỬ LÝ LẠI

### 2.1. 90% mục không có nội dung (1.959/2.186 dòng)

Các dòng này chỉ có: tên (zh/pinyin/vi/en) + phân loại — **không có** `definition_short` (định nghĩa) lẫn `context_note` (bệnh nhân/bệnh cơ). Popup hiển thị gần như trống, chỉ có khung cảnh báo "cần xác thực".

**Mức độ hoàn thành theo từng chương** (đo bằng % dòng có nội dung):

| Chương (sách 内科学 第5版) | Số thuật ngữ | Có nội dung | Tỉ lệ |
|---|---|---|---|
| 1-12 Hệ hô hấp | 354 | 202 | **57%** ✅ tạm ổn |
| 13-20 Hệ tuần hoàn | 235 | 2 | 0.9% ❌ |
| 21-32 Hệ tiêu hoá | 383 | 3 | 0.8% ❌ |
| 33-37 Hệ tiết niệu | 176 | 2 | 1.1% ❌ |
| 38-44 Hệ huyết học | 224 | 0 | **0%** ❌❌ |
| 45-52 Nội tiết & Chuyển hoá | 297 | 0 | **0%** ❌❌ |
| 53-55 Thấp khớp | 104 | 0 | **0%** ❌❌ |
| 56-60 Hệ thần kinh | 218 | 3 | 1.4% ❌ |
| 61-65 Tổn thương lý hoá | 180 | 0 | **0%** ❌❌ |

**Nhận xét:** công cụ AI làm kỹ chương đầu tiên (Hô hấp) rồi càng về sau càng làm sơ sài — 4/9 chương hoàn toàn không có 1 câu nội dung nào dù đã tạo đủ tên gọi + trích dẫn nguồn (`pathology_term_occurrences` có sẵn câu gốc tiếng Trung cho MỌI dòng, chỉ là chưa được tổng hợp thành định nghĩa).

### 2.2. Cột Hán Việt riêng (`term_vi_hanviet`) trống 100%

Yêu cầu gốc trong prompt là điền cả 2 cột `term_vi_standard` (tiếng Việt y khoa chuẩn) VÀ `term_vi_hanviet` (âm Hán Việt riêng nếu khác). Công cụ chỉ điền cột đầu, bỏ trống hoàn toàn cột sau — **không xác nhận được** liệu có sự khác biệt Hán Việt nào bị bỏ sót hay không.

## 3. YÊU CẦU CỤ THỂ cho lần xử lý lại

Gửi lại đúng workbook Sheet ở trên (đã có sẵn khung + 2.156 dòng), yêu cầu công cụ:

1. **Ưu tiên 1 — điền `definition_short_zh/vi/en` cho 8 chương còn thiếu** (Tuần hoàn, Tiêu hoá, Tiết niệu, Huyết học, Nội tiết & Chuyển hoá, Thấp khớp, Thần kinh, Tổn thương lý hoá) — làm đúng chất lượng như đã làm với chương Hô hấp (57% có nội dung). Có thể lấy nguyên văn từ `pathology_term_occurrences.source_passage_zh` (đã có sẵn, kèm số chương/trang) làm cơ sở, không cần đọc lại toàn bộ sách từ đầu.
2. **Ưu tiên 2 — điền `context_note_zh/vi/en`** (bệnh nhân/bệnh cơ — 病因和发病机制) cho tối thiểu 399 dòng `term_type=DISEASE`, ưu tiên nhóm bệnh danh trước các loại thuật ngữ phụ (viết tắt, xét nghiệm...).
3. **Điền cột `term_vi_hanviet`** cho những thuật ngữ CÓ âm Hán Việt khác biệt rõ với cách gọi y khoa hiện đại (vd. nếu có; với đa số bệnh Tây y hiện đại có thể để trống nếu không có âm Hán Việt riêng, nhưng cần XÁC NHẬN đã xem xét từng dòng chứ không bỏ qua toàn bộ).
4. **Điền `pinyin`** cho các dòng còn thiếu (hiện ~1.959/2.156 dòng thiếu).
5. Sau khi điền xong, đánh dấu `review_status = REVIEWED` (thay vì `EXTRACTED`) cho các dòng đã hoàn thiện, để lần nhập sau phân biệt được dòng nào mới/đã xử lý.

## 4. Việc khác (không thuộc phạm vi workbook này)

- 10 nhóm chuyên khoa khác (Nhi khoa, Phụ khoa, Ngoại khoa, Ngũ quan khoa, Cốt thương khoa, Ôn bệnh, Thương hàn, Kim Quỹ...) hiện chỉ có 1-2 mục soạn tay, cần workbook RIÊNG cho từng cuốn giáo trình tương ứng (chưa làm).
- Bug hiển thị "null" khi thiếu pinyin đã được sửa ở phía Chimedis (không cần xử lý ở workbook).
