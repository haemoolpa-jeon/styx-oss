// Styx Theme Module
// 테마 관리 (다크/라이트)
(function() {

function initTheme() {
  const M = window.StyxModules || {};
  if (M.ui?.initTheme) return M.ui.initTheme();
  const saved = localStorage.getItem('styx-theme') || 'dark';
  document.body.dataset.theme = saved;
  updateThemeIcon();
}

function toggleTheme() {
  const M = window.StyxModules || {};
  if (M.ui?.toggleTheme) return M.ui.toggleTheme();
  const current = document.body.dataset.theme;
  const next = current === 'dark' ? 'light' : 'dark';
  document.body.dataset.theme = next;
  localStorage.setItem('styx-theme', next);
  updateThemeIcon();
  if (window.scheduleSettingsSave) scheduleSettingsSave();
}

function updateThemeIcon() {
  const btn = document.getElementById('themeBtn');
  if (btn) btn.textContent = document.body.dataset.theme === 'dark' ? '☀️' : '🌙';
}

function getTheme() {
  return document.body.dataset.theme || 'dark';
}

initTheme();

window.StyxTheme = { initTheme, toggleTheme, updateThemeIcon, getTheme };

})();
