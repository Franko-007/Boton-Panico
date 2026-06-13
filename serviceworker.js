const CACHE_NAME = 'panico-nsg-v7';
// NO cachear index.html para que siempre cargue la versión más reciente
const ASSETS = ['/manifest.json', '/icon-192.png', '/icon-512.png', '/style.css'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.url.includes('/socket.io') || event.request.method !== 'GET') return;

  // NUNCA cachear index.html — siempre desde red para tener versión actualizada
  const url = new URL(event.request.url);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

/* ── PUSH ─── */
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  const isUrg  = data.type === 'urgente';
  const isAcc  = data.type === 'accidente';
  const title  = data.title  || (isUrg ? '🚨 EMERGENCIA – NSG' : isAcc ? '🟣 ACCIDENTE – NSG' : '⚠️ ALERTA – NSG');
  const body   = data.body   || 'Nueva alerta de emergencia';
  const color  = data.color  || (isUrg ? '#ef4444' : isAcc ? '#8b5cf6' : '#f59e0b');
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: `alerta-nsg-${data.alertId || Date.now()}`,
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

/* ── NOTIFICATIONCLICK ─── */
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
          setTimeout(() => newClient.postMessage({ type: 'SHOW_SAE', alert: alertData }), 800);
          setTimeout(() => newClient.postMessage({ type: 'SHOW_SAE', alert: alertData }), 1600);
        }
      });
    })
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SW_READY') {
    event.source.postMessage({ type: 'SW_ACK' });
  }
});
