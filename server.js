/* ──────────────────────────────────────────────────────────────
   BOTÓN DE PÁNICO – COLEGIO NSG  |  server.js  v3.3 (Admin 2026)
   Base de datos: SQLite local (alerts.db)
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
    id TEXT PRIMARY KEY, sender TEXT NOT NULL, location TEXT NOT NULL, type TEXT NOT NULL,
    message TEXT DEFAULT '', time TEXT NOT NULL, date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'activa', seen_by TEXT DEFAULT NULL,
    resolved_by TEXT DEFAULT NULL, resolve_note TEXT DEFAULT NULL,
    resolved_at TEXT DEFAULT NULL, created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  )`);
  console.log('✅ SQLite: tabla alerts lista');
}

/* ── VAPID ───────────────────────────────────────────────────── */
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;
const VAPID_EMAIL   = process.env.VAPID_EMAIL || 'mailto:admin@colegio-nsg.cl';
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
  console.log('✅ VAPID configurado');
} else {
  console.warn('⚠️  VAPID no configurado');
}
app.get('/vapid-public-key', (req, res) => {
  if (!VAPID_PUBLIC) return res.status(503).json({ error: 'Push no configurado' });
  res.json({ key: VAPID_PUBLIC });
});

/* ── PINes ───────────────────────────────────────────────────── */
const PIN_EMISOR = process.env.PIN_EMISOR || '1234';
const PIN_ADMIN  = process.env.PIN_ADMIN  || '2026'; // ✅ PIN Admin actualizado

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
  if (!saJson || !SHEET_ID) return;
  try {
    const credentials = JSON.parse(saJson);
    const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    sheetsClient = google.sheets({ version: 'v4', auth });
    await ensureSheetHeaders();
    console.log('✅ Google Sheets conectado');
  } catch (err) { console.error('❌ Google Sheets:', err.message); }
}
async function ensureSheetHeaders() {
  if (!sheetsClient) return;
  try {
    const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Alertas!A1:K1' });
    if (!res.data.values || res.data.values.length === 0) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: 'Alertas!A1', valueInputOption: 'RAW',
        requestBody: { values: [['ID','Fecha','Hora','Tipo','Emisor','Ubicación','Mensaje','Estado','Visto por','Atendido por','Nota resolución']] }
      });
    }
  } catch (err) { console.warn('Headers Sheet:', err.message); }
}
async function appendAlertToSheet(alert) {
  if (!sheetsClient) return;
  try {
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: 'Alertas!A:K', valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[alert.id, alert.date, alert.time, alert.type.toUpperCase(), alert.sender, alert.location, alert.message || '', 'activa', '', '', '']] }
    });
  } catch (err) { console.warn('Append Sheet:', err.message); }
}
async function updateSheetRow(alert) {
  if (!sheetsClient) return;
  try {
    const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Alertas!A:A' });
    const rows = res.data.values || [];
    const rowIndex = rows.findIndex(r => r[0] === alert.id);
    if (rowIndex < 0) return;
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `Alertas!H${rowIndex + 1}:K${rowIndex + 1}`, valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[alert.status, alert.seen_by || '', alert.resolved_by || '', alert.resolve_note || '']] }
    });
  } catch (err) { console.warn('Update Sheet:', err.message); }
}

/* ── Push ────────────────────────────────────────────────────── */
const pushSubscriptions = new Map();
app.post('/push-subscribe', (req, res) => {
  const { socketId, subscription } = req.body;
  if (socketId && subscription) pushSubscriptions.set(socketId, subscription);
  res.json({ ok: true });
});
app.delete('/push-subscribe', (req, res) => {
  const { socketId } = req.body;
  if (socketId) pushSubscriptions.delete(socketId);
  res.json({ ok: true });
});
async function sendPushToAll(alert) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
  const titles = { urgente: '🚨 EMERGENCIA', accidente: '🟣 ACCIDENTE', alerta: '⚠️ ALERTA' };
  const colors = { urgente: '#ef4444', accidente: '#8b5cf6', alerta: '#f59e0b' };
  const payload = JSON.stringify({
    title: `${titles[alert.type] || '⚠️ ALERTA'} – COLEGIO NSG`,
    body: `${alert.sender} en ${alert.location}`,
    type: alert.type, alertId: alert.id, color: colors[alert.type],
    sender: alert.sender, location: alert.location,
    message: alert.message, date: alert.date, time: alert.time
  });
  const dead = [];
  for (const [socketId, sub] of pushSubscriptions.entries()) {
    try { await webpush.sendNotification(sub, payload); }
    catch (err) { if (err.statusCode === 410 || err.statusCode === 404) dead.push(socketId); }
  }
  dead.forEach(id => pushSubscriptions.delete(id));
}

/* ── API Historial ───────────────────────────────────────────── */
app.get('/api/historial', (req, res) => {
  const { desde, hasta, tipo, estado, limit = 200 } = req.query;
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
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

/* ─ Health ──────────────────────────────────────────────────── */
const startTime = Date.now();
app.get('/health', (req, res) => {
  const up = Math.floor((Date.now() - startTime) / 1000);
  const h = Math.floor(up / 3600), m = Math.floor((up % 3600) / 60), s = up % 60;
  try {
    const active = db.prepare("SELECT COUNT() as n FROM alerts WHERE status != 'atendida'").get().n;
    const total  = db.prepare("SELECT COUNT() as n FROM alerts").get().n;
    res.json({
      ok: true, status: 'online', uptime: `${h}h ${m}m ${s}s`,
      time: getChileTime(), date: getChileDate(), connected: users.size,
      alerts: { active, total }, push: { configured: !!(VAPID_PUBLIC && VAPID_PRIVATE), subscribers: pushSubscriptions.size },
      sheets: { configured: !!sheetsClient }, db: 'sqlite-local'
    });
  } catch (err) { res.status(503).json({ ok: false, status: 'db_error', error: err.message }); }
});

/* ─ Helpers ─────────────────────────────────────────────────── */
function getChileTime() {
  return new Date().toLocaleTimeString('es-CL', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
}
function getChileDate() {
  return new Date().toLocaleDateString('es-CL', { timeZone: 'America/Santiago', day: '2-digit', month: '2-digit', year: 'numeric' });
}
const users = new Map();

/* ─ WebSocket ───────────────────────────────────────────────── */
io.on('connection', (socket) => {
  console.log('✅ Conexión:', socket.id);
  socket.on('register', (data) => {
    const name = (data.name || '').trim().slice(0, 50);
    const role = ['emisor','admin'].includes(data.role) ? data.role : 'emisor';
    if (!name) return;
    users.set(socket.id, { id: socket.id, name, role, connectedAt: getChileTime() });
    io.emit('users_update', Array.from(users.values()));
    try {
      const recentAlerts = db.prepare("SELECT * FROM alerts WHERE status IN ('activa','vista') ORDER BY created_at DESC LIMIT 30").all();
      socket.emit('alerts_sync', recentAlerts);
    } catch(err) { console.error('alerts_sync error:', err.message); }
  });
  
  socket.on('send_alert', (data) => {
    const user = users.get(socket.id);
    if (!user) return;
    const type = ['urgente','accidente','alerta'].includes(data.type) ? data.type : 'alerta';
    const alert = {
      id: Date.now() + Math.random().toString(36).substr(2, 9),
      sender: user.name, location: (data.location || 'Sin ubicación').slice(0, 100),
      type, message: (data.message || '').slice(0, 200), time: getChileTime(), date: getChileDate(), status: 'activa'
    };
    
    // Emitir inmediatamente
    io.emit('new_alert', alert);
    sendPushToAll(alert);
    console.log(`🚨 [${alert.type.toUpperCase()}] ${user.name} @ ${alert.location} — ${alert.time}`);
    
    // Guardar en background
    try {
      db.prepare('INSERT INTO alerts (id,sender,location,type,message,time,date,status) VALUES (?,?,?,?,?,?,?,?)')
        .run(alert.id, alert.sender, alert.location, alert.type, alert.message, alert.time, alert.date, 'activa');
      appendAlertToSheet(alert);
    } catch(err) { console.error('insert alert error:', err.message); }
  });

  socket.on('mark_seen', ({ alertId }) => {
    const user = users.get(socket.id);
    if (!user) return;
    try {
      const row = db.prepare('SELECT * FROM alerts WHERE id=?').get(alertId);
      if (!row || row.status !== 'activa') return;
      db.prepare("UPDATE alerts SET status='vista', seen_by=? WHERE id=?").run(user.name, alertId);
      const updated = db.prepare('SELECT * FROM alerts WHERE id=?').get(alertId);
      io.emit('alert_updated', updated);
      updateSheetRow(updated);
    } catch(err) { console.error('mark_seen error:', err.message); }
  });
  
  socket.on('resolve_alert', ({ alertId, note }) => {
    const user = users.get(socket.id);
    if (!user) return;
    try {
      const row = db.prepare('SELECT * FROM alerts WHERE id=?').get(alertId);
      if (!row || row.status === 'atendida') return;
      db.prepare("UPDATE alerts SET status='atendida', resolved_by=?, resolve_note=?, resolved_at=? WHERE id=?")
        .run(user.name, (note || '').slice(0, 300), getChileTime(), alertId);
      const updated = db.prepare('SELECT * FROM alerts WHERE id=?').get(alertId);
      io.emit('alert_updated', updated);
      updateSheetRow(updated);
    } catch(err) { console.error('resolve_alert error:', err.message); }
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
function start() {
  try { initDB(); initSheets(); } catch(err) { console.error('Init error:', err.message); }
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Servidor activo — Puerto ${PORT}`);
    console.log(`Hora Chile: ${getChileTime()}\n`);
  });
}
start();
process.on('SIGTERM', () => server.close(() => process.exit(0)));
