// Styx - UI Module
// DOM helpers, modals, toasts, theme

import { $, state } from './core.js';

// Toast notifications
export function toast(message, type = 'info', duration = 3000) {
  const container = $('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('hide');
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// Theme
export function initTheme() {
  const saved = localStorage.getItem('styx-theme') || 'dark';
  document.body.dataset.theme = saved;
  updateThemeIcon();
}

export function toggleTheme() {
  const current = document.body.dataset.theme;
  const next = current === 'dark' ? 'light' : 'dark';
  document.body.dataset.theme = next;
  localStorage.setItem('styx-theme', next);
  updateThemeIcon();
}

function updateThemeIcon() {
  const btn = $('themeBtn');
  if (btn) btn.textContent = document.body.dataset.theme === 'dark' ? '☀️' : '🌙';
}

// Modal helpers
export function showModal(id) {
  const modal = $(id);
  if (modal) modal.classList.remove('hidden');
}

export function hideModal(id) {
  const modal = $(id);
  if (modal) modal.classList.add('hidden');
}

// Reconnection overlay
let reconnectAttempt = 0;

export function showReconnectProgress(attempt = 1) {
  reconnectAttempt = attempt;
  const overlay = $('reconnect-overlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  const countEl = $('reconnect-count');
  if (countEl) countEl.textContent = attempt;
  const progress = (attempt / 10) * 100;
  const progressBar = overlay.querySelector('.progress-bar');
  if (progressBar) progressBar.style.width = progress + '%';
}

export function updateReconnectProgress() {
  const overlay = $('reconnect-overlay');
  if (!overlay || overlay.classList.contains('hidden')) return;
  const progress = (reconnectAttempt / 10) * 100;
  const progressBar = overlay.querySelector('.progress-bar');
  if (progressBar) progressBar.style.width = progress + '%';
}

export function hideReconnectProgress() {
  const overlay = $('reconnect-overlay');
  if (overlay) overlay.classList.add('hidden');
  reconnectAttempt = 0;
}

// Mute UI update
export function updateMuteUI() {
  const btn = $('muteBtn');
  if (btn) {
    btn.textContent = state.isMuted ? '🔇' : '🎤';
    btn.classList.toggle('muted', state.isMuted);
  }
}

// Quality indicator
export function updateQualityIndicator(jitter = 0, packetLoss = 0, e2eLatency = null) {
  const indicator = $('quality-indicator');
  if (!indicator) return;
  
  let quality = 'good';
  if (jitter > 30 || packetLoss > 5) quality = 'fair';
  if (jitter > 50 || packetLoss > 10) quality = 'poor';
  
  indicator.className = `quality-indicator ${quality}`;
  
  let title = `Jitter: ${jitter.toFixed(1)}ms\nPacket Loss: ${packetLoss.toFixed(1)}%`;
  if (e2eLatency !== null) title += `\nE2E Latency: ${e2eLatency}ms`;
  indicator.title = title;
  
  const latencyText = indicator.querySelector('.latency-text');
  if (latencyText && e2eLatency !== null) {
    latencyText.textContent = `${e2eLatency}ms`;
  }
}
