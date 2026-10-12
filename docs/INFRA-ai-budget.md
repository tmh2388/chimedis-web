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
- dict: Lão Sư (chat), phân tích phát âm, phiên âm dịch, biên tập "Tự Thêm", sinh giọng đọc (bài Học Thuật không phải bài trong ngày, Tự Thêm).
  Bài **trong ngày** của Học Thuật do nền tảng chịu chi phí (không trừ ngân sách người dùng).
- workbench: mọi lượt AI (qua `lib/ai-runs.js` → `chargeWorkbenchRun`).

## API (dict)
`GET /api/budget` → `{ state, month|day|hour:{used,limit}, credits, packs }` (đơn vị: credit). Hết hạn mức → `429 {error:'budget', reason:'hour'|'day'|'month'}`.
Workbench trả `402 {code:'ai_quota_exceeded', reason, budget}`.

## Giọng đọc
2 giọng cho mọi nội dung: `default` (nam, Wavenet) và `aoede` (nữ, Chirp 3 HD). Giọng sinh theo yêu cầu được lưu đệm dùng chung nên chỉ tốn chi phí lần nghe đầu.
