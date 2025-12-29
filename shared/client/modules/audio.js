// Styx - Audio Module
// Audio processing, effects, meters, spectrum analyzer

import { $, state, log } from './core.js';
import { toast } from './ui.js';
import { getEffects, setEffects, getNoiseProfile, setNoiseProfile } from './settings.js';

// Shared AudioContext
let sharedAudioContext = null;

export function getSharedAudioContext() {
  if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
    sharedAudioContext = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
  }
  if (sharedAudioContext.state === 'suspended') {
    sharedAudioContext.resume();
  }
  return sharedAudioContext;
}

// Effect nodes
let effectNodes = {};
let noiseGateWorklet = null;
let inputEffects = getEffects();

// Create processed input stream with EQ, compressor, noise gate
export async function createProcessedInputStream(rawStream) {
  if (state.proMode) {
    state.processedStream = rawStream;
    effectNodes = {};
    return rawStream;
  }
  
  const ctx = getSharedAudioContext();
  const source = ctx.createMediaStreamSource(rawStream);
  
  // 3-band EQ
  const eqLow = ctx.createBiquadFilter();
  eqLow.type = 'lowshelf'; eqLow.frequency.value = 320; eqLow.gain.value = inputEffects.eqLow;
  
  const eqMid = ctx.createBiquadFilter();
  eqMid.type = 'peaking'; eqMid.frequency.value = 1000; eqMid.Q.value = 1; eqMid.gain.value = inputEffects.eqMid;
  
  const eqHigh = ctx.createBiquadFilter();
  eqHigh.type = 'highshelf'; eqHigh.frequency.value = 3200; eqHigh.gain.value = inputEffects.eqHigh;
  
  let lastNode = eqHigh;
  
  // AI noise gate (AudioWorklet)
  const noiseProfile = getNoiseProfile();
  try {
    await ctx.audioWorklet.addModule('noise-gate-processor.js');
    noiseGateWorklet = new AudioWorkletNode(ctx, 'noise-gate-processor');
    const thresholdParam = noiseGateWorklet.parameters.get('threshold');
    if (thresholdParam) {
      thresholdParam.value = noiseProfile.adaptiveThreshold > -60 ? noiseProfile.adaptiveThreshold : -45;
    }
    eqHigh.connect(noiseGateWorklet);
    lastNode = noiseGateWorklet;
  } catch (e) { log('Noise gate worklet failed:', e); }
  
  // Compressor/limiter
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -12; compressor.knee.value = 6;
  compressor.ratio.value = inputEffects.compressionRatio || 4;
  compressor.attack.value = 0.003; compressor.release.value = 0.1;
  
  // Makeup gain
  const makeupGain = ctx.createGain();
  makeupGain.gain.value = inputEffects.inputVolume / 100;
  
  const dest = ctx.createMediaStreamDestination();
  
  // Chain: source -> EQ -> [noiseGate] -> compressor -> gain -> dest
  source.connect(eqLow);
  eqLow.connect(eqMid);
  eqMid.connect(eqHigh);
  lastNode.connect(compressor);
  compressor.connect(makeupGain);
  makeupGain.connect(dest);
  
  effectNodes = { eqLow, eqMid, eqHigh, compressor, makeupGain, noiseGate: noiseGateWorklet };
  state.processedStream = dest.stream;
  return state.processedStream;
}

// Update effect parameter
export function updateInputEffect(effect, value) {
  inputEffects[effect] = value;
  setEffects(inputEffects);
  
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
      state.peers.forEach(peer => {
        if (peer.compressor) peer.compressor.ratio.value = value;
      });
      break;
  }
}

// Spectrum analyzer
let spectrumAnalyser = null;
let spectrumCanvas = null;
let spectrumCtx = null;
let spectrumAnimationId = null;
let spectrumEnabled = false;

export function initSpectrum() {
  spectrumCanvas = $('spectrum-canvas');
  if (spectrumCanvas) spectrumCtx = spectrumCanvas.getContext('2d');
}

export function toggleSpectrum() {
  spectrumEnabled = !spectrumEnabled;
  const container = $('spectrum-container');
  
  if (spectrumEnabled) {
    container?.classList.remove('hidden');
    if (state.localStream) startSpectrum();
  } else {
    container?.classList.add('hidden');
    stopSpectrum();
  }
}

function startSpectrum() {
  if (!state.localStream || !spectrumCtx) return;
  
  const ctx = getSharedAudioContext();
  spectrumAnalyser = ctx.createAnalyser();
  spectrumAnalyser.fftSize = 256;
  spectrumAnalyser.smoothingTimeConstant = 0.8;
  
  const source = ctx.createMediaStreamSource(state.localStream);
  source.connect(spectrumAnalyser);
  
  drawSpectrum();
}

function stopSpectrum() {
  if (spectrumAnimationId) {
    cancelAnimationFrame(spectrumAnimationId);
    spectrumAnimationId = null;
  }
  if (spectrumAnalyser) {
    try { spectrumAnalyser.disconnect(); } catch {}
    spectrumAnalyser = null;
  }
}

function drawSpectrum() {
  if (!spectrumEnabled || !spectrumAnalyser || !spectrumCtx) return;
  
  const bufferLength = spectrumAnalyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  spectrumAnalyser.getByteFrequencyData(dataArray);
  
  const width = spectrumCanvas.width;
  const height = spectrumCanvas.height;
  
  spectrumCtx.fillStyle = 'rgba(0, 0, 0, 0.2)';
  spectrumCtx.fillRect(0, 0, width, height);
  
  const barWidth = width / bufferLength * 2;
  let x = 0;
  
  for (let i = 0; i < bufferLength; i++) {
    const barHeight = (dataArray[i] / 255) * height;
    const hue = (i / bufferLength) * 240;
    spectrumCtx.fillStyle = `hsl(${hue}, 70%, 50%)`;
    spectrumCtx.fillRect(x, height - barHeight, barWidth, barHeight);
    x += barWidth + 1;
  }
  
  spectrumAnimationId = requestAnimationFrame(drawSpectrum);
}

// Audio meter
let meterInterval = null;
let analyser = null;

export function startAudioMeter() {
  if (!state.localStream) return;
  
  const ctx = getSharedAudioContext();
  analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  
  const source = ctx.createMediaStreamSource(state.localStream);
  source.connect(analyser);
  
  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  
  meterInterval = setInterval(() => {
    analyser.getByteFrequencyData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
    const avg = sum / dataArray.length;
    const level = Math.min(100, (avg / 128) * 100);
    
    const meter = $('audio-meter-fill');
    if (meter) meter.style.width = level + '%';
  }, 50);
}

export function stopAudioMeter() {
  if (meterInterval) {
    clearInterval(meterInterval);
    meterInterval = null;
  }
  if (analyser) {
    try { analyser.disconnect(); } catch {}
    analyser = null;
  }
}

// Noise profiling
let noiseProfile = getNoiseProfile();

export function startNoiseLearning() {
  if (!state.localStream) return;
  
  noiseProfile.isLearning = true;
  noiseProfile.learningData = [];
  
  const btn = $('learn-noise');
  if (btn) { btn.textContent = '학습중...'; btn.disabled = true; }
  
  const ctx = getSharedAudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.3;
  
  const source = ctx.createMediaStreamSource(state.localStream);
  source.connect(analyser);
  
  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  let sampleCount = 0;
  
  const collectSample = () => {
    if (!noiseProfile.isLearning) return;
    
    analyser.getByteFrequencyData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) sum += dataArray[i] * dataArray[i];
    const rms = Math.sqrt(sum / dataArray.length);
    const dbLevel = 20 * Math.log10(rms / 255);
    
    noiseProfile.learningData.push(dbLevel);
    sampleCount++;
    
    if (sampleCount < 30) {
      setTimeout(collectSample, 100);
    } else {
      finishNoiseLearning(analyser);
    }
  };
  
  collectSample();
}

function finishNoiseLearning(analyser) {
  noiseProfile.isLearning = false;
  
  if (noiseProfile.learningData.length > 0) {
    const sorted = noiseProfile.learningData.sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const q75 = sorted[Math.floor(sorted.length * 0.75)];
    
    noiseProfile.baselineLevel = median;
    noiseProfile.adaptiveThreshold = Math.max(median + 10, q75 + 5);
    
    setNoiseProfile({ baselineLevel: noiseProfile.baselineLevel, adaptiveThreshold: noiseProfile.adaptiveThreshold });
    toast(`노이즈 프로파일 학습 완료 (${Math.round(noiseProfile.baselineLevel)}dB)`, 'success');
  }
  
  const btn = $('learn-noise');
  if (btn) { btn.textContent = '학습'; btn.disabled = false; }
  
  try { analyser.disconnect(); } catch {}
}

export function resetNoiseProfile() {
  noiseProfile = { baselineLevel: -60, adaptiveThreshold: -45, learningData: [], isLearning: false };
  setNoiseProfile({ baselineLevel: -60, adaptiveThreshold: -45 });
  toast('노이즈 프로파일 리셋', 'info');
}

// Presets
export function applyAudioPreset(preset) {
  if (!preset) return;
  Object.entries(preset).forEach(([key, value]) => {
    inputEffects[key] = value;
    updateInputEffect(key, value);
    
    // Update UI sliders
    const sliderMap = { eqLow: 'eq-low', eqMid: 'eq-mid', eqHigh: 'eq-high', 
                        inputVolume: 'input-volume', compressionRatio: 'compression-ratio' };
    const el = $(sliderMap[key]);
    if (el) {
      el.value = value;
      if (el.nextElementSibling) {
        el.nextElementSibling.textContent = key === 'compressionRatio' ? `${value}:1` : 
                                            key === 'inputVolume' ? `${value}%` : `${value}dB`;
      }
    }
  });
}
