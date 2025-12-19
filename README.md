# 🎵 Styx

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Real-time audio collaboration platform for musicians and voice chat.

## Features

### Audio
- **Real-time P2P audio** - Low-latency WebRTC streaming
- **Up to 8 users** - Per room
- **TURN server support** - Reliable connection behind NAT/firewall
- **Individual volume control** - Per-user volume/pan/mute/solo
- **Voice/Music modes** - Optimized audio settings

### Metronome
- **Shared metronome** - Room-wide BPM sync
- **Server time sync** - Accurate beat alignment
- **Count-in** - 4-beat countdown

### User Management
- **Registration/Login** - bcrypt encrypted passwords
- **Admin approval** - Approve/reject sign-up requests
- **Avatars** - Profile image upload

### Room Features
- **Room browser** - Active room list
- **Private rooms** - Password protection
- **Chat** - In-room text chat

## Quick Start

```bash
git clone https://github.com/haemoolpa-jeon/styx.git
cd styx
npm install
npm run setup    # Create admin account
npm start        # Start server
```

Open `http://localhost:3000` in browser

**Default admin**: `admin` / `admin123` (change after first login!)

## File Structure

```
styx/
├── server/index.js       # Signaling server
├── shared/client/        # Shared client code
├── client/config.js      # Web version config
├── styx-desktop/         # Tauri desktop app
├── docs/                 # Documentation
└── .env.example          # Environment variables
```

## Architecture

```
┌─────────┐                           ┌─────────┐
│ User A  │◄──── WebRTC P2P Audio ───►│ User B  │
└────┬────┘                           └────┬────┘
     │                                      │
     │    ┌─────────────────────────┐      │
     └───►│      Styx Server        │◄─────┘
          │  • Socket.IO signaling  │
          │  • Room/Chat/Metronome  │
          │  • TURN credentials     │
          └───────────┬─────────────┘
                      │
          ┌───────────▼─────────────┐
          │   Coturn TURN Server    │
          │  • NAT traversal relay  │
          │  • UDP/TCP 3478         │
          └─────────────────────────┘
```

## Environment Variables

```bash
# .env
PORT=3000
CORS_ORIGINS=https://your-domain.com,tauri://localhost
TURN_SERVER=your-server-ip
TURN_SECRET=your-coturn-secret
```

## Deployment

See [docs/AWS_LIGHTSAIL_DEPLOY.md](docs/AWS_LIGHTSAIL_DEPLOY.md) for deployment guide.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Server | Node.js + Express + Socket.IO |
| Client | Vanilla JS + WebRTC + Web Audio |
| TURN | Coturn (time-limited credentials) |
| Desktop | Tauri + Rust |

## Documentation

- [User Manual (Korean)](docs/USER_MANUAL.md)
- [Deployment Guide](docs/AWS_LIGHTSAIL_DEPLOY.md)
- [Testing Guide](docs/TESTING_GUIDE.md)

## License

MIT License - see [LICENSE](LICENSE) for details.
