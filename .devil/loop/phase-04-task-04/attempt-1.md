# phase-04-task-04 — attempt 1

## 목표
저장 폴더 설정 UI (R-04, DESIGN D-3 승인 v1) — 설정 창에 "저장" 탭을 신설해
현재 실효 경로 표시·폴더 선택 변경·기본값 복귀·오류 표시·외부 감시 상태를 노출.
코어(set_data_dir/get_data_dir/이전·폴백)는 phase-04-task-01 완료분을 그대로 사용.

## 변경 — `src/settings.js`
- `renderTabs()`: 고정 탭 "저장"을 탭열 맨 뒤(인덱스 탭들 + `+` 버튼 다음)에 추가
  — D-3 "기존 탭열 맨 뒤"를 문자 그대로 적용. 디스크 아이콘 svg + `tab` 클래스.
- `renderStorage()` (async, `storageSeq` 토큰으로 늦은 렌더 폐기):
  - 탭을 열 때마다 `get_data_dir` 재조회 → `{path, effectivePath, isDefault}`.
  - 현재 폴더: `#storagePath` 버튼(중간 생략 표시 `ellipsizePath` 24+…+28,
    `data-path`에 원시 경로, title에 전체 경로+안내) — 클릭 시 `open_data_dir`.
    `#storageKind` 배지: 기본/지정/폴백(설정 dir 무효 시 경고 문구+빨간 행).
  - `[폴더 변경…]`(`#storageChange`) → plugin-dialog `open({directory:true})`
    → `applyDataDir(picked)`; `[기본값으로 되돌리기]`(`#storageReset`,
    `!path && isDefault`이면 disabled) → `applyDataDir(null)`.
  - 실패 시 `#storageError` 빨간 문구 표시, 성공 시 숨김 — 코어가 Err 반환하면
    포인터를 갱신하지 않으므로 기존 경로가 자연히 유지된다.
  - `자동 불러오기` 섹션: `#storageWatch` "감시 중" 배지(store_watch_loop는
    일시 중단 상태가 없는 상시 폴링이라 표시는 항상 감시 중 — 보수적 선택) +
    `lastExternalReload`(initStore meta.src==="external" 도착 시각) 마지막 리로드
    시각 + OQ-03 확정 충돌 정책 1줄 안내(충돌본 store.conflict-*.json 보관).
  - 상단 hint: "바꾸면 기존 데이터를 새 폴더로 복사하고 원본은 그대로 둡니다"
    (이관/유지 안내 — copy_store_to_dir의 원본 보존 계약을 사용자 언어로).
- `export async function applyDataDir(path)`: 다이얼로그와 분리된 적용 진입점 —
  CDP가 네이티브 대화상자 없이 오류·성공 경로를 검증한다. 성공 → 즉시 적용
  메시지(코어가 재시작 불필요 — 포인터 매 호출 재해석), 실패 → 오류 문구+상태바.
- `render()` 디스패치에 `tab === "storage"` 분기, `guseok://open-tab`·`?tab=`
  forcedTab에 "storage" 지원 추가(기존 common/reminders와 동일 경로).
- boot의 initStore 핸들러가 meta 인자를 받아 src==="external"이면
  lastExternalReload 갱신 후 기존 renderUnlessBusy 호출(IME/상호작용 유예 유지).

## 변경 — `src/settings.css`
- `.store-path`(모노 계열·끝 생략 백업·최대 300px), `.store-err`(빨간 오류 행),
  `.store-note`(충돌 안내), `.row-ctrl .btn:disabled`(비활성 버튼 스타일).

## 변경 — `src/selftest.js` (+1케이스, 80→81)
- `storage-datadir-contract`: settings 창 존재 + `get_data_dir` 반환이 저장 탭이
  렌더하는 계약 형태({path: string|null, effectivePath: 비어있지 않은 string,
  isDefault: boolean})임을 단언. 탭 DOM 렌더·버튼·오류 경로는 CDP가 커버.

## 신규 — `plan_setup/cdp-storage-ui.cjs` (gitignore 로컬 자산)
- settings 창 CDP 접속 → 저장 탭 클릭 → `#storagePath`의 data-path가
  get_data_dir.effectivePath와 정규화 일치 + 기본/지정 배지 + 버튼 존재 +
  reset disabled 상태 + "감시 중" 배지 + 충돌 안내 문구.
- 성공 바인딩: `applyDataDir(현재 effectivePath)` — 코어가 같은 dir 재지정을
  감지해 복사 없이 포인터만 정규화하는 no-op → 상태 불변으로 성공 경로 단언
  (실 폴더 변경은 위험해 범위 밖 — cdp-data-dir.cjs가 왕복을 이미 커버).
- 오류 경로: `applyDataDir(미존재 %TEMP% 유사 경로)` → 반환 false +
  `#storageError` "폴더가 없습니다" + 표시 경로·get_data_dir 불변.

## 검증 (직접 실행)
- `npm run build` PASS / `cargo fmt --check` PASS /
  `cargo clippy --all-targets -D warnings` PASS / `cargo test` 37/37 PASS.
- `run-e2e.ps1 -Cdp "cdp-storage-ui.cjs"` — **E2E PASS**
  - selftest **81/81** (기존 80 + storage-datadir-contract)
  - CDP-STORAGE-UI **9/9**
- 1차 실행에서 title 속성에 안내 문구가 붙어 CDP 비교가 실패(2건) → `data-path`
  속성 도입 후 재실행 통과 (구현 측 수정, 검사 약화 아님).
- 잔재: selftest가 만든 store.conflict-*.json 1개를 실행 후 수동 삭제
  (cdp-conflict.cjs 미실행 회차라 스크립트 정리가 없었음 — 직접 정리).
  guseok-memo/vite 프로세스 0, :5183 LISTEN 0, store.json 스냅샷 복원(run-e2e 자체).

## 수용 기준 매핑
- 설정에서 저장 폴더를 대화상자로 선택·해제: `[폴더 변경…]`→Tauri dialog
  directory 선택→set_data_dir / `[기본값으로 되돌리기]`→set_data_dir(null).
- 현재 실효 저장 경로 표시(get_data_dir): `#storagePath`가 effectivePath를
  표시하고 탭을 열 때마다 재조회 — CDP가 effectivePath 일치를 단언.
- 쓰기 불가/미존재 선택 시 오류 메시지+기존 경로 유지: 코어 Err →
  `#storageError` 빨간 문구, 포인터 미갱신 — CDP `storage-apply-error` 단언.
- UI가 DESIGN 승인 방향과 일치: 저장 탭 맨 뒤 / 경로 중간 생략+클릭 시 폴더
  열기 / 폴더 변경 / 기본값 복귀 / 오류 빨간 문구 / 감시 중+마지막 리로드 시각 /
  OQ-03 충돌 정책 1줄 안내 — D-3 제안 항목 전부 반영.

## 남은 문제·결정 근거
- "일시 중단" 표시 없음 — 감시 스레드에 일시 중단 개념이 없어(상시 2초 폴링)
  표시 가능한 상태는 "감시 중"뿐. DESIGN의 `/일시 중단`은 상태가 존재할 때의
  표현으로 읽고 보수적으로 구현.
- 마지막 리로드 시각은 "이 설정 창이 관찰한" 외부 적용만 표시(세션 내).
  창이 닫혀 있던 중의 리로드는 잡히지 않는다 — 표시 목적상 충분하다고 판단
  (영구 타임스탬프 저장은 오버엔지니어링).
- 재시작 안내 없음 — 코어가 포인터를 매 호출 재해석해 즉시 적용되므로
  "재시작 후 적용" 대신 즉시 적용·복사 안내를 표시(태스크 지시의 분기 조건 충족).
- 커밋 대상: src/settings.js, src/settings.css, src/selftest.js, .devil 증거.
  cdp-storage-ui.cjs는 gitignore 자산. 조정자 파일(tasks·STATE·LOG·PRD·DESIGN) 제외.
