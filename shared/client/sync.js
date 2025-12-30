// Styx Sync Module
// 동기화 모드 - 지연 보정으로 모든 참가자가 동시에 듣기

let estimatedDeviceLatency = 20; // ms, default estimate
let syncDelayBuffers = new Map();
let maxRoomLatency = 0;

const DEBUG = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

async function calibrateDeviceLatency() {
  const localStream = window.localStream;
  if (!localStream) return;
  
  try {
    const ctx = new AudioContext();
    const oscillator = ctx.createOscillator();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    
    oscillator.frequency.value = 1000;
    oscillator.connect(ctx.destination);
    
    const source = ctx.createMediaStreamSource(localStream);
    source.connect(analyser);
    
    const startTime = performance.now();
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.05);
    
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let detected = false;
    
    const checkLoop = () => {
      if (detected || performance.now() - startTime > 200) {
        ctx.close();
        if (!detected) {
          console.log('[SYNC] Device calibration: no loopback detected, using default');
        }
        return;
      }
      
      analyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b) / dataArray.length;
      
      if (avg > 50) {
        detected = true;
        estimatedDeviceLatency = Math.round(performance.now() - startTime);
        console.log(`[SYNC] Device latency calibrated: ${estimatedDeviceLatency}ms`);
        if (window.toast) toast(`오디오 장치 지연: ${estimatedDeviceLatency}ms`, 'info', 2000);
      } else {
        requestAnimationFrame(checkLoop);
      }
    };
    
    setTimeout(checkLoop, 10);
  } catch (e) {
    console.warn('[SYNC] Device calibration failed:', e);
  }
}

function calculateSyncDelays() {
  const syncMode = window.syncMode;
  const selfStats = window.selfStats;
  const peerLatencies = window.peerLatencies;
  const jitterBuffer = window.jitterBuffer;
  const actuallyTauri = window.actuallyTauri;
  const tauriInvoke = window.tauriInvoke;
  const $ = id => document.getElementById(id);
  
  if (!syncMode) return;
  
  let maxLatency = (selfStats.latency || 0) + estimatedDeviceLatency;
  peerLatencies.forEach(lat => {
    const totalLat = lat + estimatedDeviceLatency;
    if (totalLat > maxLatency) maxLatency = totalLat;
  });
  
  maxRoomLatency = maxLatency + jitterBuffer;
  
  console.log(`[SYNC] Max room latency: ${maxRoomLatency}ms (device: ${estimatedDeviceLatency}ms)`);
  
  if (actuallyTauri) {
    const frames = Math.ceil(maxRoomLatency / 5);
    tauriInvoke('set_jitter_buffer', { size: frames }).catch(e => {
      console.error('[SYNC] Failed to set jitter buffer:', e);
    });
  }
  
  const display = $('sync-latency-display');
  if (display) {
    display.textContent = `동기화 지연: ${maxRoomLatency}ms`;
  }
}

function broadcastLatency() {
  const syncMode = window.syncMode;
  const selfStats = window.selfStats;
  const socket = window.socket;
  
  if (syncMode && selfStats.latency) {
    const totalLatency = selfStats.latency + estimatedDeviceLatency;
    socket.emit('peer-latency', { latency: totalLatency });
  }
}

function clearSyncDelays() {
  const actuallyTauri = window.actuallyTauri;
  const tauriInvoke = window.tauriInvoke;
  
  syncDelayBuffers.clear();
  maxRoomLatency = 0;
  
  if (actuallyTauri) {
    tauriInvoke('set_jitter_buffer', { size: 2 }).catch(e => { if (DEBUG) console.debug('Silent error:', e); });
  }
}

function initSyncSocketHandlers() {
  const socket = window.socket;
  const peerLatencies = window.peerLatencies;
  
  socket.on('peer-latency', ({ peerId, latency }) => {
    peerLatencies.set(peerId, latency);
    if (window.syncMode) {
      calculateSyncDelays();
    }
  });
}

// Export to window
window.StyxSync = {
  get estimatedDeviceLatency() { return estimatedDeviceLatency; },
  get maxRoomLatency() { return maxRoomLatency; },
  calibrateDeviceLatency,
  calculateSyncDelays,
  broadcastLatency,
  clearSyncDelays,
  initSyncSocketHandlers
};
