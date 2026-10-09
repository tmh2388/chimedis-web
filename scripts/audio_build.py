"""Sinh audio TTS cho nhánh nội dung tự động "hoc_thuat" (PubMed, luyện dịch EN→ZH) —
bản tối giản, chỉ dùng Google Cloud TTS (không cần ElevenLabs). Dùng chung service
account đã có cho Sheets API khác (GOOGLE_CREDENTIALS_JSON_B64).

Nội dung y_an/bao_chi (tiếng Trung, do Claude soạn/diễn giải) KHÔNG dùng script này —
soạn ở repo riêng tmh2388/chimedis-listening rồi copy sang backend/data/listening.
"""
import base64
import json
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


def build_passage(file_path, lang="text_en", voice_key="narrator"):
    """Sinh audio cho 1 đoạn văn tường thuật — ghi trực tiếp vào backend/public/audio/listening
    (nơi app thật serve), không qua bước copy tay nào."""
    cfg = load_audio_config()
    locale = LANG_LOCALE.get(lang, "en-US")
    voices = cfg["voices_google_en"]
    settings = cfg["provider_settings"]["google"]
    pause_ms = cfg.get("pause_ms", 420)
    voice = voices.get(voice_key)
    if not voice:
        raise RuntimeError(f"Không có giọng cho '{voice_key}' trong config/audio.yaml")

    data = json.loads(Path(file_path).read_text(encoding="utf-8"))
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
        google_tts(text, voice, settings, out_mp3, language_code=locale)
        seg_files.append(out_mp3)

    full_mp3 = out_dir / f"full-{lang}.mp3"
    concat_mp3s(seg_files, full_mp3, pause_ms)
