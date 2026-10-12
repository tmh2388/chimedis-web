# Ngân sách AI dùng chung (dict.chimedis.vn ↔ workbench chimedis.vn)

Một người dùng (cùng `firebase_uid`, cùng MySQL) có **một** ngân sách cho mọi chi phí AI/TTS ở cả hai ứng dụng.
Mã nguồn: `backend/lib/ai-budget.js` (dict) và `lib/ai-budget.js` (workbench) — **hai bản sao NGUYÊN VĂN, sửa một nơi thì sửa cả hai**.

## Bảng dùng chung (tự tạo bằng CREATE TABLE IF NOT EXISTS)
| Bảng | Nội dung |
|---|---|
| `ai_ledger` | mỗi lần tốn chi phí: `firebase_uid`, `app` (dict/workbench), `feature`, `cost_micro` (micro-USD), `created_at` |
| `ai_credits` | số dư credit nạp thêm + mốc đã "chốt" phần vượt hạn mức tháng |
| `ai_credit_txn` | sổ nạp/cộng credit (cột `ref` duy nhất → nạp lặp không cộng trùng) |

## Quy tắc
- **Hạn mức tháng** theo gói (env `AI_BUDGET_FREE/PRO/MAX`, mặc định $2 / $2 / $4). Gói do dict cấp: `users.plan` + `users.plan_expires_at`.
- **Hạn mức ngày** = 12% hạn mức tháng; **hạn mức giờ** = 6% (cuốn chiếu 60 phút). Chỉnh bằng `AI_DAY_FRACTION`, `AI_HOUR_FRACTION`.
  Mục đích: không ai dùng hết cả tháng trong vài ngày/giờ.
- Hết hạn mức tháng → trừ **credit** đã nạp (không bị giới hạn theo ngày/giờ vì đã trả tiền). Hết credit → chặn tới tháng sau.
- 1 credit = $0,01 chi phí nhà cung cấp. Gói nạp (web, chuyển khoản như mua gói): 100 credit 59.000₫ · 300 credit 159.000₫ · 800 credit 399.000₫.
- Tài khoản admin (`users.role='admin'` hoặc `ADMIN_EMAILS`) không bị chặn ở workbench.

## Ai ghi sổ
- dict: Lão Sư (chat), phân tích phát âm AI, phiên âm dịch, biên tập "Tự Thêm" + giọng đọc của tài liệu cá nhân.
  **Không trừ ngân sách người dùng:** kho nghe do nền tảng đầu tư (Báo Chí, Y Án, Bài Báo Quốc Tế) và kho Học Thuật từ CSDL
  (giọng sinh theo yêu cầu, lưu đệm dùng chung; toàn kho ~237.000 ký tự ≈ $11 nếu sinh hết hai giọng một lần).
- workbench: mọi lượt AI (qua `lib/ai-runs.js` → `chargeWorkbenchRun`).

## API (dict)
`GET /api/budget` → `{ state, month|day|hour:{used,limit}, credits, packs }` (đơn vị: credit). Hết hạn mức → `429 {error:'budget', reason:'hour'|'day'|'month'}`.
Workbench trả `402 {code:'ai_quota_exceeded', reason, budget}`.

## Giọng đọc
2 giọng cho mọi nội dung: `default` (nam, Wavenet) và `aoede` (nữ, Chirp 3 HD). Giọng sinh theo yêu cầu được lưu đệm dùng chung nên chỉ tốn chi phí lần nghe đầu.

## Chấm nhanh (tầng 1) — không tính ngân sách
`POST /api/quick-check` (mọi tài khoản đăng nhập): chấm bằng thuật toán (`backend/lib/quick-score.js`), không dùng AI để chấm.
Văn bản nói ra lấy từ nhận dạng giọng nói của trình duyệt (miễn phí) hoặc, nếu thiết bị không có (app iOS), từ dịch vụ phiên âm rẻ phía máy chủ
với giới hạn dùng công bằng `QUICK_ASR_DAILY` (mặc định 150 lượt/ngày/người). "Phân tích sâu bằng AI" chỉ chạy khi người dùng bấm nút và có tính ngân sách.
