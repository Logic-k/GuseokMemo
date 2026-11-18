# phase-05-task-04 attempt-1 — D-5 템플릿/스니펫/인덱스 숨김 UI

## 변경 요약

코어(task-01/02)를 UI로 노출 — DESIGN D-5 승인안 그대로 구현.

- **Rust** (`src-tauri/src/main.rs`): `pick` 창을 setup에서 미리 생성
  (`index.html?pick=1`, transparent·always_on_top·focused(false)·visible(false) —
  toast/search와 같은 사전 생성·hide/show 재사용 패턴). `place_pick(x,y,w,h,visible)`
  커맨드 신규: 표시 시 set_size+set_position+show+set_focus 후 `guseok://pick-open`
  emit, 숨김 시 hide. 핸들러 등록.
- **ACL** (`src-tauri/capabilities/pick.json`): `core:event:default`만 — pick 창은
  이벤트 송수신만 하고 창 제어는 handles 쪽 커맨드가 담당(toast.json과 동일 패턴).
  `gen/schemas/capabilities.json`은 cargo build 자동 재생성분.
- **index.html / src/main.js / src/pick.js**: `?pick=1` 라우트 + `#pick`/`#pickList`
  호스트. pick.js는 `빈 메모`+`state.templates[]` 세로 목록 렌더, 항목 클릭 →
  `guseok://pick-select {id}`(빈 메모 `""`), Esc/포커스 상실(400ms 유예) →
  `guseok://pick-cancel`. 외부 저장 브로드캐스트 시 목록 재렌더, darkmode 바인딩.
- **src/handles.js**: `addIndex(templateId)` 확장 — 템플릿이면 코어 `applyTemplate`로
  본문 채우고 이름(8자)을 제목으로, 이후는 기존 저장·열림 경로 그대로.
  `+` 클릭 → `openTemplatePick()`(스트립 세로 중앙·작업영역 클램프, panelRect와
  같은 규칙). `pick-select` → 닫기+addIndex, `pick-cancel` → 닫기(멱등).
- **src/panel.js**: 툴바 `❖`(index.html `btnSnippet`) → `#snipPop` 팝오버
  (snip-item 목록 = state.snippets). 버튼·팝오버 mousedown preventDefault로
  캐럿 보존 → 클릭 시 코어 `insertSnippet` 치환 결과를 `execCommand insertText`로
  캐럿 위치에 삽입(캐럿이 에디터 밖이면 본문 끝). **IME 조합 중 삽입 차단**
  (`composing` 플래그) + 안내 토스트. Esc/외부 pointerdown으로 닫힘.
- **src/settings.js**: 인덱스 탭을 `.tab-cell`(탭+눈 `.tab-eye`)로 래핑 — 눈 클릭
  시 `setIndexHidden` 코어 호출, 숨긴 탭은 `.hid` 반투명+`숨김` 배지, 다시 누르면
  표시. 마지막 visible 1개 거절 시 status `마지막 메모는 숨길 수 없어요`. 고정 탭
  `템플릿` 신설 — 템플릿·스니펫 목록/추가/편집/삭제(미리보기·builtin 표시).
- **CSS**: `style.css`에 `.pick*`(창용 카드 목록)·`.snip-pop`(rem-pop 계열
  팝오버), `settings.css`에 `.tab-cell/.tab-eye/.tab-hid`/템플릿 탭 행 —
  전부 `--chrome-*` 토큰이라 light/dark 자동 추종.
- **selftest +3 (86/86)**: `pick-window-exists`(창+커맨드),
  `snip-pop-insert`(목록 수·치환 본문 캐럿 삽입), `snip-pop-ime-block`.
- **plan_setup/cdp-template-snippet.cjs** (gitignore 대상, 로컬 증거): 실사용 경로
  11건 — 타겟 발견/선택창 오픈+목록/Esc 취소/템플릿 생성(제목·본문·lastIndexId·
  창닫힘)/스니펫 삽입/눈 아이콘 렌더·숨김(스트립 제외)·재표시·마지막 1개 거절.
  숨김은 settings 창 `.tab-eye` 클릭으로 수행해 실 UI 경로 검증.

## 검증 실행 결과

- `npm run build` — PASS
- `cargo fmt -- --check` — PASS(초기 diff → `cargo fmt` 적용 후 통과)
- `cargo clippy --all-targets -- -D warnings` — PASS
- `cargo test` — 37/37 PASS
- `run-e2e.ps1 -Cdp cdp-template-snippet.cjs` — **E2E PASS**
  - selftest **86/86** (신규 3건 포함 전원 통과)
  - CDP **11/11** (첫 실행 시 `settings-eye-render` 1건 FAIL — 기대 인덱스 수를
    템플릿 생성 전 스냅샷(s0)으로 잡은 스크립트 버그, sNow 기준으로 수정 후 통과.
    구현 결함 아님)
- 증거 로그: `.devil/loop/qa-logs/guseok-qa-20261119-020945.log`

## 남은 문제·메모

- pick 창은 OS 포커스를 가져가 Esc/외부클릭 닫힘을 구현 — 의도된 동작이며
  panel/IME 조합은 영향 없음(창 활성 시 에디터는 비조합 상태).
- `settings-eye-hide` 등은 사용자 store 스냅샷 위에서 동작 — 스크립트 종료 시
  생성 인덱스·숨김 플래그·lastIndexId 원복 + 러너가 store 스냅샷 복원.
- 보수적 결정: 스니펫 팝오버가 조합 중에도 열리는 것은 허용(조합은 에디터 내부
  상태, 팝오버 DOM은 에디터 밖)하되 **삽입만 차단** — NFR-02 "DOM·스타일 미변경"
  의 취지는 에디터 영역 한정으로 해석.
