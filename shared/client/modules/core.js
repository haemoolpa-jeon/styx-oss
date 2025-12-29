// Styx - Shared State & Utilities
// Core state that all modules need access to

export const DEBUG = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
export const log = (...args) => DEBUG && console.log(...args);
export const $ = id => document.getElementById(id);

export const serverUrl = window.STYX_SERVER_URL || '';

// Tauri detection
export const isTauriApp = () => {
  if (navigator.userAgent.includes('Tauri')) return true;
  if (typeof window.__TAURI__ !== 'undefined') return true;
  if (typeof window.__TAURI_INTERNALS__ !== 'undefined') return true;
  if (location.protocol === 'tauri:') return true;
  return false;
};

export const actuallyTauri = isTauriApp();
export const tauriInvoke = actuallyTauri ? (window.__TAURI__?.core?.invoke || null) : null;

// Shared state object - modules import and modify this
export const state = {
  // User & Room
  currentUser: null,
  myRole: 'performer',
  currentRoomSettings: {},
  isRoomCreator: false,
  roomCreatorUsername: '',
  
  // Audio
  localStream: null,
  processedStream: null,
  isMuted: false,
  selectedDeviceId: null,
  selectedOutputId: null,
  
  // Peers
  peers: new Map(),
  volumeStates: new Map(),
  
  // Recording
  isRecording: false,
  mediaRecorder: null,
  recordedChunks: [],
  multitrackMode: localStorage.getItem('styx-multitrack') === 'true',
  loopbackMode: localStorage.getItem('styx-loopback') === 'true',
  
  // Settings
  proMode: localStorage.getItem('styx-pro-mode') === 'true',
  lowLatencyMode: localStorage.getItem('styx-low-latency') === 'true',
  autoJitter: localStorage.getItem('styx-auto-jitter') !== 'false',
  vadEnabled: localStorage.getItem('styx-vad') !== 'false',
  duckingEnabled: localStorage.getItem('styx-ducking') === 'true',
};

// Avatar URL helper
export const avatarUrl = (path) => path ? (path.startsWith('/') ? serverUrl + path : path) : '';
