/**
 * text-translate.js — DỊCH đoạn người dùng bôi đen (từ / cụm / câu) trong thẻ Bác sĩ.
 * Hai động cơ (biến SELECT_TRANSLATE_ENGINE): "ai" (mặc định — theo BẢNG THUẬT NGỮ BẮT BUỘC của Chimedis, đúng quy ước Trung y)
 * hoặc "google" (Google Cloud Translation v2 qua tài khoản dịch vụ sẵn có; cần bật API + thanh toán ở dự án Google Cloud).
 * Có bộ nhớ đệm trong tiến trình; hạn mức do route đặt.
 */
import { pinyin } from 'pinyin';
import { costFromUsage } from './ai-budget.js';
import { styleBlock } from './tcm-style.js';
import { createGoogleAuth, hasGoogleCredentials } from '../google-auth.js';

const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
const MODEL = process.env.SELECT_TRANSLATE_MODEL || process.env.AI_LOOKUP_MODEL || 'gpt-5-mini';
const HAN = /[㐀-鿿]/;
const TARGETS = { vi: 'tiếng Việt', zh: 'tiếng Trung giản thể', en: 'tiếng Anh' };
export const MAX_CHARS = 400;
export const engine = () => (String(process.env.SELECT_TRANSLATE_ENGINE || 'ai').toLowerCase() === 'google' ? 'google' : 'ai');

const cache = new Map(); // khoá → kết quả (LRU thô, 500 mục)
const remember = (k, v) => { cache.set(k, v); if (cache.size > 500) cache.delete(cache.keys().next().value); return v; };

const hanPy = (text) => { if (!HAN.test(text)) return ''; try { return pinyin(text.replace(/[^㐀-鿿]/g, ''), { style: 'tone' }).map((a) => a[0]).join(' '); } catch (_) { return ''; } };

async function viaAi(text, target) {
  const sys = `Bạn là dịch giả y học Trung–Việt–Anh của Chimedis. Dịch đoạn người dùng cung cấp sang ${TARGETS[target]}, tự nhận ngôn ngữ nguồn. `
    + 'Giữ ĐÚNG thuật ngữ Trung y theo bảng bắt buộc bên dưới (Hán-Việt cho tên Việt). Không giải thích dài, không thêm ý. Nếu đã là ngôn ngữ đích thì dịch sang nghĩa dễ hiểu bằng chính ngôn ngữ đó (diễn đạt lại ngắn). '
    + 'Nếu đoạn chỉ là MỘT từ/cụm ngắn, thêm "gloss" ≤ 120 ký tự nói nghĩa theo ngữ cảnh y khoa (cùng ngôn ngữ đích), không thì để rỗng. Chỉ trả JSON.\n\n' + styleBlock([text], { max: 20 });
  const r = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: sys }, { role: 'user', content: `Đoạn cần dịch: ${JSON.stringify(text)}\nTrả JSON {"translation":"","src":"vi|zh|en|other","gloss":""}` }],
      response_format: { type: 'json_object' }, max_completion_tokens: 1500, reasoning_effort: process.env.SELECT_TRANSLATE_EFFORT || 'minimal' }),
  });
  if (!r.ok) throw Object.assign(new Error(`translate_llm ${r.status}`), { code: 'upstream' });
  const j = await r.json();
  const p = JSON.parse(String(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '{}'));
  const translation = String(p.translation || '').trim().slice(0, 1200);
  if (!translation) throw Object.assign(new Error('translate_empty'), { code: 'upstream' });
  return { translation, src: String(p.src || '').slice(0, 5), gloss: String(p.gloss || '').trim().slice(0, 200), costUsd: costFromUsage(MODEL, j.usage) };
}

async function viaGoogle(text, target) {
  if (!hasGoogleCredentials()) throw Object.assign(new Error('google_not_configured'), { code: 'not_configured' });
  const client = await createGoogleAuth(['https://www.googleapis.com/auth/cloud-platform']).getClient();
  const tok = await client.getAccessToken();
  const r = await fetch('https://translation.googleapis.com/language/translate/v2', {
    method: 'POST', headers: { Authorization: `Bearer ${tok.token || tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: text, target: target === 'zh' ? 'zh-CN' : target, format: 'text' }),
  });
  if (!r.ok) throw Object.assign(new Error(`google_translate ${r.status}`), { code: 'upstream' });
  const j = await r.json();
  const t0 = j && j.data && j.data.translations && j.data.translations[0];
  if (!t0 || !t0.translatedText) throw Object.assign(new Error('translate_empty'), { code: 'upstream' });
  const src = String(t0.detectedSourceLanguage || '').slice(0, 5).replace(/^zh.*/, 'zh');
  return { translation: String(t0.translatedText).slice(0, 1200), src, gloss: '', costUsd: (text.length / 1e6) * 20 }; // $20 / 1 triệu ký tự
}

/** @returns {{translation:string, src:string, gloss:string, py:string, engine:string, costUsd:number, cached:boolean}} */
export async function translateText(text, target) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
  const tg = TARGETS[target] ? target : 'vi';
  if (!t) throw Object.assign(new Error('empty'), { code: 'bad_request' });
  const eng = engine(); const key = `${eng}|${tg}|${t}`;
  if (cache.has(key)) return { ...cache.get(key), costUsd: 0, cached: true };
  const out = eng === 'google' ? await viaGoogle(t, tg) : await viaAi(t, tg);
  return { ...remember(key, { translation: out.translation, src: out.src, gloss: out.gloss, py: hanPy(t), engine: eng }), costUsd: out.costUsd || 0, cached: false };
}
