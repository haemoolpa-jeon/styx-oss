// Styx - Recording Module
// Recording, multitrack, export functionality

import { $, state, log } from './core.js';
import { toast } from './ui.js';

let recordingAudioCtx = null;
let multitrackRecorders = new Map();
let recordingMarkers = [];
let recordingStartTime = 0;

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, '0')}`;
}

function downloadTrack(chunks, name) {
  const blob = new Blob(chunks, { type: 'audio/webm' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `styx-${name}.webm`;
  a.click();
  URL.revokeObjectURL(a.href);
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

export function addRecordingMarker(label = '') {
  if (!state.isRecording) return;
  const elapsed = Date.now() - recordingStartTime;
  const marker = { time: elapsed, label: label || `Marker ${recordingMarkers.length + 1}` };
  recordingMarkers.push(marker);
  toast(`마커 추가: ${formatTime(elapsed)}`, 'info', 1500);
}

export function startRecording() {
  if (state.isRecording) return;
  
  const timestamp = new Date().toISOString().slice(0,19).replace(/:/g,'-');
  recordingMarkers = [];
  recordingStartTime = Date.now();
  
  if (state.multitrackMode) {
    multitrackRecorders.clear();
    
    // Local audio
    if (state.localStream) {
      const rec = new MediaRecorder(state.localStream, { mimeType: 'audio/webm' });
      const chunks = [];
      rec.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
      rec.onstop = () => downloadTrack(chunks, `${timestamp}_${state.currentUser.username}_local`);
      rec.start();
      multitrackRecorders.set('local', { recorder: rec, chunks, username: state.currentUser.username });
    }
    
    // Remote peers
    state.peers.forEach((peer, id) => {
      if (peer.audioEl?.srcObject) {
        const rec = new MediaRecorder(peer.audioEl.srcObject, { mimeType: 'audio/webm' });
        const chunks = [];
        rec.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
        rec.onstop = () => downloadTrack(chunks, `${timestamp}_${peer.username}`);
        rec.start();
        multitrackRecorders.set(id, { recorder: rec, chunks, username: peer.username });
      }
    });
    
    toast(`멀티트랙 녹음 시작 (${multitrackRecorders.size}개 트랙)`, 'info');
  } else if (state.loopbackMode) {
    recordingAudioCtx = new AudioContext();
    const dest = recordingAudioCtx.createMediaStreamDestination();
    
    state.peers.forEach(peer => {
      if (peer.audioEl?.srcObject) {
        recordingAudioCtx.createMediaStreamSource(peer.audioEl.srcObject).connect(dest);
      }
    });
    
    state.recordedChunks = [];
    state.mediaRecorder = new MediaRecorder(dest.stream, { mimeType: 'audio/webm' });
    state.mediaRecorder.ondataavailable = e => { if (e.data.size > 0) state.recordedChunks.push(e.data); };
    state.mediaRecorder.onstop = () => {
      if (recordingAudioCtx) { recordingAudioCtx.close().catch(() => {}); recordingAudioCtx = null; }
      downloadTrack(state.recordedChunks, `${timestamp}_loopback`);
    };
    state.mediaRecorder.start();
    toast('루프백 녹음 시작', 'info');
  } else {
    recordingAudioCtx = new AudioContext();
    const dest = recordingAudioCtx.createMediaStreamDestination();
    
    if (state.localStream) {
      recordingAudioCtx.createMediaStreamSource(state.localStream).connect(dest);
    }
    state.peers.forEach(peer => {
      if (peer.audioEl?.srcObject) {
        recordingAudioCtx.createMediaStreamSource(peer.audioEl.srcObject).connect(dest);
      }
    });
    
    state.recordedChunks = [];
    state.mediaRecorder = new MediaRecorder(dest.stream, { mimeType: 'audio/webm' });
    state.mediaRecorder.ondataavailable = e => { if (e.data.size > 0) state.recordedChunks.push(e.data); };
    state.mediaRecorder.onstop = () => {
      if (recordingAudioCtx) { recordingAudioCtx.close().catch(() => {}); recordingAudioCtx = null; }
      downloadTrack(state.recordedChunks, `${timestamp}_mix`);
    };
    state.mediaRecorder.start();
    toast('녹음 시작', 'info');
  }
  
  state.isRecording = true;
  updateRecordingUI(true);
}

export function stopRecording() {
  if (!state.isRecording) return;
  
  const timestamp = new Date().toISOString().slice(0,19).replace(/:/g,'-');
  
  if (state.multitrackMode && multitrackRecorders.size > 0) {
    multitrackRecorders.forEach(({ recorder }) => recorder.stop());
    multitrackRecorders.clear();
    toast('멀티트랙 녹음 완료', 'success');
  } else if (state.mediaRecorder) {
    state.mediaRecorder.stop();
    toast('녹음 완료', 'success');
  }
  
  if (recordingMarkers.length > 0) {
    exportMarkers(`styx-${timestamp}`);
  }
  
  state.isRecording = false;
  updateRecordingUI(false);
}

export function toggleRecording() {
  state.isRecording ? stopRecording() : startRecording();
}

export function cleanupRecording() {
  if (state.isRecording) {
    if (state.multitrackMode) {
      multitrackRecorders.forEach(({ recorder }) => { try { recorder.stop(); } catch {} });
      multitrackRecorders.clear();
    } else if (state.mediaRecorder) {
      state.mediaRecorder.stop();
    }
  }
  if (recordingAudioCtx) { recordingAudioCtx.close().catch(() => {}); recordingAudioCtx = null; }
  state.isRecording = false;
}

function updateRecordingUI(recording) {
  const btn = $('recordBtn');
  if (btn) {
    btn.textContent = recording ? '⏹️ 녹음 중' : '⏺️ 녹음';
    btn.classList.toggle('recording', recording);
  }
}

// Click track export
export function exportClickTrack(bpm, bars = 4) {
  const sampleRate = 48000;
  const beatDuration = 60 / bpm;
  const totalBeats = bars * 4;
  const totalSamples = Math.ceil(totalBeats * beatDuration * sampleRate);
  
  const ctx = new OfflineAudioContext(1, totalSamples, sampleRate);
  
  for (let i = 0; i < totalBeats; i++) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = (i % 4 === 0) ? 1000 : 800;
    gain.gain.value = 0.5;
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    const startTime = i * beatDuration;
    osc.start(startTime);
    osc.stop(startTime + 0.05);
  }
  
  ctx.startRendering().then(buffer => {
    const wav = audioBufferToWav(buffer);
    const blob = new Blob([wav], { type: 'audio/wav' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `click-${bpm}bpm-${bars}bars.wav`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('클릭 트랙 내보내기 완료', 'success');
  });
}

function audioBufferToWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1;
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataLength = buffer.length * blockAlign;
  const bufferLength = 44 + dataLength;
  const arrayBuffer = new ArrayBuffer(bufferLength);
  const view = new DataView(arrayBuffer);
  
  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  
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
  
  const channelData = buffer.getChannelData(0);
  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    const sample = Math.max(-1, Math.min(1, channelData[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
    offset += 2;
  }
  
  return arrayBuffer;
}
