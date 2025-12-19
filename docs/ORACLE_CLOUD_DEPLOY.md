# ☁️ Oracle Cloud Free Tier 배포 가이드

Oracle Cloud는 **영구 무료** 인스턴스를 제공합니다. Styx 서버를 무료로 운영할 수 있습니다.

## 1. Oracle Cloud 계정 생성

1. https://www.oracle.com/cloud/free/ 접속
2. "Start for free" 클릭
3. 계정 생성 (신용카드 필요하지만 과금 안 됨)
4. 지역 선택: **Seoul (ap-seoul-1)** 권장

## 2. 인스턴스 생성

### Compute → Instances → Create Instance

**설정:**
- Name: `styx-server`
- Image: **Ubuntu 22.04** (Canonical Ubuntu)
- Shape: **VM.Standard.E2.1.Micro** (Always Free)
  - 또는 ARM: **VM.Standard.A1.Flex** (더 강력, 무료)
- Networking: Create new VCN
- SSH Key: 새로 생성하거나 기존 키 업로드

**Create 클릭**

## 3. 네트워크 설정 (포트 열기)

### Networking → Virtual Cloud Networks → [VCN 선택]

1. **Security Lists** → Default Security List
2. **Add Ingress Rules**:

| Source CIDR | Protocol | Port | 설명 |
|-------------|----------|------|------|
| 0.0.0.0/0 | TCP | 3000 | Styx 웹 |
| 0.0.0.0/0 | TCP | 80 | HTTP (선택) |
| 0.0.0.0/0 | TCP | 443 | HTTPS (선택) |

## 4. 서버 접속 및 설정

```bash
# SSH 접속
ssh -i your-key.pem ubuntu@[PUBLIC_IP]

# 시스템 업데이트
sudo apt update && sudo apt upgrade -y

# Node.js 설치
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 방화벽 설정 (Ubuntu 내부)
sudo iptables -I INPUT -p tcp --dport 3000 -j ACCEPT
sudo netfilter-persistent save

# Git 설치 및 저장소 클론
sudo apt install -y git
git clone https://github.com/haemoolpa-jeon/styx.git
cd styx

# 의존성 설치
npm install

# 환경 설정
cp .env.example .env
nano .env
```

**.env 파일 설정:**
```
PORT=3000
CORS_ORIGINS=http://[PUBLIC_IP]:3000,https://your-domain.com
```

## 5. PM2로 서버 실행

```bash
# PM2 설치
sudo npm install -g pm2

# 서버 시작
pm2 start npm --name "styx" -- start

# 자동 시작 설정
pm2 startup
pm2 save

# 로그 확인
pm2 logs styx
```

## 6. 접속 테스트

브라우저에서 접속:
```
http://[PUBLIC_IP]:3000
```

## 7. (선택) 도메인 + HTTPS 설정

### 무료 도메인 옵션
- **DuckDNS** (무료): https://www.duckdns.org
- **Freenom** (무료 .tk/.ml 등)
- 또는 기존 도메인 사용

### Nginx + Let's Encrypt

```bash
# Nginx 설치
sudo apt install -y nginx

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
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

```bash
# 설정 활성화
sudo ln -s /etc/nginx/sites-available/styx /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx

# HTTPS 설정 (Let's Encrypt)
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

## 8. 데스크톱 앱 설정

`styx-desktop/client/config.js` 수정:
```javascript
window.STYX_SERVER_URL = 'https://your-domain.com';
// 또는
window.STYX_SERVER_URL = 'http://[PUBLIC_IP]:3000';
```

## 비용 요약

| 항목 | 비용 |
|------|------|
| Oracle Cloud 인스턴스 | **$0 (영구 무료)** |
| 공인 IP | **$0 (포함)** |
| 도메인 (선택) | $0~12/년 |
| SSL 인증서 | **$0 (Let's Encrypt)** |

**총 비용: $0/월** (도메인 없이 IP로 사용 시)

## 문제 해결

### 접속 안 됨
1. Security List에서 포트 3000 열렸는지 확인
2. `sudo iptables -L`로 방화벽 확인
3. `pm2 status`로 서버 실행 중인지 확인

### 서버 재시작 후 안 됨
```bash
pm2 resurrect
```

### 로그 확인
```bash
pm2 logs styx --lines 100
```
