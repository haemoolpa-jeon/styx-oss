# Styx Desktop

Tauri 기반 Styx 데스크톱 앱 - ASIO 지원 저지연 오디오

## 기능

- **ASIO 지원**: 전문 오디오 인터페이스 사용 가능
- **Custom UDP**: 저지연 오디오 전송 프로토콜
- **시스템 트레이**: 백그라운드 실행
- **글로벌 단축키**: Ctrl+Shift+M (음소거)

## 요구사항

### Windows
- [Rust](https://rustup.rs) (1.77+)
- [Node.js](https://nodejs.org) (18+)
- WebView2 (자동 설치됨)
- ASIO SDK (선택사항, ASIO 사용 시)

### Linux
- Rust, Node.js
- ALSA 개발 라이브러리: `sudo apt install libasound2-dev`
- WebKit2GTK: `sudo apt install libwebkit2gtk-4.1-dev`

## Windows 빌드

### 1. Rust 설치
https://rustup.rs 에서 rustup 설치

### 2. Tauri CLI 설치
```powershell
cargo install tauri-cli
```

### 3. 빌드
```powershell
cd styx-desktop
cargo tauri build
```

또는 배치 파일 실행:
```batch
build-windows.bat
```

### 4. 결과물
`src-tauri/target/release/bundle/` 폴더에 설치 파일 생성:
- `msi/` - MSI 설치 파일
- `nsis/` - NSIS 설치 파일

## 개발 모드

```bash
# 1. Styx 서버 실행 (styx 폴더에서)
cd ../
npm start

# 2. Tauri 개발 모드 (다른 터미널)
cd styx-desktop
cargo tauri dev
```

## Tauri IPC 커맨드

### 오디오
```javascript
const { invoke } = window.__TAURI__.core;

// 오디오 장치 목록
const devices = await invoke('get_audio_devices');

// ASIO 사용 가능 여부
const asioAvailable = await invoke('check_asio');

// 오디오 테스트
const result = await invoke('test_audio');

// 지원 샘플레이트
const rates = await invoke('get_sample_rates', { deviceName: null, isInput: true });
```

### UDP
```javascript
// UDP 소켓 바인딩
const port = await invoke('udp_bind', { port: 0 }); // 0 = 자동 할당

// 패킷 헤더 크기
const headerSize = await invoke('get_packet_header_size');
```

## 프로젝트 구조

```
styx-desktop/
├── client/              # 웹 UI
│   ├── index.html
│   ├── app.js
│   └── style.css
├── src-tauri/           # Rust 백엔드
│   ├── src/
│   │   ├── main.rs      # 진입점
│   │   ├── lib.rs       # Tauri 설정 및 커맨드
│   │   ├── audio.rs     # 오디오 처리 (cpal/ASIO)
│   │   └── udp.rs       # UDP 네트워킹
│   ├── Cargo.toml
│   └── tauri.conf.json
├── build-windows.bat
└── README.md
```

## ASIO 설정 (Windows)

ASIO를 사용하려면:

1. ASIO SDK 다운로드 (Steinberg)
2. 환경 변수 설정: `CPAL_ASIO_DIR=C:\path\to\asio-sdk`
3. 빌드 시 ASIO 기능 활성화됨

## 서버 URL 설정

앱 실행 후 개발자 도구 콘솔에서:
```javascript
localStorage.setItem('styx-server-url', 'http://your-server:3000');
location.reload();
```

## 라이선스

MIT
