# 🎵 Styx

HADES를 위한 실시간 오디오 협업 플랫폼

## 기능

### 오디오
- **실시간 P2P 오디오** - WebRTC 기반 저지연 스트리밍
- **최대 8명** - 방당 최대 8명 동시 접속
- **TURN 서버** - NAT/방화벽 뒤에서도 안정적 연결
- **개별 볼륨 조절** - 사용자별 볼륨/팬/뮤트/솔로
- **음성/음악 모드** - 용도에 맞는 오디오 최적화

### 메트로놈
- **공유 메트로놈** - 방 전체 BPM 동기화
- **서버 시간 동기화** - 정확한 박자 맞춤
- **카운트인** - 4박 카운트 후 시작

### 사용자 관리
- **회원가입/로그인** - bcrypt 암호화
- **관리자 승인** - 가입 요청 승인/거절
- **아바타** - 프로필 이미지 업로드

### 방 기능
- **방 브라우저** - 활성 방 목록
- **비공개 방** - 비밀번호 설정
- **채팅** - 방 내 텍스트 채팅

## 빠른 시작

```bash
git clone https://github.com/haemoolpa-jeon/styx.git
cd styx
npm install
npm run setup    # 관리자 계정 생성
npm start        # 서버 시작
```

브라우저에서 `http://localhost:3000` 접속

**기본 관리자**: `admin` / `admin123` (첫 로그인 후 변경 필수!)

## 파일 구조

```
styx/
├── server/index.js       # 시그널링 서버
├── shared/client/        # 공유 클라이언트 코드
├── client/config.js      # 웹 버전 설정
├── styx-desktop/         # Tauri 데스크톱 앱
├── docs/                 # 문서
└── .env.example          # 환경변수 예시
```

## 아키텍처

```
┌─────────┐                           ┌─────────┐
│ User A  │◄──── WebRTC P2P 오디오 ───►│ User B  │
└────┬────┘                           └────┬────┘
     │                                      │
     │    ┌─────────────────────────┐      │
     └───►│   Styx 서버 (서울)       │◄─────┘
          │  • Socket.IO 시그널링    │
          │  • 방/채팅/메트로놈       │
          │  • TURN 자격증명 발급    │
          └───────────┬─────────────┘
                      │
          ┌───────────▼─────────────┐
          │   Coturn TURN 서버      │
          │  • NAT 통과 릴레이       │
          │  • UDP/TCP 3478         │
          └─────────────────────────┘
```

## 환경 변수

```bash
# .env
PORT=3000
CORS_ORIGINS=https://your-domain.com,tauri://localhost
TURN_SERVER=your-server-ip
TURN_SECRET=your-coturn-secret
```

## 배포

자세한 배포 가이드는 [docs/AWS_LIGHTSAIL_DEPLOY.md](docs/AWS_LIGHTSAIL_DEPLOY.md) 참조

## 기술 스택

| 구성요소 | 기술 |
|---------|------|
| 서버 | Node.js + Express + Socket.IO |
| 클라이언트 | Vanilla JS + WebRTC + Web Audio |
| TURN | Coturn (time-limited credentials) |
| 데스크톱 | Tauri + Rust |

## 문서

- [사용 설명서](docs/USER_MANUAL.md)
- [배포 가이드](docs/AWS_LIGHTSAIL_DEPLOY.md)
- [테스트 가이드](docs/TESTING_GUIDE.md)

## 라이선스

HADES 전용 - 비공개 사용
