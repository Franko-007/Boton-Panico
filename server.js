const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

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

// Almacenamiento en memoria (para producción usar base de datos)
const users = new Map();
let alerts = [];

io.on('connection', (socket) => {
  console.log(`✅ Usuario conectado: ${socket.id}`);

  // Registrar usuario
  socket.on('register', (data) => {
    users.set(socket.id, {
      id: socket.id,
      name: data.name,
      connectedAt: new Date().toISOString()
    });
    
    console.log(`👤 ${data.name} se registró`);
    
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
      type: data.type, // 'urgente' o 'alerta'
      message: data.message,
      timestamp: new Date().toLocaleTimeString('es-CL', { 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit' 
      }),
      resolved: false
    };

    alerts.unshift(alert);
    // Mantener solo últimas 50 alertas
    if (alerts.length > 50) alerts = alerts.slice(0, 50);

    console.log(`🚨 ALERTA de ${user.name}: ${alert.message}`);
    
    // Enviar a TODOS los conectados
    io.emit('new_alert', alert);
  });

  // Resolver alerta
  socket.on('resolve_alert', (alertId) => {
    const alert = alerts.find(a => a.id === alertId);
    if (alert) {
      alert.resolved = true;
      console.log(`✓ Alerta ${alertId} resuelta`);
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
  const interfaces = os.networkInterfaces();
  let address = 'localhost';
  
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const config of iface) {
      if (config.family === 'IPv4' && !config.internal) {
        address = config.address;
        break;
      }
    }
  }
  
  console.log('🚀 Servidor activo en:');
  console.log(`   Local: http://localhost:${PORT}`);
  console.log(`   Red:   http://${address}:${PORT}`);
  console.log('\n✅ Listo para recibir conexiones');
});

// Manejo de cierre elegante
process.on('SIGTERM', () => {
  console.log(' Cerrando servidor...');
  server.close(() => {
    process.exit(0);
  });
});