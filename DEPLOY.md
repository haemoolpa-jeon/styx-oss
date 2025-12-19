# Styx 배포 가이드

## 서버 정보

| 항목 | 값 |
|------|-----|
| IP | 3.39.223.2 |
| 사용자 | bitnami |
| SSH 키 | `C:\Users\HSJEON\styx\key\LightsailDefaultKey-ap-northeast-2.pem` |
| 웹 URL | https://3-39-223-2.nip.io |
| TURN | 3.39.223.2:3478 |

## 배포 명령어

### Windows PowerShell / CMD
```powershell
cd C:\Users\HSJEON\styx
git archive --format=tar HEAD | ssh -i "C:\Users\HSJEON\styx\key\LightsailDefaultKey-ap-northeast-2.pem" bitnami@3.39.223.2 "cd ~/styx && tar -xf - && pm2 restart styx"
```

### WSL (Windows SSH 사용)
```bash
cd /mnt/c/Users/HSJEON/styx
git archive --format=tar HEAD | /mnt/c/Windows/System32/OpenSSH/ssh.exe -i "C:\Users\HSJEON\styx\key\LightsailDefaultKey-ap-northeast-2.pem" bitnami@3.39.223.2 "cd ~/styx && tar -xf - && pm2 restart styx"
```

## 서버 직접 접속

### Windows
```powershell
ssh -i "C:\Users\HSJEON\styx\key\LightsailDefaultKey-ap-northeast-2.pem" bitnami@3.39.223.2
```

### WSL
```bash
/mnt/c/Windows/System32/OpenSSH/ssh.exe -i "C:\Users\HSJEON\styx\key\LightsailDefaultKey-ap-northeast-2.pem" bitnami@3.39.223.2
```

## 서버 관리 명령어

```bash
# 상태 확인
pm2 status

# 로그 보기
pm2 logs styx

# 재시작
pm2 restart styx

# 중지
pm2 stop styx
```

## 주의사항

1. **WSL에서 .pem 파일 권한 문제**
   - WSL의 Linux SSH는 Windows 파일시스템의 .pem 파일을 777로 인식
   - 해결: Windows SSH (`/mnt/c/Windows/System32/OpenSSH/ssh.exe`) 사용

2. **서버 사용자**
   - `ubuntu` 아님, `bitnami` 사용

3. **GitHub 인증**
   - 서버에서 HTTPS pull 불가 (인증 문제)
   - 해결: `git archive` + tar로 직접 파일 전송

## 파일 구조 (서버)

```
/home/bitnami/styx/
├── server/index.js
├── shared/client/
├── client/
├── .env
└── ...
```
