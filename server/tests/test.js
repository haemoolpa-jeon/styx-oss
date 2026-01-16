// Styx Server Unit Tests
// Run: node server/tests/test.js

const assert = require('assert');

// Test utilities
let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { failed++; console.log(`✗ ${name}: ${e.message}`); }
};

console.log('\n=== Styx Server Unit Tests ===\n');

// ============ Config Tests ============
console.log('--- config.js ---');
const { config, validateEnv } = require('../config');

test('config has required properties', () => {
  assert(config.port, 'port missing');
  assert(config.udpPort, 'udpPort missing');
  assert(config.paths.users, 'paths.users missing');
  assert(config.paths.sessions, 'paths.sessions missing');
  assert(config.saltRounds > 0, 'saltRounds invalid');
});

test('config.corsOrigins is array', () => {
  assert(Array.isArray(config.corsOrigins));
});

// ============ Validation Tests ============
console.log('\n--- validation.js ---');
const { validateUsername, validatePassword, sanitize, isValidIPv4, sanitizeInput, validateRoomName } = require('../utils/validation');

test('validateUsername accepts valid usernames', () => {
  assert(validateUsername('user123'));
  assert(validateUsername('테스트'));
  assert(validateUsername('user_name'));
});

test('validateUsername rejects invalid usernames', () => {
  assert(!validateUsername('a')); // too short
  assert(!validateUsername('a'.repeat(25))); // too long
  assert(!validateUsername('user@name')); // invalid char
  assert(!validateUsername('')); // empty
});

test('validatePassword checks requirements', () => {
  assert(validatePassword('pass123').valid);
  assert(!validatePassword('123').valid); // too short
  assert(!validatePassword('password').valid); // common
  assert(!validatePassword('123456').valid); // no letter
  assert(!validatePassword('abcdef').valid); // no number
});

test('sanitize removes dangerous chars', () => {
  assert.strictEqual(sanitize('<script>'), 'script');
  assert.strictEqual(sanitize('test"quote'), 'testquote');
  assert.strictEqual(sanitize('normal'), 'normal');
});

test('isValidIPv4 validates IP addresses', () => {
  assert(isValidIPv4('192.168.1.1'));
  assert(isValidIPv4('0.0.0.0'));
  assert(isValidIPv4('255.255.255.255'));
  assert(!isValidIPv4('256.1.1.1')); // out of range
  assert(!isValidIPv4('192.168.1')); // incomplete
  assert(!isValidIPv4('not.an.ip.addr'));
  assert(!isValidIPv4(''));
});

test('sanitizeInput limits length and removes control chars', () => {
  assert.strictEqual(sanitizeInput('  test  '), 'test');
  assert.strictEqual(sanitizeInput('a'.repeat(200), 10), 'a'.repeat(10));
  assert.strictEqual(sanitizeInput('test<script>'), 'testscript');
});

test('validateRoomName accepts valid room names', () => {
  assert(validateRoomName('Room 1'));
  assert(validateRoomName('테스트방'));
  assert(validateRoomName('my-room_123'));
});

test('validateRoomName rejects invalid room names', () => {
  assert(!validateRoomName('a')); // too short
  assert(!validateRoomName('.hidden')); // starts with dot
  assert(!validateRoomName('path/../traversal')); // path traversal
});

// ============ Audit Tests ============
console.log('\n--- audit.js ---');
const { logSecurityEvent, getAuditLogs, getAuditLogCount, MAX_AUDIT_LOGS } = require('../utils/audit');

test('logSecurityEvent adds entries', () => {
  const before = getAuditLogCount();
  logSecurityEvent('TEST_EVENT', { test: true });
  assert.strictEqual(getAuditLogCount(), before + 1);
});

test('getAuditLogs returns recent entries', () => {
  logSecurityEvent('TEST_EVENT_2', { data: 'test' });
  const logs = getAuditLogs(5);
  assert(logs.length > 0);
  assert(logs[0].event === 'TEST_EVENT_2');
});

test('MAX_AUDIT_LOGS is defined', () => {
  assert(MAX_AUDIT_LOGS > 0);
});

// ============ Security Middleware Tests ============
console.log('\n--- security.js ---');
const { checkRateLimit, isIpWhitelisted, cleanupAll, getWhitelistStatus } = require('../middleware/security');

test('checkRateLimit allows normal requests', () => {
  assert(checkRateLimit('10.0.0.1'));
  assert(checkRateLimit('10.0.0.2', 'user1'));
});

test('isIpWhitelisted allows localhost', () => {
  assert(isIpWhitelisted('127.0.0.1'));
  assert(isIpWhitelisted('::1'));
});

test('getWhitelistStatus returns status object', () => {
  const status = getWhitelistStatus();
  assert('enabled' in status);
  assert('ips' in status);
  assert('count' in status);
});

test('cleanupAll runs without error', () => {
  cleanupAll(); // Should not throw
});

// ============ Rooms Service Tests ============
// Note: rooms.js requires bcrypt, skip in WSL environment
console.log('\n--- rooms.js ---');
let rooms;
try {
  rooms = require('../services/rooms');
  test('rooms.getRoomCount returns number', () => {
    assert(typeof rooms.getRoomCount() === 'number');
  });
  test('rooms.hasRoom returns false for non-existent room', () => {
    assert(!rooms.hasRoom('nonexistent_room_xyz'));
  });
  test('rooms.getRoom returns null for non-existent room', () => {
    assert(rooms.getRoom('nonexistent_room_xyz') === undefined);
  });
} catch (e) {
  if (e.code === 'ERR_DLOPEN_FAILED') {
    console.log('⚠ Skipped (bcrypt binary incompatible in WSL)');
  } else throw e;
}

// ============ UDP Service Tests ============
console.log('\n--- udp.js ---');
const udp = require('../services/udp');

test('udp.getStats returns stats object', () => {
  const stats = udp.getStats();
  assert('clients' in stats);
  assert('rooms' in stats);
  assert('packetsIn' in stats);
  assert('packetsOut' in stats);
});

test('udp.isSfuEnabled returns boolean', () => {
  assert(typeof udp.isSfuEnabled() === 'boolean');
});

// ============ Summary ============
console.log('\n=== Results ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total:  ${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
