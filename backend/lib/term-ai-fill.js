/**
 * term-ai-fill.js — AI ĐỀ XUẤT bổ sung nội dung còn thiếu/thiếu ý cho MỘT thuật ngữ (nút "AI bổ sung" của admin).
 * Chỉ ĐỀ XUẤT: không ghi CSDL. Admin xem, sửa rồi mới lưu qua /api/admin/term-edit (có giao dịch + nhật ký trước/sau).
 * Nối đất bằng bảng thuật ngữ bắt buộc + các mục liên quan trong kho (đồng bộ quy ước với từ điển, Lão Sư, tra cứu AI).
 */
import { styleBlock } from './tcm-style.js';
import { searchTerms, factsFor } from './csdl-lessons.js';
import { costFromUsage } from './ai-budget.js';

const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
const MODEL = process.env.AI_TERMFILL_MODEL || process.env.AI_LOOKUP_MODEL || 'gpt-5-mini';
const cut = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').trim().slice(0, n);

/** term: { hz, vi, en, group1, field, def_vi, def_zh, def_en } → { vi, en, def_vi, def_zh, def_en, note, costUsd } */
export async function suggestFill(term) {
  const t = { hz: cut(term.hz, 40), vi: cut(term.vi, 190), en: cut(term.en, 190), group1: cut(term.group1, 48), field: cut(term.field, 60),
    def_vi: cut(term.def_vi, 700), def_zh: cut(term.def_zh, 700), def_en: cut(term.def_en, 700) };
  if (!t.hz && !t.vi && !t.en) throw Object.assign(new Error('empty_term'), { code: 'bad_request' });
  const refs = [...searchTerms(t.hz || t.vi || t.en, 3)].slice(0, 4);
  const refText = refs.length ? 'CÁC MỤC LIÊN QUAN TRONG KHO (đối chiếu Hán-Việt/Anh, không chép nguyên):\n' + refs.map((x) => factsFor(x, 2)).join('\n\n') : '';
  const sys = 'Bạn là biên tập viên từ điển Trung y – y khoa Việt/Trung/Anh của Chimedis. Nhiệm vụ: BỔ SUNG nội dung còn thiếu hoặc quá sơ sài cho một thuật ngữ đã có trong kho. '
    + 'Chỉ viết những điều bạn CHẮC CHẮN đúng; không bịa; không chắc thì để chuỗi rỗng và ghi lý do ở "note". Không chẩn đoán/kê đơn. '
    + 'Giữ nguyên các trường đã tốt (trả lại đúng nội dung cũ hoặc để rỗng). Định nghĩa 1–3 câu, văn phong từ điển, đủ ý: là gì, biểu hiện/vai trò, liên hệ Trung y (nếu có). '
    + 'Viết ĐỦ ba ngôn ngữ Việt/Trung (giản thể)/Anh, thống nhất thuật ngữ với bảng bắt buộc. Chỉ trả JSON.\n\n' + styleBlock([t.hz, t.vi, t.en], { max: 25 }) + (refText ? '\n\n' + refText : '');
  const user = `Thuật ngữ hiện có: ${JSON.stringify(t)}\nTrả JSON: {"vi":"<tên Việt, rỗng nếu đã đúng>","en":"<tên Anh, rỗng nếu đã đúng>","def_vi":"","def_zh":"","def_en":"","note":"<lưu ý ngắn>"}`
    + (t.field ? `\nChỉ bổ sung mục nội dung: "${t.field}" (def_* là nội dung của mục này).` : '');
  const r = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      response_format: { type: 'json_object' }, max_completion_tokens: 3000, reasoning_effort: 'low' }),
  });
  if (!r.ok) throw Object.assign(new Error(`termfill_llm ${r.status}`), { code: 'upstream' });
  const j = await r.json();
  const txt = String(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '');
  if (!txt.trim()) throw Object.assign(new Error('termfill_empty'), { code: 'upstream' });
  const p = JSON.parse(txt);
  return { vi: cut(p.vi, 190), en: cut(p.en, 190), def_vi: cut(p.def_vi, 700), def_zh: cut(p.def_zh, 700), def_en: cut(p.def_en, 700), note: cut(p.note, 240), costUsd: costFromUsage(MODEL, j.usage) };
}
