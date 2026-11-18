# phase-04-task-01 — attempt 1

## 목표
store.json 위치를 사용자가 바꿀 수 있는 config.json 포인터 + IPC 명령 (R-04, TD-05).

## 변경 — `src-tauri/src/main.rs` (유일한 제품 코드 변경)

### 포인터 모델 (TD-05 그대로)
- `%APPDATA%\com.guseok.memo\config.json` = `{ "dataDir": "<폴더 경로>" | null }` —
  앱 데이터 루트는 고정, store.json만 이동. config.json 갱신은 임시 파일→rename
  (`rename_with_retry` 재사용)으로 절반 쓰인 포인터 방지 + 기존 알 수 없는 키 보존.
- `configured_data_dir(cfg)` — dataDir 원시값 읽기(손상·누락·비문자열·빈값 → None).
- `resolve_store_dir(app_dir, cfg)` — 설정 폴더가 **지금 존재하는 디렉터리**면 그곳,
  아니면 기본 dir로 안전 폴백. `store_path()`가 매 호출 해석하므로 set 이후
  저장·로드·스케줄 부팅 초기화가 즉시 새 경로를 따라감 + 지정 폴더 삭제 시 자동 폴백.

### 커맨드
- `get_data_dir(app) -> DataDirInfo` — `#[serde(rename_all="camelCase")]`로 계약 키 그대로:
  `{ path: Option<String>(설정값, 무효여도 그대로), effectivePath: String(실효 store 부모 dir),
  isDefault: bool(effective == 기본 dir) }`.
- `set_data_dir(app, path: Option<String>) -> ()` — 본체는 `set_data_dir_impl(app_dir, Option<&str>)`
  (AppHandle 없이 테스트 가능). 순서: 존재+`check_dir_writable`(시험 파일 쓰기/삭제)
  → `copy_store_to_dir`(복사→재읽기 바이트 일치 검증) → `write_data_dir_pointer`(마지막 갱신).
  미존재·비디렉터리·빈 경로·쓰기 불가·복사/검증 실패 → Err, 포인터 미갱신으로 기존 경로·데이터 유지.
- `None` — 포인터 해제: 현재 유효 dir의 저장본을 기본 dir로 복사 후 `dataDir:null`.
- 이전 정책: **복사·보존(삭제 금지)** — 원본 store.json 유지. 대상에 기존 store.json이
  있으면 먼저 그것을 store.bak.json으로 보존한 뒤 덮어씀; 없으면 원본 .bak를 함께 복사해
  `read_store_contents` 폴백 경로 유지. 자기 dir 지정은 이전 건너뛰고 포인터만 갱신,
  기본 dir 지정은 null로 정규화.
- 전환 성공 후 `update_schedule_from_store`(새 경로 내용) 호출 — 스케줄 소스 동기화.
  스케줄러 스레드는 인메모리 SCHEDULE만 보고 디스크 접점은 save_store·부팅 초기화라
  store_path 해석을 그대로 따라감. 포인터 변경 자체는 guseok://store emit 없음
  (저장 경로만 변경 — 합의된 자기 에코 방지).
- `open_data_dir` — 실효 저장 폴더(resolve 결과)를 열도록 정합성 맞춤.
- invoke_handler에 `get_data_dir`, `set_data_dir` 등록. capabilities 변경 불필요
  (앱 정의 커맨드는 ACL 대상이 아님 — 기존 save_store 등과 동일 경로).
- 성공/실패 모두 qa_write(`set-data-dir ::`) 기록 — qa 로그가 관찰 정본.

## 테스트
- `plan_setup/cdp-data-dir.cjs` (신규, gitignore 자산) — node 측 %TEMP% 대상 폴더로
  실사용자 데이터 무접촉 왕복: 초기 형태 → 지정(복사·보존·포인터 파일·get_data_dir 전환)
  → save_store가 신규 경로에 기록 → 미존재 경로 Err+상태 유지 → 해제(기본 복귀·포인터 null)
  → finally에서 포인터 원복+임시 폴더 삭제. 15개 단언.

## 검증 (직접 실행)
- `npm run build` — PASS
- `cargo fmt -- --check` — PASS (초기 diff 4건 fmt 적용 후 통과)
- `cargo clippy --all-targets -- -D warnings` — PASS (bool_assert_comparison 3건 수정 후 0)
- `cargo test` — **25/25 PASS** (기존 18 + 신규 7):
  pointer_absent_or_broken_resolves_default, pointer_valid_resolves_custom_and_missing_falls_back,
  check_dir_writable_probe, write_pointer_roundtrip_and_preserves_unknown_keys,
  copy_store_to_dir_copies_and_preserves, set_data_dir_impl_full_roundtrip,
  set_data_dir_impl_rejects_and_keeps_state
- `powershell -File harness_setup/scripts/run-e2e.ps1 -Cdp "cdp-data-dir.cjs"` —
  **selftest 42/42 PASS** + **CDP 15/15 PASS**, E2E: PASS
  (증거 `.devil/loop/qa-logs/guseok-qa-20261118-181743.log`)

## 수용 기준 대응
1. config.json에 경로 보관 + store_path() 해석 → resolve_store_dir 재귀 해석, 단위·CDP 단언
2. get_data_dir {path, effectivePath, isDefault} → dd-initial-shape/info-custom/info-default-again
3. set_data_dir: 쓰기 확인→복사→포인터 갱신→신규 경로 사용 → dd-set-ok/copy-content/save-new-path
4. 미존재·쓰기 불가 Err + 기존 경로·데이터 유지 → 단위 rejects + dd-missing-err/err-keeps-custom
5. 재시작 후 지정 경로 유지 → 포인터는 config.json 파일이 유일한 상태라 재시작=파일 재읽기와 동치;
   해석이 매 호출 파일을 읽음을 단위(pointer_valid)로, 파일 내용을 CDP(dd-pointer-file)로 단언.
   실 재기동 e2e는 single-instance·PID 추적 문제로 미실시 — 근거 기록.

## 남은 문제·결정 근거
- **Windows에서 "쓰기 불가 폴더"의 단위 재현 한계**: readonly dir 속성은 파일 생성을 막지 않고
  ACL 부여는 테스트 과잉 — check_dir_writable을 파일-as-dir·미존재 경로로 Err 단언,
  impl 차원은 미존재 Err로 커버(프로브 자체는 첫 쓰기 시도에서 실패를 그대로 전파).
- **`set_data_dir` 반환은 계약대로 `()`** — 확인 정보는 get_data_dir로 조회.
- **config.json 잔재**: e2e가 생성한 `{"dataDir":null}`은 부재와 동치지만 정확한 원복을 위해
  실행 후 삭제함(run-e2e 스냅샷은 존재 파일만 복원하므로 신규 파일은 복원 대상 아님).
- 같은 폴더 재지정·기본 dir 지정 등 모서리는 null 정규화/no-op로 처리 — 보수적 선택.
