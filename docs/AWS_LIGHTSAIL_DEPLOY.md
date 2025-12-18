# AWS Lightsail 배포 가이드

## 1. Lightsail 인스턴스 생성

### AWS Console에서:
1. [AWS Lightsail Console](https://lightsail.aws.amazon.com/) 접속
2. "Create instance" 클릭
3. 설정:
   - Region: `ap-northeast-2` (Seoul)
   - Platform: `Linux/Unix`
   - Blueprint: `Node.js` (또는 OS Only → Ubuntu 22.04)
   - Instance plan: `$5/month` (1GB RAM) 이상 권장
   - Instance name: `styx-server`
4. "Create instance" 클릭

### 네트워킹 설정:
1. 인스턴스 클릭 → "Networking" 탭
2. "Add rule" 클릭:
   - Application: `Custom`
   - Protocol: `TCP`
   - Port: `3000`
3. Save

## 2. 서버 설정

### SSH 접속:
```bash
# Lightsail 콘솔에서 "Connect using SSH" 클릭
# 또는 다운로드한 키로 접속:
ssh -i your-key.pem ubuntu@YOUR_LIGHTSAIL_IP
```

### Node.js 설치 (OS Only 선택 시):
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v  # v20.x 확인
```

### 프로젝트 클론:
```bash
cd ~
git clone https://github.com/haemoolpa-jeon/styx.git
cd styx
npm install
```

### 환경변수 설정:
```bash
# .env 파일 생성
nano .env
```

`.env` 내용:
```
PORT=3000
CORS_ORIGINS=http://YOUR_LIGHTSAIL_IP:3000,tauri://localhost,https://tauri.localhost
```

### 초기 관리자 설정:
```bash
npm run setup
# 관리자 계정 생성
```

## 3. PM2로 서버 실행

```bash
# PM2 설치
sudo npm install -g pm2

# 서버 시작
pm2 start npm --name "styx" -- start

# 부팅 시 자동 시작
pm2 startup
pm2 save

# 로그 확인
pm2 logs styx
```

## 4. 방화벽 설정 (선택)

```bash
sudo ufw allow 22
sudo ufw allow 3000
sudo ufw enable
```

## 5. 접속 테스트

브라우저에서:
```
http://YOUR_LIGHTSAIL_IP:3000
```

## 6. Tauri 데스크톱 앱 연결

### config.js 수정:
`styx-desktop/client/config.js`:
```javascript
window.STYX_SERVER_URL = 'http://YOUR_LIGHTSAIL_IP:3000';
```

### 앱 재빌드:
```bash
cd styx-desktop
# Windows에서:
build-windows.bat
```

## 7. HTTPS 설정 (선택, 권장)

### Caddy 사용 (자동 SSL):
```bash
# Caddy 설치
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy

# Caddyfile 설정
sudo nano /etc/caddy/Caddyfile
```

Caddyfile 내용 (도메인이 있는 경우):
```
your-domain.com {
    reverse_proxy localhost:3000
}
```

```bash
sudo systemctl restart caddy
```

### .env 업데이트 (HTTPS 사용 시):
```
CORS_ORIGINS=https://your-domain.com,tauri://localhost,https://tauri.localhost
```

## 8. 유지보수

### 업데이트:
```bash
cd ~/styx
git pull
npm install
pm2 restart styx
```

### 로그 확인:
```bash
pm2 logs styx --lines 100
```

### 서버 상태:
```bash
pm2 status
```

## 비용

- Lightsail $5/month 플랜: 1GB RAM, 40GB SSD, 2TB 전송
- 8명 동시 사용에 충분

## 문제 해결

### 연결 안 됨:
1. Lightsail 네트워킹에서 포트 3000 열렸는지 확인
2. `pm2 status`로 서버 실행 중인지 확인
3. `pm2 logs styx`로 에러 확인

### Tauri 앱 연결 안 됨:
1. config.js의 서버 URL 확인
2. CORS_ORIGINS에 `tauri://localhost` 포함 확인
3. 앱 재빌드 필요

### WebSocket 연결 끊김:
- Lightsail 인스턴스 재시작 후 IP 변경 확인
- 고정 IP 할당 권장 (Lightsail → Networking → Create static IP)
