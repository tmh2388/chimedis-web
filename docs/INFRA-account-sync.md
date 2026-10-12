# Tài khoản dùng chung: dict.chimedis.vn ↔ workbench (chimedis.vn)

## Nguyên tắc
Một danh tính, một hàng `users`, một nguồn sự thật cho gói:
- **Danh tính:** cùng một dự án Firebase → cùng `uid` ở cả hai nơi.
- **Dữ liệu:** cùng MySQL `u440660297_chimedis`, cùng bảng `users` (khoá `firebase_uid`). Dict ghi `plan`, `plan_expires_at`
  (và đơn/mã kích hoạt ở `orders`, `redeem_codes`); workbench đọc đúng các cột đó, không có bản sao nào để đồng bộ.
- **Gói hiệu lực:** `plan` nếu `plan_expires_at` là NULL hoặc còn hạn, ngược lại `free`:
  `IF(plan_expires_at IS NULL OR plan_expires_at > NOW(), plan, 'free')`.
- **Giá trị `plan`:** `free | pro | max`. Cột `plan` do migration m4 của workbench tạo dạng ENUM('free','pro'); dict tự nới thành
  VARCHAR(16) lúc khởi động (`ensurePlanColumns`) để chứa `max`.
- **Mua / gia hạn chỉ ở web dict** (app iOS không có giao diện mua — App Store 3.1.1). Workbench trỏ người dùng tới
  `https://dict.chimedis.vn/#nang-cap`; dict mở khung mua sau đăng nhập.
- **Gói theo email (PRO_EMAILS/MAX_EMAILS)** chỉ áp dụng khi email đã xác minh.
- **Quản trị:** quyền admin lấy từ cột `users.role` (dùng chung), không lưu danh sách riêng ở từng app.

## Việc workbench cần làm khi muốn dùng gói
Chỉ ĐỌC `users.plan` + `users.plan_expires_at` (không tự ghi). Ví dụ nâng hạn mức AI theo gói: nhân `AI_MONTHLY_LIMIT_USD` với
hệ số của gói hiệu lực (free ×1, pro ×N, max ×M).
