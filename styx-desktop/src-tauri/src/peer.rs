// UDP P2P 오디오 피어 모듈
use opus::{Encoder, Decoder, Application, Channels};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use tokio::net::UdpSocket;

use crate::udp::AudioPacketHeader;

const FRAME_SIZE: usize = 480; // 10ms @ 48kHz
const MAX_PACKET_SIZE: usize = 1500;

// 피어 연결 상태
pub struct PeerConnection {
    pub socket: Arc<UdpSocket>,
    pub remote_addr: Option<SocketAddr>,
    pub is_connected: Arc<AtomicBool>,
    pub is_muted: Arc<AtomicBool>,
    pub sequence: Arc<AtomicU32>,
}

impl PeerConnection {
    pub async fn new(port: u16) -> Result<Self, String> {
        let addr = format!("0.0.0.0:{}", port);
        let socket = UdpSocket::bind(&addr)
            .await
            .map_err(|e| format!("UDP 바인딩 실패: {}", e))?;
        
        Ok(Self {
            socket: Arc::new(socket),
            remote_addr: None,
            is_connected: Arc::new(AtomicBool::new(false)),
            is_muted: Arc::new(AtomicBool::new(false)),
            sequence: Arc::new(AtomicU32::new(0)),
        })
    }
    
    pub fn local_port(&self) -> Result<u16, String> {
        self.socket.local_addr()
            .map(|a| a.port())
            .map_err(|e| e.to_string())
    }
    
    pub fn set_remote(&mut self, addr: SocketAddr) {
        self.remote_addr = Some(addr);
        self.is_connected.store(true, Ordering::SeqCst);
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
    
    socket.send_to(&packet, target)
        .await
        .map_err(|e| format!("전송 실패: {}", e))?;
    
    Ok(())
}

// UDP에서 오디오 패킷 수신
pub async fn receive_audio_packet(
    socket: &UdpSocket,
) -> Result<(AudioPacketHeader, Vec<u8>, SocketAddr), String> {
    let mut buf = [0u8; MAX_PACKET_SIZE];
    let (len, addr) = socket.recv_from(&mut buf)
        .await
        .map_err(|e| format!("수신 실패: {}", e))?;
    
    if len < AudioPacketHeader::SIZE {
        return Err("패킷이 너무 작음".to_string());
    }
    
    let header = AudioPacketHeader::from_bytes(&buf[..AudioPacketHeader::SIZE])
        .ok_or("헤더 파싱 실패")?;
    
    let payload = buf[AudioPacketHeader::SIZE..len].to_vec();
    
    Ok((header, payload, addr))
}

// NAT hole punching 시도
pub async fn punch_hole(socket: &UdpSocket, target: &SocketAddr) -> Result<(), String> {
    let punch_packet = [0u8; 1];
    for _ in 0..3 {
        socket.send_to(&punch_packet, target)
            .await
            .map_err(|e| format!("Hole punch 실패: {}", e))?;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Ok(())
}
