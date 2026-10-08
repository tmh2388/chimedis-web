/**
 * apply-figure-label-overrides.mjs — áp tay chỉnh vị trí tên huyệt (data/figure-label-overrides.json) lên
 * data/acupoint-figures.json SAU khi chạy locate-figure-labels.mjs.
 * Lý do: định vị tự động còn ~7% hình khó (nhãn đè đường gạch/số thước, nhãn gần giống nhau). Phần còn lại được
 * RÀ BẰNG MẮT trên ảnh gốc và ghi toạ độ [x,y,w,h] px ảnh gốc (chỉ vị trí của tên đã biết, không đọc nội dung).
 * Giá trị null = xoá khung (khi tự động gán nhầm). Idempotent.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const figs = JSON.parse(fs.readFileSync(path.join(dir, 'acupoint-figures.json'), 'utf8'));
const ov = JSON.parse(fs.readFileSync(path.join(dir, 'figure-label-overrides.json'), 'utf8'));
let n = 0;
for (const [fig, pts] of Object.entries(ov)) {
  const mid = 'SRCMEDIA-JLX5-' + fig;
  if (!figs.media[mid]) { console.warn('Không có hình', mid); continue; }
  figs.labels[mid] ||= {};
  for (const [pid, box] of Object.entries(pts)) { if (box === null) delete figs.labels[mid][pid]; else figs.labels[mid][pid] = box; n++; }
}
fs.writeFileSync(path.join(dir, 'acupoint-figures.json'), JSON.stringify(figs));
console.log(`✅ Áp ${n} chỉnh tay`);
