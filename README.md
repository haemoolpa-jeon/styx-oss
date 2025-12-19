# 🎵 Styx

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Real-time audio collaboration platform for musicians and voice chat.

## Features

### Audio
- **Real-time P2P audio** - Low-latency WebRTC streaming
- **Up to 8 users** - Per room
- **TURN server support** - Reliable connection behind NAT/firewall
- **Individual volume control** - Per-user volume/pan/mute/solo
- **Voice/Music modes** - Optimized audio settings for different use cases

### Metronome
- **Shared metronome** - Room-wide BPM sync
- **Server time sync** - Accurate beat alignment across all users
- **Count-in** - 4-beat countdown before start

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
git clone https://github.com/haemoolpa-jeon/styx-oss.git
cd styx-oss
npm install
npm run setup    # Create admin account
npm start        # Start server
```

Open `http://localhost:3000` in your browser (Chrome recommended).

**Default admin**: `admin` / `admin123` (change after first login!)

## File Structure

```
styx/
├── server/index.js       # Signaling server
├── shared/client/        # Shared client code
├── client/config.js      # Web client config
├── styx-desktop/         # Tauri desktop app
├── docs/                 # Documentation
└── .env.example          # Environment variables template
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

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
PORT=3000
CORS_ORIGINS=https://your-domain.com,tauri://localhost
TURN_SERVER=your-turn-server-ip
TURN_SECRET=your-coturn-secret
```

## Deployment

See deployment guides:
- [AWS Lightsail](docs/AWS_LIGHTSAIL_DEPLOY.md)
- [Oracle Cloud](docs/ORACLE_CLOUD_DEPLOY.md)

## Tech Stack

| Component | Technology |
|-----------|------------|
| Server | Node.js + Express + Socket.IO |
| Client | Vanilla JS + WebRTC + Web Audio API |
| TURN | Coturn (time-limited credentials) |
| Desktop | Tauri + Rust |

## Documentation

- [User Manual (Korean)](docs/USER_MANUAL.md)
- [Deployment Guide](docs/AWS_LIGHTSAIL_DEPLOY.md)
- [Testing Guide](docs/TESTING_GUIDE.md)
- [Roadmap](docs/ROADMAP.md)

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
