/* ==========================================================
   JSON 阅读器 — Service Worker
   缓存优先策略，支持离线浏览
   ========================================================== */

const CACHE_NAME = 'json-reader-v4';

// 需要缓存的静态资源
const PRECACHE_URLS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './sw.js',
  './manifest.json',
  './icon.svg',
];

// ---------- 安装：预缓存 ----------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS);
    })
  );
  // 跳过等待，立即激活
  self.skipWaiting();
});

// ---------- 激活：清理旧缓存 ----------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  // 控制所有打开的页面
  self.clients.claim();
});

// ---------- 请求拦截：网络优先，缓存兜底 ----------
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // 网络成功 → 缓存一份（下次离线用），返回网络结果
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // 离线了 → 从缓存取
        return caches.match(event.request);
      })
  );
});
