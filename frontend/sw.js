/* 2 ON — Service Worker (PWA) */
const CACHE = '2on-v3';
const PRECACHE = [
  './', './index.html', './home.css', './home.js', './app-core.js',
  './games.html', './games.css', './games.js',
  './streaming/', './streaming/index.html', './streaming/streaming.css', './streaming/streaming.js', './streaming/lobby.js', './streaming/ui.js',
  './vendor/qrcode.min.js', './icon-192.png', './icon-512.png', './assets/icon.svg', './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(PRECACHE.map((u) => cache.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // API, health e ICE nunca passam pela cache
  if (url.pathname.startsWith('/api/') || url.pathname === '/ice-servers' || url.pathname === '/health') return;

  const isPage = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  const network = fetch(req).then((res) => {
    if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  });

  if (isPage) {
    // Páginas: rede primeiro (evita ficar preso numa versão antiga); cache só offline
    event.respondWith(network.catch(() => caches.match(req).then((c) => c || caches.match('./index.html'))));
  } else {
    // Ficheiros estáticos: cache primeiro, atualiza em segundo plano
    event.respondWith(caches.match(req).then((cached) => cached || network.catch(() => cached)));
    if (event.waitUntil) event.waitUntil(network.catch(() => {}));
  }
});
