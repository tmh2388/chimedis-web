# Atlas Huyệt vị — Công cụ hiệu chỉnh (nội bộ)

Công cụ 1 file HTML (không build step) để đặt toạ độ huyệt lên ảnh atlas theo
đúng thốn pháp (骨度分寸法) thay vì ước lượng bằng mắt.

## Chạy thử cục bộ

1. Tải 11 ảnh atlas từ Drive (xem `storage_uri` từng dòng trong tab
   `kb_atlas_assets` của `HVYD Acupoint Core DB`) vào `atlas-images/`,
   đặt đúng tên file như liệt kê trong biến `IMAGES` ở `atlas-calibrate.html`.
2. `python3 -m http.server 8321` trong thư mục `backend/admin/`.
3. Mở `http://localhost:8321/atlas-calibrate.html`.

## Cách dùng

1. Chọn ảnh nền.
2. Chọn 1 đoạn thốn chuẩn trong danh sách (hoặc "Tuỳ chỉnh") → bấm "Bắt đầu
   đặt thước" → click mốc GẦN rồi mốc XA trên ảnh (đúng thứ tự) → công cụ tự
   vẽ thước có vạch chia từng thốn chạy dọc theo chi, giống mẫu tham khảo
   app 3D Acupuncture (ảnh người dùng gửi 2026-08-17).
   - Mỗi thước có 2 thanh trượt riêng ngay dưới tên thước trong danh sách:
     **"Lệch ngang"** (kéo để thước tránh xa không đè lên huyệt/đường viền
     cơ thể — kéo sang âm để lệch hướng ngược lại) và **"Độ đậm"** (giảm
     xuống nếu thước quá nổi che khuất chi tiết ảnh).
3. 1 ảnh có thể đặt NHIỀU thước (vd. ảnh cánh tay cần cả đoạn nách→khuỷu 9
   thốn và đoạn khuỷu→cổ tay 12 thốn).
4. Với mỗi huyệt: **chọn Kinh mạch → chọn Huyệt** trong 2 dropdown (không
   cần nhớ/gõ mã huyệt — có sẵn đủ 404 huyệt, đúng tên Việt + gợi ý vị trí
   hiện ngay bên dưới khi chọn) → chọn thước làm mốc + số thốn dọc trục (từ
   mốc gần) + số thốn lệch ngang (dương/âm tuỳ bên) → "Tính & đặt".
   Nếu huyệt không có mô tả dạng "cách mốc X thốn" (thường là huyệt ở bàn
   tay/bàn chân/đầu mặt), dùng "Đặt tay" rồi click thẳng lên ảnh.
5. "Xuất JSON" → dán kết quả vào script ghi `kb_atlas_markers` (theo đúng
   schema: asset_id, acupoint_id, x_normalized, y_normalized, laterality,
   confidence).

## Cập nhật danh sách huyệt trong dropdown

Dữ liệu Kinh mạch/Huyệt được nhúng thẳng vào `acupoints-data.js` (không
`fetch()` để tránh lỗi CORS khi mở trực tiếp bằng double-click, không qua
server). Nếu bảng `acupoints` trong MySQL có thay đổi (thêm huyệt, sửa
tên/vị trí), chạy lại:

```
cd backend/admin
MYSQL_HOST=... MYSQL_USER=... MYSQL_PASSWORD=... MYSQL_DATABASE=... node generate-acupoints-data.mjs
```

## Lưu ý

- Chưa lưu trạng thái giữa các lần tải lại trang (chưa có localStorage) —
  làm xong 1 ảnh thì xuất JSON ngay, đừng đổi ảnh giữa chừng nếu chưa xuất.
- `confidence` tự động: 0.95 nếu tính theo thước, 0.7 nếu đặt tay bằng mắt
  (không có cơ sở đo thốn) — nên rà soát kỹ các huyệt confidence 0.7 hơn.

## Atlas 3D — đã TÁCH sang repo riêng (2026-08-19)

Hướng atlas 3D (Three.js) không còn nằm trong repo này nữa — đã chuyển
thành dự án độc lập tại **https://github.com/tmh2388/chimedis-atlas3d**
(private), vì đây là hướng đầu tư/bản quyền riêng theo quyết định của user,
tách khỏi app từ điển tra cứu chính. Xem repo đó để biết tiến độ, dữ liệu
huyệt vẫn đồng bộ 1 chiều từ `acupoints` MySQL của repo này qua
`generate-acupoints-data.mjs` (bản sao, không kết nối DB trực tiếp).

Bản 2D (`atlas-calibrate.html` ở trên) vẫn là bản chính đang dùng để hoàn
thiện atlas trong repo này, không bị ảnh hưởng bởi việc tách dự án.
