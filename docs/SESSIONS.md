# SESSIONS — bảng phối hợp giữa các phiên Claude (chat) cùng làm Chimedis

Nhiều phiên Claude có thể cùng sửa `chimedis-web` (dict.chimedis.vn), `chimedis-home` (chimedis.vn), `chimedis-ios`.
Chúng KHÔNG tự thấy nhau; **git + file này là nơi chung**. Quy tắc bắt buộc:

## Quy tắc
1. **Đầu phiên:** `git fetch && git log origin/main -10`, rồi đọc file này. Làm trong bản clone/worktree RIÊNG của phiên
   (không sửa chung một thư mục làm việc như `_work/…` khi có phiên khác đang mở).
2. **Trước khi sửa file:** `git pull --rebase`. Không đổi chữ ký hàm dùng chung (vd. `isAdmin`, `planInfo`) ở nhiều chỗ —
   sửa ở một nơi (`backend/lib/plan.js`) và cập nhật mọi chỗ gọi trong cùng commit.
3. **Commit nhỏ, push sớm.** Không để sửa dở (chưa commit) nằm lâu: nó tụt so với `origin/main` và dễ phá khi push.
4. **Cuối phiên / sau mỗi quyết định lớn:** thêm một dòng vào bảng bên dưới (đang làm gì, đụng file nào, điều đã chốt).
5. Việc cần phiên khác biết gấp → nhắn thẳng (SendMessage theo tên phiên) *và* ghi vào đây.
6. Hostinger tự redeploy khi push; đổi biến môi trường cần Restart. Không ép "Redeploy" tay.

## Đã chốt (không bàn lại nếu không có lý do mới)
| Chủ đề | Quyết định |
|---|---|
| Gói | free < pro < max; admin (ADMIN_EMAILS/users.role) luôn là max; kiểm bằng `requirePlan` phía server |
| App iOS | Không giá / nút mua / mã nâng cấp (Guideline 3.1.1). Mua chỉ trên web; IAP làm sau |
| Thanh toán | Chuyển khoản VCB (VietQR) → duyệt tay hoặc tự động qua webhook SePay (`/api/payments/sepay`, `SEPAY_API_KEY`). Email VCB không có thư tiền vào → đường `/api/payments/email` chỉ là dự phòng |
| Ngân sách AI | `ai-budget.js` giống hệt ở dict và home (sửa cả hai). 1 credit = $0,01. Kho nghe thư viện không trừ người dùng |
| Chấm nói | Tầng 1 thuật toán cho mọi tài khoản đăng nhập; AI sâu chỉ khi bấm nút |
| Workbench | Chỉ gói Max (+ Lão Sư Trung Y); Pro không dùng |
| Số build iOS | Lấy từ `BUILD_NUMBER` của Codemagic (không sửa tay) |
| `isAdmin` | Đồng bộ, 1 tham số `isAdmin(fbUser)` trong `lib/plan.js` |
| Thuật ngữ mới | AI dịch 1 lần → `dict_candidates` → job dict đưa vào `general_terms` (Tổng hợp, chưa duyệt) → người dùng ⭐ góp ý → admin duyệt; lưu MySQL, KHÔNG JSON |

## Nhật ký phiên (mới nhất ở trên)
| Ngày | Phiên | Việc / file | Ghi chú |
|---|---|---|---|
| 2026-10-13 | Ứng dụng luyện nghe Trung Y | Cử chỉ lùi/tiến toàn app, nghe offline + Cài đặt hệ thống, một bản phiên âm chuẩn, duyệt & sửa từ báo sai trong app (có chữ Hán) | Xem `docs/INFRA-app-ux-admin.md`. Lưu ý lớp nổi z-index và `selectGroup1('all')` khi rời khu vực |
| 2026-10-13 | Ứng dụng luyện nghe Trung Y | Kho thuật ngữ chung: `term-learn.js`, `laoshi-faq.js`, admin duyệt, ⭐ góp ý | Xem `docs/INFRA-shared-terminology.md`; workbench KHÔNG cần đổi gì để vào kho, chỉ nên đọc `general_terms` thay vì ảnh chụp JSON |
| 2026-10-13 | Ứng dụng luyện nghe Trung Y | Sửa 503 (tự hồi), `codemagic.yaml` số build tự động, `docs/SESSIONS.md` | Cảnh báo: `_work/chimedis-web` có sửa dở `isAdmin(mysqlPool, …)` sẽ khoá admin nếu push — cần `pull --rebase` |
| 2026-10-12 | Ứng dụng luyện nghe Trung Y | Thanh toán/credit/Lão Sư/chấm nhanh; bộ đọc email VCB không duyệt biên lai chuyển đi | `billing.js`, `ai-budget.js`, `quick-score.js`, `laoshi.js` |
| 2026-10-13 | Thiết lập thanh toán Sepay | (điền khi làm) | Cấu hình webhook SePay + `SEPAY_API_KEY` |
