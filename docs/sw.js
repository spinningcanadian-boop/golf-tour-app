// Offline support. The page itself is fetched fresh whenever there is signal (so updates show straight away),
// falling back to the saved copy with no signal. Versioned files (app.js?v=…) are served from the saved copy.
const CACHE = 'golf-tour-38a6c666fd';
const SHELL = ['./', 'index.html', 'app.js?v=38a6c666fd', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;   // Firebase traffic is handled by Firebase itself
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request, { cache: 'no-store' })
      .then(r => { if (r.ok) caches.open(CACHE).then(c => c.put('index.html', r.clone())); return r; })
      .catch(() => caches.match('index.html')));
    return;
  }
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request);
    return hit || fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; });
  }));
});
