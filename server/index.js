// Styx 서버 - HADES 실시간 오디오 협업
// Socket.IO 시그널링 서버 + 사용자 인증 + 채팅

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 5e6 }); // 5MB 아바타 허용

const PORT = process.env.PORT || 3000;
const MAX_USERS_PER_ROOM = 8; // 방당 최대 인원
const USERS_FILE = path.join(__dirname, 'users.json');
const AVATARS_DIR = path.join(__dirname, '../avatars');
const SALT_ROUNDS = 10; // bcrypt 해시 강도

// 아바타 폴더 생성
if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true });

// 사용자 데이터 로드/저장
const loadUsers = () => JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
const saveUsers = (data) => fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));

// 정적 파일 서빙
app.use(express.static(path.join(__dirname, '../client')));
app.use('/avatars', express.static(AVATARS_DIR));

// 방 상태: { roomId: { users: Map, messages: [] } }
const rooms = new Map();

// 모든 클라이언트에게 방 목록 브로드캐스트
const broadcastRoomList = () => {
  const list = [];
  rooms.forEach((data, name) => {
    list.push({ name, userCount: data.users.size, users: [...data.users.values()].map(u => u.username) });
  });
  io.emit('room-list', list);
};

io.on('connection', (socket) => {
  console.log(`연결됨: ${socket.id}`);

  // 로그인 (bcrypt 비밀번호 검증)
  socket.on('login', async ({ username, password }, cb) => {
    const data = loadUsers();
    const user = data.users[username];
    
    if (!user) return cb({ error: 'User not found' });
    
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return cb({ error: 'Wrong password' });
    if (!user.approved) return cb({ error: 'Account pending approval' });
    
    cb({ success: true, user: { username, isAdmin: user.isAdmin, avatar: user.avatar } });
  });

  // 회원가입 (bcrypt 해시 저장)
  socket.on('signup', async ({ username, password }, cb) => {
    const data = loadUsers();
    
    if (data.users[username] || data.pending[username]) {
      return cb({ error: 'Username taken' });
    }
    
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    data.pending[username] = { password: hash, requestedAt: new Date().toISOString() };
    saveUsers(data);
    cb({ success: true, message: '가입 요청 완료' });
  });

  // 관리자: 대기 중인 사용자 목록
  socket.on('get-pending', (_, cb) => {
    if (!socket.isAdmin) return cb({ error: 'Not admin' });
    const data = loadUsers();
    cb({ pending: Object.keys(data.pending) });
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

  // 아바타 업로드 (base64 이미지)
  socket.on('upload-avatar', ({ username, avatarData }, cb) => {
    if (!socket.username || socket.username !== username) return cb({ error: 'Unauthorized' });
    
    const match = avatarData.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/);
    if (!match) return cb({ error: 'Invalid image' });
    
    const ext = match[1];
    const buffer = Buffer.from(match[2], 'base64');
    const filename = `${username}.${ext}`;
    fs.writeFileSync(path.join(AVATARS_DIR, filename), buffer);
    
    const data = loadUsers();
    data.users[username].avatar = `/avatars/${filename}`;
    saveUsers(data);
    
    // 같은 방 사용자들에게 아바타 변경 알림
    if (socket.room) {
      socket.to(socket.room).emit('user-updated', { id: socket.id, avatar: `/avatars/${filename}` });
    }
    cb({ success: true, avatar: `/avatars/${filename}` });
  });

  // 방 목록 조회
  socket.on('get-rooms', (_, cb) => {
    const list = [];
    rooms.forEach((data, name) => {
      list.push({ name, userCount: data.users.size, users: [...data.users.values()].map(u => u.username) });
    });
    cb(list);
  });

  // 방 입장
  socket.on('join', ({ room, username }, cb) => {
    const data = loadUsers();
    const user = data.users[username];
    if (!user || !user.approved) return cb({ error: 'Not authorized' });

    // 방이 없으면 생성
    if (!rooms.has(room)) rooms.set(room, { users: new Map(), messages: [] });
    const roomData = rooms.get(room);
    
    // 인원 제한 확인
    if (roomData.users.size >= MAX_USERS_PER_ROOM) return cb({ error: 'Room full' });

    // 중복 사용자명 확인
    for (const [, u] of roomData.users) {
      if (u.username === username) return cb({ error: 'Username already in room' });
    }

    // 방 입장 처리
    socket.join(room);
    roomData.users.set(socket.id, { username, avatar: user.avatar });
    socket.username = username;
    socket.room = room;
    socket.isAdmin = user.isAdmin;

    // 기존 사용자 목록 전송
    const existingUsers = [];
    for (const [id, u] of roomData.users) {
      if (id !== socket.id) existingUsers.push({ id, username: u.username, avatar: u.avatar });
    }

    // 다른 사용자들에게 입장 알림
    socket.to(room).emit('user-joined', { id: socket.id, username, avatar: user.avatar });
    cb({ success: true, users: existingUsers, isAdmin: user.isAdmin, messages: roomData.messages.slice(-50) });
    
    broadcastRoomList();
    console.log(`${username} 입장: ${room} (${roomData.users.size}/${MAX_USERS_PER_ROOM})`);
  });

  // 채팅 메시지
  socket.on('chat', (text, cb) => {
    if (!socket.room || !socket.username) return;
    const roomData = rooms.get(socket.room);
    if (!roomData) return;

    const msg = { username: socket.username, text, time: Date.now() };
    roomData.messages.push(msg);
    // 최근 100개 메시지만 유지
    if (roomData.messages.length > 100) roomData.messages.shift();
    
    io.to(socket.room).emit('chat', msg);
    cb?.();
  });

  // WebRTC 시그널링: offer/answer/ICE 후보 전달
  socket.on('offer', ({ to, offer }) => io.to(to).emit('offer', { from: socket.id, offer }));
  socket.on('answer', ({ to, answer }) => io.to(to).emit('answer', { from: socket.id, answer }));
  socket.on('ice-candidate', ({ to, candidate }) => io.to(to).emit('ice-candidate', { from: socket.id, candidate }));

  // 연결 해제 처리
  socket.on('disconnect', () => {
    if (socket.room && rooms.has(socket.room)) {
      const roomData = rooms.get(socket.room);
      roomData.users.delete(socket.id);
      socket.to(socket.room).emit('user-left', { id: socket.id });
      
      // 빈 방 삭제
      if (roomData.users.size === 0) rooms.delete(socket.room);
      broadcastRoomList();
      console.log(`${socket.username} 퇴장: ${socket.room}`);
    }
  });
});

server.listen(PORT, () => console.log(`Styx 서버 실행 중: 포트 ${PORT}`));
