// Tải Firebase JS SDK về tự phục vụ (frontend/vendor/firebase) và VÁ để:
//  - không phụ thuộc www.gstatic.com (bị chặn ở Trung Quốc đại lục);
//  - gọi API đăng nhập qua CHÍNH tên miền dict (/__fb/idtk, /__fb/stk) — server chuyển tiếp tới Google (xem backend/server.js).
// Khác chimedis-home: app iOS chạy ở capacitor://localhost nên location.host là "localhost" — khi không phải http/https
// thì trỏ về https://dict.chimedis.vn.
// Chạy: node scripts/vendor-firebase.mjs && node backend/sync-frontend.js   (đổi VERSION khi nâng cấp, rồi kiểm tra đăng nhập thật)
import fs from 'node:fs';
const VERSION = '10.12.2';
const OUT = new URL('../frontend/vendor/firebase/', import.meta.url);
fs.mkdirSync(OUT, { recursive: true });
const WEB = '(location.protocol==="http:"||location.protocol==="https:")';
for (const f of ['firebase-app', 'firebase-auth']) {
  const r = await fetch(`https://www.gstatic.com/firebasejs/${VERSION}/${f}.js`);
  if (!r.ok) throw new Error(f + ' ' + r.status);
  let s = await r.text();
  if (f === 'firebase-auth') {
    s = s.replace(`"https://www.gstatic.com/firebasejs/${VERSION}/firebase-app.js"`, '"./firebase-app.js"');
    const a = s.split('apiHost:"identitytoolkit.googleapis.com"').length - 1;
    const b = s.split('tokenApiHost:"securetoken.googleapis.com"').length - 1;
    if (a !== 1 || b !== 1) throw new Error(`mẫu apiHost/tokenApiHost không khớp (a=${a}, b=${b}) — SDK đổi cấu trúc, cần xem lại`);
    s = s.replace('apiHost:"identitytoolkit.googleapis.com"', `apiHost:(${WEB}?location.host:"dict.chimedis.vn")+"/__fb/idtk"`)
         .replace('tokenApiHost:"securetoken.googleapis.com"', `tokenApiHost:(${WEB}?location.host:"dict.chimedis.vn")+"/__fb/stk"`);
    if (s.split('apiScheme:"https"').length !== 2) throw new Error('mẫu apiScheme không khớp');
    s = s.replace('apiScheme:"https"', `apiScheme:(${WEB}?location.protocol.replace(":",""):"https")`); // http khi chạy thử cục bộ
  }
  s = s.replace(`https://www.gstatic.com/firebasejs/${VERSION}/firebase-app.js`, './firebase-app.js');
  fs.writeFileSync(new URL(f + '.js', OUT), `/* Firebase JS SDK ${VERSION} — bản tự phục vụ đã vá (scripts/vendor-firebase.mjs). */\n` + s);
  console.log('ok', f, s.length);
}
