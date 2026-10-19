# Ghi chú của admin → GitHub Issue → `/chimedis-note` (cách đơn giản, đã chốt)

## Cách hoạt động
1. Mỗi app (dict, workbench, consultapp) có mục **Ghi chú** cho admin. Gửi ghi chú = tạo một **GitHub Issue nhãn `claude-todo`** ngay trong repo của app đó, kèm ngữ cảnh màn hình/thiết bị.
2. Khi bạn cần xử lý: mở máy, mở Claude Code và gõ **`/chimedis-note`**. Lệnh đọc Issue `claude-todo` đang mở ở cả 3 repo, sửa từng việc trong bản sao riêng và **mở Pull Request** (không tự merge). Bạn duyệt rồi merge → Hostinger tự triển khai.

| App | Repo |
|---|---|
| dict | `tmh2388/chimedis-web` |
| workbench | `tmh2388/chimedis-home` |
| consultapp | `tmh2388/hvyd-consultapp` |

Lệnh nằm ở `~/.claude/skills/chimedis-note/SKILL.md`. Gõ `/chimedis-note` để làm tất cả, hoặc `/chimedis-note dict 12` để làm riêng một Issue.

## Cài đặt trên dict (một lần)
1. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate: tên `chimedis-notes`, Resource owner `tmh2388`, **Only select repositories** (các repo cần nhận ghi chú), quyền **Issues: Read and write**.
2. hPanel Hostinger → ứng dụng Node → **Environment variables** → `GITHUB_NOTES_TOKEN` = token (tuỳ chọn `GITHUB_NOTES_REPO`, mặc định `tmh2388/chimedis-web`) → **Restart**.
3. Dùng: menu ☰ → **Ghi chú cho Claude** → gõ → Gửi.

## An toàn
- Token chỉ có quyền Issues (không đọc/ghi code). Claude chỉ mở PR, bạn là người merge.
- Đừng dán mật khẩu/khoá hay dữ liệu bệnh nhân vào ghi chú.

## Phương án nâng cao (tuỳ chọn, chưa dùng)
Có thể đánh thức routine Claude Code trên cloud ngay sau khi tạo Issue (env `CLAUDE_ROUTINE_FIRE_URL` + `CLAUDE_ROUTINE_TOKEN`, đã có sẵn trong endpoint dict): chạy trên gói thuê bao, không có hoá đơn API riêng nhưng trừ hạn mức thuê bao; GitHub Action dùng khoá API thì tính tiền theo token. Dịch vụ ghi chú chung ở chimedis.vn đã gác lại.
