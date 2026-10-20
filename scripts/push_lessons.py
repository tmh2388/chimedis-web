#!/usr/bin/env python3
"""Đẩy bài Luyện nghe MỚI (JSON + mp3) từ thư mục làm việc của GitHub Action lên máy chủ dict — KHÔNG commit vào main,
nên Hostinger KHÔNG phải redeploy. Giữ tối đa --keep bài do máy chủ lưu (xoá bài cũ nhất).

  LESSON_PUSH_KEY=... python scripts/push_lessons.py <category> [--keep 60] [--base https://dict.chimedis.vn]

Mã thoát: 0 = xong (kể cả không có bài mới); 3 = không có LESSON_PUSH_KEY (workflow quay về cách commit cũ);
1 = lỗi (workflow quay về cách commit cũ — file vẫn còn nguyên trong thư mục làm việc).
"""
import argparse, base64, json, os, subprocess, sys, time, urllib.error, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def http(method, url, key, body=None, timeout=300):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    last = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, data=data, method=method,
                                         headers={"x-lesson-key": key, "content-type": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, json.loads(r.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            txt = e.read().decode("utf-8", "replace")[:300]
            if e.code < 500:
                return e.code, {"error": txt}
            last = f"{e.code} {txt}"
        except Exception as e:  # mạng chập chờn
            last = repr(e)
        time.sleep(5 * (attempt + 1))
    raise RuntimeError(last)


def changed_lessons(category):
    out = subprocess.run(["git", "status", "--porcelain", "--untracked-files=all", "--", f"backend/data/listening/{category}"],
                         cwd=ROOT, capture_output=True, text=True).stdout
    files = []
    for line in out.splitlines():
        st, path = line[:2], line[3:].strip().strip('"')
        name = Path(path).name
        if not name.endswith(".json") or name.startswith(".") or "D" in st:
            continue
        files.append(ROOT / path)
    return files


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("category")
    ap.add_argument("--keep", type=int, default=60)
    ap.add_argument("--base", default=os.environ.get("LESSON_BASE_URL", "https://dict.chimedis.vn"))
    a = ap.parse_args()
    key = os.environ.get("LESSON_PUSH_KEY", "")
    if not key:
        print("Chưa có LESSON_PUSH_KEY → dùng cách commit cũ.")
        return 3
    base = a.base.rstrip("/")
    files = changed_lessons(a.category)
    print(f"{len(files)} bài mới/sửa trong '{a.category}'")
    for jf in files:
        lesson = json.loads(jf.read_text(encoding="utf-8"))
        lid = lesson["id"]
        adir = ROOT / "backend" / "public" / "audio" / "listening" / lesson["category"] / lid
        audio = {}
        if adir.exists():
            for mp3 in sorted(adir.rglob("*.mp3")):
                audio[f"{lesson['category']}/{lid}/{mp3.relative_to(adir).as_posix()}"] = base64.b64encode(mp3.read_bytes()).decode("ascii")
        mb = sum(len(v) for v in audio.values()) / 1e6
        print(f"  → {lid}: {len(lesson.get('segments', []))} câu, {len(audio)} mp3 (~{mb:.1f} MB base64)")
        code, res = http("PUT", f"{base}/api/admin/listening/lesson", key, {"lesson": lesson, "audio": audio})
        if code != 200 or not res.get("success"):
            print(f"  ✗ máy chủ trả {code}: {res}")
            return 1
        code, res = http("GET", f"{base}/api/listening/dialogues/{lid}", key, None, 60)
        if code != 200 or not (res.get("data") or {}).get("segments"):
            print(f"  ✗ đẩy xong nhưng đọc lại bài {lid} thất bại ({code})")
            return 1
        print(f"  ✓ {lid} đã có trên máy chủ")
    # giữ N bài mới nhất do máy chủ lưu (bài trong kho mã/hand-made không bị đụng)
    code, res = http("GET", f"{base}/api/listening/dialogues?category={a.category}", key, None, 60)
    if code == 200:
        mine = sorted([d for d in res.get("data", []) if d.get("db")], key=lambda d: d.get("created_at") or "", reverse=True)
        for d in mine[a.keep:]:
            c, r = http("DELETE", f"{base}/api/admin/listening/lesson/{d['id']}", key, None, 60)
            print(f"  xoá bài cũ {d['id']}: {c}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
