# phase-03-task-02 — attempt 1

리마인더 UI(패널 팝오버 + 설정 탭) + 앱 내 토스트 전달(OQ-02 확정) 구현.
task-01의 Rust 스케줄러(guseok://reminder emit)를 그대로 재사용하고 전달부만 추가.

## 변경
- `src/reminders.js` (신규) — UI·전달부 코어:
  - 로컬 ISO 파싱/표시(`parseLocal`/`toLocalIso`/`fmtReminderAt`) — naive 로컬 ISO = store 계약 = Rust 벽시계 일련초와 동일 의미.
  - 상태 판정 `reminderStatus`(disabled/invalid/fired/missed/scheduled) — Rust `plan_reminder`의 JS 거울(pending = 첫 T_k > lastFired).
  - 변경 함수 `setReminder`/`removeReminder`/`setReminderEnabled`/`markReminderFired` — 내부에서 `saveStore({immediate:true})` (setIndexHidden 패턴) → save_store가 저장본 파싱으로 Rust 스케줄 재동기화.
  - `listReminders` 전체 평탄화(숨긴 인덱스 포함) + `REM_STATUS_LABEL`/`repeatLabel`.
  - 토스트 큐 순수 로직 `toastEnqueue`/`toastRemove`/`toastPromote` + 상수(TOAST_MAX=3, PENDING_MAX=8, TOAST_MS=4000, 치수).
- `src/toast.js` + `index.html #toastHost` + `src/main.js` — `index.html?toast=1` 토스트 창 렌더러. 창은 setup 사전 생성·hide/show 재사용(NFR-06/BUG-18). 받은 목록 렌더만 담당하고 사용자 행동은 handles로 회송: 본문 클릭→`toast-open`, ×→`toast-dismiss`, Esc→`toast-clear`, 부팅→`toast-ready`(최초 상태 emit 누락 대비 재동기 핸드셰이크).
- `src/handles.js` — 상주 창이 발화 큐 소유(D-2). `guseok://reminder` 수신 → `markReminderFired`(lastFiredAt=발화 at — 재시작 재보고 방지 래치) → `pushToast`. 4초 만료 타이머, live 승격, `syncToastWindow`로 toast 창에 `guseok://toast-state` emitTo + `place_toast`(스트립 옆: 오른쪽 스트립이면 왼쪽, 세로 중앙 클램프). `toast-open` → `open(indexId)`(handles 클릭과 동일 show_panel 경로). CDP 훅 `__handles.toasts/pushToast/clearToasts`.
- `index.html` + `src/panel.js` + `src/style.css` — 툴바 `btnReminder`(시계, btnSearch 우측) + `remPop` 팝오버(fontPop 패턴): 현재 리마인더 목록(시각 순, 지남 빨강, 행별 해제/켜기·삭제) + `datetime-local` + 반복 select(없음/매일/매주) + 설정 버튼. 외부 클릭 닫힘·Esc 우선 닫힘·`has-rem` 배지·발화 시 버튼 펄스. datetime-local 값 = "YYYY-MM-DDTHH:MM" = store 계약과 동형.
- `src/settings.js` + `src/settings.css` — 공통 다음 고정 탭 "리마인더": 추가 폼(인덱스 select + datetime-local + 반복 + `+ 리마인더 추가`) + 전체 목록(색칩+인덱스 제목, 시각, 반복, 상태 배지 — 지남 `.overdue` 빨강, 해제/삭제). `guseok://open-tab` tab:"reminders" 지원, 스토어 외부 갱신은 `renderUnlessBusy` 경유(입력 중 재렌더 유예 = 기존 패턴 유지).
- `src-tauri/src/main.rs` — `place_toast` 커맨드(위치·크기·표시 지시) + setup에 `toast` 창(`index.html?toast=1`, 300x200, decorations/transparent/always_on_top/skip_taskbar/focused(false)/visible(false)).
- `src-tauri/capabilities/toast.json` (신규) — **버그 수정**: 기존 `default` capability의 windows=[handles,panel,settings,search]라 toast 창의 `plugin:event|listen`/`emit_to`가 전부 거부됐다(첫 CDP 실행에서 토스트 0건·Esc 무반응으로 발견 — probe로 ACL 에러 메시지 확인). 전용 capability에 `core:event:default`만 부여 — toast.js는 이벤트 송수신만 하고 창 제어는 handles의 place_toast가 하므로 최소 권한. `gen/schemas/capabilities.json`은 빌드 재생성분 동행.
- `src/selftest.js` — +2건: `reminder-ui-roundtrip`(set→enabled true→해제 false→삭제 round-trip) + `reminder-status-toastcap`(큐 live≤3 + pending 누적). 73→75.
- `plan_setup/cdp-reminder-ui.cjs` (신규, gitignore 로컬 자산) — 17 단언: 창 상주, 패널 닫힘 상태 missed 발화→토스트, 텍스트 형식 `제목 — HH:MM 알림`+놓침 배지, 클릭→해당 메모 패널, 큐 상한 3, Esc 전체 닫기, 설정 탭 목록·지남 빨강·해제·삭제, 패널 팝오버 설정·배지·행 해제.

## 수용 기준 근거
- 패널 팝오버(시계 버튼·datetime-local·반복 없음/매일/매주·설정·해제·현재 상태): `panel-rempop-open`/`panel-rem-set`/`panel-rem-list-badge`/`panel-rem-disable` PASS.
- 설정 리마인더 탭(목록·색칩+제목·시각·반복·지남 빨강·해제·삭제·+추가): `settings-rem-tab`/`settings-rem-overdue`/`settings-rem-disable`/`settings-rem-delete` PASS.
- 앱 내 토스트(handles 큐, 스트립 옆, 4초, 최대 3, 클릭→show_panel, Esc, missed 표시): `toast-window-exists`/`reminder-toast-fired`/`reminder-toast-text`/`reminder-toast-missed-badge`/`reminder-toast-open-panel`/`reminder-toast-cap`(max=3)/`reminder-toast-esc-clear` PASS — 패널은 발화 전 `hide_panel`로 닫아 둔 상태에서 수신 확인.
- missed 처리: 스케줄러가 missed=true로 emit → 토스트에 `놓침` 배지 + 설정/팝오버 목록에 `지남` 빨강. `reminder-fired-recorded` = lastFiredAt 래치로 재시작 재보고 방지.
- IME 안전: 신규 컨트롤은 native datetime-local/select(조합 대상 아님), 에디터 keydown의 `isComposing`/`keyCode 229` 가드 유지, toast.js Esc 핸들러도 동일 가드.
- 회귀: selftest 75/75(기존 73 유지 +2).

## 검증
- `npm run build` — PASS (dist/assets/toast-*.js·reminders-*.js 생성)
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` — PASS (초 1회 diff → fmt 적용 후 통과)
- `cargo clippy --all-targets --manifest-path src-tauri/Cargo.toml -- -D warnings` — PASS 0건
- `cargo test --manifest-path src-tauri/Cargo.toml` — PASS 33/33
- `powershell -File harness_setup/scripts/run-e2e.ps1 -Cdp "cdp-reminder-ui.cjs"` — **E2E PASS: selftest 75/75 + CDP 17/17**. 증거 `.devil/loop/qa-logs/guseok-qa-20261118-220349.log`. store 스냅샷 복원·백업 삭제 확인, guseok-memo/vite/9223 잔재 0.

## 남은 위험/결정
- capability 누락은 창 신설 시 필수 동반 변경 — default capability를 넓히기보다 전용 `toast-events`(event만)로 최소 권한 유지(보수적 선택).
- Esc = 전체 닫기로 해석(요구 "Esc dismisses the toast" — 개별 dismiss는 × 버튼이 담당). 토스트 창은 focused(false)라 클릭 직후처럼 포커스 보유 시에만 Esc 도달 → ×를 주 닫기 경로로 유지.
- 부팅 toggle emit 유실로 cdp-nudge 1회 발동(기존 문서화된 레이스, 이전 태스크 동일) — 제품 결함 아님.
- 토스트 창은 별도 WebviewWindow(setup 생성·hide/show 재사용) — handles DOM에 직접 그리는 대안 대신 분리: 스트립이 좁고(52px) 토스트는 300px 카드라 독립 창이 위치·수명 관리에 적합하며 NFR-06 계약 준수.
- `guseok://toast-*` 이벤트는 D-2 범위 내 신규 통지 — ARCH §3 표 갱신은 조정자 영역으로 보고 미변경.
