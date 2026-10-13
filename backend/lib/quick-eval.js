/**
 * quick-eval.js — "CHẤM NHANH" nhiều chiều, KHÔNG cần văn mẫu để có điểm.
 *
 * Mục tiêu của chấm nhanh (đã chốt với chủ dự án 2026-10-13): đánh giá chính LỜI NÓI của người học theo ngôn ngữ họ thực sự nói:
 *   1. RÕ RÀNG / PHÁT ÂM  — máy nhận dạng có nghe ra được không (độ tin cậy nhận dạng; âm nhỏ/tạp âm/nuốt âm → thấp).
 *   2. ĐỦ Ý               — nói đủ nội dung cần có. Chỉ tính khi bài có "căn cứ ý": đơn vị ý (key_units) hoặc câu mẫu CÙNG ngôn ngữ nói.
 *                           Đo mức phủ ý, không bắt đúng từng chữ; không có căn cứ thì bỏ chiều này, không chấm bậy.
 *   3. MẠCH LẠC & TRÔI CHẢY — tốc độ nói, quãng ngắt, lặp từ, từ đệm, câu đủ dài/đủ ý (heuristic thuần thuật toán).
 * Ngữ pháp/văn phong sâu và phát âm từng âm tiết thuộc "Phân tích sâu bằng AI".
 */
const HAN_G = /[㐀-鿿]/g;
const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const FILLERS = new Set(['um', 'uh', 'er', 'erm', 'hmm', 'ừm', 'ờ', 'à', 'ơ', 'ừ', 'thì', 'là', '呃', '嗯', '额', '那个', '这个']);

export function scriptStats(text) {
  const t = String(text || '');
  const han = (t.match(HAN_G) || []).length;
  const words = (t.replace(HAN_G, ' ').match(/[A-Za-zÀ-ỹ]+(?:['’-][A-Za-zÀ-ỹ]+)*/g) || []);
  return { han, words, units: han + words.length };
}
/** Ngôn ngữ CHỦ ĐẠO theo nội dung (đếm từ/chữ), không theo nhãn của bộ nhận dạng. 'zh' | vi/en từ detect | null. */
export function dominantLang(text, detectViEn, fallback = null) {
  const st = scriptStats(text);
  if (!st.units) return null;
  if (st.han >= st.words.length) return 'zh';
  const latinOnly = String(text).replace(HAN_G, ' ');
  return (typeof detectViEn === 'function' ? detectViEn(latinOnly) : null) || (fallback === 'vi' || fallback === 'en' ? fallback : 'en');
}
export function isMixed(text) {
  const st = scriptStats(text);
  if (st.han === 0 || st.words.length === 0) return false;
  const minor = Math.min(st.han, st.words.length), total = st.han + st.words.length;
  return minor >= 1 && minor / total >= 0.04;
}

/**
 * @param {{transcript:string, lang:'zh'|'vi'|'en', confidence:number|null, fluency?:{speech_ms:number,pause_count:number,longest_pause_ms:number}|null, contentScore:number|null}} p
 */
export function quickEval({ transcript, lang, confidence, fluency, contentScore }) {
  const st = scriptStats(transcript);
  const units = st.units;
  const notes = [];

  // 1) Rõ ràng: độ tin cậy nhận dạng 0..1 → 0..100 (0,35 trở xuống ≈ 0; 0,95 ≈ 100)
  const clarity = (confidence == null || !isFinite(confidence)) ? null : Math.round(clamp((confidence - 0.35) / 0.6 * 100));
  if (clarity != null && clarity < 55) notes.push('unclear');

  // 2) Đủ ý: do nơi gọi truyền vào (mức phủ đơn vị ý / độ phủ so với câu mẫu cùng ngôn ngữ)
  const content = (contentScore == null || !isFinite(contentScore)) ? null : Math.round(clamp(contentScore));
  if (content != null && content < 50) notes.push('missing_content');

  // 3) Mạch lạc & trôi chảy
  let flu = null;
  if (fluency && fluency.speech_ms > 700 && units > 0) {
    const rate = units / (fluency.speech_ms / 1000);                  // đơn vị (từ Anh/Việt hoặc chữ Hán) mỗi giây
    const lo = lang === 'zh' ? 2.0 : 1.5, hi = lang === 'zh' ? 6.2 : 3.6;
    let sc = 100;
    if (rate < lo) { sc -= Math.min(40, (lo - rate) / lo * 70); notes.push('slow'); }
    if (rate > hi) { sc -= Math.min(30, (rate - hi) / hi * 60); notes.push('fast'); }
    sc -= Math.min(30, (fluency.pause_count || 0) * 9);
    if ((fluency.pause_count || 0) >= 3) notes.push('pauses');
    if ((fluency.longest_pause_ms || 0) > 2200) sc -= 10;
    flu = sc;
  }
  // cấu trúc câu: độ dài, lặp, từ đệm, kết thúc đủ ý
  let coh = 100;
  const toks = [...st.words.map((w) => w.toLowerCase())];
  if (units < 3) { coh -= 45; notes.push('too_short'); }
  else if (units < 6) coh -= 15;
  let rep = 0;
  for (let i = 1; i < toks.length; i++) if (toks[i] === toks[i - 1]) rep++;
  const trig = new Map(); for (let i = 0; i + 2 < toks.length; i++) { const k = toks.slice(i, i + 3).join(' '); trig.set(k, (trig.get(k) || 0) + 1); }
  for (const c of trig.values()) if (c > 1) rep += c - 1;
  if (rep > 0) { coh -= Math.min(30, rep * 10); notes.push('repeat'); }
  const fill = toks.filter((w) => FILLERS.has(w)).length + (String(transcript).match(/呃|嗯|额/g) || []).length;
  if (units > 0 && fill / units > 0.15) { coh -= 15; notes.push('filler'); }
  coh = clamp(coh);
  const fluency2 = flu == null ? null : Math.round(clamp(0.6 * flu + 0.4 * coh));
  const coherence = fluency2 == null ? Math.round(coh) : fluency2;

  // Tổng hợp: có căn cứ ý → 45% đủ ý + 30% rõ ràng + 25% mạch lạc; không có → 55% rõ ràng + 45% mạch lạc
  const parts = [];
  if (content != null) parts.push([content, 0.45]);
  if (clarity != null) parts.push([clarity, content != null ? 0.30 : 0.55]);
  parts.push([coherence, content != null ? 0.25 : 0.45]);
  const wsum = parts.reduce((a, [, w]) => a + w, 0);
  const overall = Math.round(parts.reduce((a, [v, w]) => a + v * w, 0) / wsum);
  return { clarity, content, coherence, overall, level: overall >= 80 ? 'good' : overall >= 55 ? 'fair' : 'poor', notes: [...new Set(notes)], units };
}
