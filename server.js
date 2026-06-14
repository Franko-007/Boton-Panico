/* ──────────────────────────────────────────────────────────────
   BOTÓN DE PÁNICO – COLEGIO NSG  |  server.js  v3.9
   Mejoras v3.9:
   - Tokens de sesión (/auth/login) para que el Service Worker pueda
     responder alertas desde la notificación push aunque la app esté
     cerrada (sin guardar contraseñas en el dispositivo)
   - Nuevos endpoints REST: /api/alerts/:id/false-alarm,
     /api/alerts/:id/resolve (admin), /api/cancel-emergency (admin)
   - Lógica de resolución de alertas unificada (helpers compartidos
     entre Socket.IO y REST)
   Mejoras v3.8:
   - Botón rojo de EMERGENCIA (urgente) restringido a rol "admin"
     (validado también en el servidor, no sólo en el cliente)
   - Nuevo evento "cancel_emergency": admin puede desactivar/resolver
     todas las alertas de emergencia activas con un toque
   Mejoras previas (v3.7):
   - Contraseñas validadas en servidor (no en cliente)
   - Rate limiting en login
   - Turno activo por admin
   - Estado "falsa alarma"
   - Colores automáticos en Google Sheets
   - Keep-alive endpoint
────────────────────────────────────────────────────────────── */
require('dotenv').config();
const crypto     = require('crypto');
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
// Servir explícitamente /.well-known (Express ignora carpetas que
// empiezan con "." por defecto) — necesario para assetlinks.json,
// que Chrome usa para verificar la TWA y delegar notificaciones.
app.use('/.well-known', express.static(path.join(__dirname, '.well-known'), { dotfiles: 'allow' }));
// Servir sonidos de alarma como archivos estáticos (evita embeber base64 en index.html)
app.use('/sounds', express.static(path.join(__dirname, 'sounds'), {
  maxAge: '7d',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.wav')) {
      res.setHeader('Content-Type', 'audio/wav');
    }
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.setHeader('Accept-Ranges', 'bytes');
  }
}));
app.use(express.json());

/* ── Memoria RAM ─────────────────────────────────────────────── */
let alertsMemory  = [];
let pushSubsMemory = new Map();
// Turno activo: Map socketId -> { name, role, since }
const onDuty = new Map();

/* ── Rate limiting simple para login ─────────────────────────── */
const loginAttempts = new Map(); // ip -> { count, resetAt }

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 60000 });
    return true;
  }
  if (entry.count >= 10) return false; // max 10 intentos por minuto
  entry.count++;
  return true;
}

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

/* ── Contraseñas y PINes ─────────────────────────────────────── */
const PIN_ADMIN       = process.env.PIN_ADMIN        || '2026';
const PASS_EMISOR     = process.env.PASS_EMISOR      || 'guadalupe2026';
const PASS_ADMIN      = process.env.PASS_ADMIN       || 'Admin2026';

/* ── Tokens de sesión ─────────────────────────────────────────
   Permiten que el Service Worker responda a las alertas (botones
   de acción en la notificación push: "Falsa alarma" / "Desactivar
   emergencia") aunque la app esté completamente cerrada, sin tener
   que guardar la contraseña del usuario en el dispositivo.
   token -> { name, role, expiresAt }
──────────────────────────────────────────────────────────────── */
const sessionTokens = new Map();
const TOKEN_TTL_MS  = 60 * 24 * 60 * 60 * 1000; // 60 días

function createSessionToken(name, role) {
  const token = crypto.randomBytes(24).toString('hex');
  sessionTokens.set(token, { name, role, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

function requireAuth(roles) {
  return (req, res, next) => {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.body && req.body.token);
    const session = token ? sessionTokens.get(token) : null;
    if (!session || session.expiresAt < Date.now()) {
      return res.status(401).json({ ok: false, error: 'Sesión inválida o expirada' });
    }
    if (roles && !roles.includes(session.role)) {
      return res.status(403).json({ ok: false, error: 'No autorizado' });
    }
    req.session = session;
    next();
  };
}

// Limpieza periódica de tokens expirados
setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessionTokens) if (s.expiresAt < now) sessionTokens.delete(token);
}, 60 * 60 * 1000);

// Endpoint principal de autenticación (valida contraseña + rol en servidor)
app.post('/auth/login', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ ok: false, error: 'Demasiados intentos. Espera 1 minuto.' });
  }
  const { name, password, role } = req.body;
  if (!name || !password || !role) return res.status(400).json({ ok: false, error: 'Datos incompletos' });

  const validRoles = ['emisor', 'admin'];
  if (!validRoles.includes(role)) return res.status(400).json({ ok: false, error: 'Rol inválido' });

  const expectedPass = role === 'admin' ? PASS_ADMIN : PASS_EMISOR;
  if (password !== expectedPass) {
    return res.status(401).json({ ok: false, error: 'Contraseña incorrecta' });
  }
  const token = createSessionToken((name || '').trim().slice(0, 50) || 'Usuario', role);
  return res.json({ ok: true, role, token });
});

// Mantener compatibilidad con verify-pin (usado por historial)
app.post('/auth/verify-pin', (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ ok: false, error: 'PIN requerido' });
  if (pin === PIN_ADMIN) return res.json({ ok: true, role: 'admin' });
  return res.status(401).json({ ok: false, error: 'PIN incorrecto' });
});

/* ── Keep-alive endpoint ─────────────────────────────────────── */
app.get('/ping', (req, res) => res.json({ ok: true, time: getChileTime() }));

/* ── Google Sheets ───────────────────────────────────────────── */
let sheetsClient = null;
const SHEET_ID   = process.env.GOOGLE_SHEET_ID;

// Colores para filas según tipo de alerta
const SHEET_COLORS = {
  urgente:   { red: 0.98, green: 0.80, blue: 0.80 }, // rojo suave
  accidente: { red: 0.88, green: 0.80, blue: 0.98 }, // morado suave
  alerta:    { red: 0.99, green: 0.93, blue: 0.80 }, // naranja suave
};

async function initSheets() {
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saJson || !SHEET_ID) { console.warn('⚠️ Google Sheets no configurado'); return; }
  try {
    const credentials = JSON.parse(saJson);
    const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
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

async function ensureSheets() {
  if (!sheetsClient) return;
  try {
    const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const sheetNames = meta.data.sheets.map(s => s.properties.title);
    const requests = [];
    if (!sheetNames.includes('PushSubs')) {
      requests.push({ addSheet: { properties: { title: 'PushSubs' } } });
    }
    if (requests.length > 0) {
      await sheetsClient.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests } });
    }
    const alertsRes = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Alertas!A1:L1' });
    if (!alertsRes.data.values || alertsRes.data.values.length === 0) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: 'Alertas!A1', valueInputOption: 'RAW',
        requestBody: { values: [['ID','Fecha','Hora','Tipo','Emisor','Ubicación','Mensaje','Estado','Visto por','Atendido por','Nota resolución','Hora resolución']] }
      });
    }
    const pushRes = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'PushSubs!A1:B1' });
    if (!pushRes.data.values || pushRes.data.values.length === 0) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: 'PushSubs!A1', valueInputOption: 'RAW',
        requestBody: { values: [['Endpoint','Subscription JSON']] }
      });
    }
  } catch (err) { console.warn('ensureSheets error:', err.message); }
}

async function loadAlertsFromSheets() {
  if (!sheetsClient) return;
  try {
    const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Alertas!A2:L' });
    const rows = res.data.values || [];
    alertsMemory = rows
      .filter(r => r[0])
      .map(r => ({
        id: r[0]||'', date: r[1]||'', time: r[2]||'',
        type: (r[3]||'alerta').toLowerCase(),
        sender: r[4]||'', location: r[5]||'', message: r[6]||'',
        status: r[7]||'activa', seen_by: r[8]||null,
        resolved_by: r[9]||null, resolve_note: r[10]||null, resolved_at: r[11]||null,
        created_at: 0
      }))
      .reverse();
    console.log(`✅ ${alertsMemory.length} alertas cargadas desde Sheets`);
  } catch (err) { console.warn('loadAlertsFromSheets error:', err.message); }
}

async function loadPushSubsFromSheets() {
  if (!sheetsClient) return;
  try {
    const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'PushSubs!A2:B' });
    const rows = res.data.values || [];
    pushSubsMemory = new Map();
    rows.forEach(r => { if (r[0] && r[1]) pushSubsMemory.set(r[0], r[1]); });
    console.log(`✅ ${pushSubsMemory.size} push subs cargadas`);
  } catch (err) { console.warn('loadPushSubsFromSheets error:', err.message); }
}

async function appendAlertToSheet(alert) {
  if (!sheetsClient) return;
  try {
    // Append fila
    const appendRes = await sheetsClient.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: 'Alertas!A:L', valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[alert.id, alert.date, alert.time, alert.type.toUpperCase(), alert.sender, alert.location, alert.message||'', 'activa', '', '', '', '']] },
      includeValuesInResponse: false
    });

    // Colorear fila según tipo
    const color = SHEET_COLORS[alert.type] || SHEET_COLORS.alerta;
    const updatedRange = appendRes.data.updates?.updatedRange || '';
    const rowMatch = updatedRange.match(/(\d+)$/);
    if (rowMatch && sheetsClient) {
      const rowNum = parseInt(rowMatch[1]);
      // Obtener sheetId de la hoja Alertas
      const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: SHEET_ID });
      const alertSheet = meta.data.sheets.find(s => s.properties.title === 'Alertas');
      if (alertSheet) {
        await sheetsClient.spreadsheets.batchUpdate({
          spreadsheetId: SHEET_ID,
          requestBody: {
            requests: [{
              repeatCell: {
                range: { sheetId: alertSheet.properties.sheetId, startRowIndex: rowNum-1, endRowIndex: rowNum, startColumnIndex: 0, endColumnIndex: 12 },
                cell: { userEnteredFormat: { backgroundColor: color } },
                fields: 'userEnteredFormat.backgroundColor'
              }
            }]
          }
        });
      }
    }
  } catch (err) { console.warn('appendAlertToSheet error:', err.message); }
}

async function updateSheetRow(alert) {
  if (!sheetsClient) return;
  try {
    const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Alertas!A:A' });
    const rows = res.data.values || [];
    const rowIndex = rows.findIndex(r => r[0] === alert.id);
    if (rowIndex < 0) return;
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `Alertas!H${rowIndex+1}:L${rowIndex+1}`, valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[alert.status, alert.seen_by||'', alert.resolved_by||'', alert.resolve_note||'', alert.resolved_at||'']] }
    });
  } catch (err) { console.warn('updateSheetRow error:', err.message); }
}

/* ── Push subs ───────────────────────────────────────────────── */
app.post('/push-subscribe', async (req, res) => {
  const { subscription } = req.body;
  if (!subscription || !subscription.endpoint) return res.json({ ok: true });
  const endpoint = subscription.endpoint;
  const subJson  = JSON.stringify(subscription);
  pushSubsMemory.set(endpoint, subJson);
  if (sheetsClient) {
    sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'PushSubs!A:A' })
      .then(r => {
        const rows = r.data.values || [];
        const idx  = rows.findIndex(row => row[0] === endpoint);
        if (idx < 0) {
          sheetsClient.spreadsheets.values.append({ spreadsheetId: SHEET_ID, range: 'PushSubs!A:B', valueInputOption: 'RAW', requestBody: { values: [[endpoint, subJson]] } }).catch(() => {});
        } else {
          sheetsClient.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `PushSubs!B${idx+1}`, valueInputOption: 'RAW', requestBody: { values: [[subJson]] } }).catch(() => {});
        }
      }).catch(() => {});
  }
  res.json({ ok: true });
});

async function sendPushToAll(alert) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
  const titles = { urgente: '🚨 EMERGENCIA', accidente: '🟣 ACCIDENTE', alerta: '⚠️ ALERTA' };
  const colors  = { urgente: '#ef4444', accidente: '#8b5cf6', alerta: '#f59e0b' };
  // El campo "channel" permite que el DelegationService del APK enrute
  // la notificación al canal nativo correcto (emergencia vs alerta normal).
  const channels = { urgente: 'nsg_emergency', accidente: 'nsg_alert', alerta: 'nsg_alert' };
  const payload = JSON.stringify({
    title: `${titles[alert.type]||'⚠️ ALERTA'} – COLEGIO NSG`,
    body: `${alert.sender} en ${alert.location}`,
    type: alert.type, alertId: alert.id, color: colors[alert.type],
    channel: channels[alert.type] || 'nsg_alert',
    sender: alert.sender, location: alert.location, message: alert.message, date: alert.date, time: alert.time
  });
  const dead = [];
  for (const [endpoint, subJson] of pushSubsMemory) {
    try { await webpush.sendNotification(JSON.parse(subJson), payload); }
    catch (err) { if (err.statusCode === 410 || err.statusCode === 404) dead.push(endpoint); }
  }
  dead.forEach(ep => pushSubsMemory.delete(ep));
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

/* ── Turno activo API ────────────────────────────────────────── */
app.get('/api/duty', (req, res) => {
  res.json({ ok: true, onDuty: Array.from(onDuty.values()) });
});

/* ── Helpers ─────────────────────────────────────────────────── */
function getChileTime() {
  return new Date().toLocaleTimeString('es-CL', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
}
function getChileDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function generateId() { return `${Date.now()}-${Math.random().toString(36).substr(2,9)}`; }

/* ── Acciones sobre alertas (compartidas entre Socket.IO y REST) ─
   Las usan tanto la app abierta (vía socket) como las acciones de
   las notificaciones push (vía REST, app cerrada).
──────────────────────────────────────────────────────────────── */
function markAlertResolved(alertId, userName, note) {
  const alert = alertsMemory.find(a => a.id === alertId);
  if (!alert || alert.status === 'atendida' || alert.status === 'falsa_alarma') return null;
  alert.status       = 'atendida';
  alert.resolved_by  = userName;
  alert.resolve_note = (note || '').slice(0, 300);
  alert.resolved_at  = getChileTime();
  io.emit('alert_updated', { ...alert });
  updateSheetRow(alert);
  return alert;
}

function markAlertFalseAlarm(alertId, userName) {
  const alert = alertsMemory.find(a => a.id === alertId);
  if (!alert || alert.status === 'atendida' || alert.status === 'falsa_alarma') return null;
  alert.status       = 'falsa_alarma';
  alert.resolved_by  = userName;
  alert.resolve_note = 'Falsa alarma';
  alert.resolved_at  = getChileTime();
  io.emit('alert_updated', { ...alert });
  updateSheetRow(alert);
  return alert;
}

function cancelAllEmergencies(userName) {
  const affected = alertsMemory.filter(a =>
    a.type === 'urgente' && a.status !== 'atendida' && a.status !== 'falsa_alarma'
  );
  affected.forEach(alert => {
    alert.status       = 'atendida';
    alert.resolved_by  = userName;
    alert.resolve_note = 'Emergencia desactivada por administrador';
    alert.resolved_at  = getChileTime();
    io.emit('alert_updated', { ...alert });
    updateSheetRow(alert);
  });
  return affected;
}

/* ── Acciones rápidas desde notificación push (app cerrada) ──────
   Requieren un token de sesión emitido en /auth/login (ver arriba).
──────────────────────────────────────────────────────────────── */
app.post('/api/alerts/:id/false-alarm', requireAuth(['emisor','admin']), (req, res) => {
  const alert = markAlertFalseAlarm(req.params.id, req.session.name);
  if (!alert) return res.json({ ok: true, changed: false });
  res.json({ ok: true, changed: true });
});

app.post('/api/alerts/:id/resolve', requireAuth(['admin']), (req, res) => {
  const alert = markAlertResolved(req.params.id, req.session.name, req.body && req.body.note ? req.body.note : 'Atendido desde notificación');
  if (!alert) return res.json({ ok: true, changed: false });
  res.json({ ok: true, changed: true });
});

app.post('/api/cancel-emergency', requireAuth(['admin']), (req, res) => {
  const affected = cancelAllEmergencies(req.session.name);
  res.json({ ok: true, affected: affected.length });
});

const users = new Map();

/* ── WebSocket ───────────────────────────────────────────────── */
io.on('connection', (socket) => {
  console.log('✅ Conexión:', socket.id);

  socket.on('register', (data) => {
    const name = (data.name||'').trim().slice(0,50);
    const role = ['emisor','admin'].includes(data.role) ? data.role : 'emisor';
    if (!name) return;
    users.set(socket.id, { id: socket.id, name, role, connectedAt: getChileTime() });
    io.emit('users_update', Array.from(users.values()));
    io.emit('duty_update', Array.from(onDuty.values()));
    const recentAlerts = alertsMemory.filter(a => a.status === 'activa' || a.status === 'vista').slice(0,30);
    socket.emit('alerts_sync', recentAlerts);
  });

  socket.on('send_alert', (data) => {
    const user = users.get(socket.id);
    if (!user || !['emisor','admin'].includes(user.role)) return;
    let type = ['urgente','accidente','alerta'].includes(data.type) ? data.type : 'alerta';
    // Seguridad: el botón rojo de EMERGENCIA (urgente) sólo puede ser
    // activado por usuarios con rol "admin". Si un emisor intenta
    // enviar 'urgente' (manipulando el cliente), se reduce a 'alerta'.
    if (type === 'urgente' && user.role !== 'admin') {
      type = 'alerta';
    }
    const alert = {
      id: generateId(), sender: user.name,
      location: (data.location||'Sin ubicación').slice(0,100),
      type, message: (data.message||'').slice(0,200),
      time: getChileTime(), date: getChileDate(),
      status: 'activa', seen_by: null, resolved_by: null, resolve_note: null, resolved_at: null, created_at: Date.now()
    };
    alertsMemory.unshift(alert);
    io.emit('new_alert', alert);
    sendPushToAll(alert);
    console.log(`🚨 [${alert.type.toUpperCase()}] ${user.name} @ ${alert.location}`);
    appendAlertToSheet(alert);
  });

  socket.on('mark_seen', ({ alertId }) => {
    const user = users.get(socket.id);
    if (!user || user.role !== 'admin') return;
    const alert = alertsMemory.find(a => a.id === alertId);
    if (!alert || alert.status !== 'activa') return;
    alert.status  = 'vista';
    alert.seen_by = user.name;
    io.emit('alert_updated', { ...alert });
    updateSheetRow(alert);
  });

  socket.on('resolve_alert', ({ alertId, note }) => {
    const user = users.get(socket.id);
    if (!user) return;
    markAlertResolved(alertId, user.name, note);
  });

  // Nuevo: marcar como falsa alarma
  socket.on('false_alarm', ({ alertId }) => {
    const user = users.get(socket.id);
    if (!user) return; // cualquier rol puede marcar falsa alarma
    markAlertFalseAlarm(alertId, user.name);
  });

  // Desactivar EMERGENCIA: sólo admin. Resuelve TODAS las alertas
  // "urgente" activas/vistas de una sola vez (botón rojo OFF).
  socket.on('cancel_emergency', () => {
    const user = users.get(socket.id);
    if (!user || user.role !== 'admin') return;
    cancelAllEmergencies(user.name);
  });

  // Turno activo
  socket.on('toggle_duty', () => {
    const user = users.get(socket.id);
    if (!user) return;
    if (onDuty.has(socket.id)) {
      onDuty.delete(socket.id);
    } else {
      onDuty.set(socket.id, { name: user.name, role: user.role, since: getChileTime() });
    }
    io.emit('duty_update', Array.from(onDuty.values()));
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      console.log('❌', user.name, 'desconectado');
      users.delete(socket.id);
      onDuty.delete(socket.id);
      io.emit('users_update', Array.from(users.values()));
      io.emit('duty_update', Array.from(onDuty.values()));
    }
  });
});

async function start() {
  try { await initSheets(); } catch (err) { console.error('Init error:', err.message); }
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Servidor activo — Puerto ${PORT}`);
    console.log(`Hora Chile: ${getChileTime()}\n`);
  });
}
start();
process.on('SIGTERM', () => server.close(() => process.exit(0)));
