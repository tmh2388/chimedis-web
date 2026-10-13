/**
 * tcm-style.js — QUY ƯỚC DỊCH THUẬT NGỮ TRUNG Y dùng CHUNG cho mọi nơi AI tự dịch/diễn đạt trong Chimedis
 * (Lão Sư, bài Tự Thêm, thuật ngữ tự học…), để chat / nghe / nói đồng bộ với CSDL từ điển.
 *
 * Hai lớp (cùng triết lý với workbench `lib/ai-translate.js`):
 *  1. QUY ƯỚC văn phong (STYLE_RULES): Hán-Việt cho thuật ngữ Trung y, không "Tây y hoá", WHO/pinyin cho tiếng Anh…
 *  2. BẢNG THUẬT NGỮ BẮT BUỘC: các mục CSDL (hz/vi/en) có mặt trong văn bản nguồn được chèn vào prompt → AI phải dùng đúng
 *     dạng đã duyệt, không tự nghĩ ra cách dịch khác.
 */
import { allTerms } from './csdl-lessons.js';

export const STYLE_RULES = `QUY ƯỚC DỊCH THUẬT NGỮ TRUNG Y CỦA CHIMEDIS (bắt buộc, dùng chung toàn hệ thống):
1. Thuật ngữ Trung y (bệnh danh, chứng, huyệt, dược liệu, phương, pháp trị, lý luận) → tiếng Việt theo âm HÁN-VIỆT chuẩn, \
đúng cách giới Trung y Việt Nam vẫn dùng. Ví dụ: 失神发作 → "Thất thần phát tác"; 气虚 → "Khí hư"; 辨证论治 → "Biện chứng luận trị"; \
痰湿 → "Đàm thấp". KHÔNG diễn giải thành thuật ngữ Tây y/mô tả hiện đại (không dịch 失神 thành "mất ý thức", "vắng ý thức"…).
2. Mục có trong BẢNG THUẬT NGỮ → dùng ĐÚNG dạng ghi trong bảng, không đổi, không đặt tên khác.
3. Có thể thêm đối chiếu Tây y trong ngoặc (khi cần) SAU tên Hán-Việt; không dùng để thay thế tên Hán-Việt.
4. Tiếng Anh: ưu tiên WHO International Standard Terminologies on Traditional Medicine; không có chuẩn thì dùng pinyin kèm nghĩa ngắn.
5. Chữ Hán dùng giản thể; pinyin có dấu thanh. Giữ NHẤT QUÁN: một thuật ngữ → một cách dịch trong toàn văn.
6. Không chắc thì giữ Hán-Việt/pinyin, không bịa nghĩa.`;

let cache = { builtAt: 0, byHz: null, byVi: null, n: 0 };
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
function build() {
  const terms = allTerms();
  if (cache.byHz && cache.n === terms.length) return cache;
  const byHz = new Map(), byVi = new Map();
  for (const t of terms) {
    if (t.hz && t.hz.length >= 2 && t.vi) { const a = byHz.get(t.hz) || []; a.push(t); byHz.set(t.hz, a); }
    const v = fold(t.vi).replace(/[^a-z0-9]+/g, ' ').trim();
    if (v.length >= 5) { const a = byVi.get(v) || []; a.push(t); byVi.set(v, a); }
  }
  cache = { builtAt: Date.now(), byHz, byVi, n: terms.length };
  return cache;
}

/** Các mục CSDL có mặt trong văn bản (Hán hoặc tên Việt), dài trước, tối đa `max`. */
export function glossaryTerms(texts, max = 40) {
  const hay = (Array.isArray(texts) ? texts : [texts]).filter(Boolean).join('\n');
  if (!hay.trim()) return [];
  const { byHz, byVi } = build();
  const found = new Map();
  const han = hay.replace(/[^一-鿿]+/g, ' ');
  for (const seg of han.split(' ')) {
    for (let len = Math.min(8, seg.length); len >= 2; len--) {
      for (let i = 0; i + len <= seg.length; i++) {
        const w = seg.slice(i, i + len);
        const hit = byHz.get(w);
        if (hit && !found.has(w)) found.set(w, hit[0]);
      }
    }
  }
  const folded = ` ${fold(hay).replace(/[^a-z0-9]+/g, ' ')} `;
  if (folded.trim().length >= 5) {
    for (const [v, arr] of byVi) {
      if (folded.includes(` ${v} `) && !found.has(arr[0].hz || v)) found.set(arr[0].hz || v, arr[0]);
      if (found.size >= max * 3) break;
    }
  }
  return [...found.values()].sort((a, b) => String(b.hz || '').length - String(a.hz || '').length).slice(0, max);
}

/** Khối văn bản chèn vào prompt: quy ước + bảng thuật ngữ bắt buộc cho các mục có mặt trong `texts`. */
export function styleBlock(texts, { max = 40, rules = true } = {}) {
  const g = glossaryTerms(texts, max);
  const table = g.length
    ? `BẢNG THUẬT NGỮ BẮT BUỘC (Hán = Việt = Anh, đã duyệt trong CSDL Chimedis):\n${g.map((t) => `${t.hz || ''} = ${t.vi || ''} = ${t.en || ''}`).join('\n')}`
    : '';
  return [rules ? STYLE_RULES : '', table].filter(Boolean).join('\n\n');
}
