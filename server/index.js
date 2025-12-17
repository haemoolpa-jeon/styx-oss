// Styx 서버 - HADES 실시간 오디오 협업
// Socket.IO 시그널링 서버 + 사용자 인증 + 채팅 + 메트로놈

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 5e6 });

const PORT = process.env.PORT || 3000;
const MAX_USERS_PER_ROOM = 8;
const USERS_FILE = path.join(__dirname, 'users.json');
const AVATARS_DIR = path.join(__dirname, '../avatars');
const SALT_ROUNDS = 10;

if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true });

const loadUsers = () => JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
const saveUsers = (data) => fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));

// 입력 검증
const validateUsername = (u) => typeof u === 'string' && u.length >= 2 && u.length <= 20 && /^[a-zA-Z0-9_가-힣]+$/.test(u);
const validatePassword = (p) => typeof p === 'string' && p.length >= 4 && p.length <= 50;
const sanitize = (s) => String(s).replace(/[<>"'&]/g, '');

app.use(express.static(path.join(__dirname, '../client')));
app.use('/avatars', express.static(AVATARS_DIR));

// 방 상태: { roomId: { users: Map, messages: [], password: string|null, metronome: { bpm, playing, startTime } } }
const rooms = new Map();

const broadcastRoomList = () => {
  const list = [];
  rooms.forEach((data, name) => {
    list.push({ 
      name, 
      userCount: data.users.size, 
      hasPassword: !!data.password,
      users: [...data.users.values()].map(u => u.username) 
    });
  });
  io.emit('room-list', list);
};

io.on('connection', (socket) => {
  console.log(`연결됨: ${socket.id}`);
  
  // 로그인 시 isAdmin 설정 (방 입장 전에도 관리자 기능 사용 가능)
  socket.on('login', async ({ username, password }, cb) => {
    if (!validateUsername(username)) return cb({ error: 'Invalid username' });
    
    const data = loadUsers();
    const user = data.users[username];
    
    if (!user) return cb({ error: 'User not found' });
    
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return cb({ error: 'Wrong password' });
    if (!user.approved) return cb({ error: 'Account pending approval' });
    
    // 로그인 시점에 관리자 권한 설정
    socket.username = username;
    socket.isAdmin = user.isAdmin;
    
    cb({ success: true, user: { username, isAdmin: user.isAdmin, avatar: user.avatar } });
  });

  // 세션 복구 (localStorage 토큰)
  socket.on('restore-session', ({ username }, cb) => {
    const data = loadUsers();
    const user = data.users[username];
    if (!user || !user.approved) return cb({ error: 'Invalid session' });
    
    socket.username = username;
    socket.isAdmin = user.isAdmin;
    cb({ success: true, user: { username, isAdmin: user.isAdmin, avatar: user.avatar } });
  });

  socket.on('signup', async ({ username, password }, cb) => {
    if (!validateUsername(username)) return cb({ error: 'Invalid username (2-20자, 영문/숫자/한글/_)' });
    if (!validatePassword(password)) return cb({ error: 'Invalid password (4-50자)' });
    
    const data = loadUsers();
    if (data.users[username] || data.pending[username]) {
      return cb({ error: 'Username taken' });
    }
    
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    data.pending[username] = { password: hash, requestedAt: new Date().toISOString() };
    saveUsers(data);
    cb({ success: true, message: '가입 요청 완료' });
  });

  // 비밀번호 변경
  socket.on('change-password', async ({ oldPassword, newPassword }, cb) => {
    if (!socket.username) return cb({ error: 'Not logged in' });
    if (!validatePassword(newPassword)) return cb({ error: 'Invalid new password' });
    
    const data = loadUsers();
    const user = data.users[socket.username];
    
    const valid = await bcrypt.compare(oldPassword, user.password);
    if (!valid) return cb({ error: 'Wrong password' });
    
    user.password = await bcrypt.hash(newPassword, SALT_ROUNDS);
    saveUsers(data);
    cb({ success: true });
  });

  // 관리자: 대기 중인 사용자
  socket.on('get-pending', (_, cb) => {
    if (!socket.isAdmin) return cb({ error: 'Not admin' });
    const data = loadUsers();
    cb({ pending: Object.keys(data.pending) });
  });

  // 관리자: 모든 사용자 목록
  socket.on('get-users', (_, cb) => {
    if (!socket.isAdmin) return cb({ error: 'Not admin' });
    const data = loadUsers();
    const users = Object.entries(data.users).map(([username, u]) => ({
      username, isAdmin: u.isAdmin, createdAt: u.createdAt
    }));
    cb({ users });
  });

  // 관리자: 사용자 승인
  socket.on('approve-user', ({ username }, cb) => {
    if (!socket.isAdmin) return cb({ error: 'Not admin' });
    const data = loadUsers();
    if (!data.pending[username]) return cb({ error: 'No pending request' });
    
    data.users[username] = {
      password: data.pending[username].password,
      approved: true,
      isAdmin: false,
      avatar: null,
      createdAt: new Date().toISOString()
    };
    delete data.pending[username];
    saveUsers(data);
    cb({ success: true });
  });

  // 관리자: 사용자 거절
  socket.on('reject-user', ({ username }, cb) => {
    if (!socket.isAdmin) return cb({ error: 'Not admin' });
    const data = loadUsers();
    delete data.pending[username];
    saveUsers(data);
    cb({ success: true });
  });

  // 관리자: 사용자 삭제
  socket.on('delete-user', ({ username }, cb) => {
    if (!socket.isAdmin) return cb({ error: 'Not admin' });
    if (username === socket.username) return cb({ error: 'Cannot delete yourself' });
    
    const data = loadUsers();
    if (!data.users[username]) return cb({ error: 'User not found' });
    
    delete data.users[username];
    saveUsers(data);
    
    // 아바타 파일 삭제
    const avatarPath = path.join(AVATARS_DIR, `${username}.*`);
    try { fs.unlinkSync(avatarPath); } catch {}
    
    cb({ success: true });
  });

  // 관리자: 방에서 강퇴
  socket.on('kick-user', ({ odId }, cb) => {
    if (!socket.isAdmin) return cb({ error: 'Not admin' });
    io.to(socketId).emit('kicked');
    cb({ success: true });
  });

  // 아바타 업로드
  socket.on('upload-avatar', ({ username, avatarData }, cb) => {
    if (!socket.username || socket.username !== username) return cb({ error: 'Unauthorized' });
    
    const match = avatarData.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/);
    if (!match) return cb({ error: 'Invalid image' });
    
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > 2 * 1024 * 1024) return cb({ error: 'Image too large (max 2MB)' });
    
    const filename = `${username}.${match[1]}`;
    fs.writeFileSync(path.join(AVATARS_DIR, filename), buffer);
    
    const data = loadUsers();
    data.users[username].avatar = `/avatars/${filename}?t=${Date.now()}`;
    saveUsers(data);
    
    if (socket.room) {
      socket.to(socket.room).emit('user-updated', { id: socket.id, avatar: data.users[username].avatar });
    }
    cb({ success: true, avatar: data.users[username].avatar });
  });

  socket.on('get-rooms', (_, cb) => {
    const list = [];
    rooms.forEach((data, name) => {
      list.push({ 
        name, 
        userCount: data.users.size, 
        hasPassword: !!data.password,
        users: [...data.users.values()].map(u => u.username) 
      });
    });
    cb(list);
  });

  // 방 입장 (비밀번호 지원)
  socket.on('join', ({ room, username, password: roomPassword }, cb) => {
    const data = loadUsers();
    const user = data.users[username];
    if (!user || !user.approved) return cb({ error: 'Not authorized' });

    room = sanitize(room);
    if (!room || room.length > 30) return cb({ error: 'Invalid room name' });

    if (!rooms.has(room)) {
      rooms.set(room, { 
        users: new Map(), 
        messages: [], 
        password: roomPassword || null,
        metronome: { bpm: 120, playing: false, startTime: null }
      });
    }
    const roomData = rooms.get(room);
    
    // 비밀번호 확인
    if (roomData.password && roomData.users.size > 0 && roomData.password !== roomPassword) {
      return cb({ error: 'Wrong room password' });
    }
    
    if (roomData.users.size >= MAX_USERS_PER_ROOM) return cb({ error: 'Room full' });

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
      success: true, 
      users: existingUsers, 
      isAdmin: user.isAdmin, 
      messages: roomData.messages.slice(-50),
      metronome: roomData.metronome
    });
    
    broadcastRoomList();
    console.log(`${username} 입장: ${room} (${roomData.users.size}/${MAX_USERS_PER_ROOM})`);
  });

  // 메트로놈 동기화
  socket.on('metronome-update', ({ bpm, playing }) => {
    if (!socket.room) return;
    const roomData = rooms.get(socket.room);
    if (!roomData) return;
    
    roomData.metronome = { 
      bpm: Math.min(300, Math.max(30, bpm || 120)), 
      playing, 
      startTime: playing ? Date.now() : null 
    };
    socket.to(socket.room).emit('metronome-sync', roomData.metronome);
  });

  // 채팅
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

  // WebRTC 시그널링
  socket.on('offer', ({ to, offer }) => io.to(to).emit('offer', { from: socket.id, offer }));
  socket.on('answer', ({ to, answer }) => io.to(to).emit('answer', { from: socket.id, answer }));
  socket.on('ice-candidate', ({ to, candidate }) => io.to(to).emit('ice-candidate', { from: socket.id, candidate }));

  socket.on('disconnect', () => {
    if (socket.room && rooms.has(socket.room)) {
      const roomData = rooms.get(socket.room);
      roomData.users.delete(socket.id);
      socket.to(socket.room).emit('user-left', { id: socket.id });
      
      if (roomData.users.size === 0) rooms.delete(socket.room);
      broadcastRoomList();
      console.log(`${socket.username} 퇴장: ${socket.room}`);
    }
  });
});

server.listen(PORT, () => console.log(`Styx 서버 실행 중: 포트 ${PORT}`));
