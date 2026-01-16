# Styx v1.4.3 Release Notes

**Release Date:** 2024-12-30

## Overview
UI 간소화 및 수동 제어 기능 추가. 사용자가 자동 최적화를 사용하거나 연결 모드를 직접 선택할 수 있습니다.

---

## 🎛️ New Features

### Advanced Settings Panel
Room toolbar에 ⚙️ 버튼으로 접근 가능한 고급 설정 패널 추가:

**연결 모드:**
- 자동 (권장) - 네트워크 상태와 참가자 수에 따라 자동 선택
- P2P 직접 연결 - 서버를 거치지 않고 직접 연결 (낮은 지연)
- SFU 서버 믹싱 - 서버에서 오디오 믹싱 (다수 참가자에 적합)

**오디오 처리:**
- 에코 제거 - 상대방 스피커 소리가 마이크로 들어가는 것을 방지
- 노이즈 제거 - 배경 소음 감소
- AI 노이즈 제거 - ML 기반 고급 노이즈 제거 (약간의 지연 추가)
- 자동 음량 - 마이크 입력 볼륨 자동 조절

**성능 모드:**
- 일반 - 균형 잡힌 품질과 지연
- 저지연 - 빠른 응답 (유선 연결 권장)
- Pro - 모든 오디오 처리 우회 (ASIO 권장)

**음질 (데스크톱 전용):**
- 48~192kbps 비트레이트 선택

---

## 🧹 UI Simplification

### Removed Features
다음 기능들은 거의 사용되지 않아 제거되었습니다:
- Spectrum analyzer (스펙트럼 분석기)
- Spatial audio (공간 오디오)
- Bandwidth monitoring (대역폭 모니터링)
- Audio routing matrix (오디오 라우팅)
- Noise profiling (노이즈 프로파일링)
- Manual SFU toggle (수동 SFU 토글) → 고급 패널로 이동

### Room Toolbar Cleanup
- 중복 옵션 제거: 에코 제거, 노이즈 제거, AI 노이즈, VAD, 자동 품질, 덕킹
- 이 옵션들은 고급 설정 패널로 이동

### Room Creation Cleanup
- Sample rate 옵션 제거 (항상 48kHz 사용)

### Code Cleanup
- ~1,200줄의 사용하지 않는 코드 제거
- 제거된 기능에 대한 변수, 함수, 이벤트 리스너 정리

---

## 🔧 Improvements

### Tooltips
모든 설정에 hover 시 표시되는 설명 추가:
- 기능 설명
- 부작용 안내 (예: "지연 추가", "대역폭 증가")
- 권장 사용 시나리오

### Performance Mode Integration
- 기존 Low-latency와 Pro 체크박스를 radio cards로 통합
- Lobby와 Room 모두에서 동일한 UI 제공

### Cache Busting
- CSS/JS 파일에 버전 쿼리 파라미터 추가 (`?v=1.4.4`)
- 브라우저 캐시로 인한 업데이트 문제 해결

---

## 📊 Technical Details

### Files Modified
- `shared/client/index.html` - 고급 설정 패널 추가, toolbar 간소화
- `shared/client/app.js` - 새 핸들러 추가, 미사용 코드 제거
- `shared/client/style.css` - 고급 패널 스타일 추가

### Breaking Changes
없음. 기존 설정은 그대로 유지됩니다.

---

## 🔜 Next Steps
- VST 플러그인 호스팅 (계획 중)
- Opus DRED (Deep Redundancy) 지원 (opus crate 1.5 대기)
