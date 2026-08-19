const CACHE_VERSION = 'chimedis-v2';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const DATA_CACHE = `${CACHE_VERSION}-data`;

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
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
          .filter((key) => key.startsWith('chimedis-') && key !== SHELL_CACHE && key !== DATA_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // API calls: network-first, fall back to cache when offline
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // HTML shell ('/' và '/index.html' chứa TOÀN BỘ code — không có file JS/CSS
  // tách riêng có hash tên file để cache-bust): network-first để mọi lần deploy
  // mới có hiệu lực NGAY ở lần mở app kế tiếp có mạng, không phải đợi 1 vòng
  // "cache-first rồi refresh nền" mới thấy bản mới — user report 2026-08-19:
  // sau khi update version mới, search "hoàn toàn không tìm được" vì WKWebView
  // (app iOS) vẫn phục vụ index.html CŨ đã cache trước đó, không phải lỗi logic
  // search (đã xác nhận logic search hoạt động đúng trên bản mới).
  if (url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(networkFirst(request, SHELL_CACHE));
    return;
  }

  // Static assets khác (icon, manifest...): cache-first, refresh in background
  event.respondWith(cacheFirst(request));
});

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName || DATA_CACHE);
  try {
    const response = await fetch(request);
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
