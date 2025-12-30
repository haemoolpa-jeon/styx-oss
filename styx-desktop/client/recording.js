// Styx Recording Module
// 녹음 기능 (믹스다운, 멀티트랙, 루프백)
(function() {

let recordingAudioCtx = null;
let multitrackRecorders = new Map();
let multitrackMode = localStorage.getItem('styx-multitrack') === 'true';
let loopbackMode = localStorage.getItem('styx-loopback') === 'true';
let recordingMarkers = [];
let recordingStartTime = 0;
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;

const DEBUG = window.DEBUG ?? false;

function formatTime(ms) {
  if (window.StyxUtils?.formatTime) return window.StyxUtils.formatTime(ms);
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

function addRecordingMarker(label = '') {
  if (!isRecording) return;
  const elapsed = Date.now() - recordingStartTime;
  const marker = { time: elapsed, label: label || `Marker ${recordingMarkers.length + 1}` };
  recordingMarkers.push(marker);
  if (window.toast) toast(`마커 추가: ${formatTime(elapsed)}`, 'info', 1500);
}

function exportMarkers(filename) {
  if (recordingMarkers.length === 0) return;
  const content = recordingMarkers.map(m => `${formatTime(m.time)}\t${m.label}`).join('\n');
  const blob = new Blob([content], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${filename}_markers.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function downloadTrack(chunks, name) {
  const M = window.StyxModules || {};
  const blob = new Blob(chunks, { type: 'audio/webm' });
  if (M.core?.downloadBlob) return M.core.downloadBlob(blob, `styx-${name}.webm`);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `styx-${name}.webm`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function startRecording() {
  if (isRecording) return;
  
  const localStream = window.localStream;
  const currentUser = window.currentUser;
  const peers = window.peers;
  const $ = id => document.getElementById(id);
  
  const timestamp = new Date().toISOString().slice(0,19).replace(/:/g,'-');
  recordingMarkers = [];
  recordingStartTime = Date.now();
  
  if (multitrackMode) {
    multitrackRecorders.clear();
    
    if (localStream && currentUser) {
      const rec = new MediaRecorder(localStream, { mimeType: 'audio/webm' });
      const chunks = [];
      rec.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
      rec.onstop = () => downloadTrack(chunks, `${timestamp}_${currentUser.username}_local`);
      rec.start();
      multitrackRecorders.set('local', { recorder: rec, chunks, username: currentUser.username });
    }
    
    peers.forEach((peer, id) => {
      if (peer.audioEl?.srcObject) {
        const rec = new MediaRecorder(peer.audioEl.srcObject, { mimeType: 'audio/webm' });
        const chunks = [];
        rec.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
        rec.onstop = () => downloadTrack(chunks, `${timestamp}_${peer.username}`);
        rec.start();
        multitrackRecorders.set(id, { recorder: rec, chunks, username: peer.username });
      }
    });
    
    if (window.toast) toast(`멀티트랙 녹음 시작 (${multitrackRecorders.size}개 트랙)`, 'info');
  } else if (loopbackMode) {
    recordingAudioCtx = new AudioContext();
    const dest = recordingAudioCtx.createMediaStreamDestination();
    
    peers.forEach(peer => {
      if (peer.audioEl?.srcObject) {
        recordingAudioCtx.createMediaStreamSource(peer.audioEl.srcObject).connect(dest);
      }
    });
    
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(dest.stream, { mimeType: 'audio/webm' });
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      if (recordingAudioCtx) { recordingAudioCtx.close().catch(e => { if (DEBUG) console.debug('Silent error:', e); }); recordingAudioCtx = null; }
      downloadTrack(recordedChunks, `${timestamp}_loopback`);
    };
    mediaRecorder.start();
    if (window.toast) toast('루프백 녹음 시작 (내가 듣는 소리)', 'info');
  } else {
    recordingAudioCtx = new AudioContext();
    const dest = recordingAudioCtx.createMediaStreamDestination();
    
    if (localStream) {
      recordingAudioCtx.createMediaStreamSource(localStream).connect(dest);
    }
    peers.forEach(peer => {
      if (peer.audioEl?.srcObject) {
        recordingAudioCtx.createMediaStreamSource(peer.audioEl.srcObject).connect(dest);
      }
    });
    
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(dest.stream, { mimeType: 'audio/webm' });
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      if (recordingAudioCtx) { recordingAudioCtx.close().catch(e => { if (DEBUG) console.debug('Silent error:', e); }); recordingAudioCtx = null; }
      downloadTrack(recordedChunks, `${timestamp}_mix`);
    };
    mediaRecorder.start();
    if (window.toast) toast('녹음 시작', 'info');
  }
  
  isRecording = true;
  const recordBtn = $('recordBtn');
  if (recordBtn) {
    recordBtn.textContent = '⏹️';
    recordBtn.title = '녹음 중지';
    recordBtn.classList.add('recording');
  }
}

function stopRecording() {
  if (!isRecording) return;
  
  const $ = id => document.getElementById(id);
  const timestamp = new Date().toISOString().slice(0,19).replace(/:/g,'-');
  
  if (multitrackMode && multitrackRecorders.size > 0) {
    multitrackRecorders.forEach(({ recorder }) => recorder.stop());
    multitrackRecorders.clear();
    if (window.toast) toast('멀티트랙 녹음 완료 - 파일 다운로드 중', 'success');
  } else if (mediaRecorder) {
    mediaRecorder.stop();
    if (window.toast) toast('녹음 파일이 다운로드되었습니다', 'success');
  }
  
  if (recordingMarkers.length > 0) {
    exportMarkers(`styx-${timestamp}`);
  }
  
  isRecording = false;
  const recordBtn = $('recordBtn');
  if (recordBtn) {
    recordBtn.textContent = '⏺️';
    recordBtn.title = '녹음';
    recordBtn.classList.remove('recording');
  }
}

function cleanupRecording() {
  if (isRecording) {
    if (multitrackMode) {
      multitrackRecorders.forEach(({ recorder }) => { try { recorder.stop(); } catch {} });
      multitrackRecorders.clear();
    } else if (mediaRecorder) {
      mediaRecorder.stop();
    }
  }
  if (recordingAudioCtx) { recordingAudioCtx.close().catch(e => { if (DEBUG) console.debug('Silent error:', e); }); recordingAudioCtx = null; }
  isRecording = false;
}

function toggleRecording() {
  isRecording ? stopRecording() : startRecording();
}

function setMultitrackMode(enabled) {
  multitrackMode = enabled;
  localStorage.setItem('styx-multitrack', enabled);
}

function setLoopbackMode(enabled) {
  loopbackMode = enabled;
  localStorage.setItem('styx-loopback', enabled);
}

window.StyxRecording = {
  get isRecording() { return isRecording; },
  startRecording,
  stopRecording,
  toggleRecording,
  cleanupRecording,
  addRecordingMarker,
  setMultitrackMode,
  setLoopbackMode,
  get multitrackMode() { return multitrackMode; },
  get loopbackMode() { return loopbackMode; }
};

})();
