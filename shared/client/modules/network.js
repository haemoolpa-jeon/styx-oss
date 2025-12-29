// Styx - Network Module
// Socket.io, WebRTC, UDP/TCP handling

import { $, state, log, serverUrl, actuallyTauri, tauriInvoke } from './core.js';
import { toast, showReconnectProgress, updateReconnectProgress, hideReconnectProgress } from './ui.js';

// Socket.io connection
export const socket = io(serverUrl, { 
  reconnection: true, 
  reconnectionDelay: 1000, 
  reconnectionAttempts: 10 
});

// Reconnection handlers
socket.io.on('reconnect_attempt', (attempt) => showReconnectProgress(attempt));
socket.io.on('reconnect_error', () => updateReconnectProgress());
socket.io.on('reconnect_failed', () => {
  hideReconnectProgress();
  toast('서버 연결 실패 - 페이지를 새로고침해주세요', 'error', 10000);
});

socket.on('connect', () => {
  log('Socket connected');
  hideReconnectProgress();
});

socket.on('disconnect', (reason) => {
  log('Socket disconnected:', reason);
  if (reason === 'io server disconnect') {
    socket.connect();
  }
});

// WebRTC configuration
export let rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
  iceCandidatePoolSize: 10,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
};

// Update TURN credentials
export function updateTurnCredentials(credentials) {
  if (!credentials) return;
  rtcConfig.iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls: credentials.urls,
      username: credentials.username,
      credential: credentials.credential,
    }
  ];
  log('TURN credentials updated');
}

// NAT detection
export async function detectNatType() {
  if (!actuallyTauri || !tauriInvoke) return { nat_type: 'Unknown', public_addr: '' };
  try {
    return await tauriInvoke('detect_nat');
  } catch (e) {
    log('NAT detection failed:', e);
    return { nat_type: 'Unknown', public_addr: '' };
  }
}

// P2P connection attempt
export async function attemptP2P(peerAddr) {
  if (!actuallyTauri || !tauriInvoke) return false;
  try {
    return await tauriInvoke('attempt_p2p', { peerAddr });
  } catch (e) {
    log('P2P attempt failed:', e);
    return false;
  }
}

// UDP mode (Tauri only)
let udpPort = null;

export async function startUdpMode(relayHost, relayPort, sessionId) {
  if (!actuallyTauri || !tauriInvoke) {
    toast('UDP 모드는 데스크톱 앱에서만 사용 가능합니다', 'warning');
    return false;
  }
  
  try {
    udpPort = await tauriInvoke('udp_bind', { port: 0 });
    log('UDP bound to port:', udpPort);
    
    await tauriInvoke('udp_set_relay', { host: relayHost, port: relayPort, sessionId });
    await tauriInvoke('udp_start_relay_stream');
    
    toast('UDP 오디오 스트림 시작', 'success');
    return true;
  } catch (e) {
    log('UDP start failed:', e);
    toast('UDP 시작 실패: ' + e, 'error');
    return false;
  }
}

export async function stopUdpMode() {
  if (!actuallyTauri || !tauriInvoke) return;
  try {
    await tauriInvoke('udp_stop_stream');
    udpPort = null;
  } catch (e) {
    log('UDP stop error:', e);
  }
}

export async function setUdpMuted(muted) {
  if (!actuallyTauri || !tauriInvoke) return;
  try {
    await tauriInvoke('udp_set_muted', { muted });
  } catch (e) {
    log('UDP mute error:', e);
  }
}

// UDP stats
export async function getUdpStats() {
  if (!actuallyTauri || !tauriInvoke) return null;
  try {
    return await tauriInvoke('get_udp_stats');
  } catch (e) {
    return null;
  }
}

// Latency measurement
export async function measureRelayLatency() {
  if (!actuallyTauri || !tauriInvoke) return null;
  try {
    return await tauriInvoke('measure_relay_latency');
  } catch (e) {
    return null;
  }
}

// Bitrate control
export async function setBitrate(kbps) {
  if (!actuallyTauri || !tauriInvoke) return;
  try {
    await tauriInvoke('set_bitrate', { bitrateKbps: kbps });
  } catch (e) {
    log('Bitrate set error:', e);
  }
}

// Connection quality assessment
export function getQualityGrade(latency, packetLoss, jitter) {
  if (packetLoss > 5 || latency > 200 || jitter > 50) return { grade: 'poor', label: '불안정', color: '#ff4757' };
  if (packetLoss > 2 || latency > 100 || jitter > 30) return { grade: 'fair', label: '보통', color: '#ffa502' };
  return { grade: 'good', label: '좋음', color: '#2ed573' };
}

// SDP optimization for Opus
export function optimizeOpusSdp(sdp, mode = 'balanced') {
  const modes = {
    'low-latency': { maxaveragebitrate: 64000, stereo: 0, useinbandfec: 0, usedtx: 1, maxptime: 10 },
    'balanced': { maxaveragebitrate: 96000, stereo: 1, useinbandfec: 1, usedtx: 0, maxptime: 20 },
    'high-quality': { maxaveragebitrate: 128000, stereo: 1, useinbandfec: 1, usedtx: 0, maxptime: 40 },
  };
  
  const config = modes[mode] || modes.balanced;
  const fmtpLine = `a=fmtp:111 minptime=10;maxptime=${config.maxptime};useinbandfec=${config.useinbandfec};usedtx=${config.usedtx};stereo=${config.stereo};maxaveragebitrate=${config.maxaveragebitrate}`;
  
  return sdp.replace(/a=fmtp:111[^\r\n]*/g, fmtpLine);
}
