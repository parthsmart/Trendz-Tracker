// Trendz Tracker PWA Service Worker
const SW_VERSION = 'trendz-tracker-pwa-v2';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Strictly keeps the service worker out of unrelated requests:
// Completely bypasses all API endpoints (/api/*), Supabase database queries,
// auth tokens, and static subresource requests (scripts, styles, images).
// Only handles top-level same-origin page navigation when network is unavailable.
self.addEventListener('fetch', (event) => {
  // 1. Only consider top-level HTML document navigations
  if (event.request.mode !== 'navigate') {
    return;
  }

  // 2. Never intercept cross-origin (e.g. Supabase) or API requests
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    return;
  }

  // 3. Forward navigation request to network; fallback only if offline
  event.respondWith(
    fetch(event.request).catch((err) => {
      return caches.match('/index.html').then((cached) => cached || Promise.reject(err));
    })
  );
});
