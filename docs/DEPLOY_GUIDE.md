# 🚀 Styx 배포 가이드

이 문서는 Styx 서버와 데스크톱 앱을 배포하는 방법을 설명합니다.

---

## 📦 서버 배포

### 요구사항
- Node.js 18+
- npm 또는 yarn

### 로컬 실행
```bash
# 저장소 클론
git clone https://github.com/haemoolpa-jeon/styx.git
cd styx

# 의존성 설치
npm install

# 서버 실행
npm start
```

서버가 `http://localhost:3000`에서 실행됩니다.

### 클라우드 배포 (예: AWS EC2)

#### 1. EC2 인스턴스 생성
- Ubuntu 22.04 LTS
- t3.micro (테스트용) 또는 t3.small (운영용)
- 보안 그룹: 포트 3000 (또는 80/443) 열기

#### 2. 서버 설정
```bash
# Node.js 설치
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 저장소 클론
git clone https://github.com/haemoolpa-jeon/styx.git
cd styx
npm install

# PM2로 백그라운드 실행
sudo npm install -g pm2
pm2 start server/index.js --name styx
pm2 save
pm2 startup
```

#### 3. 도메인 연결 (선택)
```bash
# Nginx 설치
sudo apt install nginx

# 설정 파일 생성
sudo nano /etc/nginx/sites-available/styx
```

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/styx /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

#### 4. HTTPS 설정 (권장)
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

## 🖥️ 데스크톱 앱 빌드

### 요구사항 (Windows)
- Windows 10/11
- [Rust](https://rustup.rs) 설치
- [CMake](https://cmake.org/download/) 설치
- Visual Studio Build Tools

### 빌드 방법

#### 방법 1: 스크립트 사용
```batch
cd styx-desktop
build-windows.bat
```

#### 방법 2: 수동 빌드
```batch
cd styx-desktop
cargo tauri build --release
```

### 빌드 결과물
```
styx-desktop/src-tauri/target/release/
├── styx-desktop.exe          # 포터블 실행 파일
└── bundle/
    ├── msi/                   # MSI 설치 파일
    │   └── styx-desktop_x.x.x_x64_en-US.msi
    └── nsis/                  # NSIS 설치 파일
        └── styx-desktop_x.x.x_x64-setup.exe
```

---

## 📤 배포 방법

### GitHub Releases 사용

1. GitHub 저장소 → Releases → "Create a new release"
2. 태그 생성: `v1.0.0`
3. 빌드된 파일 업로드:
   - `styx-desktop_x.x.x_x64-setup.exe` (NSIS 설치 파일)
   - `styx-desktop_x.x.x_x64_en-US.msi` (MSI 설치 파일)
4. 릴리즈 노트 작성
5. "Publish release"

### 직접 공유

빌드된 `.exe` 또는 `.msi` 파일을 직접 공유:
- Google Drive
- Discord 파일 업로드
- 카카오톡

---

## 🔧 서버 설정

### 환경 변수
```bash
# .env 파일 (선택)
PORT=3000
```

### 사용자 관리
```
server/users.json
```
- 새 사용자 승인: `approved: true`
- 관리자 지정: `isAdmin: true`

### 첫 관리자 계정 생성
1. 웹에서 회원가입
2. `server/users.json` 직접 편집:
```json
{
  "users": {
    "admin_username": {
      "password": "...(해시)",
      "approved": true,
      "isAdmin": true
    }
  }
}
```

---

## 🧪 테스터 초대 방법

### 1. 서버 접속 정보 공유
```
서버 주소: http://your-server-ip:3000
또는: https://your-domain.com
```

### 2. 계정 생성 안내
1. 위 주소로 접속
2. "회원가입" 클릭
3. 사용자명/비밀번호 입력
4. 관리자 승인 대기

### 3. 계정 승인 (관리자)
1. 관리자 계정으로 로그인
2. 설정 → 사용자 관리
3. 대기 중인 사용자 승인

### 4. 데스크톱 앱 배포 (선택)
- GitHub Releases 링크 공유
- 또는 설치 파일 직접 전달

---

## 📊 모니터링

### 서버 로그 확인
```bash
# PM2 사용 시
pm2 logs styx

# 직접 실행 시
npm start 2>&1 | tee server.log
```

### 접속자 확인
서버 콘솔에 연결/입장/퇴장 로그가 표시됩니다:
```
연결됨: socket_id
username 입장: room_name (2/8)
username 퇴장: room_name
```

---

## ❓ 문제 해결

### 서버가 시작되지 않음
```bash
# 포트 사용 중인지 확인
netstat -tlnp | grep 3000

# 다른 포트로 실행
PORT=3001 npm start
```

### 데스크톱 앱 빌드 실패
- CMake 설치 확인: `cmake --version`
- Rust 설치 확인: `rustc --version`
- Visual Studio Build Tools 설치 확인

### WebRTC 연결 실패
- 방화벽에서 UDP 포트 허용
- TURN 서버가 설정되어 있는지 확인 (기본 포함됨)

---

## 📞 지원

문제가 있으면 연락주세요!
- GitHub Issues
- Discord/카톡
