const CACHE_NAME = 'node-v1';

// Alle Dateien, die offline funktionieren müssen:
const urlsToCache = [
  './',
  './index.html',
  './app.js'
  // './chart.js' <-- Wenn du Chart.js lokal abspeicherst, hier die // vorne entfernen!
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Gibt die Offline-Version zurück, falls vorhanden. Sonst lädt er aus dem Netz.
        return response || fetch(event.request);
      })
  );
});