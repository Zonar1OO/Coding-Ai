/* ============================================================
 *  Service Worker для AI Code Studio
 *  Стратегия:
 *   - свои статические файлы: cache-first с обновлением в фоне
 *   - CDN (jszip): stale-while-revalidate
 *   - API-запросы: пропускаем напрямую (не кэшируем)
 * ============================================================ */

const CACHE = 'aics-v2';
const PRECACHE = [
  './',
  './index.html',
  './styles.css',
  './js/app.js',
  './js/ai.js',
  './manifest.json',
  './icon.svg',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(
        PRECACHE.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] Не удалось закэшировать', url, err);
          })
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isApiRequest(url) {
  // Не кэшируем никакие запросы к API ИИ
  if (/\/v1\/chat\/completions/.test(url.pathname)) return true;
  if (/\/chat\/completions/.test(url.pathname)) return true;
  if (/\/v1\/messages/.test(url.pathname)) return true;
  if (/\/completions/.test(url.pathname)) return true;
  // Частые хосты API
  const hosts = [
    'api.openai.com',
    'openrouter.ai',
    'api.groq.com',
    'api.deepseek.com',
    'api.anthropic.com',
    'generativelanguage.googleapis.com',
    'api.mistral.ai'
  ];
  return hosts.includes(url.hostname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // API — пропускаем напрямую
  if (isApiRequest(url)) return;

  // Same-origin — cache-first + фоновое обновление
  if (url.origin === location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetchPromise = fetch(req)
          .then((res) => {
            if (res && res.ok) {
              const clone = res.clone();
              caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => {});
            }
            return res;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Сторонние CDN — stale-while-revalidate
  if (url.hostname === 'cdnjs.cloudflare.com') {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetchPromise = fetch(req)
          .then((res) => {
            if (res && res.ok) {
              const clone = res.clone();
              caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => {});
            }
            return res;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }
});

// Позволяем странице попросить активацию новой версии
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});