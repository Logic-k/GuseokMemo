# phase-03-task-01 — attempt 1

## 변경
- `src-tauri/src/main.rs`: 리마인더 스케줄러(TD-07, R-02/03) — 발화부만(OQ-02 전달부는 task-02 범위).
  - **시간 표현(결정 기록)**: store 계약의 `at`/`lastFiredAt`은 naive 로컬 ISO(`2026-11-19T09:00`).
    내부 비교는 "로컬 벽시계 일련초"(1970-01-01 00:00 로컬 기준, `days_from_civil`)로 통일 —
    daily/weekly의 `+1일/+7일`이 벽시계 기준으로 정확하고(UNIX epoch에 +86400은 DST에서
    벽시계가 어긋남) 타임존 오프셋 조회가 불필요해 코어가 완전한 순수 함수가 된다.
    플랫폼 의존은 `now_local_secs()` 하나뿐(Windows: `GetLocalTime` FFI / 비Windows: UTC 폴백 —
    기존 `cursor_point` cfg 패턴과 동일). emit 페이로드의 `firedAt`은 실제 UNIX epoch
    (`SystemTime`) — "chrono 없이 UNIX epoch" 지시와 양립.
  - **순수 함수**: `days_from_civil`/`civil_from_days`(Hinnant), `parse_local_iso`
    (`YYYY-MM-DD[THH:MM[:SS]]`, 'T'/공백 구분, 초 이후 접미 무시, 범위 검증),
    `format_local_iso`, `plan_reminder`(분류), `reminders_from_store`(저장본 파싱),
    `sync_schedule`(스케줄 재구축), `drain_due`(틱의 발화 수집·엔트리 갱신).
  - **스케줄 상태**: `static SCHEDULE: OnceLock<Mutex<HashMap<reminderId, SchedEntry>>>`.
    엔트리 = `{index_id, reminder_id, note, repeat, anchor_at, next_at, missed_at,
    last_fired_at}`. `next_at`/`missed_at` 모두 None이면 inert — `last_fired_at` 보존용으로 맵에 유지.
    Mutex poison은 `into_inner()`로 흡수(캐시성 상태, 디스크에서 재구축 가능).
  - **분류(plan_reminder)**: `enabled=false`·at 파싱 불가 → inert. `none`:
    `last_fired >= at` → 이미 발화(inert, 재발화 금지); `at <= now` 미발화 → 자동 발화 아닌
    "놓침" 1회 보고; 미래 → 예약. `daily`/`weekly`: pending = 첫 `T_k > last_fired`
    (`T_k = anchor + k·period`). pending이 과거면 **가장 최근 놓침 발생 1건만** 보고하고
    `next_at` = 첫 `T_k > now`(놓침 스팸 방지).
  - **중복 발화 방지(sync_schedule)**: anchor(at·repeat) 동일 시 `last_fired`를
    `max(인메모리, 디스크)`로 병합 — 발화 직후 JS가 `lastFiredAt`을 쓰기 전의 저장
    (디스크는 과거 at + null)으로 재동기화돼도 inert 유지. anchor가 바뀌면 디스크값 신뢰.
    디스크에서 사라진 id는 맵에서 제거(삭제 반영).
  - **갱신 경로**: `save_store`가 rename 성공 직후 저장본 JSON을 `update_schedule_from_store`로
    파싱 — 창 라벨 무관하게 모든 저장(편집·설정·복원·pagehide 플러시)이 스케줄에 반영.
    부팅은 setup에서 `load_store_raw`(load_store와 같은 store.json→.bak 폴백 읽기)로 초기화 후
    detached 스레드 기동(`REMINDER_CHECK_INTERVAL` = 2s, 앱 수명과 동일).
  - **발화**: `drain_due`가 missed_at(놓침 우선)→next_at due 순으로 이벤트 수집,
    `last_fired_at = now` 기록, 반복이면 `next_at` = 첫 `T_k > now`로 자동 진행,
    `none`이면 `next_at = None`(inert). 이벤트마다 `guseok://reminder` 전 창 emit +
    `qa_write("reminder :: emit reminderId=.. indexId=.. at=.. repeat=.. missed=..")` —
    qa_log가 CDP 없이 관찰 가능한 발화 정본.
  - **emit 페이로드**(일관 형식): `{indexId, reminderId, at, repeat, note, missed, firedAt}`
    — `at`은 발생 시각 로컬 ISO `YYYY-MM-DDTHH:MM:SS`(놓침이면 놓친 그 발생), `firedAt`은
    UNIX epoch 초, `missed`는 과거 미발화분 구분.
  - `load_store` 리팩터: 읽기 경로를 `read_store_contents`로 추출(기능 동일, 부팅 초기화와 공유).
  - 신규 커맨드 `qa_log_path` — selftest가 qa 로그를 `read_text_file`로 읽어 emit을 단언.

- `src/selftest.js`: 케이스 3개 추가(39 → 42).
  - `migrate-reminder-fields`: migrate()가 reminders 원소를 `{id,at,repeat,note,enabled,
    lastFiredAt}`로 정규화(누락 기본값·비객체 필터) — 수용 기준 1 단언.
  - `reminder-fire`: `idx.reminders`에 at=now+6초·repeat=none 기록 → `saveStore(immediate)` →
    qa 로그에 `reminderId=rqafire1 ... missed=false` 라인 대기·단언 — 수용 기준 2·3 e2e 단언.
  - `reminder-missed`: at=now-300초·미발화 기록 저장 → `missed=true` emit 단언 — 재시작 놓침과
    동일한 plan_reminder 경로(수용 기준 5의 mid-run 동등 분류).
  - 종료 시 `idx.reminders` 원복 후 저장 — 스케줄도 재동기화로 제거.

## 검증
- `npm run build` — PASS (vite 101ms)
- `cargo fmt -- --check` — PASS
- `cargo clippy --all-targets -- -D warnings` — PASS (0 warnings)
- `cargo test` — PASS **18/18** (기존 rename 6 + 신규 12:
  civil_days_roundtrip, parse_local_iso_variants, format_local_iso_roundtrip,
  plan_once_schedules_missed_and_done, plan_daily_reports_latest_missed_and_next,
  plan_weekly_uses_seven_day_period, drain_due_fires_once_then_done,
  drain_due_daily_advances_next, sync_missed_reported_once,
  sync_fired_once_not_resurrected_by_stale_disk(중복 발화 방지 회귀),
  sync_removes_deleted_and_adds_new, reminders_from_store_nested)
- `cargo build` — PASS
- `powershell -File harness_setup/scripts/run-e2e.ps1` — **E2E: PASS, SUMMARY 42/42**
  (기존 39 + 신규 3, FAIL 0). qa 로그에 실제 emit 라인 확인:
  `reminder :: emit reminderId=rqafire1 ... missed=false`,
  `reminder :: emit reminderId=rqamiss1 ... missed=true`.
  증거: `.devil/loop/qa-logs/guseok-qa-20261118-175831.log`.
  store 스냅샷 복원·exe/vite 정리 확인(tasklist 0, :5183 LISTEN 없음).

## 남은 위험/결정
- "놓침" 보고는 리마인더당 1회·최근 발생 1건 — 재시작 후 다수 놓친 발생을 개별 보고하면
  알림 스팸이 되므로 보수적 선택(ARCH §6.2 "놓침으로 분류해 전달"의 최소 충족). 전달부(task-02)가
  원하면 per-occurrence로 확장 가능.
- 반복 발화 중간에 앱이 잠들어 지나간 주기는 첫 `T_k > now`로 건너뜀(개별 백필 없음) — 같은
  스팸 방지 판단.
- `missed` 분류는 부팅뿐 아니라 mid-run 저장(사용자가 과거 시각 저장)에도 동일 적용 —
  수용 기준과 ARCH의 "재시작" 표기를 "동기화 시점"으로 일반화한 것(동일 코드 경로로 두 경우 모두 커버).
- `lastFiredAt` 디스크 기록은 JS 리스너(task-02) 몫 — Rust는 인메모리만 갱신(지시서 명세대로).
- 비Windows `now_local_secs()`는 UTC 폴백 — 대상 OS는 Windows이며 기존 cfg 패턴과 동일한 최소 폴백.
- emit 이벤트는 리스너가 없어도 qa_log에 기록됨 — task-02에서 JS listen 연결 예정.
