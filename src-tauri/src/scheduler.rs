use serde_json::json;
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

use crate::qa_write;

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
pub(crate) fn format_local_iso(secs: i64) -> String {
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
pub(crate) fn update_schedule_from_store(raw: &str) {
    let raws = reminders_from_store(raw);
    let mut sched = lock_schedule();
    sync_schedule(&mut sched, &raws, now_local_secs());
}

/// 실제 UNIX epoch 초 — emit 페이로드의 firedAt용.
pub(crate) fn now_epoch_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 현재 "로컬 벽시계"의 일련초 — 스케줄 비교의 기준 시각.
#[cfg(target_os = "windows")]
pub(crate) fn now_local_secs() -> i64 {
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
pub(crate) fn now_local_secs() -> i64 {
    // 폴백: 로컬 오프셋 정보가 없어 UTC를 로컬로 간주 — 대상 OS는 Windows이고
    // 이 경로는 비Windows 빌드/테스트용 최소 구현.
    now_epoch_secs()
}

/// 스케줄러 스레드 본체 — 앱 수명과 동일(detached). 주기마다 due를 emit하고
/// qa_log에 기록한다. emit 실패(수신 리스너 없음)는 무시 — qa_log가 발화의 관찰 정본.
pub(crate) fn reminder_scheduler_loop(app: AppHandle) {
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
