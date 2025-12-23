// Simple Noise Gate AudioWorklet Processor
// Lightweight alternative to RNNoise - reduces background noise without WASM dependency

class NoiseGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -50, minValue: -100, maxValue: 0 },
      { name: 'attack', defaultValue: 0.001, minValue: 0.0001, maxValue: 0.1 },
      { name: 'release', defaultValue: 0.05, minValue: 0.01, maxValue: 0.5 }
    ];
  }
  
  constructor() {
    super();
    this.envelope = 0;
    this.gateOpen = false;
  }
  
  process(inputs, outputs, parameters) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    
    if (!input || !output) return true;
    
    const threshold = Math.pow(10, parameters.threshold[0] / 20);
    const attack = parameters.attack[0];
    const release = parameters.release[0];
    
    for (let i = 0; i < input.length; i++) {
      const sample = Math.abs(input[i]);
      
      // Envelope follower
      if (sample > this.envelope) {
        this.envelope += (sample - this.envelope) * attack;
      } else {
        this.envelope += (sample - this.envelope) * release;
      }
      
      // Gate logic with hysteresis
      if (this.envelope > threshold * 1.5) {
        this.gateOpen = true;
      } else if (this.envelope < threshold) {
        this.gateOpen = false;
      }
      
      // Smooth gain
      output[i] = this.gateOpen ? input[i] : input[i] * 0.01;
    }
    
    return true;
  }
}

registerProcessor('noise-gate-processor', NoiseGateProcessor);
