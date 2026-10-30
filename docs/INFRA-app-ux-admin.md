# Ghi nhớ kỹ thuật: UX app, nghe offline, duyệt/sửa thuật ngữ (cập nhật 2026-10-13)

Tài liệu này là "bộ nhớ" của dự án trên GitHub — các phiên Claude đọc trước khi sửa (xem cả `docs/SESSIONS.md`).

## Cử chỉ & điều hướng toàn app (frontend/index.html: `appBack`, `appForward`, `initSwipeNav`)
- **Vuốt từ MÉP TRÁI** (≤28 px) = lùi một bước; **từ MÉP PHẢI** = tiến lại bước vừa lùi (chữ ký trạng thái `navSig`, hết hạn khi người dùng đổi chỗ khác).
- **Giữa màn hình**: thẻ ôn tập — trái = thẻ kế, phải = thẻ trước; popup thuật ngữ — ngang = từ kế/trước (sẵn có), vuốt xuống = đóng.
- Thứ tự lùi: hộp xác nhận → trình sửa → danh sách nhóm → popup → màn duyệt/cài đặt/thanh toán/Lão Sư/admin/đăng nhập/menu → khu vực (nghe/ôn luyện/yêu thích/lọc nhóm/tìm kiếm) → trang chủ.
- ⚠ Luyện nghe / Ôn luyện / Yêu thích đặt `state.group1 = <SENTINEL>`: rời khu vực phải `selectGroup1('all')`, không chỉ đổi `state.tab` (lỗi "0 từ" đã gặp).
- Popup bỏ qua cử chỉ bắt đầu ở mép (dành cho lùi/tiến toàn app).
- Lớp nổi: `.pp-overlay.show` 5600 < `.gs-overlay` 5700 < `.up-scrim` 5800 < bottom-sheet 2147482000.

## Nghe offline & Cài đặt hệ thống
- IndexedDB `chimedis_offline/kv`: `aud:<url>` (mp3), `dlg:<id>` (văn bản bài), `offaud:index`, `terms`, `fig:*`, `meta`.
- Nút tải/xoá bài (icon cạnh ■ và ở thẻ danh sách), xoá luôn có xác nhận bottom-sheet. Hạn mức 100/300/500/1000 MB (`chimedis_offaud_cap_mb`).
- Menu ☰ → **Cài đặt hệ thống**: thanh dung lượng, xoá có chọn, giải phóng bộ nhớ, tuỳ chọn tải/giọng/ngôn ngữ trả lời, kiểm tra cập nhật.
- Màn "đang cập nhật" (logo + %) chặn thao tác khi live update tải bản mới (`luShow/luHide`); quá 90 s thì nhả.

## Chấm giọng nói (một bản phiên âm chuẩn)
- `backend/lib/speech.js`: whisper-1 (nhận ngôn ngữ + điểm không-có-tiếng-nói) → gpt-4o-transcribe; kho `speech_transcripts` theo SHA-256 âm thanh; `speech_analysis_cache`.
- Chấm nhanh nhận ngôn ngữ nói zh/vi/en rồi đối chiếu đúng bản tham chiếu; phân tích AI KHÔNG phiên âm lại, chỉ đánh giá + `issues`; hiện chi phí từng lượt.

## Từ báo sai → admin sửa ngay trong app
- Người dùng: nút ☆ ở MỌI thuật ngữ; biểu mẫu điền sẵn bản hiện tại (chữ Hán, Việt, Anh, định nghĩa Việt/Trung/Anh), chỉ gửi ô đã sửa. Bảng `term_feedback` (có `suggested_hz`, `suggested_def[_zh|_en]`).
- Admin: ☰ → "Từ vựng báo sai" (huy hiệu số, làm mới mỗi lần mở menu + 40 s), trình sửa bottom-sheet TRƯỚC→SAU. Chỉ admin; `adminOnly`.
- Lưu: **một giao dịch MySQL** — khoá hàng, ghi (`general_terms` / `anatomy_terms`: hz, py tự tính, vi, en, position_vi/zh/en, verify=1, machine_translated=0), nhật ký `term_edit_log` (trước/sau), đóng báo cáo. Bảng khác (dược liệu, huyệt…) → `term_overrides` (hz/vi/en), áp lúc trả `/api/terms`.
- Ràng buộc: hz chỉ chữ Hán; trùng `uq_general_hz` → báo `hz_exists`; định nghĩa của nhóm không phải anatomy/general chưa sửa được ở đây.

## Việc còn mở
- Định nghĩa của nhóm Dược liệu/Huyệt vị/Từ ghép (trường riêng) — chưa có trình sửa.
- Tải nền thật khi tắt app (cần plugin Background Transfer gốc).
- Workbench nên đọc `general_terms` thay vì ảnh chụp JSON (xem INFRA-shared-terminology.md).

## Chấm nhanh nhiều chiều (v50, 2026-10-13)
- Mục tiêu: chấm **chính lời nói**, không chấm theo văn mẫu. Ba chiều: **Rõ ràng/phát âm** (độ tin cậy nhận dạng, tốc độ, ngắt nghỉ) · **Đủ ý** (chỉ khi có căn cứ cùng ngôn ngữ nói) · **Mạch lạc & trôi chảy** (lặp, từ đệm, độ dài). Code: `backend/lib/quick-eval.js`, route `/api/quick-check`.
- Ngôn ngữ: văn bản hiển thị luôn theo ngôn ngữ **thực sự nói** (`dominantLang` đếm từ/chữ). Câu Anh xen vài từ Hán vẫn là Anh; không ép `language` theo nhãn whisper (`speech.js`). Chọn "Chấm theo ngôn ngữ" ≠ ngôn ngữ nói → báo `lang_mismatch`, bỏ chiều Đủ ý, không chấm chéo.
- Phân tích sâu AI chỉ đánh giá transcript đã chốt; ngữ pháp/thanh điệu từng âm tiết cần phân tích sâu.
- Tag ADMIN bị cắt: gốc là `.drawer-item svg{flex:0 0 20px}` rò vào SVG trong tag → `.drawer-item .role-tag svg{width:11px;flex:0 0 11px}`.

## Phân tích sâu AI v3 + sửa lỗi nút Stop khi ghi (v52, 2026-10-13)
- `/api/pronunciation-score`: đánh giá lời nói theo phát âm · ngữ pháp · mạch lạc/đủ ý · thuật ngữ (+ điểm tốt, điểm cần sửa); văn mẫu chỉ làm căn cứ khi **cùng ngôn ngữ** với lời nói. Khoá cache `v3|…`. Tổng = 40% phát âm + 30% ngữ pháp + 30% mạch lạc.
- Nút Stop biến mất khi ghi: màn bị `render()` lại giữa lúc ghi → `renderListenDialogue` trả nút Stop ẩn. Sửa: khôi phục UI ghi sau render; `onstop` chỉ dọn state nếu vẫn là chính lần ghi đó (tránh ghi đè lần ghi mới); rời màn nghe thì dừng mic.
- Nhãn nút "Tải / cập nhật bộ tra cứu" dùng nhầm khoá `oa_download` ("Tải về để nghe offline") → khoá riêng `sys_dl_btn`.

## Màn chờ toàn màn hình (v53)
- Quy tắc: tải nội dung nào cũng phải có màn chờ rõ (logo + thanh chạy), không để màn trống. Hàm dùng chung `busyShow/busyHide/withBusy` (`#busyOverlay`, z-index dưới màn cập nhật bản mới, tự gỡ sau 30 s).
- Đã áp dụng: lần đầu vào Nghe/đổi tab danh mục (chỉ khi chưa có cache), Học Thuật lần đầu, mở một bài nghe (gồm tải trước âm thanh). Lỗi mạng không lưu danh sách rỗng → lần vào sau tải lại.
- Việc nên rà tiếp: các tải khác (Học tập, Từ điển lần đầu…) cần dùng cùng hàm này.

## v54 (2026-10-13)
- **Phân tích sâu AI tách khung riêng**: `lineDeep[seq]` + `listenDeepPut` — kết quả/loading nằm trong `.lsc-deep` bên dưới; video/âm thanh đã ghi và điểm chấm nhanh KHÔNG bị dựng lại (kiểm tra: cùng phần tử `<audio>`).
- **Màn chờ toàn màn hình** bọc thêm (cuối script, `busyWrapAll`): kho thuật ngữ lần đầu, danh sách Học Thuật, thanh toán/đổi mã, Lão Sư mở đầu/chọn chủ đề, Tự Thêm (tải, gửi, đọc tệp), duyệt từ báo sai, góp ý, các thao tác admin.
- **Lưu video vào Ảnh (iPhone)**: kiểu tệp chuẩn hoá `video/mp4` (bỏ `;codecs=`), đuôi `.mp4`; thông báo rõ khi thiết bị không chia sẻ được/WebM/ghi hình lỗi. Cần cắm plugin Filesystem/Media nếu share sheet vẫn không có "Lưu video".

## v55 — toast bị che + trình sửa thuật ngữ báo kết quả ngay trong bảng
- Gốc lỗi "bấm lưu mà không thấy gì": `.listen-toast` là `position:absolute; z-index:60` trong `#app`, nằm DƯỚI bảng sửa (z 2147482000) → mọi thông báo (thành công/lỗi) đều vô hình khi có bảng/popup. Nay toast `position:fixed; z-index:2147483600` gắn vào `body`.
- Trình sửa: dòng trạng thái trong bảng (Đang lưu / ✓ Đã lưu → tự đóng sau 0,9 s / ✗ lỗi kèm mã), timeout 30 s, lỗi server trả `detail` (chỉ route admin) để chẩn đoán.
- Quy tắc: mọi thao tác ghi dữ liệu phải có trạng thái hiển thị CÙNG tầng với nơi người dùng đang nhìn, không dựa vào toast.

## v56 — màn chờ dạng popup; Lão Sư nhận ra lời chào
- Màn chờ chung (`#busyOverlay`) đổi thành **popup nhỏ** (thẻ trắng + vòng xoay, nền mờ 22%). Màn xanh toàn màn hình (`#luOverlay`) CHỈ dùng khi cập nhật phiên bản ứng dụng. Lão Sư dùng chỉ báo "đang gõ" trong khung chat, không dùng overlay.
- Lão Sư (`backend/lib/laoshi.js`): thêm **phân loại ý định** — `isSmallTalk()` nhận ra chào hỏi/cảm ơn/tạm biệt/"thầy là ai" (vi/zh/en, ngắn, không có thuật ngữ y học, không phải đáp án A/B/C): bỏ chấm câu đố và nạp ngữ liệu, dặn mô hình ĐÁP LẠI như người thật (1–3 câu, có thể kèm tiếng cười), nhắc nhẹ câu đố đang chờ. Không đưa lời chào vào kho FAQ và không cho kho FAQ chặn lời chào.

## v57 — Trò chuyện tự do, quy ước dịch dùng chung, gộp báo cáo trùng, lưu có thử lại
- **Trò chuyện tự do** (menu riêng, Max): luyện khẩu ngữ bằng giọng nói. Màn `#talkScreen`: nút mic lớn (chạm nói / chạm gửi), chọn ngôn ngữ nói (中文/Việt/English), rảnh tay tự nghe tiếp, chữ phụ có thể ẩn. Luồng: ghi âm → `/api/laoshi/transcribe` → `/api/laoshi/chat` với `talk:true` (persona `TALK_PERSONA`: 1–3 câu nói, không đố/danh sách, nhắc lại đúng để sửa lỗi, hỏi nối) → `/api/laoshi/tts` phát tiếng. Khung chat chữ của Lão Sư giữ nguyên (đố, trắc nghiệm, chữ là chính).
- **Quy ước dịch thuật ngữ** `backend/lib/tcm-style.js`: `STYLE_RULES` (Hán-Việt cho thuật ngữ Trung y, không "Tây y hoá", WHO/pinyin cho tiếng Anh, nhất quán) + `glossaryTerms()` lấy các mục CSDL có mặt trong văn bản nguồn làm BẢNG THUẬT NGỮ BẮT BUỘC. Đã nối vào: Lão Sư (`laoshi.reply`), bài Tự Thêm (`user-docs` prompt biên tập/dịch), thuật ngữ tự học (`term-learn.askModel`). Ví dụ gốc lỗi: 失神发作 bị dịch "Cơn vắng ý thức" thay vì "Thất thần phát tác".
- **Gộp báo cáo trùng**: `trUnique()` — cùng nội dung → một dòng "N người báo"; chỉ khi khác nhau mới liệt kê để chọn bản đúng (chạm = điền sẵn vào trình sửa).
- **Lưu thuật ngữ**: lỗi mạng (TLS reset) → tự thử lại tối đa 3 lần, báo "đang thử lại".
- Còn mở: quét lại hàng loạt thuật ngữ `machine_translated` theo quy ước (cần duyệt chi phí + ra danh sách đề xuất để admin duyệt, không tự ghi).

## v58 — rà soát theo quy ước dịch, Trò chuyện tự do bố cục cố định, cử chỉ vuốt thông minh
- **Rà soát thuật ngữ máy dịch theo quy ước** (admin, màn "Từ báo sai" → thẻ trên cùng): `POST /api/admin/term-restyle/run` quét 25 mục `machine_translated=1` mỗi lần (gpt-5-mini + `STYLE_RULES` + bảng thuật ngữ), lưu đề xuất vào bảng `term_restyle` (không tự ghi); admin bấm Áp dụng → ghi qua `/api/admin/term-edit` (transaction + nhật ký) hoặc Bỏ qua. Mục đã ổn đánh dấu `ok`, không quét lại. Tính vào ngân sách AI của admin.
- **Trò chuyện tự do**: bố cục cố định (ngôn ngữ → mic → khung lưu hội thoại cuộn được → hai lựa chọn ghim dưới đáy). "Hiện chữ" chỉ làm mờ khung. Biểu tượng mic đổi bằng CSS `data-s` (không dựng lại DOM) + vòng xung bằng `::before` — tránh lỗi bóng ma trên iOS.
- **Vuốt lùi/tiến**: bỏ nút gợi ý; chỉ hoạt động ở màn điều hướng. `swipeNavAllowed()` chặn khi: đang trò chuyện/chat với thầy, đang ghi âm, có form/sửa/xác nhận/thanh toán/đăng nhập, đang nhập liệu, chạm vào ô nhập/audio/video.

## v59 (2026-10-14) — GỐC LỖI "Mất kết nối" khi lưu thuật ngữ
- **Nguyên nhân thật**: `mysqlPool` (lib/db.js) chỉ là wrapper `{ query }`, KHÔNG có `getConnection`. `editTerm` gọi `pool.getConnection()` NẰM NGOÀI `try` → ném TypeError trong handler async → Express 4 không bắt → *unhandled rejection* → tiến trình Node chết giữa chừng → điện thoại thấy "mất kết nối" (và máy chủ khởi động lại → các màn khác tải rất lâu). Không phải lỗi mạng.
- **Sửa**: wrapper thêm `getConnection`; `editTerm` đưa getConnection vào `try`, kiểm tra hàm tồn tại; route `term-edit` bọc try/catch; thêm `process.on('unhandledRejection'/'uncaughtException')` ghi log thay vì sập.
- **Bài học**: mọi code dùng giao dịch phải kiểm thử trên wrapper thật; không để `await` ngoài try trong handler async của Express 4.
- Rà soát quy ước: kết quả quét luôn hiển thị trong thẻ (tóm tắt lần quét, tổng đã kiểm tra, danh sách mục đạt, lỗi nếu có); mô hình không trả kết quả thì KHÔNG đánh dấu đã quét. Đếm "còn lại" không còn dùng NOT IN (chậm).
- Nút "lên đầu trang" căn giữa đáy, không đè nút ghi hình.

## v60 (2026-10-14) — đồng bộ gói/credit với chimedis.vn, sửa/duyệt hàng loạt, layout web & iPad ngang
- **chimedis.vn là trang mẹ về gói** (spec: chimedis-home/docs/INFRA-plans-and-usage.md): `backend/lib/ai-budget.js` = bản sao nguyên văn của workbench (1 credit = $0,001; CREDIT_MICRO=1000). `billing.js` PACKS credits ×10 (1000/3000/8000), amount giữ nguyên; đơn nạp ĐANG CHỜ tạo theo đơn vị cũ được quy đổi (UPDATE khớp cặp credits+amount, không DDL). Frontend: PLAN_BUDGET_CREDITS {2000,2000,4000}; nút Nâng cấp/Gia hạn/Nạp credit trên WEB mở `https://chimedis.vn/goi.html` (tab mới); iOS vẫn NO_PURCHASE_UI. Bảng mức dùng AI dùng `https://chimedis.vn/assets/ch-usage.js` + `GET https://chimedis.vn/api/account/plan` (lỗi mạng → bảng cũ làm dự phòng). Endpoint đơn hàng của dict (/api/billing/config, /api/orders…, /api/redeem, /api/payments/sepay) GIỮ NGUYÊN hình dạng. `plan.js` chỉ ALTER users khi thật sự thiếu cột (không đổi).
- **Trình xem hình huyệt**: áp dụng transform đồng bộ (trước dùng rAF — trên iOS có lúc không chạy nên ảnh không hiện tới khi bấm +/−) và khớp lại khi ảnh tải xong.
- **Duyệt/sửa hàng loạt**: `POST /api/admin/term-edit-batch` (≤60 mục, mỗi mục một giao dịch); màn Từ báo sai: chọn nhiều → "Áp dụng đề xuất chính"; thẻ Rà soát: ô sửa nhanh VI/EN từng dòng + "Áp dụng đã chọn"; sau khi lưu có thanh "Xem từ" để xem thực tế. Danh sách báo sai có bộ nhớ đệm (mở màn hiện ngay, cập nhật sau).
- **Layout ≥1024px** (web/iPad ngang): khung 1120px (≥1360: 1280px), danh sách thuật ngữ 2–3 cột, bài nghe 2–3 cột, hộp chi tiết 760px, màn chat/nói giới hạn 860px. Điện thoại và iPad dọc không đổi.

## v61 — đồng bộ ngôn ngữ chimedis.vn ⇄ dict
- Vào dict kèm `?lang=vi|zh|en` → lưu `chimedis_lang` TRƯỚC khi khởi tạo giao diện, xoá tham số khỏi URL (replaceState); ngôn ngữ từ URL thắng cài đặt máy chủ lần đó rồi được đẩy lên máy chủ.
- `withLangParam(url)`: mọi liên kết ra `*.chimedis.vn` (không phải dict) gắn `?lang=` theo `state.lang` TẠI LÚC BẤM (hiện áp dụng cho nút Nâng cấp/Gia hạn → goi.html).

## v62 — bộ tra cứu offline: trạng thái rõ + tải bền
- Mục menu "Bộ tra cứu offline" giờ MỞ màn trạng thái (không tự tải lại mỗi lần bấm). Trạng thái: ✓ đã tải đủ (n mục, a/b hình, ngày) · ◐ tải dở a/b (nút "Tiếp tục tải") · chưa tải; nút đổi theo trạng thái (Tải về máy / Tiếp tục tải / Cập nhật).
- Tải hình: mỗi hình thử lại 3 lần, timeout 20 s; một hình lỗi KHÔNG hỏng cả gói (đếm số hình chưa tải, lần sau tiếp tục). Lỗi được báo đúng nguyên nhân: không có mạng / quá 20 giây / máy chủ từ chối (mã) / máy chủ lỗi / kết nối ngắt giữa chừng — thay vì chung chung "kiểm tra mạng".

## v63 — Đăng nhập MỘT LẦN (SSO) với chimedis.vn
- ĐẾN dict: `?sso=<mã>` → xoá khỏi URL ngay; đợi auth (tối đa 6 s) → `POST https://chimedis.vn/api/sso/peek` → cùng uid thì bỏ qua; chưa đăng nhập thì `exchange` + `signInWithCustomToken`; ĐANG đăng nhập tài khoản KHÁC thì HỎI "Chuyển sang X / giữ Y" (uiConfirm) rồi mới exchange. Không chạy trong app iOS.
- ĐI từ dict: `openPlansPage()` mở tab `about:blank` ngay trong cú bấm, rồi `chimedisSsoStart()` (`/api/sso/start` với ID token) và điều hướng tới `goi.html?lang=..&sso=<mã>`; lỗi thì mở liên kết thường.
- Server: `getOrCreateUser` dùng `COALESCE(VALUES(x), x)` cho email/tên/ảnh (phiên custom token có thể thiếu claim).

## v64 — Điều hướng mẫu B, tìm kiếm luôn ưu tiên, tra cứu AI tự học
- **Điều hướng chính (mẫu B)**: `#mainNav` — điện thoại: thanh 4 nút ở đáy (Từ điển · Luyện nghe · Trò chuyện · Lão Sư); iPad/web (≥768px): thanh ngang ngay dưới ô tìm kiếm. Trạng thái active theo `state.group1/tab` (hàm `updateMainNav`, gắn qua bọc `render`). Nút lên đầu trang/FAB ghi hình được nâng lên trên thanh đáy.
- **Tìm kiếm luôn ưu tiên**: gõ vào ô tìm ở Luyện nghe/Ôn luyện → tự quay về từ điển và hiện kết quả; nhóm đang chọn không có kết quả → tìm trong TOÀN BỘ kho kèm nhãn "tìm trong toàn bộ kho".
- **Tra cứu AI + tự học** (`backend/lib/ai-lookup.js`, `POST /api/ai-lookup`): kho không có → thẻ "Tra bằng AI". Luồng: cache MySQL `ai_lookup` (khoá theo chữ Hán/không dấu; cache-only tự kiểm tra ngay khi không có kết quả) → giới hạn lượt/ngày theo gói (free 12 · pro 40 · max 100) + trần hệ thống 400/ngày → mô hình gpt-5-mini kèm QUY ƯỚC dịch + mục liên quan trong kho → lưu cache + nếu là thuật ngữ y khoa, confidence ≥ 0,6 → `learnTermDirect` đưa vào `general_terms` ("Mới (tự học)", chưa duyệt, máy dịch) → lần sau tìm thấy ngay, không cần AI; admin duyệt ở mục thuật ngữ tự học/Rà soát. Chi phí ghi vào sổ với uid='system' (hệ thống chịu, không trừ hạn mức người dùng). Chỉ cụm ngắn (≤12 chữ Hán / ≤6 từ); câu/đoạn dành cho "Hỏi Chimedis" (đề xuất riêng).

## v65 — nav kín đáy, tra từ không rời màn học, tra cứu AI phân loại, tra web
- **Thanh dưới**: phủ kín đáy (padding an toàn nằm TRONG thanh, `.app{padding-bottom:0}` trên điện thoại); ẩn khi bàn phím mở (`#app.kb-open`) để không nhảy lên giữa màn hình.
- **Khung tra cứu nổi** (`#lookupSheet`): đang ở Luyện nghe/Ôn luyện gõ vào ô tìm → hiện khung kết quả phủ lên, KHÔNG đổi tab/nhóm; "Quay lại bài học" đóng khung. Trong khung, kết quả luôn tìm toàn kho; không có → thẻ tra AI.
- **Hàng danh sách** có chữ Hán/Latin dài (`.vrow.long-hz`): bố cục 2 cột, không còn vỡ/chồng chữ (lỗi CONSORT, 病例报告表).
- **Tra cứu AI v2** (`ai-lookup.js`): tự chạy (đăng nhập, kho 0 kết quả, dừng gõ 1,5 s): cache-only trước → chưa có thì AI một lần. Phân loại `kind`: tcm_term (học vào kho Tổng hợp nếu tin cậy ≥ 0,6) | general_word (nghĩa thông thường) | symptom_or_topic (cách nói đời thường: liệt kê huyệt/bệnh/phương LIÊN QUAN, đối chiếu từng mục với kho — có trong kho thì bấm mở, chưa có thì chip nét đứt "+" để đề nghị thêm). Không còn câu "không phải thuật ngữ" cụt.
- **Tra từ trên mạng** (`web-define.js`, `GET /api/web-define`): định nghĩa từ phổ thông từ Wiktionary (nguồn mở, phía máy chủ, cache 30 ngày, không AI, không credit); CHỈ hiện ở bản web trong hộp nhỏ ghi rõ "không phải kho Chimedis, không liên quan y khoa"; app iOS không hiện. Google/Baidu Search không dùng được trực tiếp (cần khoá API + hạn mức, Baidu không có API công khai) — Wiktionary là phương án không khoá, không phí.
- **Đề nghị thêm vào kho**: người dùng bấm "Báo kho thiếu" → `term_feedback` với term_id `miss-…` → admin thấy ở màn Từ báo sai, nút "Thêm vào kho" (`POST /api/admin/term-add` → `learnTermDirect`).

## v66 — nút nổi bám thanh dưới, bộ nhớ video theo bài, nghe theo ngôn ngữ, tìm kiếm AND, liên quan đa nhóm
- **Trình xem hình huyệt** nằm trên popup (z-index 5900 > popup 5600): lỗi "chỉ thấy nút −/+" do hồi quy z-index khi tôi nâng popup lên 5600.
- **Rò dữ liệu giữa các bài**: ghi âm/video/phiên âm/điểm gắn theo SỐ CÂU nên bài 2 hiện video của bài 1. Nay `listenResetLineState()` xoá sạch khi mở bài khác.
- **Thanh điều hướng**: `position:absolute` bám đáy, tự ẩn khi cuộn xuống/hiện khi cuộn lên (`.nav-hidden`); biến `--navoff` để nút lên đầu trang và nút ghi hình bám theo. Bàn phím nhận bằng visualViewport (không dùng focus nên không bị kẹt thanh ẩn).
- **Nghe theo ngôn ngữ**: lựa chọn "Nghe bằng" (gốc/中文/Việt/English); ngôn ngữ khác gốc dùng `GET /api/listen-tts` (Pro+, tổng hợp theo câu, đệm MySQL dùng chung). Nhận dạng ghi âm LUÔN ở máy chủ, tự nhận ngôn ngữ từ âm thanh (bỏ Web Speech vì ép ngôn ngữ nên câu tiếng Anh có chữ China ra chữ Hán).
- **Tìm kiếm nhiều từ**: tầng mới — đủ MỌI từ trong tên/nội dung chính (3,5) > đủ mọi từ ở bất cứ đâu (4,5) > chỉ một phần/đồng nghĩa. Tra cứu online chỉ chạy khi KHO KHÔNG có mục chứa đủ các từ (`searchHasFullMatch`).
- **Liên quan đa nhóm**: tra cứu online và Lão Sư truy xuất kho ở nhiều nhóm (Tổng hợp, Bệnh lý, Huyệt vị, Dược liệu) và quét nội dung các mục khớp để nêu thêm huyệt/dược/bệnh liên quan; thêm loại "thực dưỡng" (AI gợi ý).
- Ghi chú admin → GitHub: xem `docs/ADMIN-NOTES-TO-CLAUDE.md`.

## v67 — đăng nhập ở Trung Quốc (app iOS)
- Triệu chứng: bấm Google trong app → "auth/chimedis-timeout" sau 20 s. Nguyên nhân: bộ chọn Google gốc không tới được dịch vụ Google khi không có VPN → treo. App trước đây luôn coi là tới được.
- Sửa: app cũng thăm dò `generate_204` (khi múi giờ/ngôn ngữ nghi ở TQ) → ẩn nút Google/Facebook (`[data-gfw]`), GIỮ Apple và email; khi timeout thì tự ẩn và báo rõ "cần VPN, hãy dùng Apple/email". Có lối "đã bật VPN → bấm để hiện".

## v68 — ghi chú admin: đánh thức routine Claude Code (cloud) + hướng dẫn chi tiết
- `POST /api/admin/dev-note` sau khi tạo Issue gọi API trigger của routine nếu có `CLAUDE_ROUTINE_FIRE_URL` + `CLAUDE_ROUTINE_TOKEN`. Hướng dẫn từng bước + chi phí: `docs/ADMIN-NOTES-TO-CLAUDE.md`.

## v68b — ghi chú admin: chốt cách đơn giản
- Gác lại dịch vụ chung ở chimedis.vn. Mỗi app tự tạo Issue `claude-todo` trong repo của mình; việc xử lý bằng lệnh `/chimedis-note` (skill ở `~/.claude/skills/chimedis-note`). Xem `docs/ADMIN-NOTES-TO-CLAUDE.md`.

## v69 — hộp ghi chú/sửa không bị bàn phím che (Issue #1)
- iOS không co khung nhìn bố cục khi bàn phím mở nên bottom-sheet bị nằm dưới bàn phím. Nay `.ui-sheet-scrim.kb` bám theo `visualViewport` (biến `--vvh`/`--vvt`), `.ed-sheet` giới hạn chiều cao theo vùng nhìn thấy và ô đang gõ tự cuộn vào giữa.

## v70 — tốc độ: mở lại không phải tải từ đầu
- **Gốc chậm đã tìm ra**: (1) service worker phục vụ `index.html` kiểu *network-first* → mở app phải chờ tải ~300 KB qua mạng (chậm/đứt ở TQ); (2) hình huyệt `Cache-Control: max-age=0` + bộ nhớ hình bị XOÁ mỗi lần phát hành (cache theo phiên bản); trong app còn không dùng bản đã tải offline khi đang online (chỉ dùng khi lỗi); (3) danh sách bài nghe/Học Thuật chỉ giữ trong RAM nên mở lại là tải lại và hiện màn chờ.
- **Sửa**: SW — HTML *stale-while-revalidate* (hiện ngay, cập nhật ngầm; bản mới vào qua cập nhật SW như cũ); bộ nhớ hình/biểu tượng riêng `chimedis-media-v1` KHÔNG xoá khi phát hành, cache-first; `/api/terms` chờ mạng tối đa 4 s rồi dùng bản đã lưu; danh sách bài nghe/Học Thuật SWR. Máy chủ — hình/biểu tượng `max-age=30 ngày`, vendor 1 ngày. App — danh sách bài nghe, bài đã mở và Học Thuật lưu IndexedDB và hiện NGAY (mạng cập nhật ngầm, không màn chờ); hình đã tải offline được dùng NGAY khi có (MutationObserver), không chờ mạng; làm nóng danh sách bài nghe khi rảnh.

## v71 — Tìm kiếm: từ điển + Bác sĩ Trung Y (2026-10-19)
- Thẻ "Bác sĩ Trung Y" trong kết quả tìm kiếm (thu gọn 2 dòng, nút "Chat với Lão Sư →", "Xem đầy đủ" nhỏ bên phải). Kho có khớp đủ → chỉ gợi ý, không gọi AI; kho không khớp → tự tra AI sau 1,5s (hệ thống trả phí, có giới hạn), lưu server (`ai_lookup`) + IndexedDB (`ail:<key>`) để hiện lại tức thì.
- Tô sáng từ trùng bằng `mark.hl` (không gạch chân).
- Xếp hạng: từ nhóm (huyệt/thuốc/bệnh/phương…) chỉ làm gợi ý nhóm; mục đúng nhóm lên trước.
- Lão Sư: lịch sử chỉ trong sessionStorage (thoát app là xoá), nút "Làm mới", mic cạnh nút Gửi, `openLaoshi({seedQuery,seedAnswer})`.
- Màn ≥1024px: hai cột (từ điển trái, thẻ bác sĩ phải, sticky). SW v71.

## v73 (2026-10-20)
- Tìm kiếm: tô cả từ đồng nghĩa; đoạn trích có tô sáng khi khớp ở trường không hiện; thẻ Bác sĩ tự giải thích cả khi kho đã có từ (lưu vĩnh viễn → lần sau không tốn AI).
- Header thu gọn khi cuộn: rAF + trễ (90/15px) để hết giật.
- Trò chuyện tự do: thầy mở lời tại chỗ (không gọi AI); persona không lặp lại câu học trò, chỉ sửa khi có lỗi rồi trả lời; bỏ bảng thuật ngữ nặng, max 900 token.
- Nút đổi ngôn ngữ nổi (#langFab) + 3 nút VI/中文/EN trong Lão Sư. Hiện số phiên bản web ở chân menu.

## v74 — Bài nghe lưu MySQL (không cần redeploy) + Bác sĩ 3 ngôn ngữ (2026-10-20)
- Bảng `listening_lessons` + `listening_audio` (MEDIUMBLOB); `backend/lib/listening-db.js`. Bài trong MySQL gộp với bài file cũ (trùng id → MySQL thắng). Danh sách giữ trong RAM, làm mới sau mỗi lần ghi và mỗi 60 giây.
- Âm thanh MySQL phục vụ ở `/audio/listening/<cat>/<id>/…mp3` (có Range) khi không có file cùng đường dẫn.
- Đẩy bài: `PUT /api/admin/listening/lesson` ({lesson, audio:{path:base64}}), xoá: `DELETE …/:id`; xác thực admin Firebase HOẶC header `x-lesson-key` = env `LESSON_PUSH_KEY` (cần đặt trên Hostinger rồi Restart). Script: `backend/push-listening-lesson.mjs`.
- `ai_lookup`: thêm cột `tcm_context_zh/_en`, `ml`; AI trả đủ Việt/Trung/Anh; bản cũ chỉ tiếng Việt được tra lại một lần khi cần ngôn ngữ khác.

## v75 (2026-10-20)
- Thẻ Bác sĩ: kho ưu tiên. Kho đã có từ → tóm tắt từ kho (miễn phí, tức thì: mục khớp nhất + mục liên quan gom theo nhóm) và nút "Giải thích kỹ hơn bằng AI" (chỉ chạy khi bấm). Kho chưa có → AI tự tra (lưu vĩnh viễn, dùng chung).
- Pipeline tự động (GitHub Actions fetch-pubmed/news/yaan) đẩy bài lên MySQL qua `scripts/push_lessons.py` thay vì commit vào main → hết redeploy hằng ngày. Cần secret `LESSON_PUSH_KEY` ở GitHub (Settings → Secrets → Actions) VÀ biến môi trường cùng giá trị trên Hostinger. Chưa có khoá → tự dùng cách commit cũ. Trạng thái "đã xử lý" lưu ở nhánh `pipeline-state` (`scripts/pipeline_state.sh`).
- `/app-bundle/log.json`: nhật ký 200 lượt hỏi/tải gói cập nhật của app (chẩn đoán).

## v77 — Speaking: đọc hết, rảnh tay có dừng, bỏ đọc pinyin (2026-10-20)
- Nguyên nhân đọc cụt: `LS_TTS_MAX=700` cắt văn bản + `lsSplitRuns` giới hạn 14 đoạn. Nay giới hạn 3600 ký tự, đoạn dài cắt ≤700 ở chỗ ngắt câu, tối đa 80 khúc (mỗi khúc dùng bộ đệm dùng chung).
- Rảnh tay: tự dừng sau 45 giây không chạm gửi; tối đa 15 phút/phiên; nút "Dừng" cạnh micro (`talkStop`).
- Pinyin không đọc: `lsStripPinyin` (âm tiết hợp lệ có dấu thanh, cần dấu đặc trưng hoặc đứng sau chữ Hán) + persona Trò chuyện không viết pinyin.
- Chi phí giọng: nam = Wavenet 16 USD/triệu ký tự, nữ = Chirp3 HD 30 USD/triệu ký tự (`ai-budget.js`).

## v78 — Speaking: không gửi khi im lặng, ⏸/▶, tự dừng chỉnh được (2026-10-20)
- Lỗi "tự gửi một loạt chữ Hán": khi im lặng, ASR trả lại danh sách thuật ngữ gợi ý (`ASR_BIAS`). Sửa 2 lớp: (1) client đo âm lượng (VAD) — chưa có tiếng nói thì không gửi; (2) `/api/laoshi/transcribe` loại bản chép chủ yếu gồm thuật ngữ trong danh sách gợi ý.
- Nút ⏸ Tạm dừng / ▶ Tiếp tục: đang đọc → tạm dừng giọng thầy (tiếp tục đọc đúng chỗ); đang nghe/chờ → dừng hẳn, ▶ để nghe tiếp.
- Rảnh tay: chưa nói sau N giây → tự dừng (mặc định 10s); nói xong im quá M giây → tự dừng và gửi (mặc định 5s). Chỉnh ở Cài đặt hệ thống → Tuỳ chọn nghe (N: 5/10/15/30, M: 2/3/5/8). Trần cứng 90 giây/lượt nghe, 15 phút/phiên.

## v80 — Cập nhật app iOS chịu mạng chậm (2026-10-20)
- Điện thoại báo "Fetch is aborted" dù máy chủ chạy: yêu cầu hỏi `latest.json` xếp hàng sau các tải nặng lúc khởi động và bị huỷ ở 20 giây (v76). Nay yêu cầu được khởi động ngay đầu `<head>` (`window.__luFirst`), chờ tới 60 giây, rồi thử lại tối đa 3 lần (45 giây/lần). Trạng thái ghi `không tới được máy chủ: …` kèm lý do.
- Đã đưa www/ v80 vào repo chimedis-ios cho Build 16.

## Ghi chú #4 (2026-10-21) — Nút tra online riêng (quả địa cầu)
- Kính lúp vẫn là tìm kiếm thường. Nút quả địa cầu `#onlineBtn` (chỉ hiện khi đã đăng nhập và gõ ≥2 ký tự) gọi `searchOnline()`: tra online (AI + Wiktionary bản web), luôn chạy lại, kể cả khi kho đã có kết quả hoặc đổi sang từ khác. Không trừ credit (hệ thống chịu, có giới hạn ngày); kết quả lưu `ai_lookup` dùng chung.
- Y khoa kho chưa có → `learnTermDirect` ghi vào CSDL y khoa (đã có). Từ phổ thông → lưu ở `ai_lookup`; chưa đưa vào kết quả tìm kiếm thường.

## Ghi chú #5 (2026-10-21) — Ghi âm bị ngắt khi khoá máy (phương án nhỏ)
- `visibilitychange` (trước `loadTermsFromAPI`): khi app bị ẩn → Trò chuyện dừng nghe gọn (`talkInterrupt`), Lão Sư huỷ mic, Luyện nghe dừng và giữ phần đã ghi; khi hiện lại → rảnh tay tự nghe tiếp, còn lại báo "Ghi âm bị ngắt khi khoá máy. Chạm micro để ghi tiếp." và dọn trạng thái "đang ghi" bị hệ điều hành ngắt ngầm. Ghi âm khi khoá máy (nền) cần quyền âm thanh nền iOS + build lại — chưa làm.
## Ghi chú #3 (2026-10-21) — Speaking: bỏ tiếng cười, đọc đúng 腧/俞, chặn pinyin
- `lsSpeechText`: bỏ hẳn "haha/hì hì/哈哈/biểu tượng cười" (trước đây đổi thành 哈哈哈). Persona Lão Sư/Trò chuyện không viết tiếng cười.
- `user-docs.zhSpeechFix` (áp dụng trong `synthesize` cho mọi giọng tiếng Trung — Lão Sư, Trò chuyện, Học Thuật, Tự Thêm): 腧/俞→述 (shù), 输穴→述穴, 白术/苍术→竹, 膻中, 数脉, 率谷, 阿胶. Chỉ đổi chữ đưa cho giọng đọc, chữ hiển thị không đổi. Thêm bảng tại ZH_SPEECH_FIX.
- Bộ đệm giọng cũ: `laoshi_tts` đổi khoá sang `v2|…`; `csdl_audio` thêm cột `fixv`, câu cũ có chữ cần sửa sinh lại đúng một lần.
- Chặn pinyin không dấu đứng sau chữ Hán (vd "麻黄 ma huang"). Bài nghe dựng sẵn bằng Python (hoc_thuat/bao_chi/y_an) KHÔNG đổi.
- (v83) Đã tắt tự gọi AI khi gõ: chỉ còn kiểm tra bản đã lưu (máy + máy chủ, miễn phí); AI chỉ chạy khi bấm nút quả địa cầu. Thẻ Bác sĩ chưa có kết quả hiện gợi ý "bấm nút quả địa cầu".

## Mục "Tìm kiếm online" (2026-10-21, v84)
- Nút quả địa cầu (`#onlineBtn`) cố định cạnh kính lúp khi đã đăng nhập (ẩn khi chưa đăng nhập và trong app iOS). Mở màn riêng `#onlineScreen` (`openOnlineScreen`/`onlineRun`), gọi `GET /api/web-search` (`web-define.js › webSearch`): Wiktionary + Wikipedia (vi/en hoặc zh/en), cache 30 ngày trong `web_define_cache`, giới hạn 40 lượt/10 phút/người, kèm liên kết Baidu/Bing/Google. KHÔNG dùng AI, KHÔNG credit, không dùng chung trạng thái với thẻ Bác sĩ.
- Thẻ Bác sĩ khi kho chưa có từ: gợi ý + nút "Hỏi Bác sĩ Trung Y (AI)" (chỉ chạy khi bấm); hộp Wiktionary cũ trong thẻ đã bỏ.
- Google/Bing/Baidu Search API không dùng được miễn phí cho cả hệ thống (cần khoá + hạn mức/trả phí; Baidu không có API công khai) → chỉ mở liên kết sang trang tìm kiếm của họ.

## v85 (2026-10-22) — Hộp ghi chú mở rộng + tô sáng trong thẻ từ
- Ghi chú cho Claude: chạm vào ô nhập → bảng mở rộng toàn màn hình (cuộn được), nút "Xong" thu về bảng mặc định, giữ nguyên chữ đã gõ (`.ui-sheet-scrim.expanded`, `.ed-done`).
- Thẻ chi tiết từ (`openPopup`): giữ tô sáng từ khoá đang tìm (`hlDom` quét các nút văn bản, bỏ qua nút bấm/ô nhập).

## Xoá tài khoản + chính sách bảo mật (2026-10-22, v87)
- `POST /api/account/delete` (`lib/account-delete.js`, `firebase-admin.deleteFirebaseUser`): cần `confirm:'DELETE'`, giới hạn 3 lần/giờ, từ chối tài khoản admin. Xoá: tài liệu riêng + giọng đọc, credit/ledger, bộ đếm dùng, phiếu sửa ASR, góp ý thuật ngữ, hồ sơ `users` (các bảng `user_*` xoá theo khoá ngoại CASCADE); gỡ liên kết người tạo ở `ai_lookup`, `laoshi_faq`, `redeem_codes`; `orders` giữ ẩn danh (bỏ email, mã người dùng → `deleted-<băm>`); rồi xoá user Firebase.
- Giao diện: nút "Xoá tài khoản" trong khung Tài khoản (`doDeleteAccount`), xác nhận → xoá → đăng xuất + dọn `chimedis_*` trên máy. Trang web `/delete-account.html` (URL cho khai báo Google Play).
- `privacy.html` viết lại (DỰ THẢO song ngữ Việt–Anh, cần chủ app rà soát trước khi nộp store). Việc còn lại: khai báo App Privacy (Apple) / Data safety (Google).

## Vá lỗ hổng gói Node.js (2026-10-24)
- `npm audit --omit=dev`: 9 lỗ hổng (8 high do `node-forge` qua firebase-admin 12 → googleapis 120 → google-auth-library 8 → gtoken → google-p12-pem; 1 moderate `mammoth`). `node-forge` không có bản vá nên cách duy nhất là bỏ phụ thuộc: nâng `firebase-admin` 12→14.5 (cần Node ≥22, Hostinger đang dùng Node 22), `googleapis` 120→188, và `npm audit fix` (mammoth). Kết quả: 0 lỗ hổng.
- firebase-admin ≥13: default import `admin` không còn `admin.credential/admin.auth` → `backend/firebase-admin.js` đổi sang `initializeApp/cert` (`firebase-admin/app`) và `getAuth(app)` (`firebase-admin/auth`). Nếu không đổi, MỌI đăng nhập sẽ hỏng.
- Đã thử cục bộ: khởi động máy chủ, khởi tạo Firebase Admin bằng khoá giả (token sai/thiếu → 401), tạo client Sheets/TTS của googleapis 188, đọc file Word bằng mammoth. Chưa thử đăng nhập thật và TTS thật trên Hostinger — thử ngay sau khi triển khai.

## Hotfix 2026-10-27 — mất Thang phương sau khi nâng firebase-admin 14
- Nguyên nhân: `optionalFirebaseUser()` (server.js) dùng `(await import('firebase-admin')).default.auth()` — API không còn ở firebase-admin ≥13 → luôn trả null (lỗi bị `catch` nuốt) → người dùng ĐÃ đăng nhập không còn nhận nhóm Thang phương (`/api/terms`) và bị 401 `login_required` ở `/api/csdl/lesson/:id` (bài Học Thuật không phải bài trong ngày). Do PR "firebase-admin 14" gây ra.
- Sửa: `firebase-admin.js` export `verifyIdTokenValue(token)` và `optionalFirebaseUser` gọi hàm này. Bài học: sau khi nâng gói major phải tìm cả `import('...')` động, và các `catch` im lặng che lỗi.

## Nút "AI bổ sung" cho thuật ngữ thiếu nội dung (ghi chú #21 — 2026-10-27, v90)
- Chỉ ADMIN. Trong hộp ⭐ (góp ý thuật ngữ): "✨ AI bổ sung" gọi `POST /api/admin/term-ai-fill` (`lib/term-ai-fill.js`) → AI ĐỀ XUẤT tên Việt/Anh + định nghĩa Việt/Trung/Anh (hoặc một mục nội dung của dược liệu/huyệt), nối đất bằng bảng thuật ngữ bắt buộc + mục liên quan trong kho; KHÔNG ghi CSDL. Admin xem/sửa rồi bấm "Lưu vào CSDL" → `/api/admin/term-edit` (giao dịch + nhật ký trước/sau, ghi chú "AI bổ sung, admin duyệt").
- Chi phí do hệ thống chịu (sổ uid=system, feature=term_ai_fill); tối đa 60 lượt/giờ/admin. Hộp góp ý của admin luôn hiện ô định nghĩa (kể cả thuật ngữ chưa có định nghĩa).
## Tìm chính xác lên đầu + Bác sĩ khi chưa có khớp chính xác (ghi chú #19, #20 — 2026-10-27, v89)
- Phát hiện bằng bộ kiểm tra (`docs/search-benchmark-snippet.js`, 480 truy vấn = 120 từ × {Hán, Việt, Anh, pinyin}): trước khi sửa, top-1: Hán 97,5%, Việt 92,5%, Anh 92,5%, pinyin 99%. Lỗi thật: (a) bước "từ chỉ nhóm" (v71) cắt "Bệnh/huyệt…" khỏi truy vấn TRƯỚC khi xét khớp nguyên văn → "Bệnh bạch cầu" xếp thứ 14 sau "Bạch cầu"; "Hạ đường huyết ban đêm" xếp sau huyệt "Thạch Môn"; (b) pinyin bỏ dấu thanh làm "xīn jì" ngang "xīn jī".
- Sửa `matchRank`: bậc −1 = khớp nguyên văn CÓ dấu/thanh, bậc 0 = khớp nguyên văn bỏ dấu, xét TRƯỚC tách từ chỉ nhóm. Sau sửa: Hán 98,3%, Việt 100%, Anh 94,2%, pinyin 100% (các ca còn lại là bản ghi trùng tên ở nhóm khác / viết tắt cùng tên Anh).
- `searchHasExactMatch(q)`: kho chỉ có mục CHỨA từ (không khớp chính xác) → thẻ Bác sĩ hiện câu "Kho chưa có mục khớp chính xác…" và nút "Hỏi Bác sĩ Trung Y (AI)" nổi bật (chỉ chạy khi bấm — giữ quyết định không tự gọi AI).
## Thang phương mở cho mọi người (2026-10-27, v88)
- Quyết định của admin: nhóm "Thang phương" hiển thị cùng hệ thống cho MỌI người dùng, không cần đăng nhập (trước đó là domain gated). Server `/api/terms` luôn gồm `getFormulaTerms()`; giao diện bỏ các bộ lọc/màn chặn theo `state.user` cho nhóm này; không còn tải lại 6,5 MB kho khi đổi trạng thái đăng nhập.
- Dạng JSON `/api/terms` KHÔNG đổi, chỉ có thêm các mục `group1: 'Thang phương'` (ConsultApp kéo endpoint này hằng ngày — đã báo).

## Tự dịch đủ Việt/Trung/Anh khi admin lưu thuật ngữ (2026-10-27, v91)
- `POST /api/admin/term-ai-translate` (`term-ai-fill.js › translateItems`): nhận các mục {key, source, text{vi,zh,en}, targets}, trả bản dịch các ngôn ngữ đích. Không ghi CSDL; chi phí do hệ thống chịu; dùng chung trần 60 lượt/giờ/admin với "AI bổ sung".
- Giao diện: khi bấm "Lưu vào CSDL" ở trình sửa thuật ngữ (`openTermEditor`, màn Từ báo sai) và hộp ⭐ của admin (`tfAdminSave`): ngôn ngữ vừa sửa là nguồn; ngôn ngữ trống hoặc chưa đổi theo được AI dịch và điền vào ô (tô vàng), rồi hiện xem trước TRƯỚC → SAU để admin duyệt. Tên thuật ngữ chỉ Việt ⇄ Anh (chữ Hán là khoá, admin quyết định). AI lỗi → hỏi admin có lưu tiếp phần đã sửa không.

## Menu nổi + giữ nguyên tiến trình giữa 4 tab (2026-10-28, v94)
- Điện thoại/app (<768px): `.mainnav` là viên thuốc nổi (cách đáy 10px, hai bên 12px, bo tròn, nền mờ, bóng), z-index 5500 → nổi trên MỌI màn kể cả Trò chuyện/Lão Sư; ẩn khi cuộn xuống/mở bàn phím. `#talkScreen/#laoshiScreen` chừa 86px đáy để không che ô nhập. iPad/web (≥768px): giữ thanh ngang; màn phủ bắt đầu ngay dưới thanh (`--ovTop`, `ovTopSync()`).
- `navGo(k)`: rời tab chỉ tạm dừng + ẩn, không huỷ. `navMem` nhớ Từ điển (nhóm, ô tìm, vị trí cuộn) và Luyện nghe (bài đang mở); `talkHide()/laoshiHide()` ẩn màn, dừng micro/giọng, giữ hội thoại; `openTalk/openLaoshi` thấy màn đang ẩn thì chỉ hiện lại (`openLaoshi({rebuild:true})` để dựng lại khi đổi ngôn ngữ). `recInterruptAll()` (tách từ xử lý khoá máy) dùng chung khi rời tab. Bấm lại tab đang mở = về đầu tab (như cũ).
## Rà soát ngôn ngữ tự chủ động (2026-10-28, v93)
- `lib/lang-audit.js` + bảng `term_lang_queue` (duy nhất theo term_id+field_key+lang_target; trạng thái todo → pending → applied/dismissed). `findGaps()` quét kho (đã áp dụng ghi đè, gồm Thang phương): ô thiếu (`missing`), quá ngắn (`short`, EN <30% / ZH <12% bản Việt), tiếng Trung không có chữ Hán (`wrong_lang`), tên Anh trùng tên Việt (`same_as_vi`). Đo trên 6215 thuật ngữ thật: 2977 ô / 2059 thuật ngữ (Từ ghép Y Khoa nghĩa Việt 750 + Anh 509; Thang phương "phân tích" Việt+Anh 447; Huyệt vị giải phẫu Việt+Anh 331, thận trọng Việt 60; …).
- Công việc nền (server.js, mỗi 6 giờ, tắt bằng `LANG_AUDIT_JOB=off`): quét nếu >20 giờ chưa quét (không tốn AI); rồi dịch đề xuất `LANG_AUDIT_BATCH` (mặc định 40) mục khi hàng `pending` còn <200. Chi phí ghi sổ uid=system, feature=lang_audit.
- API admin: `GET /api/admin/lang-audit`, `POST …/scan`, `…/run`, `…/apply` (qua `editTerm`, có giao dịch + nhật ký), `…/dismiss`. Màn "Rà soát ngôn ngữ" ở menu admin: xem/sửa bản đề xuất, tích chọn, Duyệt/Bỏ qua. KHÔNG tự ghi vào kho.
- `OVERRIDE_FIELD_RE` mở thêm: `functions|indications|cautions|analysis_(vi|zh|en)`, `meaning(_en)` (để ghi đè được các trường Thang phương và nghĩa Từ ghép).
## Tóm tắt thuật ngữ đúng ngôn ngữ (2026-10-28, v92)
- `rowSummary` (dòng kết quả + thẻ Bác sĩ) trước đây dùng chọn 2 ngôn ngữ (Việt/Trung) cho nhóm Bệnh lý/Giải phẫu/Sinh lý và bỏ qua trường định nghĩa chính `vitri` → tiếng Anh rơi về tiếng Việt, và ~2149/6215 mục không có tóm tắt. Nay `summaryTriples()` trả các bộ (Việt, Trung, Anh) theo thứ tự ưu tiên của từng loại; ưu tiên bản đúng ngôn ngữ đang chọn, thiếu mới lùi sang ngôn ngữ khác.
- Đo trên 6215 thuật ngữ thật: mục không có tóm tắt 2149 → 4 (cả 3 ngôn ngữ). Còn lệch ngôn ngữ: tiếng Trung 1269 (hầu hết "Từ ghép Y Khoa" vốn không có nghĩa tiếng Trung), tiếng Anh 509 ("Từ ghép Y Khoa" thiếu `meaning_en`) → đưa vào hàng chờ rà soát bản dịch.

## Tra từ dùng chung trong Trò chuyện / Lão Sư (2026-10-28)
- Nút 🔍 ở đầu màn Trò chuyện và Lão Sư (`ovSearchOpen()`) mở ô tìm riêng (`#ovSearch`) nằm trên màn phủ, dùng CHUNG khung kết quả `lookupSheet` với trang chủ/Luyện nghe (lớp `.ov`, z-index 5400 dưới menu nổi 5500). Chạm kết quả mở thẻ từ; "Quay lại" hoặc rời tab đóng ô tìm và về đúng màn đang làm, giữ nguyên hội thoại.

## Hợp đồng thuật ngữ (2026-10-28, v96) — ghi chú #37, #39, #42
- `lib/term-contract.js`: mọi đường tạo/ghi thuật ngữ mới đều đi qua `fixLangs()`. Quy tắc: ô Việt không chứa tiếng Trung, ô Trung phải có chữ Hán (≥40% ký tự), ô Anh không có tiếng Việt/chữ Hán; tên Anh bị bỏ pinyin trong ngoặc ("Blood stasis (yūxuè)" → "Blood stasis"). Thứ tự xử lý: (1) xếp lại nội dung đặt nhầm ô theo ngôn ngữ nhận ra (không tốn AI); (2) chỉ phần còn thiếu mới nhờ `translateItems` MỘT lần; (3) kiểm tra lại, ô vẫn sai thì BỎ (để trống) — không ghi nội dung sai ngôn ngữ vào kho.
- Dùng ở: `learnTermDirect` (ghi đủ `position_vi/zh/en`; thiếu thì ghi chú "còn thiếu" trong `verify_note`), `promoteBatch`, tra cứu AI (`ai-lookup.js`, áp cho cả nghĩa thông thường + liên hệ Trung y), `POST /api/admin/term-add` (nhận thêm `def_zh`, `def_en`; chi phí dịch tính vào sổ admin, feature `term_add`).
- Rà soát ngôn ngữ (`lang-audit.js`) thêm 2 lý do để dọn dữ liệu đã lưu sai: `misplaced` (nội dung đúng nhưng nằm nhầm ô — đề xuất đặt vào đúng ô, không tốn AI) và `pinyin_in_en` (tên Anh kèm pinyin — đề xuất bản đã bỏ, không tốn AI); ô bị đặt nhầm còn lại được tính `wrong_lang`. Đo trên 6226 thuật ngữ thật: 2 mục misplaced (瘀血, 甲钴胺), 1 pinyin_in_en, không báo nhầm mục nào khác.
- Phía giao diện: "Thêm vào kho" từ màn Từ báo sai gửi kèm định nghĩa Việt/Trung/Anh người dùng đã đề xuất.

## Học thuật ngữ Tây y + thẻ Bác sĩ có định nghĩa chuẩn / tên Anh (2026-10-28, v97) — ghi chú #40, #41, #42, #43
- Tra cứu AI (`ai-lookup.js`) phân loại thêm `medical_term` = thuật ngữ y khoa/Tây y/lâm sàng/xét nghiệm/thủ thuật/thuốc, KỂ CẢ từ đơn/cụm ngắn có nghĩa y khoa (vd. 损伤); `general_word` chỉ còn là từ đời thường không có nghĩa y khoa. `medical_term` (độ chắc ≥ 0,6) tự học vào kho "Tổng hợp" như thuật ngữ Trung y — chưa duyệt (`verify=0`), nhãn nhóm "Mới (tự học) · Tây y". Chỉ chạy khi NGƯỜI DÙNG đăng nhập bấm tra (không tự gọi AI khi gõ).
- Ngữ nghĩa trường: `def_*` = ĐỊNH NGHĨA Y KHOA CHUẨN; `tcm_context_*` = giải thích THEO TRUNG Y (thuật ngữ Tây y: tương ứng/liên hệ Trung y); `meaning_*` = nghĩa thông thường. Kết quả cũ trong bộ nhớ đệm giữ nguyên.
- Thẻ Bác sĩ (`aiLookupCardHtml`): luôn có TÊN ANH (tên còn lại ngoài ngôn ngữ đang dùng) dưới tiêu đề; khi mở rộng có ba khối có nhãn "Định nghĩa y khoa / Theo Trung y / Nghĩa thông thường" (bỏ khối trùng nội dung). Thẻ tóm tắt từ kho (`khoSummaryHtml`) cũng có tên Anh.
- Admin: nút "Thêm vào kho" ngay trên thẻ Bác sĩ khi AI đã tra nhưng chưa vào kho (từ đơn/cụm AI không tự học) → `POST /api/admin/term-add` (qua hợp đồng thuật ngữ, ghi đủ Việt/Trung/Anh) và gắn `ai_lookup.term_id` để thẻ trỏ về mục mới.

## Gợi ý liên quan của thẻ Bác sĩ + Thang phương trong chỉ mục (2026-10-28, v98) — ghi chú #36
- Backend: `csdl-lessons.js › REF_ONLY` — Thang phương được nạp vào chỉ mục để TRA CỨU/GỢI Ý (Bác sĩ, Lão Sư, bảng thuật ngữ dịch) nhưng KHÔNG thành bài học (danh sách/thống kê Học Thuật không đổi); `factsFor` có dạng riêng (thành phần · công năng · chủ trị). `relatedFromKho` có thêm nhóm `phuong`; `crossGroupRefs` thêm Thang phương; `ensureLessonIndex` nạp `getFormulaTerms()`.
- Giao diện (`relSuggest/relRowsHtml`, tính trên máy từ `TERMS`, không AI, không mạng, có cache theo mục): Bệnh/chứng → Bài thuốc / Vị thuốc / Huyệt CHỦ TRỊ (tra ngược phần Chủ trị; mục khớp sớm xếp trước); Vị thuốc → Bài thuốc có vị này (vị Quân/Thần trước) + Bệnh/chứng; Huyệt → Bệnh/chứng chủ trị; Thang phương → Vị thuốc trong bài + chủ trị; mọi mục → Từ ghép (chứa từ này, ngắn trước) và Thành phần (nếu là từ ghép). Thẻ thu gọn thấy 2 dòng gợi ý đầu; "Xem đầy đủ" thấy hết + "Kết quả khác trong kho". Giới hạn đã biết: khớp theo chữ Hán nguyên văn nên không bắt được từ đồng nghĩa (vd. 胃痛 ↔ 胃脘痛) — hướng cải tiến: bảng đồng nghĩa.

## Tìm kiếm: bản đã tra AI, từ đơn, lọc theo dropdown (SW v99, 2026-10-30)
- **Bản đã tra AI không hiện lại** (ví dụ "manipulation"): trước đây chỉ nạp bản đã lưu (máy + máy chủ) khi kho KHÔNG khớp gì (`!searchHasFullMatch`). Kho khớp mờ (từ nằm trong nội dung 8 mục khác) → bỏ qua mãi. Nay nạp bản đã lưu bất cứ khi nào KHÔNG có khớp chính xác (`searchHasExactMatch`), miễn phí, không gọi AI. Máy chủ vốn đã lưu mọi lần tra vào `ai_lookup`.
- **Từ đơn**: `matchRank` thêm bậc −0,5 (đúng nguyên từ, có dấu: "đau" → "đau đầu") và 0,8 (đúng nguyên từ, khác dấu); khớp bỏ dấu ("đầu" ≠ "đau") và khớp tiền tố ("ho" → "hoá") xếp sau. Cùng bậc: tên ngắn hơn trước. Danh sách có mốc "Khớp chính xác ▸ Liên quan khác". Ngưỡng độ dài tra AI hạ từ 4/3 xuống 2 ký tự (front + `isTermQuery`).
- **Dropdown là bộ lọc thật**: bỏ tự mở rộng ra mọi nhóm khi nhóm đang chọn không có kết quả. Thay bằng thanh chip "Toàn bộ N · Nhóm (n)…" (≥44px) từ `searchFacets()`; nhóm hiện tại 0 kết quả → báo rõ và chỉ các nhóm khác có.

## Chuẩn hồ sơ thuật ngữ khi thêm / sửa (SW v100, 2026-10-30)
Một thuật ngữ trong kho phải đủ: chữ Hán (pinyin tự sinh), tên Việt + Anh, định nghĩa Việt + Trung + Anh, nhóm. Luồng thống nhất mọi nguồn (Từ báo sai "miss-", thẻ Bác sĩ, admin):
1. **Đề nghị/tra cứu** → mở `openTermAdder()` (trình soạn thêm mới) — KHÔNG ghi thẳng như trước.
2. Chưa có định nghĩa nào → AI soạn nháp ngay (`/api/admin/term-ai-fill`); admin sửa tay hoặc bấm **✨ AI bổ sung** (nút này nay cũng có ở trình sửa `openTermEditor`).
3. Chỉ báo "Còn thiếu: …" theo thời gian thực; thiếu mà bấm Lưu → hỏi AI bổ sung hay lưu luôn.
4. Admin chốt → `/api/admin/term-add` (hợp đồng ngôn ngữ `fixLangs`, pinyin tự sinh, verify=0 chờ duyệt). Máy chủ cũng tự nhờ AI soạn định nghĩa nếu client gửi thiếu hoàn toàn (`ai:false` để tắt). AI không bao giờ tự ghi kho.
Chưa làm (đề xuất): hàng chờ "Hồ sơ chưa đầy đủ" riêng; trường theo loại (bệnh → cách trị, thuốc → công năng) cho thuật ngữ mới.

## Tìm chính xác khi bấm kính lúp / Enter (SW v101, 2026-10-30)
- Sửa hồi quy của v99: bậc −0,5 ("chứa đúng từ", vd. "Fat embolism syndrome" cho "fat") bị tính là "khớp chính xác" → thẻ Bác sĩ ẩn nút hỏi AI. Nay `searchHasExactMatch` và mốc "Khớp chính xác" chỉ tính TRÙNG TÊN (bậc −1/0); mốc mới "Chứa đúng từ này" cho −0,5/0,8.
- Kính lúp/Enter (`doSearch`) bật chế độ chính xác (`state.searchStrict`): có mục trùng tên → chỉ giữ chúng; không có → giữ mục chứa đúng từ; không có nữa → giữ nguyên. Nút "Hiện thêm N kết quả liên quan" bỏ chế độ. Đang gõ vẫn tìm rộng. Chip nhóm đếm theo đúng tập đang hiện.

## IPA tên tiếng Anh — chỉ hiển thị, không đọc (SW v102, 2026-10-30)
- Bảng riêng `term_ipa` (term_id, en, ipa); `lib/term-ipa.js`. KHÔNG ghi vào bảng nội dung kho. IPA chỉ hiện khi chuỗi Anh còn khớp lúc tạo (admin đổi tên Anh → IPA cũ ẩn tới khi tạo lại). Từ ghép Y Khoa giữ `ipa` soạn tay.
- Tạo: admin bấm **Tạo IPA** ở màn Rà soát ngôn ngữ (`POST /api/admin/term-ipa/run`, ≤3 lượt×180 từ); từ mới thêm qua `term-add` tự tạo; tác vụ nền lang-audit (cùng cổng `LANG_AUDIT_JOB`) mỗi 6 giờ tạo thêm ≤180 từ. `GET /api/admin/term-ipa` trả số còn thiếu. `/api/terms` gắn trường `ipa`.
- Hiển thị: nhỏ, sau tên Anh ở dòng kết quả, thẻ ôn và dưới tên Anh trong popup (`ipaTag()`); `aria-hidden`, `translate="no"`; không gắn nút loa, TTS chỉ đọc `term.en`.
- Lưu ý chất lượng: IPA do AI sinh (General American), chưa có bước duyệt riêng — là phụ trợ phát âm; sai thì xoá dòng trong `term_ipa` hoặc đổi tên Anh để tạo lại.

## Tối ưu gõ tìm kiếm & chờ Bác sĩ (SW v103, 2026-10-30)
- **Giật khi gõ**: đo trên 6.226 mục — mỗi phím tốn 100–270 ms (chuẩn hoá lại ~2 MB chữ cho cả kho, mỗi nơi tự quét lại, `searchHasExactMatch` chạy bộ xếp hạng trên TOÀN kho). Sửa: bộ nhớ đệm chuỗi chuẩn hoá theo từng mục (`termHays`, khoá theo nội dung nên admin sửa thì tự tính lại), tập khớp tính một lần mỗi truy vấn (`matchedSet`), kiểm tra trùng tên chỉ so tên (`hasExactName`), gộp phím gõ liền nhau — chỉ vẽ lại sau ~170 ms (`_searchRenderT`), làm ấm bộ đệm lúc rảnh (`warmSearch`). Kết quả không đổi (đối chiếu 10 truy vấn).
- **Bác sĩ chậm**: bấm nút KHÔNG tra lại kho (kho đã tra khi hiện nút; máy chủ chỉ kiểm bản đã lưu + hạn mức). Thời gian nằm ở AI sinh bản trả lời đủ 3 ngôn ngữ. Đã: chạy song song 3 truy vấn kiểm tra đầu vào; đo từng chặng vào log `[ai-lookup] ms {db, model, contract, learn_save, total}`; biến `AI_LOOKUP_EFFORT` (mặc định `low`; thử `minimal` để nhanh hơn, không cần sửa mã); trong lúc chờ hiện ngay vài mục gần nhất trong kho.
