#![windows_subsystem = "windows"]

use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::str::FromStr;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(serde::Serialize, Clone)]
struct WorkArea {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    scale: f64,
    index: i32,
    name: String,
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("store.json"))
}

#[tauri::command]
fn load_store(app: AppHandle) -> Result<String, String> {
    let p = store_path(&app)?;
    if let Ok(s) = fs::read_to_string(&p) {
        if !s.trim().is_empty() {
            return Ok(s);
        }
    }
    let bak = p.with_file_name("store.bak.json");
    if let Ok(s) = fs::read_to_string(&bak) {
        return Ok(s);
    }
    Ok(String::new())
}

#[tauri::command]
fn save_store(app: AppHandle, webview: WebviewWindow, json: String) -> Result<(), String> {
    let p = store_path(&app)?;
    let bak = p.with_file_name("store.bak.json");
    if p.exists() {
        let _ = fs::copy(&p, &bak);
    }
    let tmp = p.with_file_name("store.tmp.json");
    fs::write(&tmp, json.as_bytes()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    // 다른 창에는 저장본을 브로드캐스트(페이지 숨김 도중의 pagehide 플러시도 전파되도록 Rust 에서 직접 보냄).
    // src 에 저장한 창의 라벨을 넣어, 저장한 창 자신의 에코는 JS 쪽에서 무시한다 —
    // 자기 에코까지 처리하면 타이핑 도중 state 가 교체되며 IME 조합이 깨진다.
    let payload = json!({ "src": webview.label(), "raw": json }).to_string();
    let _ = app.emit("guseok://store", payload);
    Ok(())
}

#[tauri::command]
fn set_autostart(enabled: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey_with_flags(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Run",
            winreg::enums::KEY_SET_VALUE,
        )
        .map_err(|e| e.to_string())?;
    if enabled {
        let value = format!("\"{}\"", exe.display());
        key.set_value("GuseokMemo", &value).map_err(|e| e.to_string())?;
    } else {
        let _ = key.delete_value("GuseokMemo");
    }
    Ok(())
}

#[tauri::command]
fn open_data_dir(app: AppHandle) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::process::Command::new("explorer").arg(dir).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(path, content).map_err(|e| e.to_string())
}

fn open_settings_with(app: &AppHandle, tab: Option<&str>) -> Result<(), String> {
    let w = app
        .get_webview_window("settings")
        .ok_or("settings window missing")?;
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
    if let Some(t) = tab {
        let _ = w.emit("guseok://open-tab", json!({ "tab": t }));
    }
    Ok(())
}

#[tauri::command]
fn open_settings(app: AppHandle) -> Result<(), String> {
    open_settings_with(&app, None)
}

#[tauri::command]
fn show_panel(app: AppHandle, x: f64, y: f64, w: f64, h: f64, index_id: String) -> Result<(), String> {
    let win = app.get_webview_window("panel").ok_or("panel window missing")?;
    win.set_size(LogicalSize::new(w, h)).map_err(|e| e.to_string())?;
    win.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    app.emit("guseok://panel-open", json!({ "id": index_id })).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn hide_panel(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("panel") {
        let _ = win.hide();
    }
    let _ = app.emit("guseok://panel-closed", json!({}));
    Ok(())
}

#[tauri::command]
fn place_handles(app: AppHandle, x: f64, y: f64, w: f64, h: f64, visible: bool) -> Result<(), String> {
    let win = app.get_webview_window("handles").ok_or("handles window missing")?;
    win.set_size(LogicalSize::new(w, h)).map_err(|e| e.to_string())?;
    win.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    if visible {
        win.show().map_err(|e| e.to_string())?;
    } else {
        let _ = win.hide();
    }
    Ok(())
}

#[tauri::command]
fn monitors(app: AppHandle) -> Result<Vec<WorkArea>, String> {
    let monitors: Vec<_> = app.available_monitors().map_err(|e| e.to_string())?;
    if monitors.is_empty() {
        return Err("no monitor".into());
    }
    Ok(monitors
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let p = m.position();
            let s = m.size();
            let scale = m.scale_factor();
            let (wl, wt, wr, wb) = monitor_work_area(p.x, p.y, s.width as i32, s.height as i32);
            WorkArea {
                x: wl as f64 / scale,
                y: wt as f64 / scale,
                w: (wr - wl) as f64 / scale,
                h: (wb - wt) as f64 / scale,
                scale,
                index: i as i32,
                name: m.name().cloned().unwrap_or_else(|| format!("모니터 {}", i + 1)),
            }
        })
        .collect())
}

#[tauri::command]
fn work_area(app: AppHandle, which: String) -> Result<WorkArea, String> {
    let monitors: Vec<_> = app.available_monitors().map_err(|e| e.to_string())?;
    if monitors.is_empty() {
        return Err("no monitor".into());
    }
    let mut chosen = 0usize;
    if which == "auto" {
        let cursor = cursor_point();
        for (i, m) in monitors.iter().enumerate() {
            let p = m.position();
            let s = m.size();
            if cursor.0 >= p.x && cursor.0 < p.x + s.width as i32 && cursor.1 >= p.y && cursor.1 < p.y + s.height as i32 {
                chosen = i;
                break;
            }
        }
    } else if let Ok(n) = which.parse::<usize>() {
        if n < monitors.len() {
            chosen = n;
        }
    }
    let m = &monitors[chosen];
    let p = m.position();
    let s = m.size();
    let scale = m.scale_factor();
    let (wl, wt, wr, wb) = monitor_work_area(p.x, p.y, s.width as i32, s.height as i32);
    Ok(WorkArea {
        x: wl as f64 / scale,
        y: wt as f64 / scale,
        w: (wr - wl) as f64 / scale,
        h: (wb - wt) as f64 / scale,
        scale,
        index: chosen as i32,
        name: m.name().cloned().unwrap_or_else(|| format!("모니터 {}", chosen + 1)),
    })
}

#[cfg(target_os = "windows")]
fn cursor_point() -> (i32, i32) {
    #[repr(C)]
    struct POINT {
        x: i32,
        y: i32,
    }
    extern "system" {
        fn GetCursorPos(point: *mut POINT) -> i32;
    }
    let mut p = POINT { x: 0, y: 0 };
    unsafe {
        GetCursorPos(&mut p);
    }
    (p.x, p.y)
}

#[cfg(not(target_os = "windows"))]
fn cursor_point() -> (i32, i32) {
    (0, 0)
}

#[cfg(target_os = "windows")]
fn monitor_work_area(x: i32, y: i32, w: i32, h: i32) -> (i32, i32, i32, i32) {
    #[repr(C)]
    struct RECT {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    #[repr(C)]
    struct MONITORINFO {
        cb_size: u32,
        rc_monitor: RECT,
        rc_work: RECT,
        dw_flags: u32,
    }
    #[repr(C)]
    struct POINT {
        x: i32,
        y: i32,
    }
    extern "system" {
        fn MonitorFromPoint(pt: POINT, flags: u32) -> isize;
        fn GetMonitorInfoW(monitor: isize, info: *mut MONITORINFO) -> i32;
    }
    let pt = POINT { x, y };
    unsafe {
        let hmon = MonitorFromPoint(pt, 2);
        if hmon != 0 {
            let mut info = MONITORINFO {
                cb_size: std::mem::size_of::<MONITORINFO>() as u32,
                rc_monitor: RECT { left: 0, top: 0, right: 0, bottom: 0 },
                rc_work: RECT { left: 0, top: 0, right: 0, bottom: 0 },
                dw_flags: 0,
            };
            if GetMonitorInfoW(hmon, &mut info) != 0 {
                return (
                    info.rc_work.left,
                    info.rc_work.top,
                    info.rc_work.right,
                    info.rc_work.bottom,
                );
            }
        }
    }
    (x, y, x + w, y + h)
}

#[cfg(not(target_os = "windows"))]
fn monitor_work_area(x: i32, y: i32, w: i32, h: i32) -> (i32, i32, i32, i32) {
    (x, y, x + w, y + h)
}

fn shortcut_keys(preset: &str) -> Vec<(String, String)> {
    let toggle = match preset {
        "alt_m" => "Ctrl+Alt+KeyM",
        "shift_space" => "Ctrl+Shift+Space",
        "f9" => "F9",
        _ => "Ctrl+Shift+KeyM",
    };
    vec![
        ("toggle".to_string(), toggle.to_string()),
        ("prev".to_string(), "Ctrl+Shift+ArrowUp".to_string()),
        ("next".to_string(), "Ctrl+Shift+ArrowDown".to_string()),
    ]
}

#[tauri::command]
fn register_shortcuts(app: AppHandle, preset: String, enabled: bool) -> Result<(), String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    if !enabled {
        return Ok(());
    }
    for (action, key) in shortcut_keys(&preset) {
        let sc = Shortcut::from_str(&key).map_err(|e| format!("{key}: {e}"))?;
        let act = action.clone();
        gs.on_shortcut(sc, move |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                let _ = app.emit("guseok://shortcut", json!({ "action": act }));
            }
        })
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn qa_write(msg: &str) {
    use std::io::Write;
    let line = format!("[QA] {}\n", msg);
    let path = std::env::temp_dir().join("guseok-qa.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(line.as_bytes());
    }
}

#[tauri::command]
fn qa_log(msg: String) {
    qa_write(&msg);
}

fn autostart_qa() {
    let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    let prev = hkcu
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
        .and_then(|k| k.get_value::<String, _>("GuseokMemo"))
        .ok();
    let enable = set_autostart(true);
    let present = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
        .and_then(|k| k.get_value::<String, _>("GuseokMemo"))
        .is_ok();
    let restored = match prev {
        Some(v) => hkcu
            .open_subkey_with_flags(
                "Software\\Microsoft\\Windows\\CurrentVersion\\Run",
                winreg::enums::KEY_SET_VALUE,
            )
            .and_then(|k| k.set_value("GuseokMemo", &v)),
        None => set_autostart(false).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)),
    };
    let ok = enable.is_ok() && present && restored.is_ok();
    qa_write(&format!(
        "{} autostart :: enable={:?} present={} restored={:?}",
        if ok { "PASS" } else { "FAIL" },
        enable.err(),
        present,
        restored.err()
    ));
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.iter().any(|a| a == "--demo-index") {
                let _ = open_settings_with(app, Some("index"));
            } else if args.iter().any(|a| a == "--demo-settings") {
                let _ = open_settings(app.clone());
            } else {
                let _ = app.emit("guseok://shortcut", json!({ "action": "toggle" }));
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            load_store,
            save_store,
            set_autostart,
            read_text_file,
            open_data_dir,
            write_text_file,
            open_settings,
            show_panel,
            hide_panel,
            place_handles,
            work_area,
            monitors,
            register_shortcuts,
            qa_log,
            quit_app
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let demo = std::env::args().any(|a| a == "--demo");
            let selftest = std::env::args().any(|a| a == "--selftest");
            let demo_settings = std::env::args().any(|a| a == "--demo-settings");

            let handles = WebviewWindowBuilder::new(app, "handles", WebviewUrl::App("index.html".into()))
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

            let panel_url = if selftest { "index.html?panel=1&selftest=1" } else { "index.html?panel=1" };
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

            let settings = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
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
                        let _ = open_settings(app.clone());
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
                        let _ = open_settings(app.clone());
                    }
                });
            if let Some(icon) = icon {
                tray = tray.icon(icon);
            }
            tray.build(app)?;

            let _ = handles;
            let _ = handle;
            if demo || selftest {
                let app2 = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1400));
                    let _ = app2.emit("guseok://shortcut", json!({ "action": "toggle" }));
                });
            }
            if std::env::args().any(|a| a == "--qa-autostart") {
                autostart_qa();
            }
            if demo_settings {
                let app3 = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1800));
                    let _ = open_settings(app3);
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}









