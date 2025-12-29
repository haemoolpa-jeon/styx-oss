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

## Remaining Functions (157 total)

### Accessibility (7 functions) - Low complexity
- loadAccessibilitySettings, applyAccessibilitySettings, addScreenReaderSupport
- announceToScreenReader, toggleHighContrast, toggleScreenReaderMode, toggleReducedMotion
- saveAccessibilitySettings

### Audio Processing (15 functions) - Medium complexity
- startAudioMeter, startSpectrum, stopSpectrum, drawSpectrum
- startNoiseLearning, finishLearning, loadNoiseProfile, updateNoiseDisplay
- toggleNoiseProfile, toggleRouting, updateRouting, applyRoutingToStream
- setupSpatialAudio, toggleSpatialAudio, getPeerAudioContext

### Recording (8 functions) - Medium complexity
- startRecording, stopRecording, toggleRecording, cleanupRecording
- addRecordingMarker, exportMarkers, downloadTrack, audioBufferToWav, exportClickTrack

### Metronome (2 functions) - Low complexity
- startMetronome, stopMetronome

### Network/WebRTC (25 functions) - HIGH complexity, tightly coupled
- createPeerConnection, recreatePeerConnection, checkConnectionType
- detectNatType, canEstablishP2P, initiateP2P, attemptConnectionRecovery
- updateConnectionStatus, startLatencyPing, broadcastLatency
- startBandwidthMonitoring, stopBandwidthMonitoring, predictQualityIssues, adaptAudioQuality
- monitorNetworkQuality, adaptToNetworkQuality
- updateTurnCredentials, scheduleTurnRefresh, optimizeOpusSdp
- applyAudioSettings, applyAudioSettingsToAll, runConnectionTest, showTestResults

### UDP/TCP (Tauri) (10 functions) - Medium complexity
- startUdpMode, setUdpMuted, cleanupAudio, startUdpStatsMonitor, stopUdpStatsMonitor
- updateUdpStatsUI, updatePeerStatsUI, startTcpAudioStream, stopTcpAudioStream
- initTauriFeatures

### Room Management (15 functions) - HIGH complexity, socket-dependent
- showLobby, loadRoomList, renderRoomList, closeRoomFromLobby
- leaveRoom, closeRoom, createInviteLink, checkInviteLink
- displayRoomSettings, updateRoomSetting, syncRoomAudioSettings
- saveRoomTemplate, loadRoomTemplate, deleteRoomTemplate, updateTemplateSelect

### User/Peer Management (12 functions) - HIGH complexity
- renderUsers, applyMixerState, updateRoleUI, togglePeerMute
- startVAD, applyDucking, calculateSyncDelays, clearSyncDelays
- applyDelayCompensation, updateSelfStatsUI, searchUsers, renderUserList

### Settings/State (12 functions) - Medium complexity
- collectSettings, applySettings, scheduleSettingsSave, saveCurrentSettings
- autoDetectOptimalSettings, initStabilitySettings, applyLowLatencyMode
- setJitterBuffer, updateJitterBuffer, applyJitterBuffer, autoAdjustJitter, trackJitter

### UI/DOM (20 functions) - Medium complexity
- initUIEnhancements, enhanceKeyboardNavigation, executeShortcut
- showUserFriendlyError, handleCriticalError, addGlobalListener, cleanupGlobalListeners
- switchTab, openDiagnostics, closeDiagnostics, updateDiagnostics
- renderPingGraph, updatePresetSelect, showAuthMsg
- toggleFullscreen, toggleInputMonitor, toggleTuner, detectPitch, freqToNote

### Admin (10 functions) - Medium complexity
- checkAdminAccess, hideAdminFeaturesInTauri, initMonitoring, startMonitoring, stopMonitoring
- loadHealthData, loadMetricsData, refreshLogs, clearLogs, addSystemLog
- loadAdminData, updateAdminNotifications

### Screen Share (4 functions) - Medium complexity
- startScreenShare, stopScreenShare, createScreenShareConnection

### SFU (3 functions) - Low complexity
- toggleSfuMode, updateSfuButton, checkAutoSfu

### Chat (3 functions) - Low complexity
- sendChat, addChatMessage, playSound

### Misc Utilities (11 functions)
- getServerTime, syncServerTime, getOptimalBitrate
- adjustMasterVolume, adjustInputVolume, updateThemeIcon
- autoRejoin, reconnectAudioDevices, checkPendingDeepLink

## Recommended Migration Order

### Phase 1 - Easy wins (Low risk)
1. Accessibility functions → new `accessibility.js` module
2. Chat functions → new `chat.js` module  
3. SFU functions → add to `network.js`
4. Metronome functions → new `metronome.js` module

### Phase 2 - Medium complexity
1. Recording functions → expand `recording.js`
2. Audio processing → expand `audio.js`
3. Admin functions → new `admin.js` module
4. Settings functions → expand `settings.js`

### Phase 3 - Requires refactoring (High risk)
1. **State management** - Create central store for peers, socket, streams
2. **Socket service** - Decouple event handlers from UI
3. **WebRTC service** - Abstract peer connection lifecycle
4. **Room service** - Centralize room state management

## Building Modules

```bash
cd shared/client
npm install
npm run build  # outputs styx-modules.js
```

## Adding New Module Functions

1. Add function to appropriate module in `modules/`
2. Run `npm run build` to rebuild bundle
3. Update app.js function to delegate: `if (M.module?.func) return M.module.func(...)`
4. Test both paths (with and without modules)
