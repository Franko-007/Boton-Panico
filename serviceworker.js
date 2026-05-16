const CACHE_NAME = 'panico-nsg-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800;900&family=Barlow:wght@400;500;600&display=swap'
];

// Instalación: cachear recursos estáticos
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS).catch(() => {});
    })
  );
  self.skipWaiting();
});

// Activación: limpiar caches antiguas
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: red primero, caché como respaldo
self.addEventListener('fetch', event => {
  // Socket.io y WebSockets siempre van por red
  if (event.request.url.includes('/socket.io')) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Guardar copia fresca en caché
        if (response && response.status === 200 && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Notificaciones push (si se implementan en el futuro)
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  self.registration.showNotification(data.title || '🚨 Alerta NSG', {
    body: data.body || 'Nueva alerta de emergencia',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    requireInteraction: true,
    vibrate: [300, 100, 300, 100, 300]
  });
});
