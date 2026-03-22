// AUTO-GENERATED BUILD_HASH — do not edit manually
const BUILD_HASH = '5e758e0c';

const CACHE_NAME = `node-${BUILD_HASH}`;

const urlsToCache = [
  './',
  './index.html',
  './app.js',
  './chart.min.js'
];

// Bei Installation: neue Ressourcen cachen, sofort aktivieren
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

// Bei Aktivierung: alte Caches löschen, sofort übernehmen
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: Stale-While-Revalidate
// Cache sofort liefern, im Hintergrund aktualisieren
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(cached => {
      const fetchPromise = fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);

      return cached || fetchPromise;
    })
  );
});
