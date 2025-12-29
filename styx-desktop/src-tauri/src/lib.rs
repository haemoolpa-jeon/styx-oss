mod audio;
mod udp;
mod stream;
mod peer;

use std::sync::Mutex;
use std::sync::atomic::Ordering;
use std::collections::VecDeque;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Manager, State,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

// 앱 상태
struct AppState {
    udp_port: Mutex<Option<u16>>,
    udp_stream: Mutex<peer::UdpStreamState>,
    // TCP fallback buffers
    tcp_send_buffer: Mutex<VecDeque<Vec<u8>>>,
    tcp_recv_buffer: Mutex<VecDeque<Vec<u8>>>,
}

// ===== 오디오 커맨드 =====

#[tauri::command]
fn get_audio_devices() -> Vec<audio::AudioDevice> {
    audio::list_audio_devices()
}

#[tauri::command]
fn get_audio_hosts() -> Vec<String> {
    audio::list_audio_hosts()
}

#[tauri::command]
fn check_asio() -> bool {
    audio::is_asio_available()
}

#[tauri::command]
fn get_audio_info() -> audio::AudioInfo {
    audio::get_audio_info()
}

#[tauri::command]
fn test_audio() -> Result<String, String> {
    audio::test_audio_loopback()
}

#[tauri::command]
fn get_sample_rates(device_name: Option<String>, is_input: bool) -> Vec<u32> {
    audio::get_supported_sample_rates(device_name, is_input)
}

// ===== UDP 커맨드 =====

#[tauri::command]
async fn udp_bind(port: u16, state: State<'_, AppState>) -> Result<u16, String> {
    let (socket, local_port) = udp::bind_udp_socket(port).await?;
    
    // Use proper error handling for mutex locks
    match state.udp_port.lock() {
        Ok(mut port_guard) => *port_guard = Some(local_port),
        Err(_) => return Err("UDP 포트 상태 잠금 실패".to_string()),
    }
    
    match state.udp_stream.lock() {
        Ok(mut stream_guard) => stream_guard.socket = Some(std::sync::Arc::new(socket)),
        Err(_) => return Err("UDP 스트림 상태 잠금 실패".to_string()),
    }
    
    Ok(local_port)
}

#[tauri::command]
fn get_packet_header_size() -> usize {
    udp::AudioPacketHeader::SIZE
}

#[tauri::command]
fn get_udp_port(state: State<'_, AppState>) -> Option<u16> {
    state.udp_port.lock().map(|port| *port).unwrap_or(None)
}

#[tauri::command]
async fn get_public_ip(state: State<'_, AppState>) -> Result<String, String> {
    let socket = {
        let stream_state = state.udp_stream.lock().map_err(|_| "스트림 상태 잠금 실패".to_string())?;
        stream_state.socket.clone().ok_or("소켓 없음".to_string())?
    };
    
    let addr = udp::get_public_addr(&socket).await?;
    Ok(addr.to_string())
}

#[tauri::command]
fn udp_add_peer(addr: String, state: State<'_, AppState>) -> Result<(), String> {
    let socket_addr: std::net::SocketAddr = addr.parse().map_err(|e| format!("주소 파싱 실패: {}", e))?;
    state.udp_stream.lock()
        .map_err(|_| "스트림 상태 잠금 실패".to_string())?
        .peers.push(socket_addr);
    Ok(())
}

#[tauri::command]
fn udp_set_muted(muted: bool, state: State<'_, AppState>) -> Result<(), String> {
    state.udp_stream.lock()
        .map_err(|_| "스트림 상태 잠금 실패".to_string())?
        .is_muted.store(muted, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
fn udp_is_running(state: State<'_, AppState>) -> bool {
    state.udp_stream.lock()
        .map(|s| s.is_running.load(Ordering::SeqCst))
        .unwrap_or(false)
}

#[tauri::command]
fn set_audio_devices(input: Option<String>, output: Option<String>, state: State<'_, AppState>) -> Result<(), String> {
    let mut stream_state = state.udp_stream.lock().map_err(|_| "스트림 상태 잠금 실패".to_string())?;
    stream_state.input_device = input;
    stream_state.output_device = output;
    Ok(())
}

#[tauri::command]
fn udp_clear_peers(state: State<'_, AppState>) -> Result<(), String> {
    state.udp_stream.lock()
        .map_err(|_| "스트림 상태 잠금 실패".to_string())?
        .peers.clear();
    Ok(())
}

#[tauri::command]
fn set_jitter_buffer(state: State<'_, AppState>, size: usize) -> Result<(), String> {
    let stream_state = state.udp_stream.lock().map_err(|_| "스트림 상태 잠금 실패".to_string())?;
    let jitter_buffers = stream_state.jitter_buffers.clone();
    drop(stream_state);
    
    if let Ok(mut jb) = jitter_buffers.lock() {
        for buffer in jb.values_mut() {
            buffer.set_target(size.max(2).min(15)); // 20ms - 150ms
        }
    }
    Ok(())
}

#[tauri::command]
fn udp_start_stream(state: State<'_, AppState>) -> Result<(), String> {
    let stream_state = state.udp_stream.lock().map_err(|_| "스트림 상태 잠금 실패".to_string())?;
    
    if stream_state.is_running.load(Ordering::SeqCst) {
        return Err("이미 실행 중".to_string());
    }
    
    let socket = stream_state.socket.clone().ok_or("소켓 없음")?;
    let peers = stream_state.peers.clone();
    let input_device = stream_state.input_device.clone();
    let output_device = stream_state.output_device.clone();
    
    if peers.is_empty() {
        return Err("피어 없음".to_string());
    }
    
    stream_state.is_running.store(true, Ordering::SeqCst);
    
    // 송신 루프 시작
    peer::start_send_loop(
        socket.clone(),
        peers,
        stream_state.is_running.clone(),
        stream_state.is_muted.clone(),
        stream_state.sequence.clone(),
        stream_state.packets_sent.clone(),
        input_device,
    )?;
    
    // 수신 루프 시작
    peer::start_recv_loop(
        socket,
        stream_state.is_running.clone(),
        stream_state.jitter_buffers.clone(),
        stream_state.playback_buffer.clone(),
        stream_state.packets_received.clone(),
        stream_state.peer_stats.clone(),
        output_device,
    )?;
    
    Ok(())
}

#[tauri::command]
fn udp_stop_stream(state: State<'_, AppState>) -> Result<(), String> {
    let mut stream_state = state.udp_stream.lock().map_err(|_| "스트림 상태 잠금 실패".to_string())?;
    stream_state.is_running.store(false, Ordering::SeqCst);
    // Clear buffers and reset state for clean restart
    if let Ok(mut jb) = stream_state.jitter_buffers.lock() { jb.clear(); }
    if let Ok(mut pb) = stream_state.playback_buffer.lock() { pb.clear(); }
    stream_state.packets_sent.store(0, Ordering::Relaxed);
    stream_state.packets_received.store(0, Ordering::Relaxed);
    stream_state.socket = None; // Release socket for rebind
    Ok(())
}

#[tauri::command]
fn udp_set_relay(host: String, port: u16, session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let addr: std::net::SocketAddr = format!("{}:{}", host, port)
        .parse()
        .map_err(|e| format!("릴레이 주소 파싱 실패: {}", e))?;
    let mut stream_state = state.udp_stream.lock().unwrap();
    stream_state.relay_addr = Some(addr);
    stream_state.session_id = Some(session_id);
    Ok(())
}

#[tauri::command]
fn udp_start_relay_stream(state: State<'_, AppState>) -> Result<(), String> {
    let stream_state = state.udp_stream.lock().unwrap();
    
    if stream_state.is_running.load(Ordering::SeqCst) {
        return Err("이미 실행 중".to_string());
    }
    
    let socket = stream_state.socket.clone().ok_or("소켓 없음")?;
    let relay_addr = stream_state.relay_addr.ok_or("릴레이 주소 없음")?;
    let session_id = stream_state.session_id.clone().ok_or("세션 ID 없음")?;
    let input_device = stream_state.input_device.clone();
    let output_device = stream_state.output_device.clone();
    
    stream_state.is_running.store(true, Ordering::SeqCst);
    
    // 릴레이 모드 송수신 시작
    peer::start_relay_loop(
        socket,
        relay_addr,
        session_id,
        stream_state.is_running.clone(),
        stream_state.is_muted.clone(),
        stream_state.sequence.clone(),
        stream_state.packets_sent.clone(),
        stream_state.packets_received.clone(),
        stream_state.jitter_buffers.clone(),
        stream_state.playback_buffer.clone(),
        input_device,
        output_device,
        stream_state.input_level.clone(),
        stream_state.bitrate.clone(),
    )?;
    
    Ok(())
}

// ===== Latency Measurement =====

#[tauri::command]
async fn measure_relay_latency(state: State<'_, AppState>) -> Result<u32, String> {
    let relay_addr = {
        let stream_state = state.udp_stream.lock().map_err(|_| "Lock failed")?;
        stream_state.relay_addr.ok_or("No relay address")?
    };
    
    // Create temporary socket for ping
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    socket.set_read_timeout(Some(std::time::Duration::from_secs(2))).ok();
    
    // Send ping with timestamp: 'P' + 8-byte timestamp (ms)
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    
    let mut ping = vec![0u8; 9];
    ping[0] = 0x50; // 'P'
    ping[1..9].copy_from_slice(&now.to_be_bytes());
    
    socket.send_to(&ping, relay_addr).map_err(|e| e.to_string())?;
    
    // Wait for pong
    let mut buf = [0u8; 9];
    let (len, _) = socket.recv_from(&mut buf).map_err(|e| e.to_string())?;
    
    if len == 9 && buf[0] == 0x4F {
        let sent_time = u64::from_be_bytes([buf[1], buf[2], buf[3], buf[4], buf[5], buf[6], buf[7], buf[8]]);
        let recv_time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        Ok((recv_time - sent_time) as u32)
    } else {
        Err("Invalid pong response".to_string())
    }
}

// ===== NAT Detection =====

#[derive(serde::Serialize)]
struct NatInfo {
    nat_type: String,
    public_addr: String,
}

#[tauri::command]
async fn detect_nat() -> Result<NatInfo, String> {
    let (nat_type, public_addr) = udp::detect_nat_type(0).await?;
    Ok(NatInfo {
        nat_type: format!("{:?}", nat_type),
        public_addr: public_addr.to_string(),
    })
}

#[tauri::command]
async fn attempt_p2p(peer_addr: String, state: State<'_, AppState>) -> Result<bool, String> {
    let peer: std::net::SocketAddr = peer_addr.parse().map_err(|e| format!("Invalid address: {}", e))?;
    
    // Create a new socket for P2P attempt
    let socket = tokio::net::UdpSocket::bind("0.0.0.0:0").await.map_err(|e| e.to_string())?;
    
    let success = udp::hole_punch(&socket, peer).await?;
    
    if success {
        // Store P2P peer address
        let mut stream_state = state.udp_stream.lock().map_err(|_| "Lock failed")?;
        if !stream_state.peers.contains(&peer) {
            stream_state.peers.push(peer);
        }
    }
    
    Ok(success)
}

// ===== Bitrate Control =====

#[tauri::command]
fn set_bitrate(bitrate_kbps: u32, state: State<'_, AppState>) {
    let clamped = bitrate_kbps.max(16).min(256); // 16-256 kbps
    state.udp_stream.lock().unwrap().bitrate.store(clamped, Ordering::SeqCst);
}

#[tauri::command]
fn get_bitrate(state: State<'_, AppState>) -> u32 {
    state.udp_stream.lock().unwrap().bitrate.load(Ordering::Relaxed)
}

// ===== TCP Fallback Commands =====

#[tauri::command]
fn tcp_receive_audio(_sender_id: String, data: Vec<u8>, state: State<'_, AppState>) -> Result<(), String> {
    if let Ok(mut buf) = state.tcp_recv_buffer.lock() {
        buf.push_back(data);
        // Limit buffer size to prevent memory growth
        while buf.len() > 100 { buf.pop_front(); }
        Ok(())
    } else {
        Err("TCP 수신 버퍼 잠금 실패".to_string())
    }
}

#[tauri::command]
fn tcp_get_audio(state: State<'_, AppState>) -> Vec<u8> {
    // Return encoded audio from send buffer (captured by audio input)
    if let Ok(mut buf) = state.tcp_send_buffer.lock() {
        buf.pop_front().unwrap_or_default()
    } else {
        Vec::new()
    }
}

#[tauri::command]
fn get_input_level(state: State<'_, AppState>) -> u32 {
    state.udp_stream.lock()
        .map(|s| s.input_level.load(Ordering::Relaxed))
        .unwrap_or(0)
}

#[derive(serde::Serialize)]
struct UdpStats {
    packets_sent: u32,
    packets_received: u32,
    packets_lost: u32,
    loss_rate: f32,
    peer_count: usize,
    is_running: bool,
    jitter_buffer_size: usize,
    jitter_buffer_target: usize,
}

#[tauri::command]
fn get_udp_stats(state: State<'_, AppState>) -> UdpStats {
    let stream_state = state.udp_stream.lock().unwrap();
    let sent = stream_state.packets_sent.load(Ordering::Relaxed);
    let received = stream_state.packets_received.load(Ordering::Relaxed);
    let lost = stream_state.packets_lost.load(Ordering::Relaxed);
    let loss_rate = if received + lost > 0 {
        lost as f32 / (received + lost) as f32 * 100.0
    } else {
        0.0
    };
    
    let (jitter_size, jitter_target) = stream_state.jitter_buffers.lock()
        .map(|jb| {
            let size: usize = jb.values().map(|b| b.len()).sum();
            let target: usize = jb.values().map(|b| b.target_size()).sum();
            (size, target)
        })
        .unwrap_or((0, 0));
    
    UdpStats {
        packets_sent: sent,
        packets_received: received,
        packets_lost: lost,
        loss_rate,
        peer_count: stream_state.peers.len(),
        is_running: stream_state.is_running.load(Ordering::Relaxed),
        jitter_buffer_size: jitter_size,
        jitter_buffer_target: jitter_target,
    }
}

#[derive(serde::Serialize)]
struct PeerStatsResponse {
    addr: String,
    packets_received: u32,
    packets_lost: u32,
    loss_rate: f32,
    audio_level: f32,
}

#[tauri::command]
fn get_peer_stats(state: State<'_, AppState>) -> Vec<PeerStatsResponse> {
    let stream_state = state.udp_stream.lock().unwrap();
    stream_state.peer_stats.lock()
        .map(|stats| {
            stats.iter().map(|(addr, s)| {
                let total = s.packets_received + s.packets_lost;
                PeerStatsResponse {
                    addr: addr.to_string(),
                    packets_received: s.packets_received,
                    packets_lost: s.packets_lost,
                    loss_rate: if total > 0 { s.packets_lost as f32 / total as f32 * 100.0 } else { 0.0 },
                    audio_level: s.audio_level,
                }
            }).collect()
        })
        .unwrap_or_default()
}

// ===== Firewall Setup =====

#[tauri::command]
fn setup_firewall() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        
        let exe_path = std::env::current_exe()
            .map_err(|e| e.to_string())?;
        
        let output = Command::new("netsh")
            .args(["advfirewall", "firewall", "add", "rule", 
                   "name=Styx UDP", "dir=in", "action=allow", 
                   "protocol=UDP", "localport=10000-65535",
                   &format!("program={}", exe_path.display())])
            .output();
        
        match output {
            Ok(o) if o.status.success() => Ok("Firewall configured".to_string()),
            Ok(o) => Err(String::from_utf8_lossy(&o.stderr).to_string()),
            Err(e) => Err(e.to_string()),
        }
    }
    
    #[cfg(not(target_os = "windows"))]
    Ok("Not required on this platform".to_string())
}

// ===== 앱 실행 =====

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState {
            udp_port: Mutex::new(None),
            udp_stream: Mutex::new(peer::UdpStreamState::default()),
            tcp_send_buffer: Mutex::new(VecDeque::new()),
            tcp_recv_buffer: Mutex::new(VecDeque::new()),
        })
        .invoke_handler(tauri::generate_handler![
            // 오디오
            get_audio_devices,
            get_audio_hosts,
            check_asio,
            get_audio_info,
            test_audio,
            get_sample_rates,
            // UDP
            udp_bind,
            get_packet_header_size,
            get_udp_port,
            get_public_ip,
            udp_add_peer,
            udp_set_muted,
            udp_is_running,
            udp_clear_peers,
            set_jitter_buffer,
            set_audio_devices,
            udp_start_stream,
            udp_stop_stream,
            udp_set_relay,
            udp_start_relay_stream,
            get_udp_stats,
            get_peer_stats,
            setup_firewall,
            measure_relay_latency,
            detect_nat,
            attempt_p2p,
            // TCP fallback
            tcp_receive_audio,
            tcp_get_audio,
            // Audio level & bitrate
            get_input_level,
            set_bitrate,
            get_bitrate,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // 시스템 트레이
            let show = MenuItem::with_id(app, "show", "열기", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("Styx - HADES Audio")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // 글로벌 단축키: Ctrl+Shift+M
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyM);
            app.global_shortcut().on_shortcut(shortcut, |app, _, _| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval("document.getElementById('muteBtn')?.click()");
                }
            })?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
