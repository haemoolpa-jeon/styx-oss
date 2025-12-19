// Styx 클라이언트 - HADES 실시간 오디오 협업
// WebRTC P2P 오디오 + 안정성 중심 설계

// 디버그 모드 (프로덕션에서는 false)
const DEBUG = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const log = (...args) => DEBUG && console.log(...args);

const serverUrl = window.STYX_SERVER_URL || '';
const socket = io(serverUrl, { reconnection: true, reconnectionDelay: 1000, reconnectionAttempts: 10 });

// 아바타 URL을 절대 경로로 변환
const avatarUrl = (path) => path ? (path.startsWith('/') ? serverUrl + path : path) : '';

const peers = new Map();
const volumeStates = new Map();
let localStream = null;
let isMuted = false;
let currentUser = null;
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
let sessionRestored = false;
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;
let inputLimiterContext = null; // 입력 리미터용 AudioContext
let processedStream = null; // 리미터 적용된 스트림

// 피어 오디오용 공유 AudioContext 가져오기
function getPeerAudioContext() {
  if (!peerAudioContext || peerAudioContext.state === 'closed') {
    peerAudioContext = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
  }
  if (peerAudioContext.state === 'suspended') {
    peerAudioContext.resume();
  }
  return peerAudioContext;
}

// 입력 오디오에 리미터/컴프레서 적용
function createProcessedInputStream(rawStream) {
  inputLimiterContext = new AudioContext({ sampleRate: 48000 });
  const source = inputLimiterContext.createMediaStreamSource(rawStream);
  
  // 컴프레서 (리미터 역할)
  const compressor = inputLimiterContext.createDynamicsCompressor();
  compressor.threshold.value = -12; // 리미팅 시작점 (dB)
  compressor.knee.value = 6;        // 부드러운 전환
  compressor.ratio.value = 12;      // 높은 비율 = 리미터처럼 동작
  compressor.attack.value = 0.003;  // 빠른 어택
  compressor.release.value = 0.1;   // 적당한 릴리즈
  
  // 게인 (컴프레서 후 볼륨 보상)
  const makeupGain = inputLimiterContext.createGain();
  makeupGain.gain.value = 1.2; // 약간의 메이크업 게인
  
  const dest = inputLimiterContext.createMediaStreamDestination();
  source.connect(compressor);
  compressor.connect(makeupGain);
  makeupGain.connect(dest);
  
  processedStream = dest.stream;
  return processedStream;
}

// Tauri 감지
const _isTauriApp = typeof window.__TAURI__ !== 'undefined';
const tauriInvoke = _isTauriApp ? window.__TAURI__.core.invoke : null;

// 연결 모드: 'webrtc' | 'udp'
let connectionMode = localStorage.getItem('styx-connection-mode') || 'webrtc';

// 안정성 설정
let audioMode = localStorage.getItem('styx-audio-mode') || 'voice'; // voice | music
let jitterBuffer = parseInt(localStorage.getItem('styx-jitter-buffer')) || 100; // ms
let autoAdapt = localStorage.getItem('styx-auto-adapt') !== 'false';

// 오디오 처리 설정
let echoCancellation = localStorage.getItem('styx-echo') !== 'false';
let noiseSuppression = localStorage.getItem('styx-noise') !== 'false';
let pttMode = localStorage.getItem('styx-ptt') === 'true';
let pttKey = localStorage.getItem('styx-ptt-key') || 'Space';
let isPttActive = false;

// 오디오 프로세싱 노드
let gainNode = null;
let compressorNode = null;
let noiseGateInterval = null;
let latencyHistory = []; // 핑 그래프용
let serverTimeOffset = 0; // 서버 시간과 클라이언트 시간 차이 (ms)

// 추가 기능
let isOnline = navigator.onLine;
let lastRoom = sessionStorage.getItem('styx-room');
let lastRoomPassword = sessionStorage.getItem('styx-room-pw');
let duckingEnabled = localStorage.getItem('styx-ducking') === 'true';
let vadEnabled = localStorage.getItem('styx-vad') !== 'false';
let vadIntervals = new Map(); // 피어별 VAD 인터벌
let delayCompensation = false;
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

// 오디오 모드별 설정
const audioModes = {
  voice: { bitrate: 32000, stereo: false, fec: true, dtx: true, name: '음성' },
  music: { bitrate: 128000, stereo: true, fec: true, dtx: false, name: '악기' }
};

const $ = id => document.getElementById(id);

// 연결 품질 등급
function getQualityGrade(latency, packetLoss, jitter) {
  if (packetLoss > 5 || latency > 200 || jitter > 50) return { grade: 'poor', label: '불안정', color: '#ff4757' };
  if (packetLoss > 2 || latency > 100 || jitter > 30) return { grade: 'fair', label: '보통', color: '#ffa502' };
  return { grade: 'good', label: '좋음', color: '#2ed573' };
}

// ===== 연결 테스트 =====
async function runConnectionTest() {
  const results = { mic: false, speaker: false, network: false, turn: false };
  const statusEl = $('test-status');
  const updateStatus = (msg) => { if (statusEl) statusEl.textContent = msg; };
  
  // 1. 마이크 테스트
  updateStatus('🎤 마이크 테스트 중...');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const track = stream.getAudioTracks()[0];
    results.mic = track.readyState === 'live';
    stream.getTracks().forEach(t => t.stop());
  } catch { results.mic = false; }
  
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
  
  // 3. STUN 연결 테스트
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
  
  // 4. TURN 연결 테스트
  updateStatus('🔄 TURN 서버 테스트 중...');
  testPc = null;
  try {
    testPc = new RTCPeerConnection({ 
      iceServers: [{ urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' }],
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
  
  updateStatus('테스트 완료');
  return results;
}

// 테스트 결과 표시
function showTestResults(results) {
  const el = $('test-results');
  if (!el) return;
  el.innerHTML = `
    <div class="test-item ${results.mic ? 'pass' : 'fail'}">🎤 마이크: ${results.mic ? '✓' : '✗'}</div>
    <div class="test-item ${results.speaker ? 'pass' : 'fail'}">🔊 스피커: ${results.speaker ? '✓' : '✗'}</div>
    <div class="test-item ${results.network ? 'pass' : 'fail'}">🌐 P2P 연결: ${results.network ? '✓' : '✗'}</div>
    <div class="test-item ${results.turn ? 'pass' : 'fail'}">🔄 TURN 릴레이: ${results.turn ? '✓' : '✗'}</div>
  `;
  el.classList.remove('hidden');
}

// 토스트 메시지
function toast(message, type = 'info', duration = 3000) {
  const container = $('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  
  setTimeout(() => {
    el.classList.add('hide');
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// ===== 테마 =====
function initTheme() {
  const saved = localStorage.getItem('styx-theme') || 'dark';
  document.body.dataset.theme = saved;
  updateThemeIcon();
}

function toggleTheme() {
  const current = document.body.dataset.theme;
  const next = current === 'dark' ? 'light' : 'dark';
  document.body.dataset.theme = next;
  localStorage.setItem('styx-theme', next);
  updateThemeIcon();
  scheduleSettingsSave();
}

function updateThemeIcon() {
  const btn = $('themeBtn');
  if (btn) btn.textContent = document.body.dataset.theme === 'dark' ? '☀️' : '🌙';
}

initTheme();

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

// 오디오 설정 적용 (Opus 코덱)
async function applyAudioSettings(pc) {
  const senders = pc.getSenders();
  const audioSender = senders.find(s => s.track?.kind === 'audio');
  if (!audioSender) return;

  const params = audioSender.getParameters();
  if (!params.encodings || !params.encodings.length) {
    params.encodings = [{}];
  }

  const mode = audioModes[audioMode];
  params.encodings[0].maxBitrate = mode.bitrate;
  params.encodings[0].priority = 'high';
  params.encodings[0].networkPriority = 'high';
  
  try {
    await audioSender.setParameters(params);
  } catch (e) {
    log('오디오 파라미터 설정 실패:', e);
  }
}

// 모든 피어에 오디오 설정 적용
function applyAudioSettingsToAll() {
  peers.forEach(peer => applyAudioSettings(peer.pc));
}

// ===== 사운드 알림 =====
let notifyAudio = null;

function playSound(type) {
  if (!notifyAudio) notifyAudio = new AudioContext();
  if (notifyAudio.state === 'suspended') notifyAudio.resume();
  
  const osc = notifyAudio.createOscillator();
  const gain = notifyAudio.createGain();
  osc.connect(gain);
  gain.connect(notifyAudio.destination);
  
  if (type === 'join') {
    osc.frequency.value = 800;
    gain.gain.setValueAtTime(0.2, notifyAudio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, notifyAudio.currentTime + 0.15);
    osc.start();
    osc.stop(notifyAudio.currentTime + 0.15);
  } else if (type === 'leave') {
    osc.frequency.value = 400;
    gain.gain.setValueAtTime(0.2, notifyAudio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, notifyAudio.currentTime + 0.2);
    osc.start();
    osc.stop(notifyAudio.currentTime + 0.2);
  }
}

// ===== 키보드 단축키 =====
document.addEventListener('keydown', (e) => {
  // PTT 모드
  if (pttMode && !isPttActive && e.code === pttKey && localStream) {
    isPttActive = true;
    localStream.getAudioTracks().forEach(t => t.enabled = true);
    $('muteBtn')?.classList.remove('muted');
    $('muteBtn')?.classList.add('ptt-active');
    $('muteBtn').textContent = '🎤';
    return;
  }
  
  // 입력 필드에서는 무시
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  
  // 방 화면에서만 작동
  if (roomView?.classList.contains('hidden')) return;
  
  // M: 음소거 토글
  if (e.key === 'm' || e.key === 'M' || e.key === 'ㅡ') {
    e.preventDefault();
    if (!pttMode) $('muteBtn')?.click();
  } 
  // Space: 메트로놈 토글
  else if (e.key === ' ' && e.code !== pttKey) {
    e.preventDefault();
    $('metronome-toggle')?.click();
  }
  // R: 녹음 토글
  else if (e.key === 'r' || e.key === 'R' || e.key === 'ㄱ') {
    e.preventDefault();
    $('recordBtn')?.click();
  }
  // I: 초대 링크 복사
  else if (e.key === 'i' || e.key === 'I' || e.key === 'ㅑ') {
    e.preventDefault();
    $('inviteBtn')?.click();
  }
  // Escape: 방 나가기 (확인 필요)
  else if (e.key === 'Escape') {
    e.preventDefault();
    $('leaveBtn')?.click();
  }
  // 숫자 1-8: 피어 음소거 토글
  else if (e.key >= '1' && e.key <= '8') {
    const idx = parseInt(e.key) - 1;
    const peerIds = [...peers.keys()];
    if (peerIds[idx]) {
      const peer = peers.get(peerIds[idx]);
      if (peer) {
        peer.muted = !peer.muted;
        applyMixerState();
        renderUsers();
      }
    }
  }
});

document.addEventListener('keyup', (e) => {
  // PTT 모드 - 키 떼면 음소거
  if (pttMode && isPttActive && e.code === pttKey && localStream) {
    isPttActive = false;
    localStream.getAudioTracks().forEach(t => t.enabled = false);
    $('muteBtn')?.classList.add('muted');
    $('muteBtn')?.classList.remove('ptt-active');
    $('muteBtn').textContent = '🔇';
  }
});

// PTT 모바일 터치 지원
function initPttTouch() {
  const muteBtn = $('muteBtn');
  if (!muteBtn) return;
  
  muteBtn.addEventListener('touchstart', (e) => {
    if (!pttMode || !localStream) return;
    e.preventDefault();
    isPttActive = true;
    localStream.getAudioTracks().forEach(t => t.enabled = true);
    muteBtn.classList.remove('muted');
    muteBtn.classList.add('ptt-active');
    muteBtn.textContent = '🎤';
  }, { passive: false });
  
  muteBtn.addEventListener('touchend', (e) => {
    if (!pttMode || !localStream) return;
    e.preventDefault();
    isPttActive = false;
    localStream.getAudioTracks().forEach(t => t.enabled = false);
    muteBtn.classList.add('muted');
    muteBtn.classList.remove('ptt-active');
    muteBtn.textContent = '🔇';
  }, { passive: false });
}

// ===== (즐겨찾기 제거됨) =====

// ===== 녹음 =====
let recordingAudioCtx = null; // Store reference for cleanup

function startRecording() {
  if (isRecording) return;
  
  // 모든 오디오 스트림 믹싱
  recordingAudioCtx = new AudioContext();
  const dest = recordingAudioCtx.createMediaStreamDestination();
  
  // 로컬 오디오 추가
  if (localStream) {
    const localSource = recordingAudioCtx.createMediaStreamSource(localStream);
    localSource.connect(dest);
  }
  
  // 원격 오디오 추가
  peers.forEach(peer => {
    if (peer.audioEl.srcObject) {
      const remoteSource = recordingAudioCtx.createMediaStreamSource(peer.audioEl.srcObject);
      remoteSource.connect(dest);
    }
  });
  
  recordedChunks = [];
  mediaRecorder = new MediaRecorder(dest.stream, { mimeType: 'audio/webm' });
  
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };
  
  mediaRecorder.onstop = () => {
    if (recordingAudioCtx) {
      recordingAudioCtx.close().catch(() => {});
      recordingAudioCtx = null;
    }
    const blob = new Blob(recordedChunks, { type: 'audio/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `styx-recording-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.webm`;
    a.click();
    URL.revokeObjectURL(url);
    toast('녹음 파일이 다운로드되었습니다', 'success');
  };
  
  mediaRecorder.start();
  isRecording = true;
  $('recordBtn').textContent = '⏹️ 녹음 중';
  $('recordBtn').classList.add('recording');
  toast('녹음 시작', 'info');
}

function stopRecording() {
  if (!isRecording || !mediaRecorder) return;
  
  mediaRecorder.stop();
  isRecording = false;
  $('recordBtn').textContent = '⏺️ 녹음';
  $('recordBtn').classList.remove('recording');
  // Note: AudioContext is closed in mediaRecorder.onstop
}

// Cleanup recording if still active (called from leaveRoom)
function cleanupRecording() {
  if (isRecording && mediaRecorder) {
    mediaRecorder.stop();
  }
  if (recordingAudioCtx) {
    recordingAudioCtx.close().catch(() => {});
    recordingAudioCtx = null;
  }
  isRecording = false;
}

function toggleRecording() {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
}
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
        try { peer.pc.restartIce(); } catch {}
      });
    }
  });
}

// 자동 재입장
async function autoRejoin() {
  if (!lastRoom || !currentUser || !isOnline) return;
  
  try {
    const audioConstraints = {
      audio: {
        deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
        echoCancellation, noiseSuppression, autoGainControl: true,
        sampleRate: 48000,
        channelCount: 1,
        latency: { ideal: 0.01 }
      }
    };
    const rawStream = await navigator.mediaDevices.getUserMedia(audioConstraints);
    // 입력 리미터 적용
    localStream = createProcessedInputStream(rawStream);
    localStream._rawStream = rawStream;
    
    if (pttMode) localStream.getAudioTracks().forEach(t => t.enabled = false);
    
    socket.emit('join', { room: lastRoom, username: currentUser.username, password: lastRoomPassword }, res => {
      if (res.error) {
        toast('재입장 실패: ' + res.error, 'error');
        localStream?._rawStream?.getTracks().forEach(t => t.stop());
        localStream?.getTracks().forEach(t => t.stop());
        if (inputLimiterContext) { inputLimiterContext.close(); inputLimiterContext = null; }
        lastRoom = null;
      } else {
        toast('방에 재입장했습니다', 'success');
        socket.room = lastRoom;
        // 기존 사용자들에 대한 피어 연결 (initiator=false: 기존 사용자가 offer를 보냄)
        res.users.forEach(u => createPeerConnection(u.id, u.username, u.avatar, false));
        startLatencyPing();
        startAudioMeter();
      }
    });
  } catch {
    toast('마이크 접근 실패', 'error');
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
  
  // UDP 핸들러 설정 (Tauri 앱일 때만)
  if (_isTauriApp) setupUdpHandlers();
  
  // 세션 복구 (최초 연결 시에만)
  if (!sessionRestored) {
    sessionRestored = true;
    const savedUser = localStorage.getItem('styx-user');
    const savedToken = localStorage.getItem('styx-token');
    
    if (savedUser && savedToken) {
      socket.emit('restore-session', { username: savedUser, token: savedToken }, res => {
        if (res.success) {
          currentUser = res.user;
          showLobby();
          // URL에서 방 정보 확인
          checkInviteLink();
        } else {
          localStorage.removeItem('styx-user');
          localStorage.removeItem('styx-token');
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

// 서버 종료 알림
socket.on('server-shutdown', () => {
  toast('서버가 종료됩니다. 잠시 후 재연결됩니다.', 'warning', 5000);
});

// 재연결 시 방 자동 재입장
socket.io.on('reconnect', () => {
  log('서버 재연결됨');
  toast('서버 재연결됨', 'success');
  
  // TURN 자격증명 갱신
  updateTurnCredentials();
  
  // 세션 복구 후 방 재입장
  const savedUser = localStorage.getItem('styx-user');
  const savedToken = localStorage.getItem('styx-token');
  
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

// 초대 링크 확인
function checkInviteLink() {
  const params = new URLSearchParams(window.location.search);
  const inviteRoom = params.get('room');
  if (inviteRoom && currentUser) {
    toast(`"${inviteRoom}" 방으로 초대됨`, 'info');
    setTimeout(() => joinRoom(inviteRoom, false), 500);
    // URL 정리
    window.history.replaceState({}, '', window.location.pathname);
  }
}

// 초대 링크 생성
function createInviteLink() {
  const roomName = $('roomName')?.textContent;
  if (!roomName) return;
  
  const url = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomName)}`;
  navigator.clipboard.writeText(url).then(() => {
    toast('초대 링크가 복사되었습니다', 'success');
  }).catch(() => {
    prompt('초대 링크:', url);
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
    localStorage.setItem('styx-user', username);
    localStorage.setItem('styx-token', res.token);
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
  $('my-username').textContent = currentUser.username;
  $('my-avatar').style.backgroundImage = currentUser.avatar ? `url(${avatarUrl(currentUser.avatar)})` : '';
  if (currentUser.isAdmin) $('adminBtn').classList.remove('hidden');
  
  // 서버에서 설정 로드
  socket.emit('get-settings', null, res => {
    if (res?.settings) applySettings(res.settings);
    initStabilitySettings();
  });
  
  await loadAudioDevices();
  loadRoomList();
  
  // 새로고침 후 자동 재입장
  if (lastRoom) {
    setTimeout(() => joinRoom(lastRoom, !!lastRoomPassword, lastRoomPassword), 500);
  }
}

// 안정성 설정 초기화
function initStabilitySettings() {
  // Tauri 앱이면 연결 모드 선택 표시
  if (_isTauriApp) {
    const tauriSettings = $('tauri-settings');
    if (tauriSettings) tauriSettings.style.display = 'block';
    const modeRow = $('connection-mode-row');
    if (modeRow) modeRow.style.display = 'flex';
    updateConnectionModeButtons();
    initTauriFeatures();
  }
  
  // 오디오 모드
  updateModeButtons();
  
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
  
  // 연결 테스트 버튼
  const testBtn = $('test-connection-btn');
  if (testBtn) {
    testBtn.onclick = async () => {
      testBtn.disabled = true;
      testBtn.textContent = '테스트 중...';
      const results = await runConnectionTest();
      showTestResults(results);
      testBtn.disabled = false;
      testBtn.textContent = '🔍 연결 테스트';
    };
  }
}

// 연결 모드 설정
window.setConnectionMode = (mode) => {
  connectionMode = mode;
  localStorage.setItem('styx-connection-mode', mode);
  updateConnectionModeButtons();
  const modeNames = { webrtc: 'WebRTC', udp: 'Custom UDP' };
  toast(`${modeNames[mode]} 모드로 변경됨`, 'info');
};

function updateConnectionModeButtons() {
  $('webrtcModeBtn')?.classList.toggle('active', connectionMode === 'webrtc');
  $('udpModeBtn')?.classList.toggle('active', connectionMode === 'udp');
}

// Tauri 기능 초기화
let udpPort = null;
let udpPeers = new Map(); // peerId -> { port, publicIp, username }

async function initTauriFeatures() {
  if (!tauriInvoke) return;
  
  try {
    // 오디오 호스트 목록 로드
    const hosts = await tauriInvoke('get_audio_hosts');
    const hostSelect = $('tauri-audio-host');
    if (hostSelect && hosts.length) {
      hostSelect.innerHTML = hosts.map(h => `<option value="${h}">${h}</option>`).join('');
      $('tauri-audio-row').style.display = 'flex';
    }
    
    // 오디오 장치 목록 로드
    const devices = await tauriInvoke('get_audio_devices');
    log('Tauri 오디오 장치:', devices);
    
    // ASIO 사용 가능 여부 확인
    const asioAvailable = await tauriInvoke('check_asio');
    if (asioAvailable) {
      toast('ASIO 드라이버 감지됨', 'success');
      $('tauri-audio-hint').textContent = 'ASIO 사용 가능 - 저지연 모드 권장';
    }
    
    // 오디오 정보 가져오기
    const audioInfo = await tauriInvoke('get_audio_info');
    log('Tauri 오디오 정보:', audioInfo);
  } catch (e) {
    console.error('Tauri 초기화 오류:', e);
  }
}

// UDP 모드 시작
async function startUdpMode() {
  if (!tauriInvoke) return;
  
  try {
    // UDP 소켓 바인딩 (0 = 자동 포트)
    udpPort = await tauriInvoke('udp_bind', { port: 0 });
    log('UDP 포트 바인딩:', udpPort);
    
    // STUN으로 공인 IP 획득
    let publicIp = null;
    try {
      const publicAddr = await tauriInvoke('get_public_ip');
      publicIp = publicAddr.split(':')[0]; // IP만 추출
      log('공인 IP:', publicIp);
    } catch (e) {
      console.warn('STUN 실패:', e);
      // STUN 실패 시 WebRTC로 fallback
      toast('NAT 통과 실패, WebRTC 모드로 전환', 'warning');
      connectionMode = 'webrtc';
      localStorage.setItem('styx-connection-mode', 'webrtc');
      updateConnectionModeButtons();
      return;
    }
    
    // 서버에 UDP 정보 전송
    socket.emit('udp-info', { port: udpPort, publicIp });
    
    // 기존 피어 정보 요청
    socket.emit('udp-request-peers');
    
    const ipInfo = publicIp ? `${publicIp}:${udpPort}` : `포트 ${udpPort}`;
    toast(`UDP 모드 활성화 (${ipInfo})`, 'success');
  } catch (e) {
    console.error('UDP 시작 실패:', e);
    toast('UDP 모드 시작 실패', 'error');
  }
}

// UDP 피어 정보 수신 핸들러
function setupUdpHandlers() {
  socket.on('udp-peer-info', async ({ id, port, publicIp, username }) => {
    udpPeers.set(id, { port, publicIp, username });
    log(`UDP 피어 추가: ${username} (${publicIp}:${port})`);
    // Tauri에 피어 추가
    if (tauriInvoke && publicIp && port) {
      try {
        await tauriInvoke('udp_add_peer', { addr: `${publicIp}:${port}` });
      } catch (e) { console.error('피어 추가 실패:', e); }
    }
  });
  
  socket.on('udp-peers', async (peers) => {
    for (const p of peers) {
      udpPeers.set(p.id, { port: p.port, publicIp: p.publicIp, username: p.username });
      if (tauriInvoke && p.publicIp && p.port) {
        try {
          await tauriInvoke('udp_add_peer', { addr: `${p.publicIp}:${p.port}` });
        } catch (e) { console.error('피어 추가 실패:', e); }
      }
    }
    log('UDP 피어 목록:', udpPeers.size);
    // 피어가 있으면 스트림 시작
    if (udpPeers.size > 0) startUdpStream();
  });
}

// UDP 음소거 연동
async function setUdpMuted(muted) {
  if (tauriInvoke && connectionMode === 'udp') {
    try {
      await tauriInvoke('udp_set_muted', { muted });
    } catch (e) { console.error('UDP 음소거 설정 실패:', e); }
  }
}

// 방 퇴장 시 UDP 정리
async function cleanupUdp() {
  stopUdpStatsMonitor();
  if (tauriInvoke) {
    try {
      await tauriInvoke('udp_stop_stream');
      await tauriInvoke('udp_clear_peers');
    } catch (e) { console.error('UDP 정리 실패:', e); }
  }
  udpPeers.clear();
  udpPort = null;
}

// UDP 스트림 시작
async function startUdpStream() {
  if (!tauriInvoke || connectionMode !== 'udp') return;
  
  try {
    // 선택된 장치 설정 (웹 UI에서 선택한 장치 사용)
    const inputDevice = $('audio-device')?.value ? null : null; // Tauri는 장치 이름 필요
    const outputDevice = $('audio-output')?.value ? null : null;
    await tauriInvoke('set_audio_devices', { input: inputDevice, output: outputDevice });
    
    await tauriInvoke('udp_start_stream');
    log('UDP 스트림 시작됨');
    toast('UDP 오디오 스트림 시작', 'success');
    startUdpStatsMonitor();
  } catch (e) {
    console.error('UDP 스트림 시작 실패:', e);
    toast('UDP 스트림 시작 실패: ' + e, 'error');
  }
}

// UDP 스트림 중지
async function stopUdpStream() {
  if (!tauriInvoke) return;
  
  try {
    await tauriInvoke('udp_stop_stream');
    log('UDP 스트림 중지됨');
  } catch (e) {
    console.error('UDP 스트림 중지 실패:', e);
  }
}

// UDP 연결 품질 모니터링
let udpStatsInterval = null;

function startUdpStatsMonitor() {
  if (!tauriInvoke || udpStatsInterval) return;
  
  udpStatsInterval = setInterval(async () => {
    try {
      const stats = await tauriInvoke('get_udp_stats');
      updateUdpStatsUI(stats);
    } catch (e) {
      console.error('UDP 통계 조회 실패:', e);
    }
  }, 1000);
}

function stopUdpStatsMonitor() {
  if (udpStatsInterval) {
    clearInterval(udpStatsInterval);
    udpStatsInterval = null;
  }
}

function updateUdpStatsUI(stats) {
  const badge = $('udp-stats-badge');
  if (!badge) return;
  
  badge.classList.remove('hidden');
  
  if (!stats.is_running) {
    badge.textContent = 'UDP: 대기';
    badge.className = 'stats-badge idle';
    return;
  }
  
  const lossRate = stats.loss_rate.toFixed(1);
  const bufferMs = stats.jitter_buffer_size * 10; // 10ms per frame
  const targetMs = (stats.jitter_buffer_target || stats.jitter_buffer_size) * 10;
  let quality = 'good';
  if (stats.loss_rate > 5) quality = 'bad';
  else if (stats.loss_rate > 1) quality = 'warning';
  
  badge.textContent = `UDP: ${stats.peer_count}명 | 손실 ${lossRate}% | 버퍼 ${bufferMs}/${targetMs}ms`;
  badge.className = `stats-badge ${quality}`;
}

// 오디오 모드 설정
window.setAudioMode = (mode) => {
  audioMode = mode;
  localStorage.setItem('styx-audio-mode', mode);
  updateModeButtons();
  applyAudioSettingsToAll();
  scheduleSettingsSave();
  toast(`${audioModes[mode].name} 모드로 변경됨`, 'info');
};

function updateModeButtons() {
  $('voiceModeBtn')?.classList.toggle('active', audioMode === 'voice');
  $('musicModeBtn')?.classList.toggle('active', audioMode === 'music');
}

$('logoutBtn').onclick = () => {
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
            peer.audioEl.setSinkId(selectedOutputId).catch(() => {});
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
        <span class="room-users">${r.userCount}/8 👤</span>
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

// 아바타 업로드
$('avatar-input').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) return toast('이미지 크기는 2MB 이하여야 합니다', 'error');
  
  const reader = new FileReader();
  reader.onload = () => {
    socket.emit('upload-avatar', { username: currentUser.username, avatarData: reader.result }, res => {
      if (res.success) {
        currentUser.avatar = res.avatar;
        $('my-avatar').style.backgroundImage = `url(${avatarUrl(res.avatar)})`;
        toast('아바타가 변경되었습니다', 'success');
      } else {
        toast(res.error, 'error');
      }
    });
  };
  reader.readAsDataURL(file);
};

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
  loadAdminData();
  adminPanel.classList.remove('hidden');
  lobby.classList.add('hidden');
};

function loadAdminData() {
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
    res.users?.forEach(u => {
      const div = document.createElement('div');
      div.className = 'user-item';
      div.innerHTML = `
        <span>${escapeHtml(u.username)} ${u.isAdmin ? '👑' : ''}</span>
        ${!u.isAdmin ? `<button onclick="deleteUser('${u.username.replace(/'/g, "\\'")}')">삭제</button>` : ''}
      `;
      list.appendChild(div);
    });
  });
}

window.approveUser = (username) => socket.emit('approve-user', { username }, () => loadAdminData());
window.rejectUser = (username) => socket.emit('reject-user', { username }, () => loadAdminData());
window.deleteUser = (username) => {
  if (confirm(`${username} 사용자를 삭제하시겠습니까?`)) {
    socket.emit('delete-user', { username }, () => loadAdminData());
  }
};

$('closeAdminBtn').onclick = () => {
  adminPanel.classList.add('hidden');
  lobby.classList.remove('hidden');
};

// 방 입장
window.joinRoom = async (roomName, hasPassword, providedPassword, roomSettings) => {
  const room = roomName;
  if (!room) return toast('방 이름을 입력하세요', 'error');

  let roomPassword = providedPassword || null;
  if (hasPassword && !roomPassword) {
    roomPassword = prompt('방 비밀번호를 입력하세요:');
    if (!roomPassword) return;
  }

  // 빠른 연결 상태 확인
  if (!navigator.onLine) {
    return toast('인터넷 연결을 확인하세요', 'error');
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
      autoGainControl: true,
      sampleRate: 48000,
      channelCount: 1,
      latency: { ideal: 0.01 }
    }
  };

  try {
    const rawStream = await navigator.mediaDevices.getUserMedia(audioConstraints);
    // 입력 리미터 적용 (클리핑 방지)
    localStream = createProcessedInputStream(rawStream);
    // 원본 스트림 참조 저장 (정리용)
    localStream._rawStream = rawStream;
    
    // PTT 모드면 시작 시 음소거
    if (pttMode) {
      localStream.getAudioTracks().forEach(t => t.enabled = false);
      isMuted = true;
    }
  } catch {
    return toast('마이크 접근이 거부되었습니다', 'error');
  }

  socket.emit('join', { room, username: currentUser.username, password: roomPassword, settings: roomSettings }, res => {
    if (res.error) {
      localStream._rawStream?.getTracks().forEach(t => t.stop());
      localStream.getTracks().forEach(t => t.stop());
      if (inputLimiterContext) { inputLimiterContext.close(); inputLimiterContext = null; }
      const errorMsg = {
        'Room full': '방이 가득 찼습니다',
        'Username already in room': '이미 방에 접속 중입니다',
        'Not authorized': '권한이 없습니다',
        'Wrong room password': '방 비밀번호가 틀렸습니다'
      }[res.error] || res.error;
      return toast(errorMsg, 'error');
    }

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
    
    document.querySelector('#my-card .card-avatar').style.backgroundImage = 
      currentUser.avatar ? `url(${avatarUrl(currentUser.avatar)})` : '';

    chatMessages.innerHTML = '';
    res.messages?.forEach(addChatMessage);

    if (res.metronome) {
      $('bpm-input').value = res.metronome.bpm;
      if (res.metronome.playing) startMetronome(res.metronome.bpm, res.metronome.startTime);
    }
    
    // 지연 보상 상태 적용
    delayCompensation = res.delayCompensation || false;
    if ($('delay-compensation')) $('delay-compensation').checked = delayCompensation;

    // 기존 사용자들에 대한 피어 연결 생성 (initiator=false: 기존 사용자가 offer를 보냄)
    res.users.forEach(u => createPeerConnection(u.id, u.username, u.avatar, false));
    startLatencyPing();
    startAudioMeter();
    initPttTouch();
    
    // UDP 모드면 UDP 시작
    if (_isTauriApp && connectionMode === 'udp') {
      startUdpMode();
    }
  });
};

// 오디오 레벨 미터
function startAudioMeter() {
  try {
    audioContext = new AudioContext();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    
    const source = audioContext.createMediaStreamSource(localStream);
    source.connect(analyser);
    
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const meter = $('audio-meter');
    
    meterInterval = setInterval(() => {
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
    startMetronome(bpm, null, countIn);
  } else {
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

let metronomeBeat = 0; // 현재 박자 (0-3)
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
    tick.classList.add('active');
    
    // 비트 인디케이터 업데이트
    beatIndicators.forEach((el, i) => {
      el.classList.toggle('active', i === metronomeBeat);
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
    
    setTimeout(() => tick.classList.remove('active'), 80);
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
    oldPeer.pc.close();
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
let turnRefreshTimer = null;
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
function createPeerConnection(peerId, username, avatar, initiator) {
  const pc = new RTCPeerConnection(rtcConfig);
  const audioEl = document.createElement('audio');
  audioEl.autoplay = true;
  document.body.appendChild(audioEl);

  // 출력 장치 설정
  if (selectedOutputId && audioEl.setSinkId) {
    audioEl.setSinkId(selectedOutputId).catch(() => {});
  }

  const savedVolume = volumeStates.get(peerId) ?? 100;
  audioEl.volume = savedVolume / 100;

  peers.set(peerId, { 
    pc, username, avatar, audioEl, 
    latency: null, volume: savedVolume,
    packetLoss: 0, jitter: 0, bitrate: 0,
    quality: { grade: 'good', label: '연결중', color: '#ffa502' },
    pan: 0, muted: false, solo: false
  });

  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.ontrack = (e) => {
    const peerData = peers.get(peerId);
    
    // 지터 버퍼 적용 (WebRTC playoutDelayHint)
    if (e.receiver && e.receiver.playoutDelayHint !== undefined) {
      e.receiver.playoutDelayHint = jitterBuffer / 1000; // ms → seconds
    }
    
    try {
      // 공유 AudioContext 사용 (브라우저 AudioContext 제한 회피)
      const ctx = getPeerAudioContext();
      
      const source = ctx.createMediaStreamSource(e.streams[0]);
      
      // 압축기
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -24;
      compressor.knee.value = 30;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.25;
      
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
      compressor.connect(panNode);
      panNode.connect(delayNode);
      delayNode.connect(gainNode);
      gainNode.connect(dest);
      
      audioEl.srcObject = dest.stream;
      if (peerData) {
        peerData.audioContext = ctx; // 공유 컨텍스트 참조
        peerData.panNode = panNode;
        peerData.gainNode = gainNode;
        peerData.delayNode = delayNode;
        peerData.analyser = peerAnalyser;
        peerData.isSpeaking = false;
        peerData.audioNodes = { source, compressor, panNode, gainNode, delayNode, peerAnalyser, dest }; // 정리용
      }
      
      // VAD 시작
      if (vadEnabled) startVAD(peerId, peerAnalyser);
      
    } catch (e) {
      console.error('오디오 처리 설정 실패:', e);
      audioEl.srcObject = e.streams[0];
    }
    
    if (audioEl.playsInline !== undefined) {
      audioEl.playsInline = true;
    }
    // 오디오 재생 시작
    audioEl.play().catch(() => {});
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
      </div>
      <div class="card-mixer">
        <button class="mixer-btn ${peer.muted ? 'active' : ''}" data-action="mute">M</button>
        <button class="mixer-btn ${peer.solo ? 'active' : ''}" data-action="solo">S</button>
        <input type="range" min="-100" max="100" value="${peer.pan}" class="pan-slider" title="팬: ${peer.pan}">
      </div>
      <div class="card-controls">
        <input type="range" min="0" max="100" value="${peer.volume}" class="volume-slider">
        <span class="volume-label">${peer.volume}%</span>
        ${peer.needsManualReconnect ? `<button class="reconnect-btn" data-id="${id}">🔄</button>` : ''}
        ${currentUser?.isAdmin ? `<button class="kick-btn" data-id="${id}">강퇴</button>` : ''}
      </div>
    `;
    
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
      peer.audioEl.volume = vol / 100;
      peer.volume = vol;
      volumeStates.set(id, vol);
      label.textContent = vol + '%';
    };
    
    // 뮤트 버튼
    card.querySelector('[data-action="mute"]').onclick = () => {
      peer.muted = !peer.muted;
      applyMixerState();
      renderUsers();
    };
    
    // 솔로 버튼
    card.querySelector('[data-action="solo"]').onclick = () => {
      peer.solo = !peer.solo;
      applyMixerState();
      renderUsers();
    };
    
    // 팬 슬라이더
    const panSlider = card.querySelector('.pan-slider');
    panSlider.oninput = () => {
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

function startLatencyPing() {
  if (latencyInterval) clearInterval(latencyInterval);
  if (statsInterval) clearInterval(statsInterval);
  latencyHistory = [];
  
  // 상세 통계 수집 (2초마다)
  statsInterval = setInterval(async () => {
    let avgLatency = 0, count = 0;
    
    for (const [id, peer] of peers) {
      if (peer.pc.connectionState !== 'connected') continue;
      
      try {
        const stats = await peer.pc.getStats();
        let packetsLost = 0, packetsReceived = 0, jitter = 0, rtt = 0;
        
        stats.forEach(report => {
          if (report.type === 'inbound-rtp' && report.kind === 'audio') {
            packetsLost = report.packetsLost || 0;
            packetsReceived = report.packetsReceived || 0;
            jitter = (report.jitter || 0) * 1000;
          }
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            rtt = (report.currentRoundTripTime || 0) * 1000;
          }
        });
        
        const totalPackets = packetsLost + packetsReceived;
        const lossRate = totalPackets > 0 ? (packetsLost / totalPackets) * 100 : 0;
        
        peer.latency = Math.round(rtt);
        peer.packetLoss = lossRate;
        peer.jitter = jitter;
        const prevQuality = peer.quality?.grade;
        peer.quality = getQualityGrade(rtt, lossRate, jitter);
        
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
                sender.setParameters(params).catch(() => {});
              }
            }
          }
        }
      } catch (e) {}
    }
    
    // 지연 보상 적용
    if (delayCompensation) applyDelayCompensation();
    
    // 핑 그래프용 히스토리 저장
    if (count > 0) {
      latencyHistory.push(Math.round(avgLatency / count));
      if (latencyHistory.length > 30) latencyHistory.shift();
      renderPingGraph();
    }
    
    renderUsers();
  }, 2000);
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

// 지터 버퍼 적용 (기존 피어에)
function applyJitterBuffer() {
  peers.forEach(peer => {
    if (peer.pc) {
      peer.pc.getReceivers().forEach(receiver => {
        if (receiver.track?.kind === 'audio' && receiver.playoutDelayHint !== undefined) {
          receiver.playoutDelayHint = jitterBuffer / 1000;
        }
      });
    }
  });
}

// VAD (음성 활동 감지)
function startVAD(peerId, analyser) {
  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  const threshold = 30; // 음성 감지 임계값
  
  const interval = setInterval(() => {
    const peer = peers.get(peerId);
    if (!peer) { clearInterval(interval); return; }
    
    analyser.getByteFrequencyData(dataArray);
    const avg = dataArray.reduce((a, b) => a + b) / dataArray.length;
    const wasSpeaking = peer.isSpeaking;
    peer.isSpeaking = avg > threshold;
    
    // 상태 변경 시 UI 업데이트
    if (wasSpeaking !== peer.isSpeaking) {
      renderUsers();
      // 덕킹 적용
      if (duckingEnabled) applyDucking();
    }
  }, 100);
  
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
socket.on('user-joined', ({ id, username, avatar }) => {
  log(`새 사용자 입장: ${username} (${id}), initiator=true`);
  createPeerConnection(id, username, avatar, true);
  playSound('join');
  toast(`${username} 입장`, 'info', 2000);
});

socket.on('offer', async ({ from, offer }) => {
  try {
    log(`Offer 수신: ${from}`);
    let peer = peers.get(from);
    if (!peer) {
      log(`피어 없음, 새로 생성: ${from}`);
      createPeerConnection(from, '사용자', null, false);
      peer = peers.get(from);
    }
    const pc = peer.pc;
    
    // Perfect negotiation: glare 처리
    const offerCollision = pc.signalingState !== 'stable';
    const polite = socket.id > from;
    
    log(`Offer 처리: signalingState=${pc.signalingState}, collision=${offerCollision}, polite=${polite}`);
    
    if (offerCollision && !polite) {
      log('Offer 무시 (glare, impolite)');
      return;
    }
    
    if (offerCollision && polite) {
      log('Rollback 후 Offer 적용');
      await Promise.all([
        pc.setLocalDescription({ type: 'rollback' }),
        pc.setRemoteDescription(offer)
      ]);
    } else {
      await pc.setRemoteDescription(offer);
    }
    
    // 큐에 저장된 ICE 후보 처리
    await flushIceCandidateQueue(from);
    
    let answer = await pc.createAnswer();
    // Opus SDP 최적화 적용
    answer = new RTCSessionDescription({
      type: answer.type,
      sdp: optimizeOpusSdp(answer.sdp, audioMode)
    });
    await pc.setLocalDescription(answer);
    socket.emit('answer', { to: from, answer });
    log(`Answer 전송: ${from}`);
  } catch (e) {
    console.error('Offer 처리 실패:', e);
  }
});

socket.on('answer', async ({ from, answer }) => {
  log(`Answer 수신: ${from}`);
  const peer = peers.get(from);
  if (peer?.pc.signalingState === 'have-local-offer') {
    try { 
      await peer.pc.setRemoteDescription(answer); 
      log(`Answer 적용 완료: ${from}`);
      // 큐에 저장된 ICE 후보 처리
      await flushIceCandidateQueue(from);
    } catch (e) {
      console.error('Answer 적용 실패:', e);
    }
  } else {
    log(`Answer 무시: signalingState=${peer?.pc.signalingState}`);
  }
});

// 큐에 저장된 ICE 후보 처리
async function flushIceCandidateQueue(peerId) {
  const peer = peers.get(peerId);
  if (!peer?.iceCandidateQueue?.length) return;
  
  log(`ICE 후보 큐 처리: ${peerId} (${peer.iceCandidateQueue.length}개)`);
  for (const candidate of peer.iceCandidateQueue) {
    try {
      await peer.pc.addIceCandidate(candidate);
    } catch (e) {
      console.error('큐된 ICE 후보 추가 실패:', e);
    }
  }
  peer.iceCandidateQueue = [];
}

socket.on('ice-candidate', async ({ from, candidate }) => {
  try {
    const peer = peers.get(from);
    if (!peer || !candidate) return;
    
    // remoteDescription이 설정되지 않았으면 큐에 저장
    if (!peer.pc.remoteDescription) {
      if (!peer.iceCandidateQueue) peer.iceCandidateQueue = [];
      peer.iceCandidateQueue.push(candidate);
      log(`ICE 후보 큐잉: ${from} (remoteDescription 대기)`);
      return;
    }
    
    await peer.pc.addIceCandidate(candidate);
  } catch (e) {
    console.error('ICE 후보 추가 실패:', e);
  }
});

socket.on('user-left', ({ id }) => {
  const peer = peers.get(id);
  if (peer) {
    const username = peer.username;
    peer.pc.close();
    peer.audioEl.remove();
    // 오디오 노드 연결 해제 (공유 AudioContext는 닫지 않음)
    if (peer.audioNodes) {
      try {
        peer.audioNodes.source.disconnect();
        peer.audioNodes.compressor.disconnect();
        peer.audioNodes.panNode.disconnect();
        peer.audioNodes.gainNode.disconnect();
        peer.audioNodes.delayNode.disconnect();
        peer.audioNodes.peerAnalyser.disconnect();
      } catch {}
    }
    // VAD 인터벌 정리
    const vadInt = vadIntervals.get(id);
    if (vadInt) { clearInterval(vadInt); vadIntervals.delete(id); }
    peers.delete(id);
    renderUsers();
    playSound('leave');
    toast(`${username} 퇴장`, 'info', 2000);
  }
});

socket.on('user-updated', ({ id, avatar }) => {
  const peer = peers.get(id);
  if (peer) {
    peer.avatar = avatar;
    renderUsers();
  }
});

// 음소거
// 음소거 UI 업데이트
function updateMuteUI() {
  $('muteBtn').textContent = isMuted ? '🔇' : '🎤';
  $('muteBtn').classList.toggle('muted', isMuted);
}

// 오디오 스트림 재시작 (설정 변경 시)
async function restartAudioStream() {
  if (!localStream) return;
  
  const oldTracks = localStream.getAudioTracks();
  oldTracks.forEach(t => t.stop());
  
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
        echoCancellation: $('room-echo-cancel')?.checked ?? $('echo-cancel')?.checked ?? true,
        noiseSuppression: $('room-noise-suppress')?.checked ?? $('noise-suppress')?.checked ?? true,
        autoGainControl: true
      }
    });
    
    const newTrack = newStream.getAudioTracks()[0];
    localStream = newStream;
    
    // 모든 피어 연결에 새 트랙 적용
    peers.forEach(peer => {
      const sender = peer.pc.getSenders().find(s => s.track?.kind === 'audio');
      if (sender) sender.replaceTrack(newTrack);
    });
    
    // 음소거 상태 유지
    if (isMuted || pttMode) {
      newTrack.enabled = false;
    }
    
  } catch (e) {
    console.error('오디오 스트림 재시작 실패:', e);
    toast('오디오 설정 변경 실패', 'error');
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
  
  if (latencyInterval) { clearInterval(latencyInterval); latencyInterval = null; }
  if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
  if (meterInterval) { clearInterval(meterInterval); meterInterval = null; }
  // VAD 인터벌 정리
  vadIntervals.forEach(int => clearInterval(int));
  vadIntervals.clear();
  
  stopMetronome();
  cleanupRecording(); // Use cleanup function to handle AudioContext properly
  
  if (audioContext) { 
    try { audioContext.close(); } catch {} 
    audioContext = null; 
  }
  if (metronomeAudio) { 
    try { metronomeAudio.close(); } catch {} 
    metronomeAudio = null; 
  }
  // 피어 오디오용 공유 AudioContext 정리
  if (peerAudioContext) {
    try { peerAudioContext.close(); } catch {}
    peerAudioContext = null;
  }
  // 입력 리미터 AudioContext 정리
  if (inputLimiterContext) {
    try { inputLimiterContext.close(); } catch {}
    inputLimiterContext = null;
  }
  
  peers.forEach(peer => {
    peer.pc.close();
    peer.audioEl.remove();
    // 오디오 노드 연결 해제
    if (peer.audioNodes) {
      try {
        peer.audioNodes.source.disconnect();
      } catch {}
    }
  });
  peers.clear();
  volumeStates.clear();
  latencyHistory = [];
  
  // 원본 스트림도 정리
  localStream?._rawStream?.getTracks().forEach(t => t.stop());
  localStream?.getTracks().forEach(t => t.stop());
  localStream = null;
  
  // 상태 초기화
  isMuted = false;
  isPttActive = false;
  
  // UDP 정리
  cleanupUdp();
  
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

$('test-audio-btn').onclick = async () => {
  const btn = $('test-audio-btn');
  
  if (testStream) {
    // 테스트 중지
    testStream.getTracks().forEach(t => t.stop());
    testStream = null;
    if (testAnimationId) cancelAnimationFrame(testAnimationId);
    $('mic-level').style.width = '0%';
    btn.textContent = '🔍 마이크 테스트';
    return;
  }
  
  try {
    testStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
        echoCancellation: $('echo-cancel').checked,
        noiseSuppression: $('noise-suppress').checked
      }
    });
    
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(testStream);
    testAnalyser = ctx.createAnalyser();
    testAnalyser.fftSize = 256;
    source.connect(testAnalyser);
    
    btn.textContent = '⏹️ 테스트 중지';
    
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

// ===== 방 생성 모달 =====
window.openCreateRoomModal = () => {
  $('create-room-modal').classList.remove('hidden');
  $('new-room-name').value = '';
  $('new-room-password').value = '';
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
  const settings = {
    maxUsers: parseInt($('new-room-max-users')?.value) || 8,
    audioMode: $('new-room-audio-mode')?.value || 'music',
    sampleRate: parseInt($('new-room-sample-rate')?.value) || 48000,
    bitrate: parseInt($('new-room-bitrate')?.value) || 96,
    bpm: parseInt($('new-room-bpm')?.value) || 120,
    isPrivate: $('new-room-private')?.checked || false
  };
  
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
  
  // 방장이면 변경 가능한 UI 표시
  if (isRoomCreator || currentUser?.isAdmin) {
    container.innerHTML = `
      <span class="room-setting-item" title="오디오 모드">
        <select id="room-mode-select" class="room-setting-select">
          <option value="voice" ${s.audioMode === 'voice' ? 'selected' : ''}>🎤 음성</option>
          <option value="music" ${s.audioMode === 'music' ? 'selected' : ''}>🎸 악기</option>
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
    $('room-bitrate-select').onchange = (e) => updateRoomSetting('bitrate', parseInt(e.target.value));
  } else {
    container.innerHTML = `
      <span class="room-setting-item">${modeLabel}</span>
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
  displayRoomSettings();
  
  // 오디오 모드 변경 시 코덱 설정 업데이트
  if (setting === 'audioMode') {
    audioMode = value;
    peers.forEach(peer => applyAudioSettings(peer.pc));
    toast(`오디오 모드: ${value === 'voice' ? '음성' : '악기'}`, 'info');
  }
  if (setting === 'bitrate') {
    toast(`비트레이트: ${value}kbps`, 'info');
  }
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
      if (peer.audioEl?.setSinkId) peer.audioEl.setSinkId(selectedOutputId).catch(() => {});
    });
  };
}

if ($('room-echo-cancel')) {
  $('room-echo-cancel').onchange = async () => { if (localStream) await restartAudioStream(); };
}

if ($('room-noise-suppress')) {
  $('room-noise-suppress').onchange = async () => { if (localStream) await restartAudioStream(); };
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

// 방 내 VAD
if ($('room-vad-mode')) {
  $('room-vad-mode').checked = vadEnabled;
  $('room-vad-mode').onchange = () => {
    vadEnabled = $('room-vad-mode').checked;
    localStorage.setItem('styx-vad', vadEnabled);
    if ($('vad-mode')) $('vad-mode').checked = vadEnabled;
  };
}

// 방 내 자동 품질
if ($('room-auto-adapt')) {
  $('room-auto-adapt').checked = autoAdapt;
  $('room-auto-adapt').onchange = () => {
    autoAdapt = $('room-auto-adapt').checked;
    localStorage.setItem('styx-auto-adapt', autoAdapt);
    if ($('auto-adapt')) $('auto-adapt').checked = autoAdapt;
  };
}

// 방 내 자동 볼륨 (덕킹)
if ($('room-ducking')) {
  $('room-ducking').checked = duckingEnabled;
  $('room-ducking').onchange = () => {
    duckingEnabled = $('room-ducking').checked;
    localStorage.setItem('styx-ducking', duckingEnabled);
    if ($('ducking-mode')) $('ducking-mode').checked = duckingEnabled;
  };
}

// 지연 보상
if ($('delay-compensation')) {
  $('delay-compensation').onchange = () => {
    delayCompensation = $('delay-compensation').checked;
    socket.emit('delay-compensation', delayCompensation);
  };
}


// ===== Inline 이벤트 핸들러 대체 =====
$('themeBtn').onclick = toggleTheme;
$('webrtcModeBtn')?.addEventListener('click', () => setConnectionMode('webrtc'));
$('udpModeBtn')?.addEventListener('click', () => setConnectionMode('udp'));
document.querySelectorAll('.modal-backdrop').forEach(el => {
  el.onclick = () => {
    closeCreateRoomModal();
    $('settings-panel')?.classList.add('hidden');
    $('admin-panel')?.classList.add('hidden');
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
    audioMode, jitterBuffer, autoAdapt, echoCancellation, noiseSuppression,
    pttMode, pttKey, duckingEnabled, vadEnabled, connectionMode,
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
  pttMode = s.pttMode ?? pttMode;
  pttKey = s.pttKey ?? pttKey;
  duckingEnabled = s.duckingEnabled ?? duckingEnabled;
  vadEnabled = s.vadEnabled ?? vadEnabled;
  connectionMode = s.connectionMode ?? connectionMode;
  if (s.theme) document.documentElement.setAttribute('data-theme', s.theme);
  // localStorage 동기화
  localStorage.setItem('styx-audio-mode', audioMode);
  localStorage.setItem('styx-jitter-buffer', jitterBuffer);
  localStorage.setItem('styx-auto-adapt', autoAdapt);
  localStorage.setItem('styx-echo', echoCancellation);
  localStorage.setItem('styx-noise', noiseSuppression);
  localStorage.setItem('styx-ptt', pttMode);
  localStorage.setItem('styx-ptt-key', pttKey);
  localStorage.setItem('styx-ducking', duckingEnabled);
  localStorage.setItem('styx-vad', vadEnabled);
  localStorage.setItem('styx-connection-mode', connectionMode);
  localStorage.setItem('styx-theme', s.theme || 'dark');
}

let settingsSaveTimer = null;
function scheduleSettingsSave() {
  if (settingsSaveTimer) return;
  settingsSaveTimer = setTimeout(() => {
    settingsSaveTimer = null;
    socket.emit('save-settings', { settings: collectSettings() });
  }, 10000);
}
