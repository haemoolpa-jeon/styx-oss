// Socket.IO Integration Tests
// Run: node server/tests/integration.js
// Note: Requires server running on localhost:3000

const { io } = require('socket.io-client');

const SERVER_URL = process.env.TEST_SERVER || 'http://localhost:3000';
let passed = 0, failed = 0, skipped = 0;

const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}: ${e.message}`);
  }
};

const skip = (name) => {
  skipped++;
  console.log(`⊘ ${name} (skipped)`);
};

const createClient = () => {
  return new Promise((resolve, reject) => {
    const socket = io(SERVER_URL, { transports: ['websocket'], timeout: 5000 });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('Connection timeout')), 5000);
  });
};

const emit = (socket, event, data) => {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Response timeout')), 5000);
    socket.emit(event, data, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
};

async function runTests() {
  console.log('\n=== Socket.IO Integration Tests ===\n');
  console.log(`Server: ${SERVER_URL}\n`);

  let client;
  
  try {
    client = await createClient();
    console.log('Connected to server\n');
  } catch (e) {
    console.log(`✗ Cannot connect to server: ${e.message}`);
    console.log('\nMake sure server is running: npm start\n');
    process.exit(1);
  }

  // Connection tests
  await test('Client connects successfully', async () => {
    if (!client.connected) throw new Error('Not connected');
  });

  // Auth tests
  await test('Login with invalid credentials returns error', async () => {
    const res = await emit(client, 'login', { username: 'nonexistent_user_xyz', password: 'wrong' });
    if (!res.error) throw new Error('Expected error');
  });

  await test('Signup with invalid username returns error', async () => {
    const res = await emit(client, 'signup', { username: '@', password: 'test123' });
    if (!res.error) throw new Error('Expected error');
  });

  await test('Signup with weak password returns error', async () => {
    const res = await emit(client, 'signup', { username: 'testuser', password: '123' });
    if (!res.error) throw new Error('Expected error');
  });

  // Room tests
  await test('get-rooms returns array', async () => {
    const res = await emit(client, 'get-rooms', null);
    if (!Array.isArray(res)) throw new Error('Expected array');
  });

  // Time sync tests
  await test('time-sync returns server timestamp', async () => {
    const clientTime = Date.now();
    const serverTime = await emit(client, 'time-sync', clientTime);
    if (typeof serverTime !== 'number') throw new Error('Expected number');
    if (Math.abs(serverTime - clientTime) > 10000) throw new Error('Time drift too large');
  });

  await test('ping returns server timestamp', async () => {
    const serverTime = await emit(client, 'ping', Date.now());
    if (typeof serverTime !== 'number') throw new Error('Expected number');
  });

  // Admin tests (should fail without admin rights)
  await test('get-pending without admin returns error', async () => {
    const res = await emit(client, 'get-pending', null);
    if (!res.error) throw new Error('Expected error');
  });

  await test('get-users without admin returns error', async () => {
    const res = await emit(client, 'get-users', null);
    if (!res.error) throw new Error('Expected error');
  });

  // Settings tests (should fail without login)
  await test('save-settings without login returns error', async () => {
    const res = await emit(client, 'save-settings', { settings: {} });
    if (!res.error) throw new Error('Expected error');
  });

  await test('get-settings without login returns error', async () => {
    const res = await emit(client, 'get-settings', null);
    if (!res.error) throw new Error('Expected error');
  });

  // Whitelist tests (should fail without admin)
  await test('admin-whitelist-status without admin returns error', async () => {
    const res = await emit(client, 'admin-whitelist-status', null);
    if (!res.error) throw new Error('Expected error');
  });

  // TURN credentials (may return null if not configured)
  await test('get-turn-credentials returns response', async () => {
    const res = await emit(client, 'get-turn-credentials', null);
    // Can be null (not configured) or object with urls
    if (res !== null && !res.urls) throw new Error('Invalid response');
  });

  // Cleanup
  client.disconnect();

  // Summary
  console.log('\n=== Results ===');
  console.log(`Passed:  ${passed}`);
  console.log(`Failed:  ${failed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Total:   ${passed + failed + skipped}`);
  
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});
