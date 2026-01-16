// Input validation schemas and utilities
const { z } = require('zod');

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

const validateUsername = (u) => schemas.username.safeParse(u).success;

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

function validateRoomName(name) {
  if (!name || typeof name !== 'string') return false;
  const sanitized = sanitizeInput(name, 30);
  return sanitized.length >= 2 && sanitized.length <= 30 && 
         /^[a-zA-Z0-9가-힣\s_-]+$/.test(sanitized) &&
         !sanitized.includes('..') &&
         !sanitized.startsWith('.');
}

const sanitize = (s) => String(s).replace(/[<>"'&]/g, '').replace(/[\x00-\x1f\x7f]/g, '');

// IPv4 validation with proper octet range
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
