/**
 * csdl-lessons.js — mục "Học Thuật": bài nghe dựng TỰ ĐỘNG từ chính kho CSDL thuật ngữ của Chimedis.
 *
 * Nguyên tắc: nội dung y khoa KHÔNG do AI viết lại. Mỗi bài được lắp từ các trường dữ liệu đã có (Hán/Việt/Anh song song,
 * đã được biên soạn/thẩm định trong CSDL) bằng khuôn câu cố định → không bịa, bản dịch nhất quán với từ điển. Chỉ phần
 * GIỌNG ĐỌC là sinh theo yêu cầu (Google TTS) và lưu đệm vào MySQL, nên 5.700+ mục đều nghe được mà không phình kho git.
 *
 *  - "Hôm nay": mỗi lĩnh vực 1 bài, chọn tất định theo ngày (hoán vị cố định theo lĩnh vực → quay vòng hết kho rồi mới lặp).
 *  - Người dùng Pro: duyệt mọi lĩnh vực/tiểu lĩnh vực, tìm theo từ khoá, nghe bất kỳ mục nào.
 */
import crypto from 'node:crypto';
import { pinyin } from 'pinyin';

export const CATEGORY = 'csdl';

// Lĩnh vực = group1 của CSDL. "Từ ghép Y Khoa" (gốc từ Hy-La) không có câu tiếng Trung để nghe nên không đưa vào.
export const FIELDS = [
  { key: 'Dược liệu', vi: 'Dược liệu', zh: '中药', en: 'Herbs' },
  { key: 'Huyệt vị', vi: 'Huyệt vị', zh: '腧穴', en: 'Acupoints' },
  { key: 'Bệnh lý', vi: 'Bệnh lý', zh: '病证', en: 'Disorders' },
  { key: 'Tổng hợp', vi: 'Tổng hợp (chẩn đoán)', zh: '综合（诊断）', en: 'General (diagnosis)' },
  { key: 'Giải phẫu', vi: 'Giải phẫu', zh: '解剖', en: 'Anatomy' },
  { key: 'Sinh lý', vi: 'Sinh lý', zh: '生理', en: 'Physiology' },
];

const ID_PREFIX = 'db-';
const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const stripEnd = (s) => clean(s).replace(/\s+([.,;:。，；：])/g, '$1').replace(/[。．.；;，,、\s]+$/u, '');
const NOT_INFORMATIVE = /(来源未记载|Nguồn không ghi nhận|source does not document)/i;

// "第一节 发散风寒药" → "发散风寒药"
const zhGroup = (s) => clean(s).replace(/^第[一二三四五六七八九十百]+[节章]\s*/u, '');
// Bỏ chỉ dẫn hình "(图9-2-5)" / "(Figure 9-2-5)" — người nghe không nhìn thấy hình.
const noFig = (s) => clean(s).replace(/[（(]\s*图[^）)]*[）)]/gu, '').replace(/\(\s*Figure[^)]*\)/gi, '').replace(/\s+([。，；])/g, '$1');
const lc = (s) => { const t = clean(s); return t ? t.charAt(0).toLowerCase() + t.slice(1) : ''; };

/** Tách "①…②…" thành mảng; trả null nếu không có ký hiệu. */
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩';
function splitCircled(s) {
  const t = clean(s);
  if (!/[①-⑩]/.test(t)) return null;
  const parts = t.split(/[①-⑩]/).map((x) => stripEnd(x)).filter(Boolean);
  return parts.length ? parts : null;
}

/** Một câu 3 ngôn ngữ; null nếu thiếu bất kỳ ngôn ngữ nào (không bao giờ để trống/lẫn ngôn ngữ). */
function seg(zh, vi, en) {
  const tidy = (x) => clean(x).replace(/\s+([.,;:。，；：])/g, '$1');
  zh = tidy(zh); vi = tidy(vi); en = tidy(en);
  if (!zh || !vi || !en) return null;
  return { zh, vi, en };
}
/** Câu quá dài (> ~90 chữ Hán) được tách ở dấu ';' nếu cả 3 ngôn ngữ tách ra cùng số phần — để mỗi đoạn nghe vừa phải. */
function splitLong(s) {
  if (s.zh.length <= 90) return [s];
  const cut = (x) => x.split(/(?<=[；;])\s*/u).filter(Boolean);
  const z = cut(s.zh), v = cut(s.vi), e = cut(s.en);
  if (z.length < 2 || z.length !== v.length || v.length !== e.length) return [s];
  const out = [];
  let cur = null;
  z.forEach((part, i) => {
    if (cur && cur.zh.length + part.length <= 80) { cur.zh += part; cur.vi += ' ' + v[i]; cur.en += ' ' + e[i]; }
    else { cur = { zh: part, vi: v[i], en: e[i] }; out.push(cur); }
  });
  return out;
}
const addSeg = (arr, zh, vi, en) => { const s = seg(zh, vi, en); if (s) arr.push(...splitLong(s)); };

function buildSegments(t) {
  const out = [];
  const g = t.group1;
  const grp = { zh: zhGroup(t.group2), vi: clean(t.group2_vi), en: clean(t.group2_en) };

  if (g === 'Dược liệu') {
    addSeg(out, `${t.hz}，属${grp.zh}。`, `${t.vi}, thuộc nhóm ${lc(grp.vi)}.`, `${t.en}. Group: ${grp.en}.`);
    if (t.temperature_zh || t.taste_zh || t.meridian_zh) {
      const zh = [t.temperature_zh && `性${stripEnd(t.temperature_zh)}`, t.taste_zh && `味${stripEnd(t.taste_zh)}`, t.meridian_zh && `归${stripEnd(t.meridian_zh)}经`].filter(Boolean).join('，') + '。';
      const low = (x) => stripEnd(x).toLowerCase();
      const vi = [t.temperature_vi && `tính ${low(t.temperature_vi)}`, t.taste_vi && `vị ${low(t.taste_vi)}`, t.meridian_vi && `quy kinh ${stripEnd(t.meridian_vi)}`].filter(Boolean).join(', ');
      const en = [t.temperature_en && `nature: ${low(t.temperature_en)}`, t.taste_en && `flavor: ${low(t.taste_en)}`, t.meridian_en && `channels: ${stripEnd(t.meridian_en)}`].filter(Boolean).join('; ');
      addSeg(out, zh, `${vi.charAt(0).toUpperCase()}${vi.slice(1)}.`, `${en.charAt(0).toUpperCase()}${en.slice(1)}.`);
    }
    addSeg(out, t.action_zh && `功效：${stripEnd(t.action_zh)}。`, t.action_vi && `Công năng: ${stripEnd(t.action_vi)}.`, t.action_en && `Actions: ${stripEnd(t.action_en)}.`);
    addSeg(out, t.indication_zh && `主治：${stripEnd(t.indication_zh)}。`, t.indication_vi && `Chủ trị: ${stripEnd(t.indication_vi)}.`, t.indication_en && `Indications: ${stripEnd(t.indication_en)}.`);
    if (t.dose_text_zh || (t.dose_min_g && t.dose_max_g)) {
      const range = t.dose_min_g && t.dose_max_g ? { min: Number(t.dose_min_g), max: Number(t.dose_max_g) } : null;
      const r = (n) => (Number.isInteger(n) ? String(n) : String(n));
      // Chỉ thêm khoảng liều khi phần chữ chưa nêu số liều (tránh đọc trùng "15～30g ... 15至30克").
      const hasNum = /\d/.test(t.dose_text_zh || '');
      const showRange = range && !hasNum;
      const zh = [t.dose_text_zh && stripEnd(t.dose_text_zh), showRange && `一般用量${r(range.min)}至${r(range.max)}克`].filter(Boolean).join('；') + '。';
      const vi = [t.dose_text_vi && stripEnd(t.dose_text_vi), showRange && `liều thường dùng ${r(range.min)}–${r(range.max)} g`].filter(Boolean).join('; ');
      const en = [t.dose_text_en && stripEnd(t.dose_text_en), showRange && `usual dose ${r(range.min)}–${r(range.max)} g`].filter(Boolean).join('; ');
      addSeg(out, `用法用量：${zh}`, `Cách dùng, liều lượng: ${vi}.`, `Use and dose: ${en}.`);
    }
    if (t.caution_zh && !NOT_INFORMATIVE.test(t.caution_zh)) {
      addSeg(out, `使用注意：${stripEnd(t.caution_zh)}。`, `Lưu ý sử dụng: ${stripEnd(t.caution_vi)}.`, `Precautions: ${stripEnd(t.caution_en)}.`);
    }
    return out;
  }

  if (g === 'Huyệt vị') {
    addSeg(out, `${t.hz}，属${grp.zh}的腧穴。`, `${t.vi} (${t.en}), huyệt thuộc ${lc(grp.vi)}.`, `${t.en} is a point of the ${grp.en}.`);
    addSeg(out, t.location_zh && `定位：${noFig(t.location_zh)}`, t.location_vi && `Vị trí: ${noFig(t.location_vi)}`, t.location_en && `Location: ${noFig(t.location_en)}`);
    addSeg(out, t.indication_zh && `主治：${stripEnd(t.indication_zh)}。`, t.indication_vi && `Chủ trị: ${stripEnd(t.indication_vi)}.`, t.indication_en && `Indications: ${stripEnd(t.indication_en)}.`);
    addSeg(out, t.action_zh && `功效：${stripEnd(t.action_zh)}。`, t.action_vi && `Công năng: ${stripEnd(t.action_vi)}.`, t.action_en && `Actions: ${stripEnd(t.action_en)}.`);
    addSeg(out, t.special_class_zh && `特定穴类别：${stripEnd(t.special_class_zh)}。`, t.special_class_vi && `Nhóm huyệt đặc biệt: ${stripEnd(t.special_class_vi)}.`, t.special_class_en && `Special category: ${stripEnd(t.special_class_en)}.`);
    addSeg(out, t.caution_zh && `注意：${stripEnd(t.caution_zh)}。`, t.caution_vi && `Lưu ý: ${stripEnd(t.caution_vi)}.`, t.caution_en && `Caution: ${stripEnd(t.caution_en)}.`);
    return out;
  }

  // Bệnh lý / Tổng hợp / Giải phẫu / Sinh lý: bộ trường vitri · congnang · tcm · lamsang (zh ở *_cn)
  const labels = g === 'Bệnh lý'
    ? { c: ['病因病机', 'Bệnh nhân bệnh cơ', 'Etiology and pathogenesis'], t: ['辨证分型', 'Phân thể biện chứng', 'Pattern differentiation'], l: ['临床', 'Lâm sàng', 'Clinical'] }
    : { c: ['功能', 'Chức năng', 'Function'], t: ['中医', 'Y học cổ truyền', 'TCM'], l: ['临床', 'Lâm sàng', 'Clinical'] };
  addSeg(out, `${t.hz}，${grp.zh}。`, `${t.vi} (${t.en}) — ${lc(grp.vi)}.`, `${t.en} — ${lc(grp.en)}.`);
  addSeg(out, t.vitri_cn && stripEnd(t.vitri_cn) + '。', t.vitri && stripEnd(t.vitri) + '.', t.vitri_en && stripEnd(t.vitri_en) + '.');
  addSeg(out, t.congnang_cn && `${labels.c[0]}：${stripEnd(t.congnang_cn)}。`, t.congnang && `${labels.c[1]}: ${stripEnd(t.congnang)}.`, t.congnang_en && `${labels.c[2]}: ${stripEnd(t.congnang_en)}.`);
  // Phân thể (①…⑨): mỗi thể một câu, chỉ khi số thể khớp giữa 3 ngôn ngữ.
  const tz = splitCircled(t.tcm_cn), tv = splitCircled(t.tcm), te = splitCircled(t.tcm_en);
  if (tz && tv && te && tz.length === tv.length && tv.length === te.length) {
    tz.slice(0, 6).forEach((z, i) => addSeg(out, `${labels.t[0]}：${z.replace(/·/g, '，')}。`, `${labels.t[1]}: ${tv[i].replace(/\s*—\s*/g, ', ')}.`, `${labels.t[2]}: ${te[i]}.`));
  } else if (t.tcm_cn && t.tcm && t.tcm_en && !/[①-⑩]/.test(t.tcm_cn)) {
    addSeg(out, `${labels.t[0]}：${stripEnd(t.tcm_cn)}。`, `${labels.t[1]}: ${stripEnd(t.tcm)}.`, `${labels.t[2]}: ${stripEnd(t.tcm_en)}.`);
  }
  addSeg(out, t.lamsang_cn && `${labels.l[0]}：${stripEnd(t.lamsang_cn)}。`, t.lamsang && `${labels.l[1]}: ${stripEnd(t.lamsang)}.`, t.lamsang_en && `${labels.l[2]}: ${stripEnd(t.lamsang_en)}.`);
  return out;
}

function pinyinLine(zh) {
  try { return pinyin(zh, { style: 'tone' }).map((a) => a[0]).join(' '); } catch (_) { return ''; }
}

/** Mức độ theo độ dài câu trung bình (ký tự Hán). */
function levelOf(segs) {
  const avg = segs.reduce((n, s) => n + s.zh.length, 0) / Math.max(1, segs.length);
  return avg < 20 ? 'so_cap' : avg < 38 ? 'trung_cap' : 'cao_cap';
}

const fieldOf = (key) => FIELDS.find((f) => f.key === key);

/** Bài đầy đủ (dạng tương thích màn hình nghe). null nếu mục quá nghèo dữ liệu (< 2 câu). */
export function buildLesson(t, dayIso = null) {
  if (!t || !fieldOf(t.group1)) return null;
  const segs = buildSegments(t);
  if (segs.length < 2) return null;
  const f = fieldOf(t.group1);
  const verified = t.verify === true;
  const note = {
    vi: `Cơ sở dữ liệu Chimedis (${f.vi}) — lắp tự động từ dữ liệu có sẵn, không do AI viết lại. ${verified ? 'Mục đã thẩm định.' : 'Mục đang chờ thẩm định lần cuối — dùng để học ngôn ngữ, không thay thế tư vấn chuyên môn.'}`,
    zh: `Chimedis 数据库（${f.zh}）——由现有数据自动组合，非 AI 改写。${verified ? '本条已审核。' : '本条仍待最终审核——仅供语言学习，不能替代专业意见。'}`,
    en: `Chimedis database (${f.en}) — assembled automatically from existing data, not rewritten by AI. ${verified ? 'Entry reviewed.' : 'Entry awaiting final review — for language learning, not a substitute for professional advice.'}`,
  };
  const iso = dayIso || '2026-01-01T00:00:00.000Z';
  return {
    id: ID_PREFIX + t.id,
    category: CATEGORY,
    level: levelOf(segs),
    field: t.group1,
    group2: t.group2,
    title_vi: `${f.vi}: ${t.vi}`, title_zh: `${f.zh}：${t.hz}`, title_en: `${f.en}: ${t.en}`,
    source_note_vi: note.vi, source_note_zh: note.zh, source_note_en: note.en,
    created_at: iso, updated_at: iso,
    segments: segs.map((s, i) => ({ seq: i + 1, text_zh: s.zh, text_pinyin: pinyinLine(s.zh), text_vi: s.vi, text_en: s.en })),
  };
}

// ===== Chỉ mục trong bộ nhớ =====
let index = null; // { byId: Map, byField: Map(group1 → [terms]), eligible: Map(group1 → [terms]) }
export function buildIndex(terms) {
  const byId = new Map();
  const byField = new Map(FIELDS.map((f) => [f.key, []]));
  const segCount = new Map();
  for (const t of terms) {
    if (!t || !t.id || !byField.has(t.group1)) continue;
    const lesson = buildLesson(t);
    if (!lesson) continue; // loại mục quá nghèo dữ liệu
    byId.set(t.id, t);
    segCount.set(t.id, lesson.segments.length);
    byField.get(t.group1).push(t);
  }
  for (const arr of byField.values()) arr.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  index = { byId, byField, segCount, builtAt: Date.now() };
  return index;
}
export const hasIndex = () => !!index;
/** Mọi mục trong chỉ mục (cho bảng thuật ngữ dùng chung khi AI dịch). */
export const allTerms = () => (index ? [...index.byId.values()] : []);

export function stats() {
  if (!index) return null;
  return FIELDS.map((f) => {
    const items = index.byField.get(f.key) || [];
    const g2 = new Map();
    for (const t of items) {
      const k = t.group2 || '';
      const e = g2.get(k) || { key: k, vi: t.group2_vi || k, zh: zhGroup(k), en: t.group2_en || k, count: 0 };
      e.count++; g2.set(k, e);
    }
    return { ...f, count: items.length, groups: [...g2.values()].sort((a, b) => b.count - a.count) };
  });
}

// Hoán vị cố định theo lĩnh vực (seed = tên lĩnh vực): quay vòng hết kho rồi mới lặp, mọi người cùng thấy cùng một bài trong ngày.
function seededOrder(n, seedStr) {
  let h = crypto.createHash('sha256').update(seedStr).digest().readUInt32LE(0) || 1;
  const rnd = () => { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const orderCache = new Map();
/** Số ngày kể từ mốc cố định theo múi giờ Việt Nam (UTC+7). */
export function dayNumber(now = Date.now()) { return Math.floor((now + 7 * 3600e3) / 86400e3); }
export function dayIso(now = Date.now()) { return new Date(dayNumber(now) * 86400e3 - 7 * 3600e3).toISOString(); }

export function dailyPicks(now = Date.now(), perField = 1) {
  if (!index) return [];
  const day = dayNumber(now);
  const out = [];
  for (const f of FIELDS) {
    const all = index.byField.get(f.key) || [];
    // Ưu tiên mục giàu dữ liệu (≥ 3 câu) làm bài trong ngày; lĩnh vực nào ít mục giàu thì dùng tất cả.
    const rich = all.filter((t) => (index.segCount.get(t.id) || 0) >= 3);
    const items = rich.length >= 30 ? rich : all;
    if (!items.length) continue;
    const ck = `${f.key}:${items.length}`;
    if (!orderCache.has(ck)) orderCache.set(ck, seededOrder(items.length, f.key));
    const order = orderCache.get(ck);
    for (let k = 0; k < perField; k++) out.push(items[order[(day * perField + k) % items.length]]);
  }
  return out;
}
export function dailyIds(now = Date.now()) { return new Set(dailyPicks(now).map((t) => ID_PREFIX + t.id)); }

export function meta(t, now = Date.now()) {
  const l = buildLesson(t, dayIso(now));
  return {
    id: l.id, category: CATEGORY, level: l.level, field: l.field, group2: l.group2,
    title_vi: l.title_vi, title_zh: l.title_zh, title_en: l.title_en,
    created_at: l.created_at, updated_at: l.updated_at, seqs: l.segments.map((s) => s.seq),
  };
}

export function lessonById(id, now = Date.now()) {
  if (!index || !String(id).startsWith(ID_PREFIX)) return null;
  const t = index.byId.get(String(id).slice(ID_PREFIX.length));
  return t ? buildLesson(t, dayIso(now)) : null;
}

/** Duyệt/tìm trong một lĩnh vực (Pro). Trả { total, items }. */
export function browse({ field, group2, q, offset = 0, limit = 30 }) {
  if (!index) return { total: 0, items: [] };
  let items = field && index.byField.has(field) ? index.byField.get(field) : [...index.byField.values()].flat();
  if (group2) items = items.filter((t) => t.group2 === group2);
  const needle = clean(q).toLowerCase();
  if (needle) {
    items = items.filter((t) => [t.hz, t.py, t.vi, t.en].some((v) => v && String(v).toLowerCase().includes(needle)));
  }
  const total = items.length;
  const page = items.slice(Math.max(0, offset), Math.max(0, offset) + Math.min(100, Math.max(1, limit)));
  return {
    total,
    items: page.map((t) => ({ id: ID_PREFIX + t.id, field: t.group1, group2: t.group2, hz: t.hz, py: t.py, vi: t.vi, en: t.en })),
  };
}

export const segmentText = (lesson, seq) => {
  const s = lesson && lesson.segments.find((x) => x.seq === Number(seq));
  return s ? s.text_zh : null;
};

// ===== Tìm kiếm nhẹ để nối đất cho trợ lý (Lão Sư): trả các mục liên quan nhất tới câu hỏi =====
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
const HAN = /[一-鿿]/;
// Từ đệm tiếng Việt (đã bỏ dấu) — không dùng để tìm mục.
const STOP = new Set('nao dau vay thay qua nam gia khong duoc nhung cac nhu nay the sao cua cho hay roi con vua dang chua minh em thi la va hoc gioi biet noi hoi'.split(' '));
/** Mục theo id (không có tiền tố db-). */
export const termById = (id) => (index ? index.byId.get(String(id)) || null : null);

export function searchTerms(query, k = 3, group = null) {
  if (!index) return [];
  const q = clean(query);
  if (q.length < 2) return [];
  const han = [...q].filter((c) => HAN.test(c)).join('');
  const bigrams = new Set();
  for (let i = 0; i + 1 < han.length; i++) bigrams.add(han.slice(i, i + 2));
  const words = fold(q).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w));
  const scored = [];
  for (const t of index.byId.values()) {
    if (group && t.group1 !== group) continue;
    let sc = 0;
    if (han && t.hz && han.includes(t.hz)) sc += 8;       // tên mục xuất hiện nguyên vẹn trong câu hỏi
    if (t.hz) for (const b of bigrams) if (t.hz.includes(b)) sc += 2;
    const vi = fold(t.vi), en = fold(t.en);
    for (const w of words) { if (vi === w || en === w) sc += 6; else if (vi.includes(w)) sc += 2; else if (en.includes(w)) sc += 1; }
    if (vi && vi.length >= 4 && ` ${fold(q).replace(/[^a-z0-9]+/g, ' ')} `.includes(` ${vi.replace(/[^a-z0-9]+/g, ' ')} `)) sc += 7; // nguyên cụm (theo ranh giới từ) nằm trong câu hỏi
    if (sc > 0) scored.push([sc, t]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  if (!scored.length) return [];
  // Chỉ giữ mục khớp đủ mạnh và không quá xa mục tốt nhất — tránh đưa nhiễu làm mô hình lạc đề.
  const floor = Math.max(4, scored[0][0] * 0.5);
  return scored.filter((x) => x[0] >= floor).slice(0, k).map((x) => x[1]);
}
/** Tóm tắt dữ kiện của một mục (từ chính bài dựng) để đưa vào ngữ cảnh. */
export function factsFor(t, maxSegs = 5) {
  const l = buildLesson(t);
  if (!l) return '';
  return `[${t.group1}] ${t.hz} (${t.py || ''}) — ${t.vi} / ${t.en}\n` + l.segments.slice(0, maxSegs).map((s) => `- ${s.text_zh} | ${s.text_vi}`).join('\n');
}
export function randomOf(group1, n, excludeId, seed = Date.now()) {
  if (!index) return [];
  const arr = (index.byField.get(group1) || []).filter((t) => t.id !== excludeId);
  const out = [];
  let h = seed >>> 0 || 1;
  for (let i = 0; i < n && arr.length; i++) { h = (h * 1664525 + 1013904223) >>> 0; out.push(arr.splice(h % arr.length, 1)[0]); }
  return out;
}

/** Mục ngẫu nhiên (ưu tiên mục giàu dữ liệu) của một lĩnh vực; field rỗng/không hợp lệ → chọn ngẫu nhiên giữa các lĩnh vực. */
export function randomTopic(field, seed = Date.now()) {
  if (!index) return null;
  let h = (seed >>> 0) || 1;
  const next = () => (h = (h * 1664525 + 1013904223) >>> 0);
  next(); next();
  const keys = field && index.byField.has(field) ? [field] : FIELDS.map((f) => f.key).filter((k) => (index.byField.get(k) || []).length);
  if (!keys.length) return null;
  const all = index.byField.get(keys[next() % keys.length]) || [];
  const rich = all.filter((t) => (index.segCount.get(t.id) || 0) >= 3);
  const items = rich.length >= 30 ? rich : all;
  return items.length ? items[next() % items.length] : null;
}

// ===== Đồng âm (nhận dạng giọng nói hay nhầm: 穴位 ↔ 学位…) =====
const HAN_ONLY = /^[㐀-鿿]+$/;
let homoMap = null, homoTerms = null, homoBuiltFrom = null;
const pyKey = (s) => { try { return pinyin(s, { style: 'tone2' }).map((a) => a[0]).join('|'); } catch (_) { return ''; } };
function buildHomo(extra) {
  if (homoMap && homoBuiltFrom === index) return;
  homoMap = new Map(); homoTerms = new Set(); homoBuiltFrom = index;
  const add = (hz, vi) => {
    if (!hz || hz.length < 2 || hz.length > 4 || !HAN_ONLY.test(hz)) return;
    homoTerms.add(hz);
    const k = pyKey(hz); if (!k) return;
    const arr = homoMap.get(k) || [];
    if (arr.length < 3 && !arr.some((x) => x.hz === hz)) arr.push({ hz, vi: vi || '' });
    homoMap.set(k, arr);
  };
  for (const [hz, vi] of extra || []) add(hz, vi);
  if (index) for (const t of index.byId.values()) add(t.hz, t.vi);
}
/** Với mỗi cụm 2–4 chữ Hán trong câu mà KHÔNG phải thuật ngữ trong kho nhưng cùng pinyin+thanh với một thuật ngữ → gợi ý (tối đa 4). */
export function homophoneHints(text, extra = []) {
  const han = String(text || '').match(/[㐀-鿿]+/g) || [];
  if (!han.length) return [];
  buildHomo(extra);
  const out = [];
  for (const run of han) {
    const used = new Array(run.length).fill(false);
    for (let n = 4; n >= 2; n--) {
      for (let i = 0; i + n <= run.length; i++) {
        if (used.slice(i, i + n).some(Boolean)) continue;
        const g = run.slice(i, i + n);
        if (homoTerms.has(g)) { for (let k = i; k < i + n; k++) used[k] = true; continue; }
        const cands = (homoMap.get(pyKey(g)) || []).filter((c) => c.hz !== g);
        if (cands.length) { out.push({ heard: g, maybe: cands.map((c) => (c.vi ? `${c.hz} (${c.vi})` : c.hz)) }); for (let k = i; k < i + n; k++) used[k] = true; }
      }
    }
  }
  const seen = new Set();
  return out.filter((h) => (seen.has(h.heard) ? false : (seen.add(h.heard), true))).slice(0, 4);
}
/** Có phải thuật ngữ đã biết (trong kho CSDL hoặc danh sách cốt lõi `extra`)? */
export function isKnownTerm(hz, extra = []) { buildHomo(extra); return homoTerms.has(hz); }
