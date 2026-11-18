# phase-05-task-03 — 다크모드 (attempt 1, 인수인계 마무리)

## 인수 상태

이전 워커가 사용자 중단으로 종료. 작업 트리에 미커밋 변경이 완전한 형태로 남아 있었고
attempt 파일만 미작성이었다. 이번 시도는 **검증 + 잔재 정리 + 커밋**이 전부 — 코드 변경 없음.

인수 시 이미 완료돼 있던 것:
- `src/darkmode.js` (신규) — `DARK_MODES`/`resolveDark`/`applyDarkMode`/`bindDarkMode`.
  html.dark 클래스만 토글, system은 `matchMedia("(prefers-color-scheme: dark)")` +
  `change` 리스너로 실시간 추적 (창당 1회 바인딩).
- `src/darkmode.css` (신규) — 공유 크롬 토큰 `--chrome-*`. :root=기존 라이트 값 그대로,
  html.dark=D-4 승인 팔레트 (#17181f/#1f2029/#e8e6df/#9a98a8, 액센트 #426b94).
- `index.html`/`settings.html`/`search.html` — darkmode.css를 창 css보다 먼저 로드.
- `src/store.js` `common.darkMode:"system"` 기본값 + v1→v2 migrate (task-02 완료분).
- `src/settings.js` — 공통(앱) 탭에 "다크 모드" select(light/dark/system, #darkModeSel),
  저장 즉시 자기 창 적용 + 커밋→브로드캐스트. swatch 선택 테두리를 `.swatch.on` 토큰화.
- `src/panel.js`·`src/handles.js`·`src/search-window.js`·`src/toast.js` —
  initStore 콜백에서 applyDarkMode + bindDarkMode (toast는 수신 전용 store 구독 추가).
- `src/style.css`/`src/settings.css`/`src/search.css` — 하드코드 색 → CSS 변수 토큰 전환.
  카드 --bg/--fg/--accent·핸들 --hbg/--hfg·검색 --chip은 인덱스 테마라 토큰 밖 유지 (R-08).
- `src/selftest.js` — darkmode-store-class/darkmode-light-system 2건 추가 (83종).
- `plan_setup/cdp-darkmode.cjs` — 창별 html.dark·store round-trip·인덱스 테마 보존 10건.

## 마무리한 것

- 마지막 QA 로그의 `peek-autoclose` FAIL(2연속) 원인 분석 → 동일 코드의 232047 런은
  83/83 통과. 다크모드 테스트(992행)는 peek-autoclose(170행)보다 뒤라 인과 불가,
  `pointerInside`/물리 커서 `:hover` 의존이라 환경 플레이크로 판정 → 재실행으로 확인.
- e2e 재실행에서 peek-autoclose 포함 83/83 통과 확인 → 플레이크 확정, 코드 수정 없음.
- QA 잔재 정리: APPDATA의 store.conflict-2026-11-18/19T*.json 4건(전부 e2e 런 시각과
  일치하는 테스트 산출물) 삭제. 프로세스·포트 잔재 없음 확인.

## 게이트 결과 (2026-11-19 01:3x)

- `npm run build` — OK (vite build 199ms)
- `cargo fmt -- --check` — OK
- `cargo clippy --all-targets -- -D warnings` — OK (0 warnings)
- `cargo test` — 37/37 pass
- `harness_setup/scripts/run-e2e.ps1 -Cdp cdp-darkmode.cjs` — selftest **83/83** +
  CDP **10/10**, `E2E: PASS` (증거: qa-logs/guseok-qa-20261119-013527.log)

## 수용 기준 근거

- 설정/패널 크롬/스트립 비인덱스 영역 light/dark/system 적용 — 5창 모두 html.dark 토글 +
  `--chrome-*`/창 고유 토큰 전환. CDP: 5창 dark=true/false 단언 통과.
- common.darkMode 보존·재시작 유지 — store.json `"darkMode"` round-trip 단언
  (selftest darkmode-store-class, CDP darkmode-saved).
- 인덱스 테마 무손상 — selftest가 토글 전후 카드 --bg/--fg 동일 단언, CDP가
  카드 --bg/--fg/--accent + 핸들 --hbg/--hfg 동일 단언 (PASS).
- 색 방향 = DESIGN D-4 승인 v1 — 팔레트 값 일치, 적용 범위(설정 전체·패널 크롬·
  스트립 +·토스트·검색 창)와 카드/핸들 제외 일치.
- 라이트 외관 회귀 없음 — :root 기본값 = 기존 하드코드 값 그대로 이전.
- IME 에디터 DOM 보호 — 토글은 documentElement.classList만, 에디터/본문 DOM 미접촉.
  initStore 콜백에서 applyDarkMode가 applyStyle 앞에 있어도 DOM 비파괴 (NFR-02).

## 남은 문제 / 메모

- `peek-autoclose`는 물리 커서 위치에 민감한 기존 테스트 — 간헐 플레이크 가능
  (이번 런 통과로 다크모드 무관 확인).
- `docs/DESIGN.md`(미추적)·`docs/PRD.md`·`plan_setup/*` 변경은 조정자 영역이라
  커밋에서 제외. `plan_setup/cdp-*.cjs`는 .gitignore 대상이라 미커밋이 관례.
