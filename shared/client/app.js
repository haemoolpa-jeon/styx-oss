// Styx 클라이언트 - HADES 실시간 오디오 협업
// WebRTC P2P 오디오 + 안정성 중심 설계

// Bundled ES modules (from styx-modules.js)
const M = window.StyxModules || {};

// Import from modules
const { accessibility, loadAccessibilitySettings, applyAccessibilitySettings, announceToScreenReader, 
        toggleHighContrast, toggleScreenReaderMode, toggleReducedMotion, enhanceKeyboardNavigation } = window.StyxAccessibility || {};

// SFU mode is now auto-enabled for 5+ users via hybrid relay on server
let sfuMode = false;

function updateSfuButton() {
  // Kept for compatibility - SFU is now automatic
}

// Bandwidth monitoring removed - quality adaptation handled by auto-adapt

// 디버그 모드 (프로덕션에서는 false)
const DEBUG = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
window.DEBUG = DEBUG;
const log = (...args) => DEBUG && console.log(...args);

// Audio constants
const SAMPLE_RATE = 48000;
const LATENCY_PING_INTERVAL = 3000;
const STATS_INTERVAL = 2000;
const QUALITY_CHECK_INTERVAL = 5000;

const serverUrl = window.STYX_SERVER_URL || '';
const socket = io(serverUrl, { reconnection: true, reconnectionDelay: 1000, reconnectionAttempts: 10 });

// Reconnection progress tracking
let reconnectAttempt = 0;

socket.io.on('reconnect_attempt', (attempt) => {
  reconnectAttempt = attempt;
  showReconnectProgress(attempt);
});

socket.io.on('reconnect_error', () => {
  updateReconnectProgress();
});

socket.io.on('reconnect_failed', () => {
  hideReconnectProgress();
  toast('서버 연결 실패 - 페이지를 새로고침해주세요', 'error', 10000);
});

function showReconnectProgress(attempt = 1) {
  if (M.ui?.showReconnectProgress) return M.ui.showReconnectProgress(attempt);
  const overlay = $('reconnect-overlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  const countEl = $('reconnect-count');
  if (countEl) countEl.textContent = attempt;
  const progress = (attempt / 10) * 100;
  const progressBar = overlay.querySelector('.progress-bar');
  if (progressBar) progressBar.style.width = progress + '%';
}

function updateReconnectProgress() {
  if (M.ui?.updateReconnectProgress) return M.ui.updateReconnectProgress();
  const overlay = $('reconnect-overlay');
  if (!overlay || overlay.classList.contains('hidden')) return;
  const progress = (reconnectAttempt / 10) * 100;
  const progressBar = overlay.querySelector('.progress-bar');
  if (progressBar) progressBar.style.width = progress + '%';
}

function hideReconnectProgress() {
  if (M.ui?.hideReconnectProgress) return M.ui.hideReconnectProgress();
  const overlay = $('reconnect-overlay');
  if (overlay) overlay.classList.add('hidden');
  reconnectAttempt = 0;
}

// 아바타 URL을 절대 경로로 변환
const avatarUrl = (path) => path ? (path.startsWith('/') ? serverUrl + path : path) : '';

const peers = new Map();
const volumeStates = new Map();
let localStream = null;
let isMuted = false;
let currentUser = null;
let myRole = 'performer'; // 'host' | 'performer' | 'listener'
let selectedDeviceId = null;
let selectedOutputId = null;
let latencyInterval = null;
let statsInterval = null;
let audioContext = null;
let peerAudioContext = null; // 피어 오디오 처리용 공유 AudioContext
let analyser = null;
let meterInterval = null;
let metronomeInterval = null;
let metronomeAudio = null;
let metronomeLocalStop = false; // Track if user locally stopped metronome
let sessionRestored = false;
let inputLimiterContext = null; // 입력 리미터용 AudioContext
let processedStream = null; // 리미터 적용된 스트림

// All interval/timer declarations (moved to top for error recovery)
let networkQualityInterval = null;
let monitoringInterval = null;
let tcpAudioInterval = null;
let tcpHandlerRegistered = false;
let udpStatsInterval = null;
let udpHealthFailCount = 0;
let adminNotificationInterval = null;
let turnRefreshTimer = null;
let settingsSaveTimer = null;

// Variables used in leaveRoom (moved to top for error recovery)
let sharedAudioContext = null;
let syncMode = false;
let peerLatencies = new Map();
let peerConnections = new Map();
let latencyHistory = [];
let isPttActive = false;
let inputMonitorCtx = null;
let vadIntervals = new Map();
let screenPeerConnections = new Map();
let metronomeBeat = 0; // moved to top for error recovery

// 피어 오디오용 공유 AudioContext 가져오기 (통합된 컨텍스트 사용)
function getPeerAudioContext() {
  return getSharedAudioContext();
}

// Resume audio contexts on user interaction (browser autoplay policy)
document.addEventListener('click', function resumeAudio() {
  if (audioContext?.state === 'suspended') audioContext.resume();
  if (peerAudioContext?.state === 'suspended') peerAudioContext.resume();
  if (inputMonitorCtx?.state === 'suspended') inputMonitorCtx.resume();
  if (sharedAudioContext?.state === 'suspended') sharedAudioContext.resume();
}, { once: false });

// 입력 오디오에 리미터/컴프레서 + EQ 적용 (저지연)
let inputEffects = { eqLow: 0, eqMid: 0, eqHigh: 0, inputVolume: 120, compressionRatio: 4 };

// Audio presets (built-in + custom)
const builtInPresets = {
  voice: { eqLow: -3, eqMid: 2, eqHigh: 1, inputVolume: 130, compressionRatio: 6 },
  instrument: { eqLow: 0, eqMid: 0, eqHigh: 0, inputVolume: 100, compressionRatio: 2 },
  podcast: { eqLow: -2, eqMid: 3, eqHigh: 2, inputVolume: 140, compressionRatio: 5 }
};
let customPresets = {};
try { customPresets = JSON.parse(localStorage.getItem('styx-custom-presets') || '{}'); } catch {}

function applyAudioPreset(preset) {
  if (preset === 'custom') return;
  
  const allPresets = M.settings?.getPresets ? M.settings.getPresets() : { ...builtInPresets, ...customPresets };
  const p = allPresets[preset];
  if (!p) return;
  
  if (M.audio?.applyAudioPreset) return M.audio.applyAudioPreset(p);
  
  inputEffects = { ...inputEffects, ...p };
  
  // Update UI
  if ($('eq-low')) { $('eq-low').value = p.eqLow; $('eq-low').nextElementSibling.textContent = p.eqLow + 'dB'; }
  if ($('eq-mid')) { $('eq-mid').value = p.eqMid; $('eq-mid').nextElementSibling.textContent = p.eqMid + 'dB'; }
  if ($('eq-high')) { $('eq-high').value = p.eqHigh; $('eq-high').nextElementSibling.textContent = p.eqHigh + 'dB'; }
  if ($('input-volume')) { $('input-volume').value = p.inputVolume; $('input-volume').nextElementSibling.textContent = p.inputVolume + '%'; }
  if ($('compression-ratio')) { $('compression-ratio').value = p.compressionRatio; $('compression-ratio').nextElementSibling.textContent = p.compressionRatio + ':1'; }
  
  // Apply to audio nodes
  updateInputEffect('eqLow', p.eqLow);
  updateInputEffect('eqMid', p.eqMid);
  updateInputEffect('eqHigh', p.eqHigh);
  updateInputEffect('inputVolume', p.inputVolume);
  updateInputEffect('compressionRatio', p.compressionRatio);
  
  localStorage.setItem('styx-effects', JSON.stringify(inputEffects));
  toast(`🎛️ ${preset} 프리셋 적용`, 'success');
}
window.applyAudioPreset = applyAudioPreset;

function saveCustomPreset() {
  if (M.settings?.saveCustomPreset) {
    const name = prompt('프리셋 이름을 입력하세요:');
    if (!name || name.trim() === '') return;
    M.settings.saveCustomPreset(name, { ...inputEffects });
    updatePresetSelect();
    toast(`💾 "${name}" 프리셋 저장됨`, 'success');
    return;
  }
  const name = prompt('프리셋 이름을 입력하세요:');
  if (!name || name.trim() === '') return;
  customPresets[name] = { ...inputEffects };
  localStorage.setItem('styx-custom-presets', JSON.stringify(customPresets));
  updatePresetSelect();
  toast(`💾 "${name}" 프리셋 저장됨`, 'success');
}

function deleteCustomPreset(name) {
  if (M.settings?.deleteCustomPreset) {
    M.settings.deleteCustomPreset(name);
    updatePresetSelect();
    toast(`🗑️ "${name}" 프리셋 삭제됨`, 'info');
    return;
  }
  if (!customPresets[name]) return;
  delete customPresets[name];
  localStorage.setItem('styx-custom-presets', JSON.stringify(customPresets));
  updatePresetSelect();
  toast(`🗑️ "${name}" 프리셋 삭제됨`, 'info');
}

function updatePresetSelect() {
  const select = $('audio-preset');
  if (!select) return;
  
  const presets = M.settings?.getPresets ? M.settings.getPresets() : { ...builtInPresets, ...customPresets };
  const customNames = Object.keys(presets).filter(k => !['voice', 'instrument', 'podcast'].includes(k));
  
  select.innerHTML = `
    <option value="custom">사용자 정의</option>
    <option value="voice">🎤 음성</option>
    <option value="instrument">🎸 악기</option>
    <option value="podcast">🎙️ 팟캐스트</option>
    ${customNames.map(name => `<option value="${name}">⭐ ${name}</option>`).join('')}
  `;
}
let effectNodes = {};
let noiseGateWorklet = null;

// 사용자 경험 개선 - 자동 설정 감지
async function autoDetectOptimalSettings() {
  try {
    // 1. 오디오 장치 자동 선택
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default');
    const audioOutputs = devices.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'default');
    
    // 기본 장치가 아닌 첫 번째 장치 선택 (보통 더 좋은 품질)
    if (audioInputs.length > 0 && !selectedDeviceId) {
      selectedDeviceId = audioInputs[0].deviceId;
      if ($('audio-device')) $('audio-device').value = selectedDeviceId;
    }
    
    if (audioOutputs.length > 0 && !selectedOutputId) {
      selectedOutputId = audioOutputs[0].deviceId;
      if ($('audio-output')) $('audio-output').value = selectedOutputId;
    }
    
    // 2. 네트워크 기반 설정 자동 조정
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (connection) {
      let recommendedJitter = 40;
      
      if (connection.effectiveType === '4g') {
        recommendedJitter = 30;
      } else if (connection.effectiveType === '3g') {
        recommendedJitter = 60;
      } else if (connection.effectiveType === 'slow-2g' || connection.effectiveType === '2g') {
        recommendedJitter = 100;
      }
      
      // UI 업데이트
      if ($('jitter-slider')) {
        $('jitter-slider').value = recommendedJitter;
        updateJitterBuffer(recommendedJitter);
      }
    }
    
    // 3. 브라우저 최적화 설정
    if (navigator.userAgent.includes('Chrome')) {
      // Chrome 최적화
      echoCancellation = true;
      noiseSuppression = true;
    } else if (navigator.userAgent.includes('Firefox')) {
      // Firefox 최적화
      echoCancellation = false; // Firefox의 에코 제거가 때로 문제가 됨
      noiseSuppression = true;
    }
    
    toast('최적 설정이 자동으로 적용되었습니다', 'success', 3000);
  } catch (e) {
    console.warn('Auto-detect settings failed:', e);
  }
}

// 개선된 에러 메시지
// 사용자 친화적 에러 (from utils.js module)
const { showUserFriendlyError, getQualityGrade, formatTime, downloadBlob } = window.StyxUtils || {};

// 페이지 로드 시 자동 설정 감지 실행
document.addEventListener('DOMContentLoaded', () => {
  loadAccessibilitySettings();
  enhanceKeyboardNavigation();
  // Auto-optimization moved to after login
});

// 네트워크 품질 모니터링 및 적응형 설정
let networkQuality = 'good'; // 'good', 'fair', 'poor'
let adaptiveSettingsEnabled = true;
let lastQualityCheck = 0;

function monitorNetworkQuality() {
  const now = Date.now();
  if (now - lastQualityCheck < 5000) return; // 5초마다 체크
  lastQualityCheck = now;
  
  // RTCPeerConnection 통계 기반 품질 평가
  peers.forEach(async (peer, peerId) => {
    if (!peer.connection) return;
    
    try {
      const stats = await peer.connection.getStats();
      let totalLoss = 0, totalRtt = 0, count = 0;
      
      stats.forEach(report => {
        if (report.type === 'inbound-rtp' && report.mediaType === 'audio') {
          if (report.packetsLost !== undefined && report.packetsReceived !== undefined) {
            const lossRate = report.packetsLost / (report.packetsLost + report.packetsReceived) * 100;
            totalLoss += lossRate;
            count++;
          }
        }
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          if (report.currentRoundTripTime !== undefined) {
            totalRtt += report.currentRoundTripTime * 1000; // ms로 변환
          }
        }
      });
      
      if (count > 0) {
        const avgLoss = totalLoss / count;
        const rtt = totalRtt;
        
        // 품질 등급 결정
        let quality = 'good';
        if (avgLoss > 5 || rtt > 150) quality = 'poor';
        else if (avgLoss > 2 || rtt > 80) quality = 'fair';
        
        if (quality !== networkQuality) {
          networkQuality = quality;
          if (adaptiveSettingsEnabled) {
            adaptToNetworkQuality(quality);
          }
        }
      }
    } catch (e) {
      console.warn('Network quality check failed:', e);
    }
  });
}

function adaptToNetworkQuality(quality) {
  const settings = {
    good: { bitrate: 96, jitterBuffer: 30, mono: false },
    fair: { bitrate: 64, jitterBuffer: 50, mono: false },
    poor: { bitrate: 32, jitterBuffer: 80, mono: true }
  };
  
  const config = settings[quality];
  if (!config) return;
  
  // Graceful degradation - adjust settings to prevent dropout
  if (actuallyTauri) {
    tauriInvoke('set_bitrate', { bitrate: config.bitrate }).catch(e => { if (DEBUG) console.debug('Silent error:', e); });
    tauriInvoke('set_jitter_buffer', { size: Math.round(config.jitterBuffer / 5) }).catch(e => { if (DEBUG) console.debug('Silent error:', e); });
  }
  
  // Auto-increase jitter buffer on poor quality
  if (quality === 'poor' && !proMode && !lowLatencyMode) {
    jitterBuffer = Math.max(jitterBuffer, config.jitterBuffer);
    if ($('jitter-slider')) $('jitter-slider').value = jitterBuffer;
    if ($('jitter-value')) $('jitter-value').textContent = jitterBuffer + 'ms';
  }
  
  const labels = { good: '양호', fair: '보통', poor: '불안정' };
  toast(`📶 ${labels[quality]} - ${quality === 'poor' ? '버퍼 증가됨' : '최적화됨'}`, 'info', 2000);
}

// 네트워크 품질 모니터링 (방 입장 시 시작)

// 자동 크래시 복구 및 에러 경계
let crashRecoveryAttempts = 0;
const MAX_RECOVERY_ATTEMPTS = 3;
let appFullyLoaded = false; // Flag to prevent recovery during initialization

function handleCriticalError(error, context) {
  console.error(`Critical error in ${context}:`, error);
  
  // Don't attempt recovery during script initialization
  if (!appFullyLoaded) {
    console.warn('Error during initialization, skipping auto-recovery');
    return;
  }
  
  if (crashRecoveryAttempts < MAX_RECOVERY_ATTEMPTS) {
    crashRecoveryAttempts++;
    toast(`오류 발생 - 자동 복구 시도 중... (${crashRecoveryAttempts}/${MAX_RECOVERY_ATTEMPTS})`, 'warning');
    
    setTimeout(() => {
      try {
        // 리소스 정리 후 재시작
        leaveRoom();
        setTimeout(() => {
          if (lastRoom) {
            joinRoom(lastRoom, !!lastRoomPassword, lastRoomPassword);
          }
        }, 1000);
      } catch (e) {
        console.error('Recovery failed:', e);
        toast('자동 복구 실패 - 페이지를 새로고침해주세요', 'error');
      }
    }, 2000);
  } else {
    toast('복구 시도 한계 초과 - 페이지를 새로고침해주세요', 'error');
  }
}

// 전역 에러 핸들러
window.addEventListener('error', (e) => {
  handleCriticalError(e.error, 'Global');
});

window.addEventListener('unhandledrejection', (e) => {
  handleCriticalError(e.reason, 'Promise');
});

// 통합 AudioContext 관리 - delegates to module

function getSharedAudioContext() {
  if (M.audio?.getSharedAudioContext) return M.audio.getSharedAudioContext();
  if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
    sharedAudioContext = new AudioContext({ latencyHint: 'interactive', sampleRate: SAMPLE_RATE });
  }
  if (sharedAudioContext.state === 'suspended') sharedAudioContext.resume();
  return sharedAudioContext;
}

async function createProcessedInputStream(rawStream) {
  if (M.audio?.createProcessedInputStream) {
    const result = await M.audio.createProcessedInputStream(rawStream);
    processedStream = result;
    return result;
  }
  // Pro Mode: bypass all processing for minimum latency
  if (proMode) {
    processedStream = rawStream;
    effectNodes = {};
    return rawStream;
  }
  
  // 공유 AudioContext 사용
  const ctx = getSharedAudioContext();
  inputLimiterContext = ctx; // 호환성을 위해 유지
  
  const source = ctx.createMediaStreamSource(rawStream);
  
  // EQ (3밴드) - 지연 거의 없음 (~0.1ms each)
  const eqLow = ctx.createBiquadFilter();
  eqLow.type = 'lowshelf'; eqLow.frequency.value = 320; eqLow.gain.value = inputEffects.eqLow;
  
  const eqMid = ctx.createBiquadFilter();
  eqMid.type = 'peaking'; eqMid.frequency.value = 1000; eqMid.Q.value = 1; eqMid.gain.value = inputEffects.eqMid;
  
  const eqHigh = ctx.createBiquadFilter();
  eqHigh.type = 'highshelf'; eqHigh.frequency.value = 3200; eqHigh.gain.value = inputEffects.eqHigh;
  
  // AI 노이즈 제거 (AudioWorklet noise gate)
  let lastNode = eqHigh;
  if (aiNoiseCancellation) {
    try {
      await ctx.audioWorklet.addModule('noise-gate-processor.js');
      noiseGateWorklet = new AudioWorkletNode(ctx, 'noise-gate-processor');
      const thresholdParam = noiseGateWorklet.parameters.get('threshold');
      if (thresholdParam) thresholdParam.value = -45; // Default threshold
      eqHigh.connect(noiseGateWorklet);
      lastNode = noiseGateWorklet;
    } catch (e) { log('Noise gate worklet failed:', e); }
  }
  
  // 컴프레서 (리미터 역할) - 클리핑 방지
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -12; compressor.knee.value = 6;
  compressor.ratio.value = inputEffects.compressionRatio || 4; compressor.attack.value = 0.003; compressor.release.value = 0.1;
  
  // 메이크업 게인 (입력 볼륨 컨트롤)
  const makeupGain = ctx.createGain();
  makeupGain.gain.value = inputEffects.inputVolume / 100;
  
  const dest = ctx.createMediaStreamDestination();
  
  // 체인: source -> EQ -> [noiseGate] -> compressor -> gain -> dest
  source.connect(eqLow);
  eqLow.connect(eqMid);
  eqMid.connect(eqHigh);
  lastNode.connect(compressor);
  compressor.connect(makeupGain);
  makeupGain.connect(dest);
  
  effectNodes = { eqLow, eqMid, eqHigh, compressor, makeupGain, noiseGate: noiseGateWorklet };
  processedStream = dest.stream;
  return processedStream;
}

function updateInputEffect(effect, value) {
  if (M.audio?.updateInputEffect) return M.audio.updateInputEffect(effect, value);
  inputEffects[effect] = value;
  localStorage.setItem('styx-effects', JSON.stringify(inputEffects));
  
  if (!effectNodes.eqLow) return;
  
  switch(effect) {
    case 'eqLow': effectNodes.eqLow.gain.value = value; break;
    case 'eqMid': effectNodes.eqMid.gain.value = value; break;
    case 'eqHigh': effectNodes.eqHigh.gain.value = value; break;
    case 'inputVolume': 
      if (effectNodes.makeupGain) effectNodes.makeupGain.gain.value = value / 100; 
      break;
    case 'compressionRatio':
      if (effectNodes.compressor) effectNodes.compressor.ratio.value = value;
      // 모든 피어의 압축비도 업데이트
      peers.forEach(peer => {
        if (peer.compressor) peer.compressor.ratio.value = value;
      });
      break;
  }
}

// 저장된 이펙트 설정 로드
try { 
  const saved = localStorage.getItem('styx-effects');
  if (saved) inputEffects = { ...inputEffects, ...JSON.parse(saved) };
} catch (e) { 
  console.warn('Effects settings load failed:', e);
}

// Tauri 감지 - 더 안정적인 방법
const isTauriApp = () => {
  // 1. User-Agent 확인
  if (navigator.userAgent.includes('Tauri')) return true;
  
  // 2. window.__TAURI__ 확인
  if (typeof window.__TAURI__ !== 'undefined') return true;
  
  // 3. Tauri 특유의 전역 객체 확인
  if (typeof window.__TAURI_INTERNALS__ !== 'undefined') return true;
  
  // 4. 브라우저 특성 확인 (Tauri는 file:// 프로토콜 사용)
  if (location.protocol === 'tauri:') return true;
  
  return false;
};

const actuallyTauri = isTauriApp();
const tauriInvoke = (cmd, args) => {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return Promise.reject('Tauri not ready');
  return invoke(cmd, args).catch(e => {
    // Suppress IPC protocol errors - Tauri falls back to postMessage
    if (String(e).includes('Failed to fetch')) return Promise.reject('IPC fallback');
    throw e;
  });
};

// 관리자 전용 기능 접근 제어
function checkAdminAccess() {
  // Tauri 앱에서는 관리자 기능 비활성화
  if (actuallyTauri) {
    return false;
  }
  
  // 웹에서만 관리자 기능 허용, 로그인된 관리자만
  return currentUser && currentUser.isAdmin;
}

function hideAdminFeaturesInTauri() {
  if (actuallyTauri) {
    // Tauri 앱에서는 관리자 관련 UI 숨기기
    $('admin-panel')?.classList.add('hidden');
    const adminBtn = document.querySelector('[onclick*="admin"]');
    if (adminBtn) adminBtn.style.display = 'none';
  }
}

// 모니터링 시스템
let monitoringInitialized = false;
const systemLogs = [];

function initMonitoring() {
  if (!checkAdminAccess() || monitoringInitialized) return;
  
  // 탭 전환
  $('health-tab')?.addEventListener('click', () => switchTab('health'));
  $('metrics-tab')?.addEventListener('click', () => switchTab('metrics'));
  $('logs-tab')?.addEventListener('click', () => switchTab('logs'));
  
  // 로그 제어
  $('refresh-logs')?.addEventListener('click', refreshLogs);
  $('clear-logs')?.addEventListener('click', clearLogs);
  
  monitoringInitialized = true;
  
  // 자동 새로고침 시작
  startMonitoring();
}

function switchTab(tab) {
  // 탭 버튼 활성화
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  $(`${tab}-tab`)?.classList.add('active');
  
  // 콘텐츠 표시
  document.querySelectorAll('.tab-content').forEach(content => content.classList.add('hidden'));
  $(`${tab}-content`)?.classList.remove('hidden');
  
  // 데이터 로드
  if (tab === 'health') loadHealthData();
  else if (tab === 'metrics') loadMetricsData();
  else if (tab === 'logs') refreshLogs();
}

function startMonitoring() {
  if (monitoringInterval) return;
  
  monitoringInterval = setInterval(() => {
    const activeTab = document.querySelector('.tab-btn.active')?.id.replace('-tab', '');
    if (activeTab === 'health') loadHealthData();
    else if (activeTab === 'metrics') loadMetricsData();
  }, 5000); // 5초마다 새로고침
}

function stopMonitoring() {
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
  }
}

async function loadHealthData() {
  try {
    const response = await fetch('/health');
    const data = await response.json();
    
    const statsGrid = $('health-stats');
    if (!statsGrid) return;
    
    statsGrid.innerHTML = `
      <div class="stat-card">
        <div class="stat-value">${data.status}</div>
        <div class="stat-label">상태</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${Math.floor(data.uptime / 60)}분</div>
        <div class="stat-label">가동시간</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${data.stats?.activeConnections || 0}</div>
        <div class="stat-label">활성 연결</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${data.stats?.activeRooms || 0}</div>
        <div class="stat-label">활성 방</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${data.stats?.totalMessages || 0}</div>
        <div class="stat-label">총 메시지</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${data.stats?.errors || 0}</div>
        <div class="stat-label">오류</div>
      </div>
    `;
  } catch (e) {
    console.error('Health data load failed:', e);
  }
}

async function loadMetricsData() {
  try {
    const response = await fetch('/metrics');
    const data = await response.text();
    
    const metricsDisplay = $('metrics-data');
    if (metricsDisplay) {
      metricsDisplay.textContent = data;
    }
  } catch (e) {
    console.error('Metrics data load failed:', e);
  }
}

function refreshLogs() {
  const logsDisplay = $('logs-display');
  if (!logsDisplay) return;
  
  // 최근 로그 표시 (실제로는 서버에서 가져와야 하지만 여기서는 클라이언트 로그 표시)
  const recentLogs = systemLogs.slice(-50).reverse();
  logsDisplay.textContent = recentLogs.join('\n') || '로그가 없습니다.';
}

function clearLogs() {
  systemLogs.length = 0;
  refreshLogs();
}

function addSystemLog(message) {
  const timestamp = new Date().toISOString();
  systemLogs.push(`[${timestamp}] ${message}`);
  
  // 최대 1000개 로그만 유지
  if (systemLogs.length > 1000) {
    systemLogs.splice(0, systemLogs.length - 1000);
  }
}

// Professional UI Enhancements
function initUIEnhancements() {
  // Add fade-in animation to main elements
  document.querySelectorAll('.modal-box, .card, .room-item').forEach(el => {
    el.classList.add('fade-in');
  });
  
  // Add loading states to buttons during actions
  document.querySelectorAll('button').forEach(btn => {
    const originalClick = btn.onclick;
    if (originalClick) {
      btn.onclick = function(e) {
        btn.classList.add('loading');
        setTimeout(() => btn.classList.remove('loading'), 1000);
        return originalClick.call(this, e);
      };
    }
  });
  
  // Enhanced form validation feedback
  document.querySelectorAll('input, select, textarea').forEach(input => {
    input.addEventListener('invalid', (e) => {
      e.target.style.borderColor = 'var(--error)';
      e.target.style.boxShadow = '0 0 0 3px rgba(255, 71, 87, 0.1)';
    });
    
    input.addEventListener('input', (e) => {
      if (e.target.checkValidity()) {
        e.target.style.borderColor = 'var(--success)';
        e.target.style.boxShadow = '0 0 0 3px rgba(0, 210, 106, 0.1)';
      }
    });
  });
  
  // Add slide-in animation to new elements (room items only, not user cards which rebuild frequently)
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === 1 && node.classList.contains('room-item')) {
          node.classList.add('slide-in');
        }
      });
    });
  });
  
  observer.observe(document.body, { childList: true, subtree: true });
}

// Enhanced toast notifications with better styling
// Debug: Tauri 감지 상태 확인
log('Tauri detection:', {
  __TAURI__: typeof window.__TAURI__,
  __TAURI_INTERNALS__: typeof window.__TAURI_INTERNALS__,
  userAgent: navigator.userAgent,
  protocol: location.protocol,
  actuallyTauri
});

// 안정성 설정
let audioMode = localStorage.getItem('styx-audio-mode') || 'voice'; // voice | music
let jitterBuffer = parseInt(localStorage.getItem('styx-jitter-buffer')) || 50; // ms (낮을수록 저지연, 높을수록 안정)
let autoAdapt = localStorage.getItem('styx-auto-adapt') !== 'false';

// Sync Mode - 모든 사용자가 동일한 지연시간으로 듣도록 조정
// syncMode, peerLatencies moved to top for error recovery
// maxRoomLatency and syncDelayBuffers are managed by sync.js module

// P2P Connection State
let myNatType = 'Unknown';
let myPublicAddr = null;
// peerConnections moved to top for error recovery

// 오디오 처리 설정
let echoCancellation = localStorage.getItem('styx-echo') !== 'false';
let noiseSuppression = localStorage.getItem('styx-noise') !== 'false';
let aiNoiseCancellation = localStorage.getItem('styx-ai-noise') === 'true'; // Off by default (adds latency)
let autoGainControl = localStorage.getItem('styx-auto-gain') !== 'false';
let pttMode = localStorage.getItem('styx-ptt') === 'true';
let pttKey = localStorage.getItem('styx-ptt-key') || 'Space';
// isPttActive moved to top for error recovery

// 오디오 프로세싱 노드
let gainNode = null;
// latencyHistory moved to top for error recovery
let serverTimeOffset = 0; // 서버 시간과 클라이언트 시간 차이 (ms)

// Self connection stats
let selfStats = {
  latency: 0,
  jitter: 0,
  packetsLost: 0,
  bandwidth: 0,
  connectionType: 'unknown'
};

// Audio input monitoring
let inputMonitorEnabled = localStorage.getItem('styx-input-monitor') === 'true';
let inputMonitorGain = null;
// inputMonitorCtx moved to top for error recovery

function toggleInputMonitor(enabled) {
  inputMonitorEnabled = enabled;
  localStorage.setItem('styx-input-monitor', enabled);
  
  if (enabled && localStream) {
    if (!inputMonitorCtx) inputMonitorCtx = new AudioContext();
    const source = inputMonitorCtx.createMediaStreamSource(localStream);
    inputMonitorGain = inputMonitorCtx.createGain();
    inputMonitorGain.gain.value = 0.7;
    source.connect(inputMonitorGain);
    inputMonitorGain.connect(inputMonitorCtx.destination);
    toast('입력 모니터링 켜짐', 'info');
  } else if (inputMonitorGain) {
    inputMonitorGain.disconnect();
    inputMonitorGain = null;
    toast('입력 모니터링 꺼짐', 'info');
  }
}

// Instrument tuner (from tuner.js module)
const { toggleTuner, cleanupTuner, detectPitch, freqToNote } = window.StyxTuner || {};

// 추가 기능
let isOnline = navigator.onLine;
let lastRoom = sessionStorage.getItem('styx-room');
let lastRoomPassword = sessionStorage.getItem('styx-room-pw');
let duckingEnabled = localStorage.getItem('styx-ducking') === 'true';
let vadEnabled = localStorage.getItem('styx-vad') !== 'false';
// vadIntervals moved to top for error recovery
let delayCompensation = false;
let autoJitter = localStorage.getItem('styx-auto-jitter') !== 'false'; // 자동 지터 버퍼
let lowLatencyMode = localStorage.getItem('styx-low-latency') === 'true'; // 저지연 모드
let proMode = localStorage.getItem('styx-pro-mode') === 'true'; // Pro 모드 (처리 우회)
let dtxEnabled = localStorage.getItem('styx-dtx') === 'true'; // DTX (무음 시 전송 안함)
let comfortNoiseEnabled = localStorage.getItem('styx-comfort-noise') === 'true'; // 컴포트 노이즈
let currentRoomSettings = {}; // 현재 방 설정
let isRoomCreator = false; // 방장 여부
let roomCreatorUsername = ''; // 방장 이름

// 기본 ICE 서버 설정 (TURN은 서버에서 동적으로 받음)
let rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ],
  iceCandidatePoolSize: 10,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require'
};

// TURN 자격증명 요청 및 rtcConfig 업데이트
function updateTurnCredentials() {
  socket.emit('get-turn-credentials', null, (turnServer) => {
    if (turnServer) {
      // 서버에서 받은 TURN 설정 추가
      rtcConfig.iceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: turnServer.urls, username: turnServer.username, credential: turnServer.credential }
      ];
      log('TURN 자격증명 업데이트됨');
      // 만료 전 갱신 스케줄
      scheduleTurnRefresh();
    } else {
      // 폴백: 무료 TURN 서버
      rtcConfig.iceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
      ];
      log('TURN 폴백 사용');
    }
  });
}

// 오디오 모드별 설정 - Enhanced with quality levels
const audioModes = {
  voice: { bitrate: 32000, stereo: false, fec: true, dtx: true, name: '음성' },
  music: { bitrate: 128000, stereo: true, fec: true, dtx: false, name: '악기' }
};

// Dynamic quality levels for bandwidth optimization
const qualityLevels = {
  low: { multiplier: 0.5, name: '절약' },
  medium: { multiplier: 0.75, name: '보통' },
  high: { multiplier: 1.0, name: '고품질' },
  auto: { multiplier: 1.0, name: '자동' }
};

let currentQualityLevel = localStorage.getItem('styx-quality-level') || 'auto';

const $ = id => document.getElementById(id);

// 연결 품질 등급 (from utils.js module)
// getQualityGrade imported above

// ===== 연결 테스트 + 네트워크 품질 측정 =====
let networkTestResults = { latency: 0, jitter: 0, isWifi: false };

async function runConnectionTest() {
  const results = { mic: false, speaker: false, network: false, turn: false, quality: null };
  const statusEl = $('test-status');
  const updateStatus = (msg) => { if (statusEl) statusEl.textContent = msg; };
  
  // 1. 마이크 테스트
  updateStatus('🎤 마이크 테스트 중...');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const track = stream.getAudioTracks()[0];
    results.mic = track.readyState === 'live';
    stream.getTracks().forEach(t => t.stop());
  } catch (e) { 
    results.mic = false; 
    showUserFriendlyError(e, 'microphone test');
  }
  
  // 2. 스피커 테스트 (간단한 비프음)
  updateStatus('🔊 스피커 테스트 중...');
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.value = 0.1;
    osc.frequency.value = 440;
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
    results.speaker = true;
    await new Promise(r => setTimeout(r, 300));
    ctx.close();
  } catch { results.speaker = false; }
  
  // 3. 네트워크 품질 측정 (ping 테스트)
  updateStatus('📡 네트워크 품질 측정 중...');
  const pings = [];
  
  // Tauri app - use UDP latency measurement
  if (actuallyTauri && window.__TAURI__?.core?.invoke) {
    // First detect NAT type (works without relay)
    try {
      const natInfo = await Promise.race([
        tauriInvoke('detect_nat'),
        new Promise((_, reject) => setTimeout(() => reject('timeout'), 5000))
      ]);
      if (natInfo) {
        results.natType = natInfo.nat_type;
        results.publicAddr = natInfo.public_addr;
        results.network = true;
      }
    } catch (e) {
      log('NAT detection skipped:', e);
      results.network = true; // Assume network works
    }
    
    // Skip UDP latency test - use socket ping instead
    results.quality = { latency: 0, jitter: 0, isWifi: false };
  } else {
    // Web version - test HTTP latency
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      try {
        // Use current origin if serverUrl is empty
        const testUrl = serverUrl ? serverUrl + '/health' : window.location.origin + '/health';
        log('Testing network to:', testUrl);
        await fetch(testUrl, { method: 'HEAD', cache: 'no-store' });
        const ping = performance.now() - start;
        log(`Ping ${i + 1}: ${ping}ms`);
        pings.push(ping);
      } catch (e) { 
        log(`Ping ${i + 1} failed:`, e);
        pings.push(999); 
      }
      await new Promise(r => setTimeout(r, 100));
    }
    const avgPing = pings.reduce((a, b) => a + b, 0) / pings.length;
    const jitterCalc = pings.length > 1 ? Math.sqrt(pings.map(p => Math.pow(p - avgPing, 2)).reduce((a, b) => a + b, 0) / pings.length) : 0;
    
    networkTestResults.latency = Math.round(avgPing);
    networkTestResults.jitter = Math.round(jitterCalc);
    results.quality = { latency: networkTestResults.latency, jitter: networkTestResults.jitter, isWifi: networkTestResults.isWifi };
  }
  
  // Wi-Fi 감지 (NetworkInformation API) - for both Tauri and web
  if (navigator.connection) {
    networkTestResults.isWifi = navigator.connection.type === 'wifi';
    results.quality.isWifi = networkTestResults.isWifi;
  }
  
  // 4. STUN 연결 테스트
  updateStatus('🌐 네트워크 테스트 중...');
  let testPc = null;
  try {
    testPc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    testPc.createDataChannel('test');
    await testPc.createOffer().then(o => testPc.setLocalDescription(o));
    
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { testPc?.close(); reject('timeout'); }, 5000);
      testPc.onicecandidate = (e) => {
        if (e.candidate?.type === 'srflx') {
          clearTimeout(timeout);
          results.network = true;
          resolve();
        }
      };
    });
    testPc.close();
  } catch { if (testPc) testPc.close(); results.network = false; }
  
  // 5. TURN 테스트 (P2P 실패 시에만)
  if (!results.network) {
    updateStatus('🔄 TURN 서버 테스트 중...');
    testPc = null;
    try {
      const turnCreds = await new Promise((resolve) => {
        socket.emit('get-turn-credentials', null, resolve);
        setTimeout(() => resolve(null), 3000);
      });
      
      const turnServer = turnCreds || { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' };
      
      testPc = new RTCPeerConnection({ 
        iceServers: [turnServer],
        iceTransportPolicy: 'relay'
      });
      testPc.createDataChannel('test');
      await testPc.createOffer().then(o => testPc.setLocalDescription(o));
      
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { testPc?.close(); reject('timeout'); }, 5000);
        testPc.onicecandidate = (e) => {
          if (e.candidate?.type === 'relay') {
            clearTimeout(timeout);
            results.turn = true;
            resolve();
          }
        };
      });
      testPc.close();
    } catch { if (testPc) testPc.close(); results.turn = false; }
  }
  
  updateStatus('테스트 완료');
  return results;
}

// 테스트 결과 표시
function showTestResults(results) {
  const el = $('test-results');
  if (!el) return;
  
  const q = results.quality;
  const qualityGrade = q ? (q.latency > 100 || q.jitter > 30 ? 'poor' : q.latency > 50 || q.jitter > 15 ? 'fair' : 'good') : 'unknown';
  const qualityLabel = { good: '좋음 ✓', fair: '보통 ⚠', poor: '불안정 ✗', unknown: '측정 실패' }[qualityGrade];
  const qualityColor = { good: '#2ed573', fair: '#ffa502', poor: '#ff4757', unknown: '#999' }[qualityGrade];
  
  // Connection status: direct (STUN) or relay (TURN)
  let connStatus, connClass;
  if (results.network) {
    connStatus = '✓ 직접 연결';
    connClass = 'pass';
  } else if (results.turn) {
    connStatus = '✓ TURN 릴레이';
    connClass = 'pass';
  } else {
    connStatus = '✗ 연결 실패';
    connClass = 'fail';
  }
  
  el.innerHTML = `
    <div class="test-item ${results.mic ? 'pass' : 'fail'}">🎤 마이크: ${results.mic ? '✓' : '✗'}</div>
    <div class="test-item ${results.speaker ? 'pass' : 'fail'}">🔊 스피커: ${results.speaker ? '✓' : '✗'}</div>
    <div class="test-item ${connClass}">🌐 서버 연결: ${connStatus}</div>
    ${results.natType ? `<div class="test-item pass">🔗 NAT 유형: ${results.natType}${results.natType === 'Symmetric' ? ' (P2P 제한)' : ' (P2P 가능)'}</div>` : ''}
    ${!results.network && results.turn ? '<div class="test-item warn">⚠️ 직접 연결 불가 - TURN 릴레이 사용 (지연 증가)</div>' : ''}
    ${!results.network && !results.turn ? '<div class="test-item fail">❌ 네트워크 차단됨 - 방화벽 확인 필요</div>' : ''}
    ${q ? `<div class="test-item" style="color:${qualityColor}">📡 네트워크: ${qualityLabel} (${q.latency}ms, 지터 ${q.jitter}ms)</div>` : ''}
    ${q?.isWifi ? '<div class="test-item warn">⚠️ Wi-Fi 감지 - 유선 연결 권장</div>' : ''}
    <button class="btn-small" onclick="$('test-results').classList.add('hidden')" style="margin-top:8px;">닫기</button>
  `;
  el.classList.remove('hidden');
  
  // 자동 지터 버퍼 추천
  if (q && autoJitter) {
    const recommended = Math.min(150, Math.max(30, q.latency + q.jitter * 2));
    setJitterBuffer(recommended);
    toast(`네트워크 상태에 맞게 버퍼 ${recommended}ms로 조정됨`, 'info');
  }
}

// 토스트 메시지 (from toast.js module)
// toast function is now global from toast.js

// ===== 테마 (from theme.js module) =====
const { initTheme, toggleTheme, updateThemeIcon } = window.StyxTheme || {};

// Opus SDP 최적화: FEC, DTX, 비트레이트 설정
function optimizeOpusSdp(sdp, mode) {
  const opusConfig = audioModes[mode];
  // Opus 파라미터 추가
  const params = [
    `maxaveragebitrate=${opusConfig.bitrate}`,
    `useinbandfec=${opusConfig.fec ? 1 : 0}`,
    `usedtx=${opusConfig.dtx ? 1 : 0}`,
    `stereo=${opusConfig.stereo ? 1 : 0}`,
    'maxplaybackrate=48000'
  ].join(';');
  
  return sdp.replace(
    /a=fmtp:111 (.+)/g,
    `a=fmtp:111 $1;${params}`
  );
}

// 오디오 설정 적용 (Opus 코덱) - Enhanced with bandwidth optimization
async function applyAudioSettings(pc) {
  const senders = pc.getSenders();
  const audioSender = senders.find(s => s.track?.kind === 'audio');
  if (!audioSender) return;

  const params = audioSender.getParameters();
  if (!params.encodings || !params.encodings.length) {
    params.encodings = [{}];
  }

  const mode = audioModes[audioMode];
  let bitrate = mode.bitrate;
  
  // Apply quality level multiplier
  if (currentQualityLevel !== 'auto') {
    bitrate = Math.round(bitrate * qualityLevels[currentQualityLevel].multiplier);
  } else {
    // Auto quality based on connection
    bitrate = getOptimalBitrate(mode.bitrate);
  }
  
  params.encodings[0].maxBitrate = bitrate;
  params.encodings[0].priority = 'high';
  params.encodings[0].networkPriority = 'high';
  
  try {
    await audioSender.setParameters(params);
    if (DEBUG) console.log(`Audio bitrate set to ${bitrate}bps (${currentQualityLevel})`);
  } catch (e) {
    log('오디오 파라미터 설정 실패:', e);
  }
}

// Get optimal bitrate based on connection quality
function getOptimalBitrate(baseBitrate) {
  if (peers.size === 0) return baseBitrate;
  
  let maxJitter = 0, maxLoss = 0;
  peers.forEach(peer => {
    if (peer.jitter > maxJitter) maxJitter = peer.jitter;
    if (peer.packetLoss > maxLoss) maxLoss = peer.packetLoss;
  });
  
  // Reduce bitrate on poor connections
  if (maxLoss > 5 || maxJitter > 50) {
    return Math.round(baseBitrate * 0.4); // 40% for very poor
  } else if (maxLoss > 2 || maxJitter > 25) {
    return Math.round(baseBitrate * 0.6); // 60% for poor
  } else if (maxLoss > 0.5 || maxJitter > 10) {
    return Math.round(baseBitrate * 0.8); // 80% for fair
  }
  
  return baseBitrate; // Full quality for good connections
}

// 모든 피어에 오디오 설정 적용
function applyAudioSettingsToAll() {
  peers.forEach(peer => applyAudioSettings(peer.pc));
}

// ===== 사운드 알림 (from sound.js module) =====
const { playSound, cleanupSound } = window.StyxSound || {};

// ===== 키보드 단축키 (from keyboard.js module) =====
const { initKeyboardShortcuts, initPttTouch, registerAction, addGlobalListener, cleanupGlobalListeners } = window.StyxKeyboard || {};

// ===== (즐겨찾기 제거됨) =====

// ===== 녹음 (from recording.js module) =====
const { startRecording, stopRecording, toggleRecording, cleanupRecording, addRecordingMarker } = window.StyxRecording || {};

// Expose globals for modules using getters (dynamic access) - consolidated
// Use try-catch to handle redefinition errors gracefully
const windowProps = {
  localStream: { get: () => localStream, configurable: true },
  peers: { get: () => peers, configurable: true },
  currentUser: { get: () => currentUser, configurable: true },
  isMuted: { get: () => isMuted, configurable: true },
  isRecording: { get: () => window.StyxRecording?.isRecording || false, configurable: true },
  pttMode: { get: () => pttMode, configurable: true },
  isPttActive: { get: () => isPttActive, set: (v) => isPttActive = v, configurable: true },
  pttKey: { get: () => pttKey, configurable: true },
  syncMode: { get: () => syncMode, set: (v) => syncMode = v, configurable: true },
  selfStats: { get: () => selfStats, configurable: true },
  peerLatencies: { get: () => peerLatencies, configurable: true },
  jitterBuffer: { get: () => jitterBuffer, configurable: true },
  actuallyTauri: { get: () => actuallyTauri, configurable: true },
  tauriInvoke: { get: () => tauriInvoke, configurable: true },
  socket: { get: () => socket, configurable: true }
};
// Define each property individually to avoid one failure breaking all
Object.keys(windowProps).forEach(key => {
  try {
    Object.defineProperty(window, key, windowProps[key]);
  } catch (e) {
    // Property already defined, skip
  }
});

// ===== 화면 공유 =====
let screenStream = null;
let isScreenSharing = false;

// Screen share WebRTC connections (separate from audio UDP)
// screenPeerConnections moved to top for error recovery

async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    isScreenSharing = true;
    
    const screenShareBtn = $('screenShareBtn');
    if (screenShareBtn) {
      screenShareBtn.classList.add('sharing');
      screenShareBtn.textContent = '🖥️ 공유 중';
    }
    
    // 로컬 미리보기
    const screenVideo = $('screen-share-video');
    if (screenVideo) screenVideo.srcObject = screenStream;
    const screenUser = $('screen-share-user');
    if (screenUser) screenUser.textContent = '내 화면 공유 중';
    $('screen-share-container')?.classList.remove('hidden');
    
    // 다른 피어들에게 화면 공유 시작 알림
    socket.emit('screen-share-start');
    
    // Create dedicated WebRTC connections for screen share
    const videoTrack = screenStream.getVideoTracks()[0];
    
    // For Tauri mode: create new WebRTC connections just for screen
    // For browser mode: use existing peer connections if available
    if (actuallyTauri) {
      // Create dedicated screen share connections
      peers.forEach((peer, peerId) => {
        createScreenShareConnection(peerId, videoTrack, true);
      });
    } else {
      // Browser mode: use existing peer connections
      peers.forEach((peer, id) => {
        if (peer.pc?.addTrack) {
          peer.pc.addTrack(videoTrack, screenStream);
          peer.pc.createOffer().then(offer => {
            peer.pc.setLocalDescription(offer);
            socket.emit('offer', { to: id, offer });
          });
        }
      });
    }
    
    // 공유 중지 감지
    videoTrack.onended = () => stopScreenShare();
    toast('화면 공유 시작', 'info');
  } catch (e) {
    if (e.name !== 'NotAllowedError') toast('화면 공유 실패: ' + e.message, 'error');
  }
}

// Create dedicated WebRTC connection for screen sharing
function createScreenShareConnection(peerId, videoTrack, initiator) {
  // Close existing screen connection if any
  if (screenPeerConnections.has(peerId)) {
    screenPeerConnections.get(peerId).close();
  }
  
  const pc = new RTCPeerConnection(rtcConfig);
  screenPeerConnections.set(peerId, pc);
  
  if (videoTrack) {
    pc.addTrack(videoTrack, screenStream);
  }
  
  pc.ontrack = (e) => {
    if (e.track.kind === 'video') {
      const screenVideo = $('screen-share-video');
      if (screenVideo) {
        screenVideo.srcObject = e.streams[0];
        screenVideo.style.display = '';
        const placeholder = $('screen-share-placeholder');
        if (placeholder) placeholder.style.display = 'none';
      }
    }
  };
  
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('screen-ice-candidate', { to: peerId, candidate: e.candidate });
    }
  };
  
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      log(`Screen share connection ${pc.connectionState} with ${peerId}`);
    }
  };
  
  if (initiator) {
    pc.createOffer().then(offer => {
      pc.setLocalDescription(offer);
      socket.emit('screen-offer', { to: peerId, offer });
    });
  }
  
  return pc;
}

function stopScreenShare() {
  if (!isScreenSharing) return;
  
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }
  
  // Close all screen share WebRTC connections
  screenPeerConnections.forEach(pc => {
    try { pc.close(); } catch {}
  });
  screenPeerConnections.clear();
  
  isScreenSharing = false;
  const screenShareBtn = $('screenShareBtn');
  if (screenShareBtn) {
    screenShareBtn.classList.remove('sharing');
    screenShareBtn.textContent = '🖥️';
  }
  $('screen-share-container')?.classList.add('hidden');
  const screenVideo = $('screen-share-video');
  if (screenVideo) screenVideo.srcObject = null;
  
  socket.emit('screen-share-stop');
  toast('화면 공유 종료', 'info');
}

// 다른 사용자의 화면 공유 수신
socket.on('screen-share-start', ({ userId, username }) => {
  const screenUser = $('screen-share-user');
  if (screenUser) screenUser.textContent = `${username}님의 화면`;
  $('screen-share-container')?.classList.remove('hidden');
  
  // Tauri 앱에서도 WebRTC로 화면 공유 수신 가능
  // (WebRTC connection will be created when screen-offer is received)
});

socket.on('screen-share-stop', () => {
  if (!isScreenSharing) {
    $('screen-share-container')?.classList.add('hidden');
    const screenVideo = $('screen-share-video');
    if (screenVideo) screenVideo.srcObject = null;
    // Close screen share connections
    screenPeerConnections.forEach(pc => {
      try { pc.close(); } catch {}
    });
    screenPeerConnections.clear();
  }
});

// Screen share WebRTC signaling
socket.on('screen-offer', async ({ from, offer }) => {
  try {
    log('Received screen-offer from', from);
    const pc = createScreenShareConnection(from, null, false);
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('screen-answer', { to: from, answer });
  } catch (e) {
    console.error('Screen offer handling failed:', e);
  }
});

socket.on('screen-answer', async ({ from, answer }) => {
  try {
    log('Received screen-answer from', from);
    const pc = screenPeerConnections.get(from);
    if (pc) {
      await pc.setRemoteDescription(answer);
    }
  } catch (e) {
    console.error('Screen answer handling failed:', e);
  }
});

socket.on('screen-ice-candidate', async ({ from, candidate }) => {
  const pc = screenPeerConnections.get(from);
  if (pc) {
    try {
      await pc.addIceCandidate(candidate);
    } catch (e) {
      console.warn('Failed to add screen ICE candidate:', e);
    }
  }
});

$('screenShareBtn')?.addEventListener('click', () => {
  isScreenSharing ? stopScreenShare() : startScreenShare();
});

$('screen-share-close')?.addEventListener('click', () => {
  if (isScreenSharing) stopScreenShare();
  else $('screen-share-container')?.classList.add('hidden');
});

const authPanel = $('auth');
const lobby = $('lobby');
const adminPanel = $('admin-panel');
const roomView = $('room-view');
const usersGrid = $('users-grid');
const chatMessages = $('chat-messages');

// 오프라인 감지
window.addEventListener('online', () => {
  isOnline = true;
  toast('인터넷 연결됨', 'success');
  // 자동 재입장 시도
  if (lastRoom && currentUser && !socket.room) {
    toast('방에 재입장 시도 중...', 'info');
    setTimeout(() => autoRejoin(), 1000);
  }
});

window.addEventListener('offline', () => {
  isOnline = false;
  toast('인터넷 연결 끊김', 'error', 5000);
});

// 네트워크 변경 감지 (WiFi ↔ 유선 전환 등)
if (navigator.connection) {
  navigator.connection.addEventListener('change', () => {
    if (socket.room && peers.size > 0) {
      toast('네트워크 변경 감지, 재연결 중...', 'info');
      peers.forEach(peer => {
        try { if (peer.pc?.restartIce) peer.pc.restartIce(); } catch {}
      });
    }
  });
}

// 자동 재입장
async function autoRejoin() {
  if (!lastRoom || !currentUser || !isOnline) return;
  
  try {
    // Cleanup previous audio state
    cleanupAudio();
    
    // Get audio stream for Tauri
    if (actuallyTauri) {
      socket.emit('join', { room: lastRoom, username: currentUser.username, password: lastRoomPassword }, async (res) => {
        if (res.error) {
          toast('재입장 실패: ' + res.error, 'error');
          lastRoom = null;
        } else {
          toast('방에 재입장했습니다', 'success');
          socket.room = lastRoom;
          // Restart UDP
          try {
            await startUdpMode();
          } catch (udpError) {
            console.error('UDP 재시작 실패:', udpError);
          }
          startLatencyPing();
        }
      });
    } else {
      // Browser: spectator mode
      socket.emit('join', { room: lastRoom, username: currentUser.username, password: lastRoomPassword }, res => {
        if (res.error) {
          toast('재입장 실패: ' + res.error, 'error');
          lastRoom = null;
        } else {
          toast('방에 재입장했습니다 (관전 모드)', 'success');
          socket.room = lastRoom;
          startLatencyPing();
        }
      });
    }
  } catch (e) {
    console.error('재입장 실패:', e);
    toast('재입장 실패', 'error');
  }
}

// 소켓 연결 후 세션 복구 시도
socket.on('connect', () => {
  log('서버 연결됨');
  $('connection-status')?.classList.remove('offline');
  
  // 서버 시간 동기화 (메트로놈용)
  syncServerTime();
  
  // TURN 자격증명 업데이트
  updateTurnCredentials();
  
  // Initialize sync module socket handlers
  if (initSyncSocketHandlers) initSyncSocketHandlers();
  
  // 세션 복구 (최초 연결 시에만)
  if (!sessionRestored) {
    sessionRestored = true;
    // Check localStorage first, then sessionStorage
    const savedUser = localStorage.getItem('styx-user') || sessionStorage.getItem('styx-user');
    const savedToken = localStorage.getItem('styx-token') || sessionStorage.getItem('styx-token');
    
    if (savedUser && savedToken) {
      socket.emit('restore-session', { username: savedUser, token: savedToken }, res => {
        if (res && res.success) {
          currentUser = res.user;
          showLobby();
          // URL에서 방 정보 확인
          checkInviteLink();
          // Check for pending deep link room
          checkPendingDeepLink();
        } else {
          // Only clear if server explicitly rejected (not on timeout/error)
          if (res && res.error) {
            log('Session restore failed:', res.error);
            localStorage.removeItem('styx-user');
            localStorage.removeItem('styx-token');
            sessionStorage.removeItem('styx-user');
            sessionStorage.removeItem('styx-token');
          } else {
            // Retry on next connect if no response
            sessionRestored = false;
          }
        }
      });
    }
  }
  
  // 방에 있었다면 재입장 시도
  if (currentUser && lastRoom && !socket.room) {
    autoRejoin();
  }
});

// 서버 시간 동기화 (NTP 방식)
function syncServerTime() {
  const samples = [];
  const takeSample = () => {
    const t0 = Date.now();
    socket.emit('time-sync', t0, (serverTime) => {
      const t1 = Date.now();
      const rtt = t1 - t0;
      const offset = serverTime - t0 - (rtt / 2);
      samples.push({ offset, rtt });
      
      if (samples.length < 5) {
        setTimeout(takeSample, 100);
      } else {
        // RTT가 가장 낮은 샘플의 offset 사용 (가장 정확)
        samples.sort((a, b) => a.rtt - b.rtt);
        serverTimeOffset = samples[0].offset;
        log('서버 시간 오프셋:', serverTimeOffset, 'ms');
      }
    });
  };
  takeSample();
}

// 서버 시간 기준으로 현재 시간 반환
function getServerTime() {
  return Date.now() + serverTimeOffset;
}

socket.on('disconnect', () => {
  log('서버 연결 끊김');
  $('connection-status')?.classList.add('offline');
  toast('서버 연결 끊김, 재연결 시도 중...', 'warning');
  // 소켓 룸 상태 초기화 (재연결 시 rejoin 트리거)
  socket.room = null;
});

socket.on('error', (data) => {
  toast(data.message || '서버 오류', 'error');
});

// 서버 종료 알림
socket.on('server-shutdown', () => {
  toast('서버가 종료됩니다. 잠시 후 재연결됩니다.', 'warning', 5000);
});

// 재연결 시 방 자동 재입장
socket.io.on('reconnect', () => {
  log('서버 재연결됨');
  hideReconnectProgress();
  toast('서버 재연결됨', 'success');
  
  // TURN 자격증명 갱신
  updateTurnCredentials();
  
  // 세션 복구 후 방 재입장
  const savedUser = localStorage.getItem('styx-user') || sessionStorage.getItem('styx-user');
  const savedToken = localStorage.getItem('styx-token') || sessionStorage.getItem('styx-token');
  
  if (savedUser && savedToken && lastRoom) {
    socket.emit('restore-session', { username: savedUser, token: savedToken }, res => {
      if (res.success) {
        currentUser = res.user;
        // 방에 있었다면 자동 재입장
        if (lastRoom && roomView && !roomView.classList.contains('hidden')) {
          toast('방에 재입장 중...', 'info');
          autoRejoin();
        }
      }
    });
  }
});

// 초대 링크 확인 (URL params)
function checkInviteLink() {
  const params = new URLSearchParams(window.location.search);
  const inviteRoom = params.get('room');
  if (inviteRoom && currentUser) {
    toast(`"${inviteRoom}" 방으로 초대됨`, 'info');
    setTimeout(() => joinRoom(inviteRoom, false), 500);
    window.history.replaceState({}, '', window.location.pathname);
  }
}

// Check for pending deep link room (saved before login)
function checkPendingDeepLink() {
  const pendingRoom = sessionStorage.getItem('pendingRoom');
  if (pendingRoom && currentUser) {
    const password = sessionStorage.getItem('pendingPassword');
    sessionStorage.removeItem('pendingRoom');
    sessionStorage.removeItem('pendingPassword');
    toast(`"${pendingRoom}" 방으로 초대됨`, 'info');
    setTimeout(() => joinRoom(pendingRoom, !!password, password), 500);
  }
}

// Deep link handler for Tauri (styx://join/roomName)
if (actuallyTauri) {
  const setupDeepLink = () => {
    window.__TAURI__?.event?.listen('deep-link', (event) => {
      const url = event.payload;
      log('Deep link received:', url);
      
      // Parse styx://join/roomName or styx://join/roomName?password=xxx
      const match = url.match(/styx:\/\/join\/([^?]+)(\?password=(.+))?/);
      if (match) {
        const roomName = decodeURIComponent(match[1]);
        const password = match[3] ? decodeURIComponent(match[3]) : null;
        
        if (currentUser) {
          toast(`"${roomName}" 방으로 초대됨`, 'info');
          setTimeout(() => joinRoom(roomName, !!password, password), 500);
        } else {
          // Save for after login
          sessionStorage.setItem('pendingRoom', roomName);
          if (password) sessionStorage.setItem('pendingPassword', password);
          toast('로그인 후 방에 입장합니다', 'info');
        }
      }
    });
  };
  if (window.__TAURI__?.event) setupDeepLink();
  else setTimeout(setupDeepLink, 100);
}

// 초대 링크 생성
function createInviteLink() {
  const roomName = $('roomName')?.textContent;
  if (!roomName) return;
  
  // Generate both web URL and deep link
  const baseUrl = serverUrl || window.location.origin;
  const webUrl = `${baseUrl}/join/${encodeURIComponent(roomName)}`;
  const deepLink = `styx://join/${encodeURIComponent(roomName)}`;
  
  // Copy deep link for Tauri users, web URL as fallback info
  const inviteText = actuallyTauri 
    ? deepLink 
    : `${webUrl}\n\n데스크톱 앱: ${deepLink}`;
  
  navigator.clipboard.writeText(inviteText).then(() => {
    toast('초대 링크가 복사되었습니다', 'success');
  }).catch(() => {
    prompt('초대 링크:', inviteText);
  });
}

socket.on('kicked', () => { 
  toast('방에서 강퇴되었습니다', 'error'); 
  leaveRoom();
});

socket.on('room-closed', () => {
  toast('관리자가 방을 닫았습니다', 'warning');
  leaveRoom();
});

// 관리자: 방 닫기
function closeRoom() {
  const roomName = $('roomName')?.textContent;
  if (!roomName) return;
  
  if (confirm(`"${roomName}" 방을 닫으시겠습니까? 모든 사용자가 퇴장됩니다.`)) {
    socket.emit('close-room', { roomName }, res => {
      if (res.error) {
        toast(res.error, 'error');
      }
    });
  }
}

// 로그인/회원가입 탭
document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $('login-form').classList.toggle('hidden', tab.dataset.tab !== 'login');
    $('signup-form').classList.toggle('hidden', tab.dataset.tab !== 'signup');
  };
});

// Enter 키
$('login-user').onkeypress = $('login-pass').onkeypress = (e) => { if (e.key === 'Enter') $('loginBtn').click(); };
$('signup-user').onkeypress = $('signup-pass').onkeypress = (e) => { if (e.key === 'Enter') $('signupBtn').click(); };

// 로그인
$('loginBtn').onclick = () => {
  const username = $('login-user').value.trim();
  const password = $('login-pass').value;
  if (!username || !password) return showAuthMsg('사용자명과 비밀번호를 입력하세요', true);

  $('loginBtn').disabled = true;
  socket.emit('login', { username, password }, res => {
    $('loginBtn').disabled = false;
    if (res.error) {
      const errorMsg = {
        'Invalid credentials': '사용자명 또는 비밀번호가 틀렸습니다',
        'Account pending approval': '승인 대기 중입니다'
      }[res.error] || res.error;
      return showAuthMsg(errorMsg, true);
    }
    currentUser = res.user;
    // Save credentials only if "remember me" is checked
    if ($('remember-me')?.checked) {
      localStorage.setItem('styx-user', username);
      localStorage.setItem('styx-token', res.token);
    } else {
      // Use sessionStorage for current session only
      sessionStorage.setItem('styx-user', username);
      sessionStorage.setItem('styx-token', res.token);
      localStorage.removeItem('styx-user');
      localStorage.removeItem('styx-token');
    }
    addSystemLog(`User login: ${username} (Admin: ${res.user.isAdmin})`);
    showLobby();
  });
};

// 회원가입
$('signupBtn').onclick = () => {
  const username = $('signup-user').value.trim();
  const password = $('signup-pass').value;
  if (!username || !password) return showAuthMsg('사용자명과 비밀번호를 입력하세요', true);

  $('signupBtn').disabled = true;
  socket.emit('signup', { username, password }, res => {
    $('signupBtn').disabled = false;
    if (res.error) {
      const errorMsg = {
        'Username taken': '이미 사용 중인 사용자명입니다',
        'Invalid username (2-20자, 영문/숫자/한글/_)': '사용자명: 2-20자, 영문/숫자/한글/_만 가능',
        'Invalid password (4-50자)': '비밀번호: 4-50자'
      }[res.error] || res.error;
      return showAuthMsg(errorMsg, true);
    }
    showAuthMsg('가입 요청 완료. 관리자 승인을 기다려주세요.', false);
    toast('가입 요청이 전송되었습니다', 'success');
  });
};

function showAuthMsg(msg, isError) {
  const el = $('auth-msg');
  el.textContent = msg;
  el.className = isError ? 'error' : 'success';
}

async function showLobby() {
  authPanel.classList.add('hidden');
  lobby.classList.remove('hidden');
  
  // Auto-optimize settings after successful login
  setTimeout(autoDetectOptimalSettings, 1000);
  const usernameEl = $('my-username');
  if (usernameEl) usernameEl.textContent = currentUser.username;
  
  const avatarEl = $('my-avatar');
  if (avatarEl) avatarEl.style.backgroundImage = currentUser.avatar ? `url(${avatarUrl(currentUser.avatar)})` : '';
  if (currentUser.isAdmin) {
    // 웹에서만 관리자 버튼 표시
    if (!actuallyTauri) {
      $('adminBtn').classList.remove('hidden');
      // 관리자 알림 시작
      setTimeout(updateAdminNotifications, 1000);
      if (!adminNotificationInterval) {
        adminNotificationInterval = setInterval(updateAdminNotifications, 30000);
      }
    }
  }
  
  // 서버에서 설정 로드
  socket.emit('get-settings', null, res => {
    if (res?.settings) applySettings(res.settings);
    initStabilitySettings();
  });
  
  await loadAudioDevices();
  loadRoomList();
  
  // Listen for audio device changes - auto-reconnect
  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', async () => {
      log('[AUDIO] Device change detected');
      const oldDevices = await loadAudioDevices();
      
      // If in room with active stream, attempt reconnect
      if (socket.room && localStream) {
        toast('🔌 오디오 장치 변경 - 재연결 중...', 'info');
        try {
          await reconnectAudioDevices();
          toast('✅ 오디오 장치 재연결 완료', 'success');
        } catch (e) {
          console.error('Device reconnect failed:', e);
          toast('⚠️ 오디오 재연결 실패 - 수동으로 장치를 선택하세요', 'error');
        }
      }
    });
  }
  
  // 새로고침 후 자동 재입장
  if (lastRoom) {
    setTimeout(() => joinRoom(lastRoom, !!lastRoomPassword, lastRoomPassword), 500);
  }
}

// Reconnect audio devices without leaving room
let reconnectingDevices = false;
async function reconnectAudioDevices() {
  if (!localStream || reconnectingDevices) return;
  reconnectingDevices = true;
  
  try {
    // Stop old tracks
    localStream.getTracks().forEach(t => t.stop());
    if (localStream._rawStream) {
      localStream._rawStream.getTracks().forEach(t => t.stop());
    }
    
    // Reset audio contexts
    if (sharedAudioContext && sharedAudioContext.state !== 'closed') {
      try { sharedAudioContext.close(); } catch {}
    }
    sharedAudioContext = null;
    
    await new Promise(r => setTimeout(r, 100));
    
    // Get new stream with current device settings
    const inputDevice = $('audio-device')?.value || undefined;
    const constraints = {
      audio: {
        deviceId: inputDevice ? { exact: inputDevice } : undefined,
        sampleRate: SAMPLE_RATE,
        channelCount: 2,
        echoCancellation: $('echo-cancel')?.checked ?? true,
        noiseSuppression: $('noise-suppress')?.checked ?? true,
        autoGainControl: $('auto-gain')?.checked ?? false
      }
    };
    
    const rawStream = await navigator.mediaDevices.getUserMedia(constraints);
    processedStream = await createProcessedInputStream(rawStream);
    localStream = processedStream;
    localStream._rawStream = rawStream;
    
    // Restart Tauri UDP if active
    if (actuallyTauri && udpStreamActive) {
      await tauriInvoke('udp_stop_stream').catch(e => { if (DEBUG) console.debug('Silent error:', e); });
      await startUdpMode();
    }
    
    // Update input meter
    startInputMeter();
  } catch (e) {
    console.error('Audio device reconnect failed:', e);
    toast('오디오 장치 재연결 실패', 'error');
  } finally {
    reconnectingDevices = false;
  }
}

// 안정성 설정 초기화
function initStabilitySettings() {
  // Tauri 앱이면 오디오 설정 표시, 웹이면 다운로드 배너 표시
  if (actuallyTauri) {
    const tauriSettings = $('tauri-settings');
    if (tauriSettings) tauriSettings.style.display = 'block';
    initTauriFeatures();
  } else {
    // 웹 브라우저: 오디오 설정 숨기고 다운로드 배너 표시
    $('audio-settings-section')?.classList.add('hidden');
    $('web-download-banner')?.classList.remove('hidden');
  }
  
  // 관리자 기능 접근 제어 적용
  hideAdminFeaturesInTauri();
  
  // Professional UI enhancements 초기화
  initUIEnhancements();
  
  // 지터 버퍼 슬라이더
  const slider = $('jitter-slider');
  const valueLabel = $('jitter-value');
  if (slider) {
    slider.value = jitterBuffer;
    valueLabel.textContent = jitterBuffer + 'ms';
    slider.oninput = () => {
      jitterBuffer = parseInt(slider.value);
      valueLabel.textContent = jitterBuffer + 'ms';
      localStorage.setItem('styx-jitter-buffer', jitterBuffer);
      scheduleSettingsSave();
    };
  }
  
  // 자동 적응
  const autoCheck = $('auto-adapt');
  if (autoCheck) {
    autoCheck.checked = autoAdapt;
    autoCheck.onchange = () => {
      autoAdapt = autoCheck.checked;
      localStorage.setItem('styx-auto-adapt', autoAdapt);
      scheduleSettingsSave();
    };
  }
  
  // 에코 제거
  const echoCheck = $('echo-cancel');
  if (echoCheck) {
    echoCheck.checked = echoCancellation;
    echoCheck.onchange = () => {
      echoCancellation = echoCheck.checked;
      localStorage.setItem('styx-echo', echoCancellation);
      scheduleSettingsSave();
    };
  }
  
  // 노이즈 억제
  const noiseCheck = $('noise-suppress');
  if (noiseCheck) {
    noiseCheck.checked = noiseSuppression;
    noiseCheck.onchange = () => {
      noiseSuppression = noiseCheck.checked;
      localStorage.setItem('styx-noise', noiseSuppression);
      scheduleSettingsSave();
    };
  }
  
  // AI 노이즈 제거
  const aiNoiseCheck = $('ai-noise');
  if (aiNoiseCheck) {
    aiNoiseCheck.checked = aiNoiseCancellation;
    aiNoiseCheck.onchange = () => {
      aiNoiseCancellation = aiNoiseCheck.checked;
      localStorage.setItem('styx-ai-noise', aiNoiseCancellation);
      scheduleSettingsSave();
    };
  }
  
  // PTT 모드
  const pttCheck = $('ptt-mode');
  if (pttCheck) {
    pttCheck.checked = pttMode;
    pttCheck.onchange = () => {
      pttMode = pttCheck.checked;
      localStorage.setItem('styx-ptt', pttMode);
      scheduleSettingsSave();
      toast(pttMode ? '눌러서 말하기: Space 키를 누르고 말하세요' : '눌러서 말하기 해제', 'info');
    };
  }
  
  // VAD 설정
  const vadCheck = $('vad-mode');
  if (vadCheck) {
    vadCheck.checked = vadEnabled;
    vadCheck.onchange = () => {
      vadEnabled = vadCheck.checked;
      localStorage.setItem('styx-vad', vadEnabled);
      scheduleSettingsSave();
    };
  }
  
  // 덕킹 설정
  const duckCheck = $('ducking-mode');
  if (duckCheck) {
    duckCheck.checked = duckingEnabled;
    duckCheck.onchange = () => {
      duckingEnabled = duckCheck.checked;
      localStorage.setItem('styx-ducking', duckingEnabled);
      scheduleSettingsSave();
    };
  }
  
  // 입력 모니터링 설정
  const monitorCheck = $('input-monitor');
  if (monitorCheck) {
    monitorCheck.checked = inputMonitorEnabled;
    monitorCheck.onchange = () => toggleInputMonitor(monitorCheck.checked);
  }
  
  // 튜너 설정
  const tunerCheck = $('tuner-toggle');
  if (tunerCheck) {
    tunerCheck.onchange = () => toggleTuner(tunerCheck.checked);
  }
}

// Tauri 기능 초기화
let udpPort = null;

async function initTauriFeatures() {
  if (!actuallyTauri) return;
  
  try {
    // 오디오 호스트 목록 로드
    const hosts = await tauriInvoke('get_audio_hosts');
    const hostSelect = $('tauri-audio-host');
    if (hostSelect && hosts.length) {
      hostSelect.innerHTML = hosts.map(h => `<option value="${h}">${h}</option>`).join('');
      if ($('tauri-audio-row')) $('tauri-audio-row').style.display = 'flex';
    }
    
    // 오디오 장치 목록 로드
    const devices = await tauriInvoke('get_audio_devices');
    log('Tauri 오디오 장치:', devices);
    
    // ASIO 사용 가능 여부 확인
    const asioAvailable = await tauriInvoke('check_asio');
    if (asioAvailable) {
      toast('ASIO 드라이버 감지됨 - 저지연 모드 활성화', 'success');
      const hintEl = $('tauri-audio-hint');
      if (hintEl) hintEl.textContent = 'ASIO 사용 가능 - 저지연 모드';
    }
    
    // 오디오 정보 가져오기
    const audioInfo = await tauriInvoke('get_audio_info');
    log('Tauri 오디오 정보:', audioInfo);
    
    // 버퍼 크기 초기화
    const savedBufferSize = localStorage.getItem('styx-buffer-size') || '480';
    const bufferSelect = $('buffer-size-select');
    if (bufferSelect) {
      bufferSelect.value = savedBufferSize;
      await tauriInvoke('set_buffer_size', { size: parseInt(savedBufferSize) }).catch(e => { if (DEBUG) console.debug('Silent error:', e); });
      bufferSelect.onchange = async (e) => {
        const size = parseInt(e.target.value);
        localStorage.setItem('styx-buffer-size', size);
        const result = await tauriInvoke('set_buffer_size', { size });
        if ($('buffer-size-value')) $('buffer-size-value').textContent = `${size} (${(size/48).toFixed(1)}ms)`;
        toast(`버퍼 크기: ${size} 샘플 - 재시작 시 적용`, 'info');
      };
    }
    
    // 비트레이트 UI 표시 및 초기화
    if ($('bitrate-section')) $('bitrate-section').style.display = 'flex';
    const savedBitrate = localStorage.getItem('styx-bitrate') || '96';
    if ($('bitrate-select')) {
      $('bitrate-select').value = savedBitrate;
      $('bitrate-select').onchange = async (e) => {
        const bitrate = parseInt(e.target.value);
        localStorage.setItem('styx-bitrate', bitrate);
        await tauriInvoke('set_bitrate', { bitrateKbps: bitrate });
        toast(`음질 변경: ${bitrate}kbps`, 'info');
      };
    }
    await tauriInvoke('set_bitrate', { bitrateKbps: parseInt(savedBitrate) });
  } catch (e) {
    console.error('Tauri 초기화 오류:', e);
  }
}

// UDP 릴레이 모드 (항상 서버 릴레이 사용)
const UDP_RELAY_PORT = 5000;
let startingUdp = false;

async function startUdpMode() {
  if (!actuallyTauri || startingUdp) {
    if (!actuallyTauri) console.warn('Tauri not available, skipping UDP mode');
    return;
  }
  startingUdp = true;
  
  try {
    log('Starting UDP mode...');
    
    // Detect NAT type for P2P
    await detectNatType();
    
    // Stop any existing stream first
    try {
      await tauriInvoke('udp_stop_stream');
      await new Promise(r => setTimeout(r, 100)); // Wait for cleanup
    } catch (e) { /* ignore */ }
    
    udpPort = await tauriInvoke('udp_bind', { port: 0 });
    log('UDP 포트 바인딩:', udpPort);
    
    // Always use relay server (simpler, works for everyone)
    let relayHost = serverUrl ? new URL(serverUrl).hostname : window.location.hostname;
    
    // Convert nip.io hostname to IP for Rust SocketAddr parsing
    if (relayHost === '3-39-223-2.nip.io') {
      relayHost = '3.39.223.2';
    }
    
    const mySessionId = socket.id;
    
    log('UDP relay debug:', { serverUrl, relayHost, UDP_RELAY_PORT, mySessionId });
    
    // Try UDP first
    let udpSuccess = false;
    try {
      log('Setting UDP relay...');
      await tauriInvoke('udp_set_relay', { host: relayHost, port: UDP_RELAY_PORT, sessionId: mySessionId });
      log('✅ UDP relay set');
      
      log('Binding to room...');
      socket.emit('udp-bind-room', { sessionId: mySessionId, roomId: socket.room });
      log('✅ Room binding sent');
      
      log('Setting audio devices...');
      await tauriInvoke('set_audio_devices', { input: null, output: null });
      log('✅ Audio devices set');
      
      log('Starting relay stream...');
      
      await tauriInvoke('udp_start_relay_stream');
      log('✅ UDP relay stream started successfully');
      
      // Apply optional audio settings
      await tauriInvoke('set_dtx_enabled', { enabled: dtxEnabled }).catch(e => { if (DEBUG) console.debug('Silent error:', e); });
      await tauriInvoke('set_comfort_noise', { enabled: comfortNoiseEnabled }).catch(e => { if (DEBUG) console.debug('Silent error:', e); });
      
      // Wait a moment before starting stats monitor
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      udpSuccess = true;
      toast('UDP 오디오 연결됨', 'success');
      startUdpStatsMonitor(); // Enable for adaptive bitrate
      log('✅ UDP setup complete');
    } catch (e) {
      console.error('UDP 실패, TCP 폴백:', e);
      toast(`UDP 연결 실패: ${e.message || e}`, 'warning');
    }
    
    // Fallback to TCP if UDP fails
    if (!udpSuccess) {
      useTcpFallback = true;
      socket.emit('tcp-bind-room', { roomId: socket.room });
      startTcpAudioStream();
      toast('TCP 오디오 연결됨 (폴백)', 'info');
    }
  } catch (e) {
    console.error('오디오 시작 실패:', e);
    toast(`오디오 연결 실패: ${e.message || e}`, 'error');
    
    // Force TCP fallback on any error
    try {
      useTcpFallback = true;
      socket.emit('tcp-bind-room', { roomId: socket.room });
      startTcpAudioStream();
      toast('TCP 오디오 연결됨 (폴백)', 'info');
    } catch (tcpError) {
      console.error('TCP 폴백도 실패:', tcpError);
      toast('모든 오디오 연결 실패', 'error');
    }
  } finally {
    startingUdp = false;
  }
}

// TCP 폴백 오디오 스트림
let useTcpFallback = false;

function startTcpAudioStream() {
  if (!actuallyTauri) return;
  
  // TCP 오디오 수신 핸들러 (한 번만 등록)
  if (!tcpHandlerRegistered) {
    socket.on('tcp-audio', async (senderId, audioData) => {
      try {
        await tauriInvoke('tcp_receive_audio', { senderId, data: Array.from(new Uint8Array(audioData)) });
      } catch (e) { console.error('TCP 오디오 수신 실패:', e); }
    });
    tcpHandlerRegistered = true;
  }
  
  // TCP 오디오 송신 (10ms 간격)
  if (tcpAudioInterval) clearInterval(tcpAudioInterval);
  tcpAudioInterval = setInterval(async () => {
    try {
      const audioData = await tauriInvoke('tcp_get_audio');
      if (audioData && audioData.length > 0) {
        socket.emit('tcp-audio', new Uint8Array(audioData).buffer);
      }
    } catch (e) { /* 무시 - 오디오 없을 수 있음 */ }
  }, 10);
}

function stopTcpAudioStream() {
  if (tcpAudioInterval) {
    clearInterval(tcpAudioInterval);
    tcpAudioInterval = null;
  }
  socket.off('tcp-audio');
  tcpHandlerRegistered = false;
  useTcpFallback = false;
  udpHealthFailCount = 0;
}

// UDP 음소거 연동
async function setUdpMuted(muted) {
  if (actuallyTauri) {
    try {
      await tauriInvoke('udp_set_muted', { muted });
    } catch (e) { console.error('UDP 음소거 설정 실패:', e); }
  }
}

// 방 퇴장 시 오디오 정리
async function cleanupAudio() {
  stopUdpStatsMonitor();
  stopTcpAudioStream();
  if (actuallyTauri) {
    try {
      await tauriInvoke('udp_stop_stream');
    } catch (e) { console.error('오디오 정리 실패:', e); }
  }
  udpPort = null;
}

// UDP 연결 품질 모니터링
let currentBitrate = 96; // Default bitrate in kbps
let lastPacketLoss = 0;

function startUdpStatsMonitor() {
  if (!tauriInvoke || udpStatsInterval) return;
  
  log('Starting UDP stats monitor...');
  
  udpStatsInterval = setInterval(async () => {
    try {
      const stats = await tauriInvoke('get_udp_stats');
      if (stats) {
        updateUdpStatsUI(stats);
        
        // Get max bitrate from room settings
        const maxBitrate = currentRoomSettings.bitrate || 128;
        
        // Adaptive bitrate based on packet loss
        if (stats.loss_rate > 5 && currentBitrate > 48) {
          // High packet loss - reduce bitrate
          currentBitrate = Math.max(48, currentBitrate - 16);
          await tauriInvoke('set_bitrate', { bitrateKbps: currentBitrate });
          log(`[ADAPTIVE] Reduced bitrate to ${currentBitrate}kbps (loss: ${stats.loss_rate.toFixed(1)}%)`);
        } else if (stats.loss_rate < 1 && currentBitrate < maxBitrate) {
          // Low packet loss - increase bitrate (faster when loss = 0)
          const increment = stats.loss_rate === 0 ? 16 : 8;
          currentBitrate = Math.min(maxBitrate, currentBitrate + increment);
          await tauriInvoke('set_bitrate', { bitrateKbps: currentBitrate });
        }
        lastPacketLoss = stats.loss_rate;
        
        // Health check: if no packets received for 5 seconds, switch to TCP
        if (stats.is_running && stats.packets_received === 0) {
          udpHealthFailCount++;
          if (udpHealthFailCount >= 5 && !useTcpFallback) {
            console.warn('UDP 연결 끊김, TCP로 전환');
            toast('UDP 연결 끊김, TCP로 전환 중...', 'warning');
            await tauriInvoke('udp_stop_stream');
            useTcpFallback = true;
            socket.emit('tcp-bind-room', { roomId: socket.room });
            startTcpAudioStream();
          }
        } else {
          udpHealthFailCount = 0;
        }
      }
      
      // Per-peer stats
      try {
        const peerStats = await tauriInvoke('get_peer_stats');
        if (peerStats) updatePeerStatsUI(peerStats);
      } catch (peerError) {
        // Silently ignore peer stats errors
      }
    } catch (e) {
      console.error('UDP 통계 조회 실패:', e);
    }
  }, 1000); // Check every second for adaptive bitrate
}

function stopUdpStatsMonitor() {
  if (udpStatsInterval) {
    clearInterval(udpStatsInterval);
    udpStatsInterval = null;
  }
}

function updateUdpStatsUI(stats) {
  const badge = $('udp-stats-badge');
  if (!badge || !stats) return;
  
  badge.classList.remove('hidden');
  
  if (!stats.is_running) {
    badge.textContent = 'UDP: 대기';
    badge.className = 'stats-badge idle';
    return;
  }
  
  const lossRate = (stats.loss_rate || 0).toFixed(1);
  const bufferMs = (stats.jitter_buffer_size || 0) * 10; // 10ms per frame
  const targetMs = ((stats.jitter_buffer_target || stats.jitter_buffer_size) || 0) * 10;
  let quality = 'good';
  if (stats.loss_rate > 5) quality = 'bad';
  else if (stats.loss_rate > 1) quality = 'warning';
  
  badge.textContent = `UDP: ${stats.peer_count}명 | 손실 ${lossRate}% | 버퍼 ${bufferMs}/${targetMs}ms`;
  badge.className = `stats-badge ${quality}`;
}

function updatePeerStatsUI(peerStats) {
  if (!peerStats || !peerStats.length) return;
  
  // Update each peer's card with UDP stats
  for (const ps of peerStats) {
    document.querySelectorAll('.user-card .latency').forEach(el => {
      const card = el.closest('.user-card');
      if (!card) return;
      
      const loss = ps.loss_rate.toFixed(1);
      const level = Math.round(ps.audio_level * 100);
      el.textContent = `손실 ${loss}% | 레벨 ${level}%`;
      el.style.color = ps.loss_rate > 5 ? '#f44' : ps.loss_rate > 1 ? '#fa0' : '#4f4';
    });
  }
}

// 오디오 모드 설정
window.setAudioMode = (mode) => {
  audioMode = mode;
  localStorage.setItem('styx-audio-mode', mode);
  applyAudioSettingsToAll();
  scheduleSettingsSave();
  toast(`${audioModes[mode].name} 모드로 변경됨`, 'info');
};

$('logoutBtn').onclick = () => {
  if (adminNotificationInterval) { clearInterval(adminNotificationInterval); adminNotificationInterval = null; }
  localStorage.removeItem('styx-user');
  localStorage.removeItem('styx-token');
  location.reload();
};

// 오디오 장치 로드 (입력 + 출력)
async function loadAudioDevices() {
  const inputSelect = $('audio-device');
  const outputSelect = $('audio-output');
  
  if (!inputSelect) return;
  
  // HTTP에서는 mediaDevices가 없음 (HTTPS 필요)
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.warn('HTTPS 필요: 오디오 장치 접근 불가');
    inputSelect.innerHTML = '<option>HTTPS 필요</option>';
    if (outputSelect) outputSelect.innerHTML = '<option>HTTPS 필요</option>';
    toast('오디오 장치 접근을 위해 HTTPS가 필요합니다', 'warning', 5000);
    return;
  }
  
  try {
    // 먼저 권한 요청
    const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    tempStream.getTracks().forEach(t => t.stop());
    
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === 'audioinput');
    const audioOutputs = devices.filter(d => d.kind === 'audiooutput');
    
    // 입력 장치
    if (audioInputs.length) {
      inputSelect.innerHTML = audioInputs.map((d, i) => 
        `<option value="${d.deviceId}">${d.label || '마이크 ' + (i + 1)}</option>`
      ).join('');
      selectedDeviceId = audioInputs[0]?.deviceId;
      inputSelect.onchange = () => selectedDeviceId = inputSelect.value;
    } else {
      inputSelect.innerHTML = '<option>마이크 없음</option>';
    }
    
    // 출력 장치
    if (outputSelect && audioOutputs.length) {
      outputSelect.innerHTML = audioOutputs.map((d, i) => 
        `<option value="${d.deviceId}">${d.label || '스피커 ' + (i + 1)}</option>`
      ).join('');
      selectedOutputId = audioOutputs[0]?.deviceId;
      outputSelect.onchange = () => {
        selectedOutputId = outputSelect.value;
        peers.forEach(peer => {
          if (peer.audioEl?.setSinkId) {
            peer.audioEl.setSinkId(selectedOutputId).catch(e => { if (DEBUG) console.debug('Silent error:', e); });
          }
        });
      };
    } else if (outputSelect) {
      outputSelect.innerHTML = '<option>스피커 없음</option>';
    }
    
    log(`오디오 장치 로드: 입력 ${audioInputs.length}개, 출력 ${audioOutputs.length}개`);
  } catch (e) {
    console.error('오디오 장치 접근 실패:', e.message);
    inputSelect.innerHTML = '<option>마이크 권한 필요</option>';
    if (outputSelect) outputSelect.innerHTML = '<option>스피커 권한 필요</option>';
    toast('마이크 권한을 허용해 주세요', 'warning');
  }
}

// 방 목록
function loadRoomList() {
  socket.emit('get-rooms', null, rooms => renderRoomList(rooms));
}

socket.on('room-list', renderRoomList);

function renderRoomList(rooms) {
  const list = $('room-list');
  if (!rooms.length) {
    list.innerHTML = '<p class="no-rooms">활성화된 방이 없습니다</p>';
    return;
  }
  list.innerHTML = rooms.map((r, i) => {
    const canClose = currentUser?.isAdmin || r.creatorUsername === currentUser?.username;
    return `
    <div class="room-item">
      <div class="room-info" data-room-index="${i}">
        <span class="room-name">${r.hasPassword ? '🔒 ' : ''}${escapeHtml(r.name)}</span>
        <span class="room-users">${r.userCount}/${r.maxUsers} 👤</span>
      </div>
      ${canClose ? `<button class="room-close-btn" data-close-index="${i}">✕</button>` : ''}
    </div>
  `;
  }).join('');
  
  // Attach event handlers safely (prevents XSS via room names)
  list.querySelectorAll('.room-info[data-room-index]').forEach(el => {
    const idx = parseInt(el.dataset.roomIndex);
    const r = rooms[idx];
    el.onclick = () => joinRoom(r.name, r.hasPassword);
  });
  list.querySelectorAll('.room-close-btn[data-close-index]').forEach(el => {
    const idx = parseInt(el.dataset.closeIndex);
    const r = rooms[idx];
    el.onclick = (e) => { e.stopPropagation(); closeRoomFromLobby(r.name); };
  });
}

function closeRoomFromLobby(roomName) {
  if (!confirm(`"${roomName}" 방을 닫으시겠습니까?`)) return;
  socket.emit('close-room', { roomName }, res => {
    if (res.error) toast(res.error, 'error');
    else toast('방이 닫혔습니다', 'success');
  });
}

// 아바타 업로드 (하루 1회 제한)
$('avatar-input').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  
  // Check daily limit
  const lastChange = localStorage.getItem('styx-avatar-change');
  if (lastChange) {
    const lastDate = new Date(parseInt(lastChange)).toDateString();
    const today = new Date().toDateString();
    if (lastDate === today) {
      toast('아바타는 하루에 한 번만 변경할 수 있습니다', 'warning');
      e.target.value = '';
      return;
    }
  }
  
  if (file.size > 2 * 1024 * 1024) return toast('이미지 크기는 2MB 이하여야 합니다', 'error');
  
  const reader = new FileReader();
  reader.onload = () => {
    socket.emit('upload-avatar', { username: currentUser.username, avatarData: reader.result }, res => {
      if (res.success) {
        currentUser.avatar = res.avatar;
        $('my-avatar').style.backgroundImage = `url(${avatarUrl(res.avatar)})`;
        localStorage.setItem('styx-avatar-change', Date.now().toString());
        toast('아바타가 변경되었습니다', 'success');
      } else {
        toast(res.error, 'error');
      }
    });
  };
  reader.readAsDataURL(file);
};

// 단축키 도움말
$('shortcutsBtn')?.addEventListener('click', () => {
  $('shortcuts-overlay')?.classList.remove('hidden');
});

// 설정 패널
$('settingsBtn').onclick = () => {
  $('settings-panel').classList.remove('hidden');
  lobby.classList.add('hidden');
};

$('closeSettingsBtn').onclick = () => {
  $('settings-panel').classList.add('hidden');
  lobby.classList.remove('hidden');
};

$('changePasswordBtn').onclick = () => {
  const oldPw = $('old-password').value;
  const newPw = $('new-password').value;
  if (!oldPw || !newPw) return toast('비밀번호를 입력하세요', 'warning');
  
  socket.emit('change-password', { oldPassword: oldPw, newPassword: newPw }, res => {
    if (res.success) {
      toast('비밀번호가 변경되었습니다. 다시 로그인해주세요.', 'success');
      setTimeout(() => {
        localStorage.removeItem('styx-token');
        location.reload();
      }, 1500);
    } else {
      toast(res.error === 'Wrong password' ? '현재 비밀번호가 틀렸습니다' : res.error, 'error');
    }
  });
};

// 관리자 패널
$('adminBtn').onclick = () => {
  if (!checkAdminAccess()) {
    toast('관리자 권한이 필요합니다', 'error');
    return;
  }
  
  loadAdminData();
  initMonitoring(); // 모니터링 시스템 초기화
  adminPanel.classList.remove('hidden');
  lobby.classList.add('hidden');
};

// 관리자 알림 시스템
let pendingUserCount = 0;

function updateAdminNotifications() {
  if (!currentUser?.isAdmin) return;
  
  socket.emit('get-pending', null, res => {
    const newCount = res.pending?.length || 0;
    if (newCount > pendingUserCount) {
      toast(`새로운 가입 요청이 있습니다 (${newCount}개)`, 'info', 5000);
    }
    pendingUserCount = newCount;
    
    // 관리자 버튼에 알림 배지 표시
    const adminBtn = $('adminBtn');
    if (adminBtn) {
      const badge = adminBtn.querySelector('.notification-badge') || document.createElement('span');
      badge.className = 'notification-badge';
      badge.textContent = newCount;
      badge.style.display = newCount > 0 ? 'block' : 'none';
      if (!adminBtn.querySelector('.notification-badge')) {
        adminBtn.appendChild(badge);
      }
    }
  });
}

// 관리자 알림 확인 (관리자 로그인 시 시작)

function loadAdminData() {
  // 관리자 패널 열 때 알림 배지 숨기기
  const badge = $('adminBtn')?.querySelector('.notification-badge');
  if (badge) badge.style.display = 'none';
  
  // Load whitelist
  socket.emit('admin-whitelist-status', res => {
    if (res?.error) return;
    $('whitelist-enabled').checked = res.enabled;
    const list = $('whitelist-list');
    list.innerHTML = res.ips?.length ? '' : '<p>등록된 IP가 없습니다</p>';
    res.ips?.forEach(ip => {
      const div = document.createElement('div');
      div.className = 'whitelist-item';
      div.innerHTML = `<span>${escapeHtml(ip)}</span><button onclick="removeWhitelistIp('${ip}')">✗</button>`;
      list.appendChild(div);
    });
  });
  
  socket.emit('get-pending', null, res => {
    const list = $('pending-list');
    list.innerHTML = res.pending?.length ? '' : '<p>대기 중인 요청이 없습니다</p>';
    res.pending?.forEach(username => {
      const div = document.createElement('div');
      div.className = 'pending-user';
      div.innerHTML = `<span>${escapeHtml(username)}</span>
        <button onclick="approveUser('${username.replace(/'/g, "\\'")}')">✓</button>
        <button onclick="rejectUser('${username.replace(/'/g, "\\'")}')">✗</button>`;
      list.appendChild(div);
    });
  });
  
  socket.emit('get-users', null, res => {
    const list = $('users-list');
    list.innerHTML = '';
    
    if (!res.users?.length) {
      list.innerHTML = '<p>등록된 사용자가 없습니다</p>';
      return;
    }
    
    // Store users for search functionality
    window.allUsers = res.users;
    renderUserList(res.users);
  });
}

// Enhanced user management functions
function renderUserList(users) {
  const list = $('users-list');
  list.innerHTML = '';
  
  users.forEach(u => {
    const div = document.createElement('div');
    div.className = 'user-item';
    div.innerHTML = `
      <div class="user-info">
        <div class="user-avatar">${u.username.charAt(0).toUpperCase()}</div>
        <div class="user-details">
          <div class="user-name">${escapeHtml(u.username)}</div>
          <div class="user-status">
            ${u.isAdmin ? '<span class="admin-badge">관리자</span>' : '일반 사용자'}
            ${u.avatar ? ' • 아바타 설정됨' : ''}
          </div>
        </div>
      </div>
      <div class="user-actions">
        ${!u.isAdmin ? `<button onclick="makeAdmin('${u.username.replace(/'/g, "\\'")}', true)" class="btn-small">관리자 지정</button>` : 
          currentUser.username !== u.username ? `<button onclick="makeAdmin('${u.username.replace(/'/g, "\\'")}', false)" class="btn-small btn-danger">관리자 해제</button>` : ''}
        ${currentUser.username !== u.username ? `<button onclick="deleteUser('${u.username.replace(/'/g, "\\'")}'))" class="btn-small btn-danger">삭제</button>` : ''}
      </div>
    `;
    list.appendChild(div);
  });
}

function searchUsers() {
  const query = $('user-search').value.toLowerCase().trim();
  if (!window.allUsers) return;
  
  const filtered = window.allUsers.filter(u => 
    u.username.toLowerCase().includes(query)
  );
  
  renderUserList(filtered);
}

window.makeAdmin = (username, isAdmin) => {
  const action = isAdmin ? '관리자로 지정' : '관리자 권한 해제';
  if (!confirm(`${username} 사용자를 ${action}하시겠습니까?`)) return;
  
  socket.emit('set-admin', { username, isAdmin }, (res) => {
    if (res?.error) {
      toast(res.error, 'error');
    } else {
      toast(`${username} 사용자가 ${action}되었습니다`, 'success');
      loadAdminData();
    }
  });
};

// User management controls
$('user-search')?.addEventListener('input', searchUsers);
$('refresh-users')?.addEventListener('click', loadAdminData);

// Whitelist management
$('whitelist-enabled')?.addEventListener('change', (e) => {
  socket.emit('admin-whitelist-toggle', { enabled: e.target.checked }, res => {
    if (res?.error) toast(res.error, 'error');
    else toast(e.target.checked ? '화이트리스트 활성화됨' : '화이트리스트 비활성화됨', 'info');
  });
});

$('whitelist-add-btn')?.addEventListener('click', () => {
  const ip = $('whitelist-ip').value.trim();
  if (!ip) return toast('IP 주소를 입력하세요', 'error');
  socket.emit('admin-whitelist-add', { ip }, res => {
    if (res?.error) toast(res.error, 'error');
    else { toast(`${ip} 추가됨`, 'success'); $('whitelist-ip').value = ''; loadAdminData(); }
  });
});

window.removeWhitelistIp = (ip) => {
  if (!confirm(`${ip}를 화이트리스트에서 제거하시겠습니까?`)) return;
  socket.emit('admin-whitelist-remove', { ip }, res => {
    if (res?.error) toast(res.error, 'error');
    else { toast(`${ip} 제거됨`, 'info'); loadAdminData(); }
  });
};

window.approveUser = (username) => {
  socket.emit('approve-user', { username }, (res) => {
    if (res?.error) {
      toast(res.error, 'error');
    } else {
      toast(`${username} 사용자가 승인되었습니다`, 'success');
      loadAdminData();
    }
  });
};

window.rejectUser = (username) => {
  if (confirm(`${username} 사용자의 가입 요청을 거부하시겠습니까?`)) {
    socket.emit('reject-user', { username }, (res) => {
      if (res?.error) {
        toast(res.error, 'error');
      } else {
        toast(`${username} 사용자의 요청이 거부되었습니다`, 'info');
        loadAdminData();
      }
    });
  }
};

window.deleteUser = (username) => {
  if (confirm(`${username} 사용자를 영구적으로 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`)) {
    socket.emit('delete-user', { username }, (res) => {
      if (res?.error) {
        toast(res.error, 'error');
      } else {
        toast(`${username} 사용자가 삭제되었습니다`, 'info');
        loadAdminData();
      }
    });
  }
};

$('closeAdminBtn').onclick = () => {
  stopMonitoring(); // 모니터링 중지
  adminPanel.classList.add('hidden');
  lobby.classList.remove('hidden');
};

// 방 입장
let joiningRoom = false;
window.joinRoom = async (roomName, hasPassword, providedPassword, roomSettings) => {
  if (joiningRoom) return;
  joiningRoom = true;
  
  const room = roomName;
  if (!room) { joiningRoom = false; return toast('방 이름을 입력하세요', 'error'); }

  let roomPassword = providedPassword || null;
  if (hasPassword && !roomPassword) {
    roomPassword = prompt('방 비밀번호를 입력하세요:');
    if (!roomPassword) { joiningRoom = false; return; }
  }

  // 빠른 연결 상태 확인
  if (!navigator.onLine) {
    joiningRoom = false;
    return toast('인터넷 연결을 확인하세요', 'error');
  }
  
  // WiFi detection and warning
  if (navigator.connection) {
    const conn = navigator.connection;
    if (conn.type === 'wifi' || conn.effectiveType === '3g' || conn.effectiveType === '2g') {
      toast('⚠️ WiFi/모바일 연결 감지 - 유선 연결 권장', 'warning', 5000);
    }
  }
  
  // RTCPeerConnection 지원 확인
  if (!window.RTCPeerConnection) {
    return toast('이 브라우저는 WebRTC를 지원하지 않습니다', 'error');
  }

  const audioConstraints = {
    audio: {
      deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
      echoCancellation: $('echo-cancel')?.checked ?? true,
      noiseSuppression: $('noise-suppress')?.checked ?? true,
      autoGainControl: $('auto-gain')?.checked ?? true,
      sampleRate: SAMPLE_RATE,
      channelCount: 2, // Stereo support
      latency: { ideal: 0.01 }
    }
  };

  try {
    const rawStream = await navigator.mediaDevices.getUserMedia(audioConstraints);
    // 입력 리미터 적용 (클리핑 방지)
    localStream = await createProcessedInputStream(rawStream);
    // 원본 스트림 참조 저장 (정리용)
    localStream._rawStream = rawStream;
    
    // PTT 모드면 시작 시 음소거
    if (pttMode) {
      localStream.getAudioTracks().forEach(t => t.enabled = false);
      isMuted = true;
    }
  } catch (e) {
    showUserFriendlyError(e, 'microphone access');
    joiningRoom = false;
    return;
  }

  socket.emit('join', { room, username: currentUser.username, password: roomPassword, settings: roomSettings }, async (res) => {
    if (res.error) {
      localStream._rawStream?.getTracks().forEach(t => t.stop());
      localStream.getTracks().forEach(t => t.stop());
      if (inputLimiterContext && inputLimiterContext.state !== 'closed') { 
        try { inputLimiterContext.close(); } catch {} 
      }
      inputLimiterContext = null;
      sharedAudioContext = null;
      joiningRoom = false;
      const errorMsg = {
        'Room full': '방이 가득 찼습니다',
        'Username already in room': '이미 방에 접속 중입니다',
        'Not authorized': '권한이 없습니다',
        'Wrong room password': '방 비밀번호가 틀렸습니다'
      }[res.error] || res.error;
      return toast(errorMsg, 'error');
    }

    // Clear any existing peers from previous room
    peers.forEach(peer => {
      if (peer.pc?.close) peer.pc.close();
      if (peer.audioEl) peer.audioEl.remove();
    });
    peers.clear();
    usersGrid.innerHTML = '';

    lobby.classList.add('hidden');
    roomView.classList.remove('hidden');
    $('roomName').textContent = room;
    socket.room = room;
    lastRoom = room;
    lastRoomPassword = roomPassword;
    sessionStorage.setItem('styx-room', room);
    if (roomPassword) sessionStorage.setItem('styx-room-pw', roomPassword);
    else sessionStorage.removeItem('styx-room-pw');
    
    // 방 설정 저장 및 표시
    currentRoomSettings = res.roomSettings || {};
    isRoomCreator = res.isCreator || false;
    roomCreatorUsername = res.creatorUsername || '';
    displayRoomSettings();
    
    // 방 내 오디오 설정 동기화
    syncRoomAudioSettings();
    
    // 고급 설정 패널 초기화
    initAdvancedPanel();
    
    // PTT 모드면 음소거 버튼 상태 업데이트
    if (pttMode) {
      $('muteBtn').textContent = '🔇';
      $('muteBtn').classList.add('muted');
    }
    
    // 관리자 또는 방 생성자면 방 닫기 버튼 표시
    if (res.isAdmin || res.isCreator) {
      $('closeRoomBtn')?.classList.remove('hidden');
    } else {
      $('closeRoomBtn')?.classList.add('hidden');
    }
    
    const myCardAvatar = document.querySelector('#my-card .card-avatar');
    if (myCardAvatar) {
      myCardAvatar.style.backgroundImage = currentUser?.avatar ? `url(${avatarUrl(currentUser.avatar)})` : '';
    }

    chatMessages.innerHTML = '';
    res.messages?.forEach(addChatMessage);

    if (res.metronome) {
      $('bpm-input').value = res.metronome.bpm;
      if (res.metronome.playing) startMetronome(res.metronome.bpm, res.metronome.startTime);
    }
    
    // 지연 보상 상태 적용
    delayCompensation = res.delayCompensation || false;
    if ($('delay-compensation')) $('delay-compensation').checked = delayCompensation;

    // 역할 설정
    myRole = res.myRole || 'performer';
    updateRoleUI();
    
    // listener는 오디오 전송 안함
    if (myRole === 'listener' && localStream) {
      localStream.getAudioTracks().forEach(t => t.enabled = false);
      isMuted = true;
      updateMuteUI();
    }

    // 기존 사용자들을 peers Map에 추가
    if (res.users) {
      res.users.forEach(({ id, username, avatar, role }) => {
        if (!peers.has(id)) {
          peers.set(id, {
            pc: { connectionState: actuallyTauri ? 'connected' : 'new' },
            username,
            avatar,
            role: role || 'performer',
            audioEl: null,
            latency: null,
            volume: 100,
            packetLoss: 0,
            jitter: 0,
            bitrate: 0,
            quality: { grade: actuallyTauri ? 'good' : 'fair', label: actuallyTauri ? 'UDP' : '관전', color: actuallyTauri ? '#2ed573' : '#ffa502' },
            pan: 0,
            muted: false,
            solo: false,
            isSpeaking: false
          });
        }
      });
      renderUsers();
    }

    // Tauri앱: UDP 릴레이로 오디오, 브라우저: 관전 모드 (오디오 없음)
    if (actuallyTauri) {
      try {
        await startUdpMode();
        // After UDP is set up, attempt P2P with existing peers
        if (res.users) {
          res.users.forEach(({ id }) => initiateP2P(id));
        }
      } catch (udpError) {
        console.error('UDP 시작 실패:', udpError);
        toast('오디오 연결 중 오류 발생', 'warning');
      }
    } else {
      // 브라우저 관전 모드 배너 표시, 오디오 컨트롤 숨김
      $('browser-spectator-banner')?.classList.remove('hidden');
      $('muteBtn')?.classList.add('hidden');
      $('room-audio-device')?.classList.add('hidden');
      $('room-audio-output')?.classList.add('hidden');
      $('recordBtn')?.classList.add('hidden');
    }
    
    startLatencyPing();
    if (!networkQualityInterval) {
      networkQualityInterval = setInterval(monitorNetworkQuality, 5000);
    }
    startAudioMeter();
    initPttTouch();
    joiningRoom = false;
  });
};

// 오디오 레벨 미터
function startAudioMeter() {
  // Clean up existing meter
  if (meterInterval) {
    clearInterval(meterInterval);
    meterInterval = null;
  }
  
  // Close existing audio context
  if (audioContext && audioContext.state !== 'closed') {
    try { audioContext.close(); } catch {}
  }
  
  // Check if localStream exists
  if (!localStream) {
    console.warn('startAudioMeter: localStream not available');
    return;
  }
  
  try {
    audioContext = new AudioContext();
    // Resume if suspended (browser autoplay policy)
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    
    const source = audioContext.createMediaStreamSource(localStream);
    source.connect(analyser);
    
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const meter = $('audio-meter');
    
    meterInterval = setInterval(() => {
      if (!analyser || !meter) {
        clearInterval(meterInterval);
        meterInterval = null;
        return;
      }
      analyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b) / dataArray.length;
      const level = Math.min(100, avg * 1.5);
      meter.style.width = level + '%';
      meter.style.background = level > 80 ? '#ff4757' : level > 50 ? '#ffa502' : '#2ed573';
    }, 50);
  } catch (e) {
    console.error('AudioContext 생성 실패:', e);
  }
}

// 메트로놈
$('metronome-toggle').onclick = () => {
  // 사용자 상호작용으로 AudioContext 생성
  if (!metronomeAudio) {
    metronomeAudio = new AudioContext();
  }
  
  const bpm = parseInt($('bpm-input').value) || 120;
  const playing = !metronomeInterval;
  const countIn = $('count-in')?.checked || false;
  
  if (playing) {
    metronomeLocalStop = false;
    startMetronome(bpm, null, countIn);
  } else {
    metronomeLocalStop = true;
    stopMetronome();
  }
  
  socket.emit('metronome-update', { bpm, playing });
};

$('bpm-input').onchange = () => {
  if (metronomeInterval) {
    const bpm = parseInt($('bpm-input').value) || 120;
    stopMetronome();
    startMetronome(bpm);
    socket.emit('metronome-update', { bpm, playing: true });
  }
};

socket.on('metronome-sync', ({ bpm, playing, startTime }) => {
  $('bpm-input').value = bpm;
  if (playing) {
    // Don't restart if user just stopped it locally (debounce)
    if (metronomeLocalStop) {
      // Reset flag after a short delay to allow future syncs
      setTimeout(() => { metronomeLocalStop = false; }, 500);
      return;
    }
    startMetronome(bpm, startTime);
  } else {
    stopMetronome();
  }
});

socket.on('delay-compensation-sync', (enabled) => {
  delayCompensation = enabled;
  const checkbox = $('delay-compensation');
  if (checkbox) checkbox.checked = enabled;
  if (!enabled) {
    // 비활성화 시 모든 딜레이 제거
    peers.forEach(peer => {
      if (peer.delayNode) peer.delayNode.delayTime.setTargetAtTime(0, peer.audioContext.currentTime, 0.1);
    });
  }
  toast(enabled ? '지연 맞추기 켜짐 - 모든 사람 타이밍 동기화' : '지연 맞추기 꺼짐', 'info');
});

// metronomeBeat moved to top for error recovery
const BEATS_PER_BAR = 4;

function startMetronome(bpm, serverStartTime, countIn = false) {
  stopMetronome();
  
  const interval = 60000 / bpm;
  const tick = $('metronome-tick');
  const beatIndicators = document.querySelectorAll('.beat-indicator');
  
  let delay = 0;
  if (serverStartTime) {
    // 서버 시간 오프셋을 적용하여 정확한 경과 시간 계산
    const serverNow = getServerTime();
    const elapsed = serverNow - serverStartTime;
    delay = interval - (elapsed % interval);
    if (delay < 0) delay += interval; // 음수 방지
    metronomeBeat = Math.floor((elapsed / interval) % BEATS_PER_BAR);
    if (metronomeBeat < 0) metronomeBeat = 0;
  } else {
    metronomeBeat = 0;
  }
  
  const playTick = (isAccent = false) => {
    tick?.classList.add('active');
    
    // 비트 인디케이터 업데이트
    beatIndicators.forEach((el, i) => {
      el?.classList.toggle('active', i === metronomeBeat);
    });
    
    if (!metronomeAudio || metronomeAudio.state === 'closed') {
      metronomeAudio = new AudioContext();
    }
    if (metronomeAudio.state === 'suspended') {
      metronomeAudio.resume();
    }
    
    try {
      const osc = metronomeAudio.createOscillator();
      const gain = metronomeAudio.createGain();
      osc.connect(gain);
      gain.connect(metronomeAudio.destination);
      // 강박(첫 박)은 높은 음, 약박은 낮은 음
      osc.frequency.value = isAccent ? 1200 : 800;
      gain.gain.setValueAtTime(isAccent ? 0.4 : 0.25, metronomeAudio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, metronomeAudio.currentTime + 0.08);
      osc.start();
      osc.stop(metronomeAudio.currentTime + 0.08);
    } catch {}
    
    setTimeout(() => tick?.classList.remove('active'), 80);
    metronomeBeat = (metronomeBeat + 1) % BEATS_PER_BAR;
  };
  
  const startPlaying = () => {
    metronomeBeat = 0;
    playTick(true); // 첫 박은 강박
    metronomeInterval = setInterval(() => {
      playTick(metronomeBeat === 0);
    }, interval);
  };
  
  // 카운트인: 4박 후 시작
  if (countIn && !serverStartTime) {
    let countInBeat = 0;
    const countInInterval = setInterval(() => {
      playTick(countInBeat === 0);
      countInBeat++;
      if (countInBeat >= BEATS_PER_BAR) {
        clearInterval(countInInterval);
        startPlaying();
      }
    }, interval);
    $('metronome-toggle').textContent = '⏳';
  } else {
    setTimeout(() => {
      startPlaying();
    }, delay);
  }
  
  $('metronome-toggle').textContent = '⏹️';
  $('metronome-toggle').classList.add('playing');
}

function stopMetronome() {
  if (metronomeInterval) {
    clearInterval(metronomeInterval);
    metronomeInterval = null;
  }
  metronomeBeat = 0;
  document.querySelectorAll('.beat-indicator').forEach(el => el.classList.remove('active'));
  $('metronome-toggle').textContent = '▶️';
  $('metronome-toggle').classList.remove('playing');
}

// Export click track as audio file
function exportClickTrack() {
  const bpm = parseInt($('bpm-input')?.value) || 120;
  const bars = parseInt(prompt('몇 마디를 내보낼까요?', '8')) || 8;
  const beats = bars * BEATS_PER_BAR;
  const interval = 60 / bpm;
  const duration = beats * interval;
  
  const offlineCtx = new OfflineAudioContext(2, 48000 * duration, 48000);
  
  for (let i = 0; i < beats; i++) {
    const isAccent = i % BEATS_PER_BAR === 0;
    const osc = offlineCtx.createOscillator();
    const gain = offlineCtx.createGain();
    osc.connect(gain);
    gain.connect(offlineCtx.destination);
    osc.frequency.value = isAccent ? 1200 : 800;
    const startTime = i * interval;
    gain.gain.setValueAtTime(isAccent ? 0.4 : 0.25, startTime);
    gain.gain.exponentialRampToValueAtTime(0.01, startTime + 0.08);
    osc.start(startTime);
    osc.stop(startTime + 0.08);
  }
  
  offlineCtx.startRendering().then(buffer => {
    const wav = audioBufferToWav(buffer);
    const blob = new Blob([wav], { type: 'audio/wav' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `click-${bpm}bpm-${bars}bars.wav`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`🎵 클릭 트랙 내보내기 완료 (${bpm}BPM, ${bars}마디)`, 'success');
  });
}

// Convert AudioBuffer to WAV
function audioBufferToWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataLength = buffer.length * blockAlign;
  const bufferLength = 44 + dataLength;
  const arrayBuffer = new ArrayBuffer(bufferLength);
  const view = new DataView(arrayBuffer);
  
  const writeString = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
  writeString(0, 'RIFF');
  view.setUint32(4, bufferLength - 8, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(36, 'data');
  view.setUint32(40, dataLength, true);
  
  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      view.setInt16(offset, sample * 0x7FFF, true);
      offset += 2;
    }
  }
  return arrayBuffer;
}

// 채팅
$('sendBtn').onclick = sendChat;
$('chat-text').onkeypress = (e) => { if (e.key === 'Enter') sendChat(); };

function sendChat() {
  const text = $('chat-text').value.trim();
  if (!text) return;
  socket.emit('chat', text);
  $('chat-text').value = '';
}

socket.on('chat', addChatMessage);

function addChatMessage(msg) {
  const div = document.createElement('div');
  div.className = 'chat-msg' + (msg.username === currentUser?.username ? ' self' : '');
  div.innerHTML = `<span class="chat-user">${escapeHtml(msg.username)}</span><span class="chat-text">${escapeHtml(msg.text)}</span>`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(text) {
  if (M.core?.escapeHtml) return M.core.escapeHtml(text);
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 연결 타입 확인 (relay/srflx/host)
async function checkConnectionType(pc, peerId) {
  try {
    const stats = await pc.getStats();
    let candidateType = 'unknown';
    
    stats.forEach(report => {
      if (report.type === 'candidate-pair' && report.state === 'succeeded') {
        const localId = report.localCandidateId;
        stats.forEach(r => {
          if (r.id === localId) {
            candidateType = r.candidateType; // host, srflx, relay
          }
        });
      }
    });
    
    const peer = peers.get(peerId);
    if (peer) {
      peer.connectionType = candidateType;
      const typeLabels = { host: '직접', srflx: 'STUN', relay: 'TURN' };
      log(`연결 타입: ${peer.username} -> ${typeLabels[candidateType] || candidateType}`);
    }
  } catch (e) {
    log('연결 타입 확인 실패:', e);
  }
}

// 피어 연결 재생성 (ICE 완전 실패 시)
function recreatePeerConnection(peerId, username, avatar) {
  const oldPeer = peers.get(peerId);
  if (!oldPeer) return;
  
  log(`피어 연결 재생성: ${username}`);
  
  // 기존 연결 정리
  try {
    if (oldPeer.pc?.close) oldPeer.pc.close();
    if (oldPeer.audioNodes) {
      oldPeer.audioNodes.source.disconnect();
    }
  } catch {}
  
  // VAD 인터벌 정리
  const vadInt = vadIntervals.get(peerId);
  if (vadInt) { clearInterval(vadInt); vadIntervals.delete(peerId); }
  
  // 새 연결 생성 (initiator=true로 새 offer 전송)
  peers.delete(peerId);
  createPeerConnection(peerId, username, avatar, true);
  toast(`${username} 재연결 중...`, 'info');
}

// TURN 자격증명 갱신 (만료 전 갱신)
function scheduleTurnRefresh() {
  if (turnRefreshTimer) clearTimeout(turnRefreshTimer);
  // 23시간 후 갱신 (24시간 TTL 전에)
  turnRefreshTimer = setTimeout(() => {
    log('TURN 자격증명 갱신');
    updateTurnCredentials();
    scheduleTurnRefresh();
  }, 23 * 60 * 60 * 1000);
}

// WebRTC
function createPeerConnection(peerId, username, avatar, initiator, role = 'performer') {
  const pc = new RTCPeerConnection(rtcConfig);
  const audioEl = document.createElement('audio');
  audioEl.autoplay = true;
  document.body.appendChild(audioEl);

  // 출력 장치 설정
  if (selectedOutputId && audioEl.setSinkId) {
    audioEl.setSinkId(selectedOutputId).catch(e => { if (DEBUG) console.debug('Silent error:', e); });
  }

  const savedVolume = volumeStates.get(peerId) ?? 100;
  audioEl.volume = savedVolume / 100;

  peers.set(peerId, { 
    pc, username, avatar, audioEl, role,
    latency: null, volume: savedVolume,
    packetLoss: 0, jitter: 0, bitrate: 0,
    quality: { grade: 'good', label: '연결중', color: '#ffa502' },
    pan: 0, muted: false, solo: false
  });

  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.ontrack = (e) => {
    const peerData = peers.get(peerId);
    
    // Handle video track (screen share)
    if (e.track.kind === 'video') {
      const screenVideo = $('screen-share-video');
      if (screenVideo) {
        screenVideo.srcObject = e.streams[0];
        screenVideo.style.display = '';
        // Hide placeholder if exists
        const placeholder = $('screen-share-placeholder');
        if (placeholder) placeholder.style.display = 'none';
      }
      return;
    }
    
    // 지터 버퍼 적용 (WebRTC playoutDelayHint)
    if (e.receiver && e.receiver.playoutDelayHint !== undefined) {
      e.receiver.playoutDelayHint = jitterBuffer / 1000; // ms → seconds
    }
    
    try {
      // 공유 AudioContext 사용 (브라우저 AudioContext 제한 회피)
      const ctx = getPeerAudioContext();
      
      const source = ctx.createMediaStreamSource(e.streams[0]);
      
      // 다이나믹 레인지 압축 (자동 레벨 매칭)
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -24; // dB - 압축 시작점
      compressor.knee.value = 30; // 부드러운 압축
      compressor.ratio.value = 4; // 4:1 압축비
      compressor.attack.value = 0.003; // 3ms 빠른 반응
      compressor.release.value = 0.25; // 250ms 자연스러운 해제
      
      // 메이크업 게인 (압축 손실 보상)
      const makeupGain = ctx.createGain();
      makeupGain.gain.value = 2.0; // 압축으로 인한 볼륨 손실 보상
      
      // 팬 노드 (스테레오 위치)
      const panNode = ctx.createStereoPanner();
      panNode.pan.value = 0;
      
      // 덕킹용 게인 노드
      const gainNode = ctx.createGain();
      gainNode.gain.value = 1;
      
      // 지연 보상용 딜레이 노드
      const delayNode = ctx.createDelay(1.0); // 최대 1초
      delayNode.delayTime.value = 0;
      
      // VAD용 분석기
      const peerAnalyser = ctx.createAnalyser();
      peerAnalyser.fftSize = 256;
      
      const dest = ctx.createMediaStreamDestination();
      source.connect(peerAnalyser);
      peerAnalyser.connect(compressor);
      compressor.connect(makeupGain);
      makeupGain.connect(panNode);
      panNode.connect(delayNode);
      delayNode.connect(gainNode);
      gainNode.connect(dest);
      
      audioEl.srcObject = dest.stream;
      if (peerData) {
        peerData.audioContext = ctx; // 공유 컨텍스트 참조
        peerData.compressor = compressor;
        peerData.makeupGain = makeupGain;
        peerData.panNode = panNode;
        peerData.gainNode = gainNode;
        peerData.delayNode = delayNode;
        peerData.analyser = peerAnalyser;
        peerData.isSpeaking = false;
        peerData.audioNodes = { source, compressor, makeupGain, panNode, gainNode, delayNode, peerAnalyser, dest }; // 정리용
      }
      
      // VAD 시작
      if (vadEnabled) startVAD(peerId, peerAnalyser);
      
    } catch (err) {
      console.error('오디오 처리 설정 실패:', err);
      audioEl.srcObject = e.streams[0];
      
      // 폴백: 간단한 볼륨 모니터링
      if (vadEnabled) startVAD(peerId, null);
    }
    
    if (audioEl.playsInline !== undefined) {
      audioEl.playsInline = true;
    }
    // 오디오 재생 시작
    audioEl.play().catch(err => console.error('Audio play failed:', err));
    renderUsers();
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('ice-candidate', { to: peerId, candidate: e.candidate });
  };

  // ICE gathering 상태 모니터링
  pc.onicegatheringstatechange = () => {
    log(`ICE gathering 상태: ${username} -> ${pc.iceGatheringState}`);
  };

  pc.oniceconnectionstatechange = () => {
    const peerData = peers.get(peerId);
    log(`ICE 연결 상태: ${username} -> ${pc.iceConnectionState}`);
    
    if (pc.iceConnectionState === 'disconnected') {
      // ICE 연결 끊김 - 점진적 재시도 (exponential backoff)
      const retryDelay = Math.min(1000 * Math.pow(2, peerData?.iceRetryCount || 0), 10000);
      peerData.iceRetryCount = (peerData?.iceRetryCount || 0) + 1;
      
      setTimeout(() => {
        if (pc.iceConnectionState === 'disconnected' && peerData?.iceRetryCount <= 5) {
          log(`ICE 재시작 시도: ${username} (${peerData.iceRetryCount}/5)`);
          pc.restartIce();
        }
      }, retryDelay);
    }
    
    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      if (peerData) peerData.iceRetryCount = 0;
    }
    
    if (pc.iceConnectionState === 'failed') {
      // ICE 완전 실패 - 연결 재생성 시도
      log(`ICE 실패, 연결 재생성: ${username}`);
      recreatePeerConnection(peerId, username, peerData?.avatar);
    }
    
    if (peerData) peerData.iceState = pc.iceConnectionState;
  };

  pc.onconnectionstatechange = () => {
    const peerData = peers.get(peerId);
    log(`연결 상태 변경: ${username} -> ${pc.connectionState}`);
    
    if (pc.connectionState === 'connected') {
      applyAudioSettings(pc);
      if (peerData) {
        peerData.retryCount = 0;
        // 연결 타입 확인 (relay/srflx/host)
        checkConnectionType(pc, peerId);
      }
      log(`연결 성공: ${username}`);
    }
    if (pc.connectionState === 'failed') {
      console.error(`연결 실패: ${username}`);
      const retries = (peerData?.retryCount || 0) + 1;
      if (peerData) peerData.retryCount = retries;
      
      if (retries <= 3) {
        pc.restartIce();
        toast(`${username} 재연결 시도 (${retries}/3)`, 'warning');
      } else {
        toast(`${username} 연결 실패 - 클릭하여 재시도`, 'error', 10000);
        // 수동 재연결 옵션 제공
        if (peerData) peerData.needsManualReconnect = true;
      }
    }
    if (pc.connectionState === 'disconnected') {
      toast(`${username} 연결 끊김, 재연결 대기...`, 'warning');
    }
    renderUsers();
  };

  if (initiator) {
    log(`Offer 생성 시작: ${username} (${peerId})`);
    pc.createOffer()
      .then(offer => {
        // Opus SDP 최적화 적용
        offer.sdp = optimizeOpusSdp(offer.sdp, audioMode);
        return pc.setLocalDescription(offer);
      })
      .then(() => {
        socket.emit('offer', { to: peerId, offer: pc.localDescription });
        log(`Offer 전송 완료: ${username}`);
      })
      .catch(e => console.error('Offer 생성 실패:', e));
  }

  renderUsers();
  return pc;
}

function renderUsers() {
  usersGrid.innerHTML = '';
  const hasSolo = [...peers.values()].some(p => p.solo);
  
  peers.forEach((peer, id) => {
    const state = peer.pc.connectionState;
    const connected = state === 'connected';
    const q = peer.quality;
    const speaking = peer.isSpeaking ? 'speaking' : '';
    const connType = peer.connectionType ? { host: '직접', srflx: 'STUN', relay: 'TURN' }[peer.connectionType] || '' : '';
    
    const card = document.createElement('div');
    card.className = `user-card ${connected ? 'connected' : 'connecting'} ${speaking}`;
    card.innerHTML = `
      <div class="card-avatar" style="background-image: ${peer.avatar ? `url(${avatarUrl(peer.avatar)})` : 'none'}"></div>
      <div class="card-info">
        <span class="card-name">${peer.isSpeaking ? '🎤 ' : ''}${escapeHtml(peer.username)}</span>
        <div class="card-stats">
          <span class="quality-badge" style="background:${q.color}">${q.label}${connType ? ` (${connType})` : ''}</span>
          <span class="stat">${peer.latency ? peer.latency + 'ms' : '--'}</span>
          <span class="stat">${peer.packetLoss.toFixed(1)}% 손실</span>
        </div>
        <div class="volume-meter">
          <div class="volume-bar" data-peer="${id}"></div>
        </div>
      </div>
      <div class="card-mixer">
        <button class="mixer-btn ${peer.muted ? 'active' : ''}" data-action="mute">M</button>
        <button class="mixer-btn ${peer.solo ? 'active' : ''}" data-action="solo">S</button>
        <input type="range" min="-100" max="100" value="${peer.pan}" class="pan-slider" title="팬: ${peer.pan}">
      </div>
      <div class="card-controls">
        <input type="range" min="0" max="100" value="${peer.volume}" class="volume-slider">
        <span class="volume-label">${peer.volume}%</span>
        <span class="role-badge role-${peer.role || 'performer'}">${{host:'호스트',performer:'연주자',listener:'청취자'}[peer.role]||'연주자'}</span>
        ${myRole === 'host' && peer.role !== 'host' ? `<select class="role-select" data-id="${id}"><option value="performer" ${peer.role==='performer'?'selected':''}>연주자</option><option value="listener" ${peer.role==='listener'?'selected':''}>청취자</option></select>` : ''}
        ${peer.needsManualReconnect ? `<button class="reconnect-btn" data-id="${id}">🔄</button>` : ''}
        ${currentUser?.isAdmin ? `<button class="kick-btn" data-id="${id}">강퇴</button>` : ''}
      </div>
    `;
    
    // 역할 변경 (호스트만)
    const roleSelect = card.querySelector('.role-select');
    if (roleSelect) {
      roleSelect.onchange = () => {
        socket.emit('change-role', { userId: id, role: roleSelect.value }, res => {
          if (res?.error) toast(res.error, 'error');
        });
      };
    }
    
    // 수동 재연결 버튼
    const reconnectBtn = card.querySelector('.reconnect-btn');
    if (reconnectBtn) {
      reconnectBtn.onclick = () => {
        peer.needsManualReconnect = false;
        peer.retryCount = 0;
        recreatePeerConnection(id, peer.username, peer.avatar);
      };
    }
    
    // 볼륨 슬라이더
    const slider = card.querySelector('.volume-slider');
    const label = card.querySelector('.volume-label');
    slider.oninput = () => {
      const vol = parseInt(slider.value);
      if (peer.audioEl) peer.audioEl.volume = vol / 100;
      peer.volume = vol;
      volumeStates.set(id, vol);
      label.textContent = vol + '%';
    };
    
    // 뮤트 버튼
    const muteBtn = card.querySelector('[data-action="mute"]');
    if (muteBtn) muteBtn.onclick = () => {
      peer.muted = !peer.muted;
      applyMixerState();
      renderUsers();
    };
    
    // 솔로 버튼
    const soloBtn = card.querySelector('[data-action="solo"]');
    if (soloBtn) soloBtn.onclick = () => {
      peer.solo = !peer.solo;
      applyMixerState();
      renderUsers();
    };
    
    // 팬 슬라이더
    const panSlider = card.querySelector('.pan-slider');
    if (panSlider) panSlider.oninput = () => {
      peer.pan = parseInt(panSlider.value);
      if (peer.panNode) peer.panNode.pan.value = peer.pan / 100;
    };
    
    const kickBtn = card.querySelector('.kick-btn');
    if (kickBtn) {
      kickBtn.onclick = () => {
        if (confirm('이 사용자를 강퇴하시겠습니까?')) {
          socket.emit('kick-user', { socketId: id });
        }
      };
    }
    
    usersGrid.appendChild(card);
  });
}

// 믹서 상태 적용 (뮤트/솔로)
function applyMixerState() {
  const hasSolo = [...peers.values()].some(p => p.solo);
  peers.forEach(peer => {
    if (peer.gainNode) {
      if (peer.muted || (hasSolo && !peer.solo)) {
        peer.gainNode.gain.value = 0;
      } else {
        peer.gainNode.gain.value = 1;
      }
    }
  });
}

// ===== Sync Mode (from sync.js module) =====
const { calibrateDeviceLatency, calculateSyncDelays, broadcastLatency, clearSyncDelays, initSyncSocketHandlers } = window.StyxSync || {};

// ===== P2P Connection Functions =====

// Detect NAT type on startup
async function detectNatType() {
  if (!actuallyTauri || !tauriInvoke) return;
  
  try {
    const info = await tauriInvoke('detect_nat');
    myNatType = info.nat_type;
    myPublicAddr = info.public_addr;
    log(`[P2P] NAT Type: ${myNatType}, Public: ${myPublicAddr}`);
  } catch (e) {
    console.error('[P2P] NAT detection failed:', e);
    myNatType = 'Unknown';
  }
}

// Exchange P2P endpoints with peers
socket.on('p2p-offer', async ({ from, natType, publicAddr }) => {
  if (!actuallyTauri || !tauriInvoke) return;
  
  log(`[P2P] Received offer from ${from}: ${natType} @ ${publicAddr}`);
  
  // Check if P2P is possible
  const canP2P = canEstablishP2P(myNatType, natType);
  
  if (canP2P && publicAddr) {
    // Attempt hole punch
    try {
      const success = await tauriInvoke('attempt_p2p', { peerAddr: publicAddr });
      if (success) {
        peerConnections.set(from, { type: 'p2p', addr: publicAddr });
        socket.emit('p2p-answer', { to: from, success: true, publicAddr: myPublicAddr });
        log(`[P2P] ✅ Direct connection to ${from}`);
        updateConnectionStatus();
        return;
      }
    } catch (e) {
      log(`[P2P] Hole punch failed: ${e}`);
    }
  }
  
  // Fall back to relay
  peerConnections.set(from, { type: 'relay', addr: null });
  socket.emit('p2p-answer', { to: from, success: false });
  log(`[P2P] Using relay for ${from}`);
  updateConnectionStatus();
});

socket.on('p2p-answer', ({ from, success, publicAddr }) => {
  if (success && publicAddr) {
    peerConnections.set(from, { type: 'p2p', addr: publicAddr });
    log(`[P2P] ✅ P2P confirmed with ${from}`);
  } else {
    peerConnections.set(from, { type: 'relay', addr: null });
    log(`[P2P] Relay confirmed with ${from}`);
  }
  updateConnectionStatus();
});

// Check if P2P is possible between two NAT types
function canEstablishP2P(myNat, peerNat) {
  // Symmetric NAT on either side = no P2P
  if (myNat === 'Symmetric' || peerNat === 'Symmetric') return false;
  // Both unknown = try anyway
  if (myNat === 'Unknown' && peerNat === 'Unknown') return true;
  // Any combination of Open/FullCone/Restricted = P2P possible
  return true;
}

// Initiate P2P with a new peer
async function initiateP2P(peerId) {
  if (!actuallyTauri || !tauriInvoke) return;
  
  // Wait for NAT detection if not done yet
  if (!myPublicAddr) {
    await detectNatType();
  }
  if (!myPublicAddr) return; // Still no address, skip P2P
  
  socket.emit('p2p-offer', { 
    to: peerId, 
    natType: myNatType, 
    publicAddr: myPublicAddr 
  });
}

// Update connection status display
function updateConnectionStatus() {
  const statusEl = $('room-connection-status');
  if (!statusEl) return;
  
  let p2pCount = 0, relayCount = 0;
  peerConnections.forEach(conn => {
    if (conn.type === 'p2p') p2pCount++;
    else relayCount++;
  });
  
  if (p2pCount > 0 && relayCount === 0) {
    statusEl.textContent = `🟢 P2P (${p2pCount})`;
    statusEl.title = '모든 연결이 직접 P2P';
  } else if (p2pCount > 0) {
    statusEl.textContent = `🟡 혼합 (P2P:${p2pCount} 릴레이:${relayCount})`;
    statusEl.title = '일부 P2P, 일부 릴레이';
  } else if (relayCount > 0) {
    statusEl.textContent = `🔵 릴레이 (${relayCount})`;
    statusEl.title = '모든 연결이 서버 릴레이';
  } else {
    statusEl.textContent = '⚪ 대기';
  }
}

// Attempt to recover degraded connection
async function attemptConnectionRecovery() {
  if (!actuallyTauri || !tauriInvoke) return;
  
  try {
    // Stop current stream
    await tauriInvoke('udp_stop_stream');
    await new Promise(r => setTimeout(r, 200));
    
    // Restart UDP mode
    await startUdpMode();
    toast('✅ 연결 복구 완료', 'success');
  } catch (e) {
    console.error('[RECOVERY] Failed:', e);
    toast('❌ 연결 복구 실패, TCP로 전환', 'error');
    
    // Fall back to TCP
    useTcpFallback = true;
    socket.emit('tcp-bind-room', { roomId: socket.room });
    startTcpAudioStream();
  }
}

function startLatencyPing() {
  if (latencyInterval) clearInterval(latencyInterval);
  if (statsInterval) clearInterval(statsInterval);
  latencyHistory = [];
  
  let consecutiveFailures = 0;
  const MAX_FAILURES = 5;
  
  // Latency measurement (every 3 seconds)
  latencyInterval = setInterval(async () => {
    // Measure Socket.IO latency
    const start = Date.now();
    socket.emit('ping', start, (serverTime) => {
      const socketRtt = Date.now() - start;
      selfStats.socketLatency = socketRtt;
      consecutiveFailures = 0; // Reset on success
    });
    
    // Measure UDP latency for Tauri mode
    if (actuallyTauri && actuallyTauri) {
      try {
        const udpRtt = await tauriInvoke('measure_relay_latency');
        selfStats.latency = udpRtt;
        selfStats.udpLatency = udpRtt;
        consecutiveFailures = 0;
        
        // Quality warning
        if (udpRtt > 150) {
          toast('⚠️ 네트워크 지연이 높습니다', 'warning', 3000);
        }
      } catch (e) {
        consecutiveFailures++;
        selfStats.latency = selfStats.socketLatency || 0;
        
        // Auto-recovery attempt
        if (consecutiveFailures >= MAX_FAILURES) {
          console.warn('[QUALITY] Connection degraded, attempting recovery...');
          toast('🔄 연결 복구 중...', 'warning');
          attemptConnectionRecovery().catch(e => console.error('[RECOVERY] Error:', e));
          consecutiveFailures = 0;
        }
      }
    } else {
      selfStats.latency = selfStats.socketLatency || 0;
    }
    updateSelfStatsUI();
    broadcastLatency(); // Broadcast for sync mode
  }, 3000);
  
  // 상세 통계 수집 (2초마다)
  statsInterval = setInterval(async () => {
    let avgLatency = 0, count = 0;
    let totalBandwidth = 0, totalPacketLoss = 0, peerCount = 0;
    
    // Tauri 앱에서는 UDP 통계 사용, 웹에서는 WebRTC 통계 사용
    if (actuallyTauri) {
      // Tauri UDP 모드: 간단한 추정치 사용
      if (peers.size > 0) {
        selfStats.bandwidth = Math.round(audioModes[audioMode].bitrate / 8); // kbps
        selfStats.packetsLost = 0; // UDP는 패킷 손실 추적이 복잡함
        updateSelfStatsUI();
      }
    } else {
      // 웹 WebRTC 모드: 실제 WebRTC 통계 수집
      for (const [id, peer] of peers) {
        if (!peer.pc || peer.pc.connectionState !== 'connected') continue;
        
        try {
          const stats = await peer.pc.getStats();
          let packetsLost = 0, packetsReceived = 0, jitter = 0, rtt = 0;
          let bytesReceived = 0, bytesSent = 0;
          
          stats.forEach(report => {
            if (report.type === 'inbound-rtp' && report.kind === 'audio') {
              packetsLost = report.packetsLost || 0;
              packetsReceived = report.packetsReceived || 0;
              jitter = (report.jitter || 0) * 1000;
              bytesReceived = report.bytesReceived || 0;
            }
            if (report.type === 'outbound-rtp' && report.kind === 'audio') {
              bytesSent = report.bytesSent || 0;
            }
            if (report.type === 'candidate-pair' && report.state === 'succeeded') {
              rtt = (report.currentRoundTripTime || 0) * 1000;
            }
          });
          
          const totalPackets = packetsLost + packetsReceived;
          const lossRate = totalPackets > 0 ? (packetsLost / totalPackets) * 100 : 0;
          const bandwidth = Math.round((bytesReceived + bytesSent) * 8 / 1000 / 2); // kbps estimate
          
          peer.latency = Math.round(rtt);
          peer.packetLoss = lossRate;
          peer.jitter = jitter;
          if (jitter > 0) trackJitter(jitter);
          const prevQuality = peer.quality?.grade;
          peer.quality = getQualityGrade(rtt, lossRate, jitter);
          
          // Accumulate for self stats
          totalBandwidth += bandwidth;
          totalPacketLoss += lossRate;
          peerCount++;
          
          // 품질 저하 경고
          if (prevQuality === 'good' && peer.quality.grade === 'poor') {
            toast(`${peer.username} 연결 불안정`, 'warning', 3000);
          }
          
          if (rtt > 0) { avgLatency += rtt; count++; }
          
          // 자동 적응: 네트워크 상태에 따라 비트레이트 조절
          if (autoAdapt) {
            const sender = peer.pc.getSenders().find(s => s.track?.kind === 'audio');
            if (sender) {
              const params = sender.getParameters();
              if (params.encodings?.[0]) {
                const targetBitrate = audioModes[audioMode].bitrate;
                const currentBitrate = params.encodings[0].maxBitrate || targetBitrate;
                let newBitrate = currentBitrate;
                
                // 품질 저하 시 비트레이트 감소
                if (lossRate > 3 || jitter > 40) {
                  newBitrate = Math.max(16000, currentBitrate * 0.8);
                } 
                // 품질 좋으면 점진적 복구
                else if (lossRate < 1 && jitter < 20 && currentBitrate < targetBitrate) {
                  newBitrate = Math.min(targetBitrate, currentBitrate * 1.1);
                }
                
                if (newBitrate !== currentBitrate) {
                  params.encodings[0].maxBitrate = Math.round(newBitrate);
                  sender.setParameters(params).catch(e => { if (DEBUG) console.debug('Silent error:', e); });
                }
              }
            }
          }
        } catch (e) {}
      }
      
      // Update self stats with aggregated WebRTC data
      if (peerCount > 0) {
        selfStats.bandwidth = Math.round(totalBandwidth / peerCount);
        selfStats.packetsLost = Math.round(totalPacketLoss / peerCount);
        updateSelfStatsUI();
      }
    }
    
    // 지연 보상 적용
    if (delayCompensation) applyDelayCompensation();
    
    // 자동 지터 버퍼 조절
    autoAdjustJitter();
    
    // 핑 그래프용 히스토리 저장
    const latency = selfStats.latency || selfStats.socketLatency || 0;
    if (latency > 0) {
      latencyHistory.push(Math.round(latency));
      if (latencyHistory.length > 30) latencyHistory.shift();
      renderPingGraph();
    }
    
    renderUsers();
  }, 2000);
}

function updateSelfStatsUI() {
  const latencyEl = $('self-latency');
  const bandwidthEl = $('self-bandwidth');
  
  if (latencyEl) {
    const lat = selfStats.latency || 0;
    latencyEl.textContent = lat > 0 ? lat : '-';
    // Color code latency
    if (lat > 100) latencyEl.style.color = '#ff4757';
    else if (lat > 50) latencyEl.style.color = '#ffa502';
    else latencyEl.style.color = '#2ed573';
  }
  
  if (bandwidthEl) {
    bandwidthEl.textContent = currentBitrate || selfStats.bandwidth || '-';
  }
}

// 지연 보상: 가장 느린 피어에 맞춰 다른 피어들에게 딜레이 추가
function applyDelayCompensation() {
  let maxLatency = 0;
  peers.forEach(peer => {
    if (peer.latency > maxLatency) maxLatency = peer.latency;
  });
  
  peers.forEach(peer => {
    if (peer.delayNode && peer.latency !== null) {
      const compensation = Math.max(0, (maxLatency - peer.latency) / 1000); // ms -> sec
      peer.delayNode.delayTime.setTargetAtTime(compensation, peer.audioContext.currentTime, 0.1);
    }
  });
}

function updateJitterBuffer(value) {
  const minBuffer = proMode ? 5 : (lowLatencyMode ? 10 : 20);
  jitterBuffer = Math.min(200, Math.max(minBuffer, value));
  localStorage.setItem('styx-jitter-buffer', jitterBuffer);
  
  // UI 동기화
  if ($('jitter-slider')) {
    $('jitter-slider').value = jitterBuffer;
    $('jitter-value').textContent = jitterBuffer + 'ms';
  }
  if ($('room-jitter-slider')) {
    $('room-jitter-slider').value = jitterBuffer;
    $('room-jitter-value').textContent = jitterBuffer + 'ms';
  }
  
  applyJitterBuffer();
  
  // Tauri UDP 지터 버퍼도 설정
  if (actuallyTauri) {
    tauriInvoke('set_jitter_buffer', { size: Math.round(jitterBuffer / 10) }).catch(e => { if (DEBUG) console.debug('Silent error:', e); });
  }
}

// 지터 버퍼 적용 (기존 피어에)
function applyJitterBuffer() {
  peers.forEach(peer => {
    if (peer.pc?.getReceivers) {
      peer.pc.getReceivers().forEach(receiver => {
        if (receiver.track?.kind === 'audio' && receiver.playoutDelayHint !== undefined) {
          receiver.playoutDelayHint = jitterBuffer / 1000;
        }
      });
    }
  });
}

// 지터 버퍼 설정 (UI 동기화 포함)
function setJitterBuffer(value) {
  const minBuffer = proMode ? 5 : (lowLatencyMode ? 10 : 20);
  jitterBuffer = Math.min(200, Math.max(minBuffer, value));
  localStorage.setItem('styx-jitter-buffer', jitterBuffer);
  
  // UI 동기화
  if ($('jitter-slider')) {
    $('jitter-slider').value = jitterBuffer;
    $('jitter-value').textContent = jitterBuffer + 'ms';
  }
  if ($('room-jitter-slider')) {
    $('room-jitter-slider').value = jitterBuffer;
    $('room-jitter-value').textContent = jitterBuffer + 'ms';
  }
  
  applyJitterBuffer();
  
  // Tauri UDP 지터 버퍼도 설정
  if (actuallyTauri) {
    tauriInvoke('set_jitter_buffer', { size: Math.round(jitterBuffer / 10) }).catch(e => { if (DEBUG) console.debug('Silent error:', e); });
  }
}

// 실시간 자동 지터 버퍼 조절 (세션 중) - Enhanced
function autoAdjustJitter() {
  if (!autoJitter || peers.size === 0) return;
  
  let maxJitter = 0, maxLoss = 0, avgLatency = 0;
  let peerCount = 0;
  
  peers.forEach(peer => {
    if (peer.jitter > maxJitter) maxJitter = peer.jitter;
    if (peer.packetLoss > maxLoss) maxLoss = peer.packetLoss;
    if (peer.latency) {
      avgLatency += peer.latency;
      peerCount++;
    }
  });
  
  if (peerCount > 0) avgLatency /= peerCount;
  
  // Smarter buffer sizing based on network conditions
  let target = 50; // 기본값
  
  // High packet loss or jitter - increase buffer significantly
  if (maxLoss > 5 || maxJitter > 50) {
    target = 120;
  } else if (maxLoss > 3 || maxJitter > 30) {
    target = 100;
  } else if (maxLoss > 1 || maxJitter > 15) {
    target = 70;
  } else if (maxLoss < 0.5 && maxJitter < 5 && avgLatency < 30) {
    // Excellent conditions - can use smaller buffer
    target = 30;
  }
  
  // Consider connection type (WiFi needs larger buffer)
  if (navigator.connection?.type === 'wifi') {
    target += 10;
  }
  
  // Gradual adjustment to prevent audio glitches
  const diff = target - jitterBuffer;
  if (Math.abs(diff) > 5) {
    const step = Math.sign(diff) * Math.min(Math.abs(diff), 15);
    const newValue = Math.max(20, Math.min(150, jitterBuffer + step));
    setJitterBuffer(newValue);
    
    // Log adjustment for debugging
    if (DEBUG) {
      log(`Buffer adjusted: ${jitterBuffer}ms → ${newValue}ms (loss: ${maxLoss}%, jitter: ${maxJitter}ms)`);
    }
  }
  
  // Update quality indicator
  updateQualityIndicator(maxJitter, maxLoss);
}

// Real-time connection quality indicator
function updateQualityIndicator(jitter = 0, packetLoss = 0) {
  // Module version doesn't have all the local state, use local implementation
  const indicator = $('quality-indicator');
  if (!indicator) return;
  
  indicator.classList.remove('hidden');
  
  let quality = 'excellent';
  let text = '우수';
  
  if (packetLoss > 5 || jitter > 50) {
    quality = 'poor';
    text = '불안정';
  } else if (packetLoss > 2 || jitter > 25) {
    quality = 'fair'; 
    text = '보통';
  } else if (packetLoss > 0.5 || jitter > 10) {
    quality = 'good';
    text = '양호';
  }
  
  indicator.className = `quality-indicator ${quality}`;
  indicator.querySelector('.quality-text').textContent = text;
  
  // E2E latency estimate: network RTT/2 + jitter buffer + processing
  const networkLatency = networkTestResults.latency / 2 || 10;
  const processingLatency = proMode ? 2 : 10;
  const e2eLatency = Math.round(networkLatency + jitterBuffer + processingLatency);
  const latencyEl = indicator.querySelector('.latency-text');
  if (latencyEl) latencyEl.textContent = `${e2eLatency}ms`;
}

// VAD (음성 활동 감지)
function startVAD(peerId, analyser) {
  const dataArray = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
  const threshold = 30; // 음성 감지 임계값
  
  const interval = setInterval(() => {
    const peer = peers.get(peerId);
    if (!peer || !peers.has(peerId)) { 
      clearInterval(interval); 
      vadIntervals.delete(peerId);
      return; 
    }
    
    let avg = 0;
    if (analyser && dataArray) {
      analyser.getByteFrequencyData(dataArray);
      avg = dataArray.reduce((a, b) => a + b) / dataArray.length;
    }
    
    const wasSpeaking = peer.isSpeaking;
    peer.isSpeaking = avg > threshold;
    
    // 볼륨 바 업데이트 (0-255 -> 0-100%)
    const volumeLevel = Math.min(100, (avg / 255) * 100);
    const volumeBar = document.querySelector(`.volume-bar[data-peer="${peerId}"]`);
    if (volumeBar) {
      volumeBar.style.width = `${volumeLevel}%`;
    }
    
    // 상태 변경 시 UI 업데이트
    if (wasSpeaking !== peer.isSpeaking) {
      renderUsers();
      // 덕킹 적용
      if (duckingEnabled) applyDucking();
    }
  }, 100);
  
  // VAD 인터벌 저장 (정리용)
  const peer = peers.get(peerId);
  if (peer) peer.vadInterval = interval;
  vadIntervals.set(peerId, interval);
}

// 덕킹 (다른 사람 말할 때 볼륨 낮춤)
function applyDucking() {
  const speakingPeers = [];
  peers.forEach((peer, id) => {
    if (peer.isSpeaking) speakingPeers.push(id);
  });
  
  peers.forEach((peer, id) => {
    if (!peer.gainNode) return;
    
    if (speakingPeers.length > 0 && !speakingPeers.includes(id)) {
      // 다른 사람이 말하고 있으면 볼륨 낮춤
      peer.gainNode.gain.setTargetAtTime(0.3, peer.audioContext.currentTime, 0.1);
    } else {
      // 원래 볼륨으로
      peer.gainNode.gain.setTargetAtTime(1, peer.audioContext.currentTime, 0.1);
    }
  });
}

// 핑 그래프 렌더링
function renderPingGraph() {
  const canvas = $('ping-graph');
  if (!canvas || latencyHistory.length < 2) return;
  
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const max = Math.max(200, ...latencyHistory);
  
  ctx.clearRect(0, 0, w, h);
  
  // 배경 그리드
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = (h / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  
  // 핑 라인
  ctx.strokeStyle = '#e94560';
  ctx.lineWidth = 2;
  ctx.beginPath();
  
  const step = w / (latencyHistory.length - 1);
  latencyHistory.forEach((ping, i) => {
    const x = i * step;
    const y = h - (ping / max) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  
  // 현재 값 표시
  const current = latencyHistory[latencyHistory.length - 1];
  ctx.fillStyle = '#eee';
  ctx.font = '12px sans-serif';
  ctx.fillText(`${current}ms`, w - 40, 15);
}

// 소켓 이벤트
socket.on('sfu-mode-changed', ({ enabled }) => {
  sfuMode = enabled;
  toast(enabled ? '🔀 SFU 모드 활성화 (서버 믹싱)' : '🔗 P2P 모드 (직접 연결)', 'info');
  updateSfuButton();
});

socket.on('user-joined', ({ id, username, avatar, role }) => {
  log(`새 사용자 입장: ${username} (${id}), role=${role}`);
  playSound('join');
  toast(`${username} 입장`, 'info', 2000);
  
  if (!peers.has(id)) {
    peers.set(id, {
      pc: { connectionState: actuallyTauri ? 'connected' : 'new' },
      username,
      avatar,
      role,
      audioEl: null,
      latency: null,
      volume: 100,
      packetLoss: 0,
      jitter: 0,
      bitrate: 0,
      quality: { grade: actuallyTauri ? 'good' : 'fair', label: actuallyTauri ? 'UDP' : '관전', color: actuallyTauri ? '#2ed573' : '#ffa502' },
      pan: 0,
      muted: false,
      solo: false,
      isSpeaking: false
    });
    renderUsers();
    
    // Tauri: Attempt P2P with new peer
    if (actuallyTauri) initiateP2P(id);
  }
});

socket.on('offer', async ({ from, offer }) => {
  // 브라우저는 관전 모드 - WebRTC offer 무시
  log(`WebRTC offer 무시 (관전 모드): ${from}`);
});

socket.on('answer', async ({ from, answer }) => {
  // 브라우저는 관전 모드 - WebRTC answer 무시
  log(`WebRTC answer 무시 (관전 모드): ${from}`);
});

socket.on('ice-candidate', async ({ from, candidate }) => {
  // 브라우저는 관전 모드 - ICE 후보 무시
});

socket.on('user-left', ({ id }) => {
  // Remove peer from peers Map
  const peer = peers.get(id);
  if (peer) {
    // Cleanup audio elements and connections
    if (peer.audioEl) {
      peer.audioEl.srcObject = null;
      peer.audioEl.remove();
    }
    if (peer.pc && peer.pc.close) {
      try { peer.pc.close(); } catch {}
    }
    peers.delete(id);
  }
  
  playSound('leave');
  toast(`사용자 퇴장`, 'info', 2000);
  renderUsers();
});

socket.on('user-updated', ({ id, avatar }) => {
  const peer = peers.get(id);
  if (peer) {
    peer.avatar = avatar;
    renderUsers();
  }
});

// 역할 변경 수신
socket.on('role-changed', ({ userId, role }) => {
  if (userId === socket.id) {
    myRole = role;
    updateRoleUI();
    if (role === 'listener' && localStream) {
      localStream.getAudioTracks().forEach(t => t.enabled = false);
      isMuted = true;
      updateMuteUI();
      toast('청취자로 변경됨 - 오디오 전송 비활성화', 'info');
    } else if (role === 'performer') {
      toast('연주자로 변경됨', 'info');
    }
  } else {
    const peer = peers.get(userId);
    if (peer) {
      peer.role = role;
      renderUsers();
    }
  }
});

function updateRoleUI() {
  const roleLabels = { host: '🎯 호스트', performer: '🎸 연주자', listener: '👂 청취자' };
  const badge = $('my-role-badge');
  if (badge) badge.textContent = roleLabels[myRole] || '';
  
  // listener는 음소거 버튼 비활성화
  if ($('muteBtn')) {
    $('muteBtn').disabled = myRole === 'listener';
    $('muteBtn').title = myRole === 'listener' ? '청취자는 오디오 전송 불가' : '음소거 (M)';
  }
}

// 음소거
// 음소거 UI 업데이트
function updateMuteUI() {
  // Don't delegate - uses local isMuted state
  const btn = $('muteBtn');
  if (btn) {
    btn.textContent = isMuted ? '🔇' : '🎤';
    btn.classList.toggle('muted', isMuted);
  }
}

// 오디오 스트림 재시작 (설정 변경 시)
let restartingAudio = false;
async function restartAudioStream() {
  if (!localStream || restartingAudio) return;
  restartingAudio = true;
  
  try {
    // Stop old streams
    const oldTracks = localStream.getAudioTracks();
    oldTracks.forEach(t => t.stop());
  
    // Stop raw stream if it exists
    if (localStream._rawStream) {
      localStream._rawStream.getAudioTracks().forEach(t => t.stop());
    }
  
    // Close old audio context and reset shared context
    if (inputLimiterContext && inputLimiterContext.state !== 'closed') {
      try { inputLimiterContext.close(); } catch {}
    }
    inputLimiterContext = null;
    if (sharedAudioContext && sharedAudioContext.state !== 'closed') {
      try { sharedAudioContext.close(); } catch {}
    }
    sharedAudioContext = null;
  
    // Small delay to let audio device release
    await new Promise(r => setTimeout(r, 100));
  
    const rawStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
        echoCancellation: $('room-echo-cancel')?.checked ?? $('echo-cancel')?.checked ?? true,
        noiseSuppression: $('room-noise-suppress')?.checked ?? $('noise-suppress')?.checked ?? true,
        autoGainControl: $('auto-gain')?.checked ?? true,
        sampleRate: SAMPLE_RATE,
        channelCount: 2,
        latency: { ideal: 0.01 }
      }
    });
    
    // Recreate processed stream with input limiter and effects
    localStream = await createProcessedInputStream(rawStream);
    localStream._rawStream = rawStream;
    
    const newTrack = localStream.getAudioTracks()[0];
    
    // 모든 피어 연결에 새 트랙 적용
    peers.forEach(peer => {
      if (!peer.pc?.getSenders) return;
      const sender = peer.pc.getSenders().find(s => s.track?.kind === 'audio');
      if (sender) sender.replaceTrack(newTrack);
    });
    
    // 음소거 상태 유지
    if (isMuted || pttMode) {
      newTrack.enabled = false;
    }
    
    // Restart audio meter if it was running
    if (actuallyTauri) {
      startAudioMeter();
    }
    
    toast('오디오 설정 적용됨', 'success', 2000);
    
  } catch (e) {
    console.error('오디오 스트림 재시작 실패:', e);
    toast('오디오 설정 변경 실패 - 다시 시도해주세요', 'error');
    // Reset contexts on error
    sharedAudioContext = null;
    inputLimiterContext = null;
  } finally {
    restartingAudio = false;
  }
}

$('muteBtn').onclick = () => {
  isMuted = !isMuted;
  localStream?.getAudioTracks().forEach(t => t.enabled = !isMuted);
  $('muteBtn').textContent = isMuted ? '🔇' : '🎤';
  $('muteBtn').classList.toggle('muted', isMuted);
  setUdpMuted(isMuted);
};

// 방 나가기
$('leaveBtn').onclick = () => {
  if (!confirm('방을 나가시겠습니까?')) return;
  leaveRoom();
};

function leaveRoom() {
  // 서버에 방 나가기 알림
  socket.emit('leave-room');
  
  // 모든 타이머 정리
  if (latencyInterval) { clearInterval(latencyInterval); latencyInterval = null; }
  if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
  if (meterInterval) { clearInterval(meterInterval); meterInterval = null; }
  if (tcpAudioInterval) { clearInterval(tcpAudioInterval); tcpAudioInterval = null; }
  if (udpStatsInterval) { clearInterval(udpStatsInterval); udpStatsInterval = null; }
  if (metronomeInterval) { clearInterval(metronomeInterval); metronomeInterval = null; }
  if (turnRefreshTimer) { clearTimeout(turnRefreshTimer); turnRefreshTimer = null; }
  if (networkQualityInterval) { clearInterval(networkQualityInterval); networkQualityInterval = null; }
  
  // VAD 인터벌 정리
  vadIntervals.forEach(int => clearInterval(int));
  vadIntervals.clear();
  
  stopMetronome();
  cleanupRecording();
  if (cleanupTuner) cleanupTuner();
  if (cleanupSound) cleanupSound();
  if (cleanupGlobalListeners) cleanupGlobalListeners();
  if (isScreenSharing) stopScreenShare();
  
  // 모든 AudioContext 정리
  const contexts = [audioContext, metronomeAudio, peerAudioContext, inputLimiterContext, inputMonitorCtx];
  contexts.forEach(ctx => {
    if (ctx && ctx.state !== 'closed') {
      try { 
        ctx.close(); 
      } catch (e) { 
        console.warn('AudioContext cleanup failed:', e); 
      }
    }
  });
  
  // 전역 변수 초기화
  audioContext = null;
  metronomeAudio = null;
  peerAudioContext = null;
  inputLimiterContext = null;
  sharedAudioContext = null;
  inputMonitorCtx = null;
  processedStream = null;
  effectNodes = {};
  noiseGateWorklet = null;
  
  peers.forEach(peer => {
    if (peer.pc?.close) peer.pc.close();
    if (peer.audioEl) peer.audioEl.remove();
    // 오디오 노드 연결 해제
    if (peer.audioNodes) {
      try {
        peer.audioNodes.source.disconnect();
      } catch {}
    }
  });
  peers.clear();
  volumeStates.clear();
  
  // Cleanup P2P and sync mode state
  peerConnections.clear();
  peerLatencies.clear();
  clearSyncDelays?.(); // Use sync.js module function
  syncMode = false;
  sfuMode = false;
  isRoomCreator = false;
  currentRoomSettings = {};
  roomCreatorUsername = '';
  
  latencyHistory = [];
  
  // 원본 스트림도 정리
  localStream?._rawStream?.getTracks().forEach(t => t.stop());
  localStream?.getTracks().forEach(t => t.stop());
  localStream = null;
  
  // 상태 초기화
  isMuted = false;
  isPttActive = false;
  
  // 오디오 정리
  cleanupAudio();
  
  socket.room = null;
  lastRoom = null;
  lastRoomPassword = null;
  sessionStorage.removeItem('styx-room');
  sessionStorage.removeItem('styx-room-pw');
  roomView.classList.add('hidden');
  lobby.classList.remove('hidden');
  loadRoomList();
  
}

// ===== 마이크 테스트 =====
let testStream = null;
let testAnalyser = null;
let testAnimationId = null;
let testAudioCtx = null;

$('test-audio-btn').onclick = async () => {
  const btn = $('test-audio-btn');
  
  if (testStream) {
    // 테스트 중지
    testStream.getTracks().forEach(t => t.stop());
    testStream = null;
    if (testAnimationId) cancelAnimationFrame(testAnimationId);
    if (testAudioCtx) { try { testAudioCtx.close(); } catch {} testAudioCtx = null; }
    $('mic-level').style.width = '0%';
    btn.textContent = '🎤 마이크';
    return;
  }
  
  try {
    testStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
        echoCancellation: $('adv-echo-cancel')?.checked ?? true,
        noiseSuppression: $('adv-noise-suppress')?.checked ?? true,
        channelCount: 2 // Stereo support
      }
    });
    
    testAudioCtx = new AudioContext();
    const source = testAudioCtx.createMediaStreamSource(testStream);
    testAnalyser = testAudioCtx.createAnalyser();
    testAnalyser.fftSize = 256;
    source.connect(testAnalyser);
    
    btn.textContent = '⏹️ 중지';
    
    const dataArray = new Uint8Array(testAnalyser.frequencyBinCount);
    function updateLevel() {
      if (!testStream) return;
      testAnalyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b) / dataArray.length;
      $('mic-level').style.width = Math.min(100, avg * 1.5) + '%';
      testAnimationId = requestAnimationFrame(updateLevel);
    }
    updateLevel();
    
  } catch (e) {
    toast('마이크 접근이 거부되었습니다', 'error');
  }
};

// 네트워크 테스트 버튼
$('test-network-btn')?.addEventListener('click', async () => {
  const btn = $('test-network-btn');
  btn.disabled = true;
  btn.textContent = '테스트 중...';
  
  const results = await runConnectionTest();
  showTestResults(results);
  
  btn.disabled = false;
  btn.textContent = '📡 네트워크';
});

// ===== 방 생성 모달 =====
let roomTemplates = {};
try { roomTemplates = JSON.parse(localStorage.getItem('styx-room-templates') || '{}'); } catch {}

function saveRoomTemplate(name) {
  if (!name?.trim()) return toast('템플릿 이름을 입력하세요', 'error');
  const settings = {
    maxUsers: parseInt($('new-room-max-users')?.value, 10) || 8,
    audioMode: $('new-room-audio-mode')?.value || 'music',
    sampleRate: parseInt($('new-room-sample-rate')?.value, 10) || 48000,
    bitrate: parseInt($('new-room-bitrate')?.value, 10) || 96,
    bpm: parseInt($('new-room-bpm')?.value, 10) || 120,
    isPrivate: $('new-room-private')?.checked || false
  };
  if (M.settings?.saveRoomTemplate) M.settings.saveRoomTemplate(name, settings);
  else { roomTemplates[name] = settings; localStorage.setItem('styx-room-templates', JSON.stringify(roomTemplates)); }
  updateTemplateSelect();
  toast(`템플릿 "${name}" 저장됨`, 'success');
}

function loadRoomTemplate(name) {
  const templates = M.settings?.getRoomTemplates ? M.settings.getRoomTemplates() : roomTemplates;
  const t = templates[name];
  if (!t) return;
  if ($('new-room-max-users')) $('new-room-max-users').value = t.maxUsers;
  if ($('new-room-audio-mode')) $('new-room-audio-mode').value = t.audioMode;
  if ($('new-room-sample-rate')) $('new-room-sample-rate').value = t.sampleRate;
  if ($('new-room-bitrate')) $('new-room-bitrate').value = t.bitrate;
  if ($('new-room-bpm')) $('new-room-bpm').value = t.bpm;
  if ($('new-room-private')) $('new-room-private').checked = t.isPrivate;
  toast(`템플릿 "${name}" 적용됨`, 'info');
}

function deleteRoomTemplate(name) {
  if (M.settings?.deleteRoomTemplate) M.settings.deleteRoomTemplate(name);
  else { delete roomTemplates[name]; localStorage.setItem('styx-room-templates', JSON.stringify(roomTemplates)); }
  updateTemplateSelect();
  toast(`템플릿 "${name}" 삭제됨`, 'info');
}

function updateTemplateSelect() {
  const sel = $('room-template-select');
  if (!sel) return;
  const templates = M.settings?.getRoomTemplates ? M.settings.getRoomTemplates() : roomTemplates;
  const names = Object.keys(templates);
  sel.innerHTML = '<option value="">-- 템플릿 선택 --</option>' + 
    names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
}

window.openCreateRoomModal = () => {
  $('create-room-modal').classList.remove('hidden');
  $('new-room-name').value = '';
  $('new-room-password').value = '';
  updateTemplateSelect();
  $('new-room-name').focus();
};

window.closeCreateRoomModal = () => {
  $('create-room-modal').classList.add('hidden');
};

window.createRoom = () => {
  const name = $('new-room-name').value.trim();
  const password = $('new-room-password').value;
  
  if (!name) {
    toast('방 이름을 입력하세요', 'error');
    return;
  }
  
  // 방 설정 수집
  const maxUsersEl = $('new-room-max-users');
  const settings = {
    maxUsers: maxUsersEl ? parseInt(maxUsersEl.value, 10) : 8,
    audioMode: $('new-room-audio-mode')?.value || 'music',
    sampleRate: parseInt($('new-room-sample-rate')?.value, 10) || 48000,
    bitrate: parseInt($('new-room-bitrate')?.value, 10) || 96,
    bpm: parseInt($('new-room-bpm')?.value, 10) || 120,
    isPrivate: $('new-room-private')?.checked || false
  };
  
  log('Room settings:', settings);
  
  closeCreateRoomModal();
  joinRoom(name, !!password, password, settings);
};

// 방 만들기 버튼 이벤트
$('createRoomBtn').onclick = openCreateRoomModal;

// 방 설정 표시
function displayRoomSettings() {
  const container = $('room-settings-display');
  if (!container) return;
  
  const s = currentRoomSettings;
  const modeLabel = s.audioMode === 'voice' ? '🎤 음성' : '🎸 악기';
  const creatorLabel = roomCreatorUsername ? ` (방장: ${roomCreatorUsername})` : '';
  const syncLabel = syncMode ? '🔄 동기화' : '⚡ 저지연';
  
  // 방장이면 변경 가능한 UI 표시
  if (isRoomCreator || currentUser?.isAdmin) {
    container.innerHTML = `
      <span class="room-setting-item" title="오디오 모드">
        <select id="room-mode-select" class="room-setting-select">
          <option value="voice" ${s.audioMode === 'voice' ? 'selected' : ''}>🎤 음성</option>
          <option value="music" ${s.audioMode === 'music' ? 'selected' : ''}>🎸 악기</option>
        </select>
      </span>
      <span class="room-setting-item" title="동기화 모드 (모든 사용자가 동일한 타이밍에 듣기)">
        <select id="room-sync-select" class="room-setting-select">
          <option value="jam" ${!syncMode ? 'selected' : ''}>⚡ Jam</option>
          <option value="sync" ${syncMode ? 'selected' : ''}>🔄 Sync</option>
        </select>
      </span>
      <span class="room-setting-item" title="비트레이트">
        <select id="room-bitrate-select" class="room-setting-select">
          <option value="64" ${s.bitrate === 64 ? 'selected' : ''}>64k</option>
          <option value="96" ${s.bitrate === 96 ? 'selected' : ''}>96k</option>
          <option value="128" ${s.bitrate === 128 ? 'selected' : ''}>128k</option>
          <option value="192" ${s.bitrate === 192 ? 'selected' : ''}>192k</option>
        </select>
      </span>
      <span class="room-setting-item">${s.maxUsers || 8}명${creatorLabel}</span>
    `;
    // 변경 이벤트
    $('room-mode-select').onchange = (e) => updateRoomSetting('audioMode', e.target.value);
    $('room-sync-select').onchange = (e) => updateRoomSetting('syncMode', e.target.value === 'sync');
    $('room-bitrate-select').onchange = (e) => updateRoomSetting('bitrate', parseInt(e.target.value));
  } else {
    container.innerHTML = `
      <span class="room-setting-item">${modeLabel}</span>
      <span class="room-setting-item">${syncLabel}</span>
      <span class="room-setting-item">${s.bitrate || 96}kbps</span>
      <span class="room-setting-item">${s.maxUsers || 8}명${creatorLabel}</span>
    `;
  }
}

// 방 설정 변경
function updateRoomSetting(setting, value) {
  socket.emit('update-room-settings', { setting, value }, res => {
    if (res?.error) {
      toast('설정 변경 실패: ' + res.error, 'error');
    }
  });
}

// 방 설정 변경 수신
socket.on('room-settings-changed', ({ setting, value }) => {
  currentRoomSettings[setting] = value;
  
  // Update local variables BEFORE displayRoomSettings
  if (setting === 'audioMode') {
    audioMode = value;
    peers.forEach(peer => applyAudioSettings(peer.pc));
    toast(`오디오 모드: ${value === 'voice' ? '음성' : '악기'}`, 'info');
  }
  if (setting === 'bitrate') {
    toast(`비트레이트: ${value}kbps`, 'info');
  }
  if (setting === 'syncMode') {
    syncMode = value;
    if (syncMode) {
      toast('🔄 동기화 모드: 장치 지연 측정 중...', 'info');
      calibrateDeviceLatency();
      setTimeout(() => {
        broadcastLatency();
        calculateSyncDelays();
        toast(`🔄 동기화 완료 (총 지연: ${window.StyxSync?.maxRoomLatency || 0}ms)`, 'success');
      }, 500);
    } else {
      toast('⚡ Jam 모드: 최저 지연시간 우선', 'info');
      clearSyncDelays();
    }
  }
  
  // Update UI after variables are set
  displayRoomSettings();
});

// 방 내 오디오 설정 동기화
function syncRoomAudioSettings() {
  const roomInput = $('room-audio-device');
  const roomOutput = $('room-audio-output');
  const lobbyInput = $('audio-device');
  const lobbyOutput = $('audio-output');
  
  if (lobbyInput && roomInput) {
    roomInput.innerHTML = lobbyInput.innerHTML;
    roomInput.value = lobbyInput.value;
  }
  if (lobbyOutput && roomOutput) {
    roomOutput.innerHTML = lobbyOutput.innerHTML;
    roomOutput.value = lobbyOutput.value;
  }
  
  // Sync checkboxes from lobby to room
  const syncCheckbox = (lobbyId, roomId) => {
    const lobby = $(lobbyId), room = $(roomId);
    if (lobby && room) room.checked = lobby.checked;
  };
  syncCheckbox('ptt-mode', 'room-ptt-mode');
  syncCheckbox('auto-jitter', 'room-auto-jitter');
  
  // Sync jitter slider
  const lobbySlider = $('jitter-slider'), roomSlider = $('room-jitter-slider');
  if (lobbySlider && roomSlider) {
    roomSlider.value = lobbySlider.value;
    if ($('room-jitter-value')) $('room-jitter-value').textContent = lobbySlider.value + 'ms';
  }
}

// 방 내 오디오 장치 변경
if ($('room-audio-device')) {
  $('room-audio-device').onchange = async (e) => {
    selectedDeviceId = e.target.value;
    if (localStream) await restartAudioStream();
  };
}

if ($('room-audio-output')) {
  $('room-audio-output').onchange = (e) => {
    selectedOutputId = e.target.value;
    peers.forEach(peer => {
      if (peer.audioEl?.setSinkId) peer.audioEl.setSinkId(selectedOutputId).catch(e => { if (DEBUG) console.debug('Silent error:', e); });
    });
  };
}

if ($('room-ptt-mode')) {
  $('room-ptt-mode').onchange = (e) => {
    pttMode = e.target.checked;
    if (pttMode && localStream) {
      localStream.getAudioTracks().forEach(t => t.enabled = false);
      isMuted = true;
      updateMuteUI();
    }
  };
}

// 방 내 지터 슬라이더
if ($('room-jitter-slider')) {
  $('room-jitter-slider').value = jitterBuffer;
  $('room-jitter-value').textContent = jitterBuffer + 'ms';
  $('room-jitter-slider').oninput = () => {
    jitterBuffer = parseInt($('room-jitter-slider').value);
    $('room-jitter-value').textContent = jitterBuffer + 'ms';
    localStorage.setItem('styx-jitter-buffer', jitterBuffer);
    // 로비 슬라이더도 동기화
    if ($('jitter-slider')) {
      $('jitter-slider').value = jitterBuffer;
      $('jitter-value').textContent = jitterBuffer + 'ms';
    }
    // 기존 피어에 지터 버퍼 적용
    applyJitterBuffer();
  };
}

// 연결 진단 기능
let jitterHistory = [];
let sessionStats = { startTime: null, latencies: [], jitters: [], packetsRecv: 0, packetsLost: 0 };

function openDiagnostics() {
  $('diagnostics-modal')?.classList.remove('hidden');
  updateDiagnostics();
}

function closeDiagnostics() {
  $('diagnostics-modal')?.classList.add('hidden');
}

function updateDiagnostics() {
  // Latency chart
  const latencyCanvas = $('diag-latency-chart');
  if (latencyCanvas) {
    const ctx = latencyCanvas.getContext('2d');
    ctx.clearRect(0, 0, 400, 120);
    if (latencyHistory.length === 0) {
      ctx.fillStyle = '#888';
      ctx.font = '14px sans-serif';
      ctx.fillText('데이터 수집 중...', 150, 60);
    } else {
      ctx.strokeStyle = '#8b7cf7';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const max = Math.max(100, ...latencyHistory);
    latencyHistory.forEach((v, i) => {
      const x = (i / (latencyHistory.length - 1)) * 400;
      const y = 120 - (v / max) * 100;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    
    // Stats
    const avg = Math.round(latencyHistory.reduce((a, b) => a + b, 0) / latencyHistory.length);
    $('diag-avg-latency').textContent = avg;
    $('diag-min-latency').textContent = Math.min(...latencyHistory);
    $('diag-max-latency').textContent = Math.max(...latencyHistory);
    }
  }
  
  // Jitter histogram
  const jitterCanvas = $('diag-jitter-chart');
  if (jitterCanvas && jitterHistory.length > 0) {
    const ctx = jitterCanvas.getContext('2d');
    ctx.clearRect(0, 0, 400, 100);
    const buckets = [0, 0, 0, 0, 0]; // 0-5, 5-10, 10-20, 20-50, 50+
    jitterHistory.forEach(j => {
      if (j < 5) buckets[0]++;
      else if (j < 10) buckets[1]++;
      else if (j < 20) buckets[2]++;
      else if (j < 50) buckets[3]++;
      else buckets[4]++;
    });
    const maxBucket = Math.max(...buckets, 1);
    const labels = ['<5ms', '5-10', '10-20', '20-50', '50+'];
    buckets.forEach((count, i) => {
      const h = (count / maxBucket) * 80;
      ctx.fillStyle = i < 2 ? '#2ed573' : i < 4 ? '#ffa502' : '#ff4757';
      ctx.fillRect(i * 80 + 10, 100 - h, 60, h);
      ctx.fillStyle = '#888';
      ctx.font = '10px sans-serif';
      ctx.fillText(labels[i], i * 80 + 20, 95);
    });
  }
  
  // Packet stats
  if (actuallyTauri) {
    tauriInvoke('get_udp_stats').then(stats => {
      $('diag-packets-recv').textContent = stats.packets_received;
      $('diag-packets-lost').textContent = stats.packets_lost;
      $('diag-loss-rate').textContent = stats.loss_rate.toFixed(2);
    }).catch(e => { if (DEBUG) console.debug('Silent error:', e); });
  }
}

function exportSessionStats() {
  const stats = {
    exportTime: new Date().toISOString(),
    duration: sessionStats.startTime ? Math.round((Date.now() - sessionStats.startTime) / 1000) : 0,
    latency: {
      samples: latencyHistory.length,
      avg: latencyHistory.length ? Math.round(latencyHistory.reduce((a, b) => a + b, 0) / latencyHistory.length) : 0,
      min: latencyHistory.length ? Math.min(...latencyHistory) : 0,
      max: latencyHistory.length ? Math.max(...latencyHistory) : 0
    },
    jitter: {
      samples: jitterHistory.length,
      avg: jitterHistory.length ? Math.round(jitterHistory.reduce((a, b) => a + b, 0) / jitterHistory.length) : 0
    },
    packets: sessionStats
  };
  
  const blob = new Blob([JSON.stringify(stats, null, 2)], { type: 'application/json' });
  if (M.core?.downloadBlob) {
    M.core.downloadBlob(blob, `styx-session-${new Date().toISOString().slice(0, 10)}.json`);
    return toast('📥 세션 통계 내보내기 완료', 'success');
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `styx-session-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('📥 세션 통계 내보내기 완료', 'success');
}

// Track jitter for diagnostics
function trackJitter(jitter) {
  jitterHistory.push(jitter);
  if (jitterHistory.length > 100) jitterHistory.shift();
}

// Performance Mode (unified radio buttons)
function initPerformanceMode() {
  const radios = document.querySelectorAll('input[name="performance-mode"]');
  if (!radios.length) return;
  
  // Set initial state
  let currentMode = 'normal';
  if (proMode) currentMode = 'pro';
  else if (lowLatencyMode) currentMode = 'low-latency';
  
  radios.forEach(radio => {
    if (radio.value === currentMode) radio.checked = true;
    radio.onchange = async () => {
      const mode = radio.value;
      
      // Reset all modes
      lowLatencyMode = false;
      proMode = false;
      
      if (mode === 'low-latency') {
        lowLatencyMode = true;
      } else if (mode === 'pro') {
        proMode = true;
        lowLatencyMode = true; // Pro includes low-latency
      }
      
      localStorage.setItem('styx-low-latency', lowLatencyMode);
      localStorage.setItem('styx-pro-mode', proMode);
      
      applyLowLatencyMode();
      
      // Restart audio stream for pro mode
      if (localStream && mode === 'pro') {
        try {
          const rawStream = localStream._rawStream || localStream;
          processedStream = await createProcessedInputStream(rawStream);
          localStream = processedStream;
          localStream._rawStream = rawStream;
        } catch (e) {
          console.error('Mode switch failed:', e);
        }
      }
      
      const messages = {
        'normal': '🎵 일반 모드: 균형 잡힌 품질',
        'low-latency': '⚡ 저지연 모드: 빠른 응답',
        'pro': '🎸 Pro 모드: 최저 지연'
      };
      toast(messages[mode], 'info');
    };
  });
}
initPerformanceMode();

// Legacy checkbox handlers (for backward compatibility)
if ($('low-latency-mode')) {
  $('low-latency-mode').checked = lowLatencyMode;
  $('low-latency-mode').onchange = () => {
    lowLatencyMode = $('low-latency-mode').checked;
    localStorage.setItem('styx-low-latency', lowLatencyMode);
    applyLowLatencyMode();
    toast(lowLatencyMode ? '⚡ 저지연 모드 활성화' : '📊 일반 모드', 'info');
  };
  applyLowLatencyMode();
}

if ($('pro-mode')) {
  $('pro-mode').checked = proMode;
  $('pro-mode').onchange = async () => {
    proMode = $('pro-mode').checked;
    localStorage.setItem('styx-pro-mode', proMode);
    if (localStream) {
      try {
        const rawStream = localStream._rawStream || localStream;
        processedStream = await createProcessedInputStream(rawStream);
        localStream = processedStream;
        localStream._rawStream = rawStream;
      } catch (e) {
        console.error('Pro mode switch failed:', e);
      }
    }
    toast(proMode ? '🎸 Pro 모드 활성화' : '🎛️ 일반 모드', 'info');
  };
}

// DTX (Discontinuous Transmission) - saves bandwidth during silence
if ($('dtx-toggle')) {
  $('dtx-toggle').checked = dtxEnabled;
  $('dtx-toggle').onchange = () => {
    dtxEnabled = $('dtx-toggle').checked;
    localStorage.setItem('styx-dtx', dtxEnabled);
    if (actuallyTauri) {
      tauriInvoke('set_dtx_enabled', { enabled: dtxEnabled }).catch(e => { if (DEBUG) console.debug('Silent error:', e); });
    }
    toast(dtxEnabled ? '📉 DTX 켜짐' : '📉 DTX 꺼짐', 'info');
  };
}

// Comfort Noise - generates low-level noise during silence
if ($('comfort-noise-toggle')) {
  $('comfort-noise-toggle').checked = comfortNoiseEnabled;
  $('comfort-noise-toggle').onchange = () => {
    comfortNoiseEnabled = $('comfort-noise-toggle').checked;
    localStorage.setItem('styx-comfort-noise', comfortNoiseEnabled);
    if (actuallyTauri) {
      tauriInvoke('set_comfort_noise', { enabled: comfortNoiseEnabled }).catch(e => { if (DEBUG) console.debug('Silent error:', e); });
    }
    toast(comfortNoiseEnabled ? '🔇 컴포트 노이즈 켜짐' : '🔇 컴포트 노이즈 꺼짐', 'info');
  };
}

function applyLowLatencyMode() {
  if (lowLatencyMode) {
    // Aggressive settings for good networks
    jitterBuffer = 10;
    autoJitter = false;
    if ($('jitter-slider')) { $('jitter-slider').value = 10; $('jitter-slider').disabled = true; }
    if ($('jitter-value')) $('jitter-value').textContent = '10ms';
    if ($('auto-jitter')) { $('auto-jitter').checked = false; $('auto-jitter').disabled = true; }
    if ($('room-jitter-slider')) { $('room-jitter-slider').value = 10; $('room-jitter-slider').disabled = true; }
    if ($('room-jitter-value')) $('room-jitter-value').textContent = '10ms';
    if ($('room-auto-jitter')) { $('room-auto-jitter').checked = false; $('room-auto-jitter').disabled = true; }
  } else {
    // Restore normal settings
    jitterBuffer = parseInt(localStorage.getItem('styx-jitter-buffer')) || 50;
    autoJitter = localStorage.getItem('styx-auto-jitter') !== 'false';
    if ($('jitter-slider')) { $('jitter-slider').value = jitterBuffer; $('jitter-slider').disabled = autoJitter; }
    if ($('jitter-value')) $('jitter-value').textContent = jitterBuffer + 'ms';
    if ($('auto-jitter')) { $('auto-jitter').checked = autoJitter; $('auto-jitter').disabled = false; }
    if ($('room-jitter-slider')) { $('room-jitter-slider').value = jitterBuffer; $('room-jitter-slider').disabled = autoJitter; }
    if ($('room-jitter-value')) $('room-jitter-value').textContent = jitterBuffer + 'ms';
    if ($('room-auto-jitter')) { $('room-auto-jitter').checked = autoJitter; $('room-auto-jitter').disabled = false; }
  }
  localStorage.setItem('styx-jitter-buffer', jitterBuffer);
  localStorage.setItem('styx-auto-jitter', autoJitter);
  applyJitterBuffer();
  
  // Apply to Tauri UDP if available
  if (actuallyTauri) {
    tauriInvoke('set_jitter_buffer', { size: lowLatencyMode ? 1 : Math.round(jitterBuffer / 10) }).catch(e => { if (DEBUG) console.debug('Silent error:', e); });
  }
}

// 자동 지터 버퍼 토글 (로비)
if ($('auto-jitter')) {
  $('auto-jitter').checked = autoJitter;
  $('auto-jitter').onchange = () => {
    autoJitter = $('auto-jitter').checked;
    localStorage.setItem('styx-auto-jitter', autoJitter);
    if ($('room-auto-jitter')) $('room-auto-jitter').checked = autoJitter;
    $('jitter-slider').disabled = autoJitter;
  };
  $('jitter-slider').disabled = autoJitter;
}

// 자동 지터 버퍼 토글 (방)
if ($('room-auto-jitter')) {
  $('room-auto-jitter').checked = autoJitter;
  $('room-auto-jitter').onchange = () => {
    autoJitter = $('room-auto-jitter').checked;
    localStorage.setItem('styx-auto-jitter', autoJitter);
    if ($('auto-jitter')) $('auto-jitter').checked = autoJitter;
    $('room-jitter-slider').disabled = autoJitter;
  };
  $('room-jitter-slider').disabled = autoJitter;
}

// 지연 보상
if ($('delay-compensation')) {
  $('delay-compensation').onchange = () => {
    delayCompensation = $('delay-compensation').checked;
    socket.emit('delay-compensation', delayCompensation);
    if (delayCompensation) {
      toast('⚠️ 지연 보상: 모든 참가자의 지연이 증가합니다', 'warning', 5000);
    }
  };
}

// 멀티트랙 녹음 모드
if ($('multitrack-mode')) {
  $('multitrack-mode').checked = window.StyxRecording?.multitrackMode || false;
  $('multitrack-mode').onchange = () => {
    const enabled = $('multitrack-mode').checked;
    window.StyxRecording?.setMultitrackMode?.(enabled);
    if (enabled) {
      window.StyxRecording?.setLoopbackMode?.(false);
      if ($('loopback-mode')) $('loopback-mode').checked = false;
    }
    toast(enabled ? '멀티트랙: 각 참가자별 개별 파일 저장' : '믹스다운: 전체 믹스 저장', 'info');
  };
}

// 루프백 녹음 모드
if ($('loopback-mode')) {
  $('loopback-mode').checked = window.StyxRecording?.loopbackMode || false;
  $('loopback-mode').onchange = () => {
    const enabled = $('loopback-mode').checked;
    window.StyxRecording?.setLoopbackMode?.(enabled);
    if (enabled) {
      window.StyxRecording?.setMultitrackMode?.(false);
      if ($('multitrack-mode')) $('multitrack-mode').checked = false;
    }
    toast(enabled ? '루프백: 내가 듣는 소리만 녹음' : '믹스다운: 전체 믹스 저장', 'info');
  };
}

// 고급 설정 패널 토글
function toggleAdvancedPanel() {
  const panel = $('advanced-settings-panel');
  if (panel) panel.classList.toggle('hidden');
  $('effects-panel')?.classList.add('hidden');
}

$('advanced-settings-btn')?.addEventListener('click', toggleAdvancedPanel);

// 연결 모드 변경
document.querySelectorAll('input[name="connection-mode"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    const mode = e.target.value;
    if (mode === 'auto') {
      // 자동 모드 - 서버가 결정
      socket.emit('set-connection-preference', { mode: 'auto' });
      toast('🔄 연결 모드: 자동', 'info');
    } else if (mode === 'p2p') {
      // P2P 강제
      socket.emit('set-connection-preference', { mode: 'p2p' });
      toast('🔗 연결 모드: P2P 직접 연결', 'info');
    } else if (mode === 'sfu') {
      // SFU 강제
      socket.emit('set-sfu-mode', { enabled: true });
      toast('🔀 연결 모드: SFU 서버 믹싱', 'info');
    }
  });
});

// 고급 패널 오디오 처리 토글
$('adv-echo-cancel')?.addEventListener('change', async (e) => {
  echoCancellation = e.target.checked;
  localStorage.setItem('styx-echo', echoCancellation);
  if (localStream) await restartAudioStream();
});

$('adv-noise-suppress')?.addEventListener('change', async (e) => {
  noiseSuppression = e.target.checked;
  localStorage.setItem('styx-noise', noiseSuppression);
  if (localStream) await restartAudioStream();
});

$('adv-ai-noise')?.addEventListener('change', async (e) => {
  aiNoiseCancellation = e.target.checked;
  localStorage.setItem('styx-ai-noise', aiNoiseCancellation);
  if (localStream) await restartAudioStream();
});

$('adv-auto-gain')?.addEventListener('change', (e) => {
  autoGainControl = e.target.checked;
  localStorage.setItem('styx-auto-gain', autoGainControl);
});

// 고급 패널 성능 모드
document.querySelectorAll('input[name="adv-performance"]').forEach(radio => {
  radio.addEventListener('change', async (e) => {
    const mode = e.target.value;
    lowLatencyMode = mode === 'low-latency' || mode === 'pro';
    proMode = mode === 'pro';
    
    localStorage.setItem('styx-low-latency', lowLatencyMode);
    localStorage.setItem('styx-pro-mode', proMode);
    
    applyLowLatencyMode();
    
    if (localStream && proMode) {
      try {
        const rawStream = localStream._rawStream || localStream;
        processedStream = await createProcessedInputStream(rawStream);
        localStream = processedStream;
        localStream._rawStream = rawStream;
      } catch (e) { console.error('Mode switch failed:', e); }
    }
    
    const messages = { 'normal': '🎵 일반 모드', 'low-latency': '⚡ 저지연 모드', 'pro': '🎸 Pro 모드' };
    toast(messages[mode], 'info');
  });
});

// 고급 패널 비트레이트
$('adv-bitrate')?.addEventListener('change', async (e) => {
  const bitrate = parseInt(e.target.value);
  localStorage.setItem('styx-bitrate', bitrate);
  if (actuallyTauri) {
    await tauriInvoke('set_bitrate', { bitrateKbps: bitrate });
  }
  toast(`음질: ${bitrate}kbps`, 'info');
});

// 고급 패널 초기값 설정
function initAdvancedPanel() {
  // 오디오 처리
  if ($('adv-echo-cancel')) $('adv-echo-cancel').checked = echoCancellation;
  if ($('adv-noise-suppress')) $('adv-noise-suppress').checked = noiseSuppression;
  if ($('adv-ai-noise')) $('adv-ai-noise').checked = aiNoiseCancellation;
  if ($('adv-auto-gain')) $('adv-auto-gain').checked = autoGainControl;
  
  // 통화 모드
  if ($('adv-vad-mode')) $('adv-vad-mode').checked = vadEnabled;
  if ($('adv-input-monitor')) $('adv-input-monitor').checked = inputMonitorEnabled;
  
  // 성능 모드
  const perfMode = proMode ? 'pro' : (lowLatencyMode ? 'low-latency' : 'normal');
  const perfRadio = document.querySelector(`input[name="adv-performance"][value="${perfMode}"]`);
  if (perfRadio) perfRadio.checked = true;
  
  // 네트워크
  if ($('adv-jitter-slider')) {
    $('adv-jitter-slider').value = jitterBuffer;
    $('adv-jitter-slider').disabled = autoJitter;
  }
  if ($('adv-jitter-value')) $('adv-jitter-value').textContent = jitterBuffer + 'ms';
  if ($('adv-auto-jitter')) $('adv-auto-jitter').checked = autoJitter;
  if ($('adv-dtx')) $('adv-dtx').checked = dtxEnabled;
  if ($('adv-comfort-noise')) $('adv-comfort-noise').checked = comfortNoiseEnabled;
  if ($('adv-auto-adapt')) $('adv-auto-adapt').checked = autoAdapt;
  
  // 비트레이트
  const savedBitrate = localStorage.getItem('styx-bitrate') || '96';
  if ($('adv-bitrate')) $('adv-bitrate').value = savedBitrate;
}

// 새 고급 패널 핸들러
$('adv-vad-mode')?.addEventListener('change', (e) => {
  vadEnabled = e.target.checked;
  localStorage.setItem('styx-vad', vadEnabled);
});

$('adv-input-monitor')?.addEventListener('change', (e) => {
  inputMonitorEnabled = e.target.checked;
  localStorage.setItem('styx-input-monitor', inputMonitorEnabled);
  toggleInputMonitor(inputMonitorEnabled);
});

$('adv-jitter-slider')?.addEventListener('input', (e) => {
  jitterBuffer = parseInt(e.target.value);
  if ($('adv-jitter-value')) $('adv-jitter-value').textContent = jitterBuffer + 'ms';
  localStorage.setItem('styx-jitter-buffer', jitterBuffer);
  applyJitterBuffer();
});

$('adv-auto-jitter')?.addEventListener('change', (e) => {
  autoJitter = e.target.checked;
  localStorage.setItem('styx-auto-jitter', autoJitter);
  if ($('adv-jitter-slider')) $('adv-jitter-slider').disabled = autoJitter;
});

$('adv-dtx')?.addEventListener('change', (e) => {
  dtxEnabled = e.target.checked;
  localStorage.setItem('styx-dtx', dtxEnabled);
  if (actuallyTauri) tauriInvoke('set_dtx_enabled', { enabled: dtxEnabled }).catch(e => { if (DEBUG) console.debug('Silent error:', e); });
});

$('adv-comfort-noise')?.addEventListener('change', (e) => {
  comfortNoiseEnabled = e.target.checked;
  localStorage.setItem('styx-comfort-noise', comfortNoiseEnabled);
  if (actuallyTauri) tauriInvoke('set_comfort_noise', { enabled: comfortNoiseEnabled }).catch(e => { if (DEBUG) console.debug('Silent error:', e); });
});

$('adv-auto-adapt')?.addEventListener('change', (e) => {
  autoAdapt = e.target.checked;
  localStorage.setItem('styx-auto-adapt', autoAdapt);
});

// 오디오 이펙트 패널 (EQ만)
$('effects-toggle')?.addEventListener('click', () => {
  const panel = $('effects-panel');
  if (panel) panel.classList.toggle('hidden');
  $('advanced-settings-panel')?.classList.add('hidden');
});

// EQ 슬라이더 초기화
['eq-low', 'eq-mid', 'eq-high'].forEach(id => {
  const el = $(id);
  if (!el) return;
  const effectMap = { 'eq-low': 'eqLow', 'eq-mid': 'eqMid', 'eq-high': 'eqHigh' };
  const effect = effectMap[id];
  el.value = inputEffects[effect] || 0;
  el.nextElementSibling.textContent = `${el.value}dB`;
  el.oninput = () => {
    const val = parseInt(el.value);
    el.nextElementSibling.textContent = `${val}dB`;
    updateInputEffect(effect, val);
  };
});

// 압축비 슬라이더 초기화
const compressionEl = $('compression-ratio');
if (compressionEl) {
  compressionEl.value = inputEffects.compressionRatio || 4;
  compressionEl.nextElementSibling.textContent = `${compressionEl.value}:1`;
  compressionEl.oninput = () => {
    const val = parseFloat(compressionEl.value);
    compressionEl.nextElementSibling.textContent = `${val}:1`;
    updateInputEffect('compressionRatio', val);
  };
}

// 입력 볼륨 슬라이더 초기화
const inputVolumeEl = $('input-volume');
if (inputVolumeEl) {
  const initialValue = inputEffects.inputVolume || 120;
  inputVolumeEl.value = initialValue;
  const valueLabel = inputVolumeEl.nextElementSibling;
  if (valueLabel) valueLabel.textContent = `${initialValue}%`;
  
  inputVolumeEl.oninput = () => {
    const val = parseInt(inputVolumeEl.value);
    if (valueLabel) valueLabel.textContent = `${val}%`;
    updateInputEffect('inputVolume', val);
  };
}


// ===== Inline 이벤트 핸들러 대체 =====
$('themeBtn').onclick = toggleTheme;

// Modal backdrop click handlers - close only the parent modal
document.querySelectorAll('.modal-backdrop').forEach(el => {
  el.onclick = (e) => {
    const modal = e.target.closest('.modal');
    if (modal) {
      modal.classList.add('hidden');
    }
  };
});
$('create-room-modal')?.querySelector('.modal-close')?.addEventListener('click', closeCreateRoomModal);
document.querySelector('.modal-footer .btn-secondary')?.addEventListener('click', closeCreateRoomModal);
document.querySelector('.modal-footer .btn-primary')?.addEventListener('click', createRoom);
$('inviteBtn')?.addEventListener('click', createInviteLink);
$('recordBtn')?.addEventListener('click', toggleRecording);
$('closeRoomBtn')?.addEventListener('click', closeRoom);

// 설정 동기화
function collectSettings() {
  return {
    audioMode, jitterBuffer, autoAdapt, echoCancellation, noiseSuppression, aiNoiseCancellation,
    pttMode, pttKey, duckingEnabled, vadEnabled,
    theme: document.documentElement.getAttribute('data-theme') || 'dark'
  };
}

function applySettings(s) {
  if (!s) return;
  audioMode = s.audioMode ?? audioMode;
  jitterBuffer = s.jitterBuffer ?? jitterBuffer;
  autoAdapt = s.autoAdapt ?? autoAdapt;
  echoCancellation = s.echoCancellation ?? echoCancellation;
  noiseSuppression = s.noiseSuppression ?? noiseSuppression;
  aiNoiseCancellation = s.aiNoiseCancellation ?? aiNoiseCancellation;
  pttMode = s.pttMode ?? pttMode;
  pttKey = s.pttKey ?? pttKey;
  duckingEnabled = s.duckingEnabled ?? duckingEnabled;
  vadEnabled = s.vadEnabled ?? vadEnabled;
  if (s.theme) document.documentElement.setAttribute('data-theme', s.theme);
  // localStorage 동기화
  localStorage.setItem('styx-audio-mode', audioMode);
  localStorage.setItem('styx-jitter-buffer', jitterBuffer);
  localStorage.setItem('styx-auto-adapt', autoAdapt);
  localStorage.setItem('styx-echo', echoCancellation);
  localStorage.setItem('styx-noise', noiseSuppression);
  localStorage.setItem('styx-ai-noise', aiNoiseCancellation);
  localStorage.setItem('styx-ptt', pttMode);
  localStorage.setItem('styx-ptt-key', pttKey);
  localStorage.setItem('styx-ducking', duckingEnabled);
  localStorage.setItem('styx-vad', vadEnabled);
  localStorage.setItem('styx-theme', s.theme || 'dark');
}

function scheduleSettingsSave() {
  if (settingsSaveTimer) return;
  settingsSaveTimer = setTimeout(() => {
    settingsSaveTimer = null;
    socket.emit('save-settings', { settings: collectSettings() });
  }, 10000);
}
window.scheduleSettingsSave = scheduleSettingsSave;

// Immediate settings save (for keyboard shortcut)
function saveCurrentSettings() {
  socket.emit('save-settings', { settings: collectSettings() });
  toast('설정이 저장되었습니다', 'success', 2000);
}
window.saveCurrentSettings = saveCurrentSettings;

// Mark app as fully loaded - enables error recovery
appFullyLoaded = true;
