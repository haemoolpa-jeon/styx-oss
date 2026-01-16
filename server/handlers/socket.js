// Socket.IO event handlers
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const fs = require('fs').promises;
const path = require('path');

const { config } = require('../config');
const { logSecurityEvent } = require('../utils/audit');
const { schemas, validateUsername, validatePassword, sanitize, isValidIPv4 } = require('../utils/validation');
const { checkRateLimit, isIpWhitelisted, getWhitelistStatus, setWhitelistEnabled, addToWhitelist, removeFromWhitelist } = require('../middleware/security');
const users = require('../services/users');
const sessions = require('../services/sessions');
const rooms = require('../services/rooms');
const udp = require('../services/udp');

let serverStats = null;

function init(io, stats) {
  serverStats = stats;
  rooms.init(io, (roomId) => {
    // SFU cleanup callback
    udp.disableSfuForRoom(roomId);
  });

  io.on('connection', (socket) => {
    serverStats.totalConnections++;
    serverStats.activeConnections++;

    const clientIp = socket.handshake.address;
    const userAgent = socket.handshake.headers['user-agent'] || 'unknown';

    // IP Whitelist Check
    if (!isIpWhitelisted(clientIp)) {
      logSecurityEvent('IP_BLOCKED', { ip: clientIp, userAgent });
      socket.emit('error', { message: 'Access denied from this IP address' });
      socket.disconnect(true);
      return;
    }

    if (!checkRateLimit(clientIp)) {
      logSecurityEvent('RATE_LIMIT_EXCEEDED', { ip: clientIp, userAgent });
      socket.emit('error', { message: 'Too many requests' });
      socket.disconnect(true);
      return;
    }

    console.log(`[CONNECT] ${socket.id} from ${clientIp}`);

    // Auth handlers
    socket.on('login', async ({ username, password }, cb) => {
      try {
        if (!checkRateLimit(clientIp, username)) {
          logSecurityEvent('LOGIN_RATE_LIMIT', { ip: clientIp, username, userAgent });
          return cb({ error: 'Too many requests' });
        }
        if (!validateUsername(username)) {
          return cb({ error: 'Invalid credentials' });
        }

        const user = await users.getUser(username);
        if (!user) return cb({ error: 'Invalid credentials' });

        const valid = await bcrypt.compare(password, user.password);
        if (!valid) {
          logSecurityEvent('LOGIN_WRONG_PASSWORD', { ip: clientIp, username, userAgent });
          return cb({ error: 'Invalid credentials' });
        }
        if (!user.approved) {
          return cb({ error: 'Account pending approval' });
        }

        socket.username = username;
        socket.isAdmin = user.isAdmin;
        const token = sessions.createSession(username, clientIp, userAgent, user.isAdmin);
        
        logSecurityEvent('LOGIN_SUCCESS', { ip: clientIp, username, userAgent });
        console.log(`[LOGIN] ${username} from ${clientIp}`);
        cb({ success: true, user: { username, isAdmin: user.isAdmin, avatar: user.avatar }, token });
      } catch (e) {
        console.error('[LOGIN_ERROR]', e.message);
        cb({ error: 'Server error' });
      }
    });

    socket.on('restore-session', async ({ username, token }, cb) => {
      try {
        if (!sessions.validateSession(username, token)) {
          return cb({ error: 'Invalid session' });
        }
        const user = await users.getUser(username);
        if (!user || !user.approved) return cb({ error: 'Invalid session' });
        
        socket.username = username;
        socket.isAdmin = user.isAdmin;
        sessions.extendSession(username, user.isAdmin);
        cb({ success: true, user: { username, isAdmin: user.isAdmin, avatar: user.avatar } });
      } catch (e) {
        console.error('[SESSION_ERROR]', e.message);
        cb({ error: 'Server error' });
      }
    });

    socket.on('signup', async ({ username, password }, cb) => {
      try {
        if (!checkRateLimit(clientIp, username)) {
          return cb({ error: 'Too many requests' });
        }
        if (!validateUsername(username)) {
          return cb({ error: 'Invalid username (2-20자, 영문/숫자/한글/_)' });
        }
        const passwordCheck = validatePassword(password);
        if (!passwordCheck.valid) return cb({ error: passwordCheck.error });

        const hash = await users.hashPassword(password);
        const result = await users.addPendingUser(username, hash);
        cb(result.error ? result : { success: true, message: '가입 요청 완료' });
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

        const user = await users.getUser(socket.username);
        const valid = await bcrypt.compare(oldPassword, user.password);
        if (!valid) return cb({ error: 'Wrong password' });

        const hash = await users.hashPassword(newPassword);
        await users.updateUser(socket.username, { password: hash });
        sessions.deleteSession(socket.username);
        cb({ success: true });
      } catch (e) {
        console.error('[PASSWORD_ERROR]', e.message);
        cb({ error: 'Server error' });
      }
    });

    // Admin handlers
    socket.on('get-pending', async (_, cb) => {
      if (!socket.isAdmin) return cb({ error: 'Not admin' });
      cb({ pending: await users.getPendingUsers() });
    });

    socket.on('get-users', async (_, cb) => {
      if (!socket.isAdmin) return cb({ error: 'Not admin' });
      cb({ users: await users.getAllUsers() });
    });

    socket.on('approve-user', async ({ username }, cb) => {
      if (!socket.isAdmin) return cb({ error: 'Not admin' });
      const result = await users.approvePendingUser(username);
      if (result.success) {
        logSecurityEvent('USER_APPROVED', { ip: clientIp, username, adminUser: socket.username, userAgent });
      }
      cb(result);
    });

    socket.on('reject-user', async ({ username }, cb) => {
      if (!socket.isAdmin) return cb({ error: 'Not admin' });
      await users.rejectPendingUser(username);
      logSecurityEvent('USER_REJECTED', { ip: clientIp, username, adminUser: socket.username, userAgent });
      cb({ success: true });
    });

    socket.on('delete-user', async ({ username }, cb) => {
      if (!socket.isAdmin) return cb({ error: 'Not admin' });
      if (username === socket.username) return cb({ error: 'Cannot delete yourself' });
      
      const result = await users.deleteUser(username);
      sessions.deleteSession(username);
      cb(result);
    });

    socket.on('set-admin', async ({ username, isAdmin }, cb) => {
      if (!socket.isAdmin) return cb({ error: 'Not admin' });
      if (username === socket.username && !isAdmin) {
        return cb({ error: 'Cannot remove your own admin rights' });
      }
      const result = await users.updateUser(username, { isAdmin });
      if (result.success) {
        logSecurityEvent('ADMIN_RIGHTS_CHANGED', { ip: clientIp, targetUser: username, isAdmin, adminUser: socket.username, userAgent });
      }
      cb(result);
    });

    socket.on('kick-user', ({ socketId }, cb) => {
      if (!socket.isAdmin) return cb({ error: 'Not admin' });
      io.to(socketId).emit('kicked');
      cb({ success: true });
    });

    // Whitelist handlers
    socket.on('admin-whitelist-status', (cb) => {
      if (!socket.isAdmin) return cb?.({ error: 'Not authorized' });
      cb?.(getWhitelistStatus());
    });

    socket.on('admin-whitelist-toggle', ({ enabled }, cb) => {
      if (!socket.isAdmin) return cb?.({ error: 'Not authorized' });
      setWhitelistEnabled(enabled);
      cb?.({ success: true, enabled });
    });

    socket.on('admin-whitelist-add', ({ ip }, cb) => {
      if (!socket.isAdmin) return cb?.({ error: 'Not authorized' });
      if (!isValidIPv4(ip)) {
        return cb?.({ error: 'Invalid IP format' });
      }
      addToWhitelist(ip);
      logSecurityEvent('WHITELIST_IP_ADDED', { ip: clientIp, targetIp: ip, adminUser: socket.username, userAgent });
      cb?.({ success: true, ips: getWhitelistStatus().ips });
    });

    socket.on('admin-whitelist-remove', ({ ip }, cb) => {
      if (!socket.isAdmin) return cb?.({ error: 'Not authorized' });
      removeFromWhitelist(ip);
      logSecurityEvent('WHITELIST_IP_REMOVED', { ip: clientIp, targetIp: ip, adminUser: socket.username, userAgent });
      cb?.({ success: true, ips: getWhitelistStatus().ips });
    });

    // Room handlers
    socket.on('get-rooms', (_, cb) => {
      const list = [];
      rooms.getRooms().forEach((data, name) => {
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
          return cb({ error: 'Too many requests' });
        }
        
        const roomResult = schemas.roomName.safeParse(room);
        if (!roomResult.success) return cb({ error: 'Invalid room name' });
        room = sanitize(roomResult.data);

        const user = await users.getUser(username);
        if (!user || !user.approved) return cb({ error: 'Not authorized' });

        if (!rooms.hasRoom(room)) {
          serverStats.totalRooms++;
          const settingsResult = schemas.roomSettings.safeParse(settings);
          const validSettings = settingsResult.success ? settingsResult.data : {};
          await rooms.createRoom(room, socket.id, username, roomPassword, validSettings);
        }

        const roomData = rooms.getRoom(room);
        
        if (roomData.passwordHash && roomData.users.size > 0) {
          const valid = await rooms.verifyRoomPassword(room, roomPassword);
          if (!valid) return cb({ error: 'Wrong room password' });
        }

        if (roomData.users.size >= roomData.maxUsers) return cb({ error: 'Room full' });
        
        for (const [, u] of roomData.users) {
          if (u.username === username) return cb({ error: 'Username already in room' });
        }

        socket.join(room);
        const role = rooms.addUserToRoom(room, socket.id, username, user.avatar);
        socket.username = username;
        socket.room = room;
        socket.isAdmin = user.isAdmin;

        const existingUsers = rooms.getRoomUsers(room).filter(u => u.id !== socket.id);

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
        
        console.log(`[JOIN] ${username} entered room: ${room}`);
      } catch (e) {
        console.error('[JOIN_ERROR]', e.message);
        cb({ error: 'Server error' });
      }
    });

    socket.on('leave-room', () => {
      if (socket.room && rooms.hasRoom(socket.room)) {
        rooms.removeUserFromRoom(socket.room, socket.id);
        socket.to(socket.room).emit('user-left', { id: socket.id });
        socket.leave(socket.room);
        console.log(`[LEAVE] ${socket.username} left room: ${socket.room}`);
        socket.room = null;
      }
      // Clean up UDP room binding
      if (socket.udpSessionId) {
        udp.removeFromRoom(socket.udpSessionId);
      }
    });

    socket.on('close-room', ({ roomName }, cb) => {
      if (!rooms.hasRoom(roomName)) return cb({ error: 'Room not found' });
      const roomData = rooms.getRoom(roomName);
      if (!socket.isAdmin && roomData.creatorId !== socket.id) return cb({ error: 'Not authorized' });
      io.to(roomName).emit('room-closed');
      rooms.deleteRoom(roomName);
      cb({ success: true });
    });

    // Chat
    socket.on('chat', (text, cb) => {
      serverStats.totalMessages++;
      if (!socket.room || !socket.username) return;
      text = sanitize(text).slice(0, 500);
      if (!text) return;
      const msg = rooms.addMessage(socket.room, socket.username, text);
      if (msg) io.to(socket.room).emit('chat', msg);
      cb?.();
    });

    // Metronome
    socket.on('metronome-update', ({ bpm, playing, startTime }) => {
      if (!socket.room) return;
      const roomData = rooms.getRoom(socket.room);
      if (!roomData) return;
      // Use client-provided startTime for better sync, fallback to server time
      const syncTime = playing ? (startTime || Date.now()) : null;
      roomData.metronome = { bpm: Math.min(300, Math.max(30, bpm || 120)), playing, startTime: syncTime };
      socket.to(socket.room).emit('metronome-sync', roomData.metronome);
    });

    socket.on('delay-compensation', (enabled) => {
      if (!socket.room) return;
      const roomData = rooms.getRoom(socket.room);
      if (!roomData) return;
      roomData.delayCompensation = !!enabled;
      io.to(socket.room).emit('delay-compensation-sync', enabled);
    });

    // Room settings
    socket.on('update-room-settings', ({ setting, value }, cb) => {
      if (!socket.room) return cb?.({ error: 'Not in room' });
      const roomData = rooms.getRoom(socket.room);
      if (!roomData) return cb?.({ error: 'Room not found' });
      if (roomData.creatorId !== socket.id && !socket.isAdmin) return cb?.({ error: 'Not authorized' });
      
      const allowed = ['audioMode', 'bitrate', 'sampleRate', 'syncMode'];
      if (!allowed.includes(setting)) return cb?.({ error: 'Invalid setting' });
      
      // Validate values
      if (setting === 'audioMode' && !['voice', 'music'].includes(value)) return cb?.({ error: 'Invalid value' });
      if (setting === 'bitrate' && ![64, 96, 128, 192].includes(value)) return cb?.({ error: 'Invalid value' });
      if (setting === 'sampleRate' && ![44100, 48000].includes(value)) return cb?.({ error: 'Invalid value' });
      if (setting === 'syncMode' && typeof value !== 'boolean') return cb?.({ error: 'Invalid value' });
      
      roomData[setting] = value;
      io.to(socket.room).emit('room-settings-changed', { setting, value });
      cb?.({ success: true });
    });

    socket.on('change-role', ({ userId, role }, cb) => {
      if (!socket.room) return cb?.({ error: 'Not in room' });
      const roomData = rooms.getRoom(socket.room);
      if (!roomData) return cb?.({ error: 'Room not found' });
      
      const myRole = roomData.roles.get(socket.id);
      if (myRole !== 'host' && !socket.isAdmin) return cb?.({ error: 'Not authorized' });
      if (!['performer', 'listener'].includes(role)) return cb?.({ error: 'Invalid role' });
      if (!roomData.users.has(userId)) return cb?.({ error: 'User not found' });
      
      roomData.roles.set(userId, role);
      io.to(socket.room).emit('role-changed', { userId, role });
      cb?.({ success: true });
    });

    socket.on('peer-latency', ({ latency }) => {
      if (socket.room) socket.to(socket.room).emit('peer-latency', { peerId: socket.id, latency });
    });

    // Avatar upload
    socket.on('upload-avatar', async ({ username, avatarData }, cb) => {
      try {
        if (!socket.username || socket.username !== username) return cb({ error: 'Unauthorized' });
        const match = avatarData.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/);
        if (!match) return cb({ error: 'Invalid image' });
        const buffer = Buffer.from(match[2], 'base64');
        if (buffer.length > 2 * 1024 * 1024) return cb({ error: 'Image too large (max 2MB)' });
        
        const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
        const filename = `${username}.${ext}`;
        const avatarPath = path.join(config.paths.avatars, filename);
        
        // Delete old avatar
        const files = await fs.readdir(config.paths.avatars).catch(() => []);
        const oldAvatar = files.find(f => f.startsWith(username + '.') && f !== filename);
        if (oldAvatar) await fs.unlink(path.join(config.paths.avatars, oldAvatar)).catch(() => {});
        
        await fs.writeFile(avatarPath, buffer);
        const avatarUrl = `/avatars/${filename}?t=${Date.now()}`;
        await users.updateUser(username, { avatar: avatarUrl });
        
        if (socket.room) {
          socket.to(socket.room).emit('user-updated', { id: socket.id, avatar: avatarUrl });
        }
        cb({ success: true, avatar: avatarUrl });
      } catch (e) {
        console.error('[AVATAR_ERROR]', e.message);
        cb({ error: 'Server error' });
      }
    });

    // Settings
    socket.on('save-settings', async ({ settings }, cb) => {
      if (!socket.username) return cb?.({ error: 'Not logged in' });
      await users.updateUser(socket.username, { settings });
      cb?.({ success: true });
    });

    socket.on('get-settings', async (_, cb) => {
      if (!socket.username) return cb?.({ error: 'Not logged in' });
      const user = await users.getUser(socket.username);
      cb?.({ settings: user?.settings || null });
    });

    // WebRTC signaling
    socket.on('offer', ({ to, offer }) => io.to(to).emit('offer', { from: socket.id, offer }));
    socket.on('answer', ({ to, answer }) => io.to(to).emit('answer', { from: socket.id, answer }));
    socket.on('ice-candidate', ({ to, candidate }) => io.to(to).emit('ice-candidate', { from: socket.id, candidate }));

    // Screen share signaling
    socket.on('screen-share-start', () => {
      if (socket.room) socket.to(socket.room).emit('screen-share-start', { userId: socket.id, username: socket.username });
    });
    socket.on('screen-share-stop', () => {
      if (socket.room) socket.to(socket.room).emit('screen-share-stop', { userId: socket.id });
    });
    socket.on('screen-offer', ({ to, offer }) => io.to(to).emit('screen-offer', { from: socket.id, offer }));
    socket.on('screen-answer', ({ to, answer }) => io.to(to).emit('screen-answer', { from: socket.id, answer }));
    socket.on('screen-ice-candidate', ({ to, candidate }) => io.to(to).emit('screen-ice-candidate', { from: socket.id, candidate }));

    // Time sync
    socket.on('time-sync', (clientTime, cb) => cb(Date.now()));
    socket.on('ping', (clientTime, cb) => cb(Date.now()));

    // TURN credentials
    socket.on('get-turn-credentials', (_, cb) => {
      if (!config.turnSecret) return cb(null);
      const timestamp = Math.floor(Date.now() / 1000) + config.turnTtl;
      const turnUsername = `${timestamp}:${socket.username || 'anonymous'}`;
      const hmac = crypto.createHmac('sha1', config.turnSecret);
      hmac.update(turnUsername);
      cb({
        urls: [`turn:${config.turnServer}:3478`, `turn:${config.turnServer}:3478?transport=tcp`],
        username: turnUsername,
        credential: hmac.digest('base64')
      });
    });

    // UDP binding
    socket.on('udp-bind-room', ({ sessionId, roomId }) => {
      udp.addToRoom(sessionId, roomId);
      socket.udpSessionId = sessionId;
      console.log(`[UDP] Client bound: ${sessionId.slice(0, 8)}... -> ${roomId}`);
    });

    // TCP fallback
    socket.on('tcp-bind-room', ({ roomId }) => {
      socket.tcpRoomId = roomId;
      socket.tcpRelay = true;
      console.log(`[TCP] Client bound: ${socket.id} -> ${roomId}`);
    });

    socket.on('tcp-audio', (audioData) => {
      if (!socket.tcpRoomId) return;
      // Relay to all other TCP clients in same room
      for (const [id, s] of io.sockets.sockets) {
        if (id !== socket.id && s.tcpRoomId === socket.tcpRoomId && s.tcpRelay) {
          s.emit('tcp-audio', socket.id, audioData);
        }
      }
    });

    // P2P signaling
    socket.on('p2p-offer', ({ to, natType, publicAddr }) => {
      io.to(to).emit('p2p-offer', { from: socket.id, natType, publicAddr });
    });
    socket.on('p2p-answer', ({ to, success, publicAddr }) => {
      io.to(to).emit('p2p-answer', { from: socket.id, success, publicAddr });
    });

    // SFU mode
    socket.on('set-sfu-mode', ({ enabled }, cb) => {
      if (!socket.room || !rooms.hasRoom(socket.room)) return cb?.({ error: 'Not in room' });
      const roomData = rooms.getRoom(socket.room);
      if (roomData.creatorId !== socket.id) return cb?.({ error: 'Host only' });
      if (!udp.isSfuEnabled()) return cb?.({ error: 'SFU not available on server' });
      
      if (enabled) {
        udp.enableSfuForRoom(socket.room);
      } else {
        udp.disableSfuForRoom(socket.room);
      }
      io.to(socket.room).emit('sfu-mode-changed', { enabled });
      cb?.({ success: true, enabled });
    });

    // Disconnect
    socket.on('disconnect', (reason) => {
      serverStats.activeConnections = Math.max(0, serverStats.activeConnections - 1);
      console.log(`[DISCONNECT] ${socket.id} ${socket.username || 'anonymous'} (${reason})`);
      
      if (socket.room && rooms.hasRoom(socket.room)) {
        rooms.removeUserFromRoom(socket.room, socket.id);
        socket.to(socket.room).emit('user-left', { id: socket.id });
        console.log(`[LEAVE] ${socket.username} left ${socket.room}`);
      }
      
      if (socket.udpSessionId) {
        udp.removeClient(socket.udpSessionId);
      }
    });
  });
}

module.exports = { init };
