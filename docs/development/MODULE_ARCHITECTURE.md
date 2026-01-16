# Styx Client Module Architecture

## Overview
The client uses a hybrid architecture combining ES modules for utilities with a monolithic app.js for core WebRTC logic. This design prioritizes stability and backward compatibility.

## File Structure

```
shared/client/
├── app.js              # Main application (5500 lines, 190KB)
├── styx-modules.js     # Bundled ES modules (20KB, Vite output)
├── modules/            # ES module source files
│   ├── core.js         # Shared state, utilities
│   ├── ui.js           # Toast, theme, reconnect UI
│   ├── audio.js        # AudioContext, effects, spectrum
│   ├── settings.js     # localStorage management
│   ├── recording.js    # Recording, multitrack, WAV export
│   ├── network.js      # Quality metrics, SDP optimization
│   └── main.js         # Entry point
├── recording.js        # Standalone recording module (IIFE)
├── keyboard.js         # Keyboard shortcuts
├── accessibility.js    # Screen reader, high contrast
├── sync.js             # Latency sync between peers
├── sound.js            # UI sound effects
├── theme.js            # Theme toggle
├── tuner.js            # Instrument tuner
└── noise-gate-processor.js  # AudioWorklet for noise gate
```

## Architecture

### Loading Order (index.html)
1. `styx-modules.js` - Exposes `window.StyxModules`
2. Utility modules (utils.js, toast.js, etc.)
3. `app.js` - Main application

### Module Access Pattern
```javascript
const M = window.StyxModules || {};

// Delegate to module if available, fallback to local
function getSharedAudioContext() {
  if (M.audio?.getSharedAudioContext) return M.audio.getSharedAudioContext();
  // local implementation...
}
```

## Global State (96 variables)

Organized by category in app.js:

| Category | Variables |
|----------|-----------|
| Peer/Connection | peers, peerConnections, screenPeerConnections, vadIntervals |
| Audio | localStream, audioContext, sharedAudioContext, effectNodes |
| Room/User | currentUser, myRole, currentRoomSettings, isRoomCreator |
| Device | selectedDeviceId, selectedOutputId |
| Timers | latencyInterval, statsInterval, meterInterval |
| Network | myNatType, serverTimeOffset, latencyHistory, selfStats |

## Why Not Full Modularization?

1. **Tight Coupling**: WebRTC peer connections, audio processing, and room management share state
2. **Circular Dependencies**: createPeerConnection needs audio, audio needs peers for ducking
3. **Event-Driven**: Socket.io handlers span multiple concerns
4. **Working System**: Current architecture is stable and tested

## Migration Strategy

For future development:
- New features → Add to modules
- Bug fixes → Migrate touched code to modules
- Keep app.js as orchestration layer

## Module API Reference

### M.audio
- `getSharedAudioContext()` - Single AudioContext for all audio
- `createProcessedInputStream(stream)` - Apply EQ, compression, noise gate
- `updateInputEffect(effect, value)` - Real-time effect adjustment

### M.ui
- `toast(msg, type, duration)` - Show notification
- `showReconnectProgress(attempt)` - Connection retry UI

### M.settings
- `getSetting(key)` / `setSetting(key, value)` - localStorage wrapper
- `getPresets()` / `saveCustomPreset(name, preset)` - Audio presets

### M.network
- `getQualityGrade(latency, packetLoss, jitter)` - Connection quality
- `optimizeOpusSdp(sdp, mode)` - Codec optimization
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
