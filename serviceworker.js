const CACHE_NAME = 'panico-nsg-v3';
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
  const isAcc   = data.type === 'accidente';
  const title   = data.title  || (isUrg ? '🚨 EMERGENCIA – NSG' : isAcc ? '🟣 ACCIDENTE – NSG' : '⚠️ ALERTA – NSG');
  const body    = data.body   || 'Nueva alerta de emergencia';
  const color   = data.color  || (isUrg ? '#ef4444' : isAcc ? '#8b5cf6' : '#f59e0b');
  const tag     = 'alerta-nsg';
  
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      renotify: true,
      requireInteraction: true,
      icon:  '/icon-192.png',
      badge: '/icon-192.png',
      vibrate: isUrg ? [400,150,400,150,600] : isAcc ? [300,100,300,100,400] : [300,100,300],
      color: color,
      data: data
    })
  );
});

/* ── NOTIFICATIONCLICK: abrir/enfocar app y mostrar overlay ─── */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const alertData = event.notification.data || {};
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin)) {
          client.focus();
          client.postMessage({ type: 'SHOW_SAE', alert: alertData });
          return;
        }
      }
      return self.clients.openWindow('/').then(newClient => {
        if (newClient) {
          setTimeout(() => {
            newClient.postMessage({ type: 'SHOW_SAE', alert: alertData });
          }, 2000);
        }
      });
    })
  );
});
