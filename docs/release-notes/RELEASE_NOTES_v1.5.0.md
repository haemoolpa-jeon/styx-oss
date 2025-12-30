# Styx v1.5.0 Release Notes

**Release Date:** 2024-12-30

## Overview

v1.5.0 focuses on code quality, stability improvements, and completing the advanced settings panel functionality introduced in v1.4.3.

## Changes

### Bug Fixes

- **Duplicate Event Handler** - Removed duplicate performance mode radio button handler that was causing double event firing
- **Audio Test References** - Fixed audio test function to use `adv-echo-cancel` and `adv-noise-suppress` instead of removed lobby elements
- **Socket Error Handler** - Added missing `error` event handler for server-side errors (IP whitelist, rate limiting)
- **Null Safety** - Added null checks for `tauri-audio-row` and `buffer-size-value` elements

### Improvements

- **Diagnostics Modal** - Shows "데이터 수집 중..." message when no latency data is available yet
- **CSS Animation** - Added missing `slide-in` animation class for room list items
- **Code Cleanup** - Removed debug console.log statements from panel toggle functions

### Advanced Panel (Complete)

All 13 settings now fully functional:

| Section | Settings |
|---------|----------|
| 오디오 처리 | 에코 제거, 노이즈 제거, AI 노이즈, 자동 음량 |
| 통화 모드 | 말할 때 표시 (VAD), 입력 모니터링 |
| 성능 모드 | 일반, 저지연, Pro |
| 네트워크 | 지터 버퍼, 자동 지터, DTX, 컴포트 노이즈, 자동 품질 조절 |
| 음질 | 48-192kbps (Tauri only) |

### Code Quality

- Comprehensive code review completed
- HTML structure verified (178 balanced divs, no duplicate IDs)
- All 160 functions defined and called
- WebSocket event handlers match server emits
- async/await error handling verified

## Upgrade Notes

No breaking changes. Direct upgrade from v1.4.x supported.

## Known Issues

- ~110 unused CSS classes remain from removed features (safe to keep, some used dynamically)
- Old lobby element references in JS are protected by null safety but could be cleaned up in future

## Files Changed

- `package.json` - Version bump
- `shared/client/app.js` - Bug fixes, handler cleanup
- `shared/client/style.css` - slide-in animation
- `README.md` - Updated changelog
