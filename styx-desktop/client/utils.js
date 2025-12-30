// Styx Utils Module
// 유틸리티 함수들
(function() {

function getQualityGrade(latency, packetLoss, jitter) {
  const M = window.StyxModules || {};
  if (M.network?.getQualityGrade) return M.network.getQualityGrade(latency, packetLoss, jitter);
  if (packetLoss > 5 || latency > 200 || jitter > 50) return { grade: 'poor', label: '불안정', color: '#ff4757' };
  if (packetLoss > 2 || latency > 100 || jitter > 30) return { grade: 'fair', label: '보통', color: '#ffa502' };
  return { grade: 'good', label: '좋음', color: '#2ed573' };
}

function showUserFriendlyError(error, context) {
  const errorMessages = {
    'NotAllowedError': '마이크 권한이 거부되었습니다. 브라우저 설정에서 마이크 권한을 허용해주세요.',
    'NotFoundError': '마이크를 찾을 수 없습니다. 마이크가 연결되어 있는지 확인해주세요.',
    'NotReadableError': '마이크에 접근할 수 없습니다. 다른 앱에서 마이크를 사용 중일 수 있습니다.',
    'OverconstrainedError': '마이크 설정이 지원되지 않습니다. 다른 마이크를 선택해보세요.',
    'SecurityError': '보안 오류가 발생했습니다. HTTPS 연결을 사용해주세요.',
    'AbortError': '마이크 접근이 중단되었습니다.',
    'TypeError': '설정 오류가 발생했습니다. 페이지를 새로고침해주세요.',
    'NetworkError': '네트워크 연결에 문제가 있습니다. 인터넷 연결을 확인해주세요.',
    'timeout': '연결 시간이 초과되었습니다. 네트워크 상태를 확인해주세요.'
  };
  
  const message = errorMessages[error.name] || errorMessages[error] || `알 수 없는 오류가 발생했습니다: ${error.message || error}`;
  if (window.toast) toast(message, 'error', 8000);
}

function formatTime(ms) {
  const M = window.StyxModules || {};
  if (M.core?.formatTime) return M.core.formatTime(ms);
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

function downloadBlob(blob, filename) {
  const M = window.StyxModules || {};
  if (M.core?.downloadBlob) return M.core.downloadBlob(blob, filename);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

window.StyxUtils = {
  getQualityGrade,
  showUserFriendlyError,
  formatTime,
  downloadBlob
};

})();
