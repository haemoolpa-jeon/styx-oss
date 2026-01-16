// Session management service with caching
const fs = require('fs').promises;
const crypto = require('crypto');
const { config } = require('../config');

// In-memory cache
let sessionsCache = null;
let sessionsCacheTime = 0;
const SESSIONS_CACHE_TTL = 5000;

let sessions = new Map();
let saveTimer = null;

// Debounced save (1 second delay)
function debouncedSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveSessions(sessions);
  }, 1000);
}

async function loadSessions() {
  const now = Date.now();
  if (sessionsCache && now - sessionsCacheTime < SESSIONS_CACHE_TTL) {
    return new Map(sessionsCache);
  }
  try {
    const data = await fs.readFile(config.paths.sessions, 'utf8');
    const parsed = JSON.parse(data);
    for (const [k, v] of Object.entries(parsed)) {
      if (v.expires < now) delete parsed[k];
    }
    sessionsCache = Object.entries(parsed);
    sessionsCacheTime = now;
    return new Map(sessionsCache);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[SESSION_ERROR] Failed to load sessions file:', e.message);
    return new Map();
  }
}

async function saveSessions(sessionsMap) {
  try {
    await fs.writeFile(config.paths.sessions, JSON.stringify(Object.fromEntries(sessionsMap), null, 2));
    sessionsCache = [...sessionsMap.entries()];
    sessionsCacheTime = Date.now();
  } catch (e) {
    console.error('[SESSION_ERROR] Failed to save sessions file:', e.message);
  }
}

async function init() {
  sessions = await loadSessions();
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function safeTokenCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function createSession(username, ip, userAgent, isAdmin = false) {
  const token = generateToken();
  const sessionTimeout = isAdmin ? 24 * 60 * 60 * 1000 : 4 * 60 * 60 * 1000;
  
  sessions.set(username, {
    token,
    expires: Date.now() + sessionTimeout,
    ip,
    userAgent,
    lastActivity: Date.now()
  });
  
  debouncedSave();
  return token;
}

function getSession(username) {
  return sessions.get(username);
}

function validateSession(username, token) {
  const session = sessions.get(username);
  if (!session) return false;
  if (!safeTokenCompare(session.token, token)) return false;
  if (session.expires < Date.now()) {
    sessions.delete(username);
    debouncedSave();
    return false;
  }
  return true;
}

function extendSession(username, isAdmin = false) {
  const session = sessions.get(username);
  if (session) {
    const timeout = isAdmin ? 7 * 24 * 60 * 60 * 1000 : 4 * 60 * 60 * 1000;
    session.expires = Date.now() + timeout;
    debouncedSave();
  }
}

function deleteSession(username) {
  sessions.delete(username);
  debouncedSave();
}

async function cleanupExpired() {
  const now = Date.now();
  let cleaned = 0;
  for (const [k, v] of sessions) {
    if (v.expires < now) {
      sessions.delete(k);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    await saveSessions(sessions);
    console.log(`[CLEANUP] Cleaned ${cleaned} expired sessions`);
  }
  return cleaned;
}

function getCacheStats() {
  return {
    sessionsAge: sessionsCache ? Math.floor((Date.now() - sessionsCacheTime) / 1000) : null
  };
}

function getSessions() {
  return sessions;
}

function getSessionsByUser(username) {
  const session = sessions.get(username);
  if (!session) return [];
  return [{ ...session, token: session.token.slice(0, 8) + '...' }];
}

function deleteSessionsByUser(username) {
  sessions.delete(username);
}

module.exports = {
  init,
  generateToken,
  safeTokenCompare,
  createSession,
  getSession,
  validateSession,
  extendSession,
  deleteSession,
  cleanupExpired,
  getCacheStats,
  getSessions,
  saveSessions,
  getSessionsByUser,
  deleteSessionsByUser
};
