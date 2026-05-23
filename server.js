/* ──────────────────────────────────────────────────────────────
   BOTÓN DE PÁNICO – COLEGIO NSG  |  server.js  v3.6
   
   Arquitectura híbrida — sin SQLite, sin disco de pago:
   • Memoria RAM: alertas activas, push subs (rápido, tiempo real)
   • Google Sheets: persistencia permanente (survives reinicios)
   • Al arrancar: recupera historial completo desde Sheets
   • Push subs: se recuperan desde hoja "PushSubs" en Sheets
────────────────────────────────────────────────────────────── */
require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const webpush    = require('web-push');
const { google } = require('googleapis');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(express.static(path.join(__dirname)));
app.use(express.json());

/* ── Memoria RAM ─────────────────────────────────────────────── */
// alertsMemory: array de todas las alertas (cargado desde Sheets al arrancar)
let alertsMemory = [];
// pushSubsMemory: Map endpoint -> subscription JSON
let pushSubsMemory = new Map();

/* ── VAPID ───────────────────────────────────────────────────── */
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;
const VAPID_EMAIL   = process.env.VAPID_EMAIL || 'mailto:admin@colegio-nsg.cl';
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
  console.log('✅ VAPID configurado');
} else {
  console.warn('⚠️  VAPID no configurado.');
}

app.get('/vapid-public-key', (req, res) => {
  if (!VAPID_PUBLIC) return res.status(503).json({ error: 'Push no configurado' });
  res.json({ key: VAPID_PUBLIC });
});

/* ── PINes ───────────────────────────────────────────────────── */
const PIN_ADMIN = process.env.PIN_ADMIN || '2026';

app.post('/auth/verify-pin', (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ ok: false, error: 'PIN requerido' });
  if (pin === PIN_ADMIN) return res.json({ ok: true, role: 'admin' });
  return res.status(401).json({ ok: false, error: 'PIN incorrecto' });
});

/* ── Google Sheets ───────────────────────────────────────────── */
let sheetsClient = null;
const SHEET_ID   = process.env.GOOGLE_SHEET_ID;

async function initSheets() {
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saJson || !SHEET_ID) { console.warn('⚠️ Google Sheets no configurado'); return; }
  try {
    const credentials = JSON.parse(saJson);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    sheetsClient = google.sheets({ version: 'v4', auth });
    await ensureSheets();
    await loadAlertsFromSheets();
    await loadPushSubsFromSheets();
    console.log('✅ Google Sheets conectado');
  } catch (err) {
    console.error('❌ Google Sheets Error:', err.message);
    sheetsClient = null;
  }
}

/* ── Asegurar hojas y headers ────────────────────────────────── */
async function ensureSheets() {
  if (!sheetsClient) return;
  try {
    // Obtener hojas existentes
    const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const sheetNames = meta.data.sheets.map(s => s.properties.title);

    const requests = [];

    // Crear hoja PushSubs si no existe
    if (!sheetNames.includes('PushSubs')) {
      requests.push({ addSheet: { properties: { title: 'PushSubs' } } });
    }

    if (requests.length > 0) {
      await sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { requests }
      });
    }

    // Headers de Alertas
    const alertsRes = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: 'Alertas!A1:L1'
    });
    if (!alertsRes.data.values || alertsRes.data.values.length === 0) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: 'Alertas!A1', valueInputOption: 'RAW',
        requestBody: { values: [['ID','Fecha','Hora','Tipo','Emisor','Ubicación','Mensaje','Estado','Visto por','Atendido por','Nota resolución','Hora resolución']] }
      });
    }

    // Headers de PushSubs
    const pushRes = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: 'PushSubs!A1:B1'
    });
    if (!pushRes.data.values || pushRes.data.values.length === 0) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: 'PushSubs!A1', valueInputOption: 'RAW',
        requestBody: { values: [['Endpoint','Subscription JSON']] }
      });
    }
  } catch (err) { console.warn('ensureSheets error:', err.message); }
}

/* ── Cargar alertas desde Sheets al arrancar ─────────────────── */
async function loadAlertsFromSheets() {
  if (!sheetsClient) return;
  try {
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: 'Alertas!A2:L'
    });
    const rows = res.data.values || [];
    alertsMemory = rows
      .filter(r => r[0]) // descartar filas vacías
      .map(r => ({
        id:           r[0]  || '',
        date:         r[1]  || '',
        time:         r[2]  || '',
        type:         (r[3] || 'alerta').toLowerCase(),
        sender:       r[4]  || '',
        location:     r[5]  || '',
        message:      r[6]  || '',
        status:       r[7]  || 'activa',
        seen_by:      r[8]  || null,
        resolved_by:  r[9]  || null,
        resolve_note: r[10] || null,
        resolved_at:  r[11] || null,
        created_at:   0 // no usado en memoria, orden por posición
      }))
      .reverse(); // más recientes primero
    console.log(`✅ ${alertsMemory.length} alertas cargadas desde Sheets`);
  } catch (err) { console.warn('loadAlertsFromSheets error:', err.message); }
}

/* ── Cargar push subs desde Sheets al arrancar ───────────────── */
async function loadPushSubsFromSheets() {
  if (!sheetsClient) return;
  try {
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: 'PushSubs!A2:B'
    });
    const rows = res.data.values || [];
    pushSubsMemory = new Map();
    rows.forEach(r => {
      if (r[0] && r[1]) pushSubsMemory.set(r[0], r[1]);
    });
    console.log(`✅ ${pushSubsMemory.size} push subs cargadas desde Sheets`);
  } catch (err) { console.warn('loadPushSubsFromSheets error:', err.message); }
}

/* ── Append alerta a Sheets ──────────────────────────────────── */
async function appendAlertToSheet(alert) {
  if (!sheetsClient) return;
  try {
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: 'Alertas!A:L', valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[
        alert.id, alert.date, alert.time, alert.type.toUpperCase(),
        alert.sender, alert.location, alert.message || '',
        'activa', '', '', '', ''
      ]]}
    });
  } catch (err) { console.warn('appendAlertToSheet error:', err.message); }
}

/* ── Actualizar fila de alerta en Sheets ─────────────────────── */
async function updateSheetRow(alert) {
  if (!sheetsClient) return;
  try {
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: 'Alertas!A:A'
    });
    const rows = res.data.values || [];
    const rowIndex = rows.findIndex(r => r[0] === alert.id);
    if (rowIndex < 0) return;
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Alertas!H${rowIndex + 1}:L${rowIndex + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[
        alert.status,
        alert.seen_by      || '',
        alert.resolved_by  || '',
        alert.resolve_note || '',
        alert.resolved_at  || ''
      ]]}
    });
  } catch (err) { console.warn('updateSheetRow error:', err.message); }
}

/* ── Push subs ───────────────────────────────────────────────── */
app.post('/push-subscribe', async (req, res) => {
  const { subscription } = req.body;
  if (!subscription || !subscription.endpoint) return res.json({ ok: true });
  const endpoint = subscription.endpoint;
  const subJson  = JSON.stringify(subscription);

  // Guardar en memoria
  pushSubsMemory.set(endpoint, subJson);

  // Guardar en Sheets (async, no bloqueante)
  if (sheetsClient) {
    sheetsClient.spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: 'PushSubs!A:A'
    }).then(r => {
      const rows = r.data.values || [];
      const idx = rows.findIndex(row => row[0] === endpoint);
      if (idx < 0) {
        // Nueva suscripción — append
        sheetsClient.spreadsheets.values.append({
          spreadsheetId: SHEET_ID, range: 'PushSubs!A:B', valueInputOption: 'RAW',
          requestBody: { values: [[endpoint, subJson]] }
        }).catch(e => console.warn('push sub append error:', e.message));
      } else {
        // Actualizar existente
        sheetsClient.spreadsheets.values.update({
          spreadsheetId: SHEET_ID, range: `PushSubs!B${idx + 1}`, valueInputOption: 'RAW',
          requestBody: { values: [[subJson]] }
        }).catch(e => console.warn('push sub update error:', e.message));
      }
    }).catch(e => console.warn('push sub read error:', e.message));
  }

  res.json({ ok: true });
});

async function sendPushToAll(alert) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
  const titles = { urgente: '🚨 EMERGENCIA', accidente: '🟣 ACCIDENTE', alerta: '⚠️ ALERTA' };
  const colors  = { urgente: '#ef4444', accidente: '#8b5cf6', alerta: '#f59e0b' };
  const payload = JSON.stringify({
    title: `${titles[alert.type] || '⚠️ ALERTA'} – COLEGIO NSG`,
    body: `${alert.sender} en ${alert.location}`,
    type: alert.type, alertId: alert.id, color: colors[alert.type],
    sender: alert.sender, location: alert.location,
    message: alert.message, date: alert.date, time: alert.time
  });

  const deadEndpoints = [];
  for (const [endpoint, subJson] of pushSubsMemory) {
    try {
      await webpush.sendNotification(JSON.parse(subJson), payload);
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        deadEndpoints.push(endpoint);
      }
    }
  }

  // Limpiar suscripciones expiradas de memoria
  deadEndpoints.forEach(ep => {
    pushSubsMemory.delete(ep);
    // Limpiar de Sheets también (async)
    if (sheetsClient) {
      sheetsClient.spreadsheets.values.get({
        spreadsheetId: SHEET_ID, range: 'PushSubs!A:A'
      }).then(r => {
        const rows = r.data.values || [];
        const idx = rows.findIndex(row => row[0] === ep);
        if (idx >= 0) {
          sheetsClient.spreadsheets.values.clear({
            spreadsheetId: SHEET_ID, range: `PushSubs!A${idx+1}:B${idx+1}`
          }).catch(() => {});
        }
      }).catch(() => {});
    }
  });
}

/* ── API Historial ───────────────────────────────────────────── */
app.get('/api/historial', (req, res) => {
  const { desde, hasta, tipo, estado, limit = 500, pin } = req.query;
  if (pin !== PIN_ADMIN) return res.status(401).json({ ok: false, error: 'No autorizado' });

  let filtered = [...alertsMemory];
  if (desde)  filtered = filtered.filter(a => a.date >= desde);
  if (hasta)  filtered = filtered.filter(a => a.date <= hasta);
  if (tipo)   filtered = filtered.filter(a => a.type === tipo);
  if (estado) filtered = filtered.filter(a => a.status === estado);
  filtered = filtered.slice(0, parseInt(limit));

  res.json({ ok: true, total: filtered.length, alerts: filtered });
});

/* ── Helpers ─────────────────────────────────────────────────── */
function getChileTime() {
  return new Date().toLocaleTimeString('es-CL', {
    timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
  });
}
function getChileDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}
function generateId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

const users = new Map();

/* ── WebSocket ───────────────────────────────────────────────── */
io.on('connection', (socket) => {
  console.log('✅ Conexión:', socket.id);

  socket.on('register', (data) => {
    const name = (data.name || '').trim().slice(0, 50);
    const role = ['emisor', 'admin'].includes(data.role) ? data.role : 'emisor';
    if (!name) return;
    users.set(socket.id, { id: socket.id, name, role, connectedAt: getChileTime() });
    io.emit('users_update', Array.from(users.values()));

    // Sincronizar alertas activas y vistas desde memoria
    const recentAlerts = alertsMemory
      .filter(a => a.status === 'activa' || a.status === 'vista')
      .slice(0, 30);
    socket.emit('alerts_sync', recentAlerts);
  });

  socket.on('send_alert', (data) => {
    const user = users.get(socket.id);
    if (!user || !['emisor', 'admin'].includes(user.role)) return;
    const type = ['urgente', 'accidente', 'alerta'].includes(data.type) ? data.type : 'alerta';
    const alert = {
      id:       generateId(),
      sender:   user.name,
      location: (data.location || 'Sin ubicación').slice(0, 100),
      type,
      message:  (data.message || '').slice(0, 200),
      time:     getChileTime(),
      date:     getChileDate(),
      status:   'activa',
      seen_by:      null,
      resolved_by:  null,
      resolve_note: null,
      resolved_at:  null,
      created_at:   Date.now()
    };

    // Guardar en memoria
    alertsMemory.unshift(alert);

    // Emitir a todos y enviar push
    io.emit('new_alert', alert);
    sendPushToAll(alert);
    console.log(`🚨 [${alert.type.toUpperCase()}] ${user.name} @ ${alert.location}`);

    // Persistir en Sheets (async, no bloquea el tiempo real)
    appendAlertToSheet(alert);
  });

  socket.on('mark_seen', ({ alertId }) => {
    const user = users.get(socket.id);
    if (!user || user.role !== 'admin') return;

    const alert = alertsMemory.find(a => a.id === alertId);
    if (!alert || alert.status !== 'activa') return;

    alert.status   = 'vista';
    alert.seen_by  = user.name;

    io.emit('alert_updated', { ...alert });
    updateSheetRow(alert);
  });

  socket.on('resolve_alert', ({ alertId, note }) => {
    const user = users.get(socket.id);
    if (!user) return; // cualquier rol puede resolver desde el overlay

    const alert = alertsMemory.find(a => a.id === alertId);
    if (!alert || alert.status === 'atendida') return;

    alert.status       = 'atendida';
    alert.resolved_by  = user.name;
    alert.resolve_note = (note || '').slice(0, 300);
    alert.resolved_at  = getChileTime();

    io.emit('alert_updated', { ...alert });
    updateSheetRow(alert);
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      console.log('❌', user.name, 'desconectado');
      users.delete(socket.id);
      io.emit('users_update', Array.from(users.values()));
    }
  });
});

/* ── Arranque ────────────────────────────────────────────────── */
async function start() {
  try {
    await initSheets();
  } catch (err) { console.error('Init error:', err.message); }

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Servidor activo — Puerto ${PORT}`);
    console.log(`Hora Chile: ${getChileTime()}\n`);
  });
}

start();
process.on('SIGTERM', () => server.close(() => process.exit(0)));
