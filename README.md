# 🎵 Styx

HADES를 위한 실시간 오디오 협업 플랫폼

## 기능

### 오디오
- **실시간 P2P 오디오** - WebRTC 기반 저지연 스트리밍
- **최대 8명** - 방당 최대 8명 동시 접속
- **오디오 장치 선택** - 마이크/오디오 인터페이스 선택
- **개별 볼륨 조절** - 사용자별 볼륨 슬라이더
- **지연시간 표시** - 각 사용자와의 RTT 실시간 표시
- **오디오 레벨 미터** - 입력 볼륨 시각화

### 메트로놈
- **공유 메트로놈** - 방 전체 BPM 동기화
- **30-300 BPM** - 조절 가능한 템포
- **시각/청각 피드백** - 클릭음 + LED 표시

### 사용자 관리
- **회원가입/로그인** - bcrypt 암호화
- **관리자 승인** - 가입 요청 승인/거절
- **비밀번호 변경** - 설정에서 변경 가능
- **아바타** - 프로필 이미지 업로드 (최대 2MB)
- **세션 유지** - 로그인 상태 저장

### 방 기능
- **방 브라우저** - 활성 방 목록 및 클릭 입장
- **비공개 방** - 비밀번호 설정 가능
- **채팅** - 방 내 텍스트 채팅
- **강퇴** - 관리자 전용

## 빠른 시작

```bash
cd styx
npm install
npm run setup    # 관리자 계정 생성
npm start        # 서버 시작
```

브라우저에서 `http://localhost:3000` 접속

## 기본 관리자 계정

```
사용자명: admin
비밀번호: admin123
```

⚠️ 첫 로그인 후 설정에서 비밀번호를 변경하세요!

## 파일 구조

```
styx/
├── server/
│   ├── index.js      # 시그널링 서버
│   └── users.json    # 사용자 DB
├── avatars/          # 아바타 이미지
├── client/
│   ├── index.html    # 웹 UI
│   ├── app.js        # 클라이언트 로직
│   └── style.css     # 스타일
├── package.json
├── setup.js          # 초기 설정
└── README.md
```

## AWS 서울 배포

### 1. EC2 인스턴스 생성

- 리전: **ap-northeast-2 (서울)**
- AMI: Amazon Linux 2023
- 인스턴스: t3.micro
- 보안 그룹: SSH(22), HTTP(80), TCP(3000)

### 2. 서버 설정

```bash
ssh -i your-key.pem ec2-user@<IP>

# Node.js 설치
sudo dnf install -y nodejs

# 코드 업로드
git clone https://github.com/haemoolpa-jeon/styx.git
cd styx

# 설정 및 실행
npm install
npm run setup
sudo npm install -g pm2
pm2 start server/index.js --name styx
pm2 startup && pm2 save
```

### 3. Nginx + HTTPS (선택)

```bash
sudo dnf install -y nginx certbot python3-certbot-nginx

# /etc/nginx/conf.d/styx.conf
server {
    listen 80;
    server_name your-domain.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}

sudo systemctl enable --now nginx
sudo certbot --nginx -d your-domain.com
```

## 사용 방법

### 회원가입
1. 회원가입 탭 → 사용자명/비밀번호 입력
2. "가입 요청" 클릭
3. 관리자 승인 대기

### 방 입장
1. 로그인 후 오디오 장치 선택
2. 방 목록에서 클릭 또는 새 방 이름 입력
3. 비공개 방은 비밀번호 입력
4. "입장" 클릭

### 메트로놈 사용
1. ▶️ 버튼으로 시작/정지
2. BPM 입력란에서 템포 조절
3. 모든 사용자에게 동기화됨

### 관리자 기능
- 👑 버튼 → 가입 승인/거절
- 사용자 목록에서 삭제 가능
- 방에서 사용자 강퇴 가능

## 오디오 설정

악기 연주를 위해 자동 적용:
- 에코 제거: OFF
- 노이즈 억제: OFF
- 자동 게인: OFF

## 문제 해결

### 연결 안 됨
- 방화벽 확인
- 브라우저 새로고침
- 심한 NAT → TURN 서버 필요

### 지연시간 높음
- 유선 이더넷 권장
- 다른 앱 종료
- 서울 리전 서버 확인

### 마이크 인식 안 됨
- 브라우저 권한 확인
- 올바른 장치 선택
- 다른 앱에서 사용 중인지 확인

## 아키텍처

```
사용자 A ◄──── WebRTC P2P ────► 사용자 B
    │                              │
    └──► 시그널링 서버 (서울) ◄────┘
         Socket.IO (방/채팅/메트로놈)
```

## 기술 스택

| 구성요소 | 기술 |
|---------|------|
| 서버 | Node.js + Express + Socket.IO |
| 클라이언트 | Vanilla JS + WebRTC + Web Audio |
| 인증 | bcrypt |
| 오디오 | WebRTC + Opus |

## 라이선스

HADES 전용 - 비공개 사용

---

🎸 즐거운 잼 세션 되세요!
