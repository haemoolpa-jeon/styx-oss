#![allow(dead_code)]
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::time::Duration;
use tokio::net::UdpSocket;
use tokio::time::timeout;

// 오디오 패킷 헤더
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioPacketHeader {
    pub sequence: u32,      // 시퀀스 번호
    pub timestamp: u64,     // 타임스탬프 (마이크로초)
    pub sample_rate: u32,   // 샘플레이트
    pub channels: u8,       // 채널 수
    pub payload_len: u16,   // 페이로드 길이
}

impl AudioPacketHeader {
    pub const SIZE: usize = 19; // 4 + 8 + 4 + 1 + 2
    
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(Self::SIZE);
        buf.extend_from_slice(&self.sequence.to_be_bytes());
        buf.extend_from_slice(&self.timestamp.to_be_bytes());
        buf.extend_from_slice(&self.sample_rate.to_be_bytes());
        buf.push(self.channels);
        buf.extend_from_slice(&self.payload_len.to_be_bytes());
        buf
    }
    
    pub fn from_bytes(data: &[u8]) -> Option<Self> {
        if data.len() < Self::SIZE {
            return None;
        }
        Some(Self {
            sequence: u32::from_be_bytes([data[0], data[1], data[2], data[3]]),
            timestamp: u64::from_be_bytes([
                data[4], data[5], data[6], data[7],
                data[8], data[9], data[10], data[11]
            ]),
            sample_rate: u32::from_be_bytes([data[12], data[13], data[14], data[15]]),
            channels: data[16],
            payload_len: u16::from_be_bytes([data[17], data[18]]),
        })
    }
}

// UDP 연결 정보
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UdpConnectionInfo {
    pub local_port: u16,
    pub remote_addr: Option<String>,
    pub is_connected: bool,
}

// UDP 소켓 바인딩 with QoS (DSCP EF for real-time audio)
pub async fn bind_udp_socket(port: u16) -> Result<(UdpSocket, u16), String> {
    use socket2::{Socket, Domain, Type, Protocol};
    use std::net::SocketAddr as StdSocketAddr;
    
    // Create socket with socket2 for QoS options
    let socket2 = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))
        .map_err(|e| format!("소켓 생성 실패: {}", e))?;
    
    // Set DSCP EF (Expedited Forwarding) = 46 << 2 = 184 for real-time audio
    // This tells routers to prioritize this traffic
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawSocket;
        let tos: i32 = 184; // DSCP EF (46) << 2
        let raw = socket2.as_raw_socket();
        let _ = libc_setsockopt(raw as usize, 0, 3, &tos); // IPPROTO_IP=0, IP_TOS=3
    }
    
    #[cfg(not(windows))]
    {
        let _ = socket2.set_tos(184); // DSCP EF
    }
    
    // Bind to address
    let addr: StdSocketAddr = match format!("0.0.0.0:{}", port).parse() {
        Ok(a) => a,
        Err(e) => return Err(format!("주소 파싱 실패: {}", e)),
    };
    socket2.bind(&addr.into())
        .map_err(|e| format!("UDP 바인딩 실패: {}", e))?;
    socket2.set_nonblocking(true)
        .map_err(|e| format!("논블로킹 설정 실패: {}", e))?;
    
    let local_addr = socket2.local_addr()
        .map_err(|e| format!("로컬 주소 가져오기 실패: {}", e))?;
    let local_port = local_addr.as_socket().map(|a| a.port()).unwrap_or(0);
    
    // Convert to tokio socket
    let std_socket: std::net::UdpSocket = socket2.into();
    let socket = UdpSocket::from_std(std_socket)
        .map_err(|e| format!("Tokio 소켓 변환 실패: {}", e))?;
    
    Ok((socket, local_port))
}

// Windows-specific setsockopt (minimal, no libc dependency)
#[cfg(windows)]
fn libc_setsockopt(socket: usize, level: i32, optname: i32, optval: &i32) -> i32 {
    #[link(name = "ws2_32")]
    extern "system" {
        fn setsockopt(s: usize, level: i32, optname: i32, optval: *const i8, optlen: i32) -> i32;
    }
    unsafe {
        setsockopt(socket, level, optname, optval as *const i32 as *const i8, 4)
    }
}

// 패킷 전송
pub async fn send_audio_packet(
    socket: &UdpSocket,
    target: &SocketAddr,
    sequence: u32,
    audio_data: &[u8],
) -> Result<(), String> {
    let header = AudioPacketHeader {
        sequence,
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_micros() as u64,
        sample_rate: 48000,
        channels: 2,
        payload_len: audio_data.len() as u16,
    };
    
    let mut packet = header.to_bytes();
    packet.extend_from_slice(audio_data);
    
    socket.send_to(&packet, target)
        .await
        .map_err(|e| format!("전송 실패: {}", e))?;
    
    Ok(())
}

// 패킷 수신
pub async fn receive_audio_packet(
    socket: &UdpSocket,
    buf: &mut [u8],
) -> Result<(AudioPacketHeader, Vec<u8>, SocketAddr), String> {
    let (len, addr) = socket.recv_from(buf)
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

// NAT hole punching을 위한 STUN 요청
pub async fn get_public_addr(socket: &UdpSocket) -> Result<SocketAddr, String> {
    // Google STUN 서버
    let stun_server: SocketAddr = "74.125.250.129:19302".parse()
        .map_err(|_| "STUN 서버 주소 파싱 실패")?;
    
    // STUN Binding Request
    let binding_request: [u8; 20] = [
        0x00, 0x01, // Binding Request
        0x00, 0x00, // Message Length
        0x21, 0x12, 0xa4, 0x42, // Magic Cookie
        // Transaction ID (12 bytes)
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
        0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
    ];
    
    socket.send_to(&binding_request, stun_server)
        .await
        .map_err(|e| format!("STUN 요청 실패: {}", e))?;
    
    let mut buf = [0u8; 256];
    let recv_result = timeout(
        Duration::from_secs(3),
        socket.recv_from(&mut buf)
    ).await;
    
    let (len, _) = match recv_result {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => return Err(format!("STUN 응답 수신 실패: {}", e)),
        Err(_) => return Err("STUN 응답 타임아웃".to_string()),
    };
    
    if len < 20 {
        return Err("STUN 응답이 너무 짧음".to_string());
    }
    
    // STUN 응답 파싱 - XOR-MAPPED-ADDRESS 또는 MAPPED-ADDRESS 찾기
    let mut offset = 20; // 헤더 이후부터
    while offset + 4 <= len {
        let attr_type = u16::from_be_bytes([buf[offset], buf[offset + 1]]);
        let attr_len = u16::from_be_bytes([buf[offset + 2], buf[offset + 3]]) as usize;
        offset += 4;
        
        if offset + attr_len > len { break; }
        
        // XOR-MAPPED-ADDRESS (0x0020) 또는 MAPPED-ADDRESS (0x0001)
        if attr_type == 0x0020 && attr_len >= 8 {
            // XOR-MAPPED-ADDRESS
            let family = buf[offset + 1];
            if family == 0x01 { // IPv4
                let port = u16::from_be_bytes([buf[offset + 2], buf[offset + 3]]) ^ 0x2112;
                let ip = [
                    buf[offset + 4] ^ 0x21,
                    buf[offset + 5] ^ 0x12,
                    buf[offset + 6] ^ 0xa4,
                    buf[offset + 7] ^ 0x42,
                ];
                let addr = SocketAddr::from((ip, port));
                return Ok(addr);
            }
        } else if attr_type == 0x0001 && attr_len >= 8 {
            // MAPPED-ADDRESS (fallback)
            let family = buf[offset + 1];
            if family == 0x01 { // IPv4
                let port = u16::from_be_bytes([buf[offset + 2], buf[offset + 3]]);
                let ip = [buf[offset + 4], buf[offset + 5], buf[offset + 6], buf[offset + 7]];
                let addr = SocketAddr::from((ip, port));
                return Ok(addr);
            }
        }
        
        offset += attr_len;
        // 4바이트 정렬
        if attr_len % 4 != 0 {
            offset += 4 - (attr_len % 4);
        }
    }
    
    Err("STUN 응답에서 주소를 찾을 수 없음".to_string())
}
