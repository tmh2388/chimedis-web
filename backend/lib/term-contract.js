/**
 * term-contract.js — "HỢP ĐỒNG THUẬT NGỮ": mọi đường tạo/ghi thuật ngữ (AI tự học, tra cứu AI, admin thêm, rà soát) đi qua đây để bảo đảm
 *   - đúng NGÔN NGỮ của từng ô (ô Việt không chứa tiếng Trung, ô Trung phải có chữ Hán, ô Anh không có tiếng Việt/pinyin trong tên);
 *   - ĐỦ cả ba ngôn ngữ cho tên (Việt/Anh) và các cặp nội dung (định nghĩa, nghĩa thông thường, liên hệ Trung y).
 * Cách làm: (1) xếp lại nội dung đặt nhầm ô theo ngôn ngữ nhận ra được (không tốn AI); (2) làm sạch tên Anh (bỏ pinyin trong ngoặc);
 * (3) chỉ phần còn thiếu mới nhờ AI dịch MỘT lần, rồi kiểm tra lại; ô vẫn sai thì BỎ (để trống) — không bao giờ ghi nội dung sai ngôn ngữ vào kho.
 */

const HAN_G = /[㐀-鿿]/g;
const VI_DIAC = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;
const TONE_MARK = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/i;
const EN_WORDS = /\b(the|and|of|is|are|with|in|to|for|by|that|which|from|or|as|an)\b/gi;
export const LANGS3 = ['vi', 'zh', 'en'];

const hanCount = (s) => (String(s).match(HAN_G) || []).length;
const letterCount = (s) => String(s).replace(/[\s\d\p{P}\p{S}]/gu, '').length;
export const hanRatio = (s) => { const n = letterCount(s); return n ? hanCount(s) / n : 0; };

/** Ngôn ngữ nhận ra được của một đoạn chữ; `hint` = ngôn ngữ của ô (dùng khi chữ quá ngắn/không phân biệt được). */
export function detectLang(text, hint = 'vi') {
  const t = String(text == null ? '' : text).trim();
  if (!t) return hint;
  if (hanRatio(t) >= 0.4) return 'zh';
  if (VI_DIAC.test(t)) return 'vi';
  if ((t.match(EN_WORDS) || []).length >= 2) return 'en';
  return hint;
}
/** Chữ `text` có hợp ô ngôn ngữ `lang` không. */
export function langOk(lang, text) {
  const t = String(text == null ? '' : text).trim();
  if (!t || !letterCount(t)) return false;
  if (lang === 'zh') return hanRatio(t) >= 0.4;
  if (lang === 'en') return hanCount(t) === 0 && !VI_DIAC.test(t) && /[a-z]/i.test(t);
  return hanRatio(t) < 0.4 && !((t.match(EN_WORDS) || []).length >= 2 && !VI_DIAC.test(t)); // vi
}
/** Bỏ phần pinyin/chữ Hán trong ngoặc ở tên Anh: "Blood stasis (yūxuè)" → "Blood stasis". */
export function cleanEnName(en) {
  let s = String(en == null ? '' : en).trim();
  s = s.replace(/\s*[(（\[]([^)）\]]*)[)）\]]/g, (m, inner) => (TONE_MARK.test(inner) || hanCount(inner) ? '' : m));
  s = s.replace(HAN_G, '').replace(/\s{2,}/g, ' ').replace(/\s+([,;:])/g, '$1').trim();
  return s;
}
const clean = (v, n = 800) => String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Chuẩn hoá một bản ghi theo hợp đồng.
 * @param rec   đối tượng phẳng, vd { hz, vi, en, def_vi, def_zh, def_en, meaning_vi, ... }
 * @param specs mảng { key, cols:{vi?,zh?,en?}, name?:bool } — mỗi spec là một bộ nội dung cùng nghĩa theo ngôn ngữ
 * @param opts  { hint:{hz}, translate (mặc định translateItems) }
 * @returns {{rec:object, filled:string[], dropped:string[], incomplete:string[], costUsd:number}}
 *   filled = cột do hệ thống điền/đặt lại; dropped = cột bỏ vì sai ngôn ngữ không cứu được; incomplete = cột vẫn trống sau khi sửa (trong khi spec có nội dung).
 */
export async function fixLangs(rec, specs, opts = {}) {
  const out = { ...rec }; const filled = [], dropped = [], incomplete = [];
  const jobs = []; const slotsBySpec = new Map();
  for (const sp of specs) {
    const slots = {}; const langs = Object.keys(sp.cols);
    for (const l of langs) {
      let v = clean(rec[sp.cols[l]], sp.name ? 190 : 800);
      if (!v) continue;
      if (sp.name && l === 'en') v = cleanEnName(v);
      if (sp.name && hanCount(v)) { dropped.push(sp.cols[l]); continue; } // chữ Hán nằm ở ô tên Việt/Anh: bỏ (chữ Hán có ô riêng)
      const real = detectLang(v, l);
      if (!langs.includes(real) || slots[real]) { dropped.push(sp.cols[l]); continue; } // ô sai ngôn ngữ mà spec không có chỗ/đã có bản tốt hơn
      if (sp.name && real !== l) { dropped.push(sp.cols[l]); continue; }
      if (!langOk(real, v)) { dropped.push(sp.cols[l]); continue; }
      slots[real] = v;
    }
    slotsBySpec.set(sp, slots);
    const have = langs.filter((l) => slots[l]); const missing = langs.filter((l) => !slots[l]);
    if (have.length && missing.length) {
      const source = ['vi', 'en', 'zh'].find((l) => slots[l]);
      jobs.push({ sp, item: { key: sp.key, source, text: { vi: slots.vi || '', zh: slots.zh || '', en: slots.en || '' }, targets: missing, ctx: sp.name ? clean(opts.hint && opts.hint.hz, 40) : clean(`${(opts.hint && opts.hint.hz) || ''} ${rec.vi || ''}`, 120) } });
    }
  }
  let costUsd = 0;
  if (jobs.length) {
    try {
      const translate = opts.translate || (await import('./term-ai-fill.js')).translateItems; // nạp muộn: kiểm thử không cần phụ thuộc
      const tr = await translate(jobs.map((j) => j.item), opts.hint || {});
      costUsd = (tr && tr.costUsd) || 0;
      for (const j of jobs) {
        const got = (tr && tr.items && tr.items[j.sp.key]) || {}; const slots = slotsBySpec.get(j.sp);
        for (const l of j.item.targets) {
          let v = clean(got[l], j.sp.name ? 190 : 800);
          if (j.sp.name && l === 'en') v = cleanEnName(v);
          if (v && langOk(l, v) && !(j.sp.name && hanCount(v))) slots[l] = v;
        }
      }
    } catch (e) { console.error('[term-contract] dịch:', e.message); }
  }
  for (const sp of specs) {
    const slots = slotsBySpec.get(sp); const any = Object.keys(slots).length;
    for (const l of Object.keys(sp.cols)) {
      const col = sp.cols[l]; const before = clean(rec[col], sp.name ? 190 : 800);
      out[col] = slots[l] || null;
      if (slots[l] && slots[l] !== before) filled.push(col);
      if (any && !slots[l]) incomplete.push(col);
    }
  }
  return { rec: out, filled, dropped, incomplete, costUsd };
}

/** Bộ spec chuẩn cho một thuật ngữ mới (tên + định nghĩa). */
export const TERM_SPECS = [
  { key: 'name', cols: { vi: 'vi', en: 'en' }, name: true },
  { key: 'def', cols: { vi: 'def_vi', zh: 'def_zh', en: 'def_en' } },
];
/** Bộ spec cho kết quả tra cứu AI (thêm nghĩa thông thường + liên hệ Trung y). */
export const LOOKUP_SPECS = [
  ...TERM_SPECS,
  { key: 'meaning', cols: { vi: 'meaning_vi', zh: 'meaning_zh', en: 'meaning_en' } },
  { key: 'tcm', cols: { vi: 'tcm_context', zh: 'tcm_context_zh', en: 'tcm_context_en' } },
];
