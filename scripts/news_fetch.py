"""Tự động lấy tin tức Trung Y mới (tiếng Trung) → diễn giải → sinh audio → commit thẳng
vào backend/ — không qua bước thủ công nào.

Nguồn: Google News RSS theo từ khoá (news.google.com/rss/search?hl=zh-CN) — tính năng
KHÔNG chính thức của Google (không có doc, có thể đổi/hỏng bất cứ lúc nào), nhưng đã
khảo sát: không có RSS chính thức nào từ 国家中医药管理局/中国中医药报 (xem lịch sử
nghiên cứu 2026-10-08/09). Chỉ dùng RSS để lấy TIÊU ĐỀ + TÓM TẮT NGẮN (phần snippet
Google tự tạo để hiển thị kết quả tìm kiếm, không phải nguyên văn bài báo) — không crawl
toàn văn trang nguồn, tránh rủi ro ToS khi tái sử dụng nội dung.

GPT CHỈ được dùng dữ kiện có trong tiêu đề+tóm tắt để viết lại, không được bịa thêm số
liệu/tên người/ngày tháng không có trong văn bản gốc (cùng quy tắc với yaan_fetch.py).

Dùng:
    python scripts/news_fetch.py --max 1
"""
import argparse
import html
import json
import re
import shutil
import sys
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import audio_build  # noqa: E402
import openai_helper  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
CONTENT_DIR = ROOT / "backend" / "data" / "listening" / "bao_chi"
AUDIO_DIR = ROOT / "backend" / "public" / "audio" / "listening" / "bao_chi"
SEEN_FILE = CONTENT_DIR / ".processed_news.json"
MAX_KEPT_AUTO = 20  # chỉ đếm bài "auto": true — bài Claude soạn tay (vd. bc-01) không bị xoá

RSS_URL = "https://news.google.com/rss/search"
# Loại trừ "中药材"/"林业"/"草原" để tránh lẫn tin nông-lâm nghiệp trồng dược liệu (đã
# gặp thật khi test 2026-10-09) — ưu tiên tin lâm sàng/học thuật/văn hoá Trung y thật.
DEFAULT_QUERY = "(中医药 OR 针灸学 OR 中西医结合) -中药材 -林业 -草原"


def fetch_rss(query):
    params = {"q": query, "hl": "zh-CN", "gl": "CN", "ceid": "CN:zh-Hans"}
    r = requests.get(RSS_URL, params=params, timeout=30, headers={"User-Agent": "Mozilla/5.0"})
    r.raise_for_status()
    root = ET.fromstring(r.content)
    items = []
    for item in root.findall(".//item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        desc_raw = item.findtext("description") or ""
        desc = html.unescape(re.sub(r"<[^>]+>", " ", desc_raw)).strip()
        desc = re.sub(r"\s+", " ", desc)
        source = item.find("source")
        source_name = (source.text or "").strip() if source is not None else ""
        pub_date = (item.findtext("pubDate") or "").strip()
        if title and link:
            items.append({"title": title, "link": link, "desc": desc, "source": source_name, "pub_date": pub_date})
    return items


def load_seen():
    if SEEN_FILE.exists():
        return json.loads(SEEN_FILE.read_text(encoding="utf-8"))
    return []


def save_seen(seen_ordered):
    CONTENT_DIR.mkdir(parents=True, exist_ok=True)
    SEEN_FILE.write_text(json.dumps(seen_ordered, ensure_ascii=False, indent=2), encoding="utf-8")


def list_auto_passage_ids():
    if not CONTENT_DIR.exists():
        return []
    ids = []
    for f in CONTENT_DIR.glob("bc-auto-*.json"):
        data = json.loads(f.read_text(encoding="utf-8"))
        if data.get("auto"):
            ids.append(data["id"])
    return ids


def prune_oldest(seen_ordered):
    auto_ids = set(list_auto_passage_ids())
    while len(auto_ids) > MAX_KEPT_AUTO and seen_ordered:
        oldest_hash = seen_ordered.pop(0)
        passage_id = f"bc-auto-{oldest_hash}"
        json_path = CONTENT_DIR / f"{passage_id}.json"
        if json_path.exists():
            json_path.unlink()
        audio_path = AUDIO_DIR / passage_id
        if audio_path.exists():
            shutil.rmtree(audio_path)
        auto_ids.discard(passage_id)
        print(f"[news] đã xoá bài cũ {passage_id} (vượt ngưỡng {MAX_KEPT_AUTO} bài tự động)", file=sys.stderr)
    return seen_ordered


def pinyin_of(zh_text):
    try:
        from pypinyin import pinyin, Style

        return " ".join(s[0] for s in pinyin(zh_text, style=Style.TONE)) if zh_text else ""
    except Exception:
        return ""


def item_hash(item):
    import hashlib

    return hashlib.sha1(item["link"].encode("utf-8")).hexdigest()[:12]


def build_passage_json(item, generated):
    passage_id = f"bc-auto-{item_hash(item)}"
    cite = f"{item['source']}, {item['pub_date']}".strip(", ")
    link = item["link"]
    source_note_vi = f"Diễn giải tự động (AI) từ tiêu đề + tóm tắt tin thật trên Google News ({cite}). Bản gốc: {link}. Không trích nguyên văn bài báo, chưa qua rà soát thủ công."
    source_note_zh = f"由 AI 根据 Google News 上真实新闻的标题与摘要自动改写（{cite}）。原文链接：{link}。未摘录原文全文，尚未经人工校对。"
    source_note_en = f"AI-generated narrative from the real headline + snippet on Google News ({cite}). Original: {link}. Not a verbatim excerpt; not yet human-reviewed."

    segments = []
    for i, seg in enumerate(generated["segments"], start=1):
        segments.append(
            {
                "seq": i,
                "text_zh": seg["text_zh"],
                "text_vi": seg["text_vi"],
                "text_en": seg["text_en"],
                "text_pinyin": pinyin_of(seg["text_zh"]),
            }
        )

    return {
        "id": passage_id,
        "category": "bao_chi",
        "level": generated["level"],
        "auto": True,
        "mt_translated": True,
        "title_vi": generated["title_vi"],
        "title_zh": generated["title_zh"],
        "title_en": generated["title_en"],
        "segments": segments,
        "source_note_vi": source_note_vi,
        "source_note_zh": source_note_zh,
        "source_note_en": source_note_en,
    }


def main():
    parser = argparse.ArgumentParser(description="Lấy tin tức Trung Y mới + diễn giải + sinh audio")
    parser.add_argument("--max", type=int, default=1)
    parser.add_argument("--query", default=DEFAULT_QUERY)
    args = parser.parse_args()

    items = fetch_rss(args.query)
    seen_ordered = load_seen()
    seen_set = set(seen_ordered)
    candidates = [it for it in items if item_hash(it) not in seen_set][: args.max]
    if not candidates:
        print("Không có tin tức mới.", file=sys.stderr)
        return

    CONTENT_DIR.mkdir(parents=True, exist_ok=True)
    for item in candidates:
        facts = f"标题：{item['title']}\n摘要：{item['desc']}" if item["desc"] else f"标题：{item['title']}"
        print(f"[news] đang diễn giải: {item['title'][:60]}...", file=sys.stderr)
        generated = openai_helper.generate_passage(facts, citation_hint=f"{item['source']} ({item['pub_date']})")
        passage = build_passage_json(item, generated)
        out_path = CONTENT_DIR / f"{passage['id']}.json"
        out_path.write_text(json.dumps(passage, ensure_ascii=False, indent=2), encoding="utf-8")
        seen_ordered.append(item_hash(item))
        print(f"[news] sinh audio tiếng Trung cho {passage['id']}...", file=sys.stderr)
        audio_build.build_passage(out_path, lang="text_zh", voice_key="narrator")

    seen_ordered = prune_oldest(seen_ordered)
    save_seen(seen_ordered)


if __name__ == "__main__":
    main()
