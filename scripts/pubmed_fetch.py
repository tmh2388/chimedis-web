"""Tự động lấy bài tóm tắt PubMed mới (châm cứu/Trung y) → dịch → sinh audio → commit
thẳng vào backend/data/listening + backend/public/audio/listening (không qua bước copy
tay nào — chạy qua GitHub Actions hàng ngày là có bài mới ngay trên dict.chimedis.vn).

Nhánh nội dung "hoc_thuat" — hướng luyện dịch NGƯỢC (nghe tiếng Anh, nói lại bằng tiếng
Trung), vì PubMed là nguồn DUY NHẤT có API thật đáng tin cậy đã khảo sát (wfas.org.cn và
中国中医药报 đều không có RSS thật, Google News RSS không chính thức + có rủi ro ToS nên
không dùng để tự xuất bản). Dùng NCBI E-utilities (esearch+efetch, miễn phí, không cần
key — xem https://www.ncbi.nlm.nih.gov/books/NBK25501/).

Dịch EN→ZH/VI bằng MyMemory (cùng dịch vụ + cách gọi đã dùng thật trong production ở
backend/translate.js cho herbs/anatomy/acupoint) — MIỄN PHÍ, chấp nhận chất lượng "máy
dịch thô, cần rà soát" (mt_translated: true trong file JSON).

Chính sách giữ bài (quyết định 2026-10-09, để tránh phình kho lưu trữ git vô hạn — audio
buộc phải nằm trong git vì Hostinger xoá file ngoài git mỗi lần redeploy): tối đa
MAX_KEPT bài "hoc_thuat" cùng lúc, bài cũ nhất (theo PMID thêm trước) bị xoá (JSON + thư
mục audio) ngay khi vượt ngưỡng, trong cùng lần Action chạy.

Dùng:
    python scripts/pubmed_fetch.py --max 1
"""
import argparse
import json
import re
import shutil
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import audio_build  # noqa: E402  (sinh audio ngay sau khi tạo JSON, cùng 1 tiến trình)

ROOT = Path(__file__).resolve().parents[1]
CONTENT_DIR = ROOT / "backend" / "data" / "listening" / "hoc_thuat"
AUDIO_DIR = ROOT / "backend" / "public" / "audio" / "listening" / "hoc_thuat"
SEEN_FILE = CONTENT_DIR / ".processed_pmids.json"
MAX_KEPT = 30  # giữ tối đa 30 bài — ~1-2 tháng ở nhịp 1 bài/ngày (quyết định 2026-10-09)

ESEARCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
EFETCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"
DEFAULT_QUERY = (
    '("acupuncture"[Title/Abstract] OR "traditional chinese medicine"[Title/Abstract] '
    'OR "moxibustion"[Title/Abstract]) AND hasabstract[text]'
)

MAX_CHARS = 480  # giới hạn thực tế của MyMemory mỗi request


def load_seen():
    if SEEN_FILE.exists():
        return json.loads(SEEN_FILE.read_text(encoding="utf-8"))
    return []  # list, giữ thứ tự thêm vào (cũ nhất ở đầu) để biết bài nào xoá trước


def save_seen(seen_ordered):
    CONTENT_DIR.mkdir(parents=True, exist_ok=True)
    SEEN_FILE.write_text(json.dumps(seen_ordered, ensure_ascii=False, indent=2), encoding="utf-8")


def prune_oldest(seen_ordered):
    """Xoá bài cũ nhất khi vượt MAX_KEPT — gỡ cả JSON và thư mục audio tương ứng."""
    while len(seen_ordered) > MAX_KEPT:
        oldest_pmid = seen_ordered.pop(0)
        passage_id = f"ha-{oldest_pmid}"
        json_path = CONTENT_DIR / f"{passage_id}.json"
        if json_path.exists():
            json_path.unlink()
        audio_path = AUDIO_DIR / passage_id
        if audio_path.exists():
            shutil.rmtree(audio_path)
        print(f"[pubmed] đã xoá bài cũ {passage_id} (vượt ngưỡng {MAX_KEPT} bài)", file=sys.stderr)
    return seen_ordered


def esearch(query, retmax):
    params = {"db": "pubmed", "term": query, "retmax": retmax, "sort": "most+recent", "retmode": "json"}
    r = requests.get(ESEARCH_URL, params=params, timeout=30)
    r.raise_for_status()
    return r.json()["esearchresult"]["idlist"]


def efetch(pmids):
    if not pmids:
        return []
    params = {"db": "pubmed", "id": ",".join(pmids), "rettype": "abstract", "retmode": "xml"}
    r = requests.get(EFETCH_URL, params=params, timeout=60)
    r.raise_for_status()
    root = ET.fromstring(r.content)
    out = []
    for article in root.findall(".//PubmedArticle"):
        pmid = article.findtext(".//PMID")
        title = article.findtext(".//ArticleTitle") or ""
        abstract_parts = [t.text or "" for t in article.findall(".//AbstractText")]
        abstract = " ".join(p.strip() for p in abstract_parts if p and p.strip())
        journal = article.findtext(".//Journal/Title") or ""
        year = article.findtext(".//JournalIssue/PubDate/Year") or article.findtext(".//JournalIssue/PubDate/MedlineDate") or ""
        if pmid and abstract:
            out.append({"pmid": pmid, "title": title.strip(), "abstract": abstract, "journal": journal.strip(), "year": year.strip()})
    return out


def split_sentences(text):
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9])", text.strip())
    return [p.strip() for p in parts if p.strip()]


def split_long(text):
    if len(text) <= MAX_CHARS:
        return [text]
    parts = re.split(r"(?<=[.!?])\s+", text)
    chunks, cur = [], ""
    for p in parts:
        if len(cur + p) > MAX_CHARS and cur:
            chunks.append(cur)
            cur = ""
        cur += (" " if cur else "") + p
    if cur:
        chunks.append(cur)
    return chunks or [text[:MAX_CHARS]]


def is_bad_translation(original, translated, target):
    """Nguồn là tiếng Anh, nên cách phát hiện "dịch echo/lỗi" phải khác bản gốc (nguồn
    tiếng Trung ở backend/translate.js): dịch đúng sang zh phải CÓ chữ Hán."""
    if not translated:
        return True
    o, t = original.strip(), translated.strip()
    if t == o:
        return True
    if target == "zh":
        return not re.search(r"[一-鿿]", t)
    return False


def mymemory_translate(text, target, email, cache):
    key = f"{target}:{text}"
    if key in cache:
        return cache[key]
    segments = split_long(text)
    translated = []
    for seg in segments:
        params = {"q": seg, "langpair": f"en|{target}"}
        if email:
            params["de"] = email
        result = seg
        for attempt in range(3):
            try:
                r = requests.get("https://api.mymemory.translated.net/get", params=params, timeout=15)
                data = r.json()
                tt = (data.get("responseData") or {}).get("translatedText")
                status = data.get("responseStatus")
                if status and int(status) != 200:
                    raise RuntimeError(f"MyMemory responseStatus={status}")
                if tt and re.search(r"MYMEMORY WARNING|QUOTA|LIMIT", tt, re.I):
                    raise RuntimeError("MyMemory hết quota dịch miễn phí hôm nay")
                if tt and is_bad_translation(seg, tt, target):
                    raise RuntimeError("MyMemory trả nguyên văn gốc (nghi bị rate-limit)")
                if tt:
                    result = tt
                break
            except Exception as exc:
                if attempt == 2:
                    print(f"   cảnh báo dịch (giữ nguyên gốc): {exc}", file=sys.stderr)
                else:
                    time.sleep(0.6 * (attempt + 1))
        translated.append(result)
        time.sleep(0.15)
    joined = " ".join(translated)
    cache[key] = joined
    return joined


def pinyin_of(zh_text):
    try:
        from pypinyin import pinyin, Style

        return " ".join(s[0] for s in pinyin(zh_text, style=Style.TONE)) if zh_text else ""
    except Exception:
        return ""


def build_passage_json(article, email):
    pmid = article["pmid"]
    cache = {}
    title_en = article["title"]
    title_zh = mymemory_translate(title_en, "zh", email, cache)
    title_vi = mymemory_translate(title_en, "vi", email, cache)

    sentences = split_sentences(article["abstract"])
    segments = []
    for i, sent in enumerate(sentences, start=1):
        text_zh = mymemory_translate(sent, "zh", email, cache)
        text_vi = mymemory_translate(sent, "vi", email, cache)
        segments.append(
            {
                "seq": i,
                "text_en": sent,
                "text_zh": text_zh,
                "text_vi": text_vi,
                "text_pinyin": pinyin_of(text_zh),
            }
        )

    link = f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/"
    cite = f"{article['journal']} ({article['year']})" if article["journal"] else article["year"]
    source_note_en = f"Abstract from PubMed (PMID {pmid}), {cite}. Original: {link}. Vi/Zh translation is machine-translated (MyMemory) and not yet human-reviewed."
    source_note_vi = f"Tóm tắt từ PubMed (PMID {pmid}), {cite}. Bản gốc: {link}. Bản dịch tiếng Việt/Trung do máy dịch (MyMemory), chưa được người rà soát lại."
    source_note_zh = f"摘要来自 PubMed（PMID {pmid}），{cite}。原文：{link}。中文/越南语翻译为机器翻译（MyMemory），尚未经人工校对。"

    return {
        "id": f"ha-{pmid}",
        "category": "hoc_thuat",
        "level": "cao_cap",
        "source_lang": "en",
        "mt_translated": True,
        "title_en": title_en,
        "title_zh": title_zh,
        "title_vi": title_vi,
        "segments": segments,
        "source_note_en": source_note_en,
        "source_note_vi": source_note_vi,
        "source_note_zh": source_note_zh,
    }


def main():
    parser = argparse.ArgumentParser(description="Lấy bài PubMed mới + dịch + sinh audio")
    parser.add_argument("--max", type=int, default=1, help="Số bài mới tối đa mỗi lần chạy")
    parser.add_argument("--query", default=DEFAULT_QUERY)
    parser.add_argument("--email", default="", help="TRANSLATE_CONTACT_EMAIL (nâng quota MyMemory, tuỳ chọn)")
    args = parser.parse_args()

    import os

    email = args.email or os.environ.get("TRANSLATE_CONTACT_EMAIL", "")

    seen_ordered = load_seen()
    seen_set = set(seen_ordered)
    candidate_ids = esearch(args.query, retmax=args.max + len(seen_set) + 10)
    new_ids = [p for p in candidate_ids if p not in seen_set][: args.max]
    if not new_ids:
        print("Không có bài PubMed mới.", file=sys.stderr)
        return

    articles = efetch(new_ids)
    CONTENT_DIR.mkdir(parents=True, exist_ok=True)
    for article in articles:
        print(f"[pubmed] PMID {article['pmid']}: {article['title'][:70]}...", file=sys.stderr)
        passage = build_passage_json(article, email)
        out_path = CONTENT_DIR / f"{passage['id']}.json"
        out_path.write_text(json.dumps(passage, ensure_ascii=False, indent=2), encoding="utf-8")
        seen_ordered.append(article["pmid"])
        print(f"[pubmed] sinh audio tiếng Anh cho {passage['id']}...", file=sys.stderr)
        audio_build.build_passage(out_path, lang="text_en", voice_key="narrator")

    seen_ordered = prune_oldest(seen_ordered)
    save_seen(seen_ordered)


if __name__ == "__main__":
    main()
