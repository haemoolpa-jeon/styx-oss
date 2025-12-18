mod audio;
mod udp;
mod stream;
mod peer;

use std::sync::Mutex;
use std::sync::atomic::Ordering;
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
    *state.udp_port.lock().unwrap() = Some(local_port);
    state.udp_stream.lock().unwrap().socket = Some(std::sync::Arc::new(socket));
    Ok(local_port)
}

#[tauri::command]
fn get_packet_header_size() -> usize {
    udp::AudioPacketHeader::SIZE
}

#[tauri::command]
fn get_udp_port(state: State<'_, AppState>) -> Option<u16> {
    *state.udp_port.lock().unwrap()
}

#[tauri::command]
async fn get_public_ip(state: State<'_, AppState>) -> Result<String, String> {
    let socket = {
        let stream_state = state.udp_stream.lock().unwrap();
        stream_state.socket.clone().ok_or("소켓 없음".to_string())?
    };
    
    let addr = udp::get_public_addr(&socket).await?;
    Ok(addr.to_string())
}

#[tauri::command]
fn udp_add_peer(addr: String, state: State<'_, AppState>) -> Result<(), String> {
    let socket_addr: std::net::SocketAddr = addr.parse().map_err(|e| format!("주소 파싱 실패: {}", e))?;
    state.udp_stream.lock().unwrap().peers.push(socket_addr);
    Ok(())
}

#[tauri::command]
fn udp_set_muted(muted: bool, state: State<'_, AppState>) {
    state.udp_stream.lock().unwrap().is_muted.store(muted, Ordering::SeqCst);
}

#[tauri::command]
fn udp_is_running(state: State<'_, AppState>) -> bool {
    state.udp_stream.lock().unwrap().is_running.load(Ordering::SeqCst)
}

#[tauri::command]
fn set_audio_devices(input: Option<String>, output: Option<String>, state: State<'_, AppState>) {
    let mut stream_state = state.udp_stream.lock().unwrap();
    stream_state.input_device = input;
    stream_state.output_device = output;
}

#[tauri::command]
fn udp_clear_peers(state: State<'_, AppState>) {
    state.udp_stream.lock().unwrap().peers.clear();
}

#[tauri::command]
fn udp_start_stream(state: State<'_, AppState>) -> Result<(), String> {
    let stream_state = state.udp_stream.lock().unwrap();
    
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
        output_device,
    )?;
    
    Ok(())
}

#[tauri::command]
fn udp_stop_stream(state: State<'_, AppState>) {
    let stream_state = state.udp_stream.lock().unwrap();
    stream_state.is_running.store(false, Ordering::SeqCst);
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
    
    let jitter_size = stream_state.jitter_buffers.lock()
        .map(|jb| jb.values().map(|b| b.len()).sum())
        .unwrap_or(0);
    
    UdpStats {
        packets_sent: sent,
        packets_received: received,
        packets_lost: lost,
        loss_rate,
        peer_count: stream_state.peers.len(),
        is_running: stream_state.is_running.load(Ordering::Relaxed),
        jitter_buffer_size: jitter_size,
    }
}

// ===== 앱 실행 =====

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState {
            udp_port: Mutex::new(None),
            udp_stream: Mutex::new(peer::UdpStreamState::default()),
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
            set_audio_devices,
            udp_start_stream,
            udp_stop_stream,
            get_udp_stats,
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
