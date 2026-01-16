// Styx Server - Entry Point
// Real-time audio collaboration platform

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const path = require('path');

// Load modules
const { config, validateEnv } = require('./config');
const { getAuditLogs, getAuditLogCount, MAX_AUDIT_LOGS, logSecurityEvent } = require('./utils/audit');
const { cleanupAll } = require('./middleware/security');
const users = require('./services/users');
const sessions = require('./services/sessions');
const rooms = require('./services/rooms');
const udp = require('./services/udp');
const socketHandlers = require('./handlers/socket');

// Validate environment
validateEnv();

// Initialize Express
const app = express();
const server = createServer(app);

// Server stats
const serverStats = {
  startTime: Date.now(),
  totalConnections: 0,
  activeConnections: 0,
  totalRooms: 0,
  activeRooms: 0,
  totalMessages: 0,
  errors: 0
};

// CORS middleware
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (config.corsOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Security headers
app.use((req, res, next) => {
  if (req.path.startsWith('/avatars')) return next();
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" }
  })(req, res, next);
});

// HTTPS redirect
if (config.forceHttps) {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https' && req.hostname !== 'localhost') {
      return res.redirect(301, `https://${req.hostname}${req.url}`);
    }
    next();
  });
}

// JSON body parser for GDPR endpoints
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const now = Date.now();
  res.json({
    status: 'healthy',
    uptime: Math.floor((now - serverStats.startTime) / 1000),
    stats: {
      ...serverStats,
      activeRooms: rooms.getRoomCount(),
      memoryUsage: process.memoryUsage(),
      cpuUsage: process.cpuUsage()
    },
    cache: {
      ...users.getCacheStats(),
      ...sessions.getCacheStats()
    },
    udp: udp.getStats()
  });
});

// Metrics (Prometheus format)
app.get('/metrics', (req, res) => {
  const metrics = {
    connections_total: serverStats.totalConnections,
    connections_active: serverStats.activeConnections,
    rooms_total: serverStats.totalRooms,
    rooms_active: rooms.getRoomCount(),
    messages_total: serverStats.totalMessages,
    errors_total: serverStats.errors,
    uptime_seconds: Math.floor((Date.now() - serverStats.startTime) / 1000)
  };
  let output = '';
  Object.entries(metrics).forEach(([key, value]) => {
    output += `styx_${key} ${value}\n`;
  });
  res.set('Content-Type', 'text/plain').send(output);
});

// Automated test endpoint
app.get('/test', (req, res) => {
  const tests = [];
  tests.push({ name: 'Server Status', status: 'pass', message: 'Server is running' });
  
  const memUsage = process.memoryUsage();
  const memoryTest = memUsage.heapUsed < 500 * 1024 * 1024;
  tests.push({ name: 'Memory Usage', status: memoryTest ? 'pass' : 'fail', message: `Heap used: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB` });
  
  tests.push({ name: 'Active Connections', status: 'pass', message: `${serverStats.activeConnections} active connections` });
  
  const errorRate = serverStats.totalConnections > 0 ? (serverStats.errors / serverStats.totalConnections) : 0;
  tests.push({ name: 'Error Rate', status: errorRate < 0.1 ? 'pass' : 'fail', message: `${(errorRate * 100).toFixed(2)}% error rate` });
  
  res.json({ status: tests.every(t => t.status === 'pass') ? 'pass' : 'fail', timestamp: new Date().toISOString(), tests });
});

// Audit endpoint
app.get('/audit', (req, res) => {
  if (!config.adminToken) {
    return res.status(503).json({ error: 'Audit endpoint disabled - ADMIN_TOKEN not configured' });
  }
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${config.adminToken}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const limit = Math.min(parseInt(req.query.limit) || 100, MAX_AUDIT_LOGS);
  const offset = parseInt(req.query.offset) || 0;
  res.json({ total: getAuditLogCount(), logs: getAuditLogs(limit, offset) });
});

// Privacy policy
app.get('/privacy-policy', (req, res) => {
  res.json({
    lastUpdated: '2024-01-01',
    dataCollection: {
      personal: ['username', 'password_hash', 'ip_address', 'user_agent'],
      technical: ['session_tokens', 'audio_settings', 'connection_logs'],
      retention: '30 days for logs, indefinite for user accounts until deletion'
    },
    rights: {
      access: 'Request your data via /api/gdpr/export',
      rectification: 'Update via user settings',
      erasure: 'Request deletion via /api/gdpr/delete',
      portability: 'Export via /api/gdpr/export'
    },
    contact: 'admin@styx-audio.com'
  });
});

// GDPR data export
app.post('/api/gdpr/export', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    
    const valid = await users.verifyPassword(username, password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    
    const user = await users.getUser(username);
    const { password: _, ...userData } = user;
    res.json({
      exportDate: new Date().toISOString(),
      userData,
      sessions: sessions.getSessionsByUser(username)
    });
  } catch (e) {
    console.error('[GDPR_EXPORT_ERROR]', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// GDPR data deletion
app.post('/api/gdpr/delete', async (req, res) => {
  try {
    const { username, password, confirm } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (confirm !== 'DELETE_MY_ACCOUNT') return res.status(400).json({ error: 'Must confirm with "DELETE_MY_ACCOUNT"' });
    
    const valid = await users.verifyPassword(username, password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    
    await users.deleteUser(username);
    sessions.deleteSessionsByUser(username);
    
    // Delete avatar
    const fs = require('fs').promises;
    const avatarFiles = await fs.readdir(config.paths.avatars).catch(() => []);
    const userAvatar = avatarFiles.find(f => f.startsWith(username + '.'));
    if (userAvatar) await fs.unlink(path.join(config.paths.avatars, userAvatar)).catch(() => {});
    
    logSecurityEvent('GDPR_ACCOUNT_DELETED', { username, ip: req.ip });
    res.json({ success: true, message: 'Account and data deleted' });
  } catch (e) {
    console.error('[GDPR_DELETE_ERROR]', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Static files
app.use(express.static(path.join(__dirname, '../client')));
app.use(express.static(path.join(__dirname, '../shared/client')));
app.use('/avatars', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(config.paths.avatars));

// Deep link redirect
app.get('/join/:roomName', (req, res) => {
  // Escape HTML to prevent XSS
  const escapeHtml = (s) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const roomName = escapeHtml(req.params.roomName);
  const password = req.query.password || '';
  const deepLink = `styx://join/${encodeURIComponent(req.params.roomName)}${password ? `?password=${encodeURIComponent(password)}` : ''}`;
  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Styx - ${roomName}</title>
<style>body{font-family:sans-serif;background:#08080d;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center}.container{max-width:400px;padding:40px}h1{font-size:24px}.btn{display:inline-block;padding:14px 28px;background:#8b7cf7;color:#fff;text-decoration:none;border-radius:8px;margin:8px}</style>
</head><body><div class="container"><h1>🎵 Styx 방 참가</h1><div style="background:#1a1a24;padding:12px;border-radius:8px;margin:16px 0">${roomName}</div>
<a href="${deepLink}" class="btn">앱에서 열기</a><br><a href="https://github.com/haemoolpa-jeon/styx-oss/releases" class="btn" style="background:#1a1a24">앱 다운로드</a></div>
<script>setTimeout(()=>location.href="${deepLink}",100)</script></body></html>`);
});

// Initialize Socket.IO
const io = new Server(server, {
  cors: { origin: config.corsOrigins, credentials: true },
  maxHttpBufferSize: 5e6
});

// Initialize services
sessions.init();
udp.init();
socketHandlers.init(io, serverStats);

// Cleanup interval (hourly)
setInterval(() => {
  sessions.cleanupExpired();
  cleanupAll();
  udp.cleanupRateLimits();
}, 60 * 60 * 1000);

// Graceful shutdown
const shutdown = async (signal) => {
  console.log(`\n${signal} received, shutting down...`);
  io.emit('server-shutdown');
  io.close();
  await sessions.saveSessions(sessions.getSessions());
  server.close(() => {
    console.log('Server shutdown complete');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start server
server.listen(config.port, () => {
  console.log(`[SERVER] Styx server running on port ${config.port}`);
});
