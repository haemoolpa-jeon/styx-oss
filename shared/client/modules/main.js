// Styx - Main Entry Point (ES Modules)
// Imports all modules and initializes the application

import { $, state, log, actuallyTauri } from './modules/core.js';
import { toast, initTheme, toggleTheme, updateMuteUI, updateQualityIndicator } from './modules/ui.js';
import { socket, rtcConfig, updateTurnCredentials, startUdpMode, stopUdpMode, setUdpMuted, getUdpStats } from './modules/network.js';
import { getSharedAudioContext, createProcessedInputStream, updateInputEffect, initSpectrum, toggleSpectrum, startAudioMeter, stopAudioMeter, applyAudioPreset, startNoiseLearning, resetNoiseProfile } from './modules/audio.js';
import { startRecording, stopRecording, toggleRecording, cleanupRecording, addRecordingMarker, exportClickTrack } from './modules/recording.js';
import { getSetting, setSetting, loadAllSettings, collectSettings, applySettings, getPresets, saveCustomPreset, deleteCustomPreset } from './modules/settings.js';

// Re-export for global access (backward compatibility)
window.toast = toast;
window.socket = socket;
window.state = state;

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initSpectrum();
  loadAllSettings();
  initEventHandlers();
  
  log('Styx initialized (ES Modules)');
  log('Tauri mode:', actuallyTauri);
});

// Event handlers setup
function initEventHandlers() {
  // Theme toggle
  $('themeBtn')?.addEventListener('click', toggleTheme);
  
  // Recording
  $('recordBtn')?.addEventListener('click', toggleRecording);
  
  // Spectrum toggle
  $('spectrum-toggle')?.addEventListener('click', toggleSpectrum);
  
  // Noise profiling
  $('learn-noise')?.addEventListener('click', startNoiseLearning);
  $('reset-profile')?.addEventListener('click', resetNoiseProfile);
  
  // EQ sliders
  ['eq-low', 'eq-mid', 'eq-high'].forEach(id => {
    const el = $(id);
    if (!el) return;
    const effectMap = { 'eq-low': 'eqLow', 'eq-mid': 'eqMid', 'eq-high': 'eqHigh' };
    el.oninput = () => {
      const val = parseInt(el.value);
      el.nextElementSibling.textContent = `${val}dB`;
      updateInputEffect(effectMap[id], val);
    };
  });
  
  // Compression ratio
  const compressionEl = $('compression-ratio');
  if (compressionEl) {
    compressionEl.oninput = () => {
      const val = parseFloat(compressionEl.value);
      compressionEl.nextElementSibling.textContent = `${val}:1`;
      updateInputEffect('compressionRatio', val);
    };
  }
  
  // Input volume
  const inputVolumeEl = $('input-volume');
  if (inputVolumeEl) {
    inputVolumeEl.oninput = () => {
      const val = parseInt(inputVolumeEl.value);
      inputVolumeEl.nextElementSibling.textContent = `${val}%`;
      updateInputEffect('inputVolume', val);
    };
  }
  
  // Audio preset selector
  const presetSelect = $('audio-preset');
  if (presetSelect) {
    presetSelect.onchange = () => {
      const presets = getPresets();
      const preset = presets[presetSelect.value];
      if (preset) applyAudioPreset(preset);
    };
  }
  
  // Save custom preset
  $('save-preset')?.addEventListener('click', () => {
    const name = prompt('프리셋 이름:');
    if (name) {
      const effects = { 
        eqLow: parseInt($('eq-low')?.value || 0),
        eqMid: parseInt($('eq-mid')?.value || 0),
        eqHigh: parseInt($('eq-high')?.value || 0),
        inputVolume: parseInt($('input-volume')?.value || 120),
        compressionRatio: parseFloat($('compression-ratio')?.value || 4)
      };
      saveCustomPreset(name, effects);
      updatePresetSelect();
      toast(`프리셋 "${name}" 저장됨`, 'success');
    }
  });
  
  // Click track export
  $('export-click')?.addEventListener('click', () => {
    const bpm = parseInt($('bpm-input')?.value || 120);
    exportClickTrack(bpm, 4);
  });
  
  // Modal backdrop close
  document.querySelectorAll('.modal-backdrop').forEach(el => {
    el.onclick = (e) => {
      const modal = e.target.closest('.modal');
      if (modal) modal.classList.add('hidden');
    };
  });
  
  // Resume audio on user interaction
  document.addEventListener('click', () => {
    const ctx = getSharedAudioContext();
    if (ctx.state === 'suspended') ctx.resume();
  }, { once: false });
}

function updatePresetSelect() {
  const select = $('audio-preset');
  if (!select) return;
  
  const presets = getPresets();
  select.innerHTML = '<option value="">프리셋 선택...</option>';
  
  Object.keys(presets).forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  });
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  cleanupRecording();
  stopAudioMeter();
  stopUdpMode();
});

// Export for non-module scripts that may need access
export { 
  state, socket, toast, 
  startRecording, stopRecording, toggleRecording,
  getSharedAudioContext, createProcessedInputStream,
  startUdpMode, stopUdpMode, setUdpMuted, getUdpStats
};
