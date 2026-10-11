"""Cân bằng mức độ (so_cap / trung_cap / cao_cap) cho kho bài luyện nghe-dịch.

Trước đây chỉ Y Án có nhiều mức (do mô hình tự chọn, thực tế dồn trung_cap), còn Báo Chí/Học Thuật gần như 1 mức nên
bộ lọc theo mức không có tác dụng. Giờ mỗi pipeline hỏi `pick_target_level(category)` để biết mức đang THIẾU nhất rồi:
  - Báo Chí / Y Án: ép mô hình viết ở đúng mức đó (openai_helper.generate_passage(target_level=...));
  - Học Thuật (PubMed): chọn trong các bài ứng viên bài có độ phức tạp tiếng Anh khớp mức cần, và gán mức theo
    điểm phức tạp đo được (không còn mặc định cao_cap).
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LEVELS = ["so_cap", "trung_cap", "cao_cap"]


def count_levels(category):
    d = ROOT / "backend" / "data" / "listening" / category
    counts = {lv: 0 for lv in LEVELS}
    if not d.exists():
        return counts
    for f in d.glob("*.json"):
        if f.name.startswith("."):
            continue
        try:
            lv = json.loads(f.read_text(encoding="utf-8")).get("level")
        except Exception:
            continue
        if lv in counts:
            counts[lv] += 1
    return counts


def pick_target_level(category):
    """Mức đang có ít bài nhất (hoà → ưu tiên mức thấp hơn để xây nền)."""
    counts = count_levels(category)
    return min(LEVELS, key=lambda lv: (counts[lv], LEVELS.index(lv)))


def english_complexity(text):
    """Điểm phức tạp tiếng Anh: độ dài câu trung bình, tỉ lệ từ dài (≥ 9 chữ cái), mật độ số liệu."""
    sents = [s for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s]
    words = re.findall(r"[A-Za-z][A-Za-z'-]*", text)
    if not sents or not words:
        return {"avg_sent": 0.0, "long_ratio": 0.0, "score": 0.0}
    avg_sent = len(words) / len(sents)
    long_ratio = sum(1 for w in words if len(w) >= 9) / len(words)
    nums = len(re.findall(r"\d+(?:\.\d+)?", text)) / max(1, len(words))
    score = avg_sent / 10.0 + long_ratio * 10.0 + nums * 4.0
    return {"avg_sent": round(avg_sent, 1), "long_ratio": round(long_ratio, 3), "score": round(score, 2)}


def english_level(text):
    c = english_complexity(text)
    if c["score"] < 4.8:
        return "so_cap"
    if c["score"] < 5.9:
        return "trung_cap"
    return "cao_cap"
