const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.static(path.join(__dirname)));
app.use(express.json());

// Almacenamiento en memoria
const users = new Map();
let alerts = [];

// Función para obtener hora de Chile
function getChileTime() {
  const now = new Date();
  return now.toLocaleTimeString('es-CL', { 
    timeZone: 'America/Santiago',
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit',
    hour12: true 
  });
}

// Función para obtener fecha de Chile
function getChileDate() {
  const now = new Date();
  return now.toLocaleDateString('es-CL', { 
    timeZone: 'America/Santiago',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
}

io.on('connection', (socket) => {
  console.log(`✅ Usuario conectado: ${socket.id}`);

  // Registrar usuario
  socket.on('register', (data) => {
    users.set(socket.id, {
      id: socket.id,
      name: data.name,
      connectedAt: getChileTime()
    });
    
    console.log(`👤 ${data.name} se registró a las ${getChileTime()}`);
    
    // Enviar lista actualizada de usuarios a todos
    io.emit('users_update', Array.from(users.values()));
    
    // Enviar alertas activas al nuevo usuario
    socket.emit('alerts_sync', alerts.filter(a => !a.resolved));
  });

  // Enviar alerta
  socket.on('send_alert', (data) => {
    const user = users.get(socket.id);
    if (!user) return;

    const alert = {
      id: Date.now() + Math.random().toString(36).substr(2, 9),
      sender: user.name,
      type: data.type,
      message: data.message,
      time: getChileTime(),
      date: getChileDate(),
      resolved: false
    };

    alerts.unshift(alert);
    if (alerts.length > 50) alerts = alerts.slice(0, 50);

    console.log(`🚨 ALERTA de ${user.name} a las ${alert.time}: ${alert.message}`);
    
    // Enviar a TODOS los conectados
    io.emit('new_alert', alert);
  });

  // Resolver alerta
  socket.on('resolve_alert', (alertId) => {
    const alert = alerts.find(a => a.id === alertId);
    if (alert) {
      alert.resolved = true;
      console.log(`✓ Alerta ${alertId} resuelta a las ${getChileTime()}`);
      io.emit('alert_resolved', alertId);
    }
  });

  // Desconexión
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
  console.log('🚀 Servidor activo en:');
  console.log(`   Puerto: ${PORT}`);
  console.log(`   Hora Chile: ${getChileTime()}`);
  console.log('\n✅ Listo para recibir conexiones');
});

process.on('SIGTERM', () => {
  console.log(' Cerrando servidor...');
  server.close(() => {
    process.exit(0);
  });
});
