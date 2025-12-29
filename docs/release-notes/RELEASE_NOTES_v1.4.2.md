# Styx v1.4.2 릴리즈 노트

**릴리즈 날짜**: 2024-12-29

## 개요

v1.4.2는 안정성과 코드 품질에 중점을 둔 유지보수 릴리즈입니다. 버튼 클릭 문제, AudioContext 오류, 메모리 누수 등 다양한 버그를 수정하고 전반적인 코드 품질을 개선했습니다.

## 🐛 버그 수정

### UI/UX
- **버튼 클릭 문제 해결**: CSS `::before` pseudo-element의 `position: absolute; inset: 0` 설정이 부모 요소의 `position: relative` 없이 사용되어 클릭을 가로채던 문제 수정
- **버튼 흔들림 수정**: hover 시 `translateY` 효과로 인한 버튼 흔들림 제거
- **모달 z-index 수정**: 모달 배경과 내용의 z-index 정리

### 오디오
- **AudioContext 오류 수정**: "Cannot close a closed AudioContext" 오류 해결 - `state !== 'closed'` 체크 추가
- **오디오 스트림 재시작 수정**: 장치 변경 시 적절한 정리 및 100ms 딜레이 추가
- **테스트 오디오 정리**: 테스트 버튼 사용 후 AudioContext 정리

### 방 관리
- **SFU 모드 정리**: 방 퇴장 시 `sfuMode = false` 초기화 추가
- **화면 공유 정리**: 방 퇴장 시 `stopScreenShare()` 호출 추가
- **방 설정 초기화**: `isRoomCreator`, `currentRoomSettings`, `roomCreatorUsername` 초기화 추가

### 네트워크
- **TCP 핸들러 누수 수정**: `tcpHandlerRegistered` 플래그로 중복 등록 방지
- **UDP 헬스 카운터 초기화**: `udpHealthFailCount` 초기화 추가

## 🛡️ 안정성 개선

### Race Condition 방지
- `joiningRoom` - 동시 방 입장 방지
- `restartingAudio` - 동시 오디오 스트림 재시작 방지
- `reconnectingDevices` - 동시 장치 재연결 방지
- `startingUdp` - 동시 UDP 모드 시작 방지

### 메모리 누수 방지
- `qualityHistory.clear()` - 방 퇴장 시 품질 히스토리 정리
- `syncDelayBuffers.clear()` - 방 퇴장 시 동기화 버퍼 정리
- 모든 Map/Set 정리 로직 검증 완료

### 에러 핸들링
- Pro 모드 전환 시 try-catch 추가
- 화면 공유 관련 이벤트 핸들러에 try-catch 추가
- DOM 요소 접근 시 optional chaining 추가

## 📊 코드 품질

### 검증 완료 항목
- 모든 async 함수 try-catch 확인
- 모든 배열 바운드 체크 (5~1000개 제한)
- 모든 Map 정리 로직 확인
- 재연결 로직 검증 (Socket.io 10회 재시도, ICE 5회 재시도)

### 서버 측
- 세션 만료 정리 (주기적 실행)
- Rate limit 정리 (60초 후 만료)
- UDP 클라이언트 정리 (30초 타임아웃)
- SFU 정리 (방 삭제 시, 사용자 퇴장 시)

## ⚠️ 알려진 이슈

### Windows 보안 경고
데스크톱 앱이 코드 서명되지 않아 Windows SmartScreen 또는 백신에서 경고가 표시될 수 있습니다.

**해결 방법:**
1. SmartScreen: "추가 정보" → "실행" 클릭
2. Windows Defender: 제외 목록에 추가
3. 기타 백신: 예외 목록에 추가

## 업그레이드 방법

1. 서버 업데이트:
```bash
cd styx/server
git pull
npm install
pm2 restart styx
```

2. 데스크톱 앱: GitHub Releases에서 최신 버전 다운로드

## 다음 버전 계획

- 코드 서명 인증서 도입 검토
- 추가 성능 최적화
- 사용자 피드백 기반 UI 개선
