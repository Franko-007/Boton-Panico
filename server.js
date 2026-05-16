const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(path.join(__dirname)));
app.use(express.json());

const users = new Map();
let alerts = [];

function getChileTime() {
  return new Date().toLocaleTimeString('es-CL', {
    timeZone: 'America/Santiago',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
  });
}
function getChileDate() {
  return new Date().toLocaleDateString('es-CL', {
    timeZone: 'America/Santiago',
    day: '2-digit', month: '2-digit', year: 'numeric'
  });
}

io.on('connection', (socket) => {
  console.log(`✅ Conexión: ${socket.id}`);

  socket.on('register', (data) => {
    const name = (data.name || '').trim().slice(0, 50);
    if (!name) return;

    const alreadyRegistered = users.has(socket.id);
    users.set(socket.id, {
      id:          socket.id,
      name,
      connectedAt: getChileTime()
    });

    if (!alreadyRegistered) {
      console.log(`👤 ${name} se ha conectado a las ${getChileTime()}`);
    }

    io.emit('users_update', Array.from(users.values()));
    socket.emit('alerts_sync', alerts.filter(a => !a.resolved));
  });

  socket.on('send_alert', (data) => {
    const user = users.get(socket.id);
    if (!user) return;

    const validTypes = ['urgente', 'alerta'];
    const type = validTypes.includes(data.type) ? data.type : 'alerta';

    const alert = {
      id:       Date.now() + Math.random().toString(36).substr(2, 9),
      sender:   user.name,
      location: (data.location || 'Sin ubicación').slice(0, 100),
      type,
      message:  (data.message || '').slice(0, 200),
      time:     getChileTime(),
      date:     getChileDate(),
      resolved: false
    };

    alerts.unshift(alert);
    if (alerts.length > 50) alerts = alerts.slice(0, 50);

    console.log(`🚨 ${user.name} [${alert.location}] → ${alert.message} a las ${alert.time}`);
    io.emit('new_alert', alert);
  });

  socket.on('resolve_alert', (alertId) => {
    const alert = alerts.find(a => a.id === alertId);
    if (alert) {
      alert.resolved = true;
      console.log(`✓ Alerta ${alertId} resuelta a las ${getChileTime()}`);
      io.emit('alert_resolved', alertId);
    }
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      console.log(`❌ ${user.name} se desconectó`);
      users.delete(socket.id);
      io.emit('users_update', Array.from(users.values()));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Servidor activo — Puerto ${PORT}`);
  console.log(`   Hora Chile: ${getChileTime()}`);
  console.log('✅ Listo para conexiones\n');
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
