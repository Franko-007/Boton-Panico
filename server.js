/* ──────────────────────────────────────────────────────────────
   BOTÓN DE PÁNICO – COLEGIO NSG  |  server.js  v3.4 (fix 2026)
   Base de datos: SQLite local (alerts.db) + Google Sheets
   Correcciones:
   - IDs de alerta sin punto flotante (bug #1)
   - Fecha Chile en formato ISO yyyy-mm-dd para filtros SQL correctos (bug #8)
   - Validación de rol en send_alert, mark_seen, resolve_alert (bugs #5,6,7)
   - initSheets() correctamente awaited (bug #3)
   - manifest.json: purpose como array (bug #13)
   - serviceworker.js: tag por alertId, sin setTimeout frágil (bugs #11,12)
────────────────────────────────────────────────────────────── */
require('dotenv').config();
const express      = require('express');
const http         = require('http');
const { Server }   = require('socket.io');
const path         = require('path');
const webpush      = require('web-push');
const Database     = require('better-sqlite3');
const { google }   = require('googleapis');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(express.static(path.join(__dirname)));
app.use(express.json());

/* ── SQLite Local ────────────────────────────────────────────── */
const db = new Database('./alerts.db');
db.pragma('journal_mode = WAL');

function initDB() {
  db.exec(`CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    sender TEXT NOT NULL,
    location TEXT NOT NULL,
    type TEXT NOT NULL,
    message TEXT DEFAULT '',
    time TEXT NOT NULL,
    date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'activa',
    seen_by TEXT DEFAULT NULL,
    resolved_by TEXT DEFAULT NULL,
    resolve_note TEXT DEFAULT NULL,
    resolved_at TEXT DEFAULT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS push_subs (
    endpoint TEXT PRIMARY KEY,
    sub_json TEXT NOT NULL
  )`);

  console.log('✅ SQLite: tablas listas');
}

/* ── VAPID (Web Push) ────────────────────────────────────────── */
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;
const VAPID_EMAIL   = process.env.VAPID_EMAIL || 'mailto:admin@colegio-nsg.cl';
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
  console.log('✅ VAPID configurado');
} else {
  console.warn('⚠️  VAPID no configurado. Las notificaciones push no funcionarán.');
}

app.get('/vapid-public-key', (req, res) => {
  if (!VAPID_PUBLIC) return res.status(503).json({ error: 'Push no configurado' });
  res.json({ key: VAPID_PUBLIC });
});

/* ── PINes ───────────────────────────────────────────────────── */
const PIN_EMISOR = process.env.PIN_EMISOR || '1234';
const PIN_ADMIN  = process.env.PIN_ADMIN  || '2026';

app.post('/auth/verify-pin', (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ ok: false, error: 'PIN requerido' });
  if (pin === PIN_ADMIN)  return res.json({ ok: true, role: 'admin' });
  if (pin === PIN_EMISOR) return res.json({ ok: true, role: 'emisor' });
  return res.status(401).json({ ok: false, error: 'PIN incorrecto' });
});

/* ── Google Sheets ───────────────────────────────────────────── */
let sheetsClient = null;
const SHEET_ID   = process.env.GOOGLE_SHEET_ID;

async function initSheets() {
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saJson || !SHEET_ID) {
    console.warn('⚠️ Google Sheets no configurado en .env');
    return;
  }
  try {
    const credentials = JSON.parse(saJson);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    sheetsClient = google.sheets({ version: 'v4', auth });
    await ensureSheetHeaders();
    console.log('✅ Google Sheets conectado');
  } catch (err) {
    console.error('❌ Google Sheets Error:', err.message);
    sheetsClient = null; // Asegurarse de que quede null si falla
  }
}

async function ensureSheetHeaders() {
  if (!sheetsClient) return;
  try {
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Alertas!A1:K1'
    });
    if (!res.data.values || res.data.values.length === 0) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: 'Alertas!A1',
        valueInputOption: 'RAW',
        requestBody: {
          values: [['ID','Fecha','Hora','Tipo','Emisor','Ubicación','Mensaje','Estado','Visto por','Atendido por','Nota resolución']]
        }
      });
    }
  } catch (err) {
    console.warn('Headers Sheet:', err.message);
  }
}

async function appendAlertToSheet(alert) {
  if (!sheetsClient) return;
  try {
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Alertas!A:K',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          alert.id, alert.date, alert.time,
          alert.type.toUpperCase(), alert.sender,
          alert.location, alert.message || '',
          'activa', '', '', ''
        ]]
      }
    });
  } catch (err) {
    console.warn('Append Sheet:', err.message);
  }
}

async function updateSheetRow(alert) {
  if (!sheetsClient) return;
  try {
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Alertas!A:A'
    });
    const rows = res.data.values || [];
    const rowIndex = rows.findIndex(r => r[0] === alert.id);
    if (rowIndex < 0) return;
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Alertas!H${rowIndex + 1}:K${rowIndex + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[alert.status, alert.seen_by || '', alert.resolved_by || '', alert.resolve_note || '']]
      }
    });
  } catch (err) {
    console.warn('Update Sheet:', err.message);
  }
}

/* ── Push ────────────────────────────────────────────────────── */
app.post('/push-subscribe', (req, res) => {
  const { subscription } = req.body;
  if (subscription && subscription.endpoint) {
    try {
      db.prepare('INSERT OR REPLACE INTO push_subs (endpoint, sub_json) VALUES (?, ?)')
        .run(subscription.endpoint, JSON.stringify(subscription));
    } catch (err) {
      console.error('Error guardando suscripción:', err.message);
    }
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
    type: alert.type, alertId: alert.id,
    color: colors[alert.type],
    sender: alert.sender, location: alert.location,
    message: alert.message, date: alert.date, time: alert.time
  });

  try {
    const subs = db.prepare('SELECT * FROM push_subs').all();
    for (const row of subs) {
      try {
        const sub = JSON.parse(row.sub_json);
        await webpush.sendNotification(sub, payload);
      } catch (err) {
        // FIX: limpiar suscripciones expiradas o inválidas
        if (err.statusCode === 410 || err.statusCode === 404) {
          db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(row.endpoint);
          console.log('🗑️ Suscripción push eliminada (expirada):', row.endpoint.slice(0, 60) + '...');
        } else {
          console.warn('Push send error:', err.message);
        }
      }
    }
  } catch (err) {
    console.error('Error al enviar Push:', err.message);
  }
}

/* ── API Historial ───────────────────────────────────────────── */
// FIX: validación básica de PIN admin para proteger el historial
app.get('/api/historial', (req, res) => {
  const { desde, hasta, tipo, estado, limit = 200, pin } = req.query;

  // Verificar PIN de admin para acceder al historial
  if (pin !== PIN_ADMIN) {
    return res.status(401).json({ ok: false, error: 'No autorizado' });
  }

  let sql = 'SELECT * FROM alerts WHERE 1=1';
  const args = [];
  if (desde)  { sql += ' AND date >= ?'; args.push(desde); }
  if (hasta)  { sql += ' AND date <= ?'; args.push(hasta); }
  if (tipo)   { sql += ' AND type = ?';  args.push(tipo); }
  if (estado) { sql += ' AND status = ?'; args.push(estado); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  args.push(parseInt(limit));

  try {
    const alerts = db.prepare(sql).all(...args);
    res.json({ ok: true, total: alerts.length, alerts });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ─ Helpers ─────────────────────────────────────────────────── */
function getChileTime() {
  return new Date().toLocaleTimeString('es-CL', {
    timeZone: 'America/Santiago',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: true
  });
}

// FIX: formato ISO yyyy-mm-dd para que los filtros SQL >=/<= ordenen correctamente
function getChileDate() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
  return parts; // Devuelve "2026-05-22"
}

// FIX: generador de ID sin punto flotante
function generateId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

const users = new Map();

/* ─ WebSocket ───────────────────────────────────────────────── */
io.on('connection', (socket) => {
  console.log('✅ Conexión:', socket.id);

  socket.on('register', (data) => {
    const name = (data.name || '').trim().slice(0, 50);
    const role = ['emisor', 'admin'].includes(data.role) ? data.role : 'emisor';
    if (!name) return;
    users.set(socket.id, { id: socket.id, name, role, connectedAt: getChileTime() });
    io.emit('users_update', Array.from(users.values()));
    try {
      const recentAlerts = db.prepare(
        "SELECT * FROM alerts WHERE status IN ('activa','vista') ORDER BY created_at DESC LIMIT 30"
      ).all();
      socket.emit('alerts_sync', recentAlerts);
    } catch (err) {
      console.error('alerts_sync error:', err.message);
    }
  });

  // FIX: validar que el usuario esté registrado y tenga rol válido antes de emitir
  socket.on('send_alert', (data) => {
    const user = users.get(socket.id);
    if (!user) return;
    if (!['emisor', 'admin'].includes(user.role)) return;

    const type = ['urgente', 'accidente', 'alerta'].includes(data.type) ? data.type : 'alerta';
    const alert = {
      id: generateId(), // FIX: ID sin punto flotante
      sender: user.name,
      location: (data.location || 'Sin ubicación').slice(0, 100),
      type,
      message: (data.message || '').slice(0, 200),
      time: getChileTime(),
      date: getChileDate(), // FIX: formato ISO
      status: 'activa'
    };

    io.emit('new_alert', alert);
    sendPushToAll(alert);
    console.log(`🚨 [${alert.type.toUpperCase()}] ${user.name} @ ${alert.location} — ${alert.time}`);

    try {
      db.prepare(
        'INSERT INTO alerts (id,sender,location,type,message,time,date,status) VALUES (?,?,?,?,?,?,?,?)'
      ).run(alert.id, alert.sender, alert.location, alert.type, alert.message, alert.time, alert.date, 'activa');
      appendAlertToSheet(alert);
    } catch (err) {
      console.error('insert alert error:', err.message);
    }
  });

  // FIX: solo admins pueden marcar como vista
  socket.on('mark_seen', ({ alertId }) => {
    const user = users.get(socket.id);
    if (!user || user.role !== 'admin') return;
    try {
      const row = db.prepare('SELECT * FROM alerts WHERE id=?').get(alertId);
      if (!row || row.status !== 'activa') return;
      db.prepare("UPDATE alerts SET status='vista', seen_by=? WHERE id=?").run(user.name, alertId);
      const updated = db.prepare('SELECT * FROM alerts WHERE id=?').get(alertId);
      io.emit('alert_updated', updated);
      updateSheetRow(updated);
    } catch (err) {
      console.error('mark_seen error:', err.message);
    }
  });

  // FIX: solo admins pueden resolver
  socket.on('resolve_alert', ({ alertId, note }) => {
    const user = users.get(socket.id);
    if (!user || user.role !== 'admin') return;
    try {
      const row = db.prepare('SELECT * FROM alerts WHERE id=?').get(alertId);
      if (!row || row.status === 'atendida') return;
      db.prepare(
        "UPDATE alerts SET status='atendida', resolved_by=?, resolve_note=?, resolved_at=? WHERE id=?"
      ).run(user.name, (note || '').slice(0, 300), getChileTime(), alertId);
      const updated = db.prepare('SELECT * FROM alerts WHERE id=?').get(alertId);
      io.emit('alert_updated', updated);
      updateSheetRow(updated);
    } catch (err) {
      console.error('resolve_alert error:', err.message);
    }
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

/* ─ Arranque ────────────────────────────────────────────────── */
async function start() {
  try {
    initDB();
    await initSheets(); // FIX: await correcto para capturar errores de Sheets
  } catch (err) {
    console.error('Init error:', err.message);
  }
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Servidor activo — Puerto ${PORT}`);
    console.log(`Hora Chile: ${getChileTime()}\n`);
  });
}

start();
process.on('SIGTERM', () => server.close(() => process.exit(0)));
