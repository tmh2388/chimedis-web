# Kho thuật ngữ chung dict ⇄ workbench (tự học, lưu MySQL)

Mục tiêu: AI chỉ dịch **một lần** cho mỗi thuật ngữ y khoa quan trọng; kết quả nằm trong CSDL dùng chung, hiện ở mục "Tổng hợp" của app dict,
người dùng góp ý được, admin duyệt, và workbench dùng lại bản đã sửa. Không lưu JSON ghi lúc chạy (triển khai lại sẽ mất).

## Luồng
```
workbench tìm kiếm ──LLM dịch cụm chưa có──► dict_candidates (MySQL, SẴN CÓ, workbench tự ghi — KHÔNG đổi gì)
                                                │
                    dict (job nền 30 phút, tối đa TERM_PROMOTE_DAILY=60 cụm/ngày, mỗi cụm 1 lần)
                    1. bỏ cụm đã có trong kho (general_terms + danh sách cốt lõi)  → 0 chi phí AI
                    2. hỏi AI theo lô: có phải thuật ngữ y khoa? hz giản thể / pinyin / vi / en / định nghĩa ngắn
                    3. y khoa  → general_terms (domain 'Tổng hợp', verify=0, machine_translated=1, nhóm "Mới (tự học) · …")
                       không phải → dict_candidates.is_medical=0 (không hỏi lại)
                                                │
               app dict: mục Tổng hợp hiện thuật ngữ mới + nhãn "AI dịch tự động · chưa duyệt" + nút ⭐ góp ý
                                                │
        term_feedback ──► Admin (modal quản trị): Duyệt / Sửa / Từ chối
                          Duyệt = general_terms.verify=1, machine_translated=0  VÀ  dict_candidates.en = bản đã sửa, status='approved'
                          (workbench dùng lại bản đã sửa qua dict_candidates / CoreDB)
```

## Bảng (đều MySQL)
| Bảng | Chủ | Ghi chú |
|---|---|---|
| `dict_candidates` | workbench tạo; dict thêm cột `hz, py, vi_name, definition_vi, is_medical, promoted_term_id, promoted_at, enrich_note` (ALTER kiểm tra trước) | workbench liệt kê cột tường minh nên không ảnh hưởng |
| `general_terms` | dict ("Tổng hợp") | hàng tự học: `source LIKE 'Tự học%'`, `verify=0`; `term_id = 'tq-'+sha1(hz)[:10]` (cùng công thức seed JSON) |
| `term_feedback` | dict | góp ý người dùng (tối đa 20/ngày/người) |
| `laoshi_faq` | dict | kho câu hỏi Lão Sư: 👍 → chờ duyệt → admin duyệt → dùng lại, không gọi AI |
| `laoshi_tts_cache`, `asr_fix_votes` | dict | đệm giọng đọc dùng chung; học sửa nhận dạng đồng âm |

## Nguyên tắc chống tốn AI / chống rác
- Chỉ cụm đã thấy ≥ 2 lần hoặc `status ∈ {auto_active, approved}` mới được xét.
- Trùng với kho (chữ Hán / tên Việt / tên Anh) → bỏ qua, không gọi AI.
- AI nói "không chắc" → `medical=false`. Thiếu chữ Hán hợp lệ → không đưa vào Tổng hợp, ghi chú để người bổ sung.
- Nội dung tự học luôn `verify=0` + nhãn "chưa duyệt" cho tới khi admin duyệt; seed JSON không ghi đè hàng `verify=1`.

## Việc còn lại cho workbench (phiên workbench làm)
- `lib/tcm-dictionary.json` hiện là ảnh chụp tĩnh sinh bởi `scripts/build-tcm-dictionary.mjs`. Nên đọc `general_terms` (verify=1 hoặc cả verify=0 với trust `auto`) trực tiếp từ MySQL
  chung (hoặc `dict.chimedis.vn/api/terms`) theo định kỳ thay vì chỉ ảnh chụp, để thuật ngữ mới/đã sửa dùng được ngay.
- Có thể dùng thêm `dict_candidates.hz / vi_name / is_medical` (cột mới) khi hiển thị chip "đã nhận diện".
