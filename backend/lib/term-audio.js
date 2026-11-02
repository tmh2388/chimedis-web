/**
 * term-audio.js — GIỌNG ĐỌC TỪ MÁY CHỦ cho TÊN thuật ngữ (Hán / Việt / Anh) + rà soát & bổ sung âm thanh còn thiếu.
 * Vì sao: giọng của thiết bị (speechSynthesis / iOS) chất lượng không đều, có máy thiếu giọng Trung hoặc đọc im lặng một số từ
 * (vd. 松果体). Giọng Google (Wavenet nam / Chirp 3 HD nữ) qua máy chủ cho CHẤT LƯỢNG ĐỒNG ĐỀU trên mọi thiết bị và có sửa âm chữ đa âm.
 * Dùng chung bộ đệm `laoshi_tts_cache` (khoá = sha256(ngôn ngữ|giọng|chữ)) với Lão Sư/Luyện nghe: tạo một lần, ai cũng dùng.
 * CHỈ đọc chuỗi là TÊN có trong kho (tập `nameSet`) → không thể bị lạm dụng để đọc văn bản tuỳ ý. Chi phí do hệ thống chịu (kho hữu hạn).
 */
import { ttsKey, ttsGetMany, ttsPut } from './laoshi-learn.js';
import { synthesize } from './user-docs.js';

export const VOICES = ['default', 'aoede'];
const HAN = /[㐀-鿿]/;
const clean = (s) => String(s == null ? '' : s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/** Chuỗi gửi cho giọng đọc: Hán → bỏ chữ Latin/pinyin; Việt/Anh giữ nguyên. Rỗng nếu không đọc được. */
export function speechText(text, lang) {
  let s = clean(text).slice(0, 80);
  if (lang === 'zh') { s = s.replace(/[A-Za-zÀ-ɏḀ-ỿ]+/g, ' ').replace(/[·・]/g, ' ').replace(/\s+/g, ' ').trim(); if (!HAN.test(s)) return ''; }
  return s;
}

/** Tất cả chuỗi tên cần có âm thanh, theo ngôn ngữ: { zh:Set, vi:Set, en:Set } (chuỗi GỐC đã gọn khoảng trắng). */
export function nameSets(terms) {
  const out = { zh: new Set(), vi: new Set(), en: new Set() };
  const add = (set, v) => { const s = clean(v); if (s && s.length <= 80) set.add(s); };
  for (const t of terms) {
    if (t.hz && HAN.test(t.hz)) add(out.zh, t.hz);
    if (t.vi) add(out.vi, t.vi);
    if (t.en && /[A-Za-z]/.test(t.en)) add(out.en, t.en);
    if (t.category === 'word_element') { // ví dụ của từ ghép: "松果体瘤" / "pinealoma"
      if (t.example_cn) String(t.example_cn).split(/[,，]/).forEach((x) => add(out.zh, x));
      if (t.example_en) String(t.example_en).split(/[,，]/).forEach((x) => add(out.en, x));
      if (t.example) String(t.example).split(/[,，]/).forEach((x) => add(out.vi, x));
    }
  }
  return out;
}

const inflight = new Map();
/** mp3 của một TÊN (đã kiểm là tên trong kho): lấy từ đệm, chưa có thì sinh bằng Google TTS và lưu. */
export async function getOrMake(pool, rawText, lang, voice) {
  const v = VOICES.includes(voice) ? voice : 'default';
  const text = speechText(rawText, lang); if (!text) return null;
  const key = ttsKey(lang, v, text);
  const hit = (await ttsGetMany(pool, [key])).get(key); if (hit) return hit;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const audio = await synthesize(text, lang, v, {}); // không ghi vào ngân sách người dùng (hệ thống chịu)
    await ttsPut(pool, key, { lang, voice: v, chars: text.length, audio });
    return audio;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function cachedKeys(pool, keys) {
  const have = new Set();
  for (let i = 0; i < keys.length; i += 500) {
    const [rows] = await pool.query('SELECT hash FROM laoshi_tts_cache WHERE hash IN (?)', [keys.slice(i, i + 500)]);
    rows.forEach((r) => have.add(r.hash));
  }
  return have;
}

/** Đếm đã có / còn thiếu theo ngôn ngữ × giọng cho tên thuật ngữ. */
export async function coverage(pool, terms) {
  const sets = nameSets(terms); const out = {};
  for (const lang of ['zh', 'vi', 'en']) {
    const texts = [...sets[lang]].map((x) => speechText(x, lang)).filter(Boolean);
    for (const v of VOICES) {
      const keys = texts.map((x) => ttsKey(lang, v, x)); const have = await cachedKeys(pool, keys);
      out[`${lang}/${v}`] = { total: keys.length, cached: have.size, missing: keys.length - have.size };
    }
  }
  return out;
}

/** Sinh tối đa `limit` tên còn thiếu (song song 4). → { done, tried, remaining, chars, err } */
export async function fill(pool, terms, { lang, voice = 'default', limit = 60 } = {}) {
  const langs = lang ? [lang] : ['zh', 'vi', 'en'];
  const sets = nameSets(terms); const todo = [];
  for (const l of langs) {
    const texts = [...sets[l]].map((x) => speechText(x, l)).filter(Boolean);
    const keys = texts.map((x) => ttsKey(l, voice, x)); const have = await cachedKeys(pool, keys);
    texts.forEach((x, i) => { if (!have.has(keys[i])) todo.push([l, x]); });
  }
  const pick = todo.slice(0, Math.max(1, Math.min(200, Number(limit) || 60)));
  let done = 0, chars = 0, err = '';
  for (let i = 0; i < pick.length && !err; i += 4) {
    await Promise.all(pick.slice(i, i + 4).map(async ([l, x]) => {
      try { await getOrMake(pool, x, l, voice); done++; chars += x.length; } catch (e) { err = String(e.message || e).slice(0, 80); }
    }));
  }
  return { done, tried: pick.length, remaining: Math.max(0, todo.length - done), chars, err };
}
