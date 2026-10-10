/**
 * interpret-check.js — chấm bài dịch/dịch nói theo từng "đơn vị ý" (key_units) bằng đối chiếu xác định,
 * KHÔNG dùng AI để quyết định đúng/sai (chỉ dùng AI phiên âm giọng nói ở nơi gọi).
 *
 * Mỗi đơn vị ý: { id, zh, type, accept_vi|all_vi, accept_en, pref_vi, pref_en, bank_id?, in_bank }
 *  - accept_*: danh sách cách dịch chấp nhận được (khớp 1 trong số đó là "ok").
 *  - all_vi: nhiều nhóm; khớp đủ mọi nhóm = "ok", khớp một phần = "partial".
 * Kết quả chỉ gồm MÃ trạng thái — câu chữ hiển thị do giao diện lấy từ bảng I18N (vi/zh/en),
 * nên ngôn ngữ nhận xét luôn đúng ngôn ngữ giao diện, không phụ thuộc mô hình.
 */

export function normalize(s) {
  return String(s || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[“”"'‘’`´]/g, '')
    .replace(/(\d)[.,](\d)/g, '$1<dec>$2') // giữ dấu thập phân 37,5 / 37.5
    .replace(/[^\p{L}\p{N}<>/%]+/gu, ' ')
    .replace(/<dec>/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripAccents(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function buildHaystacks(transcript) {
  const n = ' ' + normalize(transcript) + ' ';
  const na = ' ' + stripAccents(n) + ' ';
  return { n, na, n_dotfree: n.replace(/,/g, '.'), };
}

// Bản dịch số thập phân: "37,5" khớp cả "37.5".
function phraseVariants(p) {
  const base = normalize(p);
  const out = new Set([base, base.replace(/,/g, '.')]);
  return [...out];
}

function hasPhrase(hay, phrase, lang) {
  const variants = phraseVariants(phrase);
  for (const v of variants) {
    if (!v) continue;
    // Tiếng Việt: khớp nguyên từ (tránh "cảm" khớp "cảm thấy"). Tiếng Anh: cho phép gốc từ (convuls → convulsions).
    const needle = lang === 'en' ? ' ' + v : ' ' + v + ' ';
    if (hay.n.includes(needle) || hay.n_dotfree.includes(needle)) return 'exact';
    const needleA = lang === 'en' ? ' ' + stripAccents(v) : ' ' + stripAccents(v) + ' ';
    if (hay.na.includes(needleA)) return 'accent';
  }
  return null;
}

function checkUnit(unit, hay, lang) {
  const key = lang === 'en' ? 'accept_en' : 'accept_vi';
  const groups = lang === 'vi' && Array.isArray(unit.all_vi) ? unit.all_vi : null;
  if (groups) {
    let matched = 0;
    let accentOnly = false;
    for (const g of groups) {
      let hit = null;
      for (const p of g) {
        const r = hasPhrase(hay, p, lang);
        if (r) { hit = r; break; }
      }
      if (hit) { matched++; if (hit === 'accent') accentOnly = true; }
    }
    if (matched === groups.length) return { status: 'ok', accent: accentOnly };
    if (matched > 0) return { status: 'partial' };
    return { status: 'missed' };
  }
  const list = unit[key] || [];
  for (const p of list) {
    const r = hasPhrase(hay, p, lang);
    if (r) return { status: 'ok', accent: r === 'accent' };
  }
  return { status: 'missed' };
}

export function checkUnits(units, transcript, lang) {
  const L = lang === 'en' ? 'en' : 'vi';
  const hay = buildHaystacks(transcript);
  return (units || []).map((u) => {
    const r = checkUnit(u, hay, L);
    return {
      id: u.id, zh: u.zh, type: u.type || 'term', status: r.status, accent_only: !!r.accent,
      pref: L === 'en' ? u.pref_en : u.pref_vi,
      bank_id: u.bank_id || null, in_bank: !!u.in_bank,
    };
  });
}

/** Ngôn ngữ đích có đúng không? Kiểm tra bằng ký tự, không cần AI. */
export function checkTargetLanguage(transcript, lang) {
  const t = String(transcript || '');
  const letters = (t.match(/\p{L}/gu) || []).length;
  if (!letters) return { ok: false, reason: 'empty' };
  const han = (t.match(/\p{Script=Han}/gu) || []).length;
  if (han / letters > 0.2) return { ok: false, reason: 'han' };
  if (lang === 'vi') {
    const viDiacritics = (t.match(/[ăâđêôơưàáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/gi) || []).length;
    const words = t.split(/\s+/).filter(Boolean).length;
    const en = (t.toLowerCase().match(/\b(the|and|was|with|of|is|were|her|she|his|had|that|for)\b/g) || []).length;
    if (words >= 6 && viDiacritics === 0 && en >= 2) return { ok: false, reason: 'english' };
  }
  return { ok: true };
}

const SLOW_SPS = 1.8;   // âm tiết/giây (tiếng Việt)
const FAST_SPS = 5.6;
const LONG_PAUSE_MS = 2500;

export function fluencyReport(stats, transcript, lang) {
  if (!stats || !(stats.speech_ms > 0)) return null;
  const words = String(transcript || '').trim().split(/\s+/).filter(Boolean).length;
  const speechSec = stats.speech_ms / 1000;
  const flags = [];
  const rate = words / speechSec;
  if (lang === 'vi') {
    if (words >= 4 && rate < SLOW_SPS) flags.push('slow');
    if (words >= 4 && rate > FAST_SPS) flags.push('fast');
  }
  if ((stats.pause_count || 0) >= 3 || (stats.longest_pause_ms || 0) >= LONG_PAUSE_MS) flags.push('pauses');
  return {
    rate_wps: Math.round(rate * 10) / 10,
    speech_s: Math.round(speechSec * 10) / 10,
    pause_count: stats.pause_count || 0,
    longest_pause_s: Math.round(((stats.longest_pause_ms || 0) / 1000) * 10) / 10,
    flags,
  };
}

export function buildVocabHint(units, lang) {
  const key = lang === 'en' ? 'pref_en' : 'pref_vi';
  return (units || []).map((u) => u[key]).filter(Boolean).join('; ');
}

export function analyzeInterpretation({ units, transcript, lang, fluencyStats }) {
  const L = lang === 'en' ? 'en' : 'vi';
  const langCheck = checkTargetLanguage(transcript, L);
  const results = checkUnits(units, transcript, L);
  const counts = { ok: 0, partial: 0, missed: 0 };
  for (const r of results) counts[r.status]++;
  return {
    transcript,
    lang_ok: langCheck.ok,
    lang_reason: langCheck.ok ? null : langCheck.reason,
    units: results,
    counts,
    total: results.length,
    fluency: fluencyReport(fluencyStats, transcript, L),
  };
}
