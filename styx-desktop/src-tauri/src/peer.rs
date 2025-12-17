// UDP P2P 오디오 피어 모듈
use opus::{Encoder, Decoder, Application, Channels};
use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;

use crate::udp::AudioPacketHeader;

const FRAME_SIZE: usize = 480; // 10ms @ 48kHz
const MAX_PACKET_SIZE: usize = 1500;
const JITTER_BUFFER_SIZE: usize = 5; // 50ms @ 10ms frames

// 지터 버퍼 - 패킷 순서 정렬 및 손실 보상
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
            // 가장 오래된 패킷 제거
            if let Some(&oldest) = self.buffer.keys().next() {
                self.buffer.remove(&oldest);
            }
        }
        self.buffer.insert(seq, samples);
    }
    
    pub fn pop(&mut self) -> Option<Vec<f32>> {
        // 다음 시퀀스 패킷이 있으면 반환
        if let Some(samples) = self.buffer.remove(&self.next_seq) {
            self.next_seq = self.next_seq.wrapping_add(1);
            return Some(samples);
        }
        // 버퍼가 충분히 차면 가장 오래된 것 반환 (손실 보상)
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
    pub tx: Option<mpsc::Sender<Vec<f32>>>,
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
            tx: None,
        }
    }
}

// Opus 인코더 생성
pub fn create_encoder() -> Result<Encoder, String> {
    Encoder::new(48000, Channels::Mono, Application::Voip)
        .map_err(|e| format!("Opus 인코더 생성 실패: {:?}", e))
}

// Opus 디코더 생성
pub fn create_decoder() -> Result<Decoder, String> {
    Decoder::new(48000, Channels::Mono)
        .map_err(|e| format!("Opus 디코더 생성 실패: {:?}", e))
}

// 오디오 프레임 인코딩
pub fn encode_frame(encoder: &mut Encoder, samples: &[f32]) -> Result<Vec<u8>, String> {
    let mut output = vec![0u8; MAX_PACKET_SIZE];
    let len = encoder.encode_float(samples, &mut output)
        .map_err(|e| format!("인코딩 실패: {:?}", e))?;
    output.truncate(len);
    Ok(output)
}

// 오디오 프레임 디코딩
pub fn decode_frame(decoder: &mut Decoder, data: &[u8]) -> Result<Vec<f32>, String> {
    let mut pcm = vec![0f32; FRAME_SIZE];
    let len = decoder.decode_float(data, &mut pcm, false)
        .map_err(|e| format!("디코딩 실패: {:?}", e))?;
    pcm.truncate(len);
    Ok(pcm)
}

// UDP로 오디오 패킷 전송
pub async fn send_audio_packet(
    socket: &UdpSocket,
    target: &SocketAddr,
    sequence: u32,
    opus_data: &[u8],
) -> Result<(), String> {
    let header = AudioPacketHeader {
        sequence,
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_micros() as u64,
        sample_rate: 48000,
        channels: 1,
        payload_len: opus_data.len() as u16,
    };
    
    let mut packet = header.to_bytes();
    packet.extend_from_slice(opus_data);
    
    socket.send_to(&packet, target).await.map_err(|e| format!("전송 실패: {}", e))?;
    Ok(())
}

// UDP에서 오디오 패킷 수신
pub async fn receive_audio_packet(
    socket: &UdpSocket,
) -> Result<(AudioPacketHeader, Vec<u8>, SocketAddr), String> {
    let mut buf = [0u8; MAX_PACKET_SIZE];
    let (len, addr) = socket.recv_from(&mut buf).await.map_err(|e| format!("수신 실패: {}", e))?;
    
    if len < AudioPacketHeader::SIZE {
        return Err("패킷이 너무 작음".to_string());
    }
    
    let header = AudioPacketHeader::from_bytes(&buf[..AudioPacketHeader::SIZE])
        .ok_or("헤더 파싱 실패")?;
    let payload = buf[AudioPacketHeader::SIZE..len].to_vec();
    
    Ok((header, payload, addr))
}

// NAT hole punching
pub async fn punch_hole(socket: &UdpSocket, target: &SocketAddr) -> Result<(), String> {
    let punch_packet = [0u8; 1];
    for _ in 0..3 {
        socket.send_to(&punch_packet, target).await.map_err(|e| format!("Hole punch 실패: {}", e))?;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Ok(())
}
