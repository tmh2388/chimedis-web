# Prompt: Trích xuất & dịch nội dung Bệnh Lý cho Chimedis

Tài liệu này dùng để đưa cho một công cụ AI/người khác đọc và điền dữ liệu vào workbook Google Sheet cho hạng mục **Bệnh Lý** của từ điển Chimedis (dict.chimedis.vn).

## Bối cảnh

Chimedis là từ điển tra cứu thuật ngữ Trung Y (Việt/Trung/Anh). Hạng mục "Bệnh Lý" còn thiếu dữ liệu thật. Nguồn gốc: giáo trình chuẩn `内科学 第五版` (Nội khoa học, Nhà xuất bản Trung y dược Trung Quốc), file scan lưu trên Google Drive (`HVDQ_ConsultDB` → `3. Giáo trình Trung Y tiêu chuẩn` → `13. 内科学 第五版.pdf`).

## Workbook

**`Bệnh Lý - Workbook nhập liệu`**
→ https://docs.google.com/spreadsheets/d/1_CdWvjAuc2cv20iPTrSkU64hXD-8-aJOO6gy4u6DfuE/edit

Sheet đã có sẵn cột `organ_system_zh` (nhóm hệ cơ quan) và `hz` (tên bệnh/chương gốc tiếng Trung), liệt kê đủ 79 dòng theo đúng mục lục sách (9 phần: Hô hấp, Tuần hoàn, Tiêu hoá, Tiết niệu, Huyết học, Nội tiết-chuyển hoá, Thấp khớp, Thần kinh, Tổn thương lý hoá) — **KHÔNG cần thêm/bớt dòng**, chỉ điền các cột còn trống.

## Cột cần điền

| Cột | Ý nghĩa | Ghi chú |
|---|---|---|
| `py` | Pinyin có dấu thanh của tên bệnh (`hz`) | vd. `zhīqìguǎnyán` |
| `vi` | Tên bệnh bằng **ÂM HÁN VIỆT CHUẨN** | **BẮT BUỘC dùng âm Hán Việt, KHÔNG dịch nghĩa thường.** Ví dụ: 哮喘 → "Háo suyễn" (không phải "Khó thở"); 消渴 → "Tiêu khát" (không phải "Khát nhiều"). Bệnh y học hiện đại chưa có Hán Việt cố định thì giữ thuật ngữ y khoa chuẩn tiếng Việt đang dùng trong ngành, không dịch máy tuỳ tiện. |
| `en` | Tên bệnh tiếng Anh chuẩn y khoa | Thuật ngữ y khoa quốc tế chính thức (ICD/MeSH), không dịch từng chữ. |
| `definition_zh` / `_vi` / `_en` | **Định nghĩa** bệnh | Trích/paraphrase từ phần đầu mỗi chương/mục (thường có tiêu đề "概述"). |
| `etiology_zh` / `_vi` / `_en` | **Bệnh nhân — Bệnh cơ** (病因和发病机制) | |
| `syndrome_zh` / `_vi` / `_en` | **Thể bệnh / biện chứng** — nếu sách có phân thể lâm sàng, chứng hậu Trung Y, hoặc phân độ/giai đoạn | Sách không có mục này cho bệnh đó thì để trống, không tự bịa. |
| `symptoms_treatment_zh` / `_vi` / `_en` | **Triệu chứng lâm sàng & Nguyên tắc điều trị** | Gộp phần 临床表现 + 治疗 thành 1 đoạn súc tích, không cần chép nguyên phác đồ chi tiết. |
| `source_ref` | Đã điền sẵn (chương/tiết) | Chỉ tham khảo; nếu lệch số chương/tiết so với sách thật thì sửa lại. |
| `reviewed` | Đổi `TRUE` sau khi điền xong + tự kiểm tra | Chưa chắc chắn thì để `FALSE`. |

## Quy tắc bắt buộc

- **Cột `vi` phải dùng âm Hán Việt chuẩn TCM** cho thuật ngữ chuyên môn (tên bệnh, tên chứng, tên phép trị) — đây là từ điển học thuật, không phải dịch phổ thông.
- **Không tự bịa nội dung y khoa** — mọi thông tin phải bắt nguồn từ chính văn bản sách `内科学`, không lấy từ kiến thức chung nếu sách ghi khác.
- Mỗi ô nội dung nên súc tích (2-5 câu).
- 3 ngôn ngữ (zh/vi/en) của cùng 1 cột phải khớp nghĩa nhau (không phải 3 bản dịch độc lập lệch ý).
- Dòng nào không tìm thấy nội dung tương ứng rõ ràng thì để trống cột đó — không xoá dòng, không bịa thay thế.

## Sau khi hoàn thành

Không cần thao tác gì thêm trên GitHub/Drive — việc nhập vào hệ thống MySQL sẽ do phiên Claude Code khác thực hiện dựa trên đúng Sheet này khi được yêu cầu.
