// Styx Tuner Module
// 악기 튜너 (피치 감지)
(function() {

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

let tunerCtx = null;
let tunerAnalyser = null;
let tunerInterval = null;
let tunerEnabled = false;

function detectPitch(buffer, sampleRate) {
  let maxCorr = 0, bestOffset = -1;
  const minFreq = 60, maxFreq = 1000;
  const minOffset = Math.floor(sampleRate / maxFreq);
  const maxOffset = Math.floor(sampleRate / minFreq);
  
  for (let offset = minOffset; offset < maxOffset; offset++) {
    let corr = 0;
    for (let i = 0; i < buffer.length - offset; i++) {
      corr += buffer[i] * buffer[i + offset];
    }
    if (corr > maxCorr) { maxCorr = corr; bestOffset = offset; }
  }
  return bestOffset > 0 ? sampleRate / bestOffset : null;
}

function freqToNote(freq) {
  const semitone = 12 * Math.log2(freq / 440) + 69;
  const note = Math.round(semitone);
  const cents = Math.round((semitone - note) * 100);
  return { name: NOTE_NAMES[note % 12] + Math.floor(note / 12 - 1), cents };
}

function toggleTuner(enabled) {
  tunerEnabled = enabled;
  const display = document.getElementById('tuner-display');
  const localStream = window.localStream;
  
  if (enabled && localStream) {
    if (!tunerCtx) tunerCtx = new AudioContext();
    tunerAnalyser = tunerCtx.createAnalyser();
    tunerAnalyser.fftSize = 4096;
    tunerCtx.createMediaStreamSource(localStream).connect(tunerAnalyser);
    
    const buffer = new Float32Array(tunerAnalyser.fftSize);
    tunerInterval = setInterval(() => {
      tunerAnalyser.getFloatTimeDomainData(buffer);
      const freq = detectPitch(buffer, tunerCtx.sampleRate);
      if (freq && display) {
        const note = freqToNote(freq);
        display.innerHTML = `<span class="note">${note.name}</span><span class="cents">${note.cents > 0 ? '+' : ''}${note.cents}¢</span>`;
        display.className = Math.abs(note.cents) < 10 ? 'tuner-display in-tune' : 'tuner-display';
      }
    }, 50);
    if (display) display.classList.remove('hidden');
  } else {
    if (tunerInterval) { clearInterval(tunerInterval); tunerInterval = null; }
    if (display) { display.classList.add('hidden'); display.innerHTML = ''; }
  }
}

function cleanupTuner() {
  if (tunerInterval) { clearInterval(tunerInterval); tunerInterval = null; }
  if (tunerCtx && tunerCtx.state !== 'closed') {
    tunerCtx.close().catch(() => {});
    tunerCtx = null;
  }
  tunerAnalyser = null;
  tunerEnabled = false;
}

window.StyxTuner = {
  toggleTuner,
  cleanupTuner,
  detectPitch,
  freqToNote,
  get enabled() { return tunerEnabled; }
};

})();
