# Ghi chú của admin → GitHub → Claude Code (cloud) xử lý — dùng chung toàn Chimedis

Mục tiêu: admin thấy lỗi/ý tưởng ngay trên giao diện (dict, workbench chimedis.vn, consultapp…) → ghi chú → Claude Code tự nhận việc, sửa code, mở Pull Request để admin duyệt. Không cần mở máy tính gõ lại.

## Kiến trúc chung
```
Giao diện (dict / workbench / consult)  ──►  chimedis.vn  POST /api/dev-note   (CHỈ admin, giữ DUY NHẤT token GitHub)
                                                 │ 1) tạo GitHub Issue ở repo đích (nhãn claude-todo + app:<tên>)
                                                 └ 2) gọi API trigger của "routine" Claude Code (cloud) ──► Claude sửa, mở PR nhánh claude/…
Admin duyệt PR trên GitHub → merge → Hostinger tự triển khai.
```
- Hiện dict đã có endpoint riêng (`POST /api/admin/dev-note`) làm dự phòng; chimedis.vn sẽ làm dịch vụ chung + component `ch-note.js` (đã đề nghị phiên workbench). Khi sẵn sàng, dict chuyển sang gọi dịch vụ chung.

## Chi phí: có tốn tiền API không?
- **Routine của Claude Code (khuyên dùng)** chạy trên hạ tầng đám mây của Anthropic, đăng nhập bằng tài khoản claude.ai (gói Pro/Max). Nó **không dùng khoá API, không có hoá đơn API riêng**; mỗi lần chạy **trừ vào hạn mức thuê bao** như phiên Claude Code bình thường (xem claude.ai/settings/usage). Hết hạn mức thì các lần chạy bị từ chối tới khi hạn mức làm mới — trừ khi bạn BẬT "usage credits" (khi đó phần vượt mức tính tiền; giữ TẮT nếu không muốn tốn thêm).
- Giới hạn tần suất (không tính tiền thêm): API trigger 30 lần/giờ mỗi routine, 100 lần/giờ cho cả tài khoản; lịch định kỳ tối thiểu 1 giờ/lần.
- **GitHub Action + `ANTHROPIC_API_KEY`**: TÍNH TIỀN theo token API (tách khỏi thuê bao). Action cũng nhận `claude_code_oauth_token` (tạo bằng `claude setup-token`, dành cho Pro/Max); tài liệu của action không nêu rõ cách tính phí nên không nên coi là miễn phí.
- Routine thuộc tài khoản claude.ai CÁ NHÂN: commit/PR mang danh tài khoản GitHub của bạn; Claude chỉ đẩy lên nhánh `claude/…`, không tự merge.

## Hướng dẫn cài đặt từng bước (làm một lần)
### Bước 1 — Token GitHub chỉ để tạo Issue
1. GitHub → ảnh đại diện → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. Token name `chimedis-notes`; Expiration 1 năm; Resource owner `tmh2388`.
3. Repository access → **Only select repositories** → chọn `chimedis-web` (dict), `chimedis-home` (workbench), repo consultapp.
4. Repository permissions → **Issues: Read and write** (Metadata tự động chỉ đọc). Không cấp quyền khác.
5. **Generate token**, sao chép ngay (chỉ hiện một lần).
### Bước 2 — Biến môi trường trên máy chủ
1. hPanel Hostinger → Websites → ứng dụng Node tương ứng → **Environment variables**.
2. Thêm `GITHUB_NOTES_TOKEN` = token bước 1 (tuỳ chọn `GITHUB_NOTES_REPO` = `tmh2388/chimedis-web` cho dict). Làm tương tự cho chimedis.vn khi có dịch vụ chung.
3. **Restart** ứng dụng.
### Bước 3 — Tạo "routine" Claude Code trên cloud
1. https://claude.ai/code/routines → **New routine**.
2. Tên `Chimedis xử lý ghi chú admin`.
3. **Prompt**:
   > Đọc khối routine-fire-payload: chứa repo, số Issue và nội dung ghi chú của admin Chimedis. Làm việc trong ĐÚNG repo đó. Chỉ sửa phần được yêu cầu, giữ nguyên mọi thứ đang chạy ổn, đọc CLAUDE.md và docs/SESSIONS.md của repo trước, kiểm tra cú pháp, tăng phiên bản service worker nếu sửa giao diện dict. Mở Pull Request (nhánh claude/…) ghi "Closes #<số Issue>" và mô tả cách đã kiểm tra. KHÔNG merge, KHÔNG đụng secret, KHÔNG gọi dịch vụ thanh toán. Nếu ghi chú mơ hồ hoặc rủi ro, chỉ viết nhận xét/đề xuất trong PR nháp thay vì sửa.
4. **Repositories**: thêm các repo cần xử lý. **Environment**: Default (Trusted) là đủ.
5. **Select a trigger → API** → Create → Edit → **Generate token** → sao chép **URL** và **token** (chỉ hiện một lần).
6. (Dự phòng) thêm trigger **Schedule** mỗi giờ để nhặt Issue `claude-todo` bị sót.
7. Connectors: gỡ những connector không cần (Claude dùng được cả thao tác ghi mà không hỏi).
### Bước 4 — Cho máy chủ biết routine để đánh thức ngay
Hostinger thêm `CLAUDE_ROUTINE_FIRE_URL` (URL bước 3) và `CLAUDE_ROUTINE_TOKEN` (token), Restart. Chưa đặt thì Issue vẫn được tạo, chỉ là Claude không được đánh thức ngay.
### Bước 5 — Bảo vệ nhánh chính
Repo → Settings → Branches → Add rule cho `main`: bắt buộc Pull Request trước khi merge.

## Dùng hằng ngày
1. Admin mở menu ☰ → **Ghi chú cho Claude** → gõ → Gửi (tự kèm màn hình, ngôn ngữ, thiết bị, từ đang mở).
2. Vài phút sau có Pull Request trên GitHub (phiên chạy xem tại claude.ai/code). Xem thay đổi, merge nếu ổn → Hostinger tự triển khai.

## Lưu ý
- GitHub trigger của routine hiện chỉ hỗ trợ sự kiện Pull Request/Release (KHÔNG có sự kiện Issue) nên dùng API trigger (đánh thức từ máy chủ) + lịch dự phòng.
- Routine đang ở dạng "research preview": header/giới hạn có thể đổi.
- Đừng dán mật khẩu/khoá vào ghi chú; Issue là văn bản thường (nằm trong repo riêng tư).
