# 🎵 Styx

HADES를 위한 실시간 오디오 협업 플랫폼

## 기능

- **실시간 P2P 오디오** - WebRTC 기반 저지연 오디오 스트리밍
- **최대 8명** - 방당 최대 8명 동시 접속
- **사용자 인증** - 회원가입/로그인, 관리자 승인 시스템
- **아바타** - 프로필 이미지 업로드
- **볼륨 조절** - 사용자별 개별 볼륨 슬라이더
- **지연시간 표시** - 각 사용자와의 RTT 실시간 표시
- **채팅** - 방 내 텍스트 채팅
- **오디오 장치 선택** - 마이크/오디오 인터페이스 선택
- **방 브라우저** - 활성 방 목록 및 클릭 입장

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

⚠️ 첫 로그인 후 비밀번호를 변경하세요!

## 파일 구조

```
styx/
├── server/
│   ├── index.js      # 시그널링 서버 (인증, 방, 채팅, WebRTC)
│   └── users.json    # 사용자 데이터베이스
├── avatars/          # 업로드된 아바타 이미지
├── client/
│   ├── index.html    # 웹 UI
│   ├── app.js        # 클라이언트 로직
│   └── style.css     # 스타일
├── package.json
├── setup.js          # 초기 설정 스크립트
└── README.md
```

## AWS 서울 배포 가이드

### 1. EC2 인스턴스 생성

- 리전: **ap-northeast-2 (서울)**
- AMI: Amazon Linux 2023
- 인스턴스 유형: t3.micro (프리 티어)
- 보안 그룹:
  - SSH (22) - 내 IP
  - HTTP (80) - 모든 곳
  - Custom TCP (3000) - 모든 곳

### 2. 서버 설정

```bash
# SSH 접속
ssh -i your-key.pem ec2-user@<퍼블릭-IP>

# Node.js 설치
sudo dnf install -y nodejs

# 코드 업로드 (scp 또는 git)
mkdir styx && cd styx
# (파일 업로드)

# 의존성 설치 및 설정
npm install
npm run setup

# PM2로 프로덕션 실행
sudo npm install -g pm2
pm2 start server/index.js --name styx
pm2 startup
pm2 save
```

### 3. Nginx 리버스 프록시 (선택)

```bash
sudo dnf install -y nginx

# /etc/nginx/conf.d/styx.conf 생성
server {
    listen 80;
    server_name your-domain.com;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}

sudo systemctl enable nginx
sudo systemctl start nginx
```

### 4. HTTPS 설정 (권장)

```bash
sudo dnf install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

## 사용 방법

### 회원가입
1. 회원가입 탭 클릭
2. 사용자명과 비밀번호 입력
3. "가입 요청" 클릭
4. 관리자 승인 대기

### 관리자 승인
1. admin 계정으로 로그인
2. ⚙️ 버튼 클릭
3. 대기 중인 사용자 승인/거절

### 방 입장
1. 로그인 후 로비에서 오디오 장치 선택
2. 활성 방 클릭 또는 새 방 이름 입력
3. "입장" 클릭
4. 마이크 권한 허용

### 오디오 설정

악기 연주를 위해 다음 설정이 자동 적용됩니다:
- 에코 제거: OFF
- 노이즈 억제: OFF
- 자동 게인: OFF

이 설정은 악기 소리의 왜곡을 방지합니다.

## 문제 해결

### 다른 사용자와 연결 안 됨
- 양쪽 모두 방화벽 확인
- 브라우저 새로고침 후 재시도
- 심한 NAT 환경에서는 TURN 서버 필요 (미포함)

### 지연시간이 높음
- 유선 이더넷 사용 권장 (WiFi 대신)
- 다른 대역폭 사용 앱 종료
- 서울 리전 서버 사용 확인

### 마이크가 인식 안 됨
- 브라우저 마이크 권한 확인
- 오디오 장치 드롭다운에서 올바른 장치 선택
- 다른 앱에서 마이크 사용 중인지 확인

## 아키텍처

```
사용자 A ◄──── WebRTC P2P 오디오 ────► 사용자 B
    │                                    │
    └──► 시그널링 서버 (서울) ◄──────────┘
         (Socket.IO - 방 관리만)
```

- 오디오는 서버를 거치지 않고 사용자 간 직접 전송 (P2P)
- 서버는 방 관리, 인증, 채팅만 처리
- Full Mesh 토폴로지: 8명 = 28개 P2P 연결

## 기술 스택

| 구성요소 | 기술 |
|---------|------|
| 서버 | Node.js + Express + Socket.IO |
| 클라이언트 | Vanilla HTML/JS + WebRTC API |
| 인증 | bcrypt 해시 |
| 오디오 | WebRTC + Opus 코덱 |

## 라이선스

HADES 전용 - 비공개 사용

---

🎸 즐거운 잼 세션 되세요!
