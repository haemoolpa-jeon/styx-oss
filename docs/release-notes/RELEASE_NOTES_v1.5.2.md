# Styx v1.5.2 Release Notes

**Release Date:** December 30, 2024

## Overview
Code modularization and quality improvements. This release focuses on better code organization, improved maintainability, and theme consistency fixes.

## Code Modularization

Extracted 9 modules from app.js for better maintainability:

| Module | Lines | Description |
|--------|-------|-------------|
| utils.js | 55 | Quality grade, error messages, formatTime |
| toast.js | 23 | Toast notifications |
| accessibility.js | 144 | Accessibility settings, screen reader support |
| recording.js | 208 | Multitrack, loopback, mixdown recording |
| sync.js | 144 | Sync mode, device latency calibration |
| sound.js | 37 | Join/leave notification sounds |
| theme.js | 35 | Dark/light theme management |
| tuner.js | 78 | Instrument tuner with pitch detection |
| keyboard.js | 301 | Keyboard shortcuts system |

**Result:** app.js reduced from 6,361 to 5,497 lines (-864 lines, -13.6%)

## Bug Fixes

- **Socket Handler Duplication**: Fixed duplicate `peer-latency` handler registration on socket reconnect
- **Module Variable References**: Fixed undefined variable references after modularization (tunerCtx, tunerInterval, multitrackMode, loopbackMode)
- **Memory Leaks**: Added proper cleanup for module AudioContexts (cleanupTuner, cleanupSound)
- **Keyboard Shortcuts**: Auto-initialize on DOMContentLoaded, added default action handlers
- **Global Variable Access**: Use Object.defineProperties for dynamic access to app.js variables from modules

## Theme Improvements

- Added background/color to base form elements (input, select, textarea)
- Fixed tuner in-tune colors to use CSS variables
- Fixed whitelist/user management button colors for theme consistency
- Fixed notification badge color
- Added light mode specific backgrounds for pending/approved users

## Technical Details

### Module Architecture
- Modules export via `window.StyxModuleName` pattern
- app.js imports using destructuring with fallback: `const { fn } = window.StyxModule || {}`
- Global variables exposed via getters for dynamic access
- Cleanup functions called in `leaveRoom()` to prevent memory leaks

### Files Modified
- `/shared/client/app.js` - Main application (modularized)
- `/shared/client/*.js` - 9 new module files
- `/shared/client/index.html` - Script load order
- `/shared/client/style.css` - Theme consistency fixes

## Upgrade Notes

- No breaking changes
- Desktop app rebuild required for version update
- Server automatically serves new client files

## Known Issues

- None

---
*Full changelog available in git history*
