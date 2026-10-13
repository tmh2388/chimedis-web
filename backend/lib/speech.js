/**
 * speech.js — NHẬN DẠNG GIỌNG NÓI dùng chung cho Chấm nhanh / Lão Sư / mọi nơi cần "audio → chữ".
 *
 * Vấn đề trước đây: ép ngôn ngữ theo giao diện, không có điểm tin cậy, nên (a) người nói tiếng Trung trên giao diện tiếng Anh bị ép
 * phiên âm thành tiếng Anh/tiếng khác và ra chữ vô nghĩa; (b) âm thanh im lặng/tạp âm bị mô hình "bịa" câu (ví dụ 等一下,四分鐘…) rồi vẫn bị chấm 0.
 *
 * Quy trình:
 *   1. whisper-1 (verbose_json, KHÔNG ép ngôn ngữ) → nhận ra ngôn ngữ nói + điểm "không có tiếng nói" + độ tin cậy từng đoạn.
 *   2. Nếu im lặng/tạp âm/lặp bậy → trả unclear (KHÔNG chấm điểm rác).
 *   3. Có tiếng nói → phiên âm lại bằng mô hình mạnh hơn (gpt-4o-transcribe → mini → chính whisper) với ngôn ngữ ĐÃ NHẬN + gợi ý từ vựng.
 *      Không đưa NGUYÊN CÂU mẫu vào prompt (tránh mô hình "tự sửa" che lỗi); chỉ đưa thuật ngữ.
 */
import { normalize as normalizeInterp } from './interpret-check.js';

const LANG_BY_NAME = { chinese: 'zh', mandarin: 'zh', cantonese: 'zh', english: 'en', vietnamese: 'vi', zh: 'zh', en: 'en', vi: 'vi' };
const HAN = /[㐀-鿿]/g;

/** Từ văn bản đoán ngôn ngữ: 'zh' | 'vi' | 'en' | null. */
export function guessLangFromText(t, detectViEn) {
  const s = String(t || '');
  const han = (s.match(HAN) || []).length;
  const letters = (s.match(/[A-Za-zÀ-ỹ]/g) || []).length;
  if (han >= 2 && han >= letters * 0.5) return 'zh';
  return typeof detectViEn === 'function' ? detectViEn(s) : null;
}

async function callTranscribe(buf, { model, language, prompt, verbose }) {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', model);
  if (language) form.append('language', language);
  form.append('response_format', verbose ? 'verbose_json' : 'json');
  form.append('temperature', '0');
  if (prompt) form.append('prompt', String(prompt).slice(0, 800));
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form,
  });
  if (!r.ok) { const e = new Error(`${model}: ${r.status} ${(await r.text()).slice(0, 160)}`); e.status = r.status; throw e; }
  return r.json();
}

/** Mô hình hay "nhại" prompt hoặc lặp một cụm khi gần như im lặng. */
function looksHallucinated(text, prompt) {
  const t = String(text || '').trim();
  if (!t) return true;
  const nt = normalizeInterp(t), np = normalizeInterp(prompt || '');
  if (np && nt && (np.includes(nt) || (nt.length > 12 && nt.includes(np)))) return true;
  // Lặp: một đoạn ngắn lặp ≥ 4 lần liên tiếp.
  if (/(.{2,12})\1{3,}/.test(t.replace(/\s+/g, ''))) return true;
  return false;
}

/**
 * @param {Buffer} buf WAV
 * @param {{vocab?:string, expect?:string}} opts  vocab: thuật ngữ gợi ý; expect: ngôn ngữ kỳ vọng ('zh'|'vi'|'en') dùng khi không nhận ra được
 * @returns {Promise<{text:string, language:string|null, confidence:number, unclear:boolean, reason?:string, model:string}>}
 */
export async function recognize(buf, { vocab = '', expect = null } = {}) {
  const basePrompt = vocab ? `Thuật ngữ y học cổ truyền / TCM terms: ${vocab}` : 'Y học cổ truyền Trung Hoa / Traditional Chinese Medicine.';
  let stage1 = null;
  try {
    stage1 = await callTranscribe(buf, { model: 'whisper-1', prompt: basePrompt, verbose: true });
  } catch (e) {
    if (e.status && ![400, 404, 429, 500, 502, 503].includes(e.status)) throw e;
  }
  let language = null, conf = 0.5, text1 = '';
  if (stage1) {
    language = LANG_BY_NAME[String(stage1.language || '').toLowerCase()] || null;
    text1 = String(stage1.text || '').trim();
    const segs = Array.isArray(stage1.segments) ? stage1.segments : [];
    if (segs.length) {
      const worstSilence = Math.min(...segs.map((s) => 1 - (s.no_speech_prob == null ? 0 : s.no_speech_prob)));
      const avgLp = segs.reduce((a, s) => a + (s.avg_logprob == null ? -0.5 : s.avg_logprob), 0) / segs.length;
      const maxCompr = Math.max(...segs.map((s) => s.compression_ratio || 0));
      const speechProb = segs.reduce((a, s) => a + (1 - (s.no_speech_prob || 0)), 0) / segs.length;
      conf = Math.max(0, Math.min(1, 0.6 * speechProb + 0.4 * Math.max(0, 1 + avgLp)));
      if (speechProb < 0.35 || worstSilence < 0.05) return { text: '', language, confidence: conf, unclear: true, reason: 'silence', model: 'whisper-1' };
      if (maxCompr > 2.6) return { text: '', language, confidence: conf, unclear: true, reason: 'noise', model: 'whisper-1' };
    }
    if (looksHallucinated(text1, basePrompt) && !text1.match(/[㐀-鿿A-Za-zÀ-ỹ0-9]{2,}/)) {
      return { text: '', language, confidence: conf, unclear: true, reason: 'silence', model: 'whisper-1' };
    }
  }
  const lang2 = language || expect || null;
  // Bước 2: phiên âm lại bằng mô hình mạnh hơn, ngôn ngữ đã nhận.
  const prompt2 = lang2 === 'zh' ? `中医学习。请用简体中文转写。术语：${vocab || '穴位、经络、中药、方剂'}`
    : lang2 === 'vi' ? `Thảo luận y học cổ truyền bằng tiếng Việt. Thuật ngữ: ${vocab}`
      : lang2 === 'en' ? `Traditional Chinese Medicine. Terms: ${vocab}` : basePrompt;
  for (const model of ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe']) {
    try {
      const j = await callTranscribe(buf, { model, language: lang2 || undefined, prompt: prompt2, verbose: false });
      const text = String(j.text || '').trim();
      if (text && !looksHallucinated(text, prompt2)) return { text, language: language || guessLangFromText(text), confidence: conf, unclear: false, model };
    } catch (e) {
      if (e.status && ![400, 404, 429, 500, 502, 503].includes(e.status)) throw e;
    }
  }
  if (text1 && !looksHallucinated(text1, basePrompt)) return { text: text1, language: language || guessLangFromText(text1), confidence: conf, unclear: false, model: 'whisper-1' };
  return { text: '', language, confidence: conf, unclear: true, reason: 'empty', model: 'none' };
}
