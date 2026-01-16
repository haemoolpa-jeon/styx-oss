# Styx Server API Documentation

## HTTP Endpoints

### Health & Monitoring

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | None | Server health check with stats |
| `/metrics` | GET | None | Prometheus-format metrics |
| `/test` | GET | None | Automated test results |
| `/audit` | GET | Admin Token | Security audit logs |

#### GET /health
```json
{
  "status": "healthy",
  "uptime": 3600,
  "stats": { "totalConnections": 100, "activeConnections": 5, ... },
  "cache": { "usersAge": 2, "sessionsAge": 1 },
  "udp": { "clients": 3, "rooms": 1, "packetsIn": 1000, ... }
}
```

#### GET /audit
Headers: `Authorization: Bearer <ADMIN_TOKEN>`
```json
{
  "total": 150,
  "logs": [
    { "timestamp": "2024-01-01T12:00:00Z", "event": "LOGIN_SUCCESS", "ip": "...", "username": "..." }
  ]
}
```

### GDPR Compliance

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/privacy-policy` | GET | None | Privacy policy JSON |
| `/api/gdpr/export` | POST | Password | Export user data |
| `/api/gdpr/delete` | POST | Password | Delete account |

#### POST /api/gdpr/export
```json
// Request
{ "username": "user1", "password": "pass123" }

// Response
{ "exportDate": "...", "userData": {...}, "sessions": [...] }
```

#### POST /api/gdpr/delete
```json
// Request
{ "username": "user1", "password": "pass123", "confirm": "DELETE_MY_ACCOUNT" }

// Response
{ "success": true, "message": "Account and data deleted" }
```

### Static Files

| Path | Description |
|------|-------------|
| `/` | Web client (shared/client) |
| `/avatars/:file` | User avatars |
| `/join/:roomName` | Deep link redirect page |

---

## Socket.IO Events

### Authentication

| Event | Direction | Payload | Response |
|-------|-----------|---------|----------|
| `login` | Client→Server | `{username, password}` | `{success, user, token}` or `{error}` |
| `restore-session` | Client→Server | `{username, token}` | `{success, user}` or `{error}` |
| `signup` | Client→Server | `{username, password}` | `{success, message}` or `{error}` |
| `change-password` | Client→Server | `{oldPassword, newPassword}` | `{success}` or `{error}` |

### Room Management

| Event | Direction | Payload | Response |
|-------|-----------|---------|----------|
| `get-rooms` | Client→Server | `null` | `[{name, userCount, maxUsers, hasPassword, users}]` |
| `join` | Client→Server | `{room, username, password?, settings?}` | `{success, users, messages, metronome, ...}` |
| `leave-room` | Client→Server | - | - |
| `close-room` | Client→Server | `{roomName}` | `{success}` or `{error}` |
| `user-joined` | Server→Client | `{id, username, avatar, role}` | - |
| `user-left` | Server→Client | `{id}` | - |
| `room-closed` | Server→Client | - | - |
| `room-list` | Server→Client | `[{name, userCount, ...}]` | - |

### Chat

| Event | Direction | Payload |
|-------|-----------|---------|
| `chat` | Client→Server | `text` (string) |
| `chat` | Server→Client | `{username, text, time}` |

### Metronome

| Event | Direction | Payload |
|-------|-----------|---------|
| `metronome-update` | Client→Server | `{bpm, playing}` |
| `metronome-sync` | Server→Client | `{bpm, playing, startTime}` |

### Room Settings

| Event | Direction | Payload |
|-------|-----------|---------|
| `update-room-settings` | Client→Server | `{setting, value}` |
| `room-settings-changed` | Server→Client | `{setting, value}` |
| `change-role` | Client→Server | `{userId, role}` |
| `role-changed` | Server→Client | `{userId, role}` |
| `delay-compensation` | Client→Server | `enabled` (boolean) |
| `delay-compensation-sync` | Server→Client | `enabled` (boolean) |

### WebRTC Signaling

| Event | Direction | Payload |
|-------|-----------|---------|
| `offer` | Bidirectional | `{to, offer}` / `{from, offer}` |
| `answer` | Bidirectional | `{to, answer}` / `{from, answer}` |
| `ice-candidate` | Bidirectional | `{to, candidate}` / `{from, candidate}` |

### Screen Share

| Event | Direction | Payload |
|-------|-----------|---------|
| `screen-share-start` | Client→Server | - |
| `screen-share-start` | Server→Client | `{userId, username}` |
| `screen-share-stop` | Bidirectional | `{userId}` |
| `screen-offer/answer/ice-candidate` | Bidirectional | Same as WebRTC |

### UDP/TCP Audio

| Event | Direction | Payload |
|-------|-----------|---------|
| `udp-bind-room` | Client→Server | `{sessionId, roomId}` |
| `tcp-bind-room` | Client→Server | `{roomId}` |
| `tcp-audio` | Bidirectional | Binary audio data |

### P2P Signaling

| Event | Direction | Payload |
|-------|-----------|---------|
| `p2p-offer` | Bidirectional | `{to/from, natType, publicAddr}` |
| `p2p-answer` | Bidirectional | `{to/from, success, publicAddr}` |

### Admin Events

| Event | Direction | Payload |
|-------|-----------|---------|
| `get-pending` | Client→Server | - |
| `get-users` | Client→Server | - |
| `approve-user` | Client→Server | `{username}` |
| `reject-user` | Client→Server | `{username}` |
| `delete-user` | Client→Server | `{username}` |
| `set-admin` | Client→Server | `{username, isAdmin}` |
| `kick-user` | Client→Server | `{socketId}` |
| `admin-whitelist-*` | Client→Server | Various |

### Utility

| Event | Direction | Payload |
|-------|-----------|---------|
| `time-sync` | Client→Server | `clientTime` → `serverTime` |
| `ping` | Client→Server | `clientTime` → `serverTime` |
| `get-turn-credentials` | Client→Server | - → `{urls, username, credential}` |
| `upload-avatar` | Client→Server | `{username, avatarData}` |
| `save-settings` | Client→Server | `{settings}` |
| `get-settings` | Client→Server | - → `{settings}` |
| `peer-latency` | Bidirectional | `{latency}` / `{peerId, latency}` |

### Server Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `error` | Server→Client | `{message}` - Connection error |
| `kicked` | Server→Client | User was kicked by admin |
| `server-shutdown` | Server→Client | Server shutting down |

---

## UDP Protocol

### Packet Format
```
[Session ID (20 bytes)][Payload]
```

### Ping/Pong
- Ping: `0x50` + 8-byte timestamp
- Pong: `0x4F` + 8-byte timestamp (echoed)

### Audio Relay
- Packets are relayed to all room members
- Rate limit: 500 packets/second per IP
- Max packet size: 1500 bytes

---

## Error Codes

| Error | Description |
|-------|-------------|
| `Invalid credentials` | Wrong username/password |
| `Account pending approval` | User not yet approved |
| `Too many requests` | Rate limited |
| `Not admin` | Admin action without admin rights |
| `Not authorized` | Action not permitted |
| `Room full` | Room at max capacity |
| `Wrong room password` | Incorrect room password |
