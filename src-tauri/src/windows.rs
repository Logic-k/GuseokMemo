use serde_json::json;
use std::str::FromStr;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::qa_write;
use crate::win32::work_area;

pub(crate) fn open_settings_with(app: &AppHandle, tab: Option<&str>) -> Result<(), String> {
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
pub fn open_settings(app: AppHandle) -> Result<(), String> {
    open_settings_with(&app, None)
}

#[tauri::command]
pub fn show_panel(
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
pub fn hide_panel(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("panel") {
        let _ = win.hide();
    }
    let _ = app.emit("guseok://panel-closed", json!({}));
    Ok(())
}

// ==================== 전체 검색 창 (R-01, DESIGN D-1) ====================

/// 검색 창 고정 크기 — setup의 inner_size와 동일 값(리사이즈 불가 창이라
/// 매번 set_size는 불필요, 위치만 show 때 맞춘다).
pub(crate) const SEARCH_W: f64 = 460.0;
pub(crate) const SEARCH_H: f64 = 400.0;

/// 검색 창을 커서가 있는 모니터의 작업 영역 안에 띄운다 — 가로 중앙, 세로는
/// 위쪽 38% 지점(검색 팔레트가 화면 상단 1/3에 오는 관습). 창은 setup에서
/// 미리 생성됐고 여기서는 위치만 맞춰 show+focus — 런타임 생성 금지(NFR-06/BUG-18).
#[tauri::command]
pub fn show_search(app: AppHandle) -> Result<(), String> {
    let w = app
        .get_webview_window("search")
        .ok_or("search window missing")?;
    let wa = work_area(app.clone(), "auto".to_string())?;
    let x = wa.x + (wa.w - SEARCH_W) / 2.0;
    let y = wa.y + (wa.h - SEARCH_H) * 0.38;
    w.set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    w.show().map_err(|e| e.to_string())?;
    w.set_focus().map_err(|e| e.to_string())?;
    // 입력 포커스·기존 쿼리 전체선택·재검색은 창 쪽 JS가 수행
    // (guseok://panel-open과 같은 통지 패턴).
    let _ = w.emit("guseok://search-open", json!({}));
    Ok(())
}

#[tauri::command]
pub fn hide_search(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("search") {
        let _ = w.hide();
    }
    Ok(())
}

// ==================== 앱 내 토스트 창 (R-02/03, DESIGN D-2, OQ-02) ====================
//
// OQ-02 확정 = 앱 내 토스트 단일. handles.js가 발화 큐를 소유하고, 이 커맨드로
// 스트립 옆 위치·표시를 지시한다 — 창 자체는 setup에서 미리 생성해 hide/show
// 재사용(NFR-06, BUG-18 회귀 방지). 내용(렌더·클릭 라우팅)은 toast.js가 담당.
#[tauri::command]
pub fn place_toast(
    app: AppHandle,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    visible: bool,
) -> Result<(), String> {
    let win = app
        .get_webview_window("toast")
        .ok_or("toast window missing")?;
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

// ==================== 템플릿 선택 창 (R-06, DESIGN D-5) ====================
//
// 스트립 `+` 클릭 시 패널 위치에 뜨는 작은 선택 창 — handles.js가 위치·표시를
// 지시하고 창 내용(템플릿 목록 렌더)은 pick.js가 담당한다. 창은 setup에서 미리
// 생성해 hide/show로 재사용한다(NFR-06, BUG-18 회귀 방지). 표시할 때 포커스를
// 가져가야 Esc 취소·외부 클릭(포커스 상실) 닫힘이 동작한다 — 선택창이라
// 토스트와 달리 일시적 포커스 점유가 의도된 동작이다.
#[tauri::command]
pub fn place_pick(
    app: AppHandle,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    visible: bool,
) -> Result<(), String> {
    let win = app
        .get_webview_window("pick")
        .ok_or("pick window missing")?;
    if visible {
        win.set_size(LogicalSize::new(w, h))
            .map_err(|e| e.to_string())?;
        win.set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        win.show().map_err(|e| e.to_string())?;
        let _ = win.set_focus();
        // 목록 재렌더·openedAt 갱신은 창 쪽 JS가 수행 (guseok://search-open과 같은 패턴).
        let _ = win.emit("guseok://pick-open", json!({}));
    } else {
        let _ = win.hide();
    }
    Ok(())
}

#[tauri::command]
pub fn place_handles(
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

/// 전역 단축키 목록 — toggle(열기)은 preset, prev/next는 고정, search는
/// search_preset(common.searchKey). 검색 키 옵션은 열기 프리셋과 겹치지 않는
/// 별도 키셋이라 중복 등록이 구조적으로 불가능하다 (D-1: 기본 Ctrl+Shift+F).
fn shortcut_keys(preset: &str, search_preset: &str) -> Vec<(String, String)> {
    let toggle = match preset {
        "alt_m" => "Ctrl+Alt+KeyM",
        "shift_space" => "Ctrl+Shift+Space",
        "f9" => "F9",
        _ => "Ctrl+Shift+KeyM",
    };
    let search = match search_preset {
        "ctrl_f" => "Ctrl+KeyF",
        "alt_f" => "Ctrl+Alt+KeyF",
        "f3" => "F3",
        _ => "Ctrl+Shift+KeyF",
    };
    vec![
        ("toggle".to_string(), toggle.to_string()),
        ("prev".to_string(), "Ctrl+Shift+ArrowUp".to_string()),
        ("next".to_string(), "Ctrl+Shift+ArrowDown".to_string()),
        ("search".to_string(), search.to_string()),
    ]
}

#[tauri::command]
pub fn register_shortcuts(
    app: AppHandle,
    preset: String,
    enabled: bool,
    search_key: Option<String>,
) -> Result<(), String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    if !enabled {
        return Ok(());
    }
    for (action, key) in shortcut_keys(&preset, search_key.as_deref().unwrap_or("ctrl_shift_f")) {
        let sc = Shortcut::from_str(&key).map_err(|e| format!("{key}: {e}"))?;
        let act = action.clone();
        let res = gs.on_shortcut(sc, move |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                let _ = app.emit("guseok://shortcut", json!({ "action": act }));
            }
        });
        // 검색 키만 점유 실패해도 열기/순환 키는 유지 — 경고만 남기고 계속 진행한다
        // (열기 단축키는 앱의 핵심 진입점이라 하드 실패, 검색은 추가 기능이라 강등).
        if let Err(e) = res {
            if action == "search" {
                qa_write(&format!("WARN shortcuts :: search {key}: {e}"));
            } else {
                return Err(e.to_string());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcut_keys_bind_search_presets() {
        // 기본 Ctrl+Shift+F + 프리셋 매핑 + 알 수 없는 값 폴백.
        let base = shortcut_keys("ctrl_shift_m", "ctrl_shift_f");
        assert_eq!(base.len(), 4);
        assert!(base
            .iter()
            .any(|(a, k)| a == "search" && k == "Ctrl+Shift+KeyF"));
        for (preset, want) in [
            ("ctrl_f", "Ctrl+KeyF"),
            ("alt_f", "Ctrl+Alt+KeyF"),
            ("f3", "F3"),
            ("nonsense", "Ctrl+Shift+KeyF"),
        ] {
            assert!(
                shortcut_keys("x", preset)
                    .iter()
                    .any(|(a, k)| a == "search" && k == want),
                "{preset}"
            );
        }
        // 네 항목의 키가 서로 겹치지 않아야 한다 (중복 등록 실패 방지).
        let mut seen = std::collections::HashSet::new();
        assert!(base.iter().all(|(_, k)| seen.insert(k.clone())));
    }

    // ---- 리마인더 스케줄러 (phase-03-task-01, TD-07) ----
}
