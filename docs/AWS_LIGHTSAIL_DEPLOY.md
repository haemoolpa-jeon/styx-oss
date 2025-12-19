# AWS Lightsail 배포 가이드

## 1. Lightsail 인스턴스 생성

1. [AWS Lightsail Console](https://lightsail.aws.amazon.com/) 접속
2. "Create instance" 클릭
3. 설정:
   - Region: `ap-northeast-2` (Seoul)
   - Platform: `Linux/Unix`
   - Blueprint: `Node.js` 또는 `Debian`
   - Instance plan: `$5/month` (1GB RAM) 이상
4. "Create instance" 클릭

## 2. 네트워킹 설정

인스턴스 → Networking 탭에서 방화벽 규칙 추가:

| Protocol | Port | 용도 |
|----------|------|------|
| TCP | 3000 | Styx 웹 서버 |
| TCP | 3478 | TURN (TCP) |
| UDP | 3478 | TURN (UDP) |
| UDP | 49152-65535 | TURN 미디어 릴레이 |

## 3. 서버 설정

```bash
# SSH 접속
ssh -i your-key.pem bitnami@YOUR_IP
# 또는 Lightsail 콘솔에서 "Connect using SSH"

# 프로젝트 클론
cd ~
git clone https://github.com/haemoolpa-jeon/styx.git
cd styx
npm install

# 환경변수 설정
cp .env.example .env
nano .env
```

`.env` 내용:
```
PORT=3000
CORS_ORIGINS=https://YOUR_IP.nip.io,tauri://localhost
TURN_SERVER=YOUR_IP
TURN_SECRET=your-secret-here
```

## 4. Coturn TURN 서버 설치

```bash
# Coturn 설치
sudo apt-get update
sudo apt-get install -y coturn

# 시크릿 생성
TURN_SECRET=$(openssl rand -hex 16)
echo "TURN_SECRET=$TURN_SECRET"

# 설정 파일 생성
sudo tee /etc/turnserver.conf > /dev/null << EOF
listening-ip=0.0.0.0
listening-port=3478
external-ip=YOUR_IP
min-port=49152
max-port=65535
realm=styx.turn
use-auth-secret
static-auth-secret=$TURN_SECRET
no-multicast-peers
no-cli
fingerprint
lt-cred-mech
EOF

# 서비스 활성화 및 시작
sudo sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
sudo systemctl restart coturn
sudo systemctl enable coturn
```

## 5. PM2로 서버 실행

```bash
# PM2 설치
sudo npm install -g pm2

# 서버 시작
pm2 start npm --name "styx" -- start

# 부팅 시 자동 시작
pm2 startup
pm2 save
```

## 6. 접속 테스트

브라우저에서: `http://YOUR_IP:3000`

## 7. HTTPS 설정 (선택)

### nip.io 사용 (간단)
`https://YOUR-IP.nip.io` 형식으로 접속 (Caddy 필요)

### Caddy 설치
```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy

# Caddyfile 설정
sudo tee /etc/caddy/Caddyfile > /dev/null << EOF
YOUR-IP.nip.io {
    reverse_proxy localhost:3000
}
EOF

sudo systemctl restart caddy
```

## 8. 유지보수

```bash
# 업데이트
cd ~/styx
git pull
npm install
pm2 restart styx

# 로그 확인
pm2 logs styx --lines 100

# 서버 상태
pm2 status
```

## 비용

- Lightsail $5/month: 1GB RAM, 40GB SSD, 2TB 전송
- 8명 동시 사용에 충분

## 문제 해결

### 연결 안 됨
1. Lightsail 방화벽에서 포트 열렸는지 확인
2. `pm2 status`로 서버 실행 중인지 확인
3. `pm2 logs styx`로 에러 확인

### TURN 연결 안 됨
1. UDP 3478, 49152-65535 포트 열렸는지 확인
2. `sudo systemctl status coturn`으로 서비스 확인
3. `.env`의 TURN_SECRET이 coturn 설정과 일치하는지 확인
