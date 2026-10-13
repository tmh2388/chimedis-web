# Ghi nhớ kỹ thuật: UX app, nghe offline, duyệt/sửa thuật ngữ (cập nhật 2026-10-13)

Tài liệu này là "bộ nhớ" của dự án trên GitHub — các phiên Claude đọc trước khi sửa (xem cả `docs/SESSIONS.md`).

## Cử chỉ & điều hướng toàn app (frontend/index.html: `appBack`, `appForward`, `initSwipeNav`)
- **Vuốt từ MÉP TRÁI** (≤28 px) = lùi một bước; **từ MÉP PHẢI** = tiến lại bước vừa lùi (chữ ký trạng thái `navSig`, hết hạn khi người dùng đổi chỗ khác).
- **Giữa màn hình**: thẻ ôn tập — trái = thẻ kế, phải = thẻ trước; popup thuật ngữ — ngang = từ kế/trước (sẵn có), vuốt xuống = đóng.
- Thứ tự lùi: hộp xác nhận → trình sửa → danh sách nhóm → popup → màn duyệt/cài đặt/thanh toán/Lão Sư/admin/đăng nhập/menu → khu vực (nghe/ôn luyện/yêu thích/lọc nhóm/tìm kiếm) → trang chủ.
- ⚠ Luyện nghe / Ôn luyện / Yêu thích đặt `state.group1 = <SENTINEL>`: rời khu vực phải `selectGroup1('all')`, không chỉ đổi `state.tab` (lỗi "0 từ" đã gặp).
- Popup bỏ qua cử chỉ bắt đầu ở mép (dành cho lùi/tiến toàn app).
- Lớp nổi: `.pp-overlay.show` 5600 < `.gs-overlay` 5700 < `.up-scrim` 5800 < bottom-sheet 2147482000.

## Nghe offline & Cài đặt hệ thống
- IndexedDB `chimedis_offline/kv`: `aud:<url>` (mp3), `dlg:<id>` (văn bản bài), `offaud:index`, `terms`, `fig:*`, `meta`.
- Nút tải/xoá bài (icon cạnh ■ và ở thẻ danh sách), xoá luôn có xác nhận bottom-sheet. Hạn mức 100/300/500/1000 MB (`chimedis_offaud_cap_mb`).
- Menu ☰ → **Cài đặt hệ thống**: thanh dung lượng, xoá có chọn, giải phóng bộ nhớ, tuỳ chọn tải/giọng/ngôn ngữ trả lời, kiểm tra cập nhật.
- Màn "đang cập nhật" (logo + %) chặn thao tác khi live update tải bản mới (`luShow/luHide`); quá 90 s thì nhả.

## Chấm giọng nói (một bản phiên âm chuẩn)
- `backend/lib/speech.js`: whisper-1 (nhận ngôn ngữ + điểm không-có-tiếng-nói) → gpt-4o-transcribe; kho `speech_transcripts` theo SHA-256 âm thanh; `speech_analysis_cache`.
- Chấm nhanh nhận ngôn ngữ nói zh/vi/en rồi đối chiếu đúng bản tham chiếu; phân tích AI KHÔNG phiên âm lại, chỉ đánh giá + `issues`; hiện chi phí từng lượt.

## Từ báo sai → admin sửa ngay trong app
- Người dùng: nút ☆ ở MỌI thuật ngữ; biểu mẫu điền sẵn bản hiện tại (chữ Hán, Việt, Anh, định nghĩa Việt/Trung/Anh), chỉ gửi ô đã sửa. Bảng `term_feedback` (có `suggested_hz`, `suggested_def[_zh|_en]`).
- Admin: ☰ → "Từ vựng báo sai" (huy hiệu số, làm mới mỗi lần mở menu + 40 s), trình sửa bottom-sheet TRƯỚC→SAU. Chỉ admin; `adminOnly`.
- Lưu: **một giao dịch MySQL** — khoá hàng, ghi (`general_terms` / `anatomy_terms`: hz, py tự tính, vi, en, position_vi/zh/en, verify=1, machine_translated=0), nhật ký `term_edit_log` (trước/sau), đóng báo cáo. Bảng khác (dược liệu, huyệt…) → `term_overrides` (hz/vi/en), áp lúc trả `/api/terms`.
- Ràng buộc: hz chỉ chữ Hán; trùng `uq_general_hz` → báo `hz_exists`; định nghĩa của nhóm không phải anatomy/general chưa sửa được ở đây.

## Việc còn mở
- Định nghĩa của nhóm Dược liệu/Huyệt vị/Từ ghép (trường riêng) — chưa có trình sửa.
- Tải nền thật khi tắt app (cần plugin Background Transfer gốc).
- Workbench nên đọc `general_terms` thay vì ảnh chụp JSON (xem INFRA-shared-terminology.md).

## Chấm nhanh nhiều chiều (v50, 2026-10-13)
- Mục tiêu: chấm **chính lời nói**, không chấm theo văn mẫu. Ba chiều: **Rõ ràng/phát âm** (độ tin cậy nhận dạng, tốc độ, ngắt nghỉ) · **Đủ ý** (chỉ khi có căn cứ cùng ngôn ngữ nói) · **Mạch lạc & trôi chảy** (lặp, từ đệm, độ dài). Code: `backend/lib/quick-eval.js`, route `/api/quick-check`.
- Ngôn ngữ: văn bản hiển thị luôn theo ngôn ngữ **thực sự nói** (`dominantLang` đếm từ/chữ). Câu Anh xen vài từ Hán vẫn là Anh; không ép `language` theo nhãn whisper (`speech.js`). Chọn "Chấm theo ngôn ngữ" ≠ ngôn ngữ nói → báo `lang_mismatch`, bỏ chiều Đủ ý, không chấm chéo.
- Phân tích sâu AI chỉ đánh giá transcript đã chốt; ngữ pháp/thanh điệu từng âm tiết cần phân tích sâu.
- Tag ADMIN bị cắt: gốc là `.drawer-item svg{flex:0 0 20px}` rò vào SVG trong tag → `.drawer-item .role-tag svg{width:11px;flex:0 0 11px}`.

## Phân tích sâu AI v3 + sửa lỗi nút Stop khi ghi (v52, 2026-10-13)
- `/api/pronunciation-score`: đánh giá lời nói theo phát âm · ngữ pháp · mạch lạc/đủ ý · thuật ngữ (+ điểm tốt, điểm cần sửa); văn mẫu chỉ làm căn cứ khi **cùng ngôn ngữ** với lời nói. Khoá cache `v3|…`. Tổng = 40% phát âm + 30% ngữ pháp + 30% mạch lạc.
- Nút Stop biến mất khi ghi: màn bị `render()` lại giữa lúc ghi → `renderListenDialogue` trả nút Stop ẩn. Sửa: khôi phục UI ghi sau render; `onstop` chỉ dọn state nếu vẫn là chính lần ghi đó (tránh ghi đè lần ghi mới); rời màn nghe thì dừng mic.
- Nhãn nút "Tải / cập nhật bộ tra cứu" dùng nhầm khoá `oa_download` ("Tải về để nghe offline") → khoá riêng `sys_dl_btn`.

## Màn chờ toàn màn hình (v53)
- Quy tắc: tải nội dung nào cũng phải có màn chờ rõ (logo + thanh chạy), không để màn trống. Hàm dùng chung `busyShow/busyHide/withBusy` (`#busyOverlay`, z-index dưới màn cập nhật bản mới, tự gỡ sau 30 s).
- Đã áp dụng: lần đầu vào Nghe/đổi tab danh mục (chỉ khi chưa có cache), Học Thuật lần đầu, mở một bài nghe (gồm tải trước âm thanh). Lỗi mạng không lưu danh sách rỗng → lần vào sau tải lại.
- Việc nên rà tiếp: các tải khác (Học tập, Từ điển lần đầu…) cần dùng cùng hàm này.

## v54 (2026-10-13)
- **Phân tích sâu AI tách khung riêng**: `lineDeep[seq]` + `listenDeepPut` — kết quả/loading nằm trong `.lsc-deep` bên dưới; video/âm thanh đã ghi và điểm chấm nhanh KHÔNG bị dựng lại (kiểm tra: cùng phần tử `<audio>`).
- **Màn chờ toàn màn hình** bọc thêm (cuối script, `busyWrapAll`): kho thuật ngữ lần đầu, danh sách Học Thuật, thanh toán/đổi mã, Lão Sư mở đầu/chọn chủ đề, Tự Thêm (tải, gửi, đọc tệp), duyệt từ báo sai, góp ý, các thao tác admin.
- **Lưu video vào Ảnh (iPhone)**: kiểu tệp chuẩn hoá `video/mp4` (bỏ `;codecs=`), đuôi `.mp4`; thông báo rõ khi thiết bị không chia sẻ được/WebM/ghi hình lỗi. Cần cắm plugin Filesystem/Media nếu share sheet vẫn không có "Lưu video".

## v55 — toast bị che + trình sửa thuật ngữ báo kết quả ngay trong bảng
- Gốc lỗi "bấm lưu mà không thấy gì": `.listen-toast` là `position:absolute; z-index:60` trong `#app`, nằm DƯỚI bảng sửa (z 2147482000) → mọi thông báo (thành công/lỗi) đều vô hình khi có bảng/popup. Nay toast `position:fixed; z-index:2147483600` gắn vào `body`.
- Trình sửa: dòng trạng thái trong bảng (Đang lưu / ✓ Đã lưu → tự đóng sau 0,9 s / ✗ lỗi kèm mã), timeout 30 s, lỗi server trả `detail` (chỉ route admin) để chẩn đoán.
- Quy tắc: mọi thao tác ghi dữ liệu phải có trạng thái hiển thị CÙNG tầng với nơi người dùng đang nhìn, không dựa vào toast.

## v56 — màn chờ dạng popup; Lão Sư nhận ra lời chào
- Màn chờ chung (`#busyOverlay`) đổi thành **popup nhỏ** (thẻ trắng + vòng xoay, nền mờ 22%). Màn xanh toàn màn hình (`#luOverlay`) CHỈ dùng khi cập nhật phiên bản ứng dụng. Lão Sư dùng chỉ báo "đang gõ" trong khung chat, không dùng overlay.
- Lão Sư (`backend/lib/laoshi.js`): thêm **phân loại ý định** — `isSmallTalk()` nhận ra chào hỏi/cảm ơn/tạm biệt/"thầy là ai" (vi/zh/en, ngắn, không có thuật ngữ y học, không phải đáp án A/B/C): bỏ chấm câu đố và nạp ngữ liệu, dặn mô hình ĐÁP LẠI như người thật (1–3 câu, có thể kèm tiếng cười), nhắc nhẹ câu đố đang chờ. Không đưa lời chào vào kho FAQ và không cho kho FAQ chặn lời chào.

## v57 — Trò chuyện tự do, quy ước dịch dùng chung, gộp báo cáo trùng, lưu có thử lại
- **Trò chuyện tự do** (menu riêng, Max): luyện khẩu ngữ bằng giọng nói. Màn `#talkScreen`: nút mic lớn (chạm nói / chạm gửi), chọn ngôn ngữ nói (中文/Việt/English), rảnh tay tự nghe tiếp, chữ phụ có thể ẩn. Luồng: ghi âm → `/api/laoshi/transcribe` → `/api/laoshi/chat` với `talk:true` (persona `TALK_PERSONA`: 1–3 câu nói, không đố/danh sách, nhắc lại đúng để sửa lỗi, hỏi nối) → `/api/laoshi/tts` phát tiếng. Khung chat chữ của Lão Sư giữ nguyên (đố, trắc nghiệm, chữ là chính).
- **Quy ước dịch thuật ngữ** `backend/lib/tcm-style.js`: `STYLE_RULES` (Hán-Việt cho thuật ngữ Trung y, không "Tây y hoá", WHO/pinyin cho tiếng Anh, nhất quán) + `glossaryTerms()` lấy các mục CSDL có mặt trong văn bản nguồn làm BẢNG THUẬT NGỮ BẮT BUỘC. Đã nối vào: Lão Sư (`laoshi.reply`), bài Tự Thêm (`user-docs` prompt biên tập/dịch), thuật ngữ tự học (`term-learn.askModel`). Ví dụ gốc lỗi: 失神发作 bị dịch "Cơn vắng ý thức" thay vì "Thất thần phát tác".
- **Gộp báo cáo trùng**: `trUnique()` — cùng nội dung → một dòng "N người báo"; chỉ khi khác nhau mới liệt kê để chọn bản đúng (chạm = điền sẵn vào trình sửa).
- **Lưu thuật ngữ**: lỗi mạng (TLS reset) → tự thử lại tối đa 3 lần, báo "đang thử lại".
- Còn mở: quét lại hàng loạt thuật ngữ `machine_translated` theo quy ước (cần duyệt chi phí + ra danh sách đề xuất để admin duyệt, không tự ghi).

## v58 — rà soát theo quy ước dịch, Trò chuyện tự do bố cục cố định, cử chỉ vuốt thông minh
- **Rà soát thuật ngữ máy dịch theo quy ước** (admin, màn "Từ báo sai" → thẻ trên cùng): `POST /api/admin/term-restyle/run` quét 25 mục `machine_translated=1` mỗi lần (gpt-5-mini + `STYLE_RULES` + bảng thuật ngữ), lưu đề xuất vào bảng `term_restyle` (không tự ghi); admin bấm Áp dụng → ghi qua `/api/admin/term-edit` (transaction + nhật ký) hoặc Bỏ qua. Mục đã ổn đánh dấu `ok`, không quét lại. Tính vào ngân sách AI của admin.
- **Trò chuyện tự do**: bố cục cố định (ngôn ngữ → mic → khung lưu hội thoại cuộn được → hai lựa chọn ghim dưới đáy). "Hiện chữ" chỉ làm mờ khung. Biểu tượng mic đổi bằng CSS `data-s` (không dựng lại DOM) + vòng xung bằng `::before` — tránh lỗi bóng ma trên iOS.
- **Vuốt lùi/tiến**: bỏ nút gợi ý; chỉ hoạt động ở màn điều hướng. `swipeNavAllowed()` chặn khi: đang trò chuyện/chat với thầy, đang ghi âm, có form/sửa/xác nhận/thanh toán/đăng nhập, đang nhập liệu, chạm vào ô nhập/audio/video.
