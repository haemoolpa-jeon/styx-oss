// UDP P2P 오디오 피어 모듈
use opus::{Encoder, Decoder, Application, Channels};
use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use crate::udp::AudioPacketHeader;

const FRAME_SIZE: usize = 480; // 10ms @ 48kHz
const MAX_PACKET_SIZE: usize = 1500;
const JITTER_BUFFER_SIZE: usize = 5; // 50ms @ 10ms frames

// 지터 버퍼
pub struct JitterBuffer {
    buffer: BTreeMap<u32, Vec<f32>>,
    next_seq: u32,
    max_size: usize,
}

impl JitterBuffer {
    pub fn new(max_size: usize) -> Self {
        Self { buffer: BTreeMap::new(), next_seq: 0, max_size }
    }
    
    pub fn push(&mut self, seq: u32, samples: Vec<f32>) {
        if self.buffer.len() >= self.max_size {
            if let Some(&oldest) = self.buffer.keys().next() {
                self.buffer.remove(&oldest);
            }
        }
        self.buffer.insert(seq, samples);
    }
    
    pub fn pop(&mut self) -> Option<Vec<f32>> {
        if let Some(samples) = self.buffer.remove(&self.next_seq) {
            self.next_seq = self.next_seq.wrapping_add(1);
            return Some(samples);
        }
        if self.buffer.len() >= self.max_size / 2 {
            if let Some(&seq) = self.buffer.keys().next() {
                self.next_seq = seq.wrapping_add(1);
                return self.buffer.remove(&seq);
            }
        }
        None
    }
}

// UDP 스트림 상태
pub struct UdpStreamState {
    pub socket: Option<Arc<UdpSocket>>,
    pub peers: Vec<SocketAddr>,
    pub is_running: Arc<AtomicBool>,
    pub is_muted: Arc<AtomicBool>,
    pub sequence: Arc<AtomicU32>,
    pub jitter_buffers: Arc<Mutex<BTreeMap<SocketAddr, JitterBuffer>>>,
    pub playback_buffer: Arc<Mutex<Vec<f32>>>,
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
            playback_buffer: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

// Opus 인코더/디코더 생성
pub fn create_encoder() -> Result<Encoder, String> {
    Encoder::new(48000, Channels::Mono, Application::Voip)
        .map_err(|e| format!("Opus 인코더 생성 실패: {:?}", e))
}

pub fn create_decoder() -> Result<Decoder, String> {
    Decoder::new(48000, Channels::Mono)
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
    let mut pcm = vec![0f32; FRAME_SIZE];
    let len = decoder.decode_float(data, &mut pcm, false)
        .map_err(|e| format!("디코딩 실패: {:?}", e))?;
    pcm.truncate(len);
    Ok(pcm)
}

// UDP 오디오 전송 루프 시작
pub fn start_send_loop(
    socket: Arc<UdpSocket>,
    peers: Vec<SocketAddr>,
    is_running: Arc<AtomicBool>,
    is_muted: Arc<AtomicBool>,
    sequence: Arc<AtomicU32>,
) -> Result<(), String> {
    let host = cpal::default_host();
    let device = host.default_input_device().ok_or("입력 장치 없음")?;
    let config = device.default_input_config().map_err(|e| e.to_string())?;
    
    let (tx, mut rx) = mpsc::channel::<Vec<f32>>(32);
    let is_running_clone = is_running.clone();
    let is_muted_clone = is_muted.clone();
    
    // 오디오 캡처 스레드
    std::thread::spawn(move || {
        let stream = device.build_input_stream(
            &config.into(),
            move |data: &[f32], _| {
                if !is_muted_clone.load(Ordering::Relaxed) && is_running_clone.load(Ordering::Relaxed) {
                    let _ = tx.blocking_send(data.to_vec());
                }
            },
            |e| eprintln!("입력 오류: {}", e),
            None,
        );
        if let Ok(s) = stream {
            let _ = s.play();
            while is_running.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
    });
    
    // UDP 전송 태스크
    let rt = tokio::runtime::Handle::current();
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
                        channels: 1,
                        payload_len: opus_data.len() as u16,
                    };
                    let mut packet = header.to_bytes();
                    packet.extend(&opus_data);
                    
                    for peer in &peers {
                        let _ = socket.send_to(&packet, peer).await;
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
    playback_buffer: Arc<Mutex<Vec<f32>>>,
) -> Result<(), String> {
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or("출력 장치 없음")?;
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
                        *sample = if buf.is_empty() { 0.0 } else { buf.remove(0) };
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
        let mut buf = [0u8; MAX_PACKET_SIZE];
        
        while is_running.load(Ordering::Relaxed) {
            match tokio::time::timeout(
                std::time::Duration::from_millis(100),
                socket.recv_from(&mut buf)
            ).await {
                Ok(Ok((len, addr))) => {
                    if len < AudioPacketHeader::SIZE { continue; }
                    
                    let header = match AudioPacketHeader::from_bytes(&buf[..AudioPacketHeader::SIZE]) {
                        Some(h) => h,
                        None => continue,
                    };
                    let payload = &buf[AudioPacketHeader::SIZE..len];
                    
                    let decoder = decoders.entry(addr).or_insert_with(|| create_decoder().unwrap());
                    if let Ok(samples) = decode_frame(decoder, payload) {
                        if let Ok(mut jb) = jitter_buffers.lock() {
                            jb.entry(addr).or_insert_with(|| JitterBuffer::new(JITTER_BUFFER_SIZE))
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
                            let len = pb.len();
                            if len > 9600 { pb.drain(0..len - 9600); }
                        }
                    }
                }
            }
        }
    });
    
    Ok(())
}
