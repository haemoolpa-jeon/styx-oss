// Styx Sound Module
// 사운드 알림 (입장/퇴장)

let notifyAudio = null;

function playSound(type) {
  if (!notifyAudio) notifyAudio = new AudioContext();
  if (notifyAudio.state === 'suspended') notifyAudio.resume();
  
  const osc = notifyAudio.createOscillator();
  const gain = notifyAudio.createGain();
  osc.connect(gain);
  gain.connect(notifyAudio.destination);
  
  if (type === 'join') {
    osc.frequency.value = 800;
    gain.gain.setValueAtTime(0.2, notifyAudio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, notifyAudio.currentTime + 0.15);
    osc.start();
    osc.stop(notifyAudio.currentTime + 0.15);
  } else if (type === 'leave') {
    osc.frequency.value = 400;
    gain.gain.setValueAtTime(0.2, notifyAudio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, notifyAudio.currentTime + 0.2);
    osc.start();
    osc.stop(notifyAudio.currentTime + 0.2);
  }
}

function cleanupSound() {
  if (notifyAudio && notifyAudio.state !== 'closed') {
    notifyAudio.close().catch(() => {});
    notifyAudio = null;
  }
}

window.StyxSound = { playSound, cleanupSound };
