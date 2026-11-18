# phase-04-task-03 — attempt 1

## 목표
OQ-03 확정 정책 "충돌본 보관" 구현 — 앱 미저장 편집 + 외부 store 변경 동시
상황에서 외부본을 적용하되 덮어쓰이는 로컬본을 별도 파일로 보존한다 (R-05 충돌 경로).

## 정책 해석
- **충돌 판정 (태스크 명세 우선)**: 외부 변경(`src:"external"`) 도착 시 로컬에
  미저장 편집이 있으면 충돌. "미저장" = `JSON.stringify(state) !== lastSavedJson`
  (디스크와 동기화된 마지막 직렬화 기준선) — 디바운스 대기 중 편집과 아직 저장
  호출조차 안 된 인메모리 변경을 둘 다 포착한다.
- **보관 내용**: 로컬본은 **전체 store JSON 통째** (태스크/DESIGN 미명세 →
  보수적 선택: 인덱스 부분만이면 common/templates 손실, 통째면 store.json
  형식이라 수동 복원에 그대로 사용 가능).
- **통지**: 명세 없음 → 기존 앱 내 토스트 인프라 재사용 최소 구현(상주 handles가
  큐 소유) + qa_log.

## 변경 — `src-tauri/src/main.rs`
- 신규 커맨드 `save_conflict_copy(json) -> Result<String,String>`:
  store.json 옆에 `store.conflict-<YYYY-MM-DDT HH-MM-SS>.json`(`:` → `-`, 로컬 벽시계)
  으로 tmp→rename(기존 RENAME_RETRY 공용) 원자적 쓰기, 같은 초 연속 충돌은 `-2`/`-3` 순번.
  `CONFLICT_WRITE` 뮤텍스로 이름 선택~rename 직렬화(창은 여럿이어도 invoke는 단일
  프로세스에 모임). 반환값 = 기록된 파일 경로. `conflict-copy :: wrote/FAIL` qa 로그.
- 헬퍼(테스트 대상): `conflict_file_name` / `pick_conflict_path` / `conflict_stamp` /
  `write_conflict_copy`. invoke_handler 등록.
- 감시 루프는 store.json 스탬프만 보므로 충돌본 쓰기가 리로드를 유발하지 않음.
  set_data_dir 이전은 store.json만 옮기므로 충돌본은 생성 폴더에 남는다(콜드 백업).

## 변경 — `src/store.js` (충돌 감지·보관 호출)
- `lastSavedJson` 기준선: 부팅 로드 후 · `save_store` 성공 시 · 다른 창 저장본
  적용 시 · 외부본 적용 시 갱신. 동일 내용 도착 조기 리턴에서도 기준선만 맞춘다.
- `isStoreConflict(src, localJson, savedJson)` — `src==="external"` + dirty만 충돌.
  같은 앱 다른 창 저장(src=창라벨)은 기존 last-writer-wins 정상 경로 유지.
- `conflictingIndexes(local, incoming)` — 실제로 다른 인덱스 id·title 추출(토스트 안내용).
- 적용 직렬화 `applyChain`: 충돌이면 `save_conflict_copy` 완료 후 migrate 적용 —
  비동기 보관 중 후속 이벤트 끼어들기로 적용 순서 뒤집힘 방지. 충돌 감지 즉시
  기준선을 당겨 같은 로컬본의 중복 보관 방지.
- 충돌 처리: 보관 → state=migrate → `conflict :: win=.. preserved=.. diffs=..`
  qa 로그 + `emit("guseok://conflict", {win, path, indexes})` (전 창, handles가 수신)
  → externalHandler에 meta `{src, conflict, conflictPath, diffs}` 전달(기존 단일
  인자 호출부와 호환).
- externalHandler 시그니처에 meta 추가됐지만 기존 handler들은 무시해도 동작.

## 변경 — `src/handles.js`
- `showConflictToast(p)`: kind:"conflict" 토스트를 기존 큐(TOAST_MAX·4초·승격)로
  push — `reminderId = "conflict:<path>"`로 emit 경로와 핸들러 meta 경로의 이중
  도착을 toastEnqueue 중복 제거로 흡수. `conflict :: toast` qa 로그.
- `guseok://conflict` 리스너 — 어느 창이든 충돌 감지 시 이 창이 대표 표시.
- initStore 핸들러: meta.conflict면 동일 토스트(handles 자신이 dirty인 경로 대비).

## 변경 — `src/toast.js`, `src/style.css`
- `kind==="conflict"` 항목 렌더: `{title} — 외부 변경 적용` + `충돌본 보관` 배지
  (액센트 계열 — 놓침 경고색과 구분) + note에 보관 파일명. 클릭=기존 toast-open
  경로로 해당 인덱스 열기, ×·Esc=기존 dismiss/clear 재사용.

## 변경 — `src/selftest.js` (+5케이스, 75→80)
- `conflict-policy-predicate`: 판정 진리표 + conflictingIndexes 단언.
- `conflict-external-applied` / `conflict-copy-preserved` / `conflict-notify-toast` /
  `conflict-none-clean`: 실제 store.json 덮어쓰기로 충돌 재현 — 외부본 적용,
  qa 라인의 충돌본 경로 파일을 read_text_file로 읽어 로컬 마커 보존·파일명
  형식 단언, 토스트 qa 라인 또는 toast 창 표시 단언, 깨끗한 상태의 외부 변경은
  충돌본 없이 적용(비충돌 회귀).

## 변경 — `plan_setup/cdp-conflict.cjs` (신규, gitignore 로컬 자산)
- handles 인메모리 미저장 편집 + node 직접 store 덮어쓰기 → 충돌본 파일 생성·
  파일명 형식·로컬본 보존·외부본 적용·토스트 큐·qa 로그·원복 왕복·충돌본 정리
  (selftest 잔재 포함 전부 삭제).

## 검증 (직접 실행)
- `npm run build` PASS / `cargo fmt --check` PASS / `cargo clippy -D warnings` PASS
- `cargo test` — **37/37 PASS** (기존 33 + 신규 4): 파일명 순번·스탬프 파일명
  안전·경로 순번 선택·쓰기 왕복+고유성+tmp 잔재 없음.
- `run-e2e.ps1 -Cdp "cdp-conflict.cjs,cdp-external-reload.cjs"` — **E2E PASS**
  - selftest **80/80** (신규 5: 판정·적용·보존·토스트·비충돌 회귀)
  - CDP-CONFLICT **9/9**, CDP-EXTERNAL-RELOAD **5/5** (비충돌 회귀)
- 잔재 확인: 실행 후 `store.conflict-*` 0개, guseok-memo/vite 프로세스 0,
  store.json 스냅샷 복원(run-e2e 자체).

## 수용 기준 매핑
- OQ-03 정책 구현: 충돌 경로에서 외부 적용 + 로컬본 파일 보관 (위 구조).
- 미저장+외부 동시 상황 데이터 유실 0: 충돌본이 덮어쓰인 로컬본 통째 보존
  (selftest/CDP가 실제 파일 내용 단언).
- 사용자 가시성: qa 로그 3종(`conflict-copy :: wrote`·`conflict :: win`·
  `conflict :: toast`) + 앱 내 토스트.
- 정책별 회귀: 비충돌 외부 적용(conflict-none-clean·cdp-external-reload)·
  자기에코(external-self-echo)·기존 75 selftest 전부 유지.

## 남은 문제·결정 근거
- 충돌 적용 후 대기 중이던 디바운스 저장은 취소하지 않는다 — 보존 후 state에
  외부본이 반영되고, 패널의 기존 focused 재심기 로직이 사용자가 치던 텍스트를
  살려 후속 저장이 "외부+로컬 편집" 병합본을 쓴다(기존 동작 유지, 보수적 선택).
  어느 경로든 로컬본 전체는 충돌본 파일에 있다.
- 복수 창이 동시에 dirty면 창별 로컬본 각각이 충돌본이 될 수 있다 — 각각
  보존되므로 손실 없음(-2 순번). 실사용은 편집 창 1개가 보통.
- 충돌본 쓰기 실패(디스크 가득 등 극단): 외부본은 정책대로 적용 + `FAIL
  conflict-copy` qa 로그 + 토스트 "보관 실패" 안내 — 적용을 막아 문제를 숨기는
  것보다 낫다고 판단.
- selftest가 만드는 충돌본 파일은 e2e의 CDP 스크립트가 정리한다 — selftest
  단독 실행 시 타임스탬프 백업 1개가 남을 수 있음(무해한 보관본, 삭제 명령 부재로
  의도적 잔여 — CDP 실행 경로가 정본).
- 커밋 대상: src-tauri/src/main.rs, src/store.js, src/handles.js, src/toast.js,
  src/style.css, src/selftest.js, .devil 증거. cdp-conflict.cjs는 gitignore 자산,
  조정자 파일(tasks·STATE·LOG·PRD·DESIGN) 제외.
