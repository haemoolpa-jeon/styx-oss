# Phase 8: VST Hosting & MIDI Sync - Implementation Plan

## Overview
This document outlines the research and implementation plan for VST plugin hosting and MIDI clock synchronization in Styx. These features are deferred for future implementation.

---

## MIDI Sync

### Crate Selection
- **midir** (v0.10) - Cross-platform MIDI I/O
  - Supports: ALSA (Linux), WinMM (Windows), CoreMIDI (macOS)
  - Features: Virtual ports, SysEx support
  - Docs: https://lib.rs/midir

### MIDI Clock Protocol
```
0xF8 - Timing Clock (24 per quarter note)
0xFA - Start
0xFB - Continue  
0xFC - Stop
```

At 120 BPM: 24 clocks × 2 beats/sec = 48 clock messages/second

### Implementation Tasks

#### 1. Basic MIDI I/O
- Add `midir` to Cargo.toml
- Create `midi.rs` module
- Tauri commands: `list_midi_inputs()`, `list_midi_outputs()`

#### 2. Clock Input (Slave Mode)
- Connect to selected MIDI input port
- Count 0xF8 messages to derive BPM
- Sync metronome to external clock
- Handle Start/Stop/Continue messages

#### 3. Clock Output (Master Mode)
- Connect to selected MIDI output port
- Send 0xF8 at intervals based on current BPM
- Send Start/Stop when metronome starts/stops

### Code Skeleton
```rust
// midi.rs
use midir::{MidiInput, MidiOutput};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

pub fn list_midi_inputs() -> Vec<String> {
    let midi_in = MidiInput::new("styx").ok();
    midi_in.map(|m| m.ports().iter()
        .filter_map(|p| m.port_name(p).ok())
        .collect()
    ).unwrap_or_default()
}

pub fn start_clock_input(port_name: &str, bpm: Arc<AtomicU32>) {
    // Connect to port, count 0xF8 messages, update BPM
}

pub fn start_clock_output(port_name: &str, bpm: u32, running: Arc<AtomicBool>) {
    // Send 0xF8 at (60_000 / bpm / 24) ms intervals
}
```

---

## VST Hosting

### Crate Selection
- **vst2** - VST 2.4 API (deprecated but functional)
  - Note: VST2 SDK discontinued, no new licenses available
  - Docs: https://docs.rs/vst2
  
- **Alternative**: Consider VST3 via `vst3-sys` for future-proofing

### Implementation Tasks

#### 1. Plugin Loader
- Add `vst2` to Cargo.toml
- Implement `PluginHost` trait
- Load .dll/.vst/.so files dynamically

#### 2. Audio Processing
- Route audio through plugin's `process()` method
- Handle plugin parameters
- Manage plugin state (bypass, preset)

#### 3. Plugin Selection UI
- Scan common VST directories
- Display plugin list in UI
- Load/unload plugins dynamically

### Code Skeleton
```rust
// vst_host.rs
use vst2::host::{Host, PluginLoader};
use vst2::plugin::Plugin;
use std::sync::{Arc, Mutex};

struct StyxHost;
impl Host for StyxHost {
    fn automate(&self, _index: i32, _value: f32) {}
}

pub fn load_plugin(path: &str) -> Result<Arc<Mutex<dyn Plugin>>, String> {
    let host = Arc::new(Mutex::new(StyxHost));
    let mut loader = PluginLoader::load(path, host)
        .map_err(|e| e.to_string())?;
    Ok(Arc::new(Mutex::new(loader.instance()?)))
}

pub fn process_audio(plugin: &mut dyn Plugin, input: &[f32], output: &mut [f32]) {
    // Create audio buffers, call plugin.process()
}
```

### VST Directory Locations
- Windows: `C:\Program Files\VSTPlugins`, `C:\Program Files\Steinberg\VSTPlugins`
- macOS: `/Library/Audio/Plug-Ins/VST`, `~/Library/Audio/Plug-Ins/VST`
- Linux: `/usr/lib/vst`, `~/.vst`

---

## Effort Estimates
| Feature | Effort | Complexity |
|---------|--------|------------|
| MIDI Basic I/O | Low | Simple |
| MIDI Clock Slave | Medium | Timing-sensitive |
| MIDI Clock Master | Medium | Timing-sensitive |
| VST Plugin Loader | High | Native plugin loading |
| VST Audio Processing | High | Buffer management |
| VST Plugin UI | Medium | File scanning, state |

---

## Dependencies Summary
```toml
# MIDI
midir = "0.10"

# VST (when ready)
vst2 = "0.1"  # or vst3-sys for VST3
```

---

## References
- midir: https://lib.rs/midir
- vst2: https://docs.rs/vst2
- MIDI Clock spec: https://www.midi.org/specifications
- VST SDK (archived): Steinberg VST2 documentation
