// Minimal service worker for 2 ON Streaming — no offline caching for now
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
