mod audio;
mod udp;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Manager,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

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

// ===== UDP 커맨드 =====

#[tauri::command]
async fn udp_bind(port: u16) -> Result<u16, String> {
    let (_, local_port) = udp::bind_udp_socket(port).await?;
    Ok(local_port)
}

#[tauri::command]
fn get_packet_header_size() -> usize {
    udp::AudioPacketHeader::SIZE
}

// ===== 앱 실행 =====

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            // 오디오
            get_audio_devices,
            get_audio_hosts,
            check_asio,
            get_audio_info,
            // UDP
            udp_bind,
            get_packet_header_size,
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
                    if let TrayIconEvent::Click { .. } = event {
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
