// Styx Keyboard Shortcuts Module
// 키보드 단축키 시스템
(function() {

const globalEventListeners = [];

function addGlobalListener(target, event, handler) {
  target.addEventListener(event, handler);
  globalEventListeners.push({ target, event, handler });
}

function cleanupGlobalListeners() {
  globalEventListeners.forEach(({ target, event, handler }) => {
    target.removeEventListener(event, handler);
  });
  globalEventListeners.length = 0;
}

window.addEventListener('beforeunload', cleanupGlobalListeners);

addGlobalListener(window, 'error', (e) => {
  if (e.error?.name === 'OverconstrainedError' || e.message?.includes('getUserMedia')) {
    if (window.toast) toast('마이크 접근 오류 - 다른 앱이 사용 중일 수 있습니다', 'error');
  }
});

addGlobalListener(window, 'unhandledrejection', (e) => {
  if (e.reason?.name === 'NotAllowedError') {
    if (window.toast) toast('마이크 권한이 거부되었습니다', 'error');
    e.preventDefault();
  }
});

const keyboardShortcuts = {
  'KeyM': { action: 'toggleMute', global: false },
  'Space': { action: 'toggleMetronome', global: false },
  'KeyR': { action: 'toggleRecording', global: false },
  'KeyB': { action: 'addMarker', global: false, condition: () => window.StyxRecording?.isRecording },
  'KeyI': { action: 'copyInvite', global: false },
  'Escape': { action: 'leaveRoom', global: false },
  'KeyV': { action: 'toggleVAD', global: false },
  'KeyT': { action: 'toggleTuner', global: false },
  'KeyL': { action: 'toggleLowLatency', global: false },
  'KeyE': { action: 'toggleEchoCancellation', global: false },
  'KeyN': { action: 'toggleNoiseSuppression', global: false },
  'ArrowUp': { action: 'volumeUp', global: false },
  'ArrowDown': { action: 'volumeDown', global: false },
  'ArrowLeft': { action: 'inputVolumeDown', global: false },
  'ArrowRight': { action: 'inputVolumeUp', global: false },
  'Digit1': { action: 'togglePeerMute', global: false, peer: 0 },
  'Digit2': { action: 'togglePeerMute', global: false, peer: 1 },
  'Digit3': { action: 'togglePeerMute', global: false, peer: 2 },
  'Digit4': { action: 'togglePeerMute', global: false, peer: 3 },
  'Digit5': { action: 'togglePeerMute', global: false, peer: 4 },
  'Digit6': { action: 'togglePeerMute', global: false, peer: 5 },
  'Digit7': { action: 'togglePeerMute', global: false, peer: 6 },
  'Digit8': { action: 'togglePeerMute', global: false, peer: 7 },
  'F1': { action: 'showHelp', global: true },
  'F11': { action: 'toggleFullscreen', global: true },
  'ControlKeyS': { action: 'saveSettings', global: true },
  'ControlKeyO': { action: 'openSettings', global: true },
  'ControlAltKeyH': { action: 'toggleHighContrast', global: true },
  'ControlAltKeyS': { action: 'toggleScreenReader', global: true },
  'ControlAltKeyM': { action: 'toggleReducedMotion', global: true }
};

const actionHandlers = {};

function registerAction(name, handler) {
  actionHandlers[name] = handler;
}

function executeShortcut(action, options = {}) {
  if (actionHandlers[action]) {
    try { actionHandlers[action](options); return; } catch (e) { console.warn('Shortcut failed:', e); }
  }
  
  const $ = id => document.getElementById(id);
  const StyxAccessibility = window.StyxAccessibility || {};
  
  switch (action) {
    case 'toggleMute':
      if (!window.pttMode) $('muteBtn')?.click();
      break;
    case 'toggleMetronome':
      $('metronome-toggle')?.click();
      break;
    case 'toggleRecording':
      $('recordBtn')?.click();
      break;
    case 'addMarker':
      window.StyxRecording?.addRecordingMarker?.();
      break;
    case 'copyInvite':
      $('inviteBtn')?.click();
      break;
    case 'leaveRoom':
      $('leaveBtn')?.click();
      break;
    case 'toggleVAD':
      $('vad-toggle')?.click();
      break;
    case 'toggleTuner':
      $('tuner-toggle')?.click();
      break;
    case 'toggleLowLatency':
      $('low-latency-toggle')?.click();
      break;
    case 'toggleEchoCancellation':
      const echoEl = $('room-echo-cancel') || $('echo-cancel');
      if (echoEl) { echoEl.checked = !echoEl.checked; echoEl.dispatchEvent(new Event('change')); }
      break;
    case 'toggleNoiseSuppression':
      const noiseEl = $('room-noise-suppress') || $('noise-suppress');
      if (noiseEl) { noiseEl.checked = !noiseEl.checked; noiseEl.dispatchEvent(new Event('change')); }
      break;
    case 'volumeUp':
    case 'volumeDown':
      const masterVol = $('master-volume');
      if (masterVol) {
        const delta = action === 'volumeUp' ? 5 : -5;
        masterVol.value = Math.max(0, Math.min(100, parseInt(masterVol.value) + delta));
        masterVol.dispatchEvent(new Event('input'));
        if (window.toast) toast(`마스터 볼륨: ${masterVol.value}%`, 'info', 1000);
      }
      break;
    case 'inputVolumeUp':
    case 'inputVolumeDown':
      const inputVol = $('input-volume-slider');
      if (inputVol) {
        const delta = action === 'inputVolumeUp' ? 5 : -5;
        inputVol.value = Math.max(0, Math.min(200, parseInt(inputVol.value) + delta));
        inputVol.dispatchEvent(new Event('input'));
        if (window.toast) toast(`입력 볼륨: ${inputVol.value}%`, 'info', 1000);
      }
      break;
    case 'togglePeerMute':
      if (window.peers && options.peer !== undefined) {
        const peerIds = [...window.peers.keys()];
        if (peerIds[options.peer]) {
          const peer = window.peers.get(peerIds[options.peer]);
          if (peer?.audioEl) {
            peer.audioEl.muted = !peer.audioEl.muted;
            if (window.toast) toast(`${peer.username} ${peer.audioEl.muted ? '음소거' : '음소거 해제'}`, 'info', 1000);
            window.renderUsers?.();
          }
        }
      }
      break;
    case 'showHelp':
      $('shortcuts-overlay')?.classList.remove('hidden');
      break;
    case 'toggleFullscreen':
      if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
      else document.exitFullscreen?.();
      break;
    case 'saveSettings':
      window.saveCurrentSettings?.();
      break;
    case 'openSettings':
      $('settingsBtn')?.click();
      break;
    case 'toggleHighContrast':
      StyxAccessibility.toggleHighContrast?.();
      break;
    case 'toggleScreenReader':
      StyxAccessibility.toggleScreenReaderMode?.();
      break;
    case 'toggleReducedMotion':
      StyxAccessibility.toggleReducedMotion?.();
      break;
  }
}

function initKeyboardShortcuts() {
  const $ = id => document.getElementById(id);
  
  addGlobalListener(document, 'keydown', (e) => {
    const isInputField = e.target.matches('input, textarea, [contenteditable]');
    
    const globalKey = e.ctrlKey && e.altKey ? `ControlAlt${e.code}` : 
                     e.ctrlKey ? `Control${e.code}` : e.code;
    const globalShortcut = keyboardShortcuts[globalKey];
    
    if (globalShortcut?.global) {
      e.preventDefault();
      executeShortcut(globalShortcut.action);
      return;
    }
    
    if (e.key === 'F1' || (e.key === '?' && !isInputField)) {
      e.preventDefault();
      executeShortcut('showHelp');
      return;
    }
    
    if (e.key === 'Escape') {
      const overlay = $('shortcuts-overlay');
      if (overlay && !overlay.classList.contains('hidden')) {
        overlay.classList.add('hidden');
        return;
      }
      const roomView = $('room-view');
      if (!isInputField && roomView && !roomView.classList.contains('hidden')) {
        e.preventDefault();
        executeShortcut('leaveRoom');
      }
      return;
    }
    
    if (isInputField) return;
    
    if (window.pttMode && !window.isPttActive && e.code === window.pttKey && window.localStream) {
      window.isPttActive = true;
      window.localStream.getAudioTracks().forEach(t => t.enabled = true);
      const muteBtn = $('muteBtn');
      if (muteBtn) {
        muteBtn.classList.remove('muted');
        muteBtn.classList.add('ptt-active');
        muteBtn.textContent = '🎤';
      }
      return;
    }
    
    const roomView = $('room-view');
    if (roomView?.classList.contains('hidden')) return;
    
    const shortcut = keyboardShortcuts[e.code];
    if (shortcut && !shortcut.global) {
      if (shortcut.condition && !shortcut.condition()) return;
      e.preventDefault();
      executeShortcut(shortcut.action, shortcut.action === 'togglePeerMute' ? { peer: shortcut.peer } : {});
      return;
    }
    
    const legacyMappings = { 'ㅡ': 'toggleMute', 'ㄱ': 'toggleRecording', 'ㅠ': 'addMarker', 'ㅑ': 'copyInvite' };
    if (legacyMappings[e.key]) {
      e.preventDefault();
      executeShortcut(legacyMappings[e.key]);
    }
  });
  
  document.addEventListener('keyup', (e) => {
    if (window.pttMode && window.isPttActive && e.code === window.pttKey && window.localStream) {
      window.isPttActive = false;
      window.localStream.getAudioTracks().forEach(t => t.enabled = false);
      const muteBtn = document.getElementById('muteBtn');
      if (muteBtn) {
        muteBtn.classList.add('muted');
        muteBtn.classList.remove('ptt-active');
        muteBtn.textContent = '🔇';
      }
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initKeyboardShortcuts);
} else {
  initKeyboardShortcuts();
}

function initPttTouch() {
  const muteBtn = document.getElementById('muteBtn');
  if (!muteBtn) return;
  
  muteBtn.addEventListener('touchstart', (e) => {
    if (!window.pttMode || !window.localStream) return;
    e.preventDefault();
    window.isPttActive = true;
    window.localStream.getAudioTracks().forEach(t => t.enabled = true);
    muteBtn.classList.remove('muted');
    muteBtn.classList.add('ptt-active');
    muteBtn.textContent = '🎤';
  }, { passive: false });
  
  muteBtn.addEventListener('touchend', (e) => {
    if (!window.pttMode || !window.localStream) return;
    e.preventDefault();
    window.isPttActive = false;
    window.localStream.getAudioTracks().forEach(t => t.enabled = false);
    muteBtn.classList.add('muted');
    muteBtn.classList.remove('ptt-active');
    muteBtn.textContent = '🔇';
  }, { passive: false });
}

window.StyxKeyboard = {
  initKeyboardShortcuts,
  initPttTouch,
  registerAction,
  executeShortcut,
  addGlobalListener,
  cleanupGlobalListeners
};

})();
