"""Tự động mở rộng kho Y Án đa mô thức (dược + châm) — lấy dữ kiện từ
backend/data/yaan_source_bank.json (đã trích từ tư liệu Drive thật của user, viết lại
thành SỰ KIỆN không phải nguyên văn sách), gọi OpenAI (gpt-5-mini) diễn giải thành bài
luyện nghe-dịch, sinh audio tiếng Trung (Google TTS), commit thẳng vào backend/ — không
qua bước thủ công nào.

KHÔNG tự xoá bài — khác với hoc_thuat (PubMed)/bao_chi (tin tức), kho Y Án là tài liệu
tham khảo lâu dài cho sinh viên (quyết định 2026-10-09, user: "kho sử dụng lâu dài").
Nhịp 1 bài/ngày nên tốc độ tăng dung lượng chậm (audio ~1MB/bài, ~30MB/tháng) — chấp
nhận đánh đổi này vì giá trị tham khảo lâu dài quan trọng hơn dung lượng git.

Dùng:
    python scripts/yaan_fetch.py --max 1
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import audio_build  # noqa: E402
import openai_helper  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
BANK_FILE = ROOT / "backend" / "data" / "yaan_source_bank.json"
CONTENT_DIR = ROOT / "backend" / "data" / "listening" / "y_an"
AUDIO_DIR = ROOT / "backend" / "public" / "audio" / "listening" / "y_an"
SEEN_FILE = CONTENT_DIR / ".processed_yaan.json"


def load_bank():
    return json.loads(BANK_FILE.read_text(encoding="utf-8"))


def load_seen():
    if SEEN_FILE.exists():
        return json.loads(SEEN_FILE.read_text(encoding="utf-8"))
    return []


def save_seen(seen_ordered):
    CONTENT_DIR.mkdir(parents=True, exist_ok=True)
    SEEN_FILE.write_text(json.dumps(seen_ordered, ensure_ascii=False, indent=2), encoding="utf-8")


def pinyin_of(zh_text):
    try:
        from pypinyin import pinyin, Style

        return " ".join(s[0] for s in pinyin(zh_text, style=Style.TONE)) if zh_text else ""
    except Exception:
        return ""


MODALITY_LABEL = {
    "duoc": {"vi": "Dược/Thực liệu", "zh": "方药/食疗", "en": "Herbal/Dietary therapy"},
    "cham": {"vi": "Châm cứu", "zh": "针灸", "en": "Acupuncture"},
}


def build_passage_json(case, generated):
    bank_id = case["id"]
    passage_id = f"ya-auto-{bank_id}"
    modality = case["modality"]
    mlabel = MODALITY_LABEL[modality]

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

    citation = case["citation"]
    source_note_vi = f"Diễn giải tự động (AI) từ dữ kiện y án thật ({mlabel['vi']}), nguồn: {citation}. Chưa qua rà soát thủ công."
    source_note_zh = f"由 AI 根据真实医案事实自动改写（{mlabel['zh']}），来源：{citation}。尚未经人工校对。"
    source_note_en = f"AI-generated narrative from real case facts ({mlabel['en']}), source: {citation}. Not yet human-reviewed."

    return {
        "id": passage_id,
        "category": "y_an",
        "modality": modality,
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
    parser = argparse.ArgumentParser(description="Mở rộng kho Y Án tự động")
    parser.add_argument("--max", type=int, default=1, help="Số bài mới tối đa mỗi lần chạy")
    args = parser.parse_args()

    bank = load_bank()
    seen_ordered = load_seen()
    seen_set = set(seen_ordered)
    candidates = [c for c in bank if c["id"] not in seen_set][: args.max]
    if not candidates:
        print("Không còn dữ kiện y án mới trong kho (đã dùng hết, cần bổ sung thêm vào yaan_source_bank.json).", file=sys.stderr)
        return

    CONTENT_DIR.mkdir(parents=True, exist_ok=True)
    for case in candidates:
        print(f"[yaan] đang diễn giải {case['id']} ({case['modality']})...", file=sys.stderr)
        generated = openai_helper.generate_passage(case["facts_zh"], citation_hint=case["citation"])
        passage = build_passage_json(case, generated)
        out_path = CONTENT_DIR / f"{passage['id']}.json"
        out_path.write_text(json.dumps(passage, ensure_ascii=False, indent=2), encoding="utf-8")
        seen_ordered.append(case["id"])
        print(f"[yaan] sinh audio tiếng Trung cho {passage['id']}...", file=sys.stderr)
        audio_build.build_passage(out_path, lang="text_zh", voice_key="narrator")

    save_seen(seen_ordered)


if __name__ == "__main__":
    main()
