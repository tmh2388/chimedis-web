# Cổng đăng nhập Firebase `/__fb` (đăng nhập web + app không cần VPN ở Trung Quốc)

## Cách hoạt động
- Firebase JS SDK được **tự phục vụ** (`frontend/vendor/firebase/*`, bản vá bởi `scripts/vendor-firebase.mjs`) thay vì nạp từ gstatic.com.
- SDK gọi API đăng nhập qua **chính tên miền dict**: `/__fb/idtk/*` → `identitytoolkit.googleapis.com`,
  `/__fb/stk/*` → `securetoken.googleapis.com`. Máy chủ dict (`backend/server.js`, khối "Cổng chuyển tiếp API đăng nhập Firebase")
  chuyển tiếp; chỉ cho các đường dẫn đăng nhập, 120 yêu cầu/phút/IP; đường dẫn khác dưới `/__fb/` → 404 JSON.
- Trong app iOS (`capacitor://localhost`) SDK trỏ về `https://dict.chimedis.vn/__fb/...`.

## Hệ quả vận hành
- **Đăng nhập của cả web lẫn app giờ phụ thuộc máy chủ dict chạy ổn.** Máy chủ sập/redeploy lỗi → không đăng nhập được
  (kể cả Google/Apple native, vì bước `signInWithCredential` cũng đi qua cổng). Theo dõi `/api/health` như thường lệ.
- Khoá API Firebase có thể giới hạn referrer: cổng đặt `Referer/Origin = https://chimedis.vn/` khi gọi Google.
- Service worker không cache `/__fb/*`.

## Tắt nhanh nếu cần
Revert commit "đăng nhập không cần VPN" (`git log --grep="__fb"`) rồi push: dict quay về nạp SDK từ gstatic.com và gọi thẳng Google.
Lưu ý app iOS đã build sẵn giao diện cũ/mới trong gói `www/`: bản app đã cài sẽ nhận lại giao diện qua live update ở lần mở sau.

## Chế độ Trung Quốc đại lục (chỉ web, không áp dụng trong app)
- Tự nhận bằng múi giờ `Asia/Shanghai|Chongqing|Harbin|Urumqi|Kashgar` hoặc `navigator.language === 'zh-CN'`.
- Ép bằng `localStorage.ch_cn = '1'` (bật) hoặc `'0'` (tắt), rồi tải lại trang; xoá khoá để về tự nhận.
- Ở chế độ này: ẩn nút Google/Apple/Facebook, chỉ còn email + mật khẩu, không nạp `apis.google.com`, bỏ `getRedirectResult`.

## Nâng cấp SDK
Sửa `VERSION` trong `scripts/vendor-firebase.mjs`, chạy `node scripts/vendor-firebase.mjs && node backend/sync-frontend.js`
(script báo lỗi nếu cấu trúc SDK đổi), rồi kiểm tra đăng nhập thật trên web và TestFlight.

## Ngoài phạm vi
Đăng nhập WeChat; TTS Google Cloud (Chirp) cũng bị chặn ở Trung Quốc đại lục.
