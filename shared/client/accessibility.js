// Styx Accessibility Module
// 접근성 개선 시스템
(function() {

const accessibility = {
  highContrast: false,
  screenReaderMode: false,
  reducedMotion: false
};

function loadAccessibilitySettings() {
  try {
    const saved = localStorage.getItem('styx-accessibility');
    if (saved) {
      Object.assign(accessibility, JSON.parse(saved));
      applyAccessibilitySettings();
    }
  } catch (e) {
    console.warn('Accessibility settings load failed:', e);
  }
  
  if (window.matchMedia('(prefers-contrast: high)').matches) {
    accessibility.highContrast = true;
  }
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    accessibility.reducedMotion = true;
  }
  
  applyAccessibilitySettings();
}

function applyAccessibilitySettings() {
  document.body.classList.toggle('high-contrast', accessibility.highContrast);
  document.body.classList.toggle('screen-reader', accessibility.screenReaderMode);
  document.body.classList.toggle('reduced-motion', accessibility.reducedMotion);
  
  if (accessibility.screenReaderMode) {
    addScreenReaderSupport();
  }
}

function addScreenReaderSupport() {
  const elements = [
    { id: 'muteBtn', label: () => document.getElementById('muteBtn')?.classList.contains('muted') ? '음소거 해제' : '음소거' },
    { id: 'recordBtn', label: () => document.getElementById('recordBtn')?.classList.contains('recording') ? '녹음 중지' : '녹음 시작' },
    { id: 'metronome-toggle', label: () => '메트로놈 토글' },
    { id: 'inviteBtn', label: () => '초대 링크 복사' },
    { id: 'leaveBtn', label: () => '방 나가기' },
    { id: 'settingsBtn', label: () => '설정 열기' },
    { id: 'adminBtn', label: () => '관리자 패널 열기' }
  ];
  
  elements.forEach(({ id, label }) => {
    const el = document.getElementById(id);
    if (el) {
      el.setAttribute('aria-label', typeof label === 'function' ? label() : label);
      el.setAttribute('role', 'button');
    }
  });
  
  const volumeSliders = document.querySelectorAll('input[type="range"]');
  volumeSliders.forEach(slider => {
    slider.setAttribute('role', 'slider');
    slider.setAttribute('aria-valuemin', slider.min);
    slider.setAttribute('aria-valuemax', slider.max);
    slider.setAttribute('aria-valuenow', slider.value);
    slider.addEventListener('input', () => {
      slider.setAttribute('aria-valuenow', slider.value);
    });
  });
  
  if (!document.getElementById('aria-live-region')) {
    const liveRegion = document.createElement('div');
    liveRegion.id = 'aria-live-region';
    liveRegion.setAttribute('aria-live', 'polite');
    liveRegion.setAttribute('aria-atomic', 'true');
    liveRegion.style.cssText = 'position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden';
    document.body.appendChild(liveRegion);
  }
}

function announceToScreenReader(message) {
  if (!accessibility.screenReaderMode) return;
  const liveRegion = document.getElementById('aria-live-region');
  if (liveRegion) {
    liveRegion.textContent = message;
    setTimeout(() => liveRegion.textContent = '', 1000);
  }
}

function toggleHighContrast() {
  accessibility.highContrast = !accessibility.highContrast;
  saveAccessibilitySettings();
  applyAccessibilitySettings();
  if (window.toast) toast(`고대비 모드 ${accessibility.highContrast ? '활성화' : '비활성화'}`, 'info');
  announceToScreenReader(`고대비 모드가 ${accessibility.highContrast ? '활성화' : '비활성화'}되었습니다`);
}

function toggleScreenReaderMode() {
  accessibility.screenReaderMode = !accessibility.screenReaderMode;
  saveAccessibilitySettings();
  applyAccessibilitySettings();
  if (window.toast) toast(`스크린 리더 모드 ${accessibility.screenReaderMode ? '활성화' : '비활성화'}`, 'info');
}

function toggleReducedMotion() {
  accessibility.reducedMotion = !accessibility.reducedMotion;
  saveAccessibilitySettings();
  applyAccessibilitySettings();
  if (window.toast) toast(`애니메이션 감소 ${accessibility.reducedMotion ? '활성화' : '비활성화'}`, 'info');
}

function saveAccessibilitySettings() {
  localStorage.setItem('styx-accessibility', JSON.stringify(accessibility));
}

function enhanceKeyboardNavigation() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      document.body.classList.add('keyboard-navigation');
    }
  });
  
  document.addEventListener('mousedown', () => {
    document.body.classList.remove('keyboard-navigation');
  });
  
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('button:not([disabled])')) {
      e.target.click();
    }
  });
}

// Export to window
window.StyxAccessibility = {
  accessibility,
  loadAccessibilitySettings,
  applyAccessibilitySettings,
  announceToScreenReader,
  toggleHighContrast,
  toggleScreenReaderMode,
  toggleReducedMotion,
  enhanceKeyboardNavigation
};

})();
