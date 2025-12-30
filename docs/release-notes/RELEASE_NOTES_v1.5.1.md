# Styx v1.5.1 Release Notes

**Release Date:** 2024-12-30

## Overview

v1.5.1 is a patch release with bug fixes, code quality improvements, and audio enhancements.

## Changes

### Bug Fixes
- **Peer card display** - Web browser now shows other users' cards (spectator mode)
- **peer.pc.close()** - Fixed null safety for fake PC objects in web mode
- **Input meter** - Now works in web browser (was Tauri-only)
- **Recording button** - Shows icon only, no text overflow
- **Diagnostics modal** - Fixed data collection for latency/jitter charts
- **Duplicate jitter control** - Removed from toolbar (kept in advanced panel)
- **Template dropdown** - Fixed dark/light mode styling
- **BPM spinner** - Fixed theme-aware styling

### Audio Improvements
- **Sync Mode** - Added device latency calibration using loopback test
- **PLC Enhancement** - Added fade-out for consecutive packet losses (Rust)
- **Latency measurement** - Now includes estimated device latency

### Code Quality
- Added debug logging to 22 empty catch blocks
- Extracted constants (SAMPLE_RATE, intervals)
- Multiple null safety improvements

## Upgrade Notes

Desktop app requires rebuild for PLC improvements:
```bash
cd styx-desktop/src-tauri
cargo tauri build
```

## Files Changed
- `package.json` - Version bump
- `shared/client/app.js` - Bug fixes, improvements
- `shared/client/style.css` - UI fixes
- `shared/client/index.html` - Cache version
- `styx-desktop/src-tauri/src/peer.rs` - PLC fade-out
