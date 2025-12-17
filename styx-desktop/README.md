# Styx Desktop

Tauri 기반 Styx 데스크톱 앱

## 요구사항

- [Rust](https://rustup.rs) (1.70+)
- [Node.js](https://nodejs.org) (18+)
- Windows: WebView2 (자동 설치됨)

## 개발 모드

```bash
# 서버 먼저 실행 (styx 폴더에서)
cd ../
npm start

# 다른 터미널에서 Tauri 개발 모드
cd styx-desktop
cargo tauri dev
```

## 빌드

### Windows
```batch
build-windows.bat
```

또는:
```bash
cargo tauri build
```

빌드 결과: `src-tauri/target/release/bundle/`

## 서버 URL 설정

앱 실행 후 브라우저 콘솔에서:
```javascript
localStorage.setItem('styx-server-url', 'http://your-server:3000');
location.reload();
```

## 구조

```
styx-desktop/
├── client/          # 웹 UI (Styx 클라이언트)
├── src-tauri/       # Rust 백엔드
│   ├── src/         # Rust 소스
│   ├── icons/       # 앱 아이콘
│   └── tauri.conf.json
└── build-windows.bat
```
