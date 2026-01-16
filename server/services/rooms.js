// Room management service
const bcrypt = require('bcrypt');

const rooms = new Map();
const roomDeletionTimers = new Map();
const ROOM_EMPTY_TIMEOUT = 5 * 60 * 1000;

let io = null;
let sfuCleanupCallback = null; // Set by init()

function init(socketIo, onSfuCleanup = null) {
  io = socketIo;
  sfuCleanupCallback = onSfuCleanup;
}

function broadcastRoomList() {
  const list = [];
  rooms.forEach((data, name) => {
    if (data.isPrivate) return;
    list.push({
      name,
      userCount: data.users.size,
      maxUsers: data.maxUsers || 8,
      hasPassword: !!data.passwordHash,
      creatorUsername: data.creatorUsername,
      users: [...data.users.values()].map(u => u.username)
    });
  });
  if (io) io.emit('room-list', list);
}

function scheduleRoomDeletion(roomName) {
  if (roomDeletionTimers.has(roomName)) {
    clearTimeout(roomDeletionTimers.get(roomName));
  }
  console.log(`방 삭제 예약: ${roomName} (5분 후)`);
  
  const timer = setTimeout(() => {
    const roomData = rooms.get(roomName);
    if (roomData && roomData.users.size === 0) {
      if (sfuCleanupCallback) sfuCleanupCallback(roomName);
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

async function createRoom(roomName, creatorId, creatorUsername, password, settings = {}) {
  const passwordHash = password ? await bcrypt.hash(password, 8) : null;
  
  rooms.set(roomName, {
    users: new Map(),
    messages: [],
    passwordHash,
    creatorId,
    creatorUsername,
    metronome: { bpm: settings.bpm || 120, playing: false, startTime: null },
    delayCompensation: false,
    maxUsers: Math.min(Math.max(settings.maxUsers || 8, 2), 8),
    audioMode: settings.audioMode || 'music',
    bitrate: settings.bitrate || 96,
    sampleRate: settings.sampleRate || 48000,
    isPrivate: settings.isPrivate || false,
    roles: new Map()
  });
  
  return rooms.get(roomName);
}

function getRoom(roomName) {
  return rooms.get(roomName);
}

function hasRoom(roomName) {
  return rooms.has(roomName);
}

function deleteRoom(roomName) {
  if (sfuCleanupCallback) sfuCleanupCallback(roomName);
  rooms.delete(roomName);
  broadcastRoomList();
}

async function verifyRoomPassword(roomName, password) {
  const room = rooms.get(roomName);
  if (!room || !room.passwordHash) return true;
  return bcrypt.compare(password || '', room.passwordHash);
}

function addUserToRoom(roomName, socketId, username, avatar) {
  const room = rooms.get(roomName);
  if (!room) return null;
  
  room.users.set(socketId, { username, avatar });
  
  const role = room.creatorId === socketId ? 'host' : 'performer';
  room.roles.set(socketId, role);
  
  cancelRoomDeletion(roomName);
  broadcastRoomList();
  
  return role;
}

function removeUserFromRoom(roomName, socketId) {
  const room = rooms.get(roomName);
  if (!room) return;
  
  room.users.delete(socketId);
  room.roles.delete(socketId);
  
  if (room.users.size === 0) {
    scheduleRoomDeletion(roomName);
  }
  broadcastRoomList();
}

function getRoomUsers(roomName) {
  const room = rooms.get(roomName);
  if (!room) return [];
  
  return [...room.users.entries()].map(([id, u]) => ({
    id,
    username: u.username,
    avatar: u.avatar,
    role: room.roles.get(id)
  }));
}

function addMessage(roomName, username, text) {
  const room = rooms.get(roomName);
  if (!room) return null;
  
  const msg = { username, text, time: Date.now() };
  room.messages.push(msg);
  if (room.messages.length > 100) room.messages.shift();
  
  return msg;
}

function getRooms() {
  return rooms;
}

function getRoomCount() {
  return rooms.size;
}

module.exports = {
  init,
  broadcastRoomList,
  scheduleRoomDeletion,
  cancelRoomDeletion,
  createRoom,
  getRoom,
  hasRoom,
  deleteRoom,
  verifyRoomPassword,
  addUserToRoom,
  removeUserFromRoom,
  getRoomUsers,
  addMessage,
  getRooms,
  getRoomCount
};
