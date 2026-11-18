# phase-05-task-02 — attempt 1

## 목표
인덱스 표시/숨김의 데이터+필터 로직 (R-07). 토글 UI(우클릭 메뉴·설정 체크박스)는
phase-05-task-04(blocked) 책임 — 코어 함수·필터·불변식만 구현.

## 코어 API (`src/store.js`)
- `visibleIndexes(s = state)` — `hidden !== true` 필터의 단일 정본. 스트립 렌더·
  레이아웃·step·Ctrl+번호·panel 폴백이 전부 이 순서/조건을 공유 (검색의
  `idx.hidden === true` 제외와 동일 계약).
- `ensureOneVisible(s = state)` — 전부 숨김 금지 불변식: visible 0이면
  `indexes[0].hidden = false`. migrate()·handles.removeIndex·settings 삭제,
  세 경로에서 호출 — setIndexHidden을 거치지 않는 쓰기(외부 편집·삭제·복원)에서도
  "전부 숨김 발생 금지"가 구조적으로 성립.
- `setIndexHidden(id, hidden)` → `Promise<boolean>` — UI 없이 호출 가능한 코어.
  `visibleIndexes().length <= 1`이면 숨김 거절(false) = 마지막 1개 보호.
  멱등(이미 같은 상태면 true·저장 안 함). 숨기는 인덱스가 lastIndexId면
  첫 visible로 폴백 후 즉시 저장.
- `activeIndex()` — lastIndexId가 숨긴 인덱스면 첫 visible로 폴백
  (indexes[0]도 숨김이면 그래도 반환 — 방어적).
- migrate(): 인덱스 병합 시 `hidden: item.hidden === true` — 버전 무관 strict
  boolean 정규화(v1 STEPS[1] 정규화와 중복·상위호환). 전부 숨김 store도
  `ensureOneVisible`로 첫 인덱스 자동 표시.

## 필터 적용 지점
- `src/handles.js` — render()가 visible만 DOM 생성; layoutSig에
  `visibleIndexes().length` 추가(숨김만 바뀌어도 place 재실행 — stripH는
  visible 수로 계산되므로); renderSig를 visible 목록 기준으로 전환.
  `step()`는 visible 목록만 순환. `guseok://shortcut` action "index"는
  `openNthVisible(n)` = n번째 *visible*로 위임.
  `removeIndex()`는 삭제 후 `ensureOneVisible()` + lastIndexId를 첫 visible로.
  `export async setIndexHidden()` = 코어 호출 + refresh() — `window.__handles`
  훅에도 노출(`step`, `openNthVisible`, `setIndexHidden` — CDP 검증 경로).
- `src/layout.js` — `getLayout`의 count를 `visibleIndexes(state).length`로
  (스트립 높이·손잡이 높이가 숨김 수만큼 줄어든다). store.js import 추가
  — 단방향(store←layout 의존 없음)이라 순환 없음.
- `src/panel.js` — Ctrl+번호를 `visibleIndexes()[n-1]`로 (패널 창 실제 keydown
  경로). initStore/panel-open/selftest 복원의 인덱스 폴백을 first-visible 우선.
  **열린 패널의 인덱스가 숨겨져도 닫지 않는다** — hidden은 표시만 제외라
  `indexes`에 남고 `find(id)`가 계속 바인딩됨(보수적·PRD "데이터·메모 유지").
- `src/settings.js` — 인덱스 삭제 후 `ensureOneVisible()` + lastIndexId를
  첫 visible로 — 설정에서 visible 마지막 인덱스를 지워도 전부 숨김 불가.
- `src/search.js` — 변경 없음 (`idx.hidden === true` 제외 기존 구현,
  `search-hidden-excluded` 케이스가 커버 확인).
- 리마인더 — 스케줄러는 indexes[].reminders를 hidden 무관하게 읽는다 →
  **숨긴 인덱스도 계속 발화** (PRD/ARCH에 hidden 연동 명시 없음 → 보수적 유지).

## 결정: Ctrl+번호 = "n번째 visible 인덱스"
- R-07 "숨긴 인덱스는 Ctrl+번호 직접 열기·↑/↓ 순환 대상에서 제외"와 조정자 지시
  "숨긴 인덱스를 건너뜀"을, **단축키 상호작용의 대상 도메인 = visible 목록**
  하나로 통일 — step()의 visible 순환과 동일 규칙이며 스트립의 보이는 순서와
  번호가 일치(데드키 없음). 절대 번호 유지(숨긴 번호는 무응답) 해석도 가능했으나
  스트립 표시와 번호가 어긋나는 쪽보다 도메인 단일화가 보수적이라 판단.

## selftest 신규 (61 → 68/68, 패널 창 내 단언)
- `hidden-migrate-normalize` — v2 입력의 "yes"/1/누락 → false, true만 유지 +
  직렬화 키 보존.
- `hidden-migrate-all-hidden` — 전부 숨김 파일 → 첫 인덱스 자동 표시.
- `hidden-toggle-save` — setIndexHidden → state 반영 + load_store 영속 + vis-1.
- `hidden-active-fallback` — lastIndexId=숨긴 id → activeIndex() 첫 visible.
- `hidden-layout-count` — getLayout().count == visible 수.
- `hidden-ctrl-n-skip` — 패널 실제 keydown(Ctrl+1) 디스패치 → 첫 visible이
  열림(lastIndexId 관찰, hidden id와 다름 단언).
- `hidden-last-one-guard` — 나머지 전부 숨김 → 마지막 1개 setIndexHidden 거절.
- 단일 인덱스 환경 대비 visible<2이면 임시 인덱스 삽입 후 원복 — 항상 케이스 성립.

## CDP 신규 — `plan_setup/cdp-hidden-strip.cjs` (gitignore 대상 로컬 자산) 8/8
- 사전 안정화 대기 추가: SUMMARY 직후 panel 복원 저장이 guseok://store로
  handles state를 갈아엎어 1차 실행이 실패했던 경합(아래 검증 1차 참조) —
  `ext-file-stable` 패턴 재사용.
- 단언: `.handle` DOM 수 == visible 수, lay.count; setIndexHidden → DOM 제외·
  레이아웃 축소; step() 도달 id에 숨긴 인덱스 없음; openNthVisible(1/2) →
  n번째 visible; 마지막 1개 거절 후 DOM 1개 유지; unhide → DOM 복귀.

## 검증 (직접 실행)
- `npm run build` PASS / `cargo fmt --check` PASS / `cargo clippy -D warnings` PASS
- `cargo test` — **32/32 PASS** (Rust 변경 없음 — 기준선 유지)
- `run-e2e.ps1 -Cdp cdp-hidden-strip.cjs` — **E2E PASS**,
  selftest **68/68** + CDP **8/8**
  - 증거: .devil/loop/qa-logs/guseok-qa-20261118-194723.log
  - 1차 실행(194500): selftest 67/68(v2 입력 hidden 비boolean 미정규화 →
    병합 단계 strict-boolean 정규화로 수정) + CDP 4/7(복원 저장 경합 →
    안정화 대기 추가). 2차 전부 PASS.
  - store 스냅샷 복원·프로세스 정리 확인(guseok-memo 0, :5183/:9223 LISTEN 없음)

## 남은 문제·결정 근거
- 토글 UI 없음 — phase-05-task-04가 settings/스트립에서 `setIndexHidden`을 호출.
- 숨긴 인덱스의 panel-open은 차단하지 않음(보수적) — 어떤 경로로든
  show_panel(id)이 오면 열린다. 표시 면적만 줄이는 계약.
- openNthVisible(n)은 n > visible 수면 무응답 (절대 번호 시맨틱 아님).
- settings 탭 목록은 hidden 인덱스도 그대로 나열 — 다시 표시할 곳이 필요하므로
  R-07 "설정에서 다시 표시"와 일치 (UI 체크박스는 후속 태스크).
- 커밋 대상: src/{store,handles,layout,panel,settings,selftest}.js,
  .devil/loop/{phase-05-task-02,qa-logs}. 조정자 파일(plan_setup/tasks/*) 제외.
  cdp-*.cjs는 .gitignore 로컬 자산.
