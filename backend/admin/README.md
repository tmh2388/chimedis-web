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

## Bản 3D (thí điểm) — `atlas-calibrate-3d.html`

Song song với bản 2D trên, đây là bản THÍ ĐIỂM cho hướng atlas 3D (Three.js),
dùng chung dữ liệu `acupoints-data.js`. Chưa thay thế bản 2D — 2D vẫn là bản
chính đang dùng để hoàn thiện atlas.

### Nguồn mesh 3D — đã chọn, cần bạn tự tải
- **Human Body Base Mesh Male**, Sketchfab, tác giả `ferrumiron6`
  (https://sketchfab.com/3d-models/human-body-base-mesh-male-3678451d8ccb435e833f8a10729c09f5)
  — **CC BY 4.0**: được dùng thương mại, **bắt buộc ghi công tác giả** (đã
  thêm dòng credit vào... *cần bổ sung vào trang About/Nguồn của app khi lên
  production*, tự thân file này chưa tự ghi).
  12.8k tam giác, không UV/texture (đúng ý — atlas dùng phong cách line-art
  phẳng, không cần da thật).
- Tải file: cần tài khoản Sketchfab miễn phí để bấm Download → chọn định
  dạng **.glb** (KHÔNG chọn .fbx/.obj, script này load thẳng glb) → đổi tên
  thành `body-model.glb` → đặt vào cùng thư mục với `atlas-calibrate-3d.html`
  (không commit file .glb vào git — thêm vào `.gitignore` như đã làm với
  `atlas-images/*.png`, vì file mesh cũng nặng và không phải mã nguồn).
- Chưa có `body-model.glb` → công cụ tự hiện hình placeholder (viên nang) để
  vẫn thử được thao tác thước/marker, có cảnh báo rõ trên màn hình — KHÔNG
  dùng toạ độ đặt trên placeholder làm dữ liệu thật.

### Cách dùng (giống hệt logic thốn của bản 2D, chỉ khác không gian 3D)
1. `python3 -m http.server <port>` trong `backend/admin/`, mở
   `atlas-calibrate-3d.html`.
2. Kéo chuột = xoay mô hình, cuộn = zoom, chuột phải kéo = pan — xem được cả
   mặt trước/sau/bên chỉ trong 1 mesh (khác 2D phải vẽ nhiều ảnh riêng theo
   view).
3. "Bắt đầu đặt thước" → click 2 mốc TRÊN BỀ MẶT mesh (mốc gần → xa) → công
   cụ nối 1 đường thẳng (dây cung) giữa 2 điểm, có vạch chia từng thốn.
4. Chọn Kinh mạch → Huyệt → chọn thước → nhập thốn dọc trục + lệch ngang →
   "Tính & đặt": điểm tính theo dây cung thẳng, sau đó **tự động chiếu
   (raycast) trở lại bề mặt mesh gần nhất** dọc theo pháp tuyến trung bình,
   để huyệt luôn nằm đúng trên da chứ không lơ lửng trong khối.
5. "Xuất JSON": mỗi huyệt có `x,y,z` (toạ độ thế giới thật, đơn vị mét theo
   mesh gốc) + `normal_x,y,z` (hướng vuông góc bề mặt tại điểm đó — dùng để
   sau này hiển thị marker luôn "dán" đúng mặt da khi xoay mô hình).

### Giới hạn đã biết (v1 thí điểm, cần cải tiến trước khi dùng đại trà)
- Thước là **dây cung thẳng** nối 2 mốc, không phải đường trắc địa
  (geodesic) bám sát độ cong thật của da — ở đoạn cong nhiều (khuỷu, khoeo)
  số thốn tính theo dây cung sẽ ngắn hơn thực tế đo dọc da. Bước snap-to-surface
  sửa được sai lệch bề mặt (điểm luôn nằm đúng trên da) nhưng KHÔNG sửa được
  sai lệch chiều dài dây cung — cần rà soát bằng mắt từng huyệt như quy trình
  đã áp dụng cho 2D, đặc biệt quanh khớp.
- Chưa có "mốc xương" (landmark) dựng sẵn trên mesh — mỗi lần đặt thước phải
  tự click lại mốc bằng mắt, giống thao tác 2D. Bước nâng cấp tiếp theo hợp
  lý: rig sẵn ~15-20 mốc xương chuẩn trên mesh (Blender/Mixamo) rồi chọn từ
  dropdown thay vì click tay mỗi lần — giảm sai số do đặt mốc lệch.
- Schema xuất JSON (`x,y,z,normal_*`) là **đề xuất mới**, chưa khớp bảng
  `kb_atlas_markers` hiện tại (đang là `x_normalized,y_normalized` cho ảnh
  2D) — cần bàn + viết migration/bảng mới (`kb_atlas_markers_3d`?) trước khi
  ghi dữ liệu thật vào Core DB, không tự ý đổi bảng cũ.
- Đã kiểm tra bằng tay (không phải chỉ đọc code): dựng server local, load
  model, đặt thước + tính huyệt + xuất JSON — toàn bộ chạy đúng trên hình
  placeholder. **Chưa test được với mesh giải phẫu thật** (chưa tải file) —
  cần xác nhận lại raycasting/snap hoạt động đúng trên mesh nhiều tam giác
  và nhiều sub-mesh hơn (glb thật có thể có nhiều group riêng cho từng vùng
  cơ thể, không phải 1 mesh liền như placeholder).
