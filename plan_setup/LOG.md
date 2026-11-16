# 구석메모 작업 로그

## 2026-11-15 — 전체 버그 조사 · 수정 · 검증

검증 환경: `npm run dev`(vite :5183) 실행 후 `src-tauri/target/debug/guseok-memo.exe --selftest [--qa-autostart]`.
디버그 exe는 devUrl(http://localhost:5183)을 로드하므로 vite 서버가 먼저 떠 있어야 한다.
결과는 `%TEMP%\guseok-qa.log`에 기록됨. 최종 결과: **SUMMARY 18/18 PASS** (기존 15 + 회귀 3).

### BUG-01 체크리스트 체크 상태가 저장되지 않음
- 재현: 체크박스를 켠 뒤 저장·재시작 → 텍스트엔 취소선이 남는데 상자는 비어 있음.
- 원인: `change` 핸들러가 `.done` 클래스만 바꾸고 `checked` **어트리뷰트**를 갱신하지 않음.
  `innerHTML`은 프로퍼티가 아니라 어트리뷰트를 직렬화하므로 체크가 저장에서 유실됨.
- 수정: `panel.js` — 토글 시 `setAttribute("checked","")`/`removeAttribute("checked")` 동기화.
- 회귀 검사: selftest `checkbox-persist` (innerHTML에 `checked` 직렬화 확인) — PASS.

### BUG-02 체크리스트 안에서 Enter/Backspace가 동작하지 않음
- 재현: 체크 항목에 커서를 두고 Enter → 새 항목이 생기지 않고 `ck-text` 안에 개행만 생김.
- 원인: 핸들러가 `e.target.closest(".ck")`를 쓰는데 contenteditable 에서 keydown의
  `e.target`은 항상 편집 호스트(`#editor`)라서 해당 분기가 절대 실행되지 않았음.
- 수정: `panel.js` — 선택 영역 기반 `ckFromSelection()` 도입해 Enter/Backspace 분기 교체.
  추가로 비어 있지 않은 항목 맨 앞 Backspace는 항목을 일반 단락으로 해제(unwrap)하도록 처리.
- 회귀 검사: selftest `ck-enter-new-row`, `ck-backspace-unwrap` — PASS.

### BUG-03 "왼쪽 표시" 설정이 패널 재시작 시 무시됨
- 원인: `boot()`가 `initStore` 이전에 `panelEl.dataset.side`를 읽어 항상 기본값("right") 적용.
- 수정: `panel.js` — initStore 이후로 이동. 외부 변경 핸들러는 기존대로 유지.
- 추가: 왼쪽 모드에서 카드 border-radius·box-shadow가 반전되지 않던 CSS도 미러링.

### BUG-04 "자동" 모니터가 첫 호출 모니터에 고정됨
- 원인: `layout.js`의 `autoCache`가 첫 `work_area("auto")` 결과를 영구 캐시 →
  커서를 다른 모니터로 옮겨도 스트립/메모가 항상 첫 모니터에 열림.
- 수정: 캐시 제거, 매 호출 시 커서 위치 기준으로 재해석.
  `handles.js` `open()`도 오래된 `lay` 재사용 대신 매번 `getLayout` 호출로 변경.

### BUG-05 "단축키 조작" 모드가 아무 동작도 하지 않음
- 원인: `state.common.mode` 값을 읽는 곳이 없어 스트립이 항상 표시됐고,
  `place_handles`의 `visible=false`도 실제로는 hide를 호출하지 않았음.
- 수정: `place()`에서 `mode !== "shortcut"`이면 `visible:false` 전달,
  Rust `place_handles`에 `else { win.hide() }` 추가.
- 검증: store를 `mode:"shortcut"`로 패치 후 실행 → `place_handles visible=false` 로그 확인,
  이후 원본 store 복원 완료.

### BUG-06 인덱스 1개일 때 Ctrl+Shift+↑/↓가 메모를 닫아버림
- 원인: `step()`이 같은 인덱스로 `open()`을 호출 → `open()`의 토글 로직이 닫기로 해석.
- 수정: `handles.js` — `next.id !== activeId`일 때만 `open()`.

### BUG-07 빼꼼 모드가 커서 위를 무시하고 패널을 닫음 / 내보내기 대화상자 중 닫힘
- 원인 1: 창이 움직이지 않는 커서 아래에 나타나면 `mouseenter`가 발생하지 않아
  `pointerInside`가 false로 남아 peek 지연 후 닫힘.
- 원인 2: 내보내기(`save`) 대화상자 동안 `busy`가 설정되지 않아 blur→자동 닫힘.
- 수정: `panel.js` — 열릴 때와 close 시도 루프에서 `documentElement.matches(":hover")` 재확인,
  export 대화상자 구간 `busy` 설정, focus 복귀 시 포인터가 밖이면 닫기 재예약.

### BUG-08 비율·표시 위치·모니터 변경 시 열려있는 패널 위치 미갱신
- 수정: `panel.js` — `geomKey(ratio|side|monitor)` 추적해 열린 상태에서 변경 시
  `panelRect` 재계산 후 크기·위치 재적용.

### BUG-09 `--qa-autostart`가 기존 자동실행 등록을 지움
- 원인: 테스트 끝에 무조건 `set_autostart(false)` → 사용자의 Run 키가 삭제됨.
- 수정: `main.rs` — 기존 값을 먼저 읽고 테스트 후 원래 값(없으면 삭제)으로 복원.

### BUG-10 복원(백업 불러오기)이 마이그레이션을 거치지 않음
- 원인: `Object.assign(state, parsed)` 그대로 병합 → 필드 누락·형식 오류 백업이 그대로 주입.
- 수정: `store.js` `migrate`를 export하고 `settings.js` 복원에서 `migrate(parsed)` 적용.
  `migrate` 자체도 비객체 인덱스 항목·null raw를 방어하도록 보강.

### BUG-11 설정 창이 외부 저장 이벤트로 사용 중 컨트롤을 재생성
- 원인: 패널 타이핑 → 260ms마다 store 이벤트 → 설정 `render()` → 슬라이더/입력이 드래그·입력 중 파괴.
- 수정: `settings.js` — 포커스된 폼 컨트롤이 있으면 렌더를 큐잉하고 상호작용 종료 후 반영.

### BUG-12 에디터 플레이스홀더가 표시되지 않음
- 원인: `.editor:empty` 선택자 — 에디터엔 항상 `<p><br></p>`가 있어 절대 매칭 안 됨.
- 수정: `is-empty` 클래스 토글(`updateEmptyState`) + CSS `.editor.is-empty::before`.

### BUG-13 투명 PNG 첨부 시 배경이 검게 저장됨
- 원인: JPEG는 알파가 없는데 캔버스 투명 영역을 그대로 인코딩 → 검정.
- 수정: `compressImage` — 그리기 전 흰색 채우기, `bitmap.close()`로 메모리 해제.

### BUG-14 설정 창을 닫을 때 디바운스된 마지막 변경이 유실될 수 있음
- 수정: `store.js` — `pagehide` 시 대기 중인 저장을 즉시 `save_store` 호출로 플러시.

### BUG-15 손잡이 스트립이 타이핑할 때마다 재배치·재렌더됨
- 원인: 패널 자동저장 → store 이벤트 → `refresh()`가 무조건 `place_handles` IPC + DOM 재생성.
- 수정: `handles.js` — `layoutSig`(side/monitor/anchor/mode/count)와
  `renderSig`(핸들 데이터+활성+높이) 시그니처가 바뀔 때만 실제 작업 수행.

### BUG-16 이미지 크기 슬라이더가 틱마다 전체 그리드를 재생성
- 수정: `panel.js` — `input` 이벤트에서 선택 블록의 `width`만 직접 갱신.

### BUG-17 셀프테스트가 기존 메모 데이터 의존적
- 증상: 메모에 이미 이미지가 있으면 `image-add`/`image-delete`가 실패(개수 기대값 어긋남).
- 수정: `selftest.js` — 이미지 검사 전 `idx.images = []`로 초기화(스냅샷 복원은 기존대로).

### BUG-18 설정 창이 하얗게 멈춤 (사용자 신고)
- 재현: 설정 버튼 클릭 → 창은 뜨지만 내용이 없는 흰 화면 + 앱 응답 없음.
- CDP 관찰: `invoke("open_settings")`가 resolve되지 않고, 설정 OS 창은 생성되지만
  webview가 `about:blank`에서 멈춤(페이지 타겟이 `about:blank`로만 존재, 네비게이션 없음).
- 원인: `open_settings` 커맨드 안에서 `WebviewWindowBuilder::build()`를 런타임에 호출.
  Tauri 2/Windows에서 커맨드 핸들러(비 메인 스레드) 안의 웹뷰 생성은 WebView2 생성 대기가
  자신이 막고 있는 이벤트 루프를 필요로 해 데드락. setup에서 만드는 handles/panel 창은
  메인 스레드에서 생성돼 정상이었던 것과 대조적.
- 수정: 설정 창을 setup에서 `visible(false)`로 미리 생성해 두고,
  `open_settings`는 show/unminimize/focus만 수행(신규 웹뷰 생성 없음).
  `CloseRequested`를 가로채 hide로 바꿔 창이 파괴되지 않고 재사용(닫기 버튼·OS X 모두).
  `?tab=` 지정은 `guseok://open-tab` 이벤트로 대체.
- 회귀/검증: CDP로 설정 버튼 클릭 → `settings.html` 타겟 + readyState complete +
  body 13개 항목 렌더 확인, 닫기 후 재오픈 시 타겟 유지·상태 보존 확인(release exe).
  셀프테스트 18/18 통과(설정 창이 부팅부터 존재해도 회귀 없음).
- 참고 스크립트: `plan_setup/cdp-*.cjs`(WebView2 원격 디버깅 검사용).

### 함께 고친 잡다한 결함
- `panel.js`: Ctrl+숫자 핸들러의 중복 dynamic import 제거(상단 import 사용),
  `changeFont` 시 글꼴 팝오버 수치 동기화, 외부 이벤트로 제목 입력 중 덮어쓰기 방지,
  `btnCheck`가 빈 단락을 비우고 체크 항목을 삽입하도록 정리.
- `settings.js`: 글자색 직접 지정 시에도 테마 선택 해제(`theme=-1`), 글꼴 미리보기 즉시 반영,
  버전 표기를 `getVersion()`으로 실제 버전과 동기화.
- `main.rs`: `place_handles`에 `visible=false → win.hide()` 추가(BUG-05).

### 검토했으나 미적용
- `handles` 창 `focusable(false)`: 포커스 탈취 방지 효과는 있으나 OS 드래그 동작을 이 환경에서
  끝까지 검증할 수 없어 보수적으로 제외. 현재 지연 로직으로 깜빡임은 이미 흡수됨.
- `common.hideTaskbar`, `common.toggleBy`, `uid()`: 미사용 키/함수 — 저장 데이터 호환 위해 유지.

### 미검증 (수동 확인 권장)
- 멀티 모니터에서 "자동" 해결이 실제 커서 모니터를 따라가는지 실기 확인(로직상 커서 기준 재해석).
- 왼쪽 표시 모드의 카드 그림자·모서리 미러링은 CSS 변경이며 시각 확인만 남음.
- 설정 창 상호작용 중 외부 업데이트 지연 렌더는 구현 확인, 실제 드래그 중 체감 확인은 수동.

---

## BUG-07 — 사용자 보고 "설정 버튼 → 흰 화면 정지" 재점검 (2026-11-16)

- 증상: 수정 후에도 설정이 안 된다고 재보고.
- 조사: 설치본 `C:\Users\김민오\AppData\Local\GuseokMemo\guseok-memo.exe` 가
  **Nov 14 빌드(수정 전)** 임을 확인. 새 릴리스 exe 로는 CDP 검증 완료 상태였음.
- 결론: 코드 결함 아님 — 구버전 설치본 실행이 원인. 새 설치 파일/자동 업데이트로 해소 예정.

## FEAT — GitHub 배포 + 자동 업데이트 (v0.2.0, 2026-11-16)

- 리포: https://github.com/Logic-k/GuseokMemo (public, main 푸시 완료)
- 업데이트 스택 (devil-of-devin 패턴 차용):
  - Rust: `tauri-plugin-updater` + `tauri-plugin-process`, capabilities 에
    `updater:default` / `process:default` / `process:allow-restart`
  - `tauri.conf.json`: `bundle.createUpdaterArtifacts: true`,
    `plugins.updater` — pubkey + endpoint
    `https://github.com/Logic-k/GuseokMemo/releases/latest/download/latest.json`,
    Windows installMode passive
  - 프런트: `src/updates.js` — `checkForUpdate()` / `installUpdate()`(downloadAndInstall→relaunch)
  - 자동 실행: `handles.js` 부팅 5초 뒤 확인 → 새 버전 있으면 설치 후 재시작
    (`import.meta.env.DEV` 에서는 생략)
  - 수동: 설정 → 앱 → 업데이트 → 지금 확인
- 서명 키: `~/.tauri/guseok-memo.key` (로컬 전용, 저장소 미포함).
  pubkey 만 config 에. CI 시크릿 `TAURI_SIGNING_PRIVATE_KEY` 설정 완료.
- 릴리스: v0.2.0 에 `GuseokMemo_0.2.0_x64-setup.exe` + `.sig` + `latest.json` 업로드.
  `latest.json` 엔드포인트 실서빙 확인.
- CI: `.github/workflows/release.yml` — `v*` 태그 푸시 시 tauri-action 이
  빌드·서명·Release·latest.json 자동 생성 (`includeUpdaterJson: true`).
- 검증:
  - `npx tauri build` → setup.exe(1.86 MiB) + `.sig` 생성, 빈 비밀번호 키로 서명
  - 릴리스 exe `--selftest` → **18/18 PASS**, autostart QA PASS, store-restore PASS
  - 업데이트 체크가 릴리스 존재 전엔 `Could not fetch a valid release JSON` 실패 로그,
    릴리스 후엔 실패 로그 없음(= fetch·파싱·버전 비교 성공, 최신이라 설치 생략)
  - 설치·재시작 경로는 tauri-plugin-updater 표준 플로우 — 실 업데이트는 차기 버전에서 확인 가능
- 남은 수동 확인: 구버전 설치본 → v0.2.0 자동 업데이트 실기 동작(구버전엔 updater 없음 —
  이번 한 번은 새 설치 파일로 교체 필요. 이후 버전부터 자동).

---

## BUG-08 — 인덱스 간 메모 오염 + 저장 유실 (2026-11-16, 사용자 신고)

- 증상: "메모가 각각 저장되지도 않고, 해당 메모가 다른 인덱스에도 연결되네요"
- 실데이터 증거: store.json 의 welcome1 콘텐츠에
  `<div class="ck"><input type="checkbox"> 텍스트<span class="ck-text"></span></div>` 처럼
  입력 텍스트가 `.ck-text` span 밖 고아 텍스트 노드로 저장된 구조 발견.
- 원인 1 (오염): `panel.js render()` 가 `editor.matches(":focus")` 이면
  `renderContent()` 를 건너뜀. 패널이 열린 상태에서 다른 손잡이 클릭/Ctrl+숫자/단축키로
  인덱스를 전환하면 `idx` 만 새 인덱스로 바뀌고 DOM 은 이전 메모를 유지 →
  이후 `idx.content = editor.innerHTML` 이 이전 메모 내용을 새 인덱스에 기록·저장.
- 원인 2 (저장 유실): `guseok://store` 수신 시 `state = migrate(incoming)` 로
  전체 state 를 통째 교체 → 다른 창의 디바운스 저장이 패널의 미저장 편집을 덮어씀.
  또한 `pagehide` 플러시는 디스크에만 쓰고 emit 을 안 해, 닫힌 뒤 다른 창의
  stale state 저장이 마지막 편집을 되돌릴 수 있었음.
- 원인 3 (자동 닫힘 잔존): `panel-open` 이 대기 중인 `closeTimer` 를 해제하지 않아
  빼꼼 자동 닫힘 예약 상태로 재오픈하면 새 패널이 곧바로 닫힘.
- 수정:
  - `render()`: `switched`(인덱스 id 변경) 시 포커스와 무관하게 `renderContent()` 강제.
  - `panel-open` 리스너: 전환 전 `idx.content = editor.innerHTML` 확정 +
    `state.common.lastIndexId = target.id` + `saveStore({immediate:true})` + `cancelClose()`.
  - `handles.js open()`: `lastIndexId` 변경을 immediate 저장으로 앞당김.
  - `store.js`: JS emit 제거 → Rust `save_store` 가 저장 성공 시
    `guseok://store`(src:"disk")를 브로드캐스트 → pagehide 플러시도 전파.
    `migrate()` 에 인덱스 id 검증/중복 제거 추가.
  - `panel.js`: `normalizeChecklist()` — 렌더 시 `.ck` 의 input/span 외 자식을
    `.ck-text` 안으로 이동(고아 텍스트 자가 복구). `htmlToMarkdown` 은 `.ck` 의
    `textContent` 전체를 읽어 고아 텍스트도 내보내기에 포함.
- 회귀 검사: selftest 에 `index-switch-rerender`/`index-switch-back` 추가
  (에디터 포커스 상태에서 다른 인덱스 오픈 시 내용이 실제로 바뀌는지 단언).
  `peek-autoclose` 는 peekDelay=1500 환경에서 1900ms 고정 대기가 부족해
  최대 6초 폴링으로 보강.
- 검증:
  - debug selftest **20/20 PASS** (신규 2 + 기존 18)
  - CDP 실사용 재현 (`plan_setup/cdp-index-isolation.cjs`):
    A 입력→B 전환→B는 자기 내용만, A 복귀 시 내용 유지,
    store.json 에서 A/B 내용 분리 저장 확인, welcome1 고아 텍스트 정규화 확인
  - 첫 실행의 mode-peek/store-write 실패는 검증 중 실수로 중복 실행한
    인스턴스가 single-instance 토글을 보내 발생한 테스트 아티팩트(재실행 시 통과)
- 참고: selftest 가 캡처한 `idx` 참조는 외부 store 이벤트로 state 가 교체되면
  분리되므로, 테스트 중 외부 저장 이벤트가 끼어들면 간헐 실패 가능 — 운영 경로는
  panel.js 모듈 `idx` 가 externalHandler 로 재연결돼 영향 없음.

### BUG-08 후속 — v0.2.1 릴리스 (2026-11-16)
- `npx tauri build` → `GuseokMemo_0.2.1_x64-setup.exe`(1.86 MiB)+`.sig` 생성,
  릴리스 exe selftest **20/20 PASS**
- GitHub Release v0.2.1 에 setup.exe+.sig+latest.json 업로드,
  `releases/latest/download/latest.json` 이 v0.2.1 서빙 확인
- 코드 푸시: main `7a61e3e`

## BUG-09 — 한글 입력이 두 번 눌리는 것처럼 깨짐 (2026-11-16, 사용자 신고)

- 재현: 한글 입력 시 "테스트"가 "ㅌ 테스"처럼 앞 자모만 확정되고
  다음 키에서 새 조합이 시작되는 현상. 타이핑 버스트마다 반복.
- 원인(복합):
  1. **자기 저장 에코**: BUG-08 수정에서 브로드캐스트를 Rust `save_store`로
     옮기면서 `src`가 창 라벨이 아닌 `"disk"`로 고정돼, 패널 자신의 저장도
     외부 이벤트로 되돌아옴 → `initStore` 리스너가 `state = migrate(...)` 교체 +
     externalHandler 호출 → `applyStyle`이 포커스된 편집기의
     `spellcheck`·폰트 스타일을 기록 → WebView2 IME 조합 파기.
  2. **조합 중 DOM 변경**: `updateEmptyState`가 첫 입력 시 `is-empty` 클래스를
     토글 — 이것도 포커스된 편집기의 속성 변경이라 첫 글자 조합을 깰 수 있음.
  3. **stale 덮어쓰기 잔여 경로**: 외부 이벤트가 `state`를 통째 교체하면
     편집 중인 `idx` 객체가 분리(detach)되고, 대기 중인 디바운스 저장이
     stale 내용을 디스크에 씀.
- 수정:
  - `main.rs` `save_store`: 브로드캐스트 `src`에 **저장한 창의 라벨**
    (`webview.label()`)을 실어 보냄 — `WebviewWindow` 파라미터로 호출 창 확보.
  - `store.js`: 에코 필터를 `payload.src === getCurrentWindow().label`로 복원
    (기존 `INSTANCE` 랜덤값은 창 간 고유하나 저장 쪽 src와 정합성 없음 → 라벨 방식으로 통일).
  - `panel.js` 외부 핸들러:
    - `applyStyle(target, touchEditor)` — 포커스된 에디터는 style/spellcheck 미적용.
    - 같은 인덱스 편집 중이면 `idx.content = editor.innerHTML`로 **화면 DOM을
      상태에 되심어** 대기 저장이 방금 친 텍스트를 지우지 않게 함
      (타이틀 입력 중에도 동일 처리).
    - 인덱스가 실제로 전환된 경우(`switched`)에는 포커스와 무관하게 렌더 —
      BUG-08 오염 수정 보존.
    - 포커스 중엔 `renderContent`/`renderImages`/기하 재배치 스킵.
  - `panel.js` `updateEmptyState`: `composing` 플래그로 compositionstart~end 사이
    클래스 토글 유예, `compositionend`/`blur`에서 해제.
- 회귀 검사:
  - selftest `self-echo-skip` — 자기 저장 에코가 state 를 되돌리지 않는지 단언 → PASS.
  - `plan_setup/cdp-ime-check.cjs` — ①자기 에코 무시 ②외부 저장은 정상 전파
    ③조합 중 외부 저장에도 포커스 편집기 DOM 불변 — 3/3 PASS.
  - CDP `Input.imeSetComposition` 실제 한글 조합 검증: 조합 중 save_store 호출
    → 조합 텍스트 노드 identity 유지, `테→테스→테스트` 정상 커밋.
  - `cdp-index-isolation.cjs` 재실행 — 인덱스 분리 저장 유지 확인
    (테스트 인덱스 동적 생성 방식으로 변경 — 사용자 store가 리셋되어
    기존 고정 ID가 없어졌고, 핸들 미렌더 시 즉시 중단해 오염 방지).
  - debug selftest **21/21 PASS**.
- 미검증: 실제 Windows IME(타자기)로의 손 타이핑 — CDP imeSetComposition 으로는
  조합 유지를 확인했지만 실키보드 경로는 사용자 확인 필요.
- 주의: CDP 테스트가 panel 쪽에서 인덱스를 만들 때 handles 핸들은 외부 이벤트로
  렌더됨(자기 에코 무시의 부수효과) — 테스트 작성 시 유의.
