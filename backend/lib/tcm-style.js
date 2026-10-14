/**
 * tcm-style.js — QUY ƯỚC DỊCH THUẬT NGỮ TRUNG Y dùng CHUNG cho mọi nơi AI tự dịch/diễn đạt trong Chimedis
 * (Lão Sư, bài Tự Thêm, thuật ngữ tự học…), để chat / nghe / nói đồng bộ với CSDL từ điển.
 *
 * Hai lớp (cùng triết lý với workbench `lib/ai-translate.js`):
 *  1. QUY ƯỚC văn phong (STYLE_RULES): Hán-Việt cho thuật ngữ Trung y, không "Tây y hoá", WHO/pinyin cho tiếng Anh…
 *  2. BẢNG THUẬT NGỮ BẮT BUỘC: các mục CSDL (hz/vi/en) có mặt trong văn bản nguồn được chèn vào prompt → AI phải dùng đúng
 *     dạng đã duyệt, không tự nghĩ ra cách dịch khác.
 */
import { allTerms, searchTerms } from './csdl-lessons.js';

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

/** Mục CSDL có chữ Hán đúng bằng `hz` (null nếu kho chưa có). */
export function termByHz(hz) {
  const { byHz } = build();
  const a = byHz.get(String(hz || '').trim());
  return a && a[0] ? a[0] : null;
}

const GROUP_TYPE = { 'Huyệt vị': 'huyet', 'Dược liệu': 'duoc', 'Bệnh lý': 'benh', 'Tổng hợp': 'khac', 'Sinh lý': 'khac', 'Giải phẫu': 'khac' };
/**
 * Làm giàu: từ một nhóm mục "hạt giống" của kho, quét NỘI DUNG của chúng (định nghĩa, công năng, lâm sàng…) để tìm các mục KHÁC của kho
 * được nhắc tới (huyệt, dược liệu, bệnh/chứng…). Trả { huyet:[...], duoc:[...], benh:[...], khac:[...] } mỗi loại tối đa `perType`.
 */
export function relatedFromKho(seeds, { perType = 4 } = {}) {
  const { byHz } = build();
  const seedIds = new Set(seeds.map((s) => String(s.id)));
  const score = new Map();
  for (const seed of seeds) {
    const text = Object.values(seed).filter((v) => typeof v === 'string' && v.length > 1).join('\n');
    const han = text.replace(/[^一-鿿]+/g, ' ');
    for (const seg of han.split(' ')) {
      for (let len = Math.min(6, seg.length); len >= 2; len--) {
        for (let i = 0; i + len <= seg.length; i++) {
          const hit = byHz.get(seg.slice(i, i + len));
          if (hit && hit[0] && !seedIds.has(String(hit[0].id))) score.set(hit[0].id, { t: hit[0], n: ((score.get(hit[0].id) || { n: 0 }).n) + 1 });
        }
      }
    }
  }
  const out = { huyet: [], duoc: [], benh: [], khac: [] };
  [...score.values()].sort((a, b) => b.n - a.n).forEach(({ t }) => {
    const ty = GROUP_TYPE[t.group1] || null; if (!ty || !out[ty] || out[ty].length >= perType) return;
    out[ty].push(t);
  });
  return out;
}
/** Truy xuất đa nhóm cho một câu/chủ đề: vài mục liên quan nhất ở MỖI nhóm chính (huyệt, dược liệu, bệnh lý, tổng hợp). */
export function crossGroupRefs(query, perGroup = 2) {
  const groups = ['Tổng hợp', 'Bệnh lý', 'Huyệt vị', 'Dược liệu'];
  const seen = new Set(), out = [];
  for (const g of groups) for (const t of searchTerms(query, perGroup, g)) if (!seen.has(t.id)) { seen.add(t.id); out.push(t); }
  return out;
}
