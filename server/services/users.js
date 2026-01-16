// User management service with caching
const fs = require('fs').promises;
const fsSync = require('fs');
const bcrypt = require('bcrypt');
const { Mutex } = require('async-mutex');
const { config } = require('../config');

const fileMutex = new Mutex();
/** @param {Function} fn - Function to run with file lock */
const withLock = (fn) => fileMutex.runExclusive(fn);

/** @type {Object|null} In-memory user data cache */
let usersCache = null;
let usersCacheTime = 0;
/** @constant {number} Cache TTL in ms */
const USERS_CACHE_TTL = 5000;

// Ensure data directory exists
if (!fsSync.existsSync(require('path').dirname(config.paths.users))) {
  fsSync.mkdirSync(require('path').dirname(config.paths.users), { recursive: true });
}

async function loadUsers() {
  const now = Date.now();
  if (usersCache && now - usersCacheTime < USERS_CACHE_TTL) {
    return JSON.parse(JSON.stringify(usersCache));
  }
  try {
    const data = await fs.readFile(config.paths.users, 'utf8');
    usersCache = JSON.parse(data);
    usersCacheTime = now;
    return JSON.parse(JSON.stringify(usersCache));
  } catch (e) {
    console.error('[FILE_ERROR] Failed to load users file:', e.message);
    return { users: {}, pending: {} };
  }
}

async function saveUsers(data) {
  try {
    await fs.writeFile(config.paths.users, JSON.stringify(data, null, 2));
    usersCache = JSON.parse(JSON.stringify(data));
    usersCacheTime = Date.now();
  } catch (e) {
    console.error('[FILE_ERROR] Failed to save users file:', e.message);
  }
}

/**
 * Get user by username
 * @param {string} username
 * @returns {Promise<Object|null>} User object or null
 */
async function getUser(username) {
  const data = await loadUsers();
  return data.users[username] || null;
}

async function createUser(username, passwordHash, approved = false, isAdmin = false) {
  return withLock(async () => {
    const data = await loadUsers();
    if (data.users[username]) return { error: 'Username taken' };
    
    data.users[username] = {
      password: passwordHash,
      approved,
      isAdmin,
      avatar: null,
      createdAt: new Date().toISOString()
    };
    await saveUsers(data);
    return { success: true };
  });
}

async function updateUser(username, updates) {
  return withLock(async () => {
    const data = await loadUsers();
    if (!data.users[username]) return { error: 'User not found' };
    
    Object.assign(data.users[username], updates);
    await saveUsers(data);
    return { success: true };
  });
}

async function deleteUser(username) {
  return withLock(async () => {
    const data = await loadUsers();
    if (!data.users[username]) return { error: 'User not found' };
    
    delete data.users[username];
    delete data.pending[username];
    await saveUsers(data);
    return { success: true };
  });
}

async function addPendingUser(username, passwordHash) {
  return withLock(async () => {
    const data = await loadUsers();
    if (data.users[username] || data.pending[username]) {
      return { error: 'Username taken' };
    }
    
    data.pending[username] = {
      password: passwordHash,
      requestedAt: new Date().toISOString()
    };
    await saveUsers(data);
    return { success: true };
  });
}

async function approvePendingUser(username) {
  return withLock(async () => {
    const data = await loadUsers();
    if (!data.pending[username]) return { error: 'No pending request' };
    
    data.users[username] = {
      password: data.pending[username].password,
      approved: true,
      isAdmin: false,
      avatar: null,
      createdAt: new Date().toISOString()
    };
    delete data.pending[username];
    await saveUsers(data);
    return { success: true };
  });
}

async function rejectPendingUser(username) {
  return withLock(async () => {
    const data = await loadUsers();
    delete data.pending[username];
    await saveUsers(data);
    return { success: true };
  });
}

async function getPendingUsers() {
  const data = await loadUsers();
  return Object.keys(data.pending);
}

async function getAllUsers() {
  const data = await loadUsers();
  return Object.entries(data.users).map(([username, u]) => ({
    username,
    isAdmin: u.isAdmin,
    createdAt: u.createdAt,
    avatar: u.avatar
  }));
}

/**
 * Verify user password
 * @param {string} username
 * @param {string} password - Plain text password
 * @returns {Promise<boolean>}
 */
async function verifyPassword(username, password) {
  const user = await getUser(username);
  if (!user) return false;
  return bcrypt.compare(password, user.password);
}

async function hashPassword(password) {
  return bcrypt.hash(password, config.saltRounds);
}

function getCacheStats() {
  return {
    usersAge: usersCache ? Math.floor((Date.now() - usersCacheTime) / 1000) : null
  };
}

module.exports = {
  loadUsers,
  saveUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  addPendingUser,
  approvePendingUser,
  rejectPendingUser,
  getPendingUsers,
  getAllUsers,
  verifyPassword,
  hashPassword,
  withLock,
  getCacheStats
};
