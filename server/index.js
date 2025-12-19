// Styx 서버 - 실시간 오디오 협업
// Socket.IO 시그널링 서버 + 사용자 인증 + 채팅 + 메트로놈

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
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
const TURN_SERVER = process.env.TURN_SERVER || '3.39.223.2';
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
  if (!process.env.PORT) warnings.push('PORT not set, using default 3000');
  if (!process.env.CORS_ORIGINS) warnings.push('CORS_ORIGINS not set, allowing same origin only');
  if (process.env.NODE_ENV === 'production' && !process.env.FORCE_HTTPS) {
    warnings.push('FORCE_HTTPS not set in production');
  }
  warnings.forEach(w => console.warn(`⚠️  ${w}`));
  console.log('✓ Environment validated');
}
validateEnv();

const app = express();
const server = createServer(app);

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // Disabled for Socket.IO compatibility
  crossOriginEmbedderPolicy: false
}));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()) });
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

// CORS 설정
const ALLOWED_ORIGINS = process.env.CORS_ORIGINS 
  ? process.env.CORS_ORIGINS.split(',') 
  : true;

const io = new Server(server, { 
  cors: { origin: ALLOWED_ORIGINS, credentials: true }, 
  maxHttpBufferSize: 5e6 
});

const PORT = process.env.PORT || 3000;
const USERS_FILE = path.join(__dirname, 'data', 'users.json');
const SESSIONS_FILE = path.join(__dirname, 'data', 'sessions.json');
const AVATARS_DIR = path.join(__dirname, '..', 'avatars');
const SALT_ROUNDS = 10;

// Rate Limiting with inline cleanup
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 100;

function checkRateLimit(ip) {
  const now = Date.now();
  // Inline cleanup: remove expired entries (max 10 per call to avoid blocking)
  let cleaned = 0;
  for (const [key, record] of rateLimits) {
    if (now - record.start > RATE_LIMIT_WINDOW) {
      rateLimits.delete(key);
      if (++cleaned >= 10) break;
    }
  }
  
  const record = rateLimits.get(ip);
  if (!record || now - record.start > RATE_LIMIT_WINDOW) {
    rateLimits.set(ip, { start: now, count: 1 });
    return true;
  }
  record.count++;
  return record.count <= RATE_LIMIT_MAX;
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
    console.error('사용자 파일 로드 실패:', e.message);
    return { users: {}, pending: {} };
  }
};

const saveUsers = async (data) => {
  try {
    await fs.writeFile(USERS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('사용자 파일 저장 실패:', e.message);
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
    if (e.code !== 'ENOENT') console.error('세션 파일 로드 실패:', e.message);
    return new Map();
  }
};

const saveSessions = async (sessions) => {
  try {
    await fs.writeFile(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions), null, 2));
  } catch (e) {
    console.error('세션 파일 저장 실패:', e.message);
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
const validatePassword = (p) => schemas.password.safeParse(p).success;
const sanitize = (s) => String(s).replace(/[<>"'&]/g, '');

// 세션 정리 (1시간마다)
setInterval(async () => {
  const now = Date.now();
  let cleaned = 0;
  for (const [k, v] of sessions) {
    if (v.expires < now) { sessions.delete(k); cleaned++; }
  }
  if (cleaned > 0) {
    await saveSessions(sessions);
    console.log(`만료 세션 ${cleaned}개 정리됨`);
  }
  for (const [ip, record] of rateLimits) {
    if (now - record.start > 60000) rateLimits.delete(ip);
  }
}, 60 * 60 * 1000);

// Serve client files: config.js from client/, rest from shared/client/
app.use(express.static(path.join(__dirname, '../client'))); // config.js override
app.use(express.static(path.join(__dirname, '../shared/client'))); // shared files
app.use('/avatars', express.static(AVATARS_DIR));

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
    list.push({ 
      name, userCount: data.users.size, hasPassword: !!data.passwordHash,
      creatorUsername: data.creatorUsername,
      users: [...data.users.values()].map(u => u.username) 
    });
  });
  io.emit('room-list', list);
};

io.on('connection', (socket) => {
  const clientIp = socket.handshake.address;
  
  if (!checkRateLimit(clientIp)) {
    console.log(`Rate limit 초과: ${clientIp}`);
    socket.emit('error', { message: 'Too many requests' });
    socket.disconnect(true);
    return;
  }
  
  console.log(`연결됨: ${socket.id}`);
  
  socket.on('login', async ({ username, password }, cb) => {
    try {
      await sessionsReady;
      if (!validateUsername(username)) return cb({ error: 'Invalid credentials' });
      const data = await loadUsers();
      const user = data.users[username];
      // Use generic error to prevent username enumeration
      if (!user) return cb({ error: 'Invalid credentials' });
      const valid = await bcrypt.compare(password, user.password);
      if (!valid) return cb({ error: 'Invalid credentials' });
      if (!user.approved) return cb({ error: 'Account pending approval' });
      
      socket.username = username;
      socket.isAdmin = user.isAdmin;
      const token = generateToken();
      sessions.set(username, { token, expires: Date.now() + 7 * 24 * 60 * 60 * 1000 });
      await saveSessions(sessions);
      cb({ success: true, user: { username, isAdmin: user.isAdmin, avatar: user.avatar }, token });
    } catch (e) {
      console.error('로그인 오류:', e.message);
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
      console.error('세션 복구 오류:', e.message);
      cb({ error: 'Server error' });
    }
  });

  socket.on('signup', async ({ username, password }, cb) => {
    try {
      if (!validateUsername(username)) return cb({ error: 'Invalid username (2-20자, 영문/숫자/한글/_)' });
      if (!validatePassword(password)) return cb({ error: 'Invalid password (4-50자)' });
      
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
      console.error('회원가입 오류:', e.message);
      cb({ error: 'Server error' });
    }
  });

  socket.on('change-password', async ({ oldPassword, newPassword }, cb) => {
    try {
      if (!socket.username) return cb({ error: 'Not logged in' });
      if (!validatePassword(newPassword)) return cb({ error: 'Invalid new password' });
      
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
      console.error('비밀번호 변경 오류:', e.message);
      cb({ error: 'Server error' });
    }
  });

  socket.on('get-pending', async (_, cb) => {
    try {
      if (!socket.isAdmin) return cb({ error: 'Not admin' });
      const data = await loadUsers();
      cb({ pending: Object.keys(data.pending) });
    } catch (e) {
      console.error('대기 목록 조회 오류:', e.message);
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
      console.error('사용자 목록 조회 오류:', e.message);
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
      console.error('사용자 승인 오류:', e.message);
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
      console.error('사용자 거절 오류:', e.message);
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
          console.error('아바타 삭제 오류:', e.message);
        }
        return { success: true };
      });
      cb(result);
    } catch (e) {
      console.error('사용자 삭제 오류:', e.message);
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
      console.log(`${socket.username} 퇴장: ${socket.room}`);
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
        console.error('기존 아바타 삭제 오류:', e.message);
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
      console.error('아바타 업로드 오류:', e.message);
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
      console.error('설정 저장 오류:', e.message);
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
      console.error('설정 로드 오류:', e.message);
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
        const passwordHash = roomPassword ? await bcrypt.hash(roomPassword, 8) : null;
        const s = validSettings;
        rooms.set(room, { 
          users: new Map(), messages: [], passwordHash,
          creatorId: socket.id, creatorUsername: username,
          metronome: { bpm: s.bpm || 120, playing: false, startTime: null },
          delayCompensation: false,
          maxUsers: Math.min(Math.max(s.maxUsers || 8, 2), 8),
          audioMode: s.audioMode || 'music', bitrate: s.bitrate || 96,
          sampleRate: s.sampleRate || 48000, isPrivate: s.isPrivate || false
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
      socket.username = username;
      socket.room = room;
      socket.isAdmin = user.isAdmin;

      const existingUsers = [];
      for (const [id, u] of roomData.users) {
        if (id !== socket.id) existingUsers.push({ id, username: u.username, avatar: u.avatar });
      }

      socket.to(room).emit('user-joined', { id: socket.id, username, avatar: user.avatar });
      cb({ 
        success: true, users: existingUsers, isAdmin: user.isAdmin,
        isCreator: roomData.creatorId === socket.id, creatorUsername: roomData.creatorUsername,
        messages: roomData.messages.slice(-50), metronome: roomData.metronome,
        delayCompensation: roomData.delayCompensation,
        roomSettings: {
          maxUsers: roomData.maxUsers, audioMode: roomData.audioMode,
          bitrate: roomData.bitrate, sampleRate: roomData.sampleRate, isPrivate: roomData.isPrivate
        }
      });
      broadcastRoomList();
      console.log(`${username} 입장: ${room} (${roomData.users.size}/${roomData.maxUsers})`);
    } catch (e) {
      console.error('방 입장 오류:', e.message);
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

  socket.on('disconnect', () => {
    if (socket.room && rooms.has(socket.room)) {
      const roomData = rooms.get(socket.room);
      roomData.users.delete(socket.id);
      socket.to(socket.room).emit('user-left', { id: socket.id });
      if (roomData.users.size === 0) scheduleRoomDeletion(socket.room);
      broadcastRoomList();
      console.log(`${socket.username} 퇴장: ${socket.room}`);
    }
  });
});

server.listen(PORT, () => console.log(`Styx 서버 실행 중: 포트 ${PORT}`));

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
