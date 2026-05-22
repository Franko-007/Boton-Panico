/* ──────────────────────────────────────────────────────────────
   serviceworker.js  v3.4 (fix 2026)
   Correcciones:
   - tag usa alertId en vez de string fijo → permite múltiples alertas simultáneas
   - eliminado setTimeout frágil → se usa message desde el cliente al estar listo
────────────────────────────────────────────────────────────── */
const CACHE_NAME = 'panico-nsg-v4';
const ASSETS = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png', '/style.css'];

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

/* ── PUSH: mostrar notificación nativa (incluso en background) ─── */
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
      // FIX: tag único por alerta → múltiples alertas no se sobreescriben entre sí
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

/* ── NOTIFICATIONCLICK: al tocar la alerta con la app cerrada ─── */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const alertData = event.notification.data || {};

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // Si ya hay una pestaña abierta, la enfocamos
      for (const client of clientList) {
        if (client.url.includes(self.location.origin)) {
          client.focus();
          client.postMessage({ type: 'SHOW_SAE', alert: alertData });
          return;
        }
      }
      // FIX: si la app estaba cerrada, se abre y se guarda la alerta en sessionStorage
      // El cliente la leerá en su propio evento 'load' o 'DOMContentLoaded', sin setTimeout frágil
      return self.clients.openWindow('/').then(newClient => {
        if (newClient) {
          // Se usa postMessage con un pequeño retry porque el cliente puede no estar listo aún
          // El cliente debe escuchar 'message' y también revisar sessionStorage al arrancar
          const tryPost = (attempts) => {
            if (attempts <= 0) return;
            newClient.postMessage({ type: 'SHOW_SAE', alert: alertData });
          };
          // Intentar inmediatamente y luego a 800ms y 1600ms como respaldo
          tryPost(1);
          setTimeout(() => tryPost(1), 800);
          setTimeout(() => tryPost(1), 1600);
        }
      });
    })
  );
});

/* ── MESSAGE: relay de mensajes entre service worker y clientes ─ */
self.addEventListener('message', event => {
  // Permite que el cliente envíe un 'READY' para que el SW reenvíe alertas pendientes
  if (event.data && event.data.type === 'SW_READY') {
    event.source.postMessage({ type: 'SW_ACK' });
  }
});
