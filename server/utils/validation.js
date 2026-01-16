// Input validation schemas and utilities
const { z } = require('zod');

/** @type {Object} Zod validation schemas */
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

/**
 * Validate username format (2-20 chars, alphanumeric/Korean/underscore)
 * @param {string} u - Username to validate
 * @returns {boolean}
 */
const validateUsername = (u) => schemas.username.safeParse(u).success;

/**
 * Validate password strength
 * @param {string} p - Password to validate
 * @returns {{valid: boolean, error?: string}}
 */
const validatePassword = (p) => {
  if (!schemas.password.safeParse(p).success) {
    return { valid: false, error: 'Password must be 4-50 characters' };
  }
  if (p.length < 6) return { valid: false, error: 'Password must be at least 6 characters' };
  if (!/[a-zA-Z]/.test(p)) return { valid: false, error: 'Password must contain at least one letter' };
  if (!/[0-9]/.test(p)) return { valid: false, error: 'Password must contain at least one number' };
  
  const weak = ['123456', 'password', 'qwerty', '111111', '123123', 'admin', 'user'];
  if (weak.includes(p.toLowerCase())) return { valid: false, error: 'Password is too common' };
  
  return { valid: true };
};

/**
 * Sanitize input string (trim, limit length, remove dangerous chars)
 * @param {string} input - Input to sanitize
 * @param {number} [maxLength=100] - Maximum length
 * @returns {string} Sanitized string
 */
function sanitizeInput(input, maxLength = 100) {
  if (typeof input !== 'string') return '';
  return input
    .trim()
    .slice(0, maxLength)
    .replace(/[<>]/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+=/gi, '')
    .replace(/[\x00-\x1f\x7f]/g, '');
}

/**
 * Validate room name (2-30 chars, safe characters only)
 * @param {string} name - Room name to validate
 * @returns {boolean}
 */
function validateRoomName(name) {
  if (!name || typeof name !== 'string') return false;
  const sanitized = sanitizeInput(name, 30);
  return sanitized.length >= 2 && sanitized.length <= 30 && 
         /^[a-zA-Z0-9가-힣\s_-]+$/.test(sanitized) &&
         !sanitized.includes('..') &&
         !sanitized.startsWith('.');
}

/** @param {string} s - String to sanitize */
const sanitize = (s) => String(s).replace(/[<>"'&]/g, '').replace(/[\x00-\x1f\x7f]/g, '');

/**
 * Validate IPv4 address format with proper octet range (0-255)
 * @param {string} ip - IP address to validate
 * @returns {boolean}
 */
const isValidIPv4 = (ip) => {
  if (!ip) return false;
  return /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(ip);
};

module.exports = {
  schemas,
  validateUsername,
  validatePassword,
  sanitizeInput,
  validateRoomName,
  sanitize,
  isValidIPv4
};
