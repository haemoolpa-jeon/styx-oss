// SFU Audio Mixer - Server-side audio mixing for large rooms
const OpusScript = require('opusscript');

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_SIZE = 480; // 10ms @ 48kHz

class AudioMixer {
  constructor(roomId) {
    this.roomId = roomId;
    this.decoders = new Map(); // peerId -> decoder
    this.encoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
    this.encoder.setBitrate(96000);
    this.buffers = new Map(); // peerId -> PCM buffer
    this.mixInterval = null;
  }

  addPeer(peerId) {
    if (!this.decoders.has(peerId)) {
      this.decoders.set(peerId, new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO));
      this.buffers.set(peerId, []);
    }
  }

  removePeer(peerId) {
    const decoder = this.decoders.get(peerId);
    if (decoder) decoder.delete();
    this.decoders.delete(peerId);
    this.buffers.delete(peerId);
  }

  // Decode incoming Opus packet and buffer PCM
  decodePacket(peerId, opusData) {
    const decoder = this.decoders.get(peerId);
    if (!decoder) return;
    
    try {
      const pcm = decoder.decode(opusData);
      const buffer = this.buffers.get(peerId);
      if (buffer && pcm) {
        buffer.push(pcm);
        // Limit buffer to 5 frames (50ms)
        while (buffer.length > 5) buffer.shift();
      }
    } catch (e) {
      // Decode error - skip frame
    }
  }

  // Mix all peer buffers into single output (excluding specified peer)
  mixForPeer(excludePeerId) {
    const mixBuffer = new Int16Array(FRAME_SIZE * CHANNELS);
    let hasAudio = false;
    let peerCount = 0;

    for (const [peerId, buffer] of this.buffers) {
      if (peerId === excludePeerId || buffer.length === 0) continue;
      
      const pcm = buffer.shift();
      if (!pcm) continue;
      
      hasAudio = true;
      peerCount++;
      
      // Add to mix (with overflow protection)
      for (let i = 0; i < pcm.length && i < mixBuffer.length; i++) {
        mixBuffer[i] = Math.max(-32768, Math.min(32767, mixBuffer[i] + pcm[i]));
      }
    }

    if (!hasAudio) return null;

    // Normalize if multiple sources
    if (peerCount > 1) {
      const scale = 1 / Math.sqrt(peerCount);
      for (let i = 0; i < mixBuffer.length; i++) {
        mixBuffer[i] = Math.round(mixBuffer[i] * scale);
      }
    }

    // Encode mixed audio
    try {
      return this.encoder.encode(mixBuffer, FRAME_SIZE);
    } catch (e) {
      return null;
    }
  }

  destroy() {
    for (const decoder of this.decoders.values()) {
      decoder.delete();
    }
    this.decoders.clear();
    this.buffers.clear();
    this.encoder.delete();
  }
}

// Room mixers
const mixers = new Map(); // roomId -> AudioMixer

function getMixer(roomId) {
  if (!mixers.has(roomId)) {
    mixers.set(roomId, new AudioMixer(roomId));
  }
  return mixers.get(roomId);
}

function removeMixer(roomId) {
  const mixer = mixers.get(roomId);
  if (mixer) {
    mixer.destroy();
    mixers.delete(roomId);
  }
}

module.exports = { AudioMixer, getMixer, removeMixer, FRAME_SIZE };
