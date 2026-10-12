# Nhận tiền tự động bằng email "biến động số dư" (Google Apps Script)

Hộp thư nhận thông báo ngân hàng (ví dụ haitruong.media@gmail.com) chạy một script nhỏ: mỗi phút tìm email mới của ngân hàng có
chứa mã đơn `CHMxxxxxx`, gửi lên máy chủ dict. Máy chủ chỉ tự duyệt khi **mã đơn khớp và có đúng số tiền của đơn**; mọi trường hợp
khác để đơn ở hàng chờ kèm ghi chú cho quản trị viên.

## Thiết lập (một lần)
1. hPanel → Environment variables của app dict: đặt `EMAIL_WEBHOOK_SECRET` = một chuỗi ngẫu nhiên dài (≥ 32 ký tự). Khởi động lại app.
2. Đăng nhập Gmail nhận thông báo → https://script.google.com → Dự án mới → dán đoạn mã dưới, đổi `BANK_QUERY` nếu cần.
3. Project Settings → Script properties → thêm `EMAIL_WEBHOOK_SECRET` (cùng giá trị ở bước 1).
4. Chạy `scanBankEmails` một lần để cấp quyền Gmail + gọi URL ngoài. Triggers → Add trigger → `scanBankEmails`, Time-driven, mỗi phút.

```js
const WEBHOOK_URL = 'https://dict.chimedis.vn/api/payments/email';
// Chỉnh theo người gửi thật của email ngân hàng (xem một email mẫu trong hộp thư).
const BANK_QUERY = 'from:vietcombank.com.vn newer_than:2d';
const LABEL = 'chimedis-da-gui';

function scanBankEmails() {
  const secret = PropertiesService.getScriptProperties().getProperty('EMAIL_WEBHOOK_SECRET');
  const label = GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL);
  GmailApp.search(`${BANK_QUERY} -label:${LABEL}`, 0, 30).forEach((thread) => {
    let allOk = true;
    thread.getMessages().forEach((msg) => {
      const body = msg.getPlainBody().slice(0, 20000);
      const squashed = (msg.getSubject() + ' ' + body).toUpperCase().replace(/[\s\-_.]/g, '');
      if (squashed.indexOf('CHM') === -1) return; // không liên quan tới đơn Chimedis: không gửi đi
      const res = UrlFetchApp.fetch(WEBHOOK_URL, {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { 'X-Webhook-Secret': secret },
        payload: JSON.stringify({ messageId: msg.getId(), subject: msg.getSubject(), body: body }),
      });
      if (res.getResponseCode() !== 200) allOk = false;
    });
    if (allOk) thread.addLabel(label); // chỉ gắn nhãn khi gửi thành công → lỗi tạm thời sẽ được thử lại
  });
}
```

## Ghi chú
- Khuôn email của ngân hàng có thể thay đổi; bộ đọc dung thứ (tìm mã đơn trong toàn văn, số tiền có đơn vị VND/₫/đ). Nếu một email
  không đọc được số tiền, đơn vẫn ở hàng chờ với ghi chú "chưa đối chiếu được số tiền".
- Mỗi email chỉ được dùng một lần (khoá theo id thư) nên gửi lại không cộng trùng.
- Muốn dùng dịch vụ theo dõi giao dịch (SePay…) thay cho email: dùng `POST /api/payments/sepay` với biến `SEPAY_API_KEY`.
