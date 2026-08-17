/**
 * translate.js
 * Machine translation for herbal DB fields that have no VI/EN column in the
 * source (indication, dose prep text, cautions, category names) — treat the
 * output as "cần rà soát" (needs human review), same caveat the source's own
 * AI-translated name_vi/name_en columns already carry.
 *
 * Uses MyMemory (https://mymemory.translated.net) — free, no billing/API key
 * required (Google Cloud Translation needs a billing account even within its
 * free tier, which isn't available here). Quality is plain MT, and MyMemory
 * caps each request at ~500 chars, so long text is split on Chinese
 * punctuation and re-joined.
 */
const MAX_CHARS = 480;
const EMAIL = process.env.TRANSLATE_CONTACT_EMAIL || '';
const CONCURRENCY = 2; // giảm từ 4 — chạy 2 lượt import huyệt vị liên tiếp trong 1 ngày từng
                        // khiến MyMemory rate-limit, xem ghi chú isUntranslatedEcho() bên dưới.
const REQUEST_STAGGER_MS = 150; // giãn cách nhẹ giữa các request để đỡ bị coi là spam

// Phát hiện 2026-08-17: khi bị rate-limit, MyMemory đôi khi trả HTTP 200 với
// `translatedText` là NGUYÊN VĂN CHỮ HÁN gốc echo lại (không phải chuỗi cảnh
// báo "MYMEMORY WARNING" như trường hợp hết quota đã biết) — không có lỗi rõ
// ràng để bắt, chỉ phát hiện được vì output hoàn toàn không có ký tự Latin dù
// dịch sang vi/en. Coi đây là 1 dạng lỗi dịch, không lưu làm bản dịch thật.
function isUntranslatedEcho(text) {
  return !!text && !/[a-zA-ZÀ-ỹ]/.test(text);
}

function splitLong(text) {
  if (text.length <= MAX_CHARS) return [text];
  const parts = text.split(/(?<=[；。！？.!?])/); // giữ dấu câu lại với đoạn
  const chunks = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length > MAX_CHARS && cur) { chunks.push(cur); cur = ''; }
    cur += p;
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [text.slice(0, MAX_CHARS)];
}

async function translateOne(text, target, cache) {
  const key = `${target}:${text}`;
  if (cache.has(key)) return cache.get(key);

  const segments = splitLong(text);
  const translatedSegments = [];
  for (const seg of segments) {
    const url = new URL('https://api.mymemory.translated.net/get');
    url.searchParams.set('q', seg);
    url.searchParams.set('langpair', `zh|${target}`);
    if (EMAIL) url.searchParams.set('de', EMAIL);

    let result = seg; // fallback: giữ nguyên gốc nếu dịch lỗi, còn hơn mất dữ liệu
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        const json = await res.json();
        const tt = json && json.responseData && json.responseData.translatedText;
        // MyMemory trả HTTP 200 kèm chuỗi cảnh báo hết quota thay vì lỗi thật
        // (vd. "MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS...")
        // — phải nhận diện riêng, nếu không sẽ lưu nhầm câu cảnh báo này làm
        // bản dịch thật.
        const isQuotaWarning = typeof tt === 'string' && /MYMEMORY WARNING|QUOTA|LIMIT/i.test(tt);
        if (json.responseStatus && Number(json.responseStatus) !== 200) {
          throw new Error(`MyMemory responseStatus=${json.responseStatus}`);
        }
        if (isQuotaWarning) {
          throw new Error('MyMemory hết quota dịch miễn phí hôm nay');
        }
        if (tt && isUntranslatedEcho(tt)) {
          throw new Error('MyMemory trả nguyên văn gốc (nghi bị rate-limit)');
        }
        if (tt) result = tt;
        break;
      } catch (err) {
        if (attempt === 2) console.warn(`   ⚠️  Dịch lỗi (giữ nguyên gốc): ${err.message}`);
        else await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    translatedSegments.push(result);
  }
  const joined = translatedSegments.join(' ');
  cache.set(key, joined);
  return joined;
}

/**
 * Translates an array of Chinese strings to `target` ('vi' | 'en').
 * Empty/null entries pass through as null. Identical strings are translated
 * once and reused (common for dose/caution boilerplate).
 */
export async function translateBatch(texts, target, onProgress) {
  const cache = new Map();
  const results = new Array(texts.length).fill(null);
  const todo = [];
  texts.forEach((t, i) => { if (t && String(t).trim()) todo.push(i); });

  let done = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < todo.length) {
      const idx = todo[cursor++];
      results[idx] = await translateOne(String(texts[idx]), target, cache);
      done++;
      if (onProgress && done % 50 === 0) onProgress(done, todo.length);
      if (cursor < todo.length) await new Promise((r) => setTimeout(r, REQUEST_STAGGER_MS));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length || 1) }, worker));
  if (onProgress) onProgress(done, todo.length);
  return results;
}
