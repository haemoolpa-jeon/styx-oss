// Styx - Settings Module
// All localStorage operations and settings sync

import { $, state, log } from './core.js';

// Settings keys
const KEYS = {
  theme: 'styx-theme',
  audioMode: 'styx-audio-mode',
  jitterBuffer: 'styx-jitter-buffer',
  autoJitter: 'styx-auto-jitter',
  lowLatency: 'styx-low-latency',
  proMode: 'styx-pro-mode',
  echo: 'styx-echo',
  noise: 'styx-noise',
  aiNoise: 'styx-ai-noise',
  ptt: 'styx-ptt',
  pttKey: 'styx-ptt-key',
  ducking: 'styx-ducking',
  vad: 'styx-vad',
  autoAdapt: 'styx-auto-adapt',
  multitrack: 'styx-multitrack',
  loopback: 'styx-loopback',
  effects: 'styx-effects',
  noiseProfile: 'styx-noise-profile',
  customPresets: 'styx-custom-presets',
  roomTemplates: 'styx-room-templates',
  accessibility: 'styx-accessibility',
  qualityLevel: 'styx-quality-level',
};

// Default values
const DEFAULTS = {
  audioMode: 'balanced',
  jitterBuffer: 5,
  autoJitter: true,
  lowLatency: false,
  proMode: false,
  echo: true,
  noise: true,
  aiNoise: false,
  ptt: false,
  pttKey: 'Space',
  ducking: false,
  vad: true,
  autoAdapt: true,
  multitrack: false,
  loopback: false,
  qualityLevel: 'auto',
  effects: { eqLow: 0, eqMid: 0, eqHigh: 0, inputVolume: 120, compressionRatio: 4 },
};

// Load a setting
export function getSetting(key, defaultValue = null) {
  try {
    const val = localStorage.getItem(KEYS[key] || key);
    if (val === null) return defaultValue ?? DEFAULTS[key];
    if (val === 'true') return true;
    if (val === 'false') return false;
    const num = Number(val);
    if (!isNaN(num) && val.trim() !== '') return num;
    try { return JSON.parse(val); } catch { return val; }
  } catch (e) {
    log('Settings load error:', key, e);
    return defaultValue ?? DEFAULTS[key];
  }
}

// Save a setting
export function setSetting(key, value) {
  try {
    const storageKey = KEYS[key] || key;
    if (typeof value === 'object') {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } else {
      localStorage.setItem(storageKey, String(value));
    }
  } catch (e) {
    log('Settings save error:', key, e);
  }
}

// Remove a setting
export function removeSetting(key) {
  localStorage.removeItem(KEYS[key] || key);
}

// Load all settings into state
export function loadAllSettings() {
  state.proMode = getSetting('proMode');
  state.lowLatencyMode = getSetting('lowLatency');
  state.autoJitter = getSetting('autoJitter');
  state.vadEnabled = getSetting('vad');
  state.duckingEnabled = getSetting('ducking');
  state.multitrackMode = getSetting('multitrack');
  state.loopbackMode = getSetting('loopback');
}

// Collect settings for sync
export function collectSettings() {
  return {
    audioMode: getSetting('audioMode'),
    jitterBuffer: getSetting('jitterBuffer'),
    autoAdapt: getSetting('autoAdapt'),
    echoCancellation: getSetting('echo'),
    noiseSuppression: getSetting('noise'),
    aiNoiseCancellation: getSetting('aiNoise'),
    pttMode: getSetting('ptt'),
    pttKey: getSetting('pttKey'),
    duckingEnabled: getSetting('ducking'),
    vadEnabled: getSetting('vad'),
    theme: getSetting('theme') || 'dark',
  };
}

// Apply settings from sync
export function applySettings(s) {
  if (!s) return;
  if (s.audioMode) setSetting('audioMode', s.audioMode);
  if (s.jitterBuffer !== undefined) setSetting('jitterBuffer', s.jitterBuffer);
  if (s.autoAdapt !== undefined) setSetting('autoAdapt', s.autoAdapt);
  if (s.echoCancellation !== undefined) setSetting('echo', s.echoCancellation);
  if (s.noiseSuppression !== undefined) setSetting('noise', s.noiseSuppression);
  if (s.aiNoiseCancellation !== undefined) setSetting('aiNoise', s.aiNoiseCancellation);
  if (s.pttMode !== undefined) setSetting('ptt', s.pttMode);
  if (s.pttKey) setSetting('pttKey', s.pttKey);
  if (s.duckingEnabled !== undefined) setSetting('ducking', s.duckingEnabled);
  if (s.vadEnabled !== undefined) setSetting('vad', s.vadEnabled);
  if (s.theme) {
    setSetting('theme', s.theme);
    document.documentElement.setAttribute('data-theme', s.theme);
  }
  loadAllSettings();
}

// Audio presets
const builtInPresets = {
  voice: { eqLow: -3, eqMid: 2, eqHigh: 1, inputVolume: 130, compressionRatio: 6 },
  instrument: { eqLow: 0, eqMid: 0, eqHigh: 0, inputVolume: 100, compressionRatio: 2 },
  podcast: { eqLow: -2, eqMid: 3, eqHigh: 2, inputVolume: 140, compressionRatio: 5 },
};

export function getPresets() {
  const custom = getSetting('customPresets') || {};
  return { ...builtInPresets, ...custom };
}

export function saveCustomPreset(name, settings) {
  const custom = getSetting('customPresets') || {};
  custom[name] = settings;
  setSetting('customPresets', custom);
}

export function deleteCustomPreset(name) {
  const custom = getSetting('customPresets') || {};
  delete custom[name];
  setSetting('customPresets', custom);
}

// Room templates
export function getRoomTemplates() {
  return getSetting('roomTemplates') || {};
}

export function saveRoomTemplate(name, template) {
  const templates = getRoomTemplates();
  templates[name] = template;
  setSetting('roomTemplates', templates);
}

export function deleteRoomTemplate(name) {
  const templates = getRoomTemplates();
  delete templates[name];
  setSetting('roomTemplates', templates);
}

// Effects settings
export function getEffects() {
  return getSetting('effects') || DEFAULTS.effects;
}

export function setEffects(effects) {
  setSetting('effects', effects);
}

// Noise profile
export function getNoiseProfile() {
  return getSetting('noiseProfile') || { baselineLevel: -60, adaptiveThreshold: -45 };
}

export function setNoiseProfile(profile) {
  setSetting('noiseProfile', profile);
}
