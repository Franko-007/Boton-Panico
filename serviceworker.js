const CACHE_NAME = 'panico-nsg-v2';
const ASSETS = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png'];

/* ── Instalación ────────────────────────────────────────────── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

/* ── Activación ─────────────────────────────────────────────── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

/* ── Fetch: red primero, caché como respaldo ────────────────── */
self.addEventListener('fetch', event => {
  if (event.request.url.includes('/socket.io')) return;
  event.respondWith(
    fetch(event.request)
      .then(res => {
        if (res && res.status === 200 && event.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

/* ── PUSH: mostrar notificación nativa ──────────────────────── */
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch(e) {}

  const isUrg   = data.type === 'urgente';
  const title   = data.title  || (isUrg ? '🚨 EMERGENCIA – NSG' : '⚠️ ALERTA – NSG');
  const body    = data.body   || 'Nueva alerta de emergencia';
  const tag     = 'alerta-nsg'; // reemplaza la notificación anterior si sigue activa

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      renotify:         true,        // vibra aunque ya exista una con el mismo tag
      requireInteraction: true,      // NO desaparece sola (iOS 16.4+, Android)
      icon:  '/icon-192.png',
      badge: '/icon-192.png',
      vibrate: [400, 150, 400, 150, 600],
      data:  data                    // payload completo para cuando el usuario toca
    })
  );
});

/* ── NOTIFICATIONCLICK: abrir/enfocar app y mostrar overlay ─── */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const alertData = event.notification.data || {};

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // Buscar ventana ya abierta
      for (const client of clientList) {
        if (client.url.includes(self.location.origin)) {
          client.focus();
          // Enviar datos al cliente para mostrar el overlay SAE
          client.postMessage({ type: 'SHOW_SAE', alert: alertData });
          return;
        }
      }
      // No hay ventana abierta → abrir una nueva
      return self.clients.openWindow('/').then(newClient => {
        if (newClient) {
          // Esperar un momento a que cargue antes de enviar el mensaje
          setTimeout(() => {
            newClient.postMessage({ type: 'SHOW_SAE', alert: alertData });
          }, 2000);
        }
      });
    })
  );
});
