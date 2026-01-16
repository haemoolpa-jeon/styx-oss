// UDP relay service
const dgram = require('dgram');
const { config } = require('../config');

const SESSION_ID_LEN = 20;
const MAX_PACKET_SIZE = 1500;

// Data structures
const udpClients = new Map();
const roomMembers = new Map();
const relayBuffer = Buffer.alloc(MAX_PACKET_SIZE + SESSION_ID_LEN);

// Rate limiting
const UDP_RATE_LIMIT = 500;
const UDP_RATE_WINDOW = 1000;
const udpRateLimits = new Map();

// Stats
let udpStats = { packetsIn: 0, packetsOut: 0, bytesIn: 0, bytesOut: 0, rateLimited: 0 };

// SFU support
let sfuEnabled = false;
let sfuMixer = null;
const sfuRooms = new Set();

let udpServer = null;

function checkUdpRateLimit(ip) {
  const now = Date.now();
  let record = udpRateLimits.get(ip);
  if (!record || now - record.windowStart > UDP_RATE_WINDOW) {
    udpRateLimits.set(ip, { count: 1, windowStart: now });
    return true;
  }
  record.count++;
  return record.count <= UDP_RATE_LIMIT;
}

function init() {
  // Try to load SFU mixer
  try {
    sfuMixer = require('../sfu');
    sfuEnabled = true;
    console.log('[SFU] Audio mixer loaded');
  } catch (e) {
    console.log('[SFU] Audio mixer not available (opusscript not installed)');
  }

  udpServer = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  udpServer.on('message', (msg, rinfo) => {
    // Handle raw ping packets (9 bytes: 'P' + 8-byte timestamp) for latency measurement
    if (msg.length === 9 && msg[0] === 0x50) {
      const pong = Buffer.alloc(9);
      pong[0] = 0x4F; // 'O' for pong
      msg.copy(pong, 1, 1, 9); // Copy timestamp
      udpServer.send(pong, rinfo.port, rinfo.address);
      return;
    }

    if (msg.length < SESSION_ID_LEN + 1 || msg.length > MAX_PACKET_SIZE) return;

    if (!checkUdpRateLimit(rinfo.address)) {
      udpStats.rateLimited++;
      return;
    }

    const sessionId = msg.slice(0, SESSION_ID_LEN).toString().replace(/\0/g, '');
    const payload = msg.slice(SESSION_ID_LEN);

    udpStats.packetsIn++;
    udpStats.bytesIn += msg.length;

    // Register/update client address BEFORE handling any packet type
    let client = udpClients.get(sessionId);
    if (!client) {
      console.log(`[UDP] New client: ${sessionId.slice(0, 8)}... from ${rinfo.address}:${rinfo.port}`);
      udpClients.set(sessionId, { address: rinfo.address, port: rinfo.port, roomId: null, lastSeen: Date.now() });
      client = udpClients.get(sessionId);
    } else {
      // Update address/port if changed (NAT rebinding)
      if (client.address !== rinfo.address || client.port !== rinfo.port) {
        client.address = rinfo.address;
        client.port = rinfo.port;
      }
      client.lastSeen = Date.now();
    }

    // Handle ping with timestamp
    if (payload.length === 9 && payload[0] === 0x50) {
      const pong = Buffer.alloc(9);
      pong[0] = 0x4F;
      payload.copy(pong, 1, 1, 9);
      udpServer.send(pong, rinfo.port, rinfo.address);
      return;
    }

    // Handle legacy ping
    if (payload.length === 1 && payload[0] === 0x50) {
      udpServer.send(Buffer.from([0x4F]), rinfo.port, rinfo.address);
      return;
    }

    // Audio relay requires roomId
    if (!client.roomId) return;

    const members = roomMembers.get(client.roomId);
    if (!members) return;

    // Relay to room members
    const packetLen = SESSION_ID_LEN + payload.length;
    msg.copy(relayBuffer, 0, 0, SESSION_ID_LEN);
    payload.copy(relayBuffer, SESSION_ID_LEN);

    for (const otherId of members) {
      if (otherId === sessionId) continue;
      const other = udpClients.get(otherId);
      if (!other || !other.address) continue;

      udpServer.send(relayBuffer, 0, packetLen, other.port, other.address);
      udpStats.packetsOut++;
      udpStats.bytesOut += packetLen;
    }
  });

  udpServer.on('listening', () => console.log(`[UDP] Relay server on port ${config.udpPort}`));
  udpServer.on('error', (err) => console.error('[UDP] Error:', err));
  udpServer.bind(config.udpPort);

  // Cleanup stale clients every 30 seconds
  setInterval(() => {
    const now = Date.now();
    let staleCount = 0;
    for (const [sessionId, client] of udpClients) {
      if (now - client.lastSeen > 30000) {
        removeClient(sessionId);
        staleCount++;
      }
    }
    if (staleCount > 0) console.log(`[UDP] Cleaned ${staleCount} stale clients`);
    if (udpStats.packetsIn > 0) {
      console.log(`[UDP] Stats: ${udpStats.packetsIn} in, ${udpStats.packetsOut} out, ${udpClients.size} clients`);
      // Reset counters but preserve rateLimited for monitoring
      udpStats.packetsIn = 0;
      udpStats.packetsOut = 0;
      udpStats.bytesIn = 0;
      udpStats.bytesOut = 0;
    }
  }, 30000);
}

function addToRoom(sessionId, roomId) {
  let client = udpClients.get(sessionId);
  if (!client) {
    client = { address: null, port: null, roomId: null, lastSeen: Date.now() };
    udpClients.set(sessionId, client);
  }

  if (client.roomId && roomMembers.has(client.roomId)) {
    roomMembers.get(client.roomId).delete(sessionId);
  }

  client.roomId = roomId;
  if (!roomMembers.has(roomId)) roomMembers.set(roomId, new Set());
  roomMembers.get(roomId).add(sessionId);
}

function removeClient(sessionId) {
  const client = udpClients.get(sessionId);
  if (client?.roomId) {
    if (roomMembers.has(client.roomId)) {
      roomMembers.get(client.roomId).delete(sessionId);
      if (roomMembers.get(client.roomId).size === 0) {
        roomMembers.delete(client.roomId);
      }
    }
    if (sfuEnabled && sfuRooms.has(client.roomId) && sfuMixer) {
      sfuMixer.getMixer(client.roomId).removePeer(sessionId);
    }
  }
  udpClients.delete(sessionId);
}

function removeFromRoom(sessionId) {
  const client = udpClients.get(sessionId);
  if (!client) return;
  
  if (client.roomId && roomMembers.has(client.roomId)) {
    roomMembers.get(client.roomId).delete(sessionId);
    if (roomMembers.get(client.roomId).size === 0) {
      roomMembers.delete(client.roomId);
    }
  }
  client.roomId = null;
}

function cleanupRateLimits() {
  const now = Date.now();
  for (const [ip, record] of udpRateLimits) {
    if (now - record.windowStart > UDP_RATE_WINDOW * 2) {
      udpRateLimits.delete(ip);
    }
  }
}

function getStats() {
  return {
    clients: udpClients.size,
    rooms: roomMembers.size,
    ...udpStats,
    rateLimitsTracked: udpRateLimits.size
  };
}

function isSfuEnabled() {
  return sfuEnabled;
}

function enableSfuForRoom(roomId) {
  sfuRooms.add(roomId);
}

function disableSfuForRoom(roomId) {
  sfuRooms.delete(roomId);
  if (sfuMixer) sfuMixer.removeMixer(roomId);
}

module.exports = {
  init,
  addToRoom,
  removeFromRoom,
  removeClient,
  cleanupRateLimits,
  getStats,
  isSfuEnabled,
  enableSfuForRoom,
  disableSfuForRoom,
  UDP_RATE_WINDOW
};
