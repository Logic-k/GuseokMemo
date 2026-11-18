#![windows_subsystem = "windows"]

use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::str::FromStr;
use std::time::Duration;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
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

/// fs::rename 실패(Windows 파일 점유: 백신·인덱서·동기 클라이언트) 시 재시도 전에
/// 기다리는 백오프(ms) — 첫 시도는 즉시, 실패할 때마다 다음 간격만큼 대기 후 재시도.
/// 총 대기 상한 300ms(최대 시도 4회)로 1초 미만 — 260ms 디바운스 저장 경로를 오래
/// 붙잡지 않으면서 짧은 점유를 흡수한다 (TD-02, NFR-01).
const RENAME_RETRY_DELAYS_MS: [u64; 3] = [50, 100, 150];

/// `rename`을 성공할 때까지 시도한다 — 첫 시도는 즉시, 이후 실패마다 `delays_ms`의
/// 다음 간격만큼 `sleep`으로 기다린 뒤 재시도한다. 반환값은 성공까지 걸린 시도 횟수
/// (1 = 첫 시도에 성공). 모든 시도가 실패하면 마지막 오류를 Err로 반환한다.
/// rename/sleep을 주입받아 실제 파일 점유 없이도 재시도 순서를 검증할 수 있다.
fn rename_with_retry<E, R, S>(delays_ms: &[u64], mut rename: R, mut sleep: S) -> Result<u32, E>
where
    R: FnMut() -> Result<(), E>,
    S: FnMut(Duration),
{
    let mut attempts = 0u32;
    let mut delays = delays_ms.iter();
    loop {
        attempts += 1;
        match rename() {
            Ok(()) => return Ok(attempts),
            Err(e) => match delays.next() {
                Some(&ms) => sleep(Duration::from_millis(ms)),
                None => return Err(e),
            },
        }
    }
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
    // Windows는 대상 파일이 백신·인덱서·동기 클라이언트에 열려 있는 동안 rename이
    // 대기 없이 실패한다 — 짧은 백오프로 재시도해 점유 해제를 기다린다 (TD-02, NFR-01).
    // 참고: rename은 디렉터리 항목의 디스크 내구성을 보장하지 않고, Windows에서는
    // 디렉터리 자체를 fsync할 방법이 없다 — store.bak.json 사본이 이 한계의 완충이다.
    match rename_with_retry(
        &RENAME_RETRY_DELAYS_MS,
        || fs::rename(&tmp, &p),
        std::thread::sleep,
    ) {
        Ok(attempts) => {
            if attempts > 1 {
                qa_write(&format!(
                    "save-store :: rename occupied, succeeded on attempt {attempts}"
                ));
            }
        }
        Err(e) => {
            qa_write(&format!(
                "save-store :: rename still occupied after {} attempts: {e}",
                RENAME_RETRY_DELAYS_MS.len() + 1
            ));
            return Err(e.to_string());
        }
    }
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
        key.set_value("GuseokMemo", &value)
            .map_err(|e| e.to_string())?;
    } else {
        let _ = key.delete_value("GuseokMemo");
    }
    Ok(())
}

#[tauri::command]
fn open_data_dir(app: AppHandle) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::process::Command::new("explorer")
        .arg(dir)
        .spawn()
        .map_err(|e| e.to_string())?;
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
fn show_panel(
    app: AppHandle,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    index_id: String,
) -> Result<(), String> {
    let win = app
        .get_webview_window("panel")
        .ok_or("panel window missing")?;
    win.set_size(LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    win.set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    app.emit("guseok://panel-open", json!({ "id": index_id }))
        .map_err(|e| e.to_string())?;
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
fn place_handles(
    app: AppHandle,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    visible: bool,
) -> Result<(), String> {
    let win = app
        .get_webview_window("handles")
        .ok_or("handles window missing")?;
    win.set_size(LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    win.set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
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
                name: m
                    .name()
                    .cloned()
                    .unwrap_or_else(|| format!("모니터 {}", i + 1)),
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
            if cursor.0 >= p.x
                && cursor.0 < p.x + s.width as i32
                && cursor.1 >= p.y
                && cursor.1 < p.y + s.height as i32
            {
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
        name: m
            .name()
            .cloned()
            .unwrap_or_else(|| format!("모니터 {}", chosen + 1)),
    })
}

#[cfg(target_os = "windows")]
fn cursor_point() -> (i32, i32) {
    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }
    extern "system" {
        fn GetCursorPos(point: *mut Point) -> i32;
    }
    let mut p = Point { x: 0, y: 0 };
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
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    #[repr(C)]
    struct MonitorInfo {
        cb_size: u32,
        rc_monitor: Rect,
        rc_work: Rect,
        dw_flags: u32,
    }
    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }
    extern "system" {
        fn MonitorFromPoint(pt: Point, flags: u32) -> isize;
        fn GetMonitorInfoW(monitor: isize, info: *mut MonitorInfo) -> i32;
    }
    let pt = Point { x, y };
    unsafe {
        let hmon = MonitorFromPoint(pt, 2);
        if hmon != 0 {
            let mut info = MonitorInfo {
                cb_size: std::mem::size_of::<MonitorInfo>() as u32,
                rc_monitor: Rect {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                },
                rc_work: Rect {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                },
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
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
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
        None => set_autostart(false).map_err(std::io::Error::other),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rename_retry_succeeds_on_first_attempt() {
        // 첫 시도 성공이면 재시도·sleep 없이 바로 Ok(1).
        let mut calls = 0u32;
        let mut slept: Vec<u64> = Vec::new();
        let r = rename_with_retry(
            &RENAME_RETRY_DELAYS_MS,
            || {
                calls += 1;
                Ok::<(), &str>(())
            },
            |d| slept.push(d.as_millis() as u64),
        );
        assert_eq!(r, Ok(1));
        assert_eq!(calls, 1);
        assert!(slept.is_empty());
    }

    #[test]
    fn rename_retry_succeeds_after_occupation_clears() {
        // 점유가 풀리면(여기선 3번째 시도부터 성공) 백오프 순서대로 기다린 뒤 성공.
        let mut calls = 0u32;
        let mut slept: Vec<u64> = Vec::new();
        let r = rename_with_retry(
            &RENAME_RETRY_DELAYS_MS,
            || {
                calls += 1;
                if calls <= 2 {
                    Err("sharing violation")
                } else {
                    Ok(())
                }
            },
            |d| slept.push(d.as_millis() as u64),
        );
        assert_eq!(r, Ok(3));
        assert_eq!(calls, 3);
        assert_eq!(slept, vec![50, 100]);
    }

    #[test]
    fn rename_retry_exhausted_returns_last_error() {
        // 모든 시도 실패 → 시도 횟수 = 1 + delays 수, Err는 마지막 시도의 오류.
        let mut calls = 0u32;
        let mut slept: Vec<u64> = Vec::new();
        let r: Result<u32, u32> = rename_with_retry(
            &RENAME_RETRY_DELAYS_MS,
            || {
                calls += 1;
                Err(calls)
            },
            |d| slept.push(d.as_millis() as u64),
        );
        assert_eq!(r, Err(4));
        assert_eq!(calls, 4);
        assert_eq!(slept, vec![50, 100, 150]);
    }

    #[test]
    fn rename_retry_delays_fit_budget() {
        // 명세: 보수적 백오프 — 간격 50~150ms, 단조 비감소, 총 대기 1초 미만.
        assert!(!RENAME_RETRY_DELAYS_MS.is_empty());
        assert!(RENAME_RETRY_DELAYS_MS
            .iter()
            .all(|&d| (50..=150).contains(&d)));
        assert!(RENAME_RETRY_DELAYS_MS.windows(2).all(|w| w[0] <= w[1]));
        let total: u64 = RENAME_RETRY_DELAYS_MS.iter().sum();
        assert!(total < 1000, "total backoff {total}ms exceeds 1s");
    }

    #[test]
    fn rename_retry_real_fs_rename() {
        // 실제 파일로 주입 경로 검증 — 잠금 없이 rename 한 번에 성공.
        let dir =
            std::env::temp_dir().join(format!("guseok-memo-rename-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let tmp = dir.join("store.tmp.json");
        let dst = dir.join("store.json");
        fs::write(&tmp, b"{}").unwrap();
        let r = rename_with_retry(&RENAME_RETRY_DELAYS_MS, || fs::rename(&tmp, &dst), |_| {});
        let ok = dst.exists() && !tmp.exists();
        let _ = fs::remove_dir_all(&dir);
        let attempts = r.expect("rename should succeed on clean fs");
        assert_eq!(attempts, 1);
        assert!(ok);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn rename_retry_recovers_when_occupation_released() {
        use std::os::windows::fs::OpenOptionsExt;
        // dst를 공유 없이 열어 백신·인덱서 점유를 재현 — 60ms 뒤 스레드가 drop 해 해제.
        let dir =
            std::env::temp_dir().join(format!("guseok-memo-lock-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let tmp = dir.join("store.tmp.json");
        let dst = dir.join("store.json");
        fs::write(&tmp, b"new").unwrap();
        fs::write(&dst, b"old").unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&dst)
            .unwrap();
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(60));
            drop(lock);
        });
        let r = rename_with_retry(
            &RENAME_RETRY_DELAYS_MS,
            || fs::rename(&tmp, &dst),
            std::thread::sleep,
        );
        releaser.join().unwrap();
        let content = fs::read_to_string(&dst).ok();
        let _ = fs::remove_dir_all(&dir);
        let attempts = r.expect("rename should succeed once occupation clears");
        assert!(attempts >= 2, "expected at least one retry, got {attempts}");
        assert_eq!(content.as_deref(), Some("new"));
    }
}
