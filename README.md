# 🎵 Styx

HADES를 위한 실시간 오디오 협업 플랫폼

[![CI](https://github.com/haemoolpa-jeon/styx/actions/workflows/ci.yml/badge.svg)](https://github.com/haemoolpa-jeon/styx/actions/workflows/ci.yml)

## 주요 기능

- 🎤 **저지연 오디오** - Opus 코덱, UDP 릴레이, 적응형 지터 버퍼
- 🎸 **음악 협업** - 메트로놈 동기화, 멀티트랙 녹음
- 🔒 **보안** - 사용자 인증, IP 화이트리스트, 속도 제한
- 🖥️ **데스크톱 앱** - Tauri 기반, ASIO 지원, 1.3ms 버퍼

## 빠른 시작

### 서버 실행
```bash
git clone https://github.com/haemoolpa-jeon/styx.git
cd styx
npm install
cp .env.example .env
npm start
```

### 데스크톱 앱 빌드
```bash
cd styx-desktop
npm install
npm run tauri build
```

## 문서

| 문서 | 설명 |
|------|------|
| [사용자 매뉴얼](docs/guides/USER_MANUAL.md) | 기능 사용법 |
| [배포 가이드](docs/guides/DEPLOY.md) | 서버 배포 정보 |
| [AWS Lightsail](docs/guides/AWS_LIGHTSAIL_DEPLOY.md) | Lightsail 배포 |
| [저지연 설정](docs/guides/LOW_LATENCY_SETUP.md) | ASIO/오디오 최적화 |
| [API 문서](docs/development/API.md) | HTTP/Socket.IO API |
| [아키텍처](docs/development/MODULE_ARCHITECTURE.md) | 코드 구조 |

## 서버 구조

```
server/
├── index.js              # 진입점, HTTP 라우트
├── config.js             # 환경 설정
├── handlers/socket.js    # Socket.IO 핸들러
├── middleware/security.js # 속도 제한, 화이트리스트
├── services/
│   ├── users.js          # 사용자 관리 + 캐싱
│   ├── sessions.js       # 세션 관리
│   ├── rooms.js          # 방 관리
│   └── udp.js            # UDP 릴레이
└── utils/
    ├── audit.js          # 보안 로깅
    └── validation.js     # 입력 검증
```

## 시스템 요구사항

### 서버
- Node.js 18+
- 1 GB RAM (50명 동시 접속)
- UDP 포트 5000

### 클라이언트
- Windows 10+ (데스크톱 앱)
- Chrome/Firefox (웹 관전 모드)

## 환경 변수

```env
PORT=3000
UDP_PORT=5000
CORS_ORIGINS=https://your-domain.com
TURN_SERVER=your-turn-server
TURN_SECRET=your-secret
ADMIN_TOKEN=your-admin-token
```

## API 엔드포인트

| 엔드포인트 | 설명 |
|-----------|------|
| `GET /health` | 서버 상태 및 리소스 사용량 |
| `GET /metrics` | Prometheus 형식 메트릭 |
| `GET /audit` | 보안 로그 (관리자 전용) |

## 테스트

```bash
npm test
```

## 라이선스

MIT License - [LICENSE](LICENSE)

---

## 최근 변경사항 (v1.5.3)

- 서버 모듈화 (10개 모듈)
- 리소스 모니터링 (메모리/CPU 알림)
- UDP 릴레이 개선 (다중 피어 지원)
- 키보드 단축키 커스터마이징
- 보안 강화 (관리자 토큰 필수)

전체 변경 이력: [릴리스 노트](docs/release-notes/)
