// Service Worker — Che plaS Control de Caja
const CACHE = 'cheplas-v3';
const BASE  = self.registration.scope;          // ej: https://ahhm0699.github.io/PROGRAMA-CAJA/
const PRECACHE = [
  BASE,
  BASE + 'index.html',
  BASE + 'style.css',
  BASE + 'app.js',
  BASE + 'yapes-widget.html',
  BASE + 'manifest.json',
  BASE + 'icons/icon-192.png',
  BASE + 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  // Firebase y CDN siempre en red
  if (url.includes('firestore') || url.includes('firebase') ||
      url.includes('gstatic')   || url.includes('googleapis')) {
    e.respondWith(fetch(e.request));
    return;
  }
  // Resto: network-first (garantiza contenido fresco), cae a cache si sin red
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
