# Kế hoạch: Thêm Thang Phương + gate "đăng nhập & Like fanpage"

Soạn: 2026-09-10. Trạng thái: **KẾ HOẠCH — chưa code gì.**

---

## Phần 0 — Nguồn dữ liệu: ĐÃ CHỐT = Formula Core DB **v2.0.0 Clean Baseline**

User chỉ định (2026-09-10): dùng bản **v2.0**, folder Drive `122DfmLtVqnA426YeWmC-crRvdAjB17NC`.
Sheet chính: **`HVYD Formula Core DB v2.0.0｜Clean Baseline`** (id `1cuGEQV7wAZ-ldl8tRQsbDYk2WS5cbXvepTuvo0hRf7w`, 15 tab). Bản v1.2.0 (`1GewEcHcz8...`, 37 bài) coi như LEGACY, bỏ.

**Tình trạng dữ liệu v2.0.0 (đã đo trực tiếp):**
| Tab | Số dòng có data | Ghi chú |
|---|---|---|
| `kb_formulas` | **451** | Đủ tên zh / pinyin / vi / en (tất cả `AI_TRANSLATED`, `review_status=EXTRACTED`) — cỡ 1 cuốn 方剂学 đầy đủ |
| `kb_formula_versions` | 451 | 1:1 với kb_formulas |
| `kb_formula_ingredients` | 1.199 | chỉ phủ **189/451** phương (42%) có danh sách thành phần |
| `kb_source_claims` | 1.199 | công dụng/chủ trị/phương giải/vận dụng — có `text_vi`/`text_en`/`text_pinyin` (phủ 1 phần) |
| `kb_formula_safety_rules` | 72 | rất ít phương có kiêng kỵ |
| `kb_formula_aliases` / `classification_map` / `relations` | 34 / 450 / 215 | tên khác, phân loại (loại phương), quan hệ (phụ phương...) |

**Kết luận:** v2 tốt hơn v1.2.0 nhiều (451 vs 37 tên phương) nhưng **nội dung vẫn từng phần** — ~42% có thành phần, ít hơn có công dụng/chủ trị đầy đủ, ~15% có kiêng kỵ. Toàn bộ `EXTRACTED` / `INTERNAL_QA_ONLY` / `NOT_RELEASED`, bản dịch vi/en đều `AI_TRANSLATED` (chưa human review). → Đưa vào dạng **đợt 1**, `verify=TRUE` + `machine_translated=TRUE` (UI hiện "cần rà soát"); phương chưa có thành phần vẫn hiện tên + phân loại (giống cách xử lý Bệnh Lý đợt 2).

---

## Phần 1 — Đưa Thang Phương vào từ điển (kỹ thuật, ~mô hình đã có sẵn)

Tái dùng đúng pattern đã làm cho Huyệt vị / Bệnh Lý:

1. **Schema** — bảng mới `formulas` trong `backend/db/schema.sql` (denormalized "dictionary view", 1 dòng/thang):
   - `formula_id` PK, `name_zh`/`name_zh_traditional`/`name_vi`/`name_en`/`py`
   - `formula_type_zh/vi/en` (loại phương — giải biểu/thanh nhiệt/...), `origin_zh/vi/en` (xuất xứ/triều đại)
   - `composition_zh/vi/en` (thành phần + liều — nối từ `kb_formula_ingredients`)
   - `functions_zh/vi/en` (công năng — từ `kb_formula_action_map`)
   - `indications_zh/vi/en` (chủ trị — từ `kb_formula_indication_claims`)
   - `analysis_zh/vi/en` (phương giải 方解 — nếu nguồn có)
   - `cautions_zh/vi/en` (kiêng kỵ — từ `kb_formula_safety_rules`)
   - `source`, `machine_translated`, `verify`, `verify_note`, `is_active`, `updated_at`
2. **Import script** `backend/import-formula-sheets.js` — đọc thẳng Formula Core DB qua Google Sheets API (giống `import-herbal-sheets.js`), join các tab con → 1 dòng/thang, ghi MySQL. Env var mới: `GOOGLE_FORMULA_CORE_SPREADSHEET_ID`.
3. **server.js** — thêm `getFormulaTerms()` + `formulaRowToTerm()` map sang shape `/api/terms` chung (`group1: 'Thang phương'`, `group2: formula_type_zh` làm khoá lọc), thêm vào mảng gộp trong `GET /api/terms`.
4. **Frontend `index.html`** — "Thang phương" đã có sẵn trong `GROUP1()` (tự hiện khi có data). Cần: nhánh popup riêng cho `category: 'formula'` (layout giống Dược liệu: Thành phần / Công năng / Chủ trị / Phương giải / Kiêng kỵ), dropdown 2 lọc theo loại phương (data-driven, giống Dược liệu).
5. `verify=TRUE` + `machine_translated=TRUE` cho toàn bộ (nguồn đang EXTRACTED, chưa rà soát) → UI tự hiện ghi chú "cần rà soát".

**Ước lượng:** ~1 phiên làm việc nếu nguồn rõ ràng. Không phụ thuộc phần gate bên dưới.

---

## Phần 2 — Gate "đăng nhập + Like fanpage" (phần anh cần kế hoạch nhất)

### 2a. Sự thật kỹ thuật về "Like fanpage"

**Không có cách nào để hệ thống tự kiểm chứng một người đã Like/Follow một Fanpage Facebook.** Meta đã bỏ quyền `user_likes` và **cấm "like-gating"** từ 2014–2015; các endpoint Graph API để check việc này đã bị gỡ. Facebook Login của Chimedis hiện cũng chưa dùng được cho user thường (app còn ở chế độ Development — xem [[project_chimedis_user_auth]]). → Bắt buộc dùng cơ chế **tin tưởng (honor-system)** hoặc **mã mở khoá**, không thể "xác minh thật".

### 2b. 3 phương án gate (chọn 1)

| | Cách hoạt động | Ưu | Nhược |
|---|---|---|---|
| **A. Mã mở khoá (đề xuất)** | Đăng 1 bài ghim trên Fanpage có chứa "mã mở khoá Thang Phương" (vd. `HVYD-THANG-PHUONG`). User đăng nhập → màn khoá hiện nút "Mở Fanpage" + ô nhập mã → nhập đúng → mở vĩnh viễn (lưu server theo `firebase_uid`). | User phải thật sự vào Fanpage mới lấy được mã → ràng buộc lỏng nhưng CÓ thật. Đổi mã bất cứ lúc nào (sửa env var + bài ghim). | Mã có thể bị chia sẻ ngoài Fanpage. |
| **B. Honor-system thuần** | Đăng nhập → màn khoá: nút "Đã Like Fanpage — Mở khoá" + link tới Fanpage. Bấm là mở, không kiểm tra gì. | Không ma sát, code đơn giản nhất. | Không ràng buộc gì với việc Like thật. |
| **C. Kết hợp A+B** | Hiện cả link Fanpage + ô mã (bắt buộc) + checkbox "Tôi xác nhận đã Like" (bắt buộc tick). | Vừa có ràng buộc mã, vừa nhắc trách nhiệm. | Nhiều bước hơn 1 chút. |

**Đề xuất: A** (hoặc C nếu muốn "nghi thức" rõ hơn). Cả 3 đều lưu trạng thái mở khoá **phía server** (không chỉ localStorage — tránh bị bỏ qua bằng cách xoá cache).

### 2c. Kỹ thuật triển khai gate

1. **MySQL** — thêm bảng chung cho mọi domain gate tương lai (không chỉ Thang Phương):
   ```sql
   CREATE TABLE user_domain_unlocks (
     user_id     INT NOT NULL,
     domain_key  VARCHAR(32) NOT NULL,   -- 'thang_phuong'
     unlocked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
     method      VARCHAR(16),            -- 'code' | 'honor'
     PRIMARY KEY (user_id, domain_key),
     FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
   );
   ```
2. **Backend `server.js`**:
   - `POST /api/gate/unlock` `{ domain_key, code }` — yêu cầu Firebase token; nếu `domain_key='thang_phuong'` và `code === process.env.THANG_PHUONG_UNLOCK_CODE` (hoặc phương án B: không cần code) → insert `user_domain_unlocks` → trả `{ unlocked: true }`.
   - `GET /api/gate/status` — trả danh sách `domain_key` user đã mở.
   - **`GET /api/terms`**: nếu request KHÔNG kèm Firebase token hợp lệ HOẶC user chưa mở `thang_phuong` → **lọc bỏ toàn bộ** `t.group1 === 'Thang phương'` khỏi kết quả (để nội dung không bị crawl khi chưa mở khoá). Đây là điểm khác biệt quan trọng: các domain khác vẫn trả bình thường không cần đăng nhập.
   - Env var mới trên Hostinger: `THANG_PHUONG_UNLOCK_CODE` (phương án A/C).
3. **Frontend `index.html`**:
   - Khi `state.group1 === 'Thang phương'` và chưa mở khoá → render "màn khoá" thay cho danh sách:
     - Chưa đăng nhập: nút "Đăng nhập để xem Thang Phương" (mở modal auth có sẵn).
     - Đã đăng nhập, chưa mở: nút "Mở Fanpage Hạ Vân Y Đạo" (link `https://facebook.com/<fanpage>`) + ô nhập mã + nút "Mở khoá" → gọi `POST /api/gate/unlock`.
   - Sau khi mở khoá: lưu cờ vào `state` + localStorage (cache), luôn re-check với server khi đăng nhập.
   - Khi CHƯA mở khoá: cũng ẩn "Thang phương" khỏi kết quả tìm kiếm "Toàn bộ" (client tự lọc, khớp với server).
4. **Fanpage** — anh cần: (1) URL Fanpage chính thức, (2) tạo bài ghim chứa mã (phương án A/C), (3) quyết định nội dung mã.

**Ước lượng:** ~1 phiên. Cần anh cung cấp: URL Fanpage + nội dung mã mở khoá + chọn phương án A/B/C.

---

## Phần 3 — Thứ tự đề xuất

1. Anh xác nhận **nguồn dữ liệu Thang Phương** (Phần 0) + **chọn phương án gate** (2b) + cung cấp **URL Fanpage/mã**.
2. Claude làm Phần 1 (đưa data vào) — chạy được độc lập, kể cả khi chưa có gate (tạm để `is_active=FALSE` hoặc chưa bật group cho tới khi gate xong).
3. Claude làm Phần 2 (gate) — chạy schema mới trên production (anh chạy, theo quy trình Remote MySQL ở [[reference_chimedis_infra]]), set env var, redeploy.
4. Anh tự kiểm tra trên chimedis.vn: đăng nhập → màn khoá → nhập mã → thấy Thang Phương.

---

## Ghi chú

- Sau khi HOÀN TẤT Thang Phương, **quay lại Bệnh Lý** — đang chờ công cụ AI khác điền tiếp workbook (8/9 chương Nội khoa gần như trống, xem `docs/pathology-workbook-assessment.md`).
- Facebook App vẫn ở chế độ Development — nếu sau này muốn dùng chính Facebook Login làm gate (thay vì mã), phải chuyển app sang Live trước, và vẫn KHÔNG check được việc Like (chỉ biết user đã đăng nhập bằng FB).
