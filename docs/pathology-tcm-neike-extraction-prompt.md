# Prompt: Trích xuất & dịch nội dung Bệnh Lý Trung Y (Nội khoa) cho Chimedis

Tài liệu này dùng để đưa cho một công cụ AI/người khác đọc và điền dữ liệu vào workbook Google Sheet cho phần **Bệnh Lý liên quan Trung Y** của từ điển Chimedis (dict.chimedis.vn) — bổ sung cho phần Tây y (`内科学`) đã hoàn thành trước đó.

## Bối cảnh

Hạng mục "Bệnh Lý" của Chimedis hiện có 2.186 mục, nhưng **gần như toàn bộ là bệnh danh Tây y hiện đại** (từ giáo trình `内科学`), thiếu hẳn phần bệnh chứng biện chứng luận trị theo Trung Y. Nguồn cho đợt này: **`15. 中医内科学 第五版`** (Trung Y Nội Khoa Học, Nhà xuất bản Trung y dược Trung Quốc), file scan lưu trên Google Drive (`BOOK` → `3. Giáo trình Trung Y tiêu chuẩn` → `15. 中医内科学 第五版.pdf`).

**Khác biệt quan trọng so với đợt trước (`内科学` Tây y):** sách này biện chứng luận trị theo Trung Y — mỗi bệnh chứng thường có: định nghĩa → bệnh nhân bệnh cơ (病因病机) → **các thể bệnh/chứng hậu (辨证分型)**, mỗi thể có triệu chứng riêng + phép trị + phương thuốc đại diện. Đây là phần **giá trị nhất** cần trích xuất — không được bỏ qua để chỉ lấy mỗi định nghĩa như 1 số dòng ở đợt Tây y trước.

## Workbook

**`Bệnh Lý Trung Y (Nội khoa) - Workbook nhập liệu`**
→ https://docs.google.com/spreadsheets/d/18zyWAQcy2dXoZ_nqiri10MRcHm0JjKbTp7riySVTV6s/edit

Đã có sẵn 1 tab `pathology_tcm_terms` với header gợi ý (xem bảng cột bên dưới) + 1 tab `README` tóm tắt. **Có thể tự thiết kế lại cấu trúc bảng cho hợp lý hơn nếu cần** (thêm bảng quan hệ/trích dẫn riêng như đợt trước nếu thấy cần thiết) — miễn giữ đủ ý nghĩa dữ liệu mô tả bên dưới. Số lượng dòng: điền đúng theo số bệnh chứng thực có trong sách (thường 40-60 bệnh chứng theo các chương Nội khoa Trung Y chuẩn: Phế hệ bệnh chứng, Tâm hệ bệnh chứng, Tỳ Vị hệ bệnh chứng, Can Đởm hệ bệnh chứng, Thận Bàng quang hệ bệnh chứng, Khí Huyết Tân dịch bệnh chứng, Kinh lạc Chi thể bệnh chứng...) — không cần đúng số cố định, đủ là được.

## Cột cần điền

| Cột | Ý nghĩa | Ghi chú |
|---|---|---|
| `term_id` | Mã tự đặt, duy nhất | vd. `TCMNK-001` |
| `disease_zh` | Tên bệnh chứng gốc tiếng Trung | vd. `哮病` |
| `pinyin` | Pinyin có dấu thanh | vd. `xiàobìng` |
| `disease_vi_hanviet` | **Tên bệnh bằng ÂM HÁN VIỆT CHUẨN — BẮT BUỘC, quan trọng nhất cột này** | vd. 哮病→"Háo bệnh", 喘证→"Suyễn chứng", 心悸→"Tâm quý", 胸痹→"Hung tý", 眩晕→"Huyễn vựng", 中风→"Trúng phong", 消渴→"Tiêu khát", 郁证→"Uất chứng", 不寐→"Bất mị", 胃痛→"Vị thống", 泄泻→"Tiết tả", 黄疸→"Hoàng đản", 水肿→"Thuỷ thũng", 淋证→"Lâm chứng", 痹证→"Tý chứng", 痿证→"Nuy chứng". **KHÔNG dịch nghĩa thường** (vd. KHÔNG dịch 哮病 = "Bệnh hen" — phải là "Háo bệnh"). Nếu không chắc âm Hán Việt chính xác, tra theo từ điển Hán Việt chuẩn, không tự chế. |
| `disease_en` | Tên tiếng Anh (nếu có thuật ngữ TCM tiếng Anh chuẩn dùng trong tài liệu quốc tế, vd. "wheezing syndrome"; nếu không có, dùng mô tả ngắn) | |
| `chapter_ref` | Chương/tiết trong sách | Để tra cứu đối chiếu sau này |
| `definition_zh` / `_vi` / `_en` | **Định nghĩa** | Trích/paraphrase phần 概述 đầu mỗi bệnh chứng |
| `etiology_pathogenesis_zh` / `_vi` / `_en` | **Bệnh nhân — Bệnh cơ** (病因病机) | |
| `syndrome_differentiation_zh` / `_vi` / `_en` | **Thể bệnh (biện chứng)** — liệt kê CÁC THỂ/CHỨNG HẬU (辨证分型) của bệnh này, mỗi thể gồm: tên thể (Hán Việt) + đặc điểm chứng trạng phân biệt chính | **Đây là phần quan trọng nhất, không được bỏ trống nếu sách có mục 辨证论治**. Ví dụ format gợi ý: "① Phong hàn thúc phế: ho khan, đờm loãng trắng, sợ lạnh, rêu lưỡi trắng mỏng. ② Đàm nhiệt uất phế: ho đờm vàng dính, ngực đầy tức..." |
| `symptoms_treatment_zh` / `_vi` / `_en` | **Triệu chứng & Pháp trị** — với mỗi thể bệnh ở cột trên, nêu phép trị (治法) + tên bài thuốc đại diện (代表方) tương ứng | vd. "Phong hàn thúc phế: Pháp trị Tuyên phế tán hàn — dùng bài Tam ảo thang gia giảm." |
| `review_status` | `EXTRACTED` khi mới trích xong, đổi `REVIEWED` sau khi tự kiểm tra lại | |

## Quy tắc bắt buộc (rút kinh nghiệm từ đợt Tây y trước — ĐỌC KỸ)

1. **Cột tên bệnh PHẢI là âm Hán Việt chuẩn** — đây là điểm đợt trước công cụ khác bỏ sót hoàn toàn (bỏ trống 100%), lần này bắt buộc phải có vì đây là TCM đúng nghĩa.
2. **KHÔNG được chèn placeholder/ghi chú nội bộ dạng "NOT_VERIFIED — không đủ bằng chứng..." vào bất kỳ ô nội dung nào.** Nếu sách thực sự không có thông tin cho 1 cột, **để trống ô đó**, không viết câu giải thích tại sao trống.
3. **Không dùng lại NGUYÊN VĂN 1 câu tiếng Trung cho 2 cột khác nhau** (vd. `definition_zh` và `etiology_pathogenesis_zh` giống hệt nhau) rồi dịch riêng từng cột — nếu sách chỉ có 1 câu áp dụng cho cả 2 ý, chọn đặt vào ĐÚNG 1 cột phù hợp nhất và để cột kia trống, tránh tình trạng "định nghĩa" và "bệnh cơ" trùng nội dung nhưng bản dịch tiếng Anh lại khác nhau (lỗi thật đã phát hiện ở đợt Tây y).
4. **3 ngôn ngữ (zh/vi/en) của cùng 1 cột phải khớp nghĩa nhau** — dịch 1 lần, không dịch độc lập 2 lần cho cùng nội dung gốc.
5. **Không tự bịa nội dung y khoa** — mọi thông tin bắt nguồn từ chính văn bản sách `中医内科学`, không lấy từ kiến thức chung nếu sách ghi khác.
6. Mỗi ô nội dung súc tích, không cần chép nguyên văn dài dòng.
7. Bệnh chứng nào sách không đủ dữ liệu rõ ràng cho 1 cột thì để trống cột đó — không xoá dòng, không bịa thay thế.

## Sau khi hoàn thành

Không cần thao tác gì thêm trên GitHub/Drive — việc nhập vào hệ thống MySQL sẽ do phiên Claude Code khác thực hiện dựa trên đúng Sheet này khi được yêu cầu.
