# Kết nối Google Sheets cho Chimedis

Hướng dẫn này giúp bạn tạo một **service account** (tài khoản máy) để backend Chimedis
có quyền đọc (read-only) một Google Sheet chứa dữ liệu thuật ngữ, và tự động build lại
API mỗi khi bạn sửa Sheet.

## Bước 1 — Tạo Google Cloud Project

1. Vào https://console.cloud.google.com/
2. Góc trên bên trái → chọn dropdown project → **New Project**
3. Đặt tên, ví dụ `chimedis-api` → **Create**
4. Đợi vài giây, chọn project vừa tạo (dropdown trên cùng)

## Bước 2 — Bật Google Sheets API

1. Menu ☰ → **APIs & Services** → **Library**
2. Tìm "Google Sheets API" → bấm vào → **Enable**

## Bước 3 — Tạo Service Account

1. Menu ☰ → **APIs & Services** → **Credentials**
2. **+ Create Credentials** → **Service account**
3. Đặt tên, ví dụ `chimedis-sheets-reader` → **Create and Continue**
4. Phần "Grant this service account access to project" → bỏ qua (không cần role gì đặc biệt) → **Continue** → **Done**

## Bước 4 — Tạo & tải Key (JSON)

1. Trong danh sách **Service Accounts**, bấm vào account vừa tạo
2. Tab **Keys** → **Add Key** → **Create new key** → chọn **JSON** → **Create**
3. File `.json` sẽ tự động tải về máy bạn — **đây chính là `credentials.json`**
4. ⚠️ **Giữ file này bí mật** — không đưa lên GitHub, không chia sẻ công khai. Ai có file này đều đọc được Sheet của bạn.

## Bước 5 — Chia sẻ Google Sheet cho service account

1. Mở file JSON vừa tải, tìm dòng `"client_email"` — dạng:
   `chimedis-sheets-reader@chimedis-api.iam.gserviceaccount.com`
2. Mở Google Sheet chứa dữ liệu thuật ngữ Chimedis
3. Nút **Share** (Chia sẻ) → dán email đó vào → chọn quyền **Viewer** (chỉ đọc) → **Send**

## Bước 6 — Chuẩn bị cấu trúc Sheet

Backend yêu cầu:
- Tên sheet (tab) phải là **`TERMS`** (viết hoa, đúng chính tả)
- Dòng 1 là tiêu đề cột, dữ liệu bắt đầu từ dòng 2
- Thứ tự cột (A → S):

| Cột | Field | Ví dụ |
|---|---|---|
| A | id | hh023 |
| B | hz (Hán tự) | 心 |
| C | py (pinyin) | xīn |
| D | vi (tiếng Việt) | Tim |
| E | en (tiếng Anh) | heart |
| F | group1 | Giải phẫu / Sinh lý / Bệnh lý |
| G | group2 (hệ cơ quan) | Hệ tuần hoàn |
| H | vitri (vị trí, tiếng Việt) | |
| I | vitri_cn (vị trí, tiếng Trung) | |
| J | congnang (công năng, VI) | |
| K | congnang_cn (công năng, CN) | |
| L | tcm (ghi chú Trung Y, VI) | |
| M | tcm_cn (ghi chú Trung Y, CN) | |
| N | lamsang (lâm sàng, VI) | |
| O | lamsang_cn (lâm sàng, CN) | |
| P | nguon (nguồn tham khảo) | |
| Q | verify | để trống nếu đã xác thực; gõ đúng `⚠️ Cần xác thực` nếu chưa |
| R | verify_note | ghi chú xác thực |
| S | cn_machine | `true` nếu phần tiếng Trung là dịch máy |

## Bước 7 — Lấy Sheet ID

Từ URL của Google Sheet, ví dụ:
```
https://docs.google.com/spreadsheets/d/1wXldDsL7Zs3GYEXx7o1n3y7T1KHiWkasAgWNhBIUHaI/edit
```
→ Sheet ID là đoạn giữa `/d/` và `/edit`: `1wXldDsL7Zs3GYEXx7o1n3y7T1KHiWkasAgWNhBIUHaI`

## Bước 8 — Đưa thông tin cho tôi (Claude) hoặc tự cấu hình

Bạn có 2 cách:

**Cách A (khuyến nghị — an toàn hơn):** Tự đặt 2 giá trị này trực tiếp trên VPS khi tôi
deploy backend (tôi sẽ hướng dẫn tạo file `.env` trên server, không đưa vào Git):
- `GOOGLE_SHEETS_ID` = Sheet ID ở bước 7
- Nội dung file `credentials.json` ở bước 4

**Cách B:** Dán nội dung 2 giá trị trên vào chat để tôi cấu hình hộ. Vì token/JSON key
sẽ nằm trong lịch sử chat, nên nếu chọn cách này, hãy **thu hồi và tạo lại key mới** sau
khi triển khai xong (Bước 4, tab Keys → xoá key cũ → tạo key mới).

---
Sau khi hoàn tất, backend sẽ tự động: đọc Sheet → build `terms.json` → phục vụ qua
`/api/terms`. Sửa Sheet xong, gọi `curl -X POST "https://chimedis.vn/api/build-now?secret=..."`
hoặc đợi cron tự đồng bộ (sẽ cấu hình ở bước deploy) để cập nhật ngay lập tức.
