# phase-02-task-02 — attempt 1

## 변경
- `src-tauri/src/main.rs`
  - setup에 `search` 창 추가: `WebviewUrl::App("search.html")`, 460x400, decorations(false)+transparent+always_on_top+skip_taskbar+shadow(false)+visible(false) — settings와 같은 사전 생성 + `CloseRequested` 가로채서 hide (NFR-06/BUG-18).
  - `show_search`/`hide_search` 커맨드 — show는 `work_area("auto")`(커서 모니터) 재사용해 가로 중앙·세로 38% 배치 후 show+set_focus + `guseok://search-open` emit (panel-open 통지 패턴과 동일).
  - `shortcut_keys(preset, search_preset)` — ("search", 키) 항목 추가: ctrl_shift_f(기본)/ctrl_f/alt_f/f3. `register_shortcuts`에 `search_key: Option<String>` 추가(미지정 → ctrl_shift_f). 검색 키 등록 실패만 `qa_write("WARN …")`으로 강등 — 열기/순환 핵심 키는 기존대로 하드 실패.
  - 단위 테스트 `shortcut_keys_bind_search_presets` 추가.
- `src-tauri/capabilities/default.json` — windows에 "search" 추가 + `core:window:allow-get-all-windows` (selftest 창 열거용). gen/schemas는 빌드 재생성분 동행.
- `index.html` — 툴바 `btnSearch`(돋보기 svg)를 `btnImage` 왼쪽에 배치.
- `src/panel.js` — btnSearch 클릭 → `invoke("show_search")`.
- `src/handles.js` — `guseok://shortcut` `action:"search"` → `invoke("show_search")`; register_shortcuts 호출에 `searchKey: state.common.searchKey || "ctrl_shift_f"` 전달.
- `src/store.js` — `common.searchKey = "ctrl_shift_f"` 기본값 (구 store는 common merge로 자동 채움 — 스키마 버전 유지).
- `src/settings.js` — 공통 탭에 "검색 단축키" select(열기 키와 겹치지 않는 키셋) + register_shortcuts 재호출 시 searchKey 유지.
- `search.html` + `src/search.css` + `src/search-window.js` (신규) — 상단 입력(자동 포커스·전체선택, placeholder "검색") + 결과 리스트(색칩 바 `--chip`=idx.bg + 제목 + 스니펫, 매칭 어절 `<b>` 하이라이트, 텍스트 노드 조립으로 HTML 인젝션 없음). 디바운스 120ms. 매칭 0 → "결과 없음" 중앙. ↑↓+Enter → `getLayout`/`panelRect` → `invoke("show_panel")`(handles open(id)과 동일 경로) 후 hide. Esc/외부 블러(포커스 상실) → `invoke("hide_search")`. IME: `compositionstart/end` 플래그 — 조합 중 `runSearch` 유예(pendingSearch), compositionend에 확정 텍스트로 재검색; keydown은 `isComposing`/`keyCode 229` 가드(panel.js 패턴). `guseok://store`(initStore onExternal) → 재검색(조합 중 유예). CDP 훅 `window.__search`.
- `vite.config.js` — rollup input에 `search.html`.
- `src/selftest.js` — +3건: `search-window-exists`(setup 사전 생성 라벨), `search-window-show-hide`(커맨드 표시/숨김), `migrate-searchkey-default`. 70→73.
- `plan_setup/cdp-search-ui.cjs` (신규, gitignore 로컬 자산) — 창 표시/자동 포커스, 결과 DOM 구조, "결과 없음", IME 유예+flush, ↑↓+Enter 점프→패널 표시+창 닫힘, 외부 포커스 닫힘, Esc 닫힘 = 12 단언.

## 수용 기준 근거
- 진입점으로 열림: Ctrl+Shift+F 등록(register_shortcuts, PASS shortcuts 로그) + 패널 btnSearch → `search-open-focus` PASS.
- 실시간 갱신 + 제목+스니펫: `search-results-dom`(색칩+제목+스니펫), `search-snippet-bold` PASS.
- 결과 클릭/Enter → show_panel 경로로 패널 열림: `search-jump-close`+`search-jump-panel` PASS.
- IME 조합 무파괴: `search-ime-defer`(조합 중 DOM 불변)+`search-ime-flush` PASS.
- 매칭 0 "결과 없음" + Esc/외부 클릭 닫힘: `search-empty-state`+`search-esc-close`+`search-blur-close` PASS.

## 검증
- `npm run build` — PASS (dist/search.html 생성)
- `cargo fmt --check` — PASS; `cargo clippy --all-targets -D warnings` — PASS 0건
- `cargo test` — **PASS 33/33** (신규 1 포함)
- `powershell -File harness_setup/scripts/run-e2e.ps1 -Cdp "cdp-search-ui.cjs"` — **E2E PASS: selftest 73/73 + CDP 12/12**. 증거 `.devil/loop/qa-logs/guseok-qa-20261118-212755.log`. store 스냅샷 복원, 기동 프로세스·vite·9223 잔재 0 확인.
- 부팅 toggle emit 유실로 cdp-nudge 1회 발동(기존 문서화된 레이스) — 제품 결함 아님.

## 남은 위험/결정
- 창 UI 파일명: `src/search.js`는 task-01 코어가 점유 → 창 진입점은 `src/search-window.js`로 분리(이름 충돌 회피, 코어 재수정 없음).
- searchKey 설정화: 작업 지시의 "기존 openKey 구조 맞춰 searchKey도 common에"를 따라 common 필드 + 설정 select 추가. 키셋은 openKey 옵션과 불겹침으로 중복 등록 불가.
- 검색 키 점유 실패 시 WARN 강등: 타 앱이 Ctrl+Shift+F를 점유해도 열기 단축키(핵심) 등록을 지키기 위한 보수적 선택. 실패는 qa 로그 "WARN shortcuts :: search"로 관찰 가능.
- 다크모드 토큰 미적용 — 05-03 범위(지시대로 라이트 하드코드).
- `guseok://search-open` 이벤트는 D-1 범위 내 신규 통지 — ARCH §3 표 갱신은 조정자 영역으로 보고 미변경.
