(function() {
  "use strict";
  var _a, _b;
  const DEBUG = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  const log = (...args) => DEBUG && console.log(...args);
  const $ = (id) => document.getElementById(id);
  const serverUrl = window.STYX_SERVER_URL || "";
  const isTauriApp = () => {
    if (navigator.userAgent.includes("Tauri")) return true;
    if (typeof window.__TAURI__ !== "undefined") return true;
    if (typeof window.__TAURI_INTERNALS__ !== "undefined") return true;
    if (location.protocol === "tauri:") return true;
    return false;
  };
  const actuallyTauri = isTauriApp();
  const tauriInvoke = actuallyTauri ? ((_b = (_a = window.__TAURI__) == null ? void 0 : _a.core) == null ? void 0 : _b.invoke) || null : null;
  const state = {
    // User & Room
    currentUser: null,
    myRole: "performer",
    currentRoomSettings: {},
    isRoomCreator: false,
    roomCreatorUsername: "",
    // Audio
    localStream: null,
    processedStream: null,
    isMuted: false,
    selectedDeviceId: null,
    selectedOutputId: null,
    // Peers
    peers: /* @__PURE__ */ new Map(),
    volumeStates: /* @__PURE__ */ new Map(),
    // Recording
    isRecording: false,
    mediaRecorder: null,
    recordedChunks: [],
    multitrackMode: localStorage.getItem("styx-multitrack") === "true",
    loopbackMode: localStorage.getItem("styx-loopback") === "true",
    // Settings
    proMode: localStorage.getItem("styx-pro-mode") === "true",
    lowLatencyMode: localStorage.getItem("styx-low-latency") === "true",
    autoJitter: localStorage.getItem("styx-auto-jitter") !== "false",
    vadEnabled: localStorage.getItem("styx-vad") !== "false",
    duckingEnabled: localStorage.getItem("styx-ducking") === "true"
  };
  const avatarUrl = (path) => path ? path.startsWith("/") ? serverUrl + path : path : "";
  const core = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
    __proto__: null,
    $,
    DEBUG,
    actuallyTauri,
    avatarUrl,
    isTauriApp,
    log,
    serverUrl,
    state,
    tauriInvoke
  }, Symbol.toStringTag, { value: "Module" }));
  function toast(message, type = "info", duration = 3e3) {
    const container = $("toast-container");
    if (!container) return;
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.classList.add("hide");
      setTimeout(() => el.remove(), 300);
    }, duration);
  }
  function initTheme() {
    const saved = localStorage.getItem("styx-theme") || "dark";
    document.body.dataset.theme = saved;
    updateThemeIcon();
  }
  function toggleTheme() {
    const current = document.body.dataset.theme;
    const next = current === "dark" ? "light" : "dark";
    document.body.dataset.theme = next;
    localStorage.setItem("styx-theme", next);
    updateThemeIcon();
  }
  function updateThemeIcon() {
    const btn = $("themeBtn");
    if (btn) btn.textContent = document.body.dataset.theme === "dark" ? "☀️" : "🌙";
  }
  function showModal(id) {
    const modal = $(id);
    if (modal) modal.classList.remove("hidden");
  }
  function hideModal(id) {
    const modal = $(id);
    if (modal) modal.classList.add("hidden");
  }
  let reconnectAttempt = 0;
  function showReconnectProgress(attempt = 1) {
    reconnectAttempt = attempt;
    const overlay = $("reconnect-overlay");
    if (!overlay) return;
    overlay.classList.remove("hidden");
    const countEl = $("reconnect-count");
    if (countEl) countEl.textContent = attempt;
    const progress = attempt / 10 * 100;
    const progressBar = overlay.querySelector(".progress-bar");
    if (progressBar) progressBar.style.width = progress + "%";
  }
  function updateReconnectProgress() {
    const overlay = $("reconnect-overlay");
    if (!overlay || overlay.classList.contains("hidden")) return;
    const progress = reconnectAttempt / 10 * 100;
    const progressBar = overlay.querySelector(".progress-bar");
    if (progressBar) progressBar.style.width = progress + "%";
  }
  function hideReconnectProgress() {
    const overlay = $("reconnect-overlay");
    if (overlay) overlay.classList.add("hidden");
    reconnectAttempt = 0;
  }
  function updateMuteUI() {
    const btn = $("muteBtn");
    if (btn) {
      btn.textContent = state.isMuted ? "🔇" : "🎤";
      btn.classList.toggle("muted", state.isMuted);
    }
  }
  function updateQualityIndicator(jitter = 0, packetLoss = 0, e2eLatency = null) {
    const indicator = $("quality-indicator");
    if (!indicator) return;
    let quality = "good";
    if (jitter > 30 || packetLoss > 5) quality = "fair";
    if (jitter > 50 || packetLoss > 10) quality = "poor";
    indicator.className = `quality-indicator ${quality}`;
    let title = `Jitter: ${jitter.toFixed(1)}ms
Packet Loss: ${packetLoss.toFixed(1)}%`;
    if (e2eLatency !== null) title += `
E2E Latency: ${e2eLatency}ms`;
    indicator.title = title;
    const latencyText = indicator.querySelector(".latency-text");
    if (latencyText && e2eLatency !== null) {
      latencyText.textContent = `${e2eLatency}ms`;
    }
  }
  const ui = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
    __proto__: null,
    hideModal,
    hideReconnectProgress,
    initTheme,
    showModal,
    showReconnectProgress,
    toast,
    toggleTheme,
    updateMuteUI,
    updateQualityIndicator,
    updateReconnectProgress
  }, Symbol.toStringTag, { value: "Module" }));
  const KEYS = {
    theme: "styx-theme",
    audioMode: "styx-audio-mode",
    jitterBuffer: "styx-jitter-buffer",
    autoJitter: "styx-auto-jitter",
    lowLatency: "styx-low-latency",
    proMode: "styx-pro-mode",
    echo: "styx-echo",
    noise: "styx-noise",
    aiNoise: "styx-ai-noise",
    ptt: "styx-ptt",
    pttKey: "styx-ptt-key",
    ducking: "styx-ducking",
    vad: "styx-vad",
    autoAdapt: "styx-auto-adapt",
    multitrack: "styx-multitrack",
    loopback: "styx-loopback",
    effects: "styx-effects",
    noiseProfile: "styx-noise-profile",
    customPresets: "styx-custom-presets",
    roomTemplates: "styx-room-templates",
    accessibility: "styx-accessibility",
    qualityLevel: "styx-quality-level"
  };
  const DEFAULTS = {
    audioMode: "balanced",
    jitterBuffer: 5,
    autoJitter: true,
    lowLatency: false,
    proMode: false,
    echo: true,
    noise: true,
    aiNoise: false,
    ptt: false,
    pttKey: "Space",
    ducking: false,
    vad: true,
    autoAdapt: true,
    multitrack: false,
    loopback: false,
    qualityLevel: "auto",
    effects: { eqLow: 0, eqMid: 0, eqHigh: 0, inputVolume: 120, compressionRatio: 4 }
  };
  function getSetting(key, defaultValue = null) {
    try {
      const val = localStorage.getItem(KEYS[key] || key);
      if (val === null) return defaultValue ?? DEFAULTS[key];
      if (val === "true") return true;
      if (val === "false") return false;
      const num = Number(val);
      if (!isNaN(num) && val.trim() !== "") return num;
      try {
        return JSON.parse(val);
      } catch {
        return val;
      }
    } catch (e) {
      log("Settings load error:", key, e);
      return defaultValue ?? DEFAULTS[key];
    }
  }
  function setSetting(key, value) {
    try {
      const storageKey = KEYS[key] || key;
      if (typeof value === "object") {
        localStorage.setItem(storageKey, JSON.stringify(value));
      } else {
        localStorage.setItem(storageKey, String(value));
      }
    } catch (e) {
      log("Settings save error:", key, e);
    }
  }
  function removeSetting(key) {
    localStorage.removeItem(KEYS[key] || key);
  }
  function loadAllSettings() {
    state.proMode = getSetting("proMode");
    state.lowLatencyMode = getSetting("lowLatency");
    state.autoJitter = getSetting("autoJitter");
    state.vadEnabled = getSetting("vad");
    state.duckingEnabled = getSetting("ducking");
    state.multitrackMode = getSetting("multitrack");
    state.loopbackMode = getSetting("loopback");
  }
  function collectSettings() {
    return {
      audioMode: getSetting("audioMode"),
      jitterBuffer: getSetting("jitterBuffer"),
      autoAdapt: getSetting("autoAdapt"),
      echoCancellation: getSetting("echo"),
      noiseSuppression: getSetting("noise"),
      aiNoiseCancellation: getSetting("aiNoise"),
      pttMode: getSetting("ptt"),
      pttKey: getSetting("pttKey"),
      duckingEnabled: getSetting("ducking"),
      vadEnabled: getSetting("vad"),
      theme: getSetting("theme") || "dark"
    };
  }
  function applySettings(s) {
    if (!s) return;
    if (s.audioMode) setSetting("audioMode", s.audioMode);
    if (s.jitterBuffer !== void 0) setSetting("jitterBuffer", s.jitterBuffer);
    if (s.autoAdapt !== void 0) setSetting("autoAdapt", s.autoAdapt);
    if (s.echoCancellation !== void 0) setSetting("echo", s.echoCancellation);
    if (s.noiseSuppression !== void 0) setSetting("noise", s.noiseSuppression);
    if (s.aiNoiseCancellation !== void 0) setSetting("aiNoise", s.aiNoiseCancellation);
    if (s.pttMode !== void 0) setSetting("ptt", s.pttMode);
    if (s.pttKey) setSetting("pttKey", s.pttKey);
    if (s.duckingEnabled !== void 0) setSetting("ducking", s.duckingEnabled);
    if (s.vadEnabled !== void 0) setSetting("vad", s.vadEnabled);
    if (s.theme) {
      setSetting("theme", s.theme);
      document.documentElement.setAttribute("data-theme", s.theme);
    }
    loadAllSettings();
  }
  const builtInPresets = {
    voice: { eqLow: -3, eqMid: 2, eqHigh: 1, inputVolume: 130, compressionRatio: 6 },
    instrument: { eqLow: 0, eqMid: 0, eqHigh: 0, inputVolume: 100, compressionRatio: 2 },
    podcast: { eqLow: -2, eqMid: 3, eqHigh: 2, inputVolume: 140, compressionRatio: 5 }
  };
  function getPresets() {
    const custom = getSetting("customPresets") || {};
    return { ...builtInPresets, ...custom };
  }
  function saveCustomPreset(name, settings2) {
    const custom = getSetting("customPresets") || {};
    custom[name] = settings2;
    setSetting("customPresets", custom);
  }
  function deleteCustomPreset(name) {
    const custom = getSetting("customPresets") || {};
    delete custom[name];
    setSetting("customPresets", custom);
  }
  function getRoomTemplates() {
    return getSetting("roomTemplates") || {};
  }
  function saveRoomTemplate(name, template) {
    const templates = getRoomTemplates();
    templates[name] = template;
    setSetting("roomTemplates", templates);
  }
  function deleteRoomTemplate(name) {
    const templates = getRoomTemplates();
    delete templates[name];
    setSetting("roomTemplates", templates);
  }
  function getEffects() {
    return getSetting("effects") || DEFAULTS.effects;
  }
  function setEffects(effects) {
    setSetting("effects", effects);
  }
  function getNoiseProfile() {
    return getSetting("noiseProfile") || { baselineLevel: -60, adaptiveThreshold: -45 };
  }
  function setNoiseProfile(profile) {
    setSetting("noiseProfile", profile);
  }
  const settings = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
    __proto__: null,
    applySettings,
    collectSettings,
    deleteCustomPreset,
    deleteRoomTemplate,
    getEffects,
    getNoiseProfile,
    getPresets,
    getRoomTemplates,
    getSetting,
    loadAllSettings,
    removeSetting,
    saveCustomPreset,
    saveRoomTemplate,
    setEffects,
    setNoiseProfile,
    setSetting
  }, Symbol.toStringTag, { value: "Module" }));
  let sharedAudioContext = null;
  function getSharedAudioContext() {
    if (!sharedAudioContext || sharedAudioContext.state === "closed") {
      sharedAudioContext = new AudioContext({ latencyHint: "interactive", sampleRate: 48e3 });
    }
    if (sharedAudioContext.state === "suspended") {
      sharedAudioContext.resume();
    }
    return sharedAudioContext;
  }
  let effectNodes = {};
  let noiseGateWorklet = null;
  let inputEffects = getEffects();
  async function createProcessedInputStream(rawStream) {
    if (state.proMode) {
      state.processedStream = rawStream;
      effectNodes = {};
      return rawStream;
    }
    const ctx = getSharedAudioContext();
    const source = ctx.createMediaStreamSource(rawStream);
    const eqLow = ctx.createBiquadFilter();
    eqLow.type = "lowshelf";
    eqLow.frequency.value = 320;
    eqLow.gain.value = inputEffects.eqLow;
    const eqMid = ctx.createBiquadFilter();
    eqMid.type = "peaking";
    eqMid.frequency.value = 1e3;
    eqMid.Q.value = 1;
    eqMid.gain.value = inputEffects.eqMid;
    const eqHigh = ctx.createBiquadFilter();
    eqHigh.type = "highshelf";
    eqHigh.frequency.value = 3200;
    eqHigh.gain.value = inputEffects.eqHigh;
    let lastNode = eqHigh;
    const noiseProfile2 = getNoiseProfile();
    try {
      await ctx.audioWorklet.addModule("noise-gate-processor.js");
      noiseGateWorklet = new AudioWorkletNode(ctx, "noise-gate-processor");
      const thresholdParam = noiseGateWorklet.parameters.get("threshold");
      if (thresholdParam) {
        thresholdParam.value = noiseProfile2.adaptiveThreshold > -60 ? noiseProfile2.adaptiveThreshold : -45;
      }
      eqHigh.connect(noiseGateWorklet);
      lastNode = noiseGateWorklet;
    } catch (e) {
      log("Noise gate worklet failed:", e);
    }
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -12;
    compressor.knee.value = 6;
    compressor.ratio.value = inputEffects.compressionRatio || 4;
    compressor.attack.value = 3e-3;
    compressor.release.value = 0.1;
    const makeupGain = ctx.createGain();
    makeupGain.gain.value = inputEffects.inputVolume / 100;
    const dest = ctx.createMediaStreamDestination();
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
  function updateInputEffect(effect, value) {
    inputEffects[effect] = value;
    setEffects(inputEffects);
    if (!effectNodes.eqLow) return;
    switch (effect) {
      case "eqLow":
        effectNodes.eqLow.gain.value = value;
        break;
      case "eqMid":
        effectNodes.eqMid.gain.value = value;
        break;
      case "eqHigh":
        effectNodes.eqHigh.gain.value = value;
        break;
      case "inputVolume":
        if (effectNodes.makeupGain) effectNodes.makeupGain.gain.value = value / 100;
        break;
      case "compressionRatio":
        if (effectNodes.compressor) effectNodes.compressor.ratio.value = value;
        state.peers.forEach((peer) => {
          if (peer.compressor) peer.compressor.ratio.value = value;
        });
        break;
    }
  }
  let spectrumAnalyser = null;
  let spectrumCanvas = null;
  let spectrumCtx = null;
  let spectrumAnimationId = null;
  let spectrumEnabled = false;
  function initSpectrum() {
    spectrumCanvas = $("spectrum-canvas");
    if (spectrumCanvas) spectrumCtx = spectrumCanvas.getContext("2d");
  }
  function toggleSpectrum() {
    spectrumEnabled = !spectrumEnabled;
    const container = $("spectrum-container");
    if (spectrumEnabled) {
      container == null ? void 0 : container.classList.remove("hidden");
      if (state.localStream) startSpectrum();
    } else {
      container == null ? void 0 : container.classList.add("hidden");
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
      try {
        spectrumAnalyser.disconnect();
      } catch {
      }
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
    spectrumCtx.fillStyle = "rgba(0, 0, 0, 0.2)";
    spectrumCtx.fillRect(0, 0, width, height);
    const barWidth = width / bufferLength * 2;
    let x = 0;
    for (let i = 0; i < bufferLength; i++) {
      const barHeight = dataArray[i] / 255 * height;
      const hue = i / bufferLength * 240;
      spectrumCtx.fillStyle = `hsl(${hue}, 70%, 50%)`;
      spectrumCtx.fillRect(x, height - barHeight, barWidth, barHeight);
      x += barWidth + 1;
    }
    spectrumAnimationId = requestAnimationFrame(drawSpectrum);
  }
  let meterInterval = null;
  let analyser = null;
  function startAudioMeter() {
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
      const level = Math.min(100, avg / 128 * 100);
      const meter = $("audio-meter-fill");
      if (meter) meter.style.width = level + "%";
    }, 50);
  }
  function stopAudioMeter() {
    if (meterInterval) {
      clearInterval(meterInterval);
      meterInterval = null;
    }
    if (analyser) {
      try {
        analyser.disconnect();
      } catch {
      }
      analyser = null;
    }
  }
  let noiseProfile = getNoiseProfile();
  function startNoiseLearning() {
    if (!state.localStream) return;
    noiseProfile.isLearning = true;
    noiseProfile.learningData = [];
    const btn = $("learn-noise");
    if (btn) {
      btn.textContent = "학습중...";
      btn.disabled = true;
    }
    const ctx = getSharedAudioContext();
    const analyser2 = ctx.createAnalyser();
    analyser2.fftSize = 256;
    analyser2.smoothingTimeConstant = 0.3;
    const source = ctx.createMediaStreamSource(state.localStream);
    source.connect(analyser2);
    const dataArray = new Uint8Array(analyser2.frequencyBinCount);
    let sampleCount = 0;
    const collectSample = () => {
      if (!noiseProfile.isLearning) return;
      analyser2.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i] * dataArray[i];
      const rms = Math.sqrt(sum / dataArray.length);
      const dbLevel = 20 * Math.log10(rms / 255);
      noiseProfile.learningData.push(dbLevel);
      sampleCount++;
      if (sampleCount < 30) {
        setTimeout(collectSample, 100);
      } else {
        finishNoiseLearning(analyser2);
      }
    };
    collectSample();
  }
  function finishNoiseLearning(analyser2) {
    noiseProfile.isLearning = false;
    if (noiseProfile.learningData.length > 0) {
      const sorted = noiseProfile.learningData.sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const q75 = sorted[Math.floor(sorted.length * 0.75)];
      noiseProfile.baselineLevel = median;
      noiseProfile.adaptiveThreshold = Math.max(median + 10, q75 + 5);
      setNoiseProfile({ baselineLevel: noiseProfile.baselineLevel, adaptiveThreshold: noiseProfile.adaptiveThreshold });
      toast(`노이즈 프로파일 학습 완료 (${Math.round(noiseProfile.baselineLevel)}dB)`, "success");
    }
    const btn = $("learn-noise");
    if (btn) {
      btn.textContent = "학습";
      btn.disabled = false;
    }
    try {
      analyser2.disconnect();
    } catch {
    }
  }
  function resetNoiseProfile() {
    noiseProfile = { baselineLevel: -60, adaptiveThreshold: -45, learningData: [], isLearning: false };
    setNoiseProfile({ baselineLevel: -60, adaptiveThreshold: -45 });
    toast("노이즈 프로파일 리셋", "info");
  }
  function applyAudioPreset(preset) {
    if (!preset) return;
    Object.entries(preset).forEach(([key, value]) => {
      inputEffects[key] = value;
      updateInputEffect(key, value);
      const sliderMap = {
        eqLow: "eq-low",
        eqMid: "eq-mid",
        eqHigh: "eq-high",
        inputVolume: "input-volume",
        compressionRatio: "compression-ratio"
      };
      const el = $(sliderMap[key]);
      if (el) {
        el.value = value;
        if (el.nextElementSibling) {
          el.nextElementSibling.textContent = key === "compressionRatio" ? `${value}:1` : key === "inputVolume" ? `${value}%` : `${value}dB`;
        }
      }
    });
  }
  const audio = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
    __proto__: null,
    applyAudioPreset,
    createProcessedInputStream,
    getSharedAudioContext,
    initSpectrum,
    resetNoiseProfile,
    startAudioMeter,
    startNoiseLearning,
    stopAudioMeter,
    toggleSpectrum,
    updateInputEffect
  }, Symbol.toStringTag, { value: "Module" }));
  let recordingAudioCtx = null;
  let multitrackRecorders = /* @__PURE__ */ new Map();
  let recordingMarkers = [];
  let recordingStartTime = 0;
  function formatTime(ms) {
    const s = Math.floor(ms / 1e3);
    const m = Math.floor(s / 60);
    return `${m}:${(s % 60).toString().padStart(2, "0")}`;
  }
  function downloadTrack(chunks, name) {
    const blob = new Blob(chunks, { type: "audio/webm" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `styx-${name}.webm`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function exportMarkers(filename) {
    if (recordingMarkers.length === 0) return;
    const content = recordingMarkers.map((m) => `${formatTime(m.time)}	${m.label}`).join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${filename}_markers.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function addRecordingMarker(label = "") {
    if (!state.isRecording) return;
    const elapsed = Date.now() - recordingStartTime;
    const marker = { time: elapsed, label: label || `Marker ${recordingMarkers.length + 1}` };
    recordingMarkers.push(marker);
    toast(`마커 추가: ${formatTime(elapsed)}`, "info", 1500);
  }
  function startRecording() {
    if (state.isRecording) return;
    const timestamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 19).replace(/:/g, "-");
    recordingMarkers = [];
    recordingStartTime = Date.now();
    if (state.multitrackMode) {
      multitrackRecorders.clear();
      if (state.localStream) {
        const rec = new MediaRecorder(state.localStream, { mimeType: "audio/webm" });
        const chunks = [];
        rec.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data);
        };
        rec.onstop = () => downloadTrack(chunks, `${timestamp}_${state.currentUser.username}_local`);
        rec.start();
        multitrackRecorders.set("local", { recorder: rec, chunks, username: state.currentUser.username });
      }
      state.peers.forEach((peer, id) => {
        var _a2;
        if ((_a2 = peer.audioEl) == null ? void 0 : _a2.srcObject) {
          const rec = new MediaRecorder(peer.audioEl.srcObject, { mimeType: "audio/webm" });
          const chunks = [];
          rec.ondataavailable = (e) => {
            if (e.data.size > 0) chunks.push(e.data);
          };
          rec.onstop = () => downloadTrack(chunks, `${timestamp}_${peer.username}`);
          rec.start();
          multitrackRecorders.set(id, { recorder: rec, chunks, username: peer.username });
        }
      });
      toast(`멀티트랙 녹음 시작 (${multitrackRecorders.size}개 트랙)`, "info");
    } else if (state.loopbackMode) {
      recordingAudioCtx = new AudioContext();
      const dest = recordingAudioCtx.createMediaStreamDestination();
      state.peers.forEach((peer) => {
        var _a2;
        if ((_a2 = peer.audioEl) == null ? void 0 : _a2.srcObject) {
          recordingAudioCtx.createMediaStreamSource(peer.audioEl.srcObject).connect(dest);
        }
      });
      state.recordedChunks = [];
      state.mediaRecorder = new MediaRecorder(dest.stream, { mimeType: "audio/webm" });
      state.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) state.recordedChunks.push(e.data);
      };
      state.mediaRecorder.onstop = () => {
        if (recordingAudioCtx) {
          recordingAudioCtx.close().catch(() => {
          });
          recordingAudioCtx = null;
        }
        downloadTrack(state.recordedChunks, `${timestamp}_loopback`);
      };
      state.mediaRecorder.start();
      toast("루프백 녹음 시작", "info");
    } else {
      recordingAudioCtx = new AudioContext();
      const dest = recordingAudioCtx.createMediaStreamDestination();
      if (state.localStream) {
        recordingAudioCtx.createMediaStreamSource(state.localStream).connect(dest);
      }
      state.peers.forEach((peer) => {
        var _a2;
        if ((_a2 = peer.audioEl) == null ? void 0 : _a2.srcObject) {
          recordingAudioCtx.createMediaStreamSource(peer.audioEl.srcObject).connect(dest);
        }
      });
      state.recordedChunks = [];
      state.mediaRecorder = new MediaRecorder(dest.stream, { mimeType: "audio/webm" });
      state.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) state.recordedChunks.push(e.data);
      };
      state.mediaRecorder.onstop = () => {
        if (recordingAudioCtx) {
          recordingAudioCtx.close().catch(() => {
          });
          recordingAudioCtx = null;
        }
        downloadTrack(state.recordedChunks, `${timestamp}_mix`);
      };
      state.mediaRecorder.start();
      toast("녹음 시작", "info");
    }
    state.isRecording = true;
    updateRecordingUI(true);
  }
  function stopRecording() {
    if (!state.isRecording) return;
    const timestamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 19).replace(/:/g, "-");
    if (state.multitrackMode && multitrackRecorders.size > 0) {
      multitrackRecorders.forEach(({ recorder }) => recorder.stop());
      multitrackRecorders.clear();
      toast("멀티트랙 녹음 완료", "success");
    } else if (state.mediaRecorder) {
      state.mediaRecorder.stop();
      toast("녹음 완료", "success");
    }
    if (recordingMarkers.length > 0) {
      exportMarkers(`styx-${timestamp}`);
    }
    state.isRecording = false;
    updateRecordingUI(false);
  }
  function toggleRecording() {
    state.isRecording ? stopRecording() : startRecording();
  }
  function cleanupRecording() {
    if (state.isRecording) {
      if (state.multitrackMode) {
        multitrackRecorders.forEach(({ recorder }) => {
          try {
            recorder.stop();
          } catch {
          }
        });
        multitrackRecorders.clear();
      } else if (state.mediaRecorder) {
        state.mediaRecorder.stop();
      }
    }
    if (recordingAudioCtx) {
      recordingAudioCtx.close().catch(() => {
      });
      recordingAudioCtx = null;
    }
    state.isRecording = false;
  }
  function updateRecordingUI(recording2) {
    const btn = $("recordBtn");
    if (btn) {
      btn.textContent = recording2 ? "⏹️ 녹음 중" : "⏺️ 녹음";
      btn.classList.toggle("recording", recording2);
    }
  }
  function exportClickTrack(bpm, bars = 4) {
    const sampleRate = 48e3;
    const beatDuration = 60 / bpm;
    const totalBeats = bars * 4;
    const totalSamples = Math.ceil(totalBeats * beatDuration * sampleRate);
    const ctx = new OfflineAudioContext(1, totalSamples, sampleRate);
    for (let i = 0; i < totalBeats; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = i % 4 === 0 ? 1e3 : 800;
      gain.gain.value = 0.5;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const startTime = i * beatDuration;
      osc.start(startTime);
      osc.stop(startTime + 0.05);
    }
    ctx.startRendering().then((buffer) => {
      const wav = audioBufferToWav(buffer);
      const blob = new Blob([wav], { type: "audio/wav" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `click-${bpm}bpm-${bars}bars.wav`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast("클릭 트랙 내보내기 완료", "success");
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
    const writeString = (offset2, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset2 + i, str.charCodeAt(i));
    };
    writeString(0, "RIFF");
    view.setUint32(4, bufferLength - 8, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeString(36, "data");
    view.setUint32(40, dataLength, true);
    const channelData = buffer.getChannelData(0);
    let offset = 44;
    for (let i = 0; i < buffer.length; i++) {
      const sample = Math.max(-1, Math.min(1, channelData[i]));
      view.setInt16(offset, sample < 0 ? sample * 32768 : sample * 32767, true);
      offset += 2;
    }
    return arrayBuffer;
  }
  const recording = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
    __proto__: null,
    addRecordingMarker,
    cleanupRecording,
    exportClickTrack,
    startRecording,
    stopRecording,
    toggleRecording
  }, Symbol.toStringTag, { value: "Module" }));
  const socket = io(serverUrl, {
    reconnection: true,
    reconnectionDelay: 1e3,
    reconnectionAttempts: 10
  });
  socket.io.on("reconnect_attempt", (attempt) => showReconnectProgress(attempt));
  socket.io.on("reconnect_error", () => updateReconnectProgress());
  socket.io.on("reconnect_failed", () => {
    hideReconnectProgress();
    toast("서버 연결 실패 - 페이지를 새로고침해주세요", "error", 1e4);
  });
  socket.on("connect", () => {
    log("Socket connected");
    hideReconnectProgress();
  });
  socket.on("disconnect", (reason) => {
    log("Socket disconnected:", reason);
    if (reason === "io server disconnect") {
      socket.connect();
    }
  });
  let rtcConfig = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" }
    ],
    iceCandidatePoolSize: 10,
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require"
  };
  function updateTurnCredentials(credentials) {
    if (!credentials) return;
    rtcConfig.iceServers = [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      {
        urls: credentials.urls,
        username: credentials.username,
        credential: credentials.credential
      }
    ];
    log("TURN credentials updated");
  }
  async function detectNatType() {
    if (!actuallyTauri || !tauriInvoke) return { nat_type: "Unknown", public_addr: "" };
    try {
      return await tauriInvoke("detect_nat");
    } catch (e) {
      log("NAT detection failed:", e);
      return { nat_type: "Unknown", public_addr: "" };
    }
  }
  async function attemptP2P(peerAddr) {
    if (!actuallyTauri || !tauriInvoke) return false;
    try {
      return await tauriInvoke("attempt_p2p", { peerAddr });
    } catch (e) {
      log("P2P attempt failed:", e);
      return false;
    }
  }
  let udpPort = null;
  async function startUdpMode(relayHost, relayPort, sessionId) {
    if (!actuallyTauri || !tauriInvoke) {
      toast("UDP 모드는 데스크톱 앱에서만 사용 가능합니다", "warning");
      return false;
    }
    try {
      udpPort = await tauriInvoke("udp_bind", { port: 0 });
      log("UDP bound to port:", udpPort);
      await tauriInvoke("udp_set_relay", { host: relayHost, port: relayPort, sessionId });
      await tauriInvoke("udp_start_relay_stream");
      toast("UDP 오디오 스트림 시작", "success");
      return true;
    } catch (e) {
      log("UDP start failed:", e);
      toast("UDP 시작 실패: " + e, "error");
      return false;
    }
  }
  async function stopUdpMode() {
    if (!actuallyTauri || !tauriInvoke) return;
    try {
      await tauriInvoke("udp_stop_stream");
      udpPort = null;
    } catch (e) {
      log("UDP stop error:", e);
    }
  }
  async function setUdpMuted(muted) {
    if (!actuallyTauri || !tauriInvoke) return;
    try {
      await tauriInvoke("udp_set_muted", { muted });
    } catch (e) {
      log("UDP mute error:", e);
    }
  }
  async function getUdpStats() {
    if (!actuallyTauri || !tauriInvoke) return null;
    try {
      return await tauriInvoke("get_udp_stats");
    } catch (e) {
      return null;
    }
  }
  async function measureRelayLatency() {
    if (!actuallyTauri || !tauriInvoke) return null;
    try {
      return await tauriInvoke("measure_relay_latency");
    } catch (e) {
      return null;
    }
  }
  async function setBitrate(kbps) {
    if (!actuallyTauri || !tauriInvoke) return;
    try {
      await tauriInvoke("set_bitrate", { bitrateKbps: kbps });
    } catch (e) {
      log("Bitrate set error:", e);
    }
  }
  function getQualityGrade(latency, packetLoss, jitter) {
    if (latency < 50 && packetLoss < 1 && jitter < 10) return "excellent";
    if (latency < 100 && packetLoss < 3 && jitter < 20) return "good";
    if (latency < 200 && packetLoss < 5 && jitter < 40) return "fair";
    return "poor";
  }
  function optimizeOpusSdp(sdp, mode = "balanced") {
    const modes = {
      "low-latency": { maxaveragebitrate: 64e3, stereo: 0, useinbandfec: 0, usedtx: 1, maxptime: 10 },
      "balanced": { maxaveragebitrate: 96e3, stereo: 1, useinbandfec: 1, usedtx: 0, maxptime: 20 },
      "high-quality": { maxaveragebitrate: 128e3, stereo: 1, useinbandfec: 1, usedtx: 0, maxptime: 40 }
    };
    const config = modes[mode] || modes.balanced;
    const fmtpLine = `a=fmtp:111 minptime=10;maxptime=${config.maxptime};useinbandfec=${config.useinbandfec};usedtx=${config.usedtx};stereo=${config.stereo};maxaveragebitrate=${config.maxaveragebitrate}`;
    return sdp.replace(/a=fmtp:111[^\r\n]*/g, fmtpLine);
  }
  const network = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
    __proto__: null,
    attemptP2P,
    detectNatType,
    getQualityGrade,
    getUdpStats,
    measureRelayLatency,
    optimizeOpusSdp,
    rtcConfig,
    setBitrate,
    setUdpMuted,
    socket,
    startUdpMode,
    stopUdpMode,
    updateTurnCredentials
  }, Symbol.toStringTag, { value: "Module" }));
  window.styxModules = { core, ui, settings, audio, recording, network };
})();
//# sourceMappingURL=styx-modules.iife.js.map
