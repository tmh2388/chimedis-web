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
