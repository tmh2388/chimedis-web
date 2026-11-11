/**
 * herb-gaps.js — vị thuốc xuất hiện trong thành phần các Thang phương nhưng KHÔNG nối được tới mục Dược liệu trong kho.
 *  - scan(): tách thành phần (zh làm chuẩn; vi/en ghép theo thứ tự), bỏ tên đã có / tên gọi khác (herb-aliases.json) / bài thuốc con / câu dặn dò.
 *  - verifyDraft(): bước KIỂM CHÉO thứ hai cho bản nháp AI của một vị thuốc (mô hình đối chiếu riêng + số liệu liều trong các bài của kho).
 * Không ghi gì vào kho; kết quả đưa vào hàng chờ của admin.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { costFromUsage } from './ai-budget.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
const MODEL = process.env.HERB_VERIFY_MODEL || 'gpt-5-mini';

export function loadAliases() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'data', 'herb-aliases.json'), 'utf8')).aliases || {}; } catch (_) { return {}; }
}
const split = (s) => String(s || '').split(/[；;]\s*/).map((x) => x.trim()).filter(Boolean);
const roleTail = /[（(]\s*(?:君|臣|佐|使|chief|deputy|assistant|envoy|quân|thần|tá|sứ)[^（）()]*[）)]\s*$/i;
const zhName = (x) => String(x).replace(roleTail, '').trim().split(/\s+/)[0].replace(/[（(].*$/, '');
const tail = (x) => { const m = String(x).replace(roleTail, '').match(/([0-9][0-9.,～〜~\-–]*\s*(?:g|克|枚|个|片|粒)?)\s*$/i); return m ? m[1].trim() : ''; };
const latinName = (x) => String(x).replace(roleTail, '').replace(/\s*[0-9][0-9.,～〜~\-–]*\s*(?:g|克|枚|个|片|粒)?\s*$/i, '').replace(/\s*\((?:source term|historical source term)[^)]*\)/i, '').trim();
const isNoise = (n) => !n || n.length > 6 || /[，。、倍减增者无临时若如]/.test(n) || /^[大中小]剂/.test(n);

/** @returns {Array<{name:string,count:number,vi:string,en:string,formulas:Array<{hz:string,vi:string,dose:string}>}>} */
export function scan(terms, aliases = loadAliases()) {
  const known = new Set();
  const herbHz = [];
  for (const t of terms) {
    if (t.hz) known.add(t.hz);
    if (t.hz_traditional) known.add(t.hz_traditional);
    if (t.category === 'herb' && t.hz) herbHz.push(t.hz);
  }
  const resolvable = (n) => known.has(n) || (aliases[n] && aliases[n].some((x) => known.has(x))) || herbHz.some((h) => h.startsWith(n) || n.startsWith(h));
  const acc = new Map();
  for (const f of terms) {
    if (f.category !== 'formula' || !f.composition_zh) continue;
    const z = split(f.composition_zh), v = split(f.composition_vi), e = split(f.composition_en);
    z.forEach((x, i) => {
      const n = zhName(x);
      if (isNoise(n) || resolvable(n)) return;
      let d = acc.get(n); if (!d) { d = { name: n, count: 0, vis: new Map(), ens: new Map(), formulas: [] }; acc.set(n, d); }
      d.count++;
      const dose = tail(x) || (v.length === z.length ? tail(v[i]) : '');
      if (d.formulas.length < 6) d.formulas.push({ hz: f.hz, vi: f.vi || '', dose });
      if (v.length === z.length) { const k = latinName(v[i]); if (k) d.vis.set(k, (d.vis.get(k) || 0) + 1); }
      if (e.length === z.length) { const k = latinName(e[i]); if (k) d.ens.set(k, (d.ens.get(k) || 0) + 1); }
    });
  }
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  return [...acc.values()].map((d) => ({ name: d.name, count: d.count, vi: top(d.vis), en: top(d.ens), formulas: d.formulas })).sort((a, b) => b.count - a.count);
}

let ctxCache = { at: 0, map: new Map() };
export function cacheScan(list) { ctxCache = { at: Date.now(), map: new Map(list.map((d) => [d.name, d])) }; }
export const contextFor = (hz) => ctxCache.map.get(hz) || null;

/** Kiểm chéo bản nháp vị thuốc bằng một lượt AI độc lập + dữ liệu liều trong kho. Trả { verdict:'consistent'|'check'|'uncertain', issues:[], notes, costUsd }. */
export async function verifyDraft(hz, draft) {
  if (!process.env.OPENAI_API_KEY) return { verdict: 'uncertain', issues: ['Chưa cấu hình AI để kiểm chéo'], notes: '', costUsd: 0 };
  const ctx = contextFor(hz);
  const kho = ctx ? `DỮ LIỆU TRONG KHO CHIMEDIS (từ ${ctx.count} bài thuốc): ` + ctx.formulas.map((f) => `${f.hz} (${f.vi}) dùng ${f.dose || '?'}`).join('; ') : 'Kho chưa có dữ liệu bài thuốc cho vị này.';
  const sys = 'Bạn là dược sĩ Trung dược thẩm định độc lập. Nhiệm vụ: KIỂM CHÉO bản nháp nội dung một vị thuốc (do AI khác soạn) với kiến thức chuẩn từ 《中华人民共和国药典》 và giáo trình 《中药学》. '
    + 'Đối chiếu: tên (Hán/Việt/Anh), tính–vị–quy kinh, công năng, chủ trị, liều dùng, kiêng kỵ, và liều dùng trong các bài của kho (nếu có). KHÔNG sửa lại bản nháp; chỉ nêu mâu thuẫn/điểm sai/điểm không chắc. '
    + 'Nếu vị này là thực phẩm/phụ liệu (gạo, rượu, trứng…) hoặc vị cổ ít dùng, nói rõ. Chỉ trả JSON: {"verdict":"consistent|check|uncertain","issues":["..."],"notes":"≤200 ký tự nguồn tham chiếu"}. '
    + 'verdict=consistent chỉ khi mọi mục chính khớp nguồn chuẩn; check khi có mục sai/mâu thuẫn; uncertain khi bạn không đủ chắc.';
  const r = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: sys }, { role: 'user', content: `Vị: ${hz}\n${kho}\nBẢN NHÁP:\n${JSON.stringify(draft).slice(0, 5000)}` }],
      response_format: { type: 'json_object' }, max_completion_tokens: 2500, reasoning_effort: 'low' }),
  });
  if (!r.ok) return { verdict: 'uncertain', issues: [`Không kiểm chéo được (${r.status})`], notes: '', costUsd: 0 };
  const j = await r.json();
  let p = {}; try { p = JSON.parse(j.choices[0].message.content || '{}'); } catch (_) { /* bỏ qua */ }
  const verdict = ['consistent', 'check', 'uncertain'].includes(p.verdict) ? p.verdict : 'uncertain';
  return { verdict, issues: (Array.isArray(p.issues) ? p.issues : []).map((x) => String(x).slice(0, 240)).slice(0, 8), notes: String(p.notes || '').slice(0, 240), costUsd: costFromUsage(MODEL, j.usage) };
}
