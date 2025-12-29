# Styx Client Module Architecture

## Overview
The client uses a hybrid architecture: ES modules for utilities + legacy app.js for core logic.

## Module Structure

```
shared/client/
├── app.js              # Main application (220KB, legacy)
├── styx-modules.js     # Bundled ES modules (20KB, Vite output)
├── modules/            # ES module source files
│   ├── core.js         # State, utilities (escapeHtml, formatTime, downloadBlob)
│   ├── ui.js           # Toast, theme, reconnect progress, mute UI
│   ├── audio.js        # AudioContext, effects, spectrum, presets
│   ├── settings.js     # localStorage management, presets, templates
│   ├── recording.js    # Recording, multitrack, WAV export
│   ├── network.js      # Quality grade, SDP optimization
│   └── main.js         # Entry point (imports all modules)
├── vite.config.js      # Vite bundler config
└── package.json        # Build scripts
```

## How It Works

1. `index.html` loads `styx-modules.js` before `app.js`
2. Modules expose `window.StyxModules` (M.ui, M.audio, M.core, etc.)
3. Functions in `app.js` delegate to modules when available:
   ```javascript
   function toast(msg, type, duration) {
     if (M.ui?.toast) return M.ui.toast(msg, type, duration);
     // fallback implementation...
   }
   ```

## Migrated Functions (23 total)

| Module | Functions |
|--------|-----------|
| M.ui | toast, initTheme, toggleTheme, showReconnectProgress, updateReconnectProgress, hideReconnectProgress, updateMuteUI |
| M.audio | getSharedAudioContext, createProcessedInputStream, updateInputEffect, initSpectrum, toggleSpectrum, applyAudioPreset, resetNoiseProfile |
| M.core | escapeHtml, formatTime, downloadBlob |
| M.settings | saveCustomPreset, deleteCustomPreset, saveRoomTemplate, getRoomTemplates, deleteRoomTemplate |
| M.network | getQualityGrade |

## Building Modules

```bash
cd shared/client
npm install
npm run build  # outputs styx-modules.js
```

## Future Work

To fully modularize app.js, these architectural changes are needed:

1. **State Management** - Extract global state (peers, socket, streams) into a store
2. **Socket Service** - Decouple 50+ socket event handlers from UI
3. **WebRTC Service** - Abstract peer connection management
4. **UI Components** - Split renderUsers, renderRoomList, etc.

This is a major rewrite (~2-3 days) and should be done when there's time for thorough testing.

## Adding New Module Functions

1. Add function to appropriate module in `modules/`
2. Run `npm run build` to rebuild bundle
3. Update app.js function to delegate: `if (M.module?.func) return M.module.func(...)`
4. Test both paths (with and without modules)
