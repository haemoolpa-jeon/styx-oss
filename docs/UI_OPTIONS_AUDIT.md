# Styx UI Options Audit

## Summary
Total user-facing options: **50+**
This is too many for a focused audio collaboration tool.

---

## 1. LOBBY - Audio Settings (Before Joining)

### Device Selection (Essential)
| Option | ID | Purpose | Keep? |
|--------|-----|---------|-------|
| Input Device | `audio-device` | Select microphone | ✅ Essential |
| Output Device | `audio-output` | Select speakers | ✅ Essential |

### Audio Processing (12 options!)
| Option | ID | Purpose | Keep? |
|--------|-----|---------|-------|
| Echo Cancel | `echo-cancel` | Remove echo | ✅ Essential |
| Noise Suppress | `noise-suppress` | Remove background noise | ✅ Essential |
| AI Noise | `ai-noise` | ML-based noise removal | ⚠️ Consider - adds latency |
| Auto Gain | `auto-gain` | Automatic volume | ✅ Essential |
| PTT Mode | `ptt-mode` | Push-to-talk | ✅ Essential |
| VAD Mode | `vad-mode` | Voice activity display | ⚠️ Consider - visual only |
| Ducking | `ducking-mode` | Auto volume reduction | ❌ Rarely used |
| Input Monitor | `input-monitor` | Hear yourself | ⚠️ Consider - niche |
| Tuner | `tuner-toggle` | Guitar tuner | ❌ Niche feature |
| Auto Adapt | `auto-adapt` | Auto quality adjustment | ✅ Keep (but hide) |
| Low Latency | `low-latency-mode` | Aggressive low latency | ⚠️ Merge with Pro |
| Pro Mode | `pro-mode` | Bypass all processing | ✅ Keep |

### Network Settings (4 options)
| Option | ID | Purpose | Keep? |
|--------|-----|---------|-------|
| Jitter Buffer | `jitter-slider` | Manual buffer control | ⚠️ Hide for most users |
| Auto Jitter | `auto-jitter` | Automatic buffer | ✅ Keep (default on) |
| DTX | `dtx-toggle` | Bandwidth saving | ⚠️ Advanced - hide |
| Comfort Noise | `comfort-noise-toggle` | Silence smoothing | ⚠️ Advanced - hide |

### Tauri-specific (2 options)
| Option | ID | Purpose | Keep? |
|--------|-----|---------|-------|
| Audio Host | `tauri-audio-host` | WASAPI/ASIO | ⚠️ Advanced - hide |
| Buffer Size | `buffer-size-select` | CPAL buffer | ⚠️ Advanced - hide |

---

## 2. ROOM CREATION (8 options)

| Option | ID | Purpose | Keep? |
|--------|-----|---------|-------|
| Room Name | `new-room-name` | Name the room | ✅ Essential |
| Password | `new-room-password` | Private room | ✅ Essential |
| Max Users | `new-room-max-users` | Limit participants | ✅ Essential |
| Audio Mode | `new-room-audio-mode` | Voice/Music | ✅ Essential |
| Sample Rate | `new-room-sample-rate` | 44.1/48kHz | ❌ Always 48kHz |
| Bitrate | `new-room-bitrate` | Audio quality | ⚠️ Simplify to Low/Med/High |
| BPM | `new-room-bpm` | Metronome tempo | ✅ Essential |
| Private | `new-room-private` | Hide from list | ✅ Essential |

---

## 3. IN-ROOM TOOLBAR (20+ options!)

### Essential Controls
| Option | ID | Purpose | Keep? |
|--------|-----|---------|-------|
| Mute | `muteBtn` | Mute mic | ✅ Essential |
| Leave | `leaveBtn` | Exit room | ✅ Essential |
| Invite | `inviteBtn` | Share link | ✅ Essential |
| Record | `recordBtn` | Record session | ✅ Essential |
| Screen Share | `screenShareBtn` | Share screen | ✅ Essential |

### Duplicated from Lobby (7 options)
| Option | ID | Purpose | Keep? |
|--------|-----|---------|-------|
| Room Echo Cancel | `room-echo-cancel` | Same as lobby | ❌ Remove duplicate |
| Room Noise Suppress | `room-noise-suppress` | Same as lobby | ❌ Remove duplicate |
| Room AI Noise | `room-ai-noise` | Same as lobby | ❌ Remove duplicate |
| Room PTT | `room-ptt-mode` | Same as lobby | ❌ Remove duplicate |
| Room VAD | `room-vad-mode` | Same as lobby | ❌ Remove duplicate |
| Room Auto Adapt | `room-auto-adapt` | Same as lobby | ❌ Remove duplicate |
| Room Ducking | `room-ducking` | Same as lobby | ❌ Remove duplicate |

### Recording Options (2 options)
| Option | ID | Purpose | Keep? |
|--------|-----|---------|-------|
| Multitrack | `multitrack-mode` | Record each peer separately | ⚠️ Advanced |
| Loopback | `loopback-mode` | Record what you hear | ⚠️ Advanced |

### Sync/Latency (3 options)
| Option | ID | Purpose | Keep? |
|--------|-----|---------|-------|
| Delay Compensation | `delay-compensation` | Sync all users | ✅ Essential for music |
| Room Jitter | `room-jitter-slider` | Manual buffer | ❌ Remove (use auto) |
| Room Auto Jitter | `room-auto-jitter` | Auto buffer | ❌ Remove (always auto) |

### Metronome (3 options)
| Option | ID | Purpose | Keep? |
|--------|-----|---------|-------|
| Metronome Toggle | `metronome-toggle` | Start/stop | ✅ Essential |
| BPM Input | `bpm-input` | Set tempo | ✅ Essential |
| Count-in | `count-in` | 4-beat lead-in | ✅ Essential |

### Advanced Features (8 options)
| Option | ID | Purpose | Keep? |
|--------|-----|---------|-------|
| Effects Panel | `effects-toggle` | EQ controls | ⚠️ Collapse into menu |
| Spectrum | `spectrum-toggle` | Frequency display | ❌ Visual only |
| Spatial Audio | `spatial-toggle` | 3D positioning | ❌ Rarely used |
| SFU Mode | `sfu-toggle` | Server mixing | ⚠️ Auto-enable for 5+ |
| Diagnostics | `diag-toggle` | Connection info | ⚠️ Move to menu |
| Bandwidth Monitor | `bandwidth-toggle` | Stats display | ❌ Merge with diag |
| Routing | `routing-toggle` | L/R/Mono routing | ❌ Niche |
| Noise Profile | `noise-profile-toggle` | Learn noise floor | ❌ Niche |

---

## Recommendations

### Remove (12 options)
1. **Tuner** - Niche, use external app
2. **Ducking** - Rarely used
3. **Spectrum** - Visual only, no audio benefit
4. **Spatial Audio** - Rarely used, adds complexity
5. **Bandwidth Monitor** - Merge into diagnostics
6. **Routing** - Very niche
7. **Noise Profile** - Complex, auto-adapt is better
8. **Sample Rate** - Always 48kHz
9. **Room Jitter Slider** - Use auto only
10. **All 7 duplicated room options** - Use lobby settings

### Hide in "Advanced" (8 options)
1. DTX
2. Comfort Noise
3. Audio Host (Tauri)
4. Buffer Size (Tauri)
5. Jitter Buffer (manual)
6. Multitrack Recording
7. Loopback Recording
8. SFU Mode (auto-enable instead)

### Simplify (3 options)
1. **Bitrate** → Low/Medium/High instead of kbps
2. **Low Latency + Pro Mode** → Merge into single "Performance Mode"
3. **AI Noise + Noise Suppress** → Single "Noise Reduction" with Off/Normal/AI

### Keep as-is (20 options)
- Device selection (2)
- Essential audio (echo, gain, PTT) (3)
- Room creation (6)
- Room controls (mute, leave, invite, record, screen) (5)
- Metronome (3)
- Delay compensation (1)

---

## Proposed Simplified UI

### Lobby Settings
```
🎤 Input: [Dropdown]
🔊 Output: [Dropdown]

Audio:
☑️ Echo Cancel  ☑️ Noise Reduction [Off/Normal/AI ▼]
☑️ Auto Gain    ☐ Push-to-Talk

Performance: [Normal ▼]  (Normal / Low Latency / Pro)

[▼ Advanced Settings]
  - Buffer: Auto ☑️ [slider if unchecked]
  - DTX, Comfort Noise, etc.
```

### Room Toolbar
```
[🎤 Mute] [🔗 Invite] [⏺️ Record] [🖥️ Screen] [🚪 Leave]

Metronome: [▶️] BPM: [120] ☐ Count-in

[⚙️ More] → Effects, Diagnostics, Recording Options
```

This reduces visible options from 50+ to ~15 while keeping all functionality accessible.
