const CACHE_VERSION = 'chimedis-v90';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const DATA_CACHE = `${CACHE_VERSION}-data`;
// Hình/biểu tượng: bộ nhớ riêng KHÔNG gắn phiên bản — không bị xoá mỗi lần phát hành (trước đây mỗi lần cập nhật là phải tải lại toàn bộ hình huyệt).
const MEDIA_CACHE = 'chimedis-media-v1';

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/vendor/firebase/firebase-app.js',
  '/vendor/firebase/firebase-auth.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('chimedis-') && key !== SHELL_CACHE && key !== DATA_CACHE && key !== MEDIA_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Cổng chuyển tiếp đăng nhập Firebase: luôn đi mạng, không bao giờ cache (có GET cấu hình theo phiên).
  if (url.pathname.startsWith('/__fb/')) return;

  // Hình huyệt/biểu tượng: lấy từ bộ nhớ NGAY nếu có (tên tệp cố định), chỉ tải khi chưa có.
  if(url.pathname.startsWith('/figures/') || url.pathname.startsWith('/icons/')){
    event.respondWith(mediaFirst(request));
    return;
  }

  // Danh sách bài nghe / Học Thuật / từ vựng chuẩn: trả bản đã lưu NGAY, cập nhật ngầm (mở lần sau nhanh, không chờ mạng).
  if(url.pathname.startsWith('/api/listening/dialogues') || url.pathname === '/api/csdl/daily' || url.pathname === '/api/csdl/fields' || url.pathname === '/api/tcm-vocabulary'){
    event.respondWith(staleWhileRevalidate(request, event));
    return;
  }

  // Kho thuật ngữ (~1 MB): chờ mạng tối đa 4 giây rồi dùng bản đã lưu (mạng chập chờn không làm treo).
  if(url.pathname === '/api/terms'){
    event.respondWith(networkFirst(request, undefined, 4000));
    return;
  }

  // API calls: network-first, fall back to cache when offline
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // HTML: phục vụ bản đã lưu NGAY rồi cập nhật ngầm (mở app không chờ tải ~300 KB qua mạng). Bản mới có hiệu lực qua cập nhật service worker
  // (mỗi lần phát hành đều đổi số phiên bản → tải lại tự động), nên không lo mắc kẹt bản cũ.
  if (url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(staleWhileRevalidate(request, event, SHELL_CACHE));
    return;
  }

  // Static assets khác (icon, manifest...): cache-first, refresh in background
  event.respondWith(cacheFirst(request));
});

async function mediaFirst(request){
  const cache = await caches.open(MEDIA_CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  if(hit) return hit;
  const res = await fetch(request);
  if(res && res.ok) cache.put(request, res.clone()).catch(() => {});
  return res;
}
async function staleWhileRevalidate(request, event, cacheName){
  const cache = await caches.open(cacheName || DATA_CACHE);
  const cached = await cache.match(request);
  const refresh = fetch(request).then((res) => { if(res && res.ok) cache.put(request, res.clone()).catch(() => {}); return res; }).catch(() => null);
  if(cached){ if(event && event.waitUntil) event.waitUntil(refresh); return cached; }
  const res = await refresh;
  if(res) return res;
  return new Response('', { status: 504 });
}

async function networkFirst(request, cacheName, timeoutMs) {
  const cache = await caches.open(cacheName || DATA_CACHE);
  try {
    const response = timeoutMs
      ? await Promise.race([fetch(request), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))])
      : await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => cached);

  return cached || fetchPromise;
}
