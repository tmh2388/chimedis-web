# Ghi chú của admin → GitHub → Claude Code xử lý từ xa

Mục tiêu: admin đang dùng app/web thấy lỗi hoặc có ý tưởng thì ghi ngay trên giao diện; Claude Code nhận việc mà không cần admin mở máy tính gõ lại.

## Đã làm (v66)
- Menu ☰ → **Ghi chú cho Claude** (chỉ admin): hộp nhập nội dung. Bản ghi kèm tự động: trang, màn hình/nhóm đang mở, ngôn ngữ, kích thước cửa sổ, thiết bị, từ đang mở, ô tìm kiếm.
- Máy chủ `POST /api/admin/dev-note` tạo **GitHub Issue** nhãn `claude-todo` trong repo (mặc định `tmh2388/chimedis-web`, đổi bằng `GITHUB_NOTES_REPO`).
- Cần đặt env (Hostinger, rồi Restart): `GITHUB_NOTES_TOKEN` = fine-grained PAT chỉ cấp quyền **Issues: Read and write** cho đúng repo cần. Chưa có token thì app báo "chưa cấu hình".

## Cách Claude Code nhận việc (chọn một)
1. **GitHub Action `anthropics/claude-code-action`** (khuyên dùng): Issue có nhãn `claude-todo` → Action chạy Claude, sửa code, mở Pull Request để admin duyệt. Cần secret `ANTHROPIC_API_KEY` trong repo. Mẫu workflow: `docs/claude-todo.workflow.yml.example` (copy sang `.github/workflows/` khi sẵn sàng; mặc định KHÔNG bật để tránh chạy tốn phí ngoài ý muốn).
2. **Tác vụ định kỳ của Claude Code** (routine/schedule): mỗi giờ đọc Issue mở có nhãn `claude-todo` bằng `gh issue list`, xử lý rồi mở PR. Không cần secret trong repo, dùng gói Claude Code hiện có.
3. **Thủ công**: mở Claude Code → "đọc các Issue claude-todo và xử lý".

## An toàn
- Token chỉ có quyền Issues; không đọc/ghi code. PR luôn do người duyệt; không tự merge.
- Ghi chú không chứa dữ liệu nhạy cảm tự động (chỉ ngữ cảnh màn hình). Không dán mật khẩu/khóa vào ghi chú.
- Issue ở repo riêng tư nên không lộ ra ngoài.

## Hạn chế/ý tưởng tiếp
- Chưa đính kèm ảnh chụp màn hình (cần lưu ảnh ở nơi riêng tư rồi dán liên kết); có thể thêm sau.
- Có thể thêm cùng cơ chế cho workbench (chimedis.vn) bằng cùng endpoint/nhãn.
