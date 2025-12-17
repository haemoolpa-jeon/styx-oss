mod audio;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Manager,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

// Tauri 커맨드: 오디오 장치 목록
#[tauri::command]
fn get_audio_devices() -> Vec<audio::AudioDevice> {
    audio::list_audio_devices()
}

// Tauri 커맨드: 오디오 호스트 목록
#[tauri::command]
fn get_audio_hosts() -> Vec<String> {
    audio::list_audio_hosts()
}

// Tauri 커맨드: ASIO 사용 가능 여부
#[tauri::command]
fn check_asio() -> bool {
    audio::is_asio_available()
}

// Tauri 커맨드: 전체 오디오 정보
#[tauri::command]
fn get_audio_info() -> audio::AudioInfo {
    audio::get_audio_info()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_audio_devices,
            get_audio_hosts,
            check_asio,
            get_audio_info
        ])
        .setup(|app| {
            // 로깅 (디버그 모드)
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // 시스템 트레이 메뉴
            let show = MenuItem::with_id(app, "show", "열기", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            // 트레이 아이콘
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
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { .. } = event {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // 글로벌 단축키: Ctrl+Shift+M (음소거 토글)
            let shortcut_mute = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyM);
            app.global_shortcut().on_shortcut(shortcut_mute, |app, _shortcut, _event| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval("document.getElementById('muteBtn')?.click()");
                }
            })?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // 창 닫기 시 트레이로 최소화
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
