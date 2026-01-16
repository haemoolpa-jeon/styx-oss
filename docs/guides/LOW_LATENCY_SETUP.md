# Styx 저지연 오디오 설정 가이드

## 목표: 6명 서울 지역, 40ms 이하 지연

---

## 1. 필수 장비

### 각 참가자 준비물
- [ ] ASIO 오디오 인터페이스 (권장: Focusrite Scarlett Solo ~10만원, Behringer UMC22 ~5만원)
- [ ] 유선 이더넷 연결 (WiFi 사용 금지)
- [ ] 헤드폰 (에코 방지)
- [ ] Styx 데스크톱 앱 설치

---

## 2. Windows 방화벽 설정

### 자동 설정 (PowerShell 관리자 권한)
```powershell
# 관리자 권한으로 PowerShell 실행 후:
netsh advfirewall firewall add rule name="Styx UDP In" dir=in action=allow protocol=UDP localport=10000-65535
netsh advfirewall firewall add rule name="Styx UDP Out" dir=out action=allow protocol=UDP localport=10000-65535
Write-Host "✅ 방화벽 규칙 추가 완료"
```

### 수동 설정
1. Windows 보안 → 방화벽 및 네트워크 보호
2. "방화벽에서 앱 허용" 클릭
3. "설정 변경" → "다른 앱 허용"
4. Styx 앱 경로 선택: `C:\Users\[사용자]\AppData\Local\styx-desktop\styx-desktop.exe`
5. "개인" 및 "공용" 네트워크 모두 체크

---

## 3. 네트워크 확인

### CGNAT 확인 (중요!)
한국 ISP(KT, SKT, LG U+)는 CGNAT를 사용할 수 있습니다.

```powershell
# 1. 라우터 WAN IP 확인
ipconfig | findstr "Default Gateway"
# 브라우저에서 게이트웨이 IP로 접속하여 WAN IP 확인

# 2. 공인 IP 확인
Invoke-RestMethod -Uri "https://api.ipify.org"
```

**결과 비교:**
- WAN IP = 공인 IP → ✅ 정상 (P2P UDP 가능)
- WAN IP ≠ 공인 IP → ⚠️ CGNAT (ISP에 공인 IP 요청 필요)
- WAN IP가 100.64.x.x 또는 10.x.x.x → ⚠️ CGNAT

### CGNAT 해결 방법
1. ISP 고객센터에 "공인 IP 할당" 요청 (보통 무료)
2. 또는 WebRTC 모드 사용 (UDP보다 20ms 정도 느림)

---

## 4. Styx 앱 설정

### 저지연 모드 활성화
1. Styx 데스크톱 앱 실행
2. 로비에서 "⚡ 저지연 모드" 체크
3. ASIO 감지 시 자동으로 UDP 모드 선택됨
4. 수동 선택: "⚡ UDP (저지연)" 버튼 클릭

### ASIO 드라이버 설정
1. 오디오 인터페이스 드라이버 설치 (제조사 웹사이트)
2. ASIO 컨트롤 패널에서 버퍼 크기 설정:
   - 권장: 64 또는 128 samples
   - 최소: 32 samples (불안정할 수 있음)
   - 안전: 256 samples

---

## 5. 연결 테스트

### 네트워크 테스트
1. 로비에서 "📡 네트워크" 버튼 클릭
2. 결과 확인:
   - 지연: < 10ms (서울 내)
   - 지터: < 5ms
   - 패킷 손실: < 1%

### 오디오 테스트
1. "🎤 마이크" 버튼 클릭
2. 레벨 미터 확인
3. ASIO 사용 시 "ASIO 드라이버 감지됨" 메시지 확인

---

## 6. 문제 해결

### UDP 연결 안 됨
```
증상: 방에 입장했지만 소리가 안 들림
```

**해결 순서:**
1. 방화벽 확인 (위 스크립트 실행)
2. CGNAT 확인 (위 방법)
3. 라우터 재시작
4. WebRTC 모드로 전환 (fallback)

### ASIO 장치 안 보임
```
증상: 오디오 드라이버 목록에 ASIO 없음
```

**해결:**
1. 오디오 인터페이스 드라이버 재설치
2. 장치 관리자에서 드라이버 업데이트
3. USB 포트 변경 (USB 3.0 권장)

### 오디오 끊김/글리치
```
증상: 소리가 뚝뚝 끊기거나 노이즈 발생
```

**해결:**
1. ASIO 버퍼 크기 증가 (64 → 128 → 256)
2. 저지연 모드 해제 (버퍼 50ms로 증가)
3. WiFi → 유선 이더넷 변경
4. 다른 USB 장치 분리

### 지연이 40ms 이상
```
증상: 연주 싱크가 안 맞음
```

**체크리스트:**
- [ ] 저지연 모드 ON?
- [ ] UDP 모드 선택됨?
- [ ] ASIO 드라이버 사용 중?
- [ ] 유선 이더넷 연결?
- [ ] CGNAT 아님?

---

## 7. 예상 지연 시간

| 설정 | 예상 지연 |
|------|----------|
| 웹 브라우저 | 100-150ms |
| Tauri + WebRTC | 60-80ms |
| Tauri + UDP | 45-55ms |
| **Tauri + UDP + ASIO + 저지연** | **32-40ms** ✅ |

---

## 8. 빠른 시작 체크리스트

```
□ 1. ASIO 오디오 인터페이스 연결
□ 2. 유선 이더넷 연결
□ 3. 방화벽 스크립트 실행
□ 4. Styx 앱 실행
□ 5. 저지연 모드 체크
□ 6. UDP 모드 확인
□ 7. 네트워크 테스트 통과
□ 8. 방 입장 및 테스트
```

---

## 문의

문제가 지속되면:
1. 앱 내 "📡 네트워크" 테스트 결과 스크린샷
2. Windows 이벤트 뷰어 오류 로그
3. 사용 중인 오디오 인터페이스 모델명

위 정보와 함께 문의해주세요.
