"""Gọi OpenAI API để diễn giải dữ kiện y án / tin tức thành đoạn văn luyện nghe-dịch
(tiếng Trung tự nhiên + bản dịch vi/en), dùng cho các pipeline tự động không cần chat
(y_an tự động, bao_chi tự động). Dùng model rẻ nhất (gpt-5-mini, quyết định 2026-10-09
vì chi phí thấp hơn Claude Haiku ~2.7 lần ở cùng khối lượng việc này).

QUAN TRỌNG: input luôn là DỮ KIỆN đã tóm tắt (sự kiện y khoa: triệu chứng, huyệt vị,
phương thuốc, kết quả), KHÔNG phải nguyên văn trích từ sách có bản quyền — mô hình chỉ
viết LẠI thành văn tường thuật tự nhiên, không được bịa thêm dữ kiện.
"""
import json
import os
import time

import requests

OPENAI_URL = "https://api.openai.com/v1/chat/completions"
MODEL = "gpt-5-mini"

PASSAGE_SCHEMA = {
    "type": "object",
    "properties": {
        "title_vi": {"type": "string"},
        "title_zh": {"type": "string"},
        "title_en": {"type": "string"},
        "level": {"type": "string", "enum": ["so_cap", "trung_cap", "cao_cap"]},
        "segments": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "text_zh": {"type": "string"},
                    "text_vi": {"type": "string"},
                    "text_en": {"type": "string"},
                },
                "required": ["text_zh", "text_vi", "text_en"],
                "additionalProperties": False,
            },
            "minItems": 5,
            "maxItems": 14,
        },
    },
    "required": ["title_vi", "title_zh", "title_en", "level", "segments"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = """Bạn là biên tập viên tài liệu luyện nghe-dịch tiếng Trung Y khoa cho \
nghiên cứu sinh Châm cứu đang luyện tập dịch cabin.

Nhiệm vụ: từ DỮ KIỆN y án/tin tức tiếng Trung (đã tóm tắt sự kiện, không phải nguyên văn \
sách/báo có bản quyền), viết lại thành một đoạn văn tường thuật TỰ NHIÊN bằng tiếng Trung \
(5-12 câu ngắn gọn, mỗi câu 1-2 mệnh đề, dễ nghe thành tiếng/đọc thành tiếng), kèm bản \
dịch tiếng Việt và tiếng Anh sát nghĩa cho TỪNG câu.

Quy tắc bắt buộc:
1. GIỮ NGUYÊN mọi dữ kiện y khoa (triệu chứng, huyệt vị, phương thuốc, liều lượng, kết \
quả điều trị) — KHÔNG bịa thêm, KHÔNG suy diễn chi tiết không có trong dữ kiện gốc.
2. Văn phong tường thuật tự nhiên như kể chuyện ca bệnh, không liệt kê khô khan.
3. Phân loại level theo độ khó ngôn ngữ (không phải độ khó y khoa):
   - so_cap: câu ngắn, từ vựng phổ thông, ít thuật ngữ chuyên ngành.
   - trung_cap: có thuật ngữ y khoa cơ bản (tên bệnh, tên huyệt thường gặp), câu phức \
vừa phải.
   - cao_cap: thuật ngữ Trung y chuyên sâu, cấu trúc câu cổ văn hoặc phức tạp, nhiều \
danh từ y lý.
4. title_vi/text_vi và title_en/text_en phải dịch TOÀN BỘ sang tiếng Việt/tiếng Anh —
   KHÔNG được để sót chữ Hán nào trong 2 trường này (kể cả tên bệnh/tên huyệt: dùng
   phiên âm Hán-Việt hoặc tên y học tương ứng, ví dụ 梅核气 → "mai hạch khí"/"globus
   hystericus", không giữ nguyên chữ Hán).
5. Trả về đúng JSON schema đã cho, không thêm trường nào khác."""


def require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Thiếu biến môi trường bắt buộc: {name}")
    return value


def generate_passage(facts_zh, citation_hint=""):
    """Gọi OpenAI, trả về dict {title_vi, title_zh, title_en, level, segments}."""
    api_key = require_env("OPENAI_API_KEY")
    user_content = f"Dữ kiện (tiếng Trung):\n{facts_zh}"
    if citation_hint:
        user_content += f"\n\n(Nguồn tham khảo, chỉ để bạn hiểu ngữ cảnh, không cần nhắc trong bài: {citation_hint})"

    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "listening_passage", "schema": PASSAGE_SCHEMA, "strict": True},
        },
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    for attempt in range(4):
        r = requests.post(OPENAI_URL, headers=headers, json=payload, timeout=90)
        if r.status_code < 400:
            data = r.json()
            content = data["choices"][0]["message"]["content"]
            return json.loads(content)
        if r.status_code not in (429, 500, 502, 503, 504) or attempt == 3:
            raise RuntimeError(f"OpenAI lỗi {r.status_code}: {r.text[:500]}")
        time.sleep(2**attempt)
