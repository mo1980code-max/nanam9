/*
 * Voltade service worker.
 *
 * Strategy:
 *   • Navigations  → network-first, cache fallback. Games and content must be fresh;
 *     the offline shell is the fallback, not the default.
 *   • Static assets (/_next/static, icons, brand) → cache-first, immutable-ish and
 *     content-hashed by Next, so a stale entry is impossible.
 *   • Game media and /api → network only. Caching API responses would cache personal
 *     state (favourites, votes) under a URL another user might request. Never do that.
 */

const SHELL = 'voltade-shell-v1';
const STATIC = 'voltade-static-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(['/', '/games', '/icons/icon-192.png', '/brand/logo.svg'])),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== SHELL && key !== STATIC).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // CDN, storage, OAuth: never intercept

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) return; // network only

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match('/'))),
    );
    return;
  }

  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/') || url.pathname.startsWith('/brand/')) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((response) => {
            const copy = response.clone();
            caches.open(STATIC).then((cache) => cache.put(request, copy));
            return response;
          }),
      ),
    );
  }
});
