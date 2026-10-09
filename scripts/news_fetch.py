"""Tự động lấy tin tức Trung Y mới (tiếng Trung) → diễn giải → sinh audio → commit thẳng
vào backend/ — không qua bước thủ công nào.

2 nguồn:
1. Google News RSS theo từ khoá (news.google.com/rss/search?hl=zh-CN) — tính năng KHÔNG
   chính thức của Google (không có doc, có thể đổi/hỏng bất cứ lúc nào), nhưng đã khảo
   sát: không có RSS chính thức nào từ 国家中医药管理局/中国中医药报. Chỉ lấy TIÊU ĐỀ +
   TÓM TẮT NGẮN (snippet Google tự tạo), không crawl toàn văn trang nguồn.
2. Podcast "中醫藥雙語新聞" (Tammy圓兒, nội dung trích từ báo in 《中國醫藥導報》, 30
   năm tuổi, RSS công khai qua SoundOn — cơ chế CHÍNH THỐNG, khác hẳn Spotify không có
   RSS công khai và ToS cấm crawl — xem khảo sát 2026-10-09). Feed đã ngừng cập nhật từ
   03/2024 (66 tập) — không phải nguồn "sống", chỉ dùng để bổ sung 1 lần kho có sẵn, lấy
   tiêu đề+mô tả tập (không phải nguyên văn báo in).

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
PODCAST_RSS_URL = "https://feeds.soundon.fm/podcasts/05e9e8e6-f723-4b85-ae6e-7eceee1006d9.xml"
PODCAST_SOURCE_LABEL = "Podcast 中醫藥雙語新聞 (Tammy圓兒, trích từ 中國醫藥導報)"


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
            items.append({"title": title, "link": link, "desc": desc, "source": source_name, "pub_date": pub_date, "item_id": link})
    return items


def fetch_podcast():
    r = requests.get(PODCAST_RSS_URL, timeout=30)
    r.raise_for_status()
    root = ET.fromstring(r.content)
    items = []
    for item in root.findall(".//item"):
        title = (item.findtext("title") or "").strip()
        desc = re.sub(r"\s+", " ", (item.findtext("description") or "").strip())
        guid = (item.findtext("guid") or "").strip()
        link = (item.findtext("link") or "").strip()
        pub_date = (item.findtext("pubDate") or "").strip()
        # Chỉ lấy tập tiếng Trung (feed có cả bản tiếng Trung lẫn tiếng Anh cho cùng nội
        # dung, bản Trung đủ làm nguồn vì GPT tự dịch vi/en) — nhận diện qua ký tự CJK.
        if title and guid and re.search(r"[一-鿿]", title):
            items.append({"title": title, "link": link or title, "desc": desc, "source": PODCAST_SOURCE_LABEL, "pub_date": pub_date, "item_id": f"podcast-{guid}"})
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

    return hashlib.sha1(item.get("item_id", item["link"]).encode("utf-8")).hexdigest()[:12]


def build_passage_json(item, generated):
    passage_id = f"bc-auto-{item_hash(item)}"
    cite = f"{item['source']}, {item['pub_date']}".strip(", ")
    link = item["link"]
    is_podcast = item.get("item_id", "").startswith("podcast-")
    src_label_vi = "mô tả tập podcast thật" if is_podcast else "tin thật trên Google News"
    src_label_zh = "播客节目真实简介" if is_podcast else "Google News 上真实新闻的标题与摘要"
    src_label_en = "a real podcast episode description" if is_podcast else "the real headline + snippet on Google News"
    source_note_vi = f"Diễn giải tự động (AI) từ tiêu đề + {src_label_vi} ({cite}). Bản gốc: {link}. Không trích nguyên văn, chưa qua rà soát thủ công."
    source_note_zh = f"由 AI 根据{src_label_zh}自动改写（{cite}）。原文链接：{link}。未摘录原文全文，尚未经人工校对。"
    source_note_en = f"AI-generated narrative from the real headline + {src_label_en} ({cite}). Original: {link}. Not a verbatim excerpt; not yet human-reviewed."

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
    try:
        items += fetch_podcast()
    except Exception as exc:
        print(f"[news] cảnh báo: không lấy được podcast RSS ({exc}), chỉ dùng Google News.", file=sys.stderr)
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
