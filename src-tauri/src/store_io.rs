use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::qa_write;
use crate::scheduler::{
    format_local_iso, now_epoch_secs, now_local_secs, update_schedule_from_store,
};

pub(crate) fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
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
pub(crate) fn load_store_raw(app: &AppHandle) -> String {
    match store_path(app) {
        Ok(p) => read_store_contents(&p),
        Err(_) => String::new(),
    }
}

#[tauri::command]
pub fn load_store(app: AppHandle) -> Result<String, String> {
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
pub fn save_store(app: AppHandle, webview: WebviewWindow, json: String) -> Result<(), String> {
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
pub struct DataDirInfo {
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
pub fn get_data_dir(app: AppHandle) -> Result<DataDirInfo, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(data_dir_info(&dir))
}

/// 저장 폴더 지정/해제 — Some(dir): 존재·쓰기 확인 → 기존 store.json 복사·검증 →
/// 포인터 갱신. None: 포인터 해제 후 기본 경로로 복귀(마찬가지로 복사 후 전환).
/// 미존재·쓰기 불가·복사 실패는 Err — 기존 경로·데이터는 그대로 유지된다.
#[tauri::command]
pub fn set_data_dir(app: AppHandle, path: Option<String>) -> Result<(), String> {
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
pub fn open_data_dir(app: AppHandle) -> Result<(), String> {
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
pub fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(path, content).map_err(|e| e.to_string())
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
pub(crate) struct FileStamp {
    modified: SystemTime,
    len: u64,
}

/// p의 현재 스탬프 — 일반 파일이 아니거나 metadata/mtime 조회 실패면 None.
pub(crate) fn file_stamp(p: &Path) -> Option<FileStamp> {
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
pub(crate) fn note_store_stamp(path: &Path, stamp: Option<FileStamp>) {
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
pub(crate) fn store_watch_loop(app: AppHandle) {
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

// ==================== 동기 충돌 — 충돌본 보관 (OQ-03, R-05) ====================
//
// 외부 변경(src:"external")을 적용할 때 로컬 미저장 편집이 덮어쓰이면, 덮어쓰이는
// 로컬 저장본 전체를 store.json 옆의 store.conflict-<로컬시각>.json으로 보관한다.
// 충돌 판정은 JS(store.js)의 몫 — Rust는 보관 파일의 원자적 쓰기만 담당한다.
// 감시 루프는 store.json의 스탬프만 보므로 충돌본 쓰기가 리로드를 유발하지 않고,
// set_data_dir 이전은 store.json만 옮기므로 충돌본은 생성된 폴더에 그대로 남는다
// (콜드 백업 — 이전 대상에서 의도적으로 제외).

/// 충돌본 파일명 — n=0이면 `store.conflict-<stamp>.json`, 이후는 -2, -3… 순번.
/// stamp는 로컬 벽시계(conflict_stamp), 파일명 불가 문자가 없다.
fn conflict_file_name(stamp: &str, n: u32) -> String {
    if n == 0 {
        format!("store.conflict-{stamp}.json")
    } else {
        format!("store.conflict-{stamp}-{}.json", n + 1)
    }
}

/// dir 안에서 아직 존재하지 않는 첫 충돌본 경로. 같은 초의 연속 충돌은 순번으로
/// 구분하고, 극단적인 동명은 epoch 접미로 빠져나온다.
fn pick_conflict_path(dir: &Path, stamp: &str) -> PathBuf {
    for n in 0..1000u32 {
        let p = dir.join(conflict_file_name(stamp, n));
        if !p.exists() {
            return p;
        }
    }
    dir.join(conflict_file_name(
        &format!("{stamp}-{}", now_epoch_secs()),
        0,
    ))
}

/// 파일명 스탬프 — 로컬 벽시계 ISO("2026-11-19T09:30:15")에서 Windows 파일명
/// 불가 ':'만 '-'로 치환 → "2026-11-19T09-30-15". 사람이 읽는 백업 이름이라
/// 로컬 시각 그대로를 쓴다(리마인더의 벽시계 계약과 동일 기준).
fn conflict_stamp() -> String {
    format_local_iso(now_local_secs()).replace(':', "-")
}

/// 이름 선택 + tmp→rename(저장과 같은 재시도 공용) — 절반 쓰인 충돌본을 피한다.
/// 같은 이름을 고르는 경쟁은 호출자(CONFLICT_WRITE 락)가 직렬화로 막는다.
fn write_conflict_copy(dir: &Path, stamp: &str, json: &str) -> Result<PathBuf, String> {
    let dst = pick_conflict_path(dir, stamp);
    let tmp = dst.with_extension("tmp");
    fs::write(&tmp, json.as_bytes()).map_err(|e| e.to_string())?;
    match rename_with_retry(
        &RENAME_RETRY_DELAYS_MS,
        || fs::rename(&tmp, &dst),
        std::thread::sleep,
    ) {
        Ok(_) => Ok(dst),
        Err(e) => {
            let _ = fs::remove_file(&tmp); // 실패한 tmp는 잔재로 두지 않는다
            Err(e.to_string())
        }
    }
}

/// 충돌본 쓰기 직렬화 — 창이 여럿이어도 invoke는 단일 Rust 프로세스에 모이므로,
/// 이름 선택~rename 구간을 뮤텍스로 묶으면 같은 파일명을 동시에 고르지 않는다.
static CONFLICT_WRITE: OnceLock<Mutex<()>> = OnceLock::new();

#[tauri::command]
pub fn save_conflict_copy(app: AppHandle, json: String) -> Result<String, String> {
    let p = store_path(&app)?;
    let dir = p
        .parent()
        .ok_or_else(|| "store.json has no parent dir".to_string())?
        .to_path_buf();
    let _guard = CONFLICT_WRITE
        .get_or_init(|| Mutex::new(()))
        .lock()
        // poison돼도 쓰기 자체는 안전 — 계속 진행(다른 OnceLock들과 같은 정책)
        .unwrap_or_else(|e| e.into_inner());
    match write_conflict_copy(&dir, &conflict_stamp(), &json) {
        Ok(dst) => {
            qa_write(&format!(
                "conflict-copy :: wrote {} bytes={}",
                dst.display(),
                json.len()
            ));
            Ok(dst.to_string_lossy().into_owned())
        }
        Err(e) => {
            qa_write(&format!("conflict-copy :: FAIL {e}"));
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

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

    // ---- 전체 검색 단축키 (phase-02-task-02, D-1) ----

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

    // ---- 동기 충돌 — 충돌본 보관 (phase-04-task-03, OQ-03) ----

    #[test]
    fn conflict_file_name_numbering() {
        // n=0은 순번 없는 기본명, 이후는 -2, -3… (Windows "파일 (2)" 관습과 같은 1-base)
        assert_eq!(
            conflict_file_name("2026-11-19T09-30-15", 0),
            "store.conflict-2026-11-19T09-30-15.json"
        );
        assert_eq!(
            conflict_file_name("2026-11-19T09-30-15", 1),
            "store.conflict-2026-11-19T09-30-15-2.json"
        );
        assert_eq!(
            conflict_file_name("2026-11-19T09-30-15", 9),
            "store.conflict-2026-11-19T09-30-15-10.json"
        );
    }

    #[test]
    fn conflict_stamp_is_filename_safe() {
        // "YYYY-MM-DDTHH-MM-SS" — Windows 파일명 불가 문자가 없다.
        let s = conflict_stamp();
        assert_eq!(s.len(), 19, "{s}");
        for bad in [':', '/', '\\', '*', '?', '"', '<', '>', '|'] {
            assert!(!s.contains(bad), "stamp contains {bad:?}: {s}");
        }
    }

    #[test]
    fn pick_conflict_path_skips_occupied() {
        let dir = datadir_fixture("conflict-pick");
        let stamp = "2026-11-19T09-30-15";
        // 비어 있으면 기본명
        assert_eq!(
            pick_conflict_path(&dir, stamp),
            dir.join("store.conflict-2026-11-19T09-30-15.json")
        );
        // 기본명이 있으면 -2, 그것도 있으면 -3
        fs::write(dir.join(conflict_file_name(stamp, 0)), b"a").unwrap();
        assert_eq!(
            pick_conflict_path(&dir, stamp),
            dir.join("store.conflict-2026-11-19T09-30-15-2.json")
        );
        fs::write(dir.join(conflict_file_name(stamp, 1)), b"b").unwrap();
        assert_eq!(
            pick_conflict_path(&dir, stamp),
            dir.join("store.conflict-2026-11-19T09-30-15-3.json")
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_conflict_copy_roundtrip_and_unique() {
        let dir = datadir_fixture("conflict-write");
        let stamp = "2026-11-19T09-30-15";
        let a = write_conflict_copy(&dir, stamp, "{\"v\":1}").unwrap();
        let b = write_conflict_copy(&dir, stamp, "{\"v\":2}").unwrap();
        // 같은 스탬프의 연속 충돌은 서로 다른 파일 — 둘 다 내용 보존(데이터 손실 0)
        assert_ne!(a, b);
        assert_eq!(fs::read_to_string(&a).unwrap(), "{\"v\":1}");
        assert_eq!(fs::read_to_string(&b).unwrap(), "{\"v\":2}");
        // tmp 잔재 없음 — 확정본만 남는다
        let tmp_left = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().ends_with(".tmp"));
        assert!(!tmp_left);
        let _ = fs::remove_dir_all(&dir);
    }
}
