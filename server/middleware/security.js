// Security middleware - rate limiting, CORS, whitelist
const fsSync = require('fs');
const { config } = require('../config');
const { logSecurityEvent } = require('../utils/audit');

/** @type {Map<string, {start: number, count: number}>} IP rate limit records */
const rateLimits = new Map();
/** @type {Map<string, {start: number, count: number}>} User rate limit records */
const userRateLimits = new Map();
/** @type {Map<string, {violations: number, penaltyStart?: number}>} Suspicious IP records */
const suspiciousIPs = new Map();

/** @constant {number} Rate limit window in ms */
const RATE_LIMIT_WINDOW = 60000;
/** @constant {number} Max requests per IP per window */
const RATE_LIMIT_MAX = 100;
/** @constant {number} Max requests per user per window */
const USER_RATE_LIMIT_MAX = 50;
/** @constant {number} Violations before marking suspicious */
const SUSPICIOUS_THRESHOLD = 3;
/** @constant {number} Penalty duration for suspicious IPs (5 min) */
const SUSPICIOUS_PENALTY = 300000;

// IP Whitelist
let ipWhitelist = new Set();
let whitelistEnabled = false;

function loadWhitelist() {
  try {
    if (fsSync.existsSync(config.paths.whitelist)) {
      const data = JSON.parse(fsSync.readFileSync(config.paths.whitelist, 'utf8'));
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
    fsSync.writeFileSync(config.paths.whitelist, JSON.stringify({
      enabled: whitelistEnabled,
      ips: Array.from(ipWhitelist),
      lastModified: new Date().toISOString()
    }, null, 2));
  } catch (e) {
    console.error('Failed to save whitelist:', e);
  }
}

/**
 * Check if IP is whitelisted (or whitelist disabled)
 * @param {string} ip - IP address to check
 * @returns {boolean}
 */
function isIpWhitelisted(ip) {
  if (!whitelistEnabled) return true;
  return ipWhitelist.has(ip) || ip === '127.0.0.1' || ip === '::1';
}

/**
 * Check rate limit for IP and optional user
 * @param {string} ip - Client IP address
 * @param {string} [userId] - Optional user identifier
 * @returns {boolean} True if request allowed, false if rate limited
 */
function checkRateLimit(ip, userId = null) {
  const now = Date.now();

  const suspicious = suspiciousIPs.get(ip);
  if (suspicious && now - suspicious.penaltyStart < SUSPICIOUS_PENALTY) {
    return false;
  }

  // Cleanup expired entries (batch)
  let cleaned = 0;
  for (const [key, record] of rateLimits) {
    if (now - record.start > RATE_LIMIT_WINDOW) {
      rateLimits.delete(key);
      if (++cleaned >= 10) break;
    }
  }

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
    if (ipRecord.count > RATE_LIMIT_MAX) {
      const suspiciousRecord = suspiciousIPs.get(ip) || { violations: 0 };
      suspiciousRecord.violations++;
      if (suspiciousRecord.violations >= SUSPICIOUS_THRESHOLD) {
        suspiciousRecord.penaltyStart = now;
        logSecurityEvent('IP_MARKED_SUSPICIOUS', { ip, violations: suspiciousRecord.violations });
      }
      suspiciousIPs.set(ip, suspiciousRecord);
      return false;
    }
  }

  // Check user-based rate limit
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

function cleanupAll() {
  const now = Date.now();
  
  for (const [ip, record] of rateLimits) {
    if (now - record.start > 60000) rateLimits.delete(ip);
  }
  for (const [userId, record] of userRateLimits) {
    if (now - record.start > 60000) userRateLimits.delete(userId);
  }
  for (const [ip, record] of suspiciousIPs) {
    if (record.penaltyStart && now - record.penaltyStart > SUSPICIOUS_PENALTY + 3600000) {
      suspiciousIPs.delete(ip);
    }
  }
}

function getWhitelistStatus() {
  return {
    enabled: whitelistEnabled,
    ips: Array.from(ipWhitelist),
    count: ipWhitelist.size
  };
}

function setWhitelistEnabled(enabled) {
  whitelistEnabled = enabled;
  saveWhitelist();
}

function addToWhitelist(ip) {
  ipWhitelist.add(ip);
  saveWhitelist();
}

function removeFromWhitelist(ip) {
  ipWhitelist.delete(ip);
  saveWhitelist();
}

// Initialize
loadWhitelist();

module.exports = {
  checkRateLimit,
  isIpWhitelisted,
  cleanupAll,
  getWhitelistStatus,
  setWhitelistEnabled,
  addToWhitelist,
  removeFromWhitelist,
  SUSPICIOUS_PENALTY
};
