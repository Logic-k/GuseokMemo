# phase-01-task-01 — attempt 1 (구현)

## 변경 요약

- `src/store.js`
  - `SCHEMA_VERSION = 2` 도입, `defaultState().version`이 이를 사용.
  - `defaultIndex()`: `hidden:false`, `reminders:[]` 추가 (v2).
  - `common`: `darkMode:"system"`, `notifyMethod:"panel"` 추가 — OQ-02 미정이라
    TRD TD-07 후보(toast|panel|sound) 중 외부 권한·OS 의존이 없는 "panel"을 보수적 기본값으로 선택.
  - 최상위 `templates`: STARTERS 3종 재사용 `{id:"tpl"+i, name, content, builtin:true}`.
  - `defaultReminder()`/`defaultTemplate()` 기본형 export (phase-03/05 재사용 전제).
  - `migrate()`를 버전 단계 연쇄로 구조화: `STEPS[n]` = v n→n+1 변환 맵,
    입력이 선언한 version(`raw.version`, 없으면 1)부터 SCHEMA_VERSION까지 순서 적용.
    `STEPS[1]`(v1→v2)은 신규 필드의 형식 정규화 담당 — common 문자열 검증,
    `idx.hidden` 불리언화, `idx.reminders` 비객체 필터+기본형 merge,
    `templates` 비객체 필터+기본형 merge.
  - 기존 방어 로직(id 검증·중복·MAX_INDEXES·비객체 항목·null raw) 그대로 유지.
  - 미래 버전(version>2) 파일은 단계 건너뛰고 version 보존 —
    spread merge의 알 수 없는 키 보존과 함께 TD-10 다운그레이드 안전 유지.
- `plan_setup/fixtures/store-v1.json` — v1 스냅샷 fixture 신설.
- `src/selftest.js` — 신규 3케이스(메모리 내, 디스크 무관):
  `migrate-v1-to-v2`(vite dev에서 fixture fetch→동일 구조 단언, 실패 시 인라인 폴백),
  `migrate-keep-unknown`(TD-10 알 수 없는 키 보존+기존 데이터 유지),
  `migrate-old-backup`(필드 누락·비객체·중복 id·reminders 형식 오류 백업을
  settings 복원 경로와 동일하게 migrate→Object.assign 후 정규화 단언).
- `src-tauri/src/main.rs` — 태스크 무관 기준선 정리: 첫 게이트 실행에서
  기존 fmt 위반 13군데 + clippy 위반 5건(acronym 4, io_other_error 1) 발견.
  `cargo fmt` 적용 + Win32 FFI 로컬 구조체명 POINT/RECT/MONITORINFO→
  Point/Rect/MonitorInfo + `Error::new(ErrorKind::Other,e)`→`Error::other`.
  기계적 변경, 동작 동일 (clippy 권고 그대로).

## 실행한 검증과 결과

- `npm run build` — PASS (vite build 성공)
- `cargo fmt --check` — PASS (적용 후)
- `cargo clippy --all-targets -- -D warnings` — PASS 0 경고
- `cargo test` — PASS (0 tests — 기준선, Rust 순수 로직 추가 없어 unit.md 기준 충족)
- `cargo build` — PASS (debug exe)
- `powershell -File harness_setup/scripts/run-e2e.ps1` — **SUMMARY 29/29 passed, FAIL 0**
  (기존 26 + 신규 3; migrate-v1-to-v2는 `src=fixture`로 실제 fixture 파일 대상 단언 확인)
  증거: `.devil/loop/qa-logs/guseok-qa-20261118-170153.log`
- 잔재: guseok-memo.exe 0, :5183 LISTEN 없음, store 스냅샷 복원 확인 — 정리 완료.

## 남은 문제·위험

- `notifyMethod` 기본값 "panel"은 OQ-02 임시값 — 사용자 결정 시 문서/기본값 갱신 필요.
- `darkMode`는 스키마만 수용 — 실제 테마 적용 로직은 phase-05-task-03(UI, DESIGN blocked) 범위.
- release exe selftest에서는 fixture fetch가 불가 → 인라인 동일 구조로 폴백
  (단언 자체는 유지; fixture 파일 정합은 debug 경로에서 확인됨).
- main.rs fmt/clippy 기준선 정리는 본 태스크 범위 밖 파일의 공백·명명 변경 —
  동작 변경 없음을 clippy/build로 확인했으나 diff 리뷰 시 참고.
