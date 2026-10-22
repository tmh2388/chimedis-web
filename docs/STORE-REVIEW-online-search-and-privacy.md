# Đánh giá rủi ro App Store / Google Play — Tìm kiếm online trong app (2026-10-22)

> Đây là đánh giá kỹ thuật của Claude dựa trên hiểu biết về chính sách công khai, KHÔNG phải tư vấn pháp lý và không bảo đảm Apple/Google sẽ duyệt. Chính sách thay đổi; cần đọc lại bản mới nhất trước khi nộp.

## Tính năng: nút quả địa cầu → màn "Tìm kiếm online"
- Nội dung: Wiktionary + Wikipedia (qua máy chủ Chimedis, bộ nhớ đệm 30 ngày), liên kết mở sang Baidu/Bing/Google bằng trình duyệt ngoài. Không AI, không thanh toán, không credit.
- Điểm có lợi: không có giá/nút mua (App Store 3.1.1); điện thoại chỉ gọi máy chủ Chimedis, không gửi IP/mã thiết bị cho Wikipedia; có ghi nguồn + giấy phép CC BY-SA + liên kết về bài gốc (đúng điều kiện giấy phép Wikipedia/Wiktionary); có dòng "chỉ để tham khảo, không thay thế tư vấn y tế".
- Rủi ro còn lại (thấp–trung bình): (1) Apple 1.2 / Google Play UGC: nội dung Wikipedia do cộng đồng viết — thường được chấp nhận vì là nguồn bên thứ ba có kiểm duyệt cộng đồng, nhưng không tuyệt đối; (2) liên kết sang công cụ tìm kiếm ngoài có thể dẫn tới nội dung người lớn ngoài app — cũng là thực tế của mọi app có liên kết web; (3) nội dung y khoa không thẩm định (Apple 1.4.1 / Google Play Health): đã có dòng miễn trừ, nên thêm vào mô tả app.
- Cách giảm rủi ro nhanh nếu bị hỏi: tắt nút bằng một PR nhỏ (giao diện cập nhật qua live update, không cần build lại).

## Phát hiện QUAN TRỌNG khác (không thuộc tính năng này) — cần xử lý trước khi nộp
1. **Chính sách bảo mật đã lỗi thời.** `privacy.html` (cập nhật 14/08/2026) nói "không đăng ký tài khoản, không thu thập dữ liệu cá nhân, không bên thứ ba". Thực tế app hiện có đăng nhập (email/Google/Apple), đồng bộ yêu thích/tiến độ, tài liệu riêng, ghi âm giọng nói gửi đi nhận dạng, trò chuyện với AI (OpenAI), giọng đọc (Google Cloud TTS), credit/hạn mức. Apple 5.1.1 và Google Play (Data safety) yêu cầu chính sách khớp thực tế. Cần viết lại và khai báo "App Privacy" (Apple) / "Data safety" (Google).
2. **Chưa có xoá tài khoản trong app.** Apple 5.1.1(v) bắt buộc app cho tạo tài khoản phải cho xoá tài khoản ngay trong app; Google Play yêu cầu đường dẫn xoá trong app và trên web. Cần xây tính năng xoá (xoá Firebase user + dữ liệu MySQL liên quan).
3. **Đăng nhập Google/Facebook cùng Apple:** nếu có đăng nhập bên thứ ba thì Apple yêu cầu có Đăng nhập với Apple hoặc lựa chọn tương đương (4.8) — app đã có Apple; cần giữ.
4. **Micro/camera:** mô tả quyền (Info.plist) đã có; nên mô tả rõ mục đích ghi âm luyện nói.
5. **Nội dung AI:** Apple/Google ngày càng hỏi về nội dung do AI sinh ra — cần cơ chế báo cáo nội dung (đã có "báo sai" ở thuật ngữ; nên có ở trả lời của Lão Sư).

## Việc đề xuất (thứ tự)
1. Viết lại chính sách bảo mật + trang xoá dữ liệu (cần chủ app xác nhận nội dung).
2. Tính năng xoá tài khoản trong app (có xác nhận, xoá dữ liệu liên quan, giữ nhật ký tối thiểu theo luật).
3. Hoàn thiện khai báo App Privacy / Data safety.
