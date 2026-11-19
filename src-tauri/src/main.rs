#![windows_subsystem = "windows"]

mod scheduler;
mod store_io;
mod win32;
mod windows;

use serde_json::json;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, WebviewUrl, WebviewWindowBuilder};

const READY_HANDLES: u8 = 1 << 0;
const READY_PANEL: u8 = 1 << 1;
const READY_BOTH: u8 = READY_HANDLES | READY_PANEL;
static READY_MASK: AtomicU8 = AtomicU8::new(0);

fn window_ready_bit(label: &str) -> u8 {
    match label {
        "handles" => READY_HANDLES,
        "panel" => READY_PANEL,
        _ => 0,
    }
}

/// 프런트엔드(handles/panel)가 boot 리스너 등록을 마쳤을 때 호출한다.
/// --selftest / --demo 시작 시 부팅 emit 유실 레이스를 없애기 위한 핸드셰이크.
#[tauri::command]
fn window_ready(window: tauri::Window) {
    let bit = window_ready_bit(window.label());
    if bit != 0 {
        READY_MASK.fetch_or(bit, Ordering::Release);
    }
}

fn qa_write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub(crate) fn qa_write(msg: &str) {
    use std::io::Write;
    let _guard = qa_write_lock().lock().unwrap_or_else(|e| e.into_inner());
    let line = format!("[QA] {}\n", msg);
    let path = std::env::temp_dir().join("guseok-qa.log");
    for attempt in 0..4 {
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = f.write_all(line.as_bytes());
            return;
        }
        if attempt < 3 {
            std::thread::sleep(Duration::from_millis(15));
        }
    }
}

#[tauri::command]
fn qa_log(msg: String) {
    qa_write(&msg);
}

/// selftest가 CDP 없이 스케줄러 발화 라인을 읽을 수 있게 qa 로그 경로를 반환한다.
#[tauri::command]
fn qa_log_path() -> String {
    std::env::temp_dir()
        .join("guseok-qa.log")
        .to_string_lossy()
        .into_owned()
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.iter().any(|a| a == "--demo-index") {
                let _ = windows::open_settings_with(app, Some("index"));
            } else if args.iter().any(|a| a == "--demo-settings") {
                let _ = windows::open_settings(app.clone());
            } else {
                let _ = app.emit("guseok://shortcut", json!({ "action": "toggle" }));
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            store_io::load_store,
            store_io::save_store,
            store_io::get_data_dir,
            store_io::set_data_dir,
            win32::set_autostart,
            store_io::read_text_file,
            store_io::open_data_dir,
            store_io::write_text_file,
            windows::open_settings,
            windows::show_panel,
            windows::hide_panel,
            windows::show_search,
            windows::hide_search,
            windows::place_toast,
            windows::place_pick,
            windows::place_handles,
            win32::work_area,
            win32::monitors,
            windows::register_shortcuts,
            qa_log,
            qa_log_path,
            window_ready,
            store_io::save_conflict_copy,
            quit_app
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let demo = std::env::args().any(|a| a == "--demo");
            let selftest = std::env::args().any(|a| a == "--selftest");
            let demo_settings = std::env::args().any(|a| a == "--demo-settings");

            let handles =
                WebviewWindowBuilder::new(app, "handles", WebviewUrl::App("index.html".into()))
                    .title("구석메모")
                    .inner_size(52.0, 280.0)
                    .decorations(false)
                    .transparent(true)
                    .resizable(false)
                    .maximizable(false)
                    .minimizable(false)
                    .closable(false)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .shadow(false)
                    .focused(false)
                    .visible(false)
                    .build()?;

            let panel_url = if selftest {
                "index.html?panel=1&selftest=1"
            } else {
                "index.html?panel=1"
            };
            let _panel = WebviewWindowBuilder::new(app, "panel", WebviewUrl::App(panel_url.into()))
                .title("구석메모 메모")
                .inner_size(420.0, 460.0)
                .decorations(false)
                .transparent(true)
                .resizable(false)
                .maximizable(false)
                .minimizable(false)
                .closable(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .shadow(false)
                .focused(false)
                .visible(false)
                .build()?;

            let settings =
                WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
                    .title("구석메모 설정")
                    .inner_size(600.0, 760.0)
                    .min_inner_size(520.0, 600.0)
                    .center()
                    .visible(false)
                    .build()?;
            let settings_for_event = settings.clone();
            settings.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = settings_for_event.hide();
                }
            });

            // D-1 — 검색은 전역 기능이라 panel과 분리된 독립 창. 다른 창과 마찬가지로
            // setup에서 미리 만들고 hide/show로 재사용한다 (NFR-06, BUG-18 회귀 방지).
            let search =
                WebviewWindowBuilder::new(app, "search", WebviewUrl::App("search.html".into()))
                    .title("구석메모 검색")
                    .inner_size(windows::SEARCH_W, windows::SEARCH_H)
                    .decorations(false)
                    .transparent(true)
                    .resizable(false)
                    .maximizable(false)
                    .minimizable(false)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .shadow(false)
                    .focused(false)
                    .visible(false)
                    .build()?;
            let search_for_event = search.clone();
            search.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = search_for_event.hide();
                }
            });
            let _ = search;

            // D-2/OQ-02 — 리마인더 앱 내 토스트. 스트립 옆에 뜨는 알림 카드로,
            // 패널이 닫혀 있어도(권한·OS 알림 설정과 무관하게) 도달한다. handles가
            // 큐를 소유하며 place_toast로 위치·표시를 지시하고, 클릭은
            // guseok://toast-* 이벤트로 handles에 되돌아간다.
            let _toast = WebviewWindowBuilder::new(
                app,
                "toast",
                WebviewUrl::App("index.html?toast=1".into()),
            )
            .title("구석메모 알림")
            .inner_size(300.0, 200.0)
            .decorations(false)
            .transparent(true)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .closable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .focused(false)
            .visible(false)
            .build()?;

            // D-5 — 템플릿 선택 창. 스트립 `+`에서 패널 위치에 뜨는 작은 목록 창.
            // 다른 보조 창과 마찬가지로 setup에서 만들고 place_pick으로 show/hide.
            let _pick =
                WebviewWindowBuilder::new(app, "pick", WebviewUrl::App("index.html?pick=1".into()))
                    .title("구석메모 템플릿")
                    .inner_size(200.0, 160.0)
                    .decorations(false)
                    .transparent(true)
                    .resizable(false)
                    .maximizable(false)
                    .minimizable(false)
                    .closable(false)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .shadow(false)
                    .focused(false)
                    .visible(false)
                    .build()?;

            let settings_item = MenuItemBuilder::with_id("settings", "설정").build(app)?;
            let toggle_item = MenuItemBuilder::with_id("toggle", "메모 열기 / 닫기").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "종료").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&toggle_item, &settings_item, &quit_item])
                .build()?;

            let icon = app.default_window_icon().cloned();
            let mut tray = TrayIconBuilder::with_id("main")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("구석메모")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "settings" => {
                        let _ = windows::open_settings(app.clone());
                    }
                    "toggle" => {
                        let _ = app.emit("guseok://shortcut", json!({ "action": "toggle" }));
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        let _ = windows::open_settings(app.clone());
                    }
                });
            if let Some(icon) = icon {
                tray = tray.icon(icon);
            }
            tray.build(app)?;

            let _ = handles;
            // TD-07: 부팅 시 디스크 store로 리마인더 스케줄 초기화(load_store와 같은
            // 읽기 경로) — 이후 갱신은 save_store가 저장본 파싱으로 담당한다.
            // 스레드는 detached — 트레이 상주 앱이라 수명은 앱과 동일.
            {
                let raw = store_io::load_store_raw(&handle);
                scheduler::update_schedule_from_store(&raw);
                let sched_app = handle.clone();
                std::thread::spawn(move || scheduler::reminder_scheduler_loop(sched_app));
            }
            // TD-04: 외부 변경 감시 — 부팅 로드 직후의 파일 상태가 "우리가 아는" 기준
            // 스탬프. store_path가 포인터를 매번 재해석하므로 set_data_dir 전환도
            // 스레드가 자동으로 따라간다(경로 변경 시 조용히 재기준).
            if let Ok(p) = store_io::store_path(&handle) {
                store_io::note_store_stamp(&p, store_io::file_stamp(&p));
            }
            {
                let watch_app = handle.clone();
                std::thread::spawn(move || store_io::store_watch_loop(watch_app));
            }
            let _ = handle;
            if demo || selftest {
                let app2 = app.handle().clone();
                std::thread::spawn(move || {
                    // handles·panel 양쪽 리스너가 준비될 때까지 최대 10초 대기 후 toggle emit.
                    // 느린 부팅에서도 시작 이벤트가 유실되지 않으며, 빠른 부팅에서는 즉시 진행한다.
                    let start = std::time::Instant::now();
                    while (READY_MASK.load(Ordering::Acquire) & READY_BOTH) != READY_BOTH
                        && start.elapsed() < Duration::from_secs(10)
                    {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    std::thread::sleep(Duration::from_millis(150));
                    let _ = app2.emit("guseok://shortcut", json!({ "action": "toggle" }));
                });
            }
            if std::env::args().any(|a| a == "--qa-autostart") {
                win32::autostart_qa();
            }
            if demo_settings {
                let app3 = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1800));
                    let _ = windows::open_settings(app3);
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_ready_bit_mapping() {
        assert_eq!(window_ready_bit("handles"), READY_HANDLES);
        assert_eq!(window_ready_bit("panel"), READY_PANEL);
        assert_eq!(
            window_ready_bit("handles") | window_ready_bit("panel"),
            READY_BOTH
        );
        assert_eq!(window_ready_bit("settings"), 0);
        assert_eq!(window_ready_bit("search"), 0);
    }
}
