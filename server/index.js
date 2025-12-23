// Styx 서버 - 실시간 오디오 협업
// Socket.IO 시그널링 서버 + 사용자 인증 + 채팅 + 메트로놈 + UDP 릴레이

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const dgram = require('dgram');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const helmet = require('helmet');
const { Mutex } = require('async-mutex');
const { z } = require('zod');

// Input validation schemas
const schemas = {
  username: z.string().min(2).max(20).regex(/^[a-zA-Z0-9_가-힣]+$/),
  password: z.string().min(4).max(50),
  roomName: z.string().min(1).max(30),
  bpm: z.number().int().min(30).max(300),
  roomSettings: z.object({
    maxUsers: z.number().int().min(2).max(8).optional(),
    audioMode: z.enum(['voice', 'music']).optional(),
    bitrate: z.number().int().optional(),
    sampleRate: z.number().int().optional(),
    bpm: z.number().int().min(30).max(300).optional(),
    isPrivate: z.boolean().optional()
  }).optional()
};

// TURN 서버 설정
const TURN_SERVER = process.env.TURN_SERVER;
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_TTL = 24 * 60 * 60; // 24시간

// TURN 자격증명 생성 (time-limited credentials)
function generateTurnCredentials(username) {
  if (!TURN_SECRET) return null;
  const timestamp = Math.floor(Date.now() / 1000) + TURN_TTL;
  const turnUsername = `${timestamp}:${username}`;
  const hmac = crypto.createHmac('sha1', TURN_SECRET);
  hmac.update(turnUsername);
  const credential = hmac.digest('base64');
  return { username: turnUsername, credential };
}

// 환경 변수 검증
function validateEnv() {
  const warnings = [];
  const errors = [];
  
  if (!process.env.PORT) warnings.push('PORT not set, using default 3000');
  if (!process.env.CORS_ORIGINS) warnings.push('CORS_ORIGINS not set, allowing same origin only');
  if (process.env.NODE_ENV === 'production' && !process.env.FORCE_HTTPS) {
    warnings.push('FORCE_HTTPS not set in production');
  }
  
  // TURN server validation
  if (!TURN_SERVER) warnings.push('TURN_SERVER not set, WebRTC may fail behind NAT');
  if (!TURN_SECRET) {
    if (process.env.NODE_ENV === 'production') {
      errors.push('TURN_SECRET required in production for WebRTC NAT traversal');
    } else {
      warnings.push('TURN_SECRET not set, WebRTC may fail behind NAT');
    }
  }
  
  warnings.forEach(w => console.warn(`⚠️  ${w}`));
  
  if (errors.length > 0) {
    errors.forEach(e => console.error(`❌ ${e}`));
    console.error('Fix critical configuration errors before starting server');
    process.exit(1);
  }
  
  console.log('✓ Environment validated');
}
validateEnv();

const app = express();
const server = createServer(app);

// 에러 추적 래퍼
function trackError(operation, error) {
  serverStats.errors++;
  console.error(`[ERROR] ${operation}:`, error.message);
}

// 모니터링 및 헬스체크 시스템
let serverStats = {
  startTime: Date.now(),
  totalConnections: 0,
  activeConnections: 0,
  totalRooms: 0,
  activeRooms: 0,
  totalMessages: 0,
  errors: 0
};

// 헬스체크 엔드포인트
app.get('/health', (req, res) => {
  const uptime = Date.now() - serverStats.startTime;
  res.json({
    status: 'healthy',
    uptime: Math.floor(uptime / 1000),
    stats: {
      ...serverStats,
      activeRooms: rooms?.size || 0,
      memoryUsage: process.memoryUsage(),
      cpuUsage: process.cpuUsage()
    }
  });
});

// 메트릭스 엔드포인트 (Prometheus 형식)
app.get('/metrics', (req, res) => {
  const metrics = {
    connections_total: serverStats.totalConnections,
    connections_active: serverStats.activeConnections,
    rooms_total: serverStats.totalRooms,
    rooms_active: rooms?.size || 0,
    messages_total: serverStats.totalMessages,
    errors_total: serverStats.errors,
    uptime_seconds: Math.floor((Date.now() - serverStats.startTime) / 1000)
  };
  
  let output = '';
  Object.entries(metrics).forEach(([key, value]) => {
    output += `styx_${key} ${value}\n`;
  });
  
  res.set('Content-Type', 'text/plain');
  res.send(output);
});

// 자동화된 테스트 엔드포인트
app.get('/test', (req, res) => {
  const tests = [];
  
  // 기본 서버 상태 테스트
  tests.push({
    name: 'Server Status',
    status: 'pass',
    message: 'Server is running'
  });
  
  // 메모리 사용량 테스트
  const memUsage = process.memoryUsage();
  const memoryTest = memUsage.heapUsed < 500 * 1024 * 1024; // 500MB 제한
  tests.push({
    name: 'Memory Usage',
    status: memoryTest ? 'pass' : 'fail',
    message: `Heap used: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`
  });
  
  // 활성 연결 테스트
  const connectionTest = serverStats.activeConnections >= 0;
  tests.push({
    name: 'Active Connections',
    status: connectionTest ? 'pass' : 'fail',
    message: `${serverStats.activeConnections} active connections`
  });
  
  // 에러율 테스트
  const errorRate = serverStats.totalConnections > 0 ? 
    (serverStats.errors / serverStats.totalConnections) : 0;
  const errorTest = errorRate < 0.1; // 10% 미만
  tests.push({
    name: 'Error Rate',
    status: errorTest ? 'pass' : 'fail',
    message: `${(errorRate * 100).toFixed(2)}% error rate`
  });
  
  const allPassed = tests.every(t => t.status === 'pass');
  
  res.json({
    status: allPassed ? 'pass' : 'fail',
    timestamp: new Date().toISOString(),
    tests
  });
});

// CORS 설정 for HTTP requests
const ALLOWED_ORIGINS = process.env.CORS_ORIGINS 
  ? process.env.CORS_ORIGINS.split(',') 
  : ['http://tauri.localhost', 'https://tauri.localhost', 'http://localhost:3000'];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS === true) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Security headers
app.use((req, res, next) => {
  // Skip CORP for avatars - allow cross-origin
  if (req.path.startsWith('/avatars')) {
    return next();
  }
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" }
  })(req, res, next);
});

// Health check endpoint
app.get('/health', (req, res) => {
  const uptime = Math.floor(process.uptime());
  const memUsage = process.memoryUsage();
  res.json({ 
    status: 'ok', 
    uptime,
    memory: {
      used: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
      total: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB'
    },
    connections: io.engine.clientsCount || 0
  });
});

// HTTPS 리다이렉트 (프로덕션)
if (process.env.FORCE_HTTPS === 'true') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https' && req.hostname !== 'localhost') {
      return res.redirect(301, `https://${req.hostname}${req.url}`);
    }
    next();
  });
  console.log('✓ HTTPS redirect enabled');
}

const io = new Server(server, { 
  cors: { origin: ALLOWED_ORIGINS, credentials: true }, 
  maxHttpBufferSize: 5e6 
});

const PORT = process.env.PORT || 3000;
const USERS_FILE = path.join(__dirname, 'data', 'users.json');
const SESSIONS_FILE = path.join(__dirname, 'data', 'sessions.json');
const WHITELIST_FILE = path.join(__dirname, 'data', 'whitelist.json');
const AVATARS_DIR = path.join(__dirname, '..', 'avatars');
const SALT_ROUNDS = 10;

// IP Whitelist System
let ipWhitelist = new Set();
let whitelistEnabled = false;

function loadWhitelist() {
  try {
    if (fsSync.existsSync(WHITELIST_FILE)) {
      const data = JSON.parse(fsSync.readFileSync(WHITELIST_FILE, 'utf8'));
      ipWhitelist = new Set(data.ips || []);
      whitelistEnabled = data.enabled || false;
      console.log(`✓ IP whitelist loaded: ${ipWhitelist.size} IPs, enabled: ${whitelistEnabled}`);
    }
  } catch (e) {
    console.error('Failed to load whitelist:', e);
  }
}

function saveWhitelist() {
  try {
    fsSync.writeFileSync(WHITELIST_FILE, JSON.stringify({
      enabled: whitelistEnabled,
      ips: Array.from(ipWhitelist),
      lastModified: new Date().toISOString()
    }, null, 2));
  } catch (e) {
    console.error('Failed to save whitelist:', e);
  }
}

function isIpWhitelisted(ip) {
  if (!whitelistEnabled) return true;
  return ipWhitelist.has(ip) || ip === '127.0.0.1' || ip === '::1'; // Always allow localhost
}

// Load whitelist on startup
loadWhitelist();

// Enhanced Rate Limiting with per-user tracking
const rateLimits = new Map(); // IP-based
const userRateLimits = new Map(); // User session-based
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 100; // Per IP
const USER_RATE_LIMIT_MAX = 50; // Per user session

function checkRateLimit(ip, userId = null) {
  const now = Date.now();
  
  // Cleanup expired entries
  let cleaned = 0;
  for (const [key, record] of rateLimits) {
    if (now - record.start > RATE_LIMIT_WINDOW) {
      rateLimits.delete(key);
      if (++cleaned >= 10) break;
    }
  }
  
  // Cleanup expired user rate limits
  for (const [key, record] of userRateLimits) {
    if (now - record.start > RATE_LIMIT_WINDOW) {
      userRateLimits.delete(key);
      if (++cleaned >= 20) break;
    }
  }
  
  // Check IP-based rate limit
  const ipRecord = rateLimits.get(ip);
  if (!ipRecord || now - ipRecord.start > RATE_LIMIT_WINDOW) {
    rateLimits.set(ip, { start: now, count: 1 });
  } else {
    ipRecord.count++;
    if (ipRecord.count > RATE_LIMIT_MAX) return false;
  }
  
  // Check user-based rate limit if userId provided
  if (userId) {
    const userRecord = userRateLimits.get(userId);
    if (!userRecord || now - userRecord.start > RATE_LIMIT_WINDOW) {
      userRateLimits.set(userId, { start: now, count: 1 });
    } else {
      userRecord.count++;
      if (userRecord.count > USER_RATE_LIMIT_MAX) return false;
    }
  }
  
  return true;
}

// 디렉토리 초기화
if (!fsSync.existsSync(AVATARS_DIR)) fsSync.mkdirSync(AVATARS_DIR, { recursive: true });
if (!fsSync.existsSync(path.dirname(USERS_FILE))) fsSync.mkdirSync(path.dirname(USERS_FILE), { recursive: true });

// 파일 잠금 뮤텍스 (async-mutex로 race condition 방지)
const fileMutex = new Mutex();
const withLock = (fn) => fileMutex.runExclusive(fn);

// 비동기 파일 작업
const loadUsers = async () => {
  try {
    const data = await fs.readFile(USERS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    console.error('[FILE_ERROR] Failed to load users file:', e.message);
    return { users: {}, pending: {} };
  }
};

const saveUsers = async (data) => {
  try {
    await fs.writeFile(USERS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[FILE_ERROR] Failed to save users file:', e.message);
  }
};

const loadSessions = async () => {
  try {
    const data = await fs.readFile(SESSIONS_FILE, 'utf8');
    const parsed = JSON.parse(data);
    const now = Date.now();
    for (const [k, v] of Object.entries(parsed)) {
      if (v.expires < now) delete parsed[k];
    }
    return new Map(Object.entries(parsed));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[SESSION_ERROR] Failed to load sessions file:', e.message);
    return new Map();
  }
};

const saveSessions = async (sessions) => {
  try {
    await fs.writeFile(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions), null, 2));
  } catch (e) {
    console.error('[SESSION_ERROR] Failed to save sessions file:', e.message);
  }
};

let sessions = new Map();
let sessionsReady = loadSessions().then(s => { sessions = s; });

const generateToken = () => crypto.randomBytes(32).toString('hex');

// Timing-safe token comparison
function safeTokenCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// 입력 검증 (legacy - kept for compatibility, use zod schemas for new code)
const validateUsername = (u) => schemas.username.safeParse(u).success;
const validatePassword = (p) => {
  if (!schemas.password.safeParse(p).success) return { valid: false, error: 'Password must be 4-50 characters' };
  
  // Enhanced password requirements
  if (p.length < 6) return { valid: false, error: 'Password must be at least 6 characters' };
  if (!/[a-zA-Z]/.test(p)) return { valid: false, error: 'Password must contain at least one letter' };
  if (!/[0-9]/.test(p)) return { valid: false, error: 'Password must contain at least one number' };
  
  // Check for common weak passwords
  const weak = ['123456', 'password', 'qwerty', '111111', '123123', 'admin', 'user'];
  if (weak.includes(p.toLowerCase())) return { valid: false, error: 'Password is too common' };
  
  return { valid: true };
};

// Input sanitization
function sanitizeInput(input, maxLength = 100) {
  if (typeof input !== 'string') return '';
  return input
    .trim()
    .slice(0, maxLength)
    .replace(/[<>]/g, '') // Remove potential HTML tags
    .replace(/javascript:/gi, '') // Remove javascript: URLs
    .replace(/on\w+=/gi, '') // Remove event handlers
    .replace(/[\x00-\x1f\x7f]/g, ''); // Remove control characters
}

function validateRoomName(name) {
  if (!name || typeof name !== 'string') return false;
  const sanitized = sanitizeInput(name, 30);
  return sanitized.length >= 2 && sanitized.length <= 30 && 
         /^[a-zA-Z0-9가-힣\s_-]+$/.test(sanitized) &&
         !sanitized.includes('..') && // Prevent path traversal
         !sanitized.startsWith('.'); // Prevent hidden files
}
const sanitize = (s) => String(s).replace(/[<>"'&]/g, '').replace(/[\x00-\x1f\x7f]/g, '');

// 세션 정리 (1시간마다)
setInterval(async () => {
  const now = Date.now();
  let cleaned = 0;
  for (const [k, v] of sessions) {
    if (v.expires < now) { sessions.delete(k); cleaned++; }
  }
  if (cleaned > 0) {
    await saveSessions(sessions);
    console.log(`[CLEANUP] Cleaned ${cleaned} expired sessions`);
  }
  for (const [ip, record] of rateLimits) {
    if (now - record.start > 60000) rateLimits.delete(ip);
  }
  for (const [userId, record] of userRateLimits) {
    if (now - record.start > 60000) userRateLimits.delete(userId);
  }
}, 60 * 60 * 1000);

// Serve client files: config.js from client/, rest from shared/client/
app.use(express.static(path.join(__dirname, '../client'))); // config.js override
app.use(express.static(path.join(__dirname, '../shared/client'))); // shared files
app.use('/avatars', (req, res, next) => {
  res.removeHeader('Cross-Origin-Resource-Policy');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(AVATARS_DIR));

// 방 상태
const rooms = new Map();
const roomDeletionTimers = new Map();
const ROOM_EMPTY_TIMEOUT = 5 * 60 * 1000;

function scheduleRoomDeletion(roomName) {
  if (roomDeletionTimers.has(roomName)) clearTimeout(roomDeletionTimers.get(roomName));
  console.log(`방 삭제 예약: ${roomName} (5분 후)`);
  const timer = setTimeout(() => {
    const roomData = rooms.get(roomName);
    if (roomData && roomData.users.size === 0) {
      rooms.delete(roomName);
      roomDeletionTimers.delete(roomName);
      broadcastRoomList();
      console.log(`방 삭제됨 (타임아웃): ${roomName}`);
    }
  }, ROOM_EMPTY_TIMEOUT);
  roomDeletionTimers.set(roomName, timer);
}

function cancelRoomDeletion(roomName) {
  if (roomDeletionTimers.has(roomName)) {
    clearTimeout(roomDeletionTimers.get(roomName));
    roomDeletionTimers.delete(roomName);
    console.log(`방 삭제 취소: ${roomName}`);
  }
}

const broadcastRoomList = () => {
  const list = [];
  rooms.forEach((data, name) => {
    if (data.isPrivate) return; // Skip private rooms
    list.push({ 
      name, userCount: data.users.size, maxUsers: data.maxUsers || 8,
      hasPassword: !!data.passwordHash, creatorUsername: data.creatorUsername,
      users: [...data.users.values()].map(u => u.username) 
    });
  });
  io.emit('room-list', list);
};

io.on('connection', (socket) => {
  // 연결 통계 업데이트
  serverStats.totalConnections++;
  serverStats.activeConnections++;
  
  const clientIp = socket.handshake.address;
  const userAgent = socket.handshake.headers['user-agent'] || 'unknown';
  
  // IP Whitelist Check
  if (!isIpWhitelisted(clientIp)) {
    console.log(`[WHITELIST_BLOCK] ${clientIp}`);
    socket.emit('error', { message: 'Access denied from this IP address' });
    socket.disconnect(true);
    return;
  }
  
  if (!checkRateLimit(clientIp)) {
    console.log(`[RATE_LIMIT] ${clientIp}`);
    socket.emit('error', { message: 'Too many requests' });
    socket.disconnect(true);
    return;
  }
  
  console.log(`[CONNECT] ${socket.id} from ${clientIp}`);
  
  socket.on('login', async ({ username, password }, cb) => {
    try {
      await sessionsReady;
      if (!checkRateLimit(clientIp, username)) {
        console.log(`[RATE_LIMIT] ${clientIp} user:${username}`);
        return cb({ error: 'Too many requests' });
      }
      if (!validateUsername(username)) {
        console.log(`[LOGIN_FAIL] invalid username format from ${clientIp}`);
        return cb({ error: 'Invalid credentials' });
      }
      const data = await loadUsers();
      const user = data.users[username];
      // Use generic error to prevent username enumeration
      if (!user) {
        console.log(`[LOGIN_FAIL] ${username} not found from ${clientIp}`);
        return cb({ error: 'Invalid credentials' });
      }
      const valid = await bcrypt.compare(password, user.password);
      if (!valid) {
        console.log(`[LOGIN_FAIL] ${username} wrong password from ${clientIp}`);
        return cb({ error: 'Invalid credentials' });
      }
      if (!user.approved) {
        console.log(`[LOGIN_FAIL] ${username} not approved from ${clientIp}`);
        return cb({ error: 'Account pending approval' });
      }
      
      socket.username = username;
      socket.isAdmin = user.isAdmin;
      const token = generateToken();
      const sessionTimeout = user.isAdmin ? 24 * 60 * 60 * 1000 : 4 * 60 * 60 * 1000; // Admin: 24h, User: 4h
      sessions.set(username, { 
        token, 
        expires: Date.now() + sessionTimeout,
        ip: clientIp,
        userAgent,
        lastActivity: Date.now()
      });
      await saveSessions(sessions);
      console.log(`[LOGIN] ${username} from ${clientIp}`);
      cb({ success: true, user: { username, isAdmin: user.isAdmin, avatar: user.avatar }, token });
    } catch (e) {
      console.error('[LOGIN_ERROR]', e.message);
      cb({ error: 'Server error' });
    }
  });

  socket.on('restore-session', async ({ username, token }, cb) => {
    try {
      await sessionsReady;
      const session = sessions.get(username);
      // Use timing-safe comparison to prevent timing attacks
      if (!session || !safeTokenCompare(session.token, token) || session.expires < Date.now()) {
        sessions.delete(username);
        await saveSessions(sessions);
        return cb({ error: 'Invalid session' });
      }
      const data = await loadUsers();
      const user = data.users[username];
      if (!user || !user.approved) return cb({ error: 'Invalid session' });
      socket.username = username;
      socket.isAdmin = user.isAdmin;
      session.expires = Date.now() + 7 * 24 * 60 * 60 * 1000;
      cb({ success: true, user: { username, isAdmin: user.isAdmin, avatar: user.avatar } });
    } catch (e) {
      console.error('[SESSION_ERROR] Session restore failed:', e.message);
      cb({ error: 'Server error' });
    }
  });

  socket.on('signup', async ({ username, password }, cb) => {
    try {
      if (!checkRateLimit(clientIp, username)) {
        console.log(`[RATE_LIMIT] ${clientIp} user:${username}`);
        return cb({ error: 'Too many requests' });
      }
      if (!validateUsername(username)) return cb({ error: 'Invalid username (2-20자, 영문/숫자/한글/_)' });
      
      const passwordCheck = validatePassword(password);
      if (!passwordCheck.valid) return cb({ error: passwordCheck.error });
      
      const result = await withLock(async () => {
        const data = await loadUsers();
        if (data.users[username] || data.pending[username]) return { error: 'Username taken' };
        const hash = await bcrypt.hash(password, SALT_ROUNDS);
        data.pending[username] = { password: hash, requestedAt: new Date().toISOString() };
        await saveUsers(data);
        return { success: true, message: '가입 요청 완료' };
      });
      cb(result);
    } catch (e) {
      console.error('[SIGNUP_ERROR]', e.message);
      cb({ error: 'Server error' });
    }
  });

  socket.on('change-password', async ({ oldPassword, newPassword }, cb) => {
    try {
      if (!socket.username) return cb({ error: 'Not logged in' });
      
      const passwordCheck = validatePassword(newPassword);
      if (!passwordCheck.valid) return cb({ error: passwordCheck.error });
      
      const result = await withLock(async () => {
        const data = await loadUsers();
        const user = data.users[socket.username];
        const valid = await bcrypt.compare(oldPassword, user.password);
        if (!valid) return { error: 'Wrong password' };
        user.password = await bcrypt.hash(newPassword, SALT_ROUNDS);
        await saveUsers(data);
        sessions.delete(socket.username);
        await saveSessions(sessions);
        return { success: true };
      });
      cb(result);
    } catch (e) {
      console.error('[PASSWORD_ERROR] Password change failed:', e.message);
      cb({ error: 'Server error' });
    }
  });

  socket.on('get-pending', async (_, cb) => {
    try {
      if (!socket.isAdmin) return cb({ error: 'Not admin' });
      const data = await loadUsers();
      cb({ pending: Object.keys(data.pending) });
    } catch (e) {
      console.error('[PENDING_ERROR] Failed to get pending users:', e.message);
      cb({ error: 'Server error' });
    }
  });

  socket.on('get-users', async (_, cb) => {
    try {
      if (!socket.isAdmin) return cb({ error: 'Not admin' });
      const data = await loadUsers();
      const users = Object.entries(data.users).map(([username, u]) => ({
        username, isAdmin: u.isAdmin, createdAt: u.createdAt
      }));
      cb({ users });
    } catch (e) {
      console.error('[USERS_ERROR] Failed to get users list:', e.message);
      cb({ error: 'Server error' });
    }
  });

  socket.on('approve-user', async ({ username }, cb) => {
    try {
      if (!socket.isAdmin) return cb({ error: 'Not admin' });
      const result = await withLock(async () => {
        const data = await loadUsers();
        if (!data.pending[username]) return { error: 'No pending request' };
        data.users[username] = {
          password: data.pending[username].password, approved: true, isAdmin: false,
          avatar: null, createdAt: new Date().toISOString()
        };
        delete data.pending[username];
        await saveUsers(data);
        return { success: true };
      });
      cb(result);
    } catch (e) {
      console.error('[APPROVE_ERROR] User approval failed:', e.message);
      cb({ error: 'Server error' });
    }
  });

  socket.on('reject-user', async ({ username }, cb) => {
    try {
      if (!socket.isAdmin) return cb({ error: 'Not admin' });
      await withLock(async () => {
        const data = await loadUsers();
        delete data.pending[username];
        await saveUsers(data);
      });
      cb({ success: true });
    } catch (e) {
      console.error('[REJECT_ERROR] User rejection failed:', e.message);
      cb({ error: 'Server error' });
    }
  });

  socket.on('delete-user', async ({ username }, cb) => {
    try {
      if (!socket.isAdmin) return cb({ error: 'Not admin' });
      if (username === socket.username) return cb({ error: 'Cannot delete yourself' });
      
      const result = await withLock(async () => {
        const data = await loadUsers();
        if (!data.users[username]) return { error: 'User not found' };
        delete data.users[username];
        await saveUsers(data);
        sessions.delete(username);
        await saveSessions(sessions);
        
        try {
          const files = await fs.readdir(AVATARS_DIR);
          const avatarFile = files.find(f => f.startsWith(username + '.'));
          if (avatarFile) await fs.unlink(path.join(AVATARS_DIR, avatarFile));
        } catch (e) {
          console.error('[AVATAR_ERROR] Failed to delete old avatar:', e.message);
        }
        return { success: true };
      });
      cb(result);
    } catch (e) {
      console.error('[DELETE_ERROR] User deletion failed:', e.message);
      cb({ error: 'Server error' });
    }
  });

  socket.on('kick-user', ({ socketId }, cb) => {
    if (!socket.isAdmin) return cb({ error: 'Not admin' });
    if (!socketId) return cb({ error: 'Invalid socket ID' });
    io.to(socketId).emit('kicked');
    cb({ success: true });
  });

  socket.on('close-room', ({ roomName }, cb) => {
    if (!rooms.has(roomName)) return cb({ error: 'Room not found' });
    const roomData = rooms.get(roomName);
    if (!socket.isAdmin && roomData.creatorId !== socket.id) return cb({ error: 'Not authorized' });
    io.to(roomName).emit('room-closed');
    rooms.delete(roomName);
    broadcastRoomList();
    cb({ success: true });
  });

  socket.on('leave-room', () => {
    if (socket.room && rooms.has(socket.room)) {
      const roomData = rooms.get(socket.room);
      roomData.users.delete(socket.id);
      socket.to(socket.room).emit('user-left', { id: socket.id });
      socket.leave(socket.room);
      console.log(`[LEAVE] ${socket.username} left room: ${socket.room}`);
      if (roomData.users.size === 0) scheduleRoomDeletion(socket.room);
      socket.room = null;
      broadcastRoomList();
    }
  });

  socket.on('upload-avatar', async ({ username, avatarData }, cb) => {
    try {
      if (!socket.username || socket.username !== username) return cb({ error: 'Unauthorized' });
      const match = avatarData.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/);
      if (!match) return cb({ error: 'Invalid image' });
      const buffer = Buffer.from(match[2], 'base64');
      if (buffer.length > 2 * 1024 * 1024) return cb({ error: 'Image too large (max 2MB)' });
      
      const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
      const filename = `${username}.${ext}`;
      
      try {
        const files = await fs.readdir(AVATARS_DIR);
        const oldAvatar = files.find(f => f.startsWith(username + '.') && f !== filename);
        if (oldAvatar) await fs.unlink(path.join(AVATARS_DIR, oldAvatar));
      } catch (e) {
        console.error('[AVATAR_ERROR] Failed to delete existing avatar:', e.message);
      }
      
      await fs.writeFile(path.join(AVATARS_DIR, filename), buffer);
      
      const result = await withLock(async () => {
        const data = await loadUsers();
        data.users[username].avatar = `/avatars/${filename}?t=${Date.now()}`;
        await saveUsers(data);
        if (socket.room) {
          socket.to(socket.room).emit('user-updated', { id: socket.id, avatar: data.users[username].avatar });
        }
        return { success: true, avatar: data.users[username].avatar };
      });
      cb(result);
    } catch (e) {
      console.error('[AVATAR_ERROR] Avatar upload failed:', e.message);
      cb({ error: 'Server error' });
    }
  });

  socket.on('save-settings', async ({ settings }, cb) => {
    try {
      if (!socket.username) return cb?.({ error: 'Not logged in' });
      await withLock(async () => {
        const data = await loadUsers();
        if (!data.users[socket.username]) return;
        data.users[socket.username].settings = settings;
        await saveUsers(data);
      });
      cb?.({ success: true });
    } catch (e) {
      console.error('[SETTINGS_ERROR] Failed to save settings:', e.message);
      cb?.({ error: 'Server error' });
    }
  });

  socket.on('get-settings', async (_, cb) => {
    try {
      if (!socket.username) return cb?.({ error: 'Not logged in' });
      const data = await loadUsers();
      const user = data.users[socket.username];
      cb?.({ settings: user?.settings || null });
    } catch (e) {
      console.error('[SETTINGS_ERROR] Failed to load settings:', e.message);
      cb?.({ error: 'Server error' });
    }
  });

  socket.on('get-rooms', (_, cb) => {
    const list = [];
    rooms.forEach((data, name) => {
      if (data.isPrivate) return;
      list.push({ 
        name, userCount: data.users.size, maxUsers: data.maxUsers || 8,
        hasPassword: !!data.passwordHash, audioMode: data.audioMode || 'music',
        users: [...data.users.values()].map(u => u.username) 
      });
    });
    cb(list);
  });

  socket.on('join', async ({ room, username, password: roomPassword, settings }, cb) => {
    try {
      if (!checkRateLimit(clientIp, username)) {
        console.log(`[RATE_LIMIT] ${clientIp} user:${username}`);
        return cb({ error: 'Too many requests' });
      }
      // Validate inputs with zod
      const roomResult = schemas.roomName.safeParse(room);
      if (!roomResult.success) return cb({ error: 'Invalid room name' });
      room = sanitize(roomResult.data);
      
      const settingsResult = schemas.roomSettings.safeParse(settings);
      const validSettings = settingsResult.success ? settingsResult.data : {};
      
      const data = await loadUsers();
      const user = data.users[username];
      if (!user || !user.approved) return cb({ error: 'Not authorized' });

      if (!rooms.has(room)) {
        // 방 생성 통계 업데이트
        serverStats.totalRooms++;
        
        const passwordHash = roomPassword ? await bcrypt.hash(roomPassword, 8) : null;
        const s = validSettings;
        rooms.set(room, { 
          users: new Map(), messages: [], passwordHash,
          creatorId: socket.id, creatorUsername: username,
          metronome: { bpm: s.bpm || 120, playing: false, startTime: null },
          delayCompensation: false,
          maxUsers: Math.min(Math.max(s.maxUsers || 8, 2), 8),
          audioMode: s.audioMode || 'music', bitrate: s.bitrate || 96,
          sampleRate: s.sampleRate || 48000, isPrivate: s.isPrivate || false,
          roles: new Map() // userId -> 'host' | 'performer' | 'listener'
        });
      }
      const roomData = rooms.get(room);
      cancelRoomDeletion(room);
      
      if (roomData.passwordHash && roomData.users.size > 0) {
        const valid = await bcrypt.compare(roomPassword || '', roomData.passwordHash);
        if (!valid) return cb({ error: 'Wrong room password' });
      }
      
      if (roomData.users.size >= roomData.maxUsers) return cb({ error: 'Room full' });
      for (const [, u] of roomData.users) {
        if (u.username === username) return cb({ error: 'Username already in room' });
      }

      socket.join(room);
      roomData.users.set(socket.id, { username, avatar: user.avatar });
      // 역할 설정: 방 생성자는 host, 나머지는 performer
      const role = roomData.creatorId === socket.id ? 'host' : 'performer';
      roomData.roles.set(socket.id, role);
      socket.username = username;
      socket.room = room;
      socket.isAdmin = user.isAdmin;

      const existingUsers = [];
      for (const [id, u] of roomData.users) {
        if (id !== socket.id) existingUsers.push({ id, username: u.username, avatar: u.avatar, role: roomData.roles.get(id) });
      }

      socket.to(room).emit('user-joined', { id: socket.id, username, avatar: user.avatar, role });
      cb({ 
        success: true, users: existingUsers, isAdmin: user.isAdmin,
        isCreator: roomData.creatorId === socket.id, creatorUsername: roomData.creatorUsername,
        messages: roomData.messages.slice(-50), metronome: roomData.metronome,
        delayCompensation: roomData.delayCompensation, myRole: role,
        roomSettings: {
          maxUsers: roomData.maxUsers, audioMode: roomData.audioMode,
          bitrate: roomData.bitrate, sampleRate: roomData.sampleRate, isPrivate: roomData.isPrivate
        }
      });
      broadcastRoomList();
      console.log(`[JOIN] ${username} entered room: ${room} (${roomData.users.size}/${roomData.maxUsers})`);
    } catch (e) {
      console.error('[JOIN_ERROR] Room join failed:', e.message, e.stack);
      cb({ error: 'Server error' });
    }
  });

  socket.on('metronome-update', ({ bpm, playing }) => {
    if (!socket.room) return;
    const roomData = rooms.get(socket.room);
    if (!roomData) return;
    roomData.metronome = { bpm: Math.min(300, Math.max(30, bpm || 120)), playing, startTime: playing ? Date.now() : null };
    socket.to(socket.room).emit('metronome-sync', roomData.metronome);
  });

  socket.on('delay-compensation', (enabled) => {
    if (!socket.room) return;
    const roomData = rooms.get(socket.room);
    if (!roomData) return;
    roomData.delayCompensation = !!enabled;
    io.to(socket.room).emit('delay-compensation-sync', enabled);
  });

  // 화면 공유
  socket.on('screen-share-start', () => {
    if (!socket.room) return;
    socket.to(socket.room).emit('screen-share-start', { userId: socket.id, username: socket.username });
  });

  socket.on('screen-share-stop', () => {
    if (!socket.room) return;
    socket.to(socket.room).emit('screen-share-stop', { userId: socket.id });
  });

  // 역할 변경 (호스트만 가능)
  socket.on('change-role', ({ userId, role }, cb) => {
    if (!socket.room) return cb?.({ error: 'Not in room' });
    const roomData = rooms.get(socket.room);
    if (!roomData) return cb?.({ error: 'Room not found' });
    
    const myRole = roomData.roles.get(socket.id);
    if (myRole !== 'host' && !socket.isAdmin) return cb?.({ error: 'Not authorized' });
    if (!['performer', 'listener'].includes(role)) return cb?.({ error: 'Invalid role' });
    if (!roomData.users.has(userId)) return cb?.({ error: 'User not found' });
    
    roomData.roles.set(userId, role);
    io.to(socket.room).emit('role-changed', { userId, role });
    cb?.({ success: true });
  });

  socket.on('update-room-settings', ({ setting, value }, cb) => {
    if (!socket.room) return cb?.({ error: 'Not in room' });
    const roomData = rooms.get(socket.room);
    if (!roomData) return cb?.({ error: 'Room not found' });
    if (roomData.creatorId !== socket.id && !socket.isAdmin) return cb?.({ error: 'Not authorized' });
    
    const allowed = ['audioMode', 'bitrate', 'sampleRate'];
    if (!allowed.includes(setting)) return cb?.({ error: 'Invalid setting' });
    if (setting === 'audioMode' && !['voice', 'music'].includes(value)) return cb?.({ error: 'Invalid value' });
    if (setting === 'bitrate' && ![64, 96, 128, 192].includes(value)) return cb?.({ error: 'Invalid value' });
    if (setting === 'sampleRate' && ![44100, 48000].includes(value)) return cb?.({ error: 'Invalid value' });
    
    roomData[setting] = value;
    io.to(socket.room).emit('room-settings-changed', { setting, value });
    cb?.({ success: true });
  });

  socket.on('chat', (text, cb) => {
    // 메시지 통계 업데이트
    serverStats.totalMessages++;
    
    if (!socket.room || !socket.username) return;
    const roomData = rooms.get(socket.room);
    if (!roomData) return;
    text = sanitize(text).slice(0, 500);
    if (!text) return;
    const msg = { username: socket.username, text, time: Date.now() };
    roomData.messages.push(msg);
    if (roomData.messages.length > 100) roomData.messages.shift();
    io.to(socket.room).emit('chat', msg);
    cb?.();
  });

  socket.on('offer', ({ to, offer }) => io.to(to).emit('offer', { from: socket.id, offer }));
  socket.on('answer', ({ to, answer }) => io.to(to).emit('answer', { from: socket.id, answer }));
  socket.on('ice-candidate', ({ to, candidate }) => io.to(to).emit('ice-candidate', { from: socket.id, candidate }));

  // 시간 동기화 (메트로놈용)
  socket.on('time-sync', (clientTime, cb) => {
    cb(Date.now());
  });

  // TURN 자격증명 요청
  socket.on('get-turn-credentials', (_, cb) => {
    const creds = generateTurnCredentials(socket.username || 'anonymous');
    if (creds) {
      cb({
        urls: [
          `turn:${TURN_SERVER}:3478`,
          `turn:${TURN_SERVER}:3478?transport=tcp`
        ],
        username: creds.username,
        credential: creds.credential
      });
    } else {
      cb(null); // TURN not configured, client will use fallback
    }
  });

  socket.on('udp-info', ({ port, publicIp }) => {
    if (!socket.room) return;
    socket.udpPort = port;
    socket.udpPublicIp = publicIp;
    socket.to(socket.room).emit('udp-peer-info', { id: socket.id, port, publicIp, username: socket.username });
  });

  socket.on('udp-request-peers', () => {
    if (!socket.room) return;
    const roomData = rooms.get(socket.room);
    if (!roomData) return;
    const peers = [];
    for (const [id, u] of roomData.users) {
      const peerSocket = io.sockets.sockets.get(id);
      if (peerSocket && peerSocket.udpPort && id !== socket.id) {
        peers.push({ id, port: peerSocket.udpPort, publicIp: peerSocket.udpPublicIp, username: u.username });
      }
    }
    socket.emit('udp-peers', peers);
  });

  // Admin: IP Whitelist Management
  socket.on('admin-whitelist-status', (cb) => {
    if (!socket.isAdmin) return cb?.({ error: 'Not authorized' });
    cb?.({ 
      enabled: whitelistEnabled, 
      ips: Array.from(ipWhitelist),
      count: ipWhitelist.size 
    });
  });

  socket.on('admin-whitelist-toggle', ({ enabled }, cb) => {
    if (!socket.isAdmin) return cb?.({ error: 'Not authorized' });
    whitelistEnabled = enabled;
    saveWhitelist();
    console.log(`[ADMIN] ${socket.username} ${enabled ? 'enabled' : 'disabled'} IP whitelist`);
    cb?.({ success: true, enabled: whitelistEnabled });
  });

  socket.on('admin-whitelist-add', ({ ip }, cb) => {
    if (!socket.isAdmin) return cb?.({ error: 'Not authorized' });
    if (!ip || !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return cb?.({ error: 'Invalid IP format' });
    
    ipWhitelist.add(ip);
    saveWhitelist();
    console.log(`[ADMIN] ${socket.username} added IP to whitelist: ${ip}`);
    cb?.({ success: true, ips: Array.from(ipWhitelist) });
  });

  socket.on('admin-whitelist-remove', ({ ip }, cb) => {
    if (!socket.isAdmin) return cb?.({ error: 'Not authorized' });
    ipWhitelist.delete(ip);
    saveWhitelist();
    console.log(`[ADMIN] ${socket.username} removed IP from whitelist: ${ip}`);
    cb?.({ success: true, ips: Array.from(ipWhitelist) });
  });

  socket.on('disconnect', (reason) => {
    // 연결 통계 업데이트
    serverStats.activeConnections = Math.max(0, serverStats.activeConnections - 1);
    
    console.log(`[DISCONNECT] ${socket.id} ${socket.username || 'anonymous'} (${reason})`);
    if (socket.room && rooms.has(socket.room)) {
      const roomData = rooms.get(socket.room);
      roomData.users.delete(socket.id);
      socket.to(socket.room).emit('user-left', { id: socket.id });
      if (roomData.users.size === 0) scheduleRoomDeletion(socket.room);
      broadcastRoomList();
      console.log(`[LEAVE] ${socket.username} left ${socket.room}`);
    }
  });
});

// UDP Relay Server (optimized)
const UDP_PORT = parseInt(process.env.UDP_PORT) || 5000;
const udpServer = dgram.createSocket({ type: 'udp4', reuseAddr: true });
const SESSION_ID_LEN = 20;

// Optimized data structures
const udpClients = new Map(); // sessionId -> { address, port, roomId }
const roomMembers = new Map(); // roomId -> Set<sessionId> (O(1) room lookup)

// Pre-allocated buffer for relay
const MAX_PACKET_SIZE = 1500;
const relayBuffer = Buffer.alloc(MAX_PACKET_SIZE + SESSION_ID_LEN);

// Stats
let udpStats = { packetsIn: 0, packetsOut: 0, bytesIn: 0, bytesOut: 0 };

udpServer.on('message', (msg, rinfo) => {
  if (msg.length < SESSION_ID_LEN + 1 || msg.length > MAX_PACKET_SIZE) return;
  
  const sessionId = msg.slice(0, SESSION_ID_LEN).toString();
  const payload = msg.slice(SESSION_ID_LEN);
  
  udpStats.packetsIn++;
  udpStats.bytesIn += msg.length;
  
  // Handle ping (health check) - payload starts with 'P'
  if (payload.length === 1 && payload[0] === 0x50) { // 'P' = ping
    udpServer.send(Buffer.from([0x4F]), rinfo.port, rinfo.address); // 'O' = pong
    return;
  }
  
  // Register/update client
  let client = udpClients.get(sessionId);
  if (!client) {
    udpClients.set(sessionId, { address: rinfo.address, port: rinfo.port, roomId: null, lastSeen: Date.now() });
    return;
  }
  
  // Update address if changed (NAT rebinding)
  if (client.address !== rinfo.address || client.port !== rinfo.port) {
    client.address = rinfo.address;
    client.port = rinfo.port;
  }
  client.lastSeen = Date.now();
  
  if (!client.roomId) return;
  
  // O(1) room member lookup
  const members = roomMembers.get(client.roomId);
  if (!members) return;
  
  // Relay to room members (using pre-allocated buffer)
  const packetLen = SESSION_ID_LEN + payload.length;
  msg.copy(relayBuffer, 0, 0, SESSION_ID_LEN); // Copy sender ID
  payload.copy(relayBuffer, SESSION_ID_LEN);    // Copy payload
  
  for (const otherId of members) {
    if (otherId === sessionId) continue;
    const other = udpClients.get(otherId);
    if (!other) continue;
    
    udpServer.send(relayBuffer, 0, packetLen, other.port, other.address);
    udpStats.packetsOut++;
    udpStats.bytesOut += packetLen;
  }
});

// Helper: Add client to room
function addToRoom(sessionId, roomId) {
  const client = udpClients.get(sessionId);
  if (client) {
    // Remove from old room
    if (client.roomId && roomMembers.has(client.roomId)) {
      roomMembers.get(client.roomId).delete(sessionId);
    }
    // Add to new room
    client.roomId = roomId;
    if (!roomMembers.has(roomId)) roomMembers.set(roomId, new Set());
    roomMembers.get(roomId).add(sessionId);
  }
}

// Helper: Remove client
function removeUdpClient(sessionId) {
  const client = udpClients.get(sessionId);
  if (client?.roomId && roomMembers.has(client.roomId)) {
    roomMembers.get(client.roomId).delete(sessionId);
    if (roomMembers.get(client.roomId).size === 0) {
      roomMembers.delete(client.roomId);
    }
  }
  udpClients.delete(sessionId);
}

udpServer.on('listening', () => console.log(`[UDP] Relay server on port ${UDP_PORT}`));
udpServer.on('error', (err) => console.error('[UDP] Error:', err));
udpServer.bind(UDP_PORT);

// UDP stats and stale client cleanup (every 30 seconds)
setInterval(() => {
  const now = Date.now();
  let staleCount = 0;
  for (const [sessionId, client] of udpClients) {
    if (now - client.lastSeen > 30000) {
      removeUdpClient(sessionId);
      staleCount++;
    }
  }
  if (staleCount > 0) console.log(`[UDP] Cleaned ${staleCount} stale clients`);
  if (udpStats.packetsIn > 0) {
    console.log(`[UDP] Stats: ${udpStats.packetsIn} in, ${udpStats.packetsOut} out, ${udpClients.size} clients, ${roomMembers.size} rooms`);
    udpStats = { packetsIn: 0, packetsOut: 0, bytesIn: 0, bytesOut: 0 };
  }
}, 30000);

// TCP Relay (via Socket.IO binary) - fallback when UDP blocked
const tcpClients = new Map(); // sessionId -> { socket, roomId }

io.on('connection', (socket) => {
  // UDP room binding
  socket.on('udp-bind-room', ({ sessionId, roomId }) => {
    addToRoom(sessionId, roomId);
    socket.udpSessionId = sessionId;
    console.log(`[UDP] Client bound: ${sessionId.slice(0,8)}... -> ${roomId}`);
  });
  
  // TCP relay binding
  socket.on('tcp-bind-room', ({ roomId }) => {
    tcpClients.set(socket.id, { socket, roomId });
    socket.tcpRelay = true;
    console.log(`[TCP] Client bound: ${socket.id} -> ${roomId}`);
  });
  
  // TCP audio relay (binary)
  socket.on('tcp-audio', (audioData) => {
    const client = tcpClients.get(socket.id);
    if (!client?.roomId) return;
    
    // Relay to all other TCP clients in same room
    for (const [otherId, other] of tcpClients) {
      if (otherId !== socket.id && other.roomId === client.roomId) {
        other.socket.emit('tcp-audio', socket.id, audioData);
      }
    }
  });
  
  socket.on('disconnect', () => {
    if (socket.udpSessionId) {
      removeUdpClient(socket.udpSessionId);
    }
    if (socket.tcpRelay) {
      tcpClients.delete(socket.id);
    }
  });
});

server.listen(PORT, () => console.log(`[SERVER] Styx server running on port ${PORT}`));

// Graceful shutdown
const shutdown = async (signal) => {
  console.log(`\n${signal} 수신, 서버 종료 중...`);
  
  // Notify all connected clients
  io.emit('server-shutdown');
  
  // Close all socket connections
  io.close();
  
  // Save sessions before exit
  await saveSessions(sessions);
  
  server.close(() => {
    console.log('서버 종료 완료');
    process.exit(0);
  });
  
  // Force exit after 5 seconds
  setTimeout(() => process.exit(1), 5000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
