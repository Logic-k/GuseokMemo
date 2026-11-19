use tauri::AppHandle;

use crate::qa_write;

#[derive(serde::Serialize, Clone)]
pub struct WorkArea {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) w: f64,
    pub(crate) h: f64,
    pub(crate) scale: f64,
    pub(crate) index: i32,
    pub(crate) name: String,
}

#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<(), String> {
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
pub fn monitors(app: AppHandle) -> Result<Vec<WorkArea>, String> {
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
pub fn work_area(app: AppHandle, which: String) -> Result<WorkArea, String> {
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

pub(crate) fn autostart_qa() {
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
