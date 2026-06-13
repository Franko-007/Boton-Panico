const CACHE_NAME = 'panico-nsg-v8';
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

/* ═══════════════════════════════════════════════════════════════
   SESIÓN EN INDEXEDDB
   El SW necesita saber quién es el usuario (nombre, rol y token de
   sesión) para poder:
     1) decidir qué botones de acción mostrar en la notificación
        push (p.ej. "Desactivar emergencia" sólo si es admin), y
     2) autenticar las llamadas REST que esos botones disparan,
   todo esto SIN que la app esté abierta.
   La página envía SET_SESSION al hacer login y CLEAR_SESSION al
   cerrar sesión (ver index.html).
═══════════════════════════════════════════════════════════════ */
const DB_NAME = 'panico-nsg-db';
const STORE   = 'session';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function setSession(session) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(session, 'current');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { /* IndexedDB no disponible: degradar sin sesión */ }
}

async function getSession() {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get('current');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = () => reject(req.error);
    });
  } catch (e) { return null; }
}

async function clearSession() {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete('current');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {}
}

/* ── PUSH ─── */
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  const isUrg  = data.type === 'urgente';
  const isAcc  = data.type === 'accidente';
  const title  = data.title  || (isUrg ? '🚨 EMERGENCIA – NSG' : isAcc ? '🟣 ACCIDENTE – NSG' : '⚠️ ALERTA – NSG');
  const body   = data.body   || 'Nueva alerta de emergencia';
  const color  = data.color  || (isUrg ? '#ef4444' : isAcc ? '#8b5cf6' : '#f59e0b');

  event.waitUntil((async () => {
    const session = await getSession();
    const role = session ? session.role : null;

    // Botones de acción: responder a la alerta SIN abrir la app.
    // Chrome/Android soporta hasta 2 acciones por notificación.
    const actions = [];
    if (isUrg && role === 'admin') {
      actions.push({ action: 'cancel_emergency', title: '🟢 Desactivar emergencia' });
    } else if (!isUrg && role === 'admin') {
      actions.push({ action: 'resolve', title: '✓ Atendido' });
    }
    actions.push({ action: 'false_alarm', title: '🚫 Falsa alarma' });

    await self.registration.showNotification(title, {
      body,
      tag: `alerta-nsg-${data.alertId || Date.now()}`,
      renotify: true,
      requireInteraction: true,
      icon:  '/icon-192.png',
      badge: '/icon-192.png',
      vibrate: isUrg ? [400,150,400,150,600,150,400,150,600] : isAcc ? [300,100,300,100,400] : [300,100,300],
      color: color,
      actions,
      data: data
    });
  })());
});

/* ── NOTIFICATIONCLICK ─── */
self.addEventListener('notificationclick', event => {
  const alertData = event.notification.data || {};
  const action = event.action;

  // Botones de acción rápida: resolver vía REST sin abrir la app.
  if (action === 'false_alarm' || action === 'resolve' || action === 'cancel_emergency') {
    event.notification.close();
    event.waitUntil((async () => {
      const session = await getSession();
      if (!session || !session.token) return;
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.token}`
      };
      try {
        if (action === 'false_alarm' && alertData.alertId) {
          await fetch(`/api/alerts/${alertData.alertId}/false-alarm`, { method: 'POST', headers, body: '{}' });
        } else if (action === 'resolve' && alertData.alertId) {
          await fetch(`/api/alerts/${alertData.alertId}/resolve`, { method: 'POST', headers, body: JSON.stringify({ note: 'Atendido desde notificación' }) });
        } else if (action === 'cancel_emergency') {
          await fetch('/api/cancel-emergency', { method: 'POST', headers, body: '{}' });
        }
      } catch (e) { /* sin conexión: el usuario deberá abrir la app */ }
    })());
    return;
  }

  // Click normal (sin acción): abrir/enfocar la app y mostrar el overlay SAE
  event.notification.close();
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
  if (!event.data) return;
  if (event.data.type === 'SW_READY') {
    event.source.postMessage({ type: 'SW_ACK' });
  } else if (event.data.type === 'SET_SESSION') {
    setSession({ name: event.data.name, role: event.data.role, token: event.data.token });
  } else if (event.data.type === 'CLEAR_SESSION') {
    clearSession();
  }
});
