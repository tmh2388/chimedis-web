"""Sinh audio TTS cho các pipeline tự động chạy thẳng trong repo này (hoc_thuat/PubMed
tiếng Anh, y_an+bao_chi tự động tiếng Trung) — chỉ dùng Google Cloud TTS, dùng chung
service account đã có cho Sheets API khác (GOOGLE_CREDENTIALS_JSON_B64).

Nội dung y_an/bao_chi THỦ CÔNG (do Claude trực tiếp soạn/diễn giải trong chat) vẫn soạn
ở repo riêng tmh2388/chimedis-listening rồi copy sang đây như trước — script này chỉ
phục vụ các pipeline KHÔNG cần chat (workflow_dispatch/cron).
"""
import base64
import json
import re
import time
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
AUDIO_CONFIG = ROOT / "config" / "audio.yaml"

LANG_LOCALE = {"text_zh": "cmn-CN", "text_vi": "vi-VN", "text_en": "en-US"}


def load_audio_config():
    return yaml.safe_load(AUDIO_CONFIG.read_text(encoding="utf-8"))


def require_env(name):
    import os

    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Thiếu biến môi trường bắt buộc: {name}")
    return value


def google_client():
    from google.cloud import texttospeech
    from google.oauth2 import service_account

    b64 = require_env("GOOGLE_CREDENTIALS_JSON_B64")
    info = json.loads(base64.b64decode(b64))
    creds = service_account.Credentials.from_service_account_info(info)
    # transport="rest" (không dùng gRPC mặc định) — gRPC từng thất bại trên 1 mạng/sandbox
    # cụ thể (lỗi "No route to host" tới endpoint IPv6 của Google), REST dùng HTTPS thuần
    # nên ổn định hơn ở nhiều môi trường mạng khác nhau (đã verify 2026-10-09).
    return texttospeech.TextToSpeechClient(credentials=creds, transport="rest")


def google_tts(text, voice_name, settings, out_mp3, language_code=None):
    from google.cloud import texttospeech

    client = google_client()
    language_code = language_code or settings.get("language_code", "en-US")
    input_text = texttospeech.SynthesisInput(text=text)
    voice = texttospeech.VoiceSelectionParams(language_code=language_code, name=voice_name)
    if "Chirp3" in voice_name or "Chirp-HD" in voice_name:
        # Chirp 3 HD không hỗ trợ pitch.
        audio_config = texttospeech.AudioConfig(
            audio_encoding=texttospeech.AudioEncoding.MP3,
            speaking_rate=settings.get("speaking_rate", 1.0),
        )
    else:
        audio_config = texttospeech.AudioConfig(
            audio_encoding=texttospeech.AudioEncoding.MP3,
            speaking_rate=settings.get("speaking_rate", 1.0),
            pitch=settings.get("pitch", 0.0),
        )
    for attempt in range(5):
        try:
            resp = client.synthesize_speech(input=input_text, voice=voice, audio_config=audio_config)
            out_mp3.write_bytes(resp.audio_content)
            return
        except Exception as exc:
            if attempt == 4:
                raise RuntimeError(f"Google TTS lỗi: {exc}") from exc
            time.sleep(2**attempt)


def concat_mp3s(parts, output_mp3, pause_ms):
    import subprocess
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        silence = td / "silence.mp3"
        subprocess.run(
            [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
                "-t", str(pause_ms / 1000), "-c:a", "libmp3lame", str(silence),
            ],
            check=True,
        )
        sequence = []
        for i, p in enumerate(parts):
            sequence.append(p)
            if i != len(parts) - 1:
                sequence.append(silence)
        list_file = td / "concat.txt"
        list_file.write_text("\n".join(f"file '{p.resolve()}'" for p in sequence), encoding="utf-8")
        subprocess.run(
            [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-f", "concat", "-safe", "0", "-i", str(list_file),
                "-c", "copy", str(output_mp3),
            ],
            check=True,
        )


def tts_prepare(text, lang="text_zh"):
    """Văn bản đưa cho TTS (KHÔNG đổi chữ hiển thị). Chèn dấu phẩy ngay trước dấu ngoặc kép mở khi nó dính liền
    chữ đứng trước: không có dấu phẩy, mô hình tự ngắt nhầm ở chữ đầu của cụm trong ngoặc (vd 2026年度“中西医…” bị
    dừng sau 年度中). Muốn kiểm soát hoàn toàn một câu, đặt field `tts_zh` cho đoạn đó trong JSON."""
    if lang != "text_zh":
        return text
    NO_BREAK_BEFORE = set("的之和与及或为是称曰叫以对将把被从在于里内见说道即名云言指含有")
    out = []
    last_punct = -1
    for i, ch in enumerate(text):
        if ch in "，。；：、！？,.;:!?" :
            last_punct = i
        if ch in "“「『" and i - last_punct - 1 >= 8:
            prev = text[i - 1]
            if prev not in NO_BREAK_BEFORE and re.match(r"[\u4e00-\u9fffA-Za-z0-9]", prev):
                out.append("，")
        out.append(ch)
    return "".join(out)


def tts_text(seg, lang):
    if lang == "text_zh" and seg.get("tts_zh"):
        return seg["tts_zh"]
    return tts_prepare(seg[lang], lang)


def build_passage(file_path, lang="text_en", voice_key="narrator"):
    """Sinh audio cho 1 đoạn văn tường thuật — ghi trực tiếp vào backend/public/audio/listening
    (nơi app thật serve), không qua bước copy tay nào."""
    cfg = load_audio_config()
    locale = LANG_LOCALE.get(lang, "en-US")
    voices_key = "voices_google_zh" if lang == "text_zh" else "voices_google_en"
    voices = cfg[voices_key]
    settings = cfg["provider_settings"]["google"]
    pause_ms = cfg.get("pause_ms", 420)
    voice = voices.get(voice_key)
    if not voice:
        raise RuntimeError(f"Không có giọng cho '{voice_key}' trong config/audio.yaml")

    data = json.loads(Path(file_path).read_text(encoding="utf-8"))
    if not data.get("created_at"):
        # Ngày bài được đưa vào kho — dùng để xếp bài mới lên đầu và hiện "cập nhật" dưới tiêu đề.
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        data["created_at"] = now
        data["updated_at"] = now
        Path(file_path).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    passage_id = data["id"]
    category = data["category"]
    out_dir = ROOT / "backend" / "public" / "audio" / "listening" / category / passage_id
    out_dir.mkdir(parents=True, exist_ok=True)

    seg_files = []
    for seg in data["segments"]:
        seq = seg["seq"]
        text = seg[lang]
        out_mp3 = out_dir / f"{seq:02d}-{lang}.mp3"
        print(f"[{passage_id}] đoạn {seq} ({lang})...", file=__import__("sys").stderr)
        google_tts(tts_text(seg, lang), voice, settings, out_mp3, language_code=locale)
        seg_files.append(out_mp3)

    full_mp3 = out_dir / f"full-{lang}.mp3"
    concat_mp3s(seg_files, full_mp3, pause_ms)

    if lang == "text_zh":
        build_extra_voices(file_path)


def build_extra_voices(file_path, lang="text_zh"):
    """Sinh thêm các giọng người học có thể chọn (voices_extra_zh) cho đoạn tiếng Trung — chỉ file từng câu
    (app phát nối tiếp từng câu), lưu ở <id>/<khóa giọng>/NN-text_zh.mp3. Đã có file thì bỏ qua."""
    cfg = load_audio_config()
    extra = cfg.get("voices_extra_zh") or {}
    if not extra:
        return
    settings = cfg["provider_settings"]["google"]
    data = json.loads(Path(file_path).read_text(encoding="utf-8"))
    if data.get("source_lang") == "en":
        return
    base = ROOT / "backend" / "public" / "audio" / "listening" / data["category"] / data["id"]
    for key, voice in extra.items():
        out_dir = base / key
        out_dir.mkdir(parents=True, exist_ok=True)
        for seg in data["segments"]:
            out_mp3 = out_dir / f"{seg['seq']:02d}-{lang}.mp3"
            if out_mp3.exists() and out_mp3.stat().st_size > 0:
                continue
            print(f"[{data['id']}] {key} đoạn {seg['seq']}...", file=__import__("sys").stderr)
            google_tts(tts_text(seg, lang), voice, settings, out_mp3, language_code=LANG_LOCALE.get(lang, "cmn-CN"))


def backfill_extra_voices():
    root = ROOT / "backend" / "data" / "listening"
    for f in sorted(root.glob("*/*.json")):
        if f.name.startswith("."):
            continue
        build_extra_voices(f)


def regen_prosody(lang="text_zh"):
    """Sinh lại audio (mọi giọng) cho các đoạn mà văn bản TTS khác văn bản hiển thị (tts_prepare hoặc `tts_zh`),
    rồi nối lại full-text_zh.mp3. Dùng khi đổi quy tắc ngắt nghỉ."""
    cfg = load_audio_config()
    settings = cfg["provider_settings"]["google"]
    pause_ms = cfg.get("pause_ms", 420)
    voices = {"": cfg["voices_google_zh"]["narrator"], **{k: v for k, v in (cfg.get("voices_extra_zh") or {}).items()}}
    root = ROOT / "backend" / "data" / "listening"
    for f in sorted(root.glob("*/*.json")):
        if f.name.startswith("."):
            continue
        data = json.loads(f.read_text(encoding="utf-8"))
        if data.get("source_lang") == "en":
            continue
        base = ROOT / "backend" / "public" / "audio" / "listening" / data["category"] / data["id"]
        changed = [seg for seg in data["segments"] if tts_text(seg, lang) != seg[lang]]
        if not changed:
            continue
        for key, voice in voices.items():
            out_dir = base / key if key else base
            out_dir.mkdir(parents=True, exist_ok=True)
            for seg in changed:
                out_mp3 = out_dir / f"{seg['seq']:02d}-{lang}.mp3"
                print(f"[{data['id']}] {key or 'default'} đoạn {seg['seq']}: {tts_text(seg, lang)}", file=__import__("sys").stderr)
                google_tts(tts_text(seg, lang), voice, settings, out_mp3, language_code=LANG_LOCALE.get(lang, "cmn-CN"))
        parts = [base / f"{seg['seq']:02d}-{lang}.mp3" for seg in data["segments"]]
        if all(p.exists() for p in parts):
            concat_mp3s(parts, base / f"full-{lang}.mp3", pause_ms)


if __name__ == "__main__":
    import sys as _sys
    if len(_sys.argv) > 1 and _sys.argv[1] == "regen-prosody":
        regen_prosody()
    elif len(_sys.argv) > 1 and _sys.argv[1] == "backfill-voices":
        backfill_extra_voices()
    else:
        print("Dùng: python scripts/audio_build.py backfill-voices", file=_sys.stderr)
