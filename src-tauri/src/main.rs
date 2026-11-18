#![windows_subsystem = "windows"]

use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
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
    // TD-05: config.json 포인터가 유효한 폴더를 가리키면 그곳의 store.json을 쓰고,
    // 아니면(없음·손상·폴더 없음) 기본 위치로 폴백한다. 호출마다 해석하므로
    // set_data_dir 이후의 저장·로드·스케줄 초기화가 즉시 새 경로를 따라간다.
    Ok(resolve_store_dir(&dir, &config_path(&dir)).join("store.json"))
}

/// store.json → 비어 있으면 store.bak.json 폴백 — load_store 커맨드와
/// 스케줄러 부팅 초기화(load_store_raw)가 공유하는 읽기 경로.
fn read_store_contents(p: &Path) -> String {
    if let Ok(s) = fs::read_to_string(p) {
        if !s.trim().is_empty() {
            return s;
        }
    }
    let bak = p.with_file_name("store.bak.json");
    if let Ok(s) = fs::read_to_string(&bak) {
        return s;
    }
    String::new()
}

/// 커맨드가 아닌 Rust 내부 호출용 — 실패 시 빈 문자열(빈 스케줄로 시작).
fn load_store_raw(app: &AppHandle) -> String {
    match store_path(app) {
        Ok(p) => read_store_contents(&p),
        Err(_) => String::new(),
    }
}

#[tauri::command]
fn load_store(app: AppHandle) -> Result<String, String> {
    let p = store_path(&app)?;
    Ok(read_store_contents(&p))
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
    // TD-04: 감시 루프의 자기 에코 억제 — rename으로 확정된 실제 스탬프를 추적값으로
    // 기록해 두면, 폴링이 이번 저장을 외부 변경으로 오인하지 않는다.
    note_store_stamp(&p, file_stamp(&p));
    // 다른 창에는 저장본을 브로드캐스트(페이지 숨김 도중의 pagehide 플러시도 전파되도록 Rust 에서 직접 보냄).
    // src 에 저장한 창의 라벨을 넣어, 저장한 창 자신의 에코는 JS 쪽에서 무시한다 —
    // 자기 에코까지 처리하면 타이핑 도중 state 가 교체되며 IME 조합이 깨진다.
    let payload = json!({ "src": webview.label(), "raw": json }).to_string();
    let _ = app.emit("guseok://store", payload);
    // TD-07: 저장본의 reminders로 인메모리 스케줄을 갱신한다 — 저장한 창 라벨과
    // 무관하게 모든 save_store 경유 저장(편집·설정·복원·pagehide 플러시)이 반영된다.
    update_schedule_from_store(&json);
    Ok(())
}

// ==================== 저장 폴더 지정 (TD-05, R-04) ====================
//
// 포인터 파일 `%APPDATA%\com.guseok.memo\config.json` = { "dataDir": "<폴더>" | null }.
// 포인터를 store.json 안에 두면 "폴더를 바꾼 사실"이 옮겨간 파일에만 있어 부팅 시
// 위치를 알 수 없다(치킨앤에그) — 앱 데이터 루트는 고정하고 store.json만 옮긴다.
// config.json 손상·부분 누락·무효 경로는 전부 기본 경로로 안전 폴백한다.

/// 고정 위치 포인터 파일 — store.json과 같은 앱 데이터 루트(이동 대상 아님).
fn config_path(app_dir: &Path) -> PathBuf {
    app_dir.join("config.json")
}

/// config.json의 dataDir 원시값 — "설정된 값"만 반환한다(get_data_dir의 표시용).
/// 존재 여부는 resolve_store_dir가 판단. 문자열 아님·빈 값·JSON 손상·파일 없음은 None.
fn configured_data_dir(cfg: &Path) -> Option<PathBuf> {
    let raw = fs::read_to_string(cfg).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let s = v.get("dataDir")?.as_str()?.trim();
    if s.is_empty() {
        None
    } else {
        Some(PathBuf::from(s))
    }
}

/// 포인터 해석 — 설정된 폴더가 실제로 존재하는 디렉터리면 그곳, 아니면 기본 dir.
/// 지정 폴더가 나중에 삭제된 경우도 여기서 기본 경로로 폴백한다(매 호출마다 확인).
fn resolve_store_dir(app_dir: &Path, cfg: &Path) -> PathBuf {
    match configured_data_dir(cfg) {
        Some(d) if d.is_dir() => d,
        _ => app_dir.to_path_buf(),
    }
}

/// 두 디렉터리의 동치 비교 — canonicalize로 철자 차이(대소문·..·끝 구분자)를 흡수한다.
/// 한쪽이라도 해석 실패(미존재)면 문자열 비교로 폴백.
fn same_dir(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

/// 지정 폴더의 쓰기 가능 확인 — 시험 파일을 실제로 쓰고 지운다(읽기 전용·ACL 감지).
fn check_dir_writable(dir: &Path) -> Result<(), String> {
    let probe = dir.join(format!(".guseok-write-test-{}", std::process::id()));
    fs::write(&probe, b"ok").map_err(|e| format!("폴더에 쓸 수 없습니다: {e}"))?;
    let _ = fs::remove_file(&probe);
    Ok(())
}

/// 기존 저장본을 새 폴더로 이전 — 원본은 보존한다(복사, 삭제 금지 — 데이터 파괴 금지).
/// 대상에 이미 store.json이 있으면 그것을 먼저 store.bak.json으로 보존하고, 없으면
/// 원본 .bak를 함께 복사해 read_store_contents의 폴백 경로를 유지한다.
/// 복사 후 재읽기 검증 — 내용이 다르면 Err(호출자가 포인터를 갱신하지 않는다).
/// 반환: store.json을 실제로 옮겼으면 true(원본이 없으면 false — 첫 실행 등).
fn copy_store_to_dir(from_dir: &Path, to_dir: &Path) -> Result<bool, String> {
    let src = from_dir.join("store.json");
    let dst = to_dir.join("store.json");
    if !src.exists() {
        return Ok(false); // 옮길 저장본이 없다 — 대상의 기존 파일은 그대로 둔다.
    }
    if dst.exists() {
        fs::copy(&dst, to_dir.join("store.bak.json"))
            .map_err(|e| format!("대상 폴더의 기존 store.json 보존 실패: {e}"))?;
    } else {
        let src_bak = from_dir.join("store.bak.json");
        if src_bak.exists() {
            // 폴백 보조 — .bak 복사 실패는 이전 자체를 막지 않는다.
            let _ = fs::copy(&src_bak, to_dir.join("store.bak.json"));
        }
    }
    fs::copy(&src, &dst).map_err(|e| format!("store.json 복사 실패: {e}"))?;
    let (a, b) = (
        fs::read(&src).map_err(|e| e.to_string())?,
        fs::read(&dst).map_err(|e| e.to_string())?,
    );
    if a != b {
        return Err("복사본 읽기 검증 실패 — 전환하지 않았습니다".into());
    }
    Ok(true)
}

/// config.json 포인터 갱신 — 기존 파일의 알 수 없는 키는 보존하고 dataDir만 교체.
/// 임시 파일→rename(재시도) 경로로 써 절반 쓰인 포인터를 피한다.
fn write_data_dir_pointer(cfg: &Path, dir: Option<&Path>) -> Result<(), String> {
    let mut obj = fs::read_to_string(cfg)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    obj.insert(
        "dataDir".into(),
        match dir {
            Some(d) => json!(d.to_string_lossy()),
            None => serde_json::Value::Null,
        },
    );
    let body =
        serde_json::to_string_pretty(&serde_json::Value::Object(obj)).map_err(|e| e.to_string())?;
    let tmp = cfg.with_file_name("config.tmp.json");
    fs::write(&tmp, body.as_bytes()).map_err(|e| e.to_string())?;
    rename_with_retry(
        &RENAME_RETRY_DELAYS_MS,
        || fs::rename(&tmp, cfg),
        std::thread::sleep,
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// get_data_dir의 반환 — ARCH §4 계약 {path, effectivePath, isDefault}.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DataDirInfo {
    /// config.json에 설정된 지정 폴더(무효·폴백 중이어도 설정값 그대로 — UI 오류 표시용)
    path: Option<String>,
    /// 실제 사용 중인 store.json의 부모 디렉터리
    effective_path: String,
    /// effectivePath가 기본 앱 데이터 dir이면 true(포인터 없음·무효 포함)
    is_default: bool,
}

fn data_dir_info(app_dir: &Path) -> DataDirInfo {
    let cfg = config_path(app_dir);
    let effective = resolve_store_dir(app_dir, &cfg);
    DataDirInfo {
        path: configured_data_dir(&cfg).map(|p| p.to_string_lossy().into_owned()),
        effective_path: effective.to_string_lossy().into_owned(),
        is_default: same_dir(&effective, app_dir),
    }
}

/// set_data_dir의 본체 — AppHandle 없이 디렉터리만으로 이전·포인터 갱신을 수행한다.
/// 순서: 존재·쓰기 가능 확인 → 기존 store 복사·읽기 검증 → config.json 포인터 갱신.
/// 포인터는 마지막에 갱신하므로 중간 실패는 기존 경로·데이터를 그대로 둔다.
fn set_data_dir_impl(app_dir: &Path, path: Option<&str>) -> Result<DataDirInfo, String> {
    fs::create_dir_all(app_dir).map_err(|e| e.to_string())?;
    let cfg = config_path(app_dir);
    let cur_dir = resolve_store_dir(app_dir, &cfg);
    match path {
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Err("빈 경로입니다".into());
            }
            let new_dir = PathBuf::from(trimmed);
            if !new_dir.is_dir() {
                return Err(format!("폴더가 없습니다: {trimmed}"));
            }
            check_dir_writable(&new_dir)?;
            // 같은 폴더 재지정은 자기 복사 방지를 위해 이전을 건너뛰고 포인터만 갱신.
            if !same_dir(&new_dir, &cur_dir) {
                copy_store_to_dir(&cur_dir, &new_dir)?;
            }
            // 기본 dir과 같은 곳을 지정하면 포인터 해제와 동치 — null로 정규화.
            let pointer = if same_dir(&new_dir, app_dir) {
                None
            } else {
                Some(new_dir.as_path())
            };
            write_data_dir_pointer(&cfg, pointer)?;
        }
        None => {
            // 포인터 해제 — 현재 유효 폴더의 저장본을 기본 dir로 복사 후 전환.
            if !same_dir(&cur_dir, app_dir) {
                copy_store_to_dir(&cur_dir, app_dir)?;
            }
            write_data_dir_pointer(&cfg, None)?;
        }
    }
    Ok(data_dir_info(app_dir))
}

#[tauri::command]
fn get_data_dir(app: AppHandle) -> Result<DataDirInfo, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(data_dir_info(&dir))
}

/// 저장 폴더 지정/해제 — Some(dir): 존재·쓰기 확인 → 기존 store.json 복사·검증 →
/// 포인터 갱신. None: 포인터 해제 후 기본 경로로 복귀(마찬가지로 복사 후 전환).
/// 미존재·쓰기 불가·복사 실패는 Err — 기존 경로·데이터는 그대로 유지된다.
#[tauri::command]
fn set_data_dir(app: AppHandle, path: Option<String>) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let info = match set_data_dir_impl(&dir, path.as_deref()) {
        Ok(i) => i,
        Err(e) => {
            qa_write(&format!("set-data-dir :: FAIL path={path:?} err={e}"));
            return Err(e);
        }
    };
    // 저장 폴더가 바뀌었으므로 스케줄 소스도 새 경로로 재동기화 — 이전은 마지막
    // 저장본의 복사라 내용은 동일하지만, 대상에 기존 store.json이 있던 경우도 흡수한다.
    // (스케줄러 스레드는 인메모리 SCHEDULE만 보고, 디스크 접점은 save_store·부팅
    // 초기화라 store_path 해석을 그대로 따라간다.)
    let raw = read_store_contents(&resolve_store_dir(&dir, &config_path(&dir)).join("store.json"));
    update_schedule_from_store(&raw);
    qa_write(&format!(
        "set-data-dir :: ok path={path:?} effective={}",
        info.effective_path
    ));
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
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // 저장 폴더가 지정돼 있으면 store.json이 실제로 있는 그 폴더를 연다 (TD-05).
    let dir = resolve_store_dir(&dir, &config_path(&dir));
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

// ==================== 리마인더 스케줄러 (TD-07, R-02/03) ====================
//
// 발화부만 구현 — 전달 방식(OQ-02, phase-03-task-02)과 무관하게 store.json의
// indexes[].reminders[]를 따라가는 인메모리 스케줄을 유지하고, due 발생마다
// `guseok://reminder`를 전 창에 emit + qa_log 기록한다.
//
// 시간 표현: at/lastFiredAt은 store 계약상 "로컬 시각 ISO"(예: 2026-11-19T09:00).
// 스케줄러는 그 로컬 벽시계를 일련초(1970-01-01 00:00 로컬 기준 초)로 환산해
// 비교한다 — daily/weekly의 "+1일/+7일"이 벽시계 기준으로 정확하고(epoch 초에
// 86400을 더하면 DST에서 벽시계가 어긋남) 타임존 오프셋 조회 없이 순수 계산으로
// 끝난다. 외부 의존은 현재 로컬 시각을 읽는 now_local_secs() 하나뿐이고
// 비Windows는 UTC 폴백을 둔다(대상 OS는 Windows). emit 페이로드의 firedAt은
// 실제 UNIX epoch 초(SystemTime)를 넣는다.

/// 스케줄 체크 주기 — 트레이 상주 앱이라 스레드 수명은 앱과 동일(detached).
/// 2초: 분 단위 정밀도의 리마인더에 지연·비용 모두 충분히 작은 간격.
const REMINDER_CHECK_INTERVAL: Duration = Duration::from_secs(2);
const SECS_PER_DAY: i64 = 86_400;

/// repeat 값 — store는 "none"|"daily"|"weekly", 알 수 없는 값은 Once로 간주.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Repeat {
    Once,
    Daily,
    Weekly,
}

impl Repeat {
    fn parse(s: &str) -> Repeat {
        match s {
            "daily" => Repeat::Daily,
            "weekly" => Repeat::Weekly,
            _ => Repeat::Once,
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Repeat::Once => "none",
            Repeat::Daily => "daily",
            Repeat::Weekly => "weekly",
        }
    }
    /// 반복 주기(초) — 비반복이면 None.
    fn period_secs(self) -> Option<i64> {
        match self {
            Repeat::Once => None,
            Repeat::Daily => Some(SECS_PER_DAY),
            Repeat::Weekly => Some(7 * SECS_PER_DAY),
        }
    }
}

/// 스케줄러가 따라가는 리마인더 한 건. `next_at`/`missed_at`이 모두 None이면
/// inert(발화 완료·비활성) — 발화 기록(last_fired_at) 보존용으로 맵에 남긴다.
struct SchedEntry {
    index_id: String,
    reminder_id: String,
    note: String,
    repeat: Repeat,
    anchor_at: i64,             // store의 at — 반복 발생 시각 T_k = anchor + k·period
    next_at: Option<i64>,       // 다음 정상 발화 발생 시각
    missed_at: Option<i64>,     // 보고 대기 중인 놓침 발생 시각
    last_fired_at: Option<i64>, // 마지막 발화/놓침 처리 시각 (인메모리 — 디스크 기록은 JS 몫)
}

/// drain_due가 반환하는 발화 이벤트 — emit 페이로드의 재료.
struct FireEvent {
    index_id: String,
    reminder_id: String,
    note: String,
    repeat: Repeat,
    at: i64, // 발생 시각(놓침이면 놓친 그 발생, 정상이면 도래한 발생)
    missed: bool,
}

/// store JSON에서 추출한 리마인더 원시 필드.
#[derive(Clone)]
struct RawReminder {
    index_id: String,
    id: String,
    at: String,
    repeat: String,
    note: String,
    enabled: bool,
    last_fired_at: Option<String>,
}

static SCHEDULE: OnceLock<Mutex<HashMap<String, SchedEntry>>> = OnceLock::new();

fn lock_schedule() -> MutexGuard<'static, HashMap<String, SchedEntry>> {
    SCHEDULE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        // poison돼도 스케줄은 디스크에서 재구축 가능한 캐시 — 죽이지 않고 계속 진행
        .unwrap_or_else(|e| e.into_inner())
}

/// 연/월/일 → 1970-01-01 기준 일수 (Howard Hinnant의 civil calendar 알고리즘).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = (m + 9) % 12; // 3월=0 … 2월=11
    let doy = (153 * mp + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146097 + doe - 719468
}

/// 일수 → 연/월/일 (days_from_civil의 역함수).
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 로컬 ISO("YYYY-MM-DD[THH:MM[:SS]]") → 로컬 일련초.
/// 'T' 또는 공백 구분 허용, 초 이후 접미(Z·오프셋)는 무시 — store 계약은 naive 로컬 시각.
/// 월/일/시/분 범위가 맞지 않거나 형식이 아니면 None.
fn parse_local_iso(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    let num = |i: usize, n: usize| -> Option<i64> {
        (0..n).try_fold(0i64, |acc, k| {
            let c = *b.get(i + k)?;
            if c.is_ascii_digit() {
                Some(acc * 10 + (c - b'0') as i64)
            } else {
                None
            }
        })
    };
    if b.len() < 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let (y, mo, d) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    let (mut h, mut mi, mut sec) = (0, 0, 0);
    if b.len() > 10 {
        if b[10] != b'T' && b[10] != b' ' {
            return None;
        }
        if b.len() < 16 || b[13] != b':' {
            return None;
        }
        h = num(11, 2)?;
        mi = num(14, 2)?;
        if b.len() >= 19 && b[16] == b':' {
            sec = num(17, 2)?;
        }
    }
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    Some(days_from_civil(y, mo, d) * SECS_PER_DAY + h * 3600 + mi * 60 + sec)
}

/// 로컬 일련초 → "YYYY-MM-DDTHH:MM:SS" (parse_local_iso의 역함수).
fn format_local_iso(secs: i64) -> String {
    let days = secs.div_euclid(SECS_PER_DAY);
    let tod = secs.rem_euclid(SECS_PER_DAY);
    let (y, mo, d) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        y,
        mo,
        d,
        tod / 3600,
        (tod % 3600) / 60,
        tod % 60
    )
}

/// 동기화 시점의 분류 — (다음 정상 발화 시각, 놓침 보고 시각)을 반환한다.
/// 둘 다 None이면 inert(발화 완료 또는 비활성).
///
/// 규칙:
/// - 반복 없음: last_fired >= at이면 이미 발화 → inert(중복 발화 방지).
///   at <= now인 미발화분은 자동 발화가 아니라 "놓침"으로 한 번만 보고(재시작 복원).
/// - 반복: pending = 첫 T_k > last_fired. pending <= now이면 가장 최근에 놓친
///   발생(T_k <= now 중 최대)만 한 번 보고하고, next는 첫 T_k > now.
fn plan_reminder(
    at: i64,
    repeat: Repeat,
    last_fired: Option<i64>,
    enabled: bool,
    now: i64,
) -> (Option<i64>, Option<i64>) {
    if !enabled {
        return (None, None);
    }
    match repeat.period_secs() {
        None => {
            if last_fired.is_some_and(|l| l >= at) {
                (None, None) // 이미 발화한 일회성 — 재발화 금지
            } else if at <= now {
                (None, Some(at)) // 미발화 과거분 → 놓침
            } else {
                (Some(at), None)
            }
        }
        Some(p) => {
            // pending = 첫 T_k > last_fired (없거나 at 이전이면 at 자체)
            let pending = match last_fired {
                Some(l) if l >= at => at + ((l - at) / p + 1) * p,
                _ => at,
            };
            if pending > now {
                return (Some(pending), None);
            }
            // 놓친 발생이 여럿이어도 가장 최근 것 하나만 보고(스팸 방지)
            let missed = at + ((now - at) / p) * p;
            let next = at + ((now - at) / p + 1) * p;
            (Some(next), Some(missed))
        }
    }
}

/// 저장본의 리마인더 집합으로 인메모리 스케줄을 재구축한다.
/// - 디스크에서 사라진 id는 제거(삭제 반영), at 파싱 불가도 대상 아님.
/// - last_fired는 "anchor(at·repeat) 동일 시 max(인메모리, 디스크)"로 병합 —
///   발화 직후 JS가 lastFiredAt을 쓰기 전의 저장(디스크는 과거 at·null)에서도
///   재발화하지 않게 하는 중복 발화 방지 장치. anchor가 바뀐 리마인더는 디스크값을 신뢰.
fn sync_schedule(sched: &mut HashMap<String, SchedEntry>, raws: &[RawReminder], now: i64) {
    let mut next_map: HashMap<String, SchedEntry> = HashMap::with_capacity(raws.len());
    for r in raws {
        let Some(at) = parse_local_iso(&r.at) else {
            continue;
        };
        let repeat = Repeat::parse(&r.repeat);
        let disk_last = r.last_fired_at.as_deref().and_then(parse_local_iso);
        let merged_last = match sched.get(&r.id) {
            Some(e) if e.anchor_at == at && e.repeat == repeat => {
                match (e.last_fired_at, disk_last) {
                    (Some(a), Some(b)) => Some(a.max(b)),
                    (a, b) => a.or(b),
                }
            }
            _ => disk_last,
        };
        let (next_at, missed_at) = plan_reminder(at, repeat, merged_last, r.enabled, now);
        next_map.insert(
            r.id.clone(),
            SchedEntry {
                index_id: r.index_id.clone(),
                reminder_id: r.id.clone(),
                note: r.note.clone(),
                repeat,
                anchor_at: at,
                next_at,
                missed_at,
                last_fired_at: merged_last,
            },
        );
    }
    *sched = next_map;
}

/// due를 수집하고 엔트리를 갱신한다 — 틱의 순수 부분(mutex 밖에서 테스트 가능).
/// 한 엔트리에 놓침 보고와 정상 발화가 둘 다면 놓침을 먼저 담는다.
fn drain_due(sched: &mut HashMap<String, SchedEntry>, now: i64) -> Vec<FireEvent> {
    let mut events = Vec::new();
    for e in sched.values_mut() {
        if let Some(m) = e.missed_at.take() {
            e.last_fired_at = Some(e.last_fired_at.map_or(now, |l| l.max(now)));
            events.push(FireEvent {
                index_id: e.index_id.clone(),
                reminder_id: e.reminder_id.clone(),
                note: e.note.clone(),
                repeat: e.repeat,
                at: m,
                missed: true,
            });
        }
        if let Some(n) = e.next_at {
            if n <= now {
                e.last_fired_at = Some(e.last_fired_at.map_or(now, |l| l.max(now)));
                // 반복이면 발화 후 다음 at 자동 계산 — 첫 T_k > now
                // (앱이 잠든 사이 지나간 주기는 건너뛰고 다음 유효 발생만 잡는다)
                e.next_at = e
                    .repeat
                    .period_secs()
                    .map(|p| e.anchor_at + ((now - e.anchor_at) / p + 1) * p);
                events.push(FireEvent {
                    index_id: e.index_id.clone(),
                    reminder_id: e.reminder_id.clone(),
                    note: e.note.clone(),
                    repeat: e.repeat,
                    at: n,
                    missed: false,
                });
            }
        }
    }
    events
}

/// store JSON 텍스트에서 indexes[].reminders[]를 평탄 추출.
/// enabled 누락은 true, repeat 누락은 "none" — JS defaultReminder와 같은 기본값.
fn reminders_from_store(raw: &str) -> Vec<RawReminder> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let Some(indexes) = v.get("indexes").and_then(|a| a.as_array()) else {
        return out;
    };
    for idx in indexes {
        let index_id = idx.get("id").and_then(|s| s.as_str()).unwrap_or_default();
        let Some(rs) = idx.get("reminders").and_then(|a| a.as_array()) else {
            continue;
        };
        for r in rs {
            let id = r.get("id").and_then(|s| s.as_str()).unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            out.push(RawReminder {
                index_id: index_id.to_string(),
                id: id.to_string(),
                at: r
                    .get("at")
                    .and_then(|s| s.as_str())
                    .unwrap_or_default()
                    .to_string(),
                repeat: r
                    .get("repeat")
                    .and_then(|s| s.as_str())
                    .unwrap_or("none")
                    .to_string(),
                note: r
                    .get("note")
                    .and_then(|s| s.as_str())
                    .unwrap_or_default()
                    .to_string(),
                enabled: r.get("enabled").and_then(|b| b.as_bool()).unwrap_or(true),
                last_fired_at: r
                    .get("lastFiredAt")
                    .and_then(|s| s.as_str())
                    .map(str::to_string),
            });
        }
    }
    out
}

/// 저장본 JSON을 파싱해 인메모리 스케줄을 갱신 — save_store(어느 창이든)·부팅 초기화 공용.
fn update_schedule_from_store(raw: &str) {
    let raws = reminders_from_store(raw);
    let mut sched = lock_schedule();
    sync_schedule(&mut sched, &raws, now_local_secs());
}

/// 실제 UNIX epoch 초 — emit 페이로드의 firedAt용.
fn now_epoch_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 현재 "로컬 벽시계"의 일련초 — 스케줄 비교의 기준 시각.
#[cfg(target_os = "windows")]
fn now_local_secs() -> i64 {
    #[repr(C)]
    struct WinSystemTime {
        w_year: u16,
        w_month: u16,
        w_day_of_week: u16,
        w_day: u16,
        w_hour: u16,
        w_minute: u16,
        w_second: u16,
        w_milliseconds: u16,
    }
    extern "system" {
        fn GetLocalTime(st: *mut WinSystemTime);
    }
    let st = {
        let mut st: WinSystemTime = unsafe { std::mem::zeroed() };
        unsafe { GetLocalTime(&mut st) };
        st
    };
    let _ = (st.w_day_of_week, st.w_milliseconds); // SYSTEMTIME 레이아웃 유지용 미사용 필드
    days_from_civil(st.w_year as i64, st.w_month as i64, st.w_day as i64) * SECS_PER_DAY
        + st.w_hour as i64 * 3600
        + st.w_minute as i64 * 60
        + st.w_second as i64
}

#[cfg(not(target_os = "windows"))]
fn now_local_secs() -> i64 {
    // 폴백: 로컬 오프셋 정보가 없어 UTC를 로컬로 간주 — 대상 OS는 Windows이고
    // 이 경로는 비Windows 빌드/테스트용 최소 구현.
    now_epoch_secs()
}

/// 스케줄러 스레드 본체 — 앱 수명과 동일(detached). 주기마다 due를 emit하고
/// qa_log에 기록한다. emit 실패(수신 리스너 없음)는 무시 — qa_log가 발화의 관찰 정본.
fn reminder_scheduler_loop(app: AppHandle) {
    loop {
        std::thread::sleep(REMINDER_CHECK_INTERVAL);
        let events = {
            let mut sched = lock_schedule();
            drain_due(&mut sched, now_local_secs())
        };
        for ev in events {
            let at_iso = format_local_iso(ev.at);
            qa_write(&format!(
                "reminder :: emit reminderId={} indexId={} at={} repeat={} missed={}",
                ev.reminder_id,
                ev.index_id,
                at_iso,
                ev.repeat.as_str(),
                ev.missed
            ));
            // ARCH §3: guseok://reminder → 전 창. at은 발생 시각의 로컬 ISO,
            // firedAt은 UNIX epoch 초, missed는 재시작 후 과거 미발화분 구분.
            let _ = app.emit(
                "guseok://reminder",
                json!({
                    "indexId": ev.index_id,
                    "reminderId": ev.reminder_id,
                    "at": at_iso,
                    "repeat": ev.repeat.as_str(),
                    "note": ev.note,
                    "missed": ev.missed,
                    "firedAt": now_epoch_secs(),
                }),
            );
        }
    }
}

// ==================== 외부 변경 감지 — mtime 폴링 (TD-04, R-05) ====================
//
// 동기 클라이언트·다른 PC가 바꾼 store.json을 앱이 다시 읽는다. 리마인더와 같은
// detached 스레드 패턴으로 STORE_WATCH_INTERVAL마다 store.json의 스탬프를
// (경로 재해석 포함) 비교한다 — notify 크레이트는 의존성·플랫폼 편차 때문에 보류.
//
// 자기 에코 억제: save_store가 rename 성공 직후의 실제 스탬프를 추적값으로 기록하고,
// 폴링은 그 값과 다른 스탬프만 외부 변경으로 판정한다. 추적값이 "우리가 마지막으로
// 쓴/읽은 상태"인 셈이라 mtime 해상도나 벽시계 추측이 필요 없다.

/// 감시 주기 — 리마인더와 같은 2초: 동기 반영 허용 지연 안이고 stat 한 번의 비용이 없음.
const STORE_WATCH_INTERVAL: Duration = Duration::from_secs(2);

/// 파일 한 번의 관찰 — 존재할 때 mtime + 길이. 파일이 없거나 metadata를 못 읽으면
/// Option 자체가 None이다. len을 보조로 쓰는 이유: FAT(2초)·일부 네트워크 드라이브의
/// mtime 해상도가 같은 시각의 다른 쓰기를 못 가리는 경우를 흡수하기 위해.
/// (같은 mtime + 같은 len의 다른 내용은 해시 없이 못 잡는다 — 읽기 비용 때문에 채택 안 함.)
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct FileStamp {
    modified: SystemTime,
    len: u64,
}

/// p의 현재 스탬프 — 일반 파일이 아니거나 metadata/mtime 조회 실패면 None.
fn file_stamp(p: &Path) -> Option<FileStamp> {
    let md = fs::metadata(p).ok()?;
    if !md.is_file() {
        return None;
    }
    Some(FileStamp {
        modified: md.modified().ok()?,
        len: md.len(),
    })
}

/// 틱의 판정 — 무엇을 할지만 결정하고 파일은 건드리지 않는다(순수).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum WatchDecision {
    /// 스탬프 동일 — 변화 없음 또는 자기 저장 에코 → 아무 것도 하지 않는다.
    Quiet,
    /// 추적값과 다른 파일이 존재 — 읽어서 guseok://store(src:"external")로 전파.
    Reload,
    /// 파일이 사라짐(또는 관찰 불가) — 추적값만 리셋하고 반영하지 않는다.
    /// 빈 내용으로 state를 덮어쓰는 사고를 막고, 재생성은 다음 틱이 Reload로 잡는다.
    Gone,
}

/// (추적 스탬프, 관찰 스탬프) → 판정. 다르면 외부 행위 — 존재하면 Reload, 부재면 Gone.
fn watch_decision(tracked: Option<FileStamp>, current: Option<FileStamp>) -> WatchDecision {
    match current {
        Some(cur) if tracked != Some(cur) => WatchDecision::Reload,
        Some(_) => WatchDecision::Quiet,
        None => match tracked {
            Some(_) => WatchDecision::Gone,
            None => WatchDecision::Quiet,
        },
    }
}

/// 감시 상태 — 감시 중인 경로와 "우리가 아는" 마지막 스탬프.
/// path는 store_path() 재해석과 비교해 set_data_dir 전환을 감지하는 데 쓴다.
#[derive(Default)]
struct WatchState {
    path: Option<PathBuf>,
    stamp: Option<FileStamp>,
}

static STORE_WATCH: OnceLock<Mutex<WatchState>> = OnceLock::new();

fn lock_store_watch() -> MutexGuard<'static, WatchState> {
    STORE_WATCH
        .get_or_init(|| Mutex::new(WatchState::default()))
        .lock()
        // poison돼도 스탬프는 다음 저장/틱에 재설정되는 캐시 — 계속 진행
        .unwrap_or_else(|e| e.into_inner())
}

/// 저장 성공·부팅 초기 로드가 호출하는 추적값 갱신 — "이 스탬프까지는 우리가 안다".
/// 이 값과 다른 관찰만 외부 변경으로 판정되므로 자기 에코가 억제된다.
fn note_store_stamp(path: &Path, stamp: Option<FileStamp>) {
    let mut w = lock_store_watch();
    w.path = Some(path.to_path_buf());
    w.stamp = stamp;
}

/// 틱의 순수 부분 — 경로 전환 감지·자기 에코 억제·추적값 전진을 한 곳에서 한다.
/// 반환: (판정, 읽기 실패 시 복원할 이전 스탬프).
fn watch_tick(
    w: &mut WatchState,
    path: &Path,
    cur: Option<FileStamp>,
) -> (WatchDecision, Option<FileStamp>) {
    if w.path.as_deref() != Some(path) {
        // 첫 틱 또는 set_data_dir 전환 — 이전은 이미 복사·동기화 완료 상태라
        // 새 경로의 현재 스탬프로 조용히 재기준한다(emit 없음).
        w.path = Some(path.to_path_buf());
        w.stamp = cur;
        return (WatchDecision::Quiet, cur);
    }
    let prev = w.stamp;
    let d = watch_decision(prev, cur);
    match d {
        WatchDecision::Quiet => {}
        WatchDecision::Gone => w.stamp = None,
        WatchDecision::Reload => w.stamp = cur, // 읽기 실패 시 호출부가 되돌린다
    }
    (d, prev)
}

/// mtime 폴링 루프 — 앱 수명과 동일(detached). 외부 변경을 감지하면 파일을 읽어
/// guseok://store{src:"external", raw}를 전 창에 emit한다. JS 쪽은 src가 창 라벨과
/// 달라 기존 리스너가 migrate() 경유로 그대로 반영한다 (신규 경로 최소화, TD-04).
fn store_watch_loop(app: AppHandle) {
    let mut read_fail_streak = 0u32;
    loop {
        std::thread::sleep(STORE_WATCH_INTERVAL);
        let Ok(p) = store_path(&app) else {
            continue;
        };
        let cur = file_stamp(&p);
        let (decision, prev_stamp) = {
            let mut w = lock_store_watch();
            watch_tick(&mut w, &p, cur)
        };
        match decision {
            WatchDecision::Quiet => read_fail_streak = 0,
            WatchDecision::Gone => {
                read_fail_streak = 0;
                qa_write(&format!("store-watch :: gone {}", p.display()));
            }
            WatchDecision::Reload => match fs::read_to_string(&p) {
                Ok(raw) => {
                    read_fail_streak = 0;
                    if raw.trim().is_empty() {
                        // 반영할 내용이 없다 — 스탬프는 전진 유지(후속 쓰기는 새 스탬프).
                        qa_write(&format!("store-watch :: empty {}", p.display()));
                    } else if serde_json::from_str::<serde_json::Value>(&raw).is_err() {
                        // 동기 클라이언트의 중간 상태(반쯤 쓰인 파일) — 무효 내용을
                        // 브로드캐스트하지 않는다. 완성 쓰기는 스탬프가 달라 재감지된다.
                        qa_write(&format!("store-watch :: invalid {}", p.display()));
                    } else {
                        qa_write(&format!(
                            "store-watch :: reload {} bytes={}",
                            p.display(),
                            raw.len()
                        ));
                        let payload = json!({ "src": "external", "raw": raw }).to_string();
                        let _ = app.emit("guseok://store", payload);
                    }
                }
                Err(e) => {
                    // 읽기 실패(동기 클라이언트가 점유·복사 중) — 스탬프를 되돌려
                    // 다음 틱에 재시도한다. 그 사이 우리 쪽 저장 등이 스탬프를
                    // 갱신했으면 되돌리지 않는다.
                    {
                        let mut w = lock_store_watch();
                        if w.path.as_deref() == Some(p.as_path()) && w.stamp == cur {
                            w.stamp = prev_stamp;
                        }
                    }
                    read_fail_streak = read_fail_streak.saturating_add(1);
                    // 연속 실패는 첫 번만 기록 — 장기 점유에서 로그가 무한 증식하지 않게.
                    if read_fail_streak == 1 {
                        qa_write(&format!("store-watch :: read-fail {} {e}", p.display()));
                    }
                }
            },
        }
    }
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

/// selftest가 CDP 없이 스케줄러 발화 라인을 읽을 수 있게 qa 로그 경로를 반환한다.
#[tauri::command]
fn qa_log_path() -> String {
    std::env::temp_dir()
        .join("guseok-qa.log")
        .to_string_lossy()
        .into_owned()
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
            get_data_dir,
            set_data_dir,
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
            qa_log_path,
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
            // TD-07: 부팅 시 디스크 store로 리마인더 스케줄 초기화(load_store와 같은
            // 읽기 경로) — 이후 갱신은 save_store가 저장본 파싱으로 담당한다.
            // 스레드는 detached — 트레이 상주 앱이라 수명은 앱과 동일.
            {
                let raw = load_store_raw(&handle);
                update_schedule_from_store(&raw);
                let sched_app = handle.clone();
                std::thread::spawn(move || reminder_scheduler_loop(sched_app));
            }
            // TD-04: 외부 변경 감시 — 부팅 로드 직후의 파일 상태가 "우리가 아는" 기준
            // 스탬프. store_path가 포인터를 매번 재해석하므로 set_data_dir 전환도
            // 스레드가 자동으로 따라간다(경로 변경 시 조용히 재기준).
            if let Ok(p) = store_path(&handle) {
                note_store_stamp(&p, file_stamp(&p));
            }
            {
                let watch_app = handle.clone();
                std::thread::spawn(move || store_watch_loop(watch_app));
            }
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

    // ---- 리마인더 스케줄러 (phase-03-task-01, TD-07) ----

    /// 로컬 일련초 작성 헬퍼.
    fn local(y: i64, mo: i64, d: i64, h: i64, mi: i64, s: i64) -> i64 {
        days_from_civil(y, mo, d) * SECS_PER_DAY + h * 3600 + mi * 60 + s
    }

    fn raw(
        index_id: &str,
        id: &str,
        at: &str,
        repeat: &str,
        enabled: bool,
        last: Option<&str>,
    ) -> RawReminder {
        RawReminder {
            index_id: index_id.into(),
            id: id.into(),
            at: at.into(),
            repeat: repeat.into(),
            note: String::new(),
            enabled,
            last_fired_at: last.map(str::to_string),
        }
    }

    #[test]
    fn civil_days_roundtrip() {
        // 알려진 값: epoch 0, 2000-01-01 = 10957일.
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 1, 1), 10957);
        for &(y, m, d) in &[
            (1970, 1, 1),
            (1969, 12, 31),
            (1999, 12, 31),
            (2000, 2, 29),
            (2024, 2, 29),
            (2026, 11, 19),
            (2100, 3, 1),
        ] {
            assert_eq!(civil_from_days(days_from_civil(y, m, d)), (y, m, d));
        }
    }

    #[test]
    fn parse_local_iso_variants() {
        let expect = local(2026, 11, 19, 9, 0, 0);
        assert_eq!(parse_local_iso("2026-11-19T09:00"), Some(expect));
        assert_eq!(parse_local_iso("2026-11-19 09:00"), Some(expect));
        assert_eq!(parse_local_iso("2026-11-19T09:00:30"), Some(expect + 30));
        assert_eq!(
            parse_local_iso("2026-11-19"),
            Some(local(2026, 11, 19, 0, 0, 0))
        );
        // 초 이후 접미는 무시
        assert_eq!(parse_local_iso("2026-11-19T09:00:00Z"), Some(expect));
        for bad in [
            "",
            "junk",
            "2026-13-19T09:00",
            "2026-11-19T25:00",
            "2026/11/19",
            "2026-11-19T09",
            "2026-11-19X09:00",
        ] {
            assert_eq!(parse_local_iso(bad), None, "{bad}");
        }
    }

    #[test]
    fn format_local_iso_roundtrip() {
        let s = local(2026, 11, 19, 9, 30, 15);
        assert_eq!(format_local_iso(s), "2026-11-19T09:30:15");
        assert_eq!(parse_local_iso(&format_local_iso(s)), Some(s));
    }

    #[test]
    fn plan_once_schedules_missed_and_done() {
        let now = local(2026, 11, 19, 12, 0, 0);
        // 미래 → 예약
        assert_eq!(
            plan_reminder(now + 3600, Repeat::Once, None, true, now),
            (Some(now + 3600), None)
        );
        // 과거 미발화 → 자동 발화가 아니라 놓침 보고
        assert_eq!(
            plan_reminder(now - 3600, Repeat::Once, None, true, now),
            (None, Some(now - 3600))
        );
        // 과거이나 last_fired >= at → 이미 발화 → inert (중복 발화 방지)
        assert_eq!(
            plan_reminder(now - 3600, Repeat::Once, Some(now - 1800), true, now),
            (None, None)
        );
        // 비활성 → inert
        assert_eq!(
            plan_reminder(now + 3600, Repeat::Once, None, false, now),
            (None, None)
        );
    }

    #[test]
    fn plan_daily_reports_latest_missed_and_next() {
        let at = local(2026, 11, 17, 9, 0, 0); // daily — T_k: 매일 09:00
        let now = local(2026, 11, 19, 12, 0, 0);
        // lastFiredAt 없음 → pending = 17일 09시 <= now: 최근 놓침 19일 09시, next 20일 09시
        let (next, missed) = plan_reminder(at, Repeat::Daily, None, true, now);
        assert_eq!(missed, Some(local(2026, 11, 19, 9, 0, 0)));
        assert_eq!(next, Some(local(2026, 11, 20, 9, 0, 0)));
        // last_fired 18일 10시 → 첫 미발화 pending은 19일 09시
        let (next2, missed2) = plan_reminder(
            at,
            Repeat::Daily,
            Some(local(2026, 11, 18, 10, 0, 0)),
            true,
            now,
        );
        assert_eq!(missed2, Some(local(2026, 11, 19, 9, 0, 0)));
        assert_eq!(next2, Some(local(2026, 11, 20, 9, 0, 0)));
        // last_fired가 오늘 10시 이후 → 다음 발생은 내일, 놓침 없음
        let (next3, missed3) = plan_reminder(
            at,
            Repeat::Daily,
            Some(local(2026, 11, 19, 10, 0, 0)),
            true,
            now,
        );
        assert_eq!(missed3, None);
        assert_eq!(next3, Some(local(2026, 11, 20, 9, 0, 0)));
        // 비활성 → inert
        assert_eq!(
            plan_reminder(at, Repeat::Daily, None, false, now),
            (None, None)
        );
    }

    #[test]
    fn plan_weekly_uses_seven_day_period() {
        let at = local(2026, 11, 3, 9, 0, 0); // weekly — T_k: 11/3, 11/10, 11/17, 11/24
        let now = local(2026, 11, 19, 12, 0, 0);
        let (next, missed) = plan_reminder(at, Repeat::Weekly, None, true, now);
        assert_eq!(missed, Some(local(2026, 11, 17, 9, 0, 0)));
        assert_eq!(next, Some(local(2026, 11, 24, 9, 0, 0)));
    }

    #[test]
    fn drain_due_fires_once_then_done() {
        let mut sched = HashMap::new();
        let now = local(2026, 11, 19, 12, 0, 0);
        sched.insert(
            "r1".into(),
            SchedEntry {
                index_id: "i1".into(),
                reminder_id: "r1".into(),
                note: "n".into(),
                repeat: Repeat::Once,
                anchor_at: now - 60,
                next_at: Some(now - 60),
                missed_at: None,
                last_fired_at: None,
            },
        );
        let ev = drain_due(&mut sched, now);
        assert_eq!(ev.len(), 1);
        assert!(!ev[0].missed && ev[0].at == now - 60 && ev[0].reminder_id == "r1");
        // none은 발화 후 next_at = None → 같은/다음 틱에도 재발화 없음
        assert!(drain_due(&mut sched, now + 1).is_empty());
        assert_eq!(sched["r1"].last_fired_at, Some(now));
    }

    #[test]
    fn drain_due_daily_advances_next() {
        let mut sched = HashMap::new();
        let at = local(2026, 11, 19, 9, 0, 0);
        let now = at + 5;
        sched.insert(
            "r2".into(),
            SchedEntry {
                index_id: "i1".into(),
                reminder_id: "r2".into(),
                note: String::new(),
                repeat: Repeat::Daily,
                anchor_at: at,
                next_at: Some(at),
                missed_at: None,
                last_fired_at: None,
            },
        );
        let ev = drain_due(&mut sched, now);
        assert_eq!(ev.len(), 1);
        // 발화 후 다음 at 자동 계산 — 다음날 같은 벽시계
        assert_eq!(sched["r2"].next_at, Some(at + SECS_PER_DAY));
        assert!(drain_due(&mut sched, now + 60).is_empty());
    }

    #[test]
    fn sync_missed_reported_once() {
        // 과거 미발화분은 놓침으로 한 번만 보고 — 같은 디스크 상태 재동기화에 재보고 없음.
        let mut sched = HashMap::new();
        let now = local(2026, 11, 19, 12, 0, 0);
        let raws = vec![raw("i1", "r1", "2026-11-19T09:00", "none", true, None)];
        sync_schedule(&mut sched, &raws, now);
        assert_eq!(sched["r1"].missed_at, Some(local(2026, 11, 19, 9, 0, 0)));
        let ev = drain_due(&mut sched, now + 1);
        assert_eq!(ev.len(), 1);
        assert!(ev[0].missed && ev[0].at == local(2026, 11, 19, 9, 0, 0));
        sync_schedule(&mut sched, &raws, now + 2);
        assert!(sched["r1"].missed_at.is_none());
        assert!(drain_due(&mut sched, now + 3).is_empty());
    }

    #[test]
    fn sync_fired_once_not_resurrected_by_stale_disk() {
        // 중복 발화 방지 회귀: 발화 직후 JS가 lastFiredAt을 쓰기 전에 저장이 일어나면
        // 디스크는 "at 과거 + lastFiredAt null"로 되돌아간다 — 인메모리 last_fired
        // 병합으로 inert를 유지해 재발화/재놓침 보고를 막는다.
        let mut sched = HashMap::new();
        let raws = vec![raw("i1", "r1", "2026-11-19T11:59", "none", true, None)];
        sync_schedule(&mut sched, &raws, local(2026, 11, 19, 11, 58, 0)); // at이 미래일 때 동기화
        assert_eq!(sched["r1"].next_at, Some(local(2026, 11, 19, 11, 59, 0)));
        let ev = drain_due(&mut sched, local(2026, 11, 19, 11, 59, 30)); // 정상 발화
        assert_eq!(ev.len(), 1);
        sync_schedule(&mut sched, &raws, local(2026, 11, 19, 12, 0, 0)); // 오래된 디스크 재동기화
        assert!(sched["r1"].missed_at.is_none() && sched["r1"].next_at.is_none());
        assert!(drain_due(&mut sched, local(2026, 11, 19, 12, 0, 30)).is_empty());
    }

    #[test]
    fn sync_removes_deleted_and_adds_new() {
        let mut sched = HashMap::new();
        let now = local(2026, 11, 19, 12, 0, 0);
        let raws = vec![raw("i1", "r1", "2026-11-20T09:00", "none", true, None)];
        sync_schedule(&mut sched, &raws, now);
        assert!(sched.contains_key("r1"));
        // 디스크에서 사라지면 스케줄에서도 제거
        sync_schedule(&mut sched, &[], now);
        assert!(sched.is_empty());
        // 새 리마인더 등장 → 반영 (daily 미래 → 예약)
        let raws2 = vec![raw("i2", "r9", "2026-11-20T10:00", "daily", true, None)];
        sync_schedule(&mut sched, &raws2, now);
        assert_eq!(sched["r9"].next_at, Some(local(2026, 11, 20, 10, 0, 0)));
        assert_eq!(sched["r9"].index_id, "i2");
    }

    #[test]
    fn reminders_from_store_nested() {
        let raw = r#"{"version":2,"indexes":[
            {"id":"i1","reminders":[
                {"id":"r1","at":"2026-11-20T09:00","repeat":"daily","note":"a","enabled":false,"lastFiredAt":"2026-11-19T09:00"},
                {"id":"r2","at":"2026-11-20T10:00"},
                {"at":"no-id"}]},
            {"id":"i2"},
            "junk"]}"#;
        let rs = reminders_from_store(raw);
        assert_eq!(rs.len(), 2);
        assert_eq!(rs[0].index_id, "i1");
        assert!(!rs[0].enabled);
        assert_eq!(rs[0].last_fired_at.as_deref(), Some("2026-11-19T09:00"));
        assert!(rs[1].enabled); // enabled 누락 → 기본 true (defaultReminder와 동일)
        assert_eq!(reminders_from_store("not json").len(), 0);
        assert_eq!(reminders_from_store("{}").len(), 0);
    }

    // ---- 저장 폴더 지정 (phase-04-task-01, TD-05) ----

    /// 테스트 격리용 임시 앱 데이터 dir — 실제 %APPDATA%를 건드리지 않는다.
    fn datadir_fixture(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "guseok-datadir-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn pointer_absent_or_broken_resolves_default() {
        let app = datadir_fixture("resolve-default");
        let cfg = config_path(&app);
        // config.json 없음 → 기본
        assert_eq!(resolve_store_dir(&app, &cfg), app);
        // 손상된 JSON → 기본
        fs::write(&cfg, b"{not json").unwrap();
        assert_eq!(resolve_store_dir(&app, &cfg), app);
        // dataDir 누락·null·비문자열·빈 문자열 → 기본
        for body in [
            "{}",
            "{\"dataDir\":null}",
            "{\"dataDir\":42}",
            "{\"dataDir\":\"  \"}",
            "[]",
        ] {
            fs::write(&cfg, body).unwrap();
            assert_eq!(resolve_store_dir(&app, &cfg), app, "{body}");
        }
        let _ = fs::remove_dir_all(&app);
    }

    #[test]
    fn pointer_valid_resolves_custom_and_missing_falls_back() {
        let app = datadir_fixture("resolve-app");
        let custom = datadir_fixture("resolve-custom");
        let cfg = config_path(&app);
        // 유효 폴더 → 지정 경로 (재해석마다 파일을 다시 읽으므로 재시작 후에도 유지)
        write_data_dir_pointer(&cfg, Some(&custom)).unwrap();
        assert_eq!(resolve_store_dir(&app, &cfg), custom);
        // 지정 폴더가 사라지면 다음 해석부터 기본으로 폴백
        fs::remove_dir_all(&custom).unwrap();
        assert_eq!(resolve_store_dir(&app, &cfg), app);
        let _ = fs::remove_dir_all(&app);
    }

    #[test]
    fn check_dir_writable_probe() {
        let dir = datadir_fixture("writable");
        check_dir_writable(&dir).unwrap();
        // 시험 파일이 잔재로 남지 않는다
        assert!(fs::read_dir(&dir).unwrap().next().is_none());
        // 디렉터리가 아닌 경로(파일)와 미존재 경로는 Err
        let file = dir.join("f.txt");
        fs::write(&file, b"x").unwrap();
        assert!(check_dir_writable(&file).is_err());
        assert!(check_dir_writable(&dir.join("missing-sub")).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_pointer_roundtrip_and_preserves_unknown_keys() {
        let app = datadir_fixture("pointer");
        let cfg = config_path(&app);
        // 기존 파일의 알 수 없는 키는 보존
        fs::write(&cfg, "{\"otherKey\":1,\"dataDir\":\"D:\\\\old\"}").unwrap();
        let custom = datadir_fixture("pointer-target");
        write_data_dir_pointer(&cfg, Some(&custom)).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&cfg).unwrap()).unwrap();
        assert_eq!(v["otherKey"], 1);
        assert_eq!(configured_data_dir(&cfg).as_deref(), Some(custom.as_path()));
        // 해제 → dataDir null
        write_data_dir_pointer(&cfg, None).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&cfg).unwrap()).unwrap();
        assert!(v["dataDir"].is_null());
        assert_eq!(configured_data_dir(&cfg), None);
        let _ = fs::remove_dir_all(&app);
        let _ = fs::remove_dir_all(&custom);
    }

    #[test]
    fn copy_store_to_dir_copies_and_preserves() {
        let from = datadir_fixture("copy-from");
        let to = datadir_fixture("copy-to");
        fs::write(from.join("store.json"), b"{\"v\":1}").unwrap();
        fs::write(from.join("store.bak.json"), b"{\"v\":0}").unwrap();
        // 대상이 비어 있으면 .bak도 함께 옮겨 읽기 폴백을 유지
        assert!(copy_store_to_dir(&from, &to).unwrap());
        assert_eq!(fs::read(to.join("store.json")).unwrap(), b"{\"v\":1}");
        assert_eq!(fs::read(to.join("store.bak.json")).unwrap(), b"{\"v\":0}");
        // 원본 보존 — 이전은 복사이지 이동이 아니다
        assert!(from.join("store.json").exists());
        // 대상에 기존 store.json이 있으면 그것을 .bak로 보존한 뒤 덮어쓴다
        fs::write(from.join("store.json"), b"{\"v\":2}").unwrap();
        assert!(copy_store_to_dir(&from, &to).unwrap());
        assert_eq!(fs::read(to.join("store.json")).unwrap(), b"{\"v\":2}");
        assert_eq!(fs::read(to.join("store.bak.json")).unwrap(), b"{\"v\":1}");
        // 원본이 없으면 Ok(false) — 대상 그대로
        let empty = datadir_fixture("copy-empty");
        assert!(!copy_store_to_dir(&empty, &to).unwrap());
        let _ = fs::remove_dir_all(&from);
        let _ = fs::remove_dir_all(&to);
        let _ = fs::remove_dir_all(&empty);
    }

    #[test]
    fn set_data_dir_impl_full_roundtrip() {
        let app = datadir_fixture("impl-app");
        let custom = datadir_fixture("impl-custom");
        fs::write(app.join("store.json"), b"{\"version\":2}").unwrap();
        // 지정 → 복사 + 포인터 갱신 + effectivePath 전환
        let info = set_data_dir_impl(&app, Some(custom.to_str().unwrap())).unwrap();
        assert!(!info.is_default);
        assert_eq!(info.path.as_deref(), Some(custom.to_str().unwrap()));
        assert_eq!(PathBuf::from(&info.effective_path), custom);
        assert!(custom.join("store.json").exists());
        assert!(app.join("store.json").exists()); // 원본 보존
                                                  // 해제 → 기본으로 복사 복귀 + 포인터 null
        let info2 = set_data_dir_impl(&app, None).unwrap();
        assert!(info2.is_default);
        assert_eq!(info2.path, None);
        assert_eq!(
            fs::read(app.join("store.json")).unwrap(),
            b"{\"version\":2}"
        );
        assert!(custom.join("store.json").exists()); // 지정 폴더 쪽도 보존
        let _ = fs::remove_dir_all(&app);
        let _ = fs::remove_dir_all(&custom);
    }

    #[test]
    fn set_data_dir_impl_rejects_and_keeps_state() {
        let app = datadir_fixture("impl-fail");
        let custom = datadir_fixture("impl-current");
        fs::write(app.join("store.json"), b"{}").unwrap();
        set_data_dir_impl(&app, Some(custom.to_str().unwrap())).unwrap();
        // 미존재 경로 → Err, 포인터·데이터 그대로
        let missing = app.join("no-such-dir");
        assert!(set_data_dir_impl(&app, Some(missing.to_str().unwrap())).is_err());
        let info = data_dir_info(&app);
        assert_eq!(PathBuf::from(&info.effective_path), custom);
        // 파일(디렉터리 아님)·빈 경로도 Err
        let file = app.join("f.txt");
        fs::write(&file, b"x").unwrap();
        assert!(set_data_dir_impl(&app, Some(file.to_str().unwrap())).is_err());
        assert!(set_data_dir_impl(&app, Some("   ")).is_err());
        // 기본 dir 지정은 포인터 해제와 동치 — null 정규화 + 기본으로 복귀
        let info2 = set_data_dir_impl(&app, Some(app.to_str().unwrap())).unwrap();
        assert!(info2.is_default);
        assert_eq!(info2.path, None);
        assert!(app.join("store.json").exists());
        let _ = fs::remove_dir_all(&app);
        let _ = fs::remove_dir_all(&custom);
    }

    // ---- 외부 변경 감지 — mtime 폴링 (phase-04-task-02, TD-04) ----

    /// epoch+ms, len으로 스탬프를 만드는 헬퍼.
    fn stamp(ms: u64, len: u64) -> Option<FileStamp> {
        Some(FileStamp {
            modified: UNIX_EPOCH + Duration::from_millis(ms),
            len,
        })
    }

    #[test]
    fn watch_decision_same_stamp_is_quiet_self_echo() {
        // save_store가 기록한 추적값과 관찰값이 같으면 자기 에코 — 억제된다.
        assert_eq!(
            watch_decision(stamp(1000, 10), stamp(1000, 10)),
            WatchDecision::Quiet
        );
        // 둘 다 부재(파일이 아직 없는 상태 유지)도 조용하다.
        assert_eq!(watch_decision(None, None), WatchDecision::Quiet);
    }

    #[test]
    fn watch_decision_new_stamp_is_reload() {
        // 다른 mtime → 외부 변경
        assert_eq!(
            watch_decision(stamp(1000, 10), stamp(2000, 10)),
            WatchDecision::Reload
        );
        // mtime이 같아도 len이 다르면 변경 — 해상도 한계(FAT·네트워크) 보완
        assert_eq!(
            watch_decision(stamp(1000, 10), stamp(1000, 11)),
            WatchDecision::Reload
        );
        // 부재 → 생성도 외부 변경(동기 폴더에 새로 놓인 파일)
        assert_eq!(watch_decision(None, stamp(500, 3)), WatchDecision::Reload);
    }

    #[test]
    fn watch_decision_gone_is_not_reload() {
        // 파일 삭제는 리로드가 아니다 — 빈 내용으로 덮어쓰지 않게 추적만 리셋.
        assert_eq!(watch_decision(stamp(1000, 10), None), WatchDecision::Gone);
    }

    #[test]
    fn watch_tick_rebases_on_first_and_path_change() {
        let mut w = WatchState::default();
        let a = Path::new("a");
        let b = Path::new("b");
        // 첫 틱(미초기화) — emit 없이 기준만 잡는다
        let (d, _) = watch_tick(&mut w, a, stamp(100, 1));
        assert_eq!(d, WatchDecision::Quiet);
        assert_eq!(w.path.as_deref(), Some(a));
        assert_eq!(w.stamp, stamp(100, 1));
        // 같은 경로 + 같은 스탬프 → Quiet
        assert_eq!(watch_tick(&mut w, a, stamp(100, 1)).0, WatchDecision::Quiet);
        // 같은 경로 + 다른 스탬프 → Reload, 추적값 전진·복원용 이전값 반환
        let (d, prev) = watch_tick(&mut w, a, stamp(200, 1));
        assert_eq!(d, WatchDecision::Reload);
        assert_eq!(prev, stamp(100, 1));
        assert_eq!(w.stamp, stamp(200, 1));
        // 경로 전환(set_data_dir) — 이전은 복사 완료라 조용히 재기준
        let (d, _) = watch_tick(&mut w, b, stamp(999, 9));
        assert_eq!(d, WatchDecision::Quiet);
        assert_eq!(w.path.as_deref(), Some(b));
        assert_eq!(w.stamp, stamp(999, 9));
    }

    #[test]
    fn watch_tick_gone_then_recreate_is_reload() {
        let mut w = WatchState::default();
        let a = Path::new("a");
        watch_tick(&mut w, a, stamp(100, 1));
        let (d, _) = watch_tick(&mut w, a, None);
        assert_eq!(d, WatchDecision::Gone);
        assert_eq!(w.stamp, None);
        // 재생성(삭제→다시 놓기)은 다음 틱에 Reload로 잡힌다
        let (d, _) = watch_tick(&mut w, a, stamp(300, 2));
        assert_eq!(d, WatchDecision::Reload);
    }

    #[test]
    fn watch_tick_reload_advances_stamp_once() {
        // Reload 후 같은 관찰이 계속되면 Quiet — 한 파일로 반복 emit하지 않는다.
        let mut w = WatchState::default();
        let a = Path::new("a");
        watch_tick(&mut w, a, stamp(100, 1));
        assert_eq!(
            watch_tick(&mut w, a, stamp(200, 2)).0,
            WatchDecision::Reload
        );
        assert_eq!(watch_tick(&mut w, a, stamp(200, 2)).0, WatchDecision::Quiet);
    }

    #[test]
    fn file_stamp_real_fs_states() {
        let dir = datadir_fixture("watch-stamp");
        let f = dir.join("store.json");
        // 부재 → None
        assert_eq!(file_stamp(&f), None);
        // 파일 → Some, len 반영
        fs::write(&f, b"{}").unwrap();
        let s = file_stamp(&f);
        assert!(s.is_some());
        assert_eq!(s.unwrap().len, 2);
        // 디렉터리는 파일이 아니다 → None
        assert_eq!(file_stamp(&dir), None);
        let _ = fs::remove_dir_all(&dir);
    }
}
