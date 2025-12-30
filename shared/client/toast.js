// Styx Toast Module
// 토스트 알림 메시지
(function() {

function toast(message, type = 'info', duration = 3000) {
  const M = window.StyxModules || {};
  if (M.ui?.toast) return M.ui.toast(message, type, duration);
  
  const container = document.getElementById('toast-container');
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

window.toast = toast;
window.StyxToast = { toast };

})();
