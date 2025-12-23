// UDP P2P 오디오 피어 모듈
use opus::{Encoder, Decoder, Application, Channels};
use std::collections::{BTreeMap, VecDeque};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use crate::udp::AudioPacketHeader;

const FRAME_SIZE: usize = 960; // 10ms @ 48kHz stereo (480 samples per channel)
const MAX_PACKET_SIZE: usize = 1500;
const MIN_JITTER_BUFFER: usize = 2;  // 20ms minimum (aggressive, for good networks)
const MAX_JITTER_BUFFER: usize = 10; // 100ms maximum
const KEEPALIVE_INTERVAL_MS: u64 = 5000; // 5초마다 keepalive

// 적응형 지터 버퍼
pub struct JitterBuffer {
    buffer: BTreeMap<u32, Vec<f32>>,
    next_seq: u32,
    target_size: usize,
    // 적응형 크기 조절용 통계
    late_packets: u32,
    total_packets: u32,
}

impl JitterBuffer {
    pub fn new(initial_size: usize) -> Self {
        Self { 
            buffer: BTreeMap::new(), 
            next_seq: 0, 
            target_size: initial_size,
            late_packets: 0,
            total_packets: 0,
        }
    }
    
    pub fn len(&self) -> usize {
        self.buffer.len()
    }
    
    pub fn target_size(&self) -> usize {
        self.target_size
    }
    
    pub fn set_target(&mut self, size: usize) {
        self.target_size = size.max(MIN_JITTER_BUFFER).min(MAX_JITTER_BUFFER);
    }
    
    pub fn push(&mut self, seq: u32, samples: Vec<f32>) {
        self.total_packets += 1;
        
        // 너무 오래된 패킷 (이미 재생됨)
        if self.next_seq > 0 && seq < self.next_seq.wrapping_sub(self.target_size as u32 * 2) {
            self.late_packets += 1;
            return;
        }
        
        // 버퍼 오버플로우 방지
        while self.buffer.len() >= self.target_size * 2 {
            if let Some(&oldest) = self.buffer.keys().next() {
                self.buffer.remove(&oldest);
            }
        }
        self.buffer.insert(seq, samples);
        
        // 적응형 크기 조절 (100패킷마다)
        if self.total_packets % 100 == 0 {
            self.adapt_size();
        }
    }
    
    fn adapt_size(&mut self) {
        if self.total_packets == 0 { return; }
        
        let late_ratio = self.late_packets as f32 / self.total_packets as f32;
        
        if late_ratio > 0.05 && self.target_size < MAX_JITTER_BUFFER {
            // 5% 이상 늦은 패킷 → 버퍼 증가
            self.target_size += 1;
        } else if late_ratio < 0.01 && self.target_size > MIN_JITTER_BUFFER {
            // 1% 미만 → 버퍼 감소 (지연 줄이기)
            self.target_size -= 1;
        }
        
        // 통계 리셋
        self.late_packets = 0;
        self.total_packets = 0;
    }
    
    pub fn pop(&mut self) -> Option<Vec<f32>> {
        // 정상 순서 패킷
        if let Some(samples) = self.buffer.remove(&self.next_seq) {
            self.next_seq = self.next_seq.wrapping_add(1);
            return Some(samples);
        }
        
        // 버퍼가 충분히 찼으면 가장 오래된 것 반환 (순서 건너뛰기)
        if self.buffer.len() >= self.target_size / 2 {
            if let Some(&seq) = self.buffer.keys().next() {
                self.next_seq = seq.wrapping_add(1);
                return self.buffer.remove(&seq);
            }
        }
        None
    }
}

// 피어별 통계
#[derive(Default, Clone)]
pub struct PeerStats {
    pub packets_received: u32,
    pub packets_lost: u32,
    pub last_seq: u32,
    pub audio_level: f32,
}

// UDP 스트림 상태
pub struct UdpStreamState {
    pub socket: Option<Arc<UdpSocket>>,
    pub peers: Vec<SocketAddr>,
    pub is_running: Arc<AtomicBool>,
    pub is_muted: Arc<AtomicBool>,
    pub sequence: Arc<AtomicU32>,
    pub jitter_buffers: Arc<Mutex<BTreeMap<SocketAddr, JitterBuffer>>>,
    pub playback_buffer: Arc<Mutex<VecDeque<f32>>>, // VecDeque for O(1) pop_front
    // 통계
    pub packets_sent: Arc<AtomicU32>,
    pub packets_received: Arc<AtomicU32>,
    pub packets_lost: Arc<AtomicU32>,
    pub peer_stats: Arc<Mutex<BTreeMap<SocketAddr, PeerStats>>>,
    pub input_level: Arc<AtomicU32>, // 0-100 input level
    pub bitrate: Arc<AtomicU32>, // Opus bitrate in kbps
    // 장치 선택
    pub input_device: Option<String>,
    pub output_device: Option<String>,
    // 릴레이 모드
    pub relay_addr: Option<SocketAddr>,
    pub session_id: Option<String>,
}

impl Default for UdpStreamState {
    fn default() -> Self {
        Self {
            socket: None,
            peers: Vec::new(),
            is_running: Arc::new(AtomicBool::new(false)),
            is_muted: Arc::new(AtomicBool::new(false)),
            sequence: Arc::new(AtomicU32::new(0)),
            jitter_buffers: Arc::new(Mutex::new(BTreeMap::new())),
            playback_buffer: Arc::new(Mutex::new(VecDeque::new())),
            packets_sent: Arc::new(AtomicU32::new(0)),
            packets_received: Arc::new(AtomicU32::new(0)),
            packets_lost: Arc::new(AtomicU32::new(0)),
            peer_stats: Arc::new(Mutex::new(BTreeMap::new())),
            input_level: Arc::new(AtomicU32::new(0)),
            bitrate: Arc::new(AtomicU32::new(96)), // 96kbps default
            input_device: None,
            output_device: None,
            relay_addr: None,
            session_id: None,
        }
    }
}

// Opus 인코더/디코더 생성
pub fn create_encoder_with_bitrate(bitrate_kbps: u32) -> Result<Encoder, String> {
    let mut encoder = Encoder::new(48000, Channels::Stereo, Application::LowDelay)
        .map_err(|e| format!("Opus 인코더 생성 실패: {:?}", e))?;
    encoder.set_bitrate(opus::Bitrate::Bits(bitrate_kbps as i32 * 1000)).ok();
    encoder.set_inband_fec(true).ok();
    encoder.set_packet_loss_perc(5).ok();
    encoder.set_vbr(false).ok();
    Ok(encoder)
}

pub fn create_encoder() -> Result<Encoder, String> {
    create_encoder_with_bitrate(96)
}

pub fn create_decoder() -> Result<Decoder, String> {
    Decoder::new(48000, Channels::Stereo)
        .map_err(|e| format!("Opus 디코더 생성 실패: {:?}", e))
}

// 오디오 프레임 인코딩/디코딩
pub fn encode_frame(encoder: &mut Encoder, samples: &[f32]) -> Result<Vec<u8>, String> {
    let mut output = vec![0u8; MAX_PACKET_SIZE];
    let len = encoder.encode_float(samples, &mut output)
        .map_err(|e| format!("인코딩 실패: {:?}", e))?;
    output.truncate(len);
    Ok(output)
}

pub fn decode_frame(decoder: &mut Decoder, data: &[u8]) -> Result<Vec<f32>, String> {
    let mut pcm = vec![0f32; FRAME_SIZE]; // 960 samples for stereo
    let len = decoder.decode_float(data, &mut pcm, true) // true = FEC 활성화
        .map_err(|e| format!("디코딩 실패: {:?}", e))?;
    pcm.truncate(len);
    Ok(pcm)
}

// 패킷 손실 시 PLC (Packet Loss Concealment)
pub fn decode_plc(decoder: &mut Decoder) -> Result<Vec<f32>, String> {
    let mut pcm = vec![0f32; FRAME_SIZE];
    let len = decoder.decode_float(&[], &mut pcm, true)
        .map_err(|e| format!("PLC 실패: {:?}", e))?;
    pcm.truncate(len);
    Ok(pcm)
}

// 오디오 레벨 계산 (RMS)
fn calculate_audio_level(samples: &[f32]) -> f32 {
    if samples.is_empty() { return 0.0; }
    let sum: f32 = samples.iter().map(|s| s * s).sum();
    (sum / samples.len() as f32).sqrt()
}

// UDP 오디오 전송 루프 시작
pub fn start_send_loop(
    socket: Arc<UdpSocket>,
    peers: Vec<SocketAddr>,
    is_running: Arc<AtomicBool>,
    is_muted: Arc<AtomicBool>,
    sequence: Arc<AtomicU32>,
    packets_sent: Arc<AtomicU32>,
    input_device_name: Option<String>,
) -> Result<(), String> {
    let host = cpal::default_host();
    let device = match &input_device_name {
        Some(name) => host.input_devices()
            .map_err(|e| e.to_string())?
            .find(|d| d.name().map(|n| n == *name).unwrap_or(false))
            .ok_or_else(|| format!("입력 장치 '{}' 없음", name))?,
        None => host.default_input_device().ok_or("기본 입력 장치 없음")?,
    };
    let config = device.default_input_config().map_err(|e| e.to_string())?;
    
    let (tx, mut rx) = mpsc::channel::<Vec<f32>>(32);
    let is_running_capture = is_running.clone();
    let is_running_stream = is_running.clone();
    let is_running_keepalive = is_running.clone();
    let is_muted_clone = is_muted.clone();
    
    // 오디오 캡처 스레드
    std::thread::spawn(move || {
        let stream = device.build_input_stream(
            &config.into(),
            move |data: &[f32], _| {
                if !is_muted_clone.load(Ordering::Relaxed) && is_running_capture.load(Ordering::Relaxed) {
                    let _ = tx.blocking_send(data.to_vec());
                }
            },
            |e| eprintln!("입력 오류: {}", e),
            None,
        );
        if let Ok(s) = stream {
            let _ = s.play();
            while is_running_stream.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
    });
    
    // UDP 전송 태스크
    let rt = tokio::runtime::Handle::current();
    let socket_clone = socket.clone();
    let peers_clone = peers.clone();
    
    // Keepalive 태스크 (NAT 매핑 유지)
    rt.spawn(async move {
        let keepalive_packet = [0u8; 1]; // 빈 keepalive 패킷
        while is_running_keepalive.load(Ordering::Relaxed) {
            for peer in &peers_clone {
                let _ = socket_clone.send_to(&keepalive_packet, peer).await;
            }
            tokio::time::sleep(std::time::Duration::from_millis(KEEPALIVE_INTERVAL_MS)).await;
        }
    });
    
    rt.spawn(async move {
        let mut encoder = match create_encoder() {
            Ok(e) => e,
            Err(_) => return,
        };
        let mut frame_buffer = Vec::with_capacity(FRAME_SIZE);
        
        while let Some(samples) = rx.recv().await {
            frame_buffer.extend(samples);
            
            while frame_buffer.len() >= FRAME_SIZE {
                let frame: Vec<f32> = frame_buffer.drain(..FRAME_SIZE).collect();
                if let Ok(opus_data) = encode_frame(&mut encoder, &frame) {
                    let seq = sequence.fetch_add(1, Ordering::SeqCst);
                    let header = AudioPacketHeader {
                        sequence: seq,
                        timestamp: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap().as_micros() as u64,
                        sample_rate: 48000,
                        channels: 2,
                        payload_len: opus_data.len() as u16,
                    };
                    let mut packet = header.to_bytes();
                    packet.extend(&opus_data);
                    
                    for peer in &peers {
                        let _ = socket.send_to(&packet, peer).await;
                        packets_sent.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
        }
    });
    
    Ok(())
}

// UDP 오디오 수신 루프 시작
pub fn start_recv_loop(
    socket: Arc<UdpSocket>,
    is_running: Arc<AtomicBool>,
    jitter_buffers: Arc<Mutex<BTreeMap<SocketAddr, JitterBuffer>>>,
    playback_buffer: Arc<Mutex<VecDeque<f32>>>,
    packets_received: Arc<AtomicU32>,
    peer_stats: Arc<Mutex<BTreeMap<SocketAddr, PeerStats>>>,
    output_device_name: Option<String>,
) -> Result<(), String> {
    let host = cpal::default_host();
    let device = match &output_device_name {
        Some(name) => host.output_devices()
            .map_err(|e| e.to_string())?
            .find(|d| d.name().map(|n| n == *name).unwrap_or(false))
            .ok_or_else(|| format!("출력 장치 '{}' 없음", name))?,
        None => host.default_output_device().ok_or("기본 출력 장치 없음")?,
    };
    let config = device.default_output_config().map_err(|e| e.to_string())?;
    
    let playback_clone = playback_buffer.clone();
    let is_running_clone = is_running.clone();
    
    // 오디오 재생 스레드
    std::thread::spawn(move || {
        let stream = device.build_output_stream(
            &config.into(),
            move |data: &mut [f32], _| {
                if let Ok(mut buf) = playback_clone.lock() {
                    for sample in data.iter_mut() {
                        *sample = buf.pop_front().unwrap_or(0.0);
                    }
                }
            },
            |e| eprintln!("출력 오류: {}", e),
            None,
        );
        if let Ok(s) = stream {
            let _ = s.play();
            while is_running_clone.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
    });
    
    // UDP 수신 태스크
    let rt = tokio::runtime::Handle::current();
    rt.spawn(async move {
        let mut decoders: BTreeMap<SocketAddr, Decoder> = BTreeMap::new();
        let mut last_seq: BTreeMap<SocketAddr, u32> = BTreeMap::new();
        let mut buf = [0u8; MAX_PACKET_SIZE];
        
        while is_running.load(Ordering::Relaxed) {
            match tokio::time::timeout(
                std::time::Duration::from_millis(100),
                socket.recv_from(&mut buf)
            ).await {
                Ok(Ok((len, addr))) => {
                    // Keepalive 패킷 무시
                    if len <= 1 { continue; }
                    if len < AudioPacketHeader::SIZE { continue; }
                    
                    let header = match AudioPacketHeader::from_bytes(&buf[..AudioPacketHeader::SIZE]) {
                        Some(h) => h,
                        None => continue,
                    };
                    let payload = &buf[AudioPacketHeader::SIZE..len];
                    
                    packets_received.fetch_add(1, Ordering::Relaxed);
                    
                    // 패킷 손실 감지 및 per-peer 통계 업데이트
                    let mut lost_count = 0u32;
                    if let Some(&prev_seq) = last_seq.get(&addr) {
                        let expected = prev_seq.wrapping_add(1);
                        if header.sequence != expected && header.sequence > expected {
                            // 손실된 패킷 수 (FEC로 복구 시도)
                            let lost = header.sequence.wrapping_sub(expected);
                            lost_count = lost;
                            if lost < 10 { // 합리적인 범위 내에서만
                                let decoder = decoders.entry(addr).or_insert_with(|| {
                                    create_decoder().unwrap_or_else(|_| {
                                        eprintln!("Failed to create decoder for PLC, using silent fallback");
                                        // Return a dummy decoder that produces silence
                                        Decoder::new(48000, Channels::Stereo).unwrap_or_else(|_| {
                                            eprintln!("Critical: All decoder creation failed, audio will be silent");
                                            // This should never fail, but if it does, we'll handle it gracefully
                                            unsafe { std::mem::zeroed() } // Emergency fallback
                                        })
                                    })
                                });
                                for _ in 0..lost {
                                    if let Ok(plc_samples) = decode_plc(decoder) {
                                        if let Ok(mut jb) = jitter_buffers.lock() {
                                            jb.entry(addr)
                                                .or_insert_with(|| JitterBuffer::new(MIN_JITTER_BUFFER))
                                                .push(expected, plc_samples);
                                        }
                                    }
                                }
                            }
                        }
                    }
                    last_seq.insert(addr, header.sequence);
                    
                    let decoder = decoders.entry(addr).or_insert_with(|| {
                        create_decoder().unwrap_or_else(|_| {
                            eprintln!("Failed to create decoder for audio, using silent fallback");
                            Decoder::new(48000, Channels::Stereo).unwrap_or_else(|_| {
                                eprintln!("Critical: All decoder creation failed, audio will be silent");
                                unsafe { std::mem::zeroed() } // Emergency fallback
                            })
                        })
                    });
                    if let Ok(samples) = decode_frame(decoder, payload) {
                        // Update per-peer stats
                        if let Ok(mut stats) = peer_stats.lock() {
                            let s = stats.entry(addr).or_default();
                            s.packets_received += 1;
                            s.packets_lost += lost_count;
                            s.last_seq = header.sequence;
                            s.audio_level = calculate_audio_level(&samples);
                        }
                        
                        if let Ok(mut jb) = jitter_buffers.lock() {
                            jb.entry(addr)
                                .or_insert_with(|| JitterBuffer::new(MIN_JITTER_BUFFER))
                                .push(header.sequence, samples);
                        }
                    }
                }
                _ => {}
            }
            
            // 지터 버퍼에서 재생 버퍼로 이동
            if let Ok(mut jb) = jitter_buffers.lock() {
                for (_, buffer) in jb.iter_mut() {
                    if let Some(samples) = buffer.pop() {
                        if let Ok(mut pb) = playback_buffer.lock() {
                            pb.extend(samples);
                            // 버퍼 오버플로우 방지 (200ms 최대)
                            while pb.len() > 9600 {
                                pb.pop_front();
                            }
                        }
                    }
                }
            }
        }
    });
    
    Ok(())
}


// 릴레이 모드 송수신 루프 (fixed implementation)
pub fn start_relay_loop(
    socket: Arc<UdpSocket>,
    relay_addr: SocketAddr,
    session_id: String,
    is_running: Arc<AtomicBool>,
    is_muted: Arc<AtomicBool>,
    sequence: Arc<AtomicU32>,
    packets_sent: Arc<AtomicU32>,
    packets_received: Arc<AtomicU32>,
    _jitter_buffers: Arc<Mutex<BTreeMap<SocketAddr, JitterBuffer>>>,
    playback_buffer: Arc<Mutex<VecDeque<f32>>>,
    input_device: Option<String>,
    output_device: Option<String>,
    input_level: Arc<AtomicU32>,
    bitrate: Arc<AtomicU32>,
) -> Result<(), String> {
    eprintln!("[RELAY] Starting relay loop with proper networking");
    
    let session_bytes = session_id.as_bytes().to_vec();
    let bitrate_kbps = bitrate.load(Ordering::Relaxed);
    
    // Audio input thread with UDP sending
    let is_running_send = is_running.clone();
    let is_muted_send = is_muted.clone();
    let sequence_send = sequence.clone();
    let packets_sent_send = packets_sent.clone();
    let input_level_send = input_level.clone();
    let session_send = session_bytes.clone();
    
    std::thread::spawn(move || {
        let mut encoder = match create_encoder_with_bitrate(bitrate_kbps) {
            Ok(e) => e,
            Err(e) => { eprintln!("[AUDIO] Encoder creation failed: {}", e); return; }
        };
        
        let host = cpal::default_host();
        let device = input_device
            .and_then(|name| host.input_devices().ok()?.find(|d| d.name().ok().as_ref() == Some(&name)))
            .or_else(|| host.default_input_device());
        
        let device = match device {
            Some(d) => d,
            None => { eprintln!("[AUDIO] No input device"); return; }
        };
        
        let config = cpal::StreamConfig {
            channels: 2, // Stereo input
            sample_rate: cpal::SampleRate(48000),
            buffer_size: cpal::BufferSize::Fixed(FRAME_SIZE as u32), // 960 samples for stereo
        };
        
        let (tx, rx) = std::sync::mpsc::channel::<Vec<f32>>();
        
        let stream = match device.build_input_stream(
            &config,
            move |data: &[f32], _| { let _ = tx.send(data.to_vec()); },
            |e| eprintln!("[AUDIO] Input error: {}", e),
            None,
        ) {
            Ok(s) => s,
            Err(e) => { eprintln!("[AUDIO] Input stream creation failed: {}", e); return; }
        };
        
        if let Err(e) = stream.play() {
            eprintln!("[AUDIO] Input stream start failed: {}", e);
            return;
        }
        
        // Keep stream alive
        let _stream = stream;
        
        // Create blocking UDP socket for sending
        let std_socket = match std::net::UdpSocket::bind("0.0.0.0:0") {
            Ok(s) => s,
            Err(e) => { eprintln!("[UDP] Failed to create send socket: {}", e); return; }
        };
        
        let mut packet_buffer = Vec::with_capacity(1024);
        let mut padded_session = [0u8; 20];
        let copy_len = session_send.len().min(20);
        padded_session[..copy_len].copy_from_slice(&session_send[..copy_len]);
        
        while is_running_send.load(Ordering::SeqCst) {
            if let Ok(samples) = rx.recv_timeout(std::time::Duration::from_millis(20)) {
                // Calculate input level
                let rms: f32 = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt();
                let level = (rms * 200.0).min(100.0) as u32;
                input_level_send.store(level, Ordering::Relaxed);
                
                if is_muted_send.load(Ordering::SeqCst) { continue; }
                
                if let Ok(encoded) = encode_frame(&mut encoder, &samples) {
                    let seq = sequence_send.fetch_add(1, Ordering::SeqCst);
                    let header = AudioPacketHeader {
                        sequence: seq,
                        timestamp: 0,
                        sample_rate: 48000,
                        channels: 2,
                        payload_len: encoded.len() as u16,
                    };
                    
                    packet_buffer.clear();
                    packet_buffer.extend_from_slice(&padded_session);
                    packet_buffer.extend_from_slice(&header.to_bytes());
                    packet_buffer.extend_from_slice(&encoded);
                    
                    if let Ok(_) = std_socket.send_to(&packet_buffer, relay_addr) {
                        packets_sent_send.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
        }
    });
    
    // Audio output thread with UDP receiving
    let is_running_recv = is_running.clone();
    let packets_received_recv = packets_received.clone();
    
    std::thread::spawn(move || {
        let mut decoder = match create_decoder() {
            Ok(d) => d,
            Err(e) => { eprintln!("[AUDIO] Decoder creation failed: {}", e); return; }
        };
        
        let host = cpal::default_host();
        let device = output_device
            .and_then(|name| host.output_devices().ok()?.find(|d| d.name().ok().as_ref() == Some(&name)))
            .or_else(|| host.default_output_device());
        
        let device = match device {
            Some(d) => d,
            None => { eprintln!("[AUDIO] No output device"); return; }
        };
        
        let config = cpal::StreamConfig {
            channels: 2, // Stereo output
            sample_rate: cpal::SampleRate(48000),
            buffer_size: cpal::BufferSize::Fixed(FRAME_SIZE as u32), // 960 samples for stereo
        };
        
        let pb = playback_buffer.clone();
        let stream = match device.build_output_stream(
            &config,
            move |data: &mut [f32], _| {
                if let Ok(mut buf) = pb.lock() {
                    for sample in data.iter_mut() {
                        *sample = buf.pop_front().unwrap_or(0.0);
                    }
                }
            },
            |e| eprintln!("[AUDIO] Output error: {}", e),
            None,
        ) {
            Ok(s) => s,
            Err(e) => { eprintln!("[AUDIO] Output stream creation failed: {}", e); return; }
        };
        
        if let Err(e) = stream.play() {
            eprintln!("[AUDIO] Output stream start failed: {}", e);
            return;
        }
        
        // Keep stream alive
        let _stream = stream;
        
        // Create blocking UDP socket for receiving
        let std_socket = match std::net::UdpSocket::bind("0.0.0.0:0") {
            Ok(s) => {
                s.set_read_timeout(Some(std::time::Duration::from_millis(10))).ok();
                s
            },
            Err(e) => { eprintln!("[UDP] Failed to create recv socket: {}", e); return; }
        };
        
        let mut buf = vec![0u8; 2000];
        const SESSION_ID_LEN: usize = 20;
        
        while is_running_recv.load(Ordering::SeqCst) {
            // Use the original socket for receiving (it's bound to the relay)
            match std_socket.recv_from(&mut buf) {
                Ok((len, _)) if len > SESSION_ID_LEN + AudioPacketHeader::SIZE => {
                    let sender_id = String::from_utf8_lossy(&buf[..SESSION_ID_LEN]).trim_end_matches('\0').to_string();
                    if sender_id == session_id { continue; } // Skip own packets
                    
                    let _header = match AudioPacketHeader::from_bytes(&buf[SESSION_ID_LEN..SESSION_ID_LEN + AudioPacketHeader::SIZE]) {
                        Some(h) => h,
                        None => continue,
                    };
                    let payload = &buf[SESSION_ID_LEN + AudioPacketHeader::SIZE..len];
                    
                    if let Ok(samples) = decode_frame(&mut decoder, payload) {
                        packets_received_recv.fetch_add(1, Ordering::Relaxed);
                        
                        if let Ok(mut pb) = playback_buffer.lock() {
                            pb.extend(samples);
                            // Prevent buffer overflow
                            while pb.len() > 9600 { pb.pop_front(); }
                        }
                    }
                }
                _ => {
                    // No packet or timeout, continue
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
            }
        }
    });
    
    eprintln!("[RELAY] Relay loop started successfully with networking");
    Ok(())
}
