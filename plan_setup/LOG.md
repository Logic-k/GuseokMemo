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

## BUG-10 — 체크리스트 항목 안에서 한글 입력이 계속 깨짐 (2026-11-16, 사용자 신고)

- 재현: 일반 문단은 v0.2.2에서 해결됐으나, `.ck` 체크리스트 항목 안에서는
  여전히 "2번 눌림/글자 갈라짐" 발생.
- 원인: `.ck` 전용 keydown 경로가 IME 조합을 가로챔.
  1. **조합 중 Enter** — 항목 끝 Enter(마지막 자모 확정 의도)가
     `ckFromSelection()` → `preventDefault()` + 새 `.ck` 행 생성 + `caretInto`로
     커서 이동 → 활성 조합이 강제 확정/유실. 한글 입력은 항목마다 Enter를
     누르므로 매번 재발.
  2. **조합 중 Backspace** — 빈 항목에서 조합 시작 직후 Backspace 시
     행 삭제/unwrap이 조합 중 DOM을 교체할 수 있는 경로.
  3. **btnCheck의 `setTimeout` 정리** — 체크리스트 버튼으로 행 생성 후
     `el.textContent = ""` + `placeCaretEnd`가 0ms 뒤 실행 — 생성 직후 바로
     타이핑을 시작하면 막 시작된 조합을 지움.
  4. `selectionchange`/`keyup` → `syncToolbar` → `queryCommandState` 난사도
     조합 중 잡음(보수적으로 차단).
- 수정 (`src/panel.js`):
  - keydown 핸들러 최상단에 `e.isComposing || e.key === "Process" || keyCode === 229`
    가드 — 조합 중엔 커스텀 Enter/Backspace 처리 전면 중단. 조합 Enter는
    브라우저가 커밋만 하고 삼키므로, 다음 Enter가 행 생성(표준 동작).
  - `btnCheck` 클릭의 `setTimeout` 정리 제거 — `<br>` 유지해도 입력에 지장 없음.
  - `syncToolbar`에 `composing` 가드.
- 검증:
  - CDP `imeSetComposition` + `dispatchKeyEvent`: 조합 중 Enter → 행 수 1 유지·
    조합 텍스트 보존; 조합 종료 후 Enter → 새 행 정상 생성; 빈 행 Backspace →
    행 삭제 정상.
  - selftest `ime-enter-no-row`, `ime-enter-after-commit` 추가 →
    **23/23 PASS**.
  - 일반 `<p>` 조합은 이번 변경 영향 없음(기존 통과 경로 동일).

## FEAT-1 — 편의성 개선 묶음: 패널 내 제목/투명도, 사이드바 추가·삭제, 멀티모니터 자석 스냅 (2026-11-17, 사용자 요청)

- 요청:
  1. 메모 제목을 설정 진입 없이 패널에서 바로 변경.
  2. 투명도를 메모 작성 중 조절.
  3. 사이드바에서 메모 추가·삭제.
  4. 빈 메모는 "여기에 적어주세요" 표시, 입력 시 사라짐(혼동 최소화).
  5. 좌/우·듀얼모니터 — 스트립을 가장자리 근처로 옮기면 자석처럼 스냅.
- 구현:
  - `index.html`: titleInput에 placeholder="메모 이름"/title="제목 바꾸기",
    fontPop에 투명도 range(25–100, 5단계)+값 표시 추가,
    에디터 placeholder 문구를 "여기에 적어주세요"로 정합.
  - `src/style.css`: 제목 hover/focus 시 밑줄·배경으로 편집 가능 어포던스,
    `.handle-add`(점선 + 버튼), `.handle.del-armed`(빨간 펄스 "삭제") 스타일.
  - `src/panel.js`: opacityRange input → `idx.opacity` + `applyStyle(idx,false)`
    (카드 배경만 — IME 조합 중 에디터 미변경), change 시 saveStore.
    제목 입력은 기존 input→persist 경로 그대로(발견성만 개선).
  - `src/handles.js`: 스트립 하단 `+` 버튼(`MAX_INDEXES` 미만일 때) →
    defaultIndex+테마 배정 후 즉시 저장·열람. 핸들 우클릭 → 2.6초간
    "삭제" 무장(del-armed) → 한 번 더 클릭 시 삭제(활성이면 패널 닫기,
    마지막 1개는 삭제 불가). `__handles` CDP 테스트 훅 노출.
  - `src/layout.js`: `getLayout(state, showAdd)` — `+` 버튼 높이(ADD_H=30)를
    스트립 높이에 반영.
  - `src-tauri/src/main.rs`: `monitors` 명령 추가 — 모든 모니터의 작업 영역
    (논리 좌표) 반환.
  - `snapToEdge` 재작성 — 드래그 종료 지점 기준 **모든 모니터**의 좌/우
    가장자리 후보 중 최소 거리 선택(상하 배치 구분용 y범위 벗어남 패널티),
    `state.common.side`/`monitor`/`anchor` 갱신 후 place+즉시 저장.
    기존: 선택된 모니터 안에서만 스냅.
- 검증:
  - selftest 신규 `title-edit-panel`, `opacity-panel`, `placeholder-attr`
    포함 **26/26 PASS** (debug exe + vite).
  - `cdp-sidebar-features.cjs` **9/9 PASS** — monitors 명령(2대 반환),
    `+` 클릭→인덱스 추가→패널 자동 오픈, 우클릭 무장→클릭 삭제,
    모니터0 좌/우·모니터1 좌 가장자리 스냅 각각 정확한 side/monitor 선택.

## Loop 실행 (2026-11-18, dod-runner)

- 시작: 사용자 지시로 Loop 승인·실행. 환경: 로컬 메인 체크아웃, 순차(동시 구현 상한 1). 역할별 모델 (미정) → 프로필 기본값 사용(보수적 선택, LOOP.md §2 규칙).
- 기준선 커밋 `loop(bootstrap)` — research/docs/plan/harness/loop 체계.
- blocked 6개 사유 확인: docs/DESIGN.md 부재(사용자 승인 전) + OQ-02/03 사용자 결정 미해소 → 계약상 blocked 유지. pending 12개부터 순차 실행.
- phase-01-task-01 completed (274c85d): 스키마 v2·migrate STEPS 연쇄·v1 fixture·selftest +3 → 29/29. 독립 검증 PASS. main.rs 기준선 fmt/clippy 정리 동행(동작 변경 없음). notifyMethod:"panel"은 OQ-02 임시값.
- phase-01-task-02 completed (76e793b+4253cb3): rename_with_retry 백오프 50/100/150ms + 단위 6건(실 점유 재현). 독립 검증 PASS, e2e 29/29. 참고: 구현자 중단→재개 경로에서 동일 변경 커밋 2개 발생(제품 diff 동일, 후자는 attempt+증거만). run-e2e "early exit" 오판 사례 1회 — qa.log SUMMARY로 실제 PASS 확인, harness 판정 개선 후보.
- phase-01-task-03 completed (2150f93): rust-version 1.90, 버전 세트 확인(tauri 2.12.5·updater 2.14.1·wry 0.57.2 등, 커밋 메시지). validator PASS — phase-01 완료.
- phase-02-task-01 completed (e0b5c01): src/search.js — extractText+search 코어, hidden 제외, selftest +10 → 39/39. validator PASS.
- phase-03-task-01 completed (7313cd6): Rust 스케줄러 스레드(2s)·save_store 스케줄 동기화·guseok://reminder emit·놓침 분류. cargo 18/18, selftest 42/42, validator PASS.
  - 주의: selftest waitQa가 append-only 로그 전체 스캔 → 이전 런 stale 라인 거짓양성 가능(기능은 별도 실증 PASS) — 후속 태스크에서 마커 이후 구간만 스캔하도록 개선 후보.
  - lastFiredAt 디스크 기록은 JS 리스너가 필요 — phase-03-task-02(blocked) 범위. 재시작 시 이전 발화분은 missed 재보고(정상).
- phase-04-task-01 completed (18dceb4): config.json 포인터 + get/set_data_dir + 복사·보존 이전. cargo 25/25, selftest 42/42, CDP cdp-data-dir 15/15 — 검증자가 실 재기동·ACL 쓰기거부 추가 실측 PASS. 주의: config.json BOM 시 기본 폴백(무해).
- phase-04-task-02 completed (74fcdb3): mtime+len 2s 폴링 자동 리로드, FileStamp 자기에코 억제, src:"external" emit. 반영 지연 0.6~2.2s. cargo 32/32, selftest 45/45, CDP 5/5, validator PASS.
  - 비차단 관찰: qa_write가 deny-write 리더 시 라인 유실 가능(관찰 정본 주의), extHits 스테일 라인 약한 단언, 부팅~2s reload 1건 발생(TOCTOU — JS dedup으로 무해, 충돌 경로 task-03에서 재검토).
- phase-05-task-01 completed (8094966): src/templates.js — applyTemplate/insertSnippet/snippetValues, snippets[] 최상위 스키마 신설(ARCH §5 무정의 → 별도 배열 보수적 선택, TRD TD-10 보존 정합). selftest 61/61, validator PASS.
- phase-05-task-02 completed (2da48d6): visibleIndexes/ensureOneVisible/setIndexHidden 코어 + 스트립·step·Ctrl+번호·layout 필터. Ctrl+번호=n번째 visible 해석(보수적, 근거 attempt). 리마인더는 hidden 무관 발화 유지. selftest 68/68, CDP 8/8, validator PASS.
- phase-06-task-01 completed: TD-09 noRedirectionBitmap **기각** — 적용 빌드에서만 검은 프레임 2건 재현(Win10 19045, 흰 플래시 양쪽 0건 → 이득 없음), 태스크 규칙대로 롤백. 소스 HEAD 복귀, selftest 68/68 유지. 관찰 증거 .devil/loop/phase-06-task-01/attempt-1.md.
- phase-06-task-02 completed (ed62069): TD-10 allowDowngrades 확정 적용 — v0.2.4 알고리즘이 v2 store를 spread merge로 무파괴 보존함을 시뮬레이션 케이스 2개로 단언. 롤백 운용 절차 attempt-1.md §4. 실 배포는 사용자 승인 대상. selftest 70/70, validator PASS.
- phase-06-task-03 → blocked(OQ-05): validator 실측 — 멀티모니터 "자동" 실커서 추종 양방향 PASS, 외부 리로드 실 파일 수정 반영 1.5~1.8s PASS. 실기 IME 손 타이핑만 사용자 확인 필요(조합 경로 정상 관찰, 포커스 직후 첫 자모 소실 징후는 아티팩트 가능성 — 실기 확인 대상으로 잔류).
- **Loop 1차 라운드 종료**: pending 12 중 11 completed(전부 validator PASS), 06-03 + 기존 6 blocked = 7개 사용자 결정 대기. selftest 26→70, cargo 0→32. 잔재 정리 확인(프로세스·포트·store 복원).
## Loop 2차 — phase-02-task-02 PASS (검색 UI)
- 구현 c3fc344f → 커밋 10fba92: search 창 사전생성+show_search/hide_search, Ctrl+Shift+F 전역키(common.searchKey)+btnSearch 진입, search.html/search-window.js, IME 조합 유예, selftest+3
- 게이트: build/fmt/clippy/cargo test 33/33 + e2e selftest 73/73 + CDP 12/12 (qa-20261118-212755)
- 독립검증 7fb7d893: 수용 기준 5/5 실관찰 PASS (진입점 실 OS키+버튼 클릭 포함), RESULT: PASS

## Loop 2차 — phase-03-task-02 PASS (리마인더 UI+앱 내 토스트)
- 구현 34961b94: src/reminders.js+src/toast.js 신규, toast 창 setup 생성+place_toast, capabilities/toast.json(ACL), 패널 remPop+btnReminder, 설정 리마인더 탭, handles 토스트 큐(live3/pending8/4초), selftest+2
- 게이트: build/fmt/clippy/cargo test 33/33 + e2e selftest 75/75 + CDP 17/17 (qa-20261118-220349)
- 독립검증 00907b2f: 수용 기준 6/6 실관찰 PASS — 패널 닫힘 상태 토스트 도달·토스트 클릭 show_panel·지남 #c0392b 표시·IME 회귀 3/3. RESULT: PASS

## Loop 2차 — phase-04-task-03 PASS (OQ-03 충돌본 보관)
- 구현 2e0dee4a → 커밋 8a4b4a9: Rust save_conflict_copy(원자적·순번·뮤텍스), store.js lastSavedJson/isStoreConflict/applyChain, handles 충돌 토스트, selftest+5
- 게이트: build/fmt/clippy/cargo test 37/37 + e2e selftest 80/80 + CDP conflict 9/9 + external-reload 회귀 5/5
- 독립검증 ed845806: 수용 기준 4/4 PASS — 충돌본 파일 디스크 직독으로 로컬본 보존 확인, 비충돌/자기에코/다른창저장 경계 검증. RESULT: PASS

## Loop 2차 — phase-04-task-04 PASS (저장 폴더 설정 UI)
- 구현 8393a520 → 커밋 aa5c6a1: 설정 저장 탭(경로 표시+폴더 열기+변경/기본값 dialog→set_data_dir+오류행+감시 중 배지+충돌 안내), selftest+1
- 게이트: build/fmt/clippy/cargo test 37/37 + e2e selftest 81/81 + CDP 9/9
- 독립검증 24ad2f1f: 수용 기준 5/5 PASS — 실효 경로 get_data_dir 일치·오류 #c0392b+경로 유지·reset 동작·81/81 회귀. RESULT: PASS

## Loop 2차 — phase-05-task-03 PASS (다크모드)
- 구현 b63b576c(전 워커 중단분 인수) → 커밋 ac6ae00: src/darkmode.js+darkmode.css(--chrome-* 토큰, html.dark 토글), 5창 적용, 공통 탭 #darkModeSel, system=matchMedia 추적, selftest+2
- 게이트: build/fmt/clippy/cargo test 37/37 + e2e selftest 83/83 + CDP 10/10
- 독립검증 aab2015c: 수용 기준 5/5 PASS — 5창 토글·D-4 팔레트·인덱스 색 무손상·OS 추적·재시작 유지·라이트 회귀 무. RESULT: PASS

## Loop 2차 — phase-05-task-04 PASS (템플릿/스니펫/숨김 UI)
- 구현 170e3f97 → 커밋 e8e27e6: pick 창(setup 생성)+place_pick, src/pick.js, addIndex(templateId), snipPop+insertSnippet(IME 차단), 설정 눈 토글+템플릿 탭, selftest+3
- 게이트: build/fmt/clippy/cargo test 37/37 + e2e selftest 86/86 + CDP 11/11
- 독립검증 ee037926: 수용 기준 5/5 PASS — 템플릿 생성·캐럿 삽입+치환·숨김 필터+최소1개 불변·Esc/블러·86/86 회귀. RESULT: PASS

## Loop 2차 라운드 종료 — UI 6/6 전부 완료, 잔여 06-03(실기 IME)만 사용자 확인 대기


## BUG-11 — 긴 메모 입력 시 캐럿이 툴바 아래로 가려져 안 보임 (2026-11-20, 사용자 신고)

- 재현·관찰: 카드를 넘는 내용 입력 시 Chromium이 캐럿을 스크롤포트 **맨 아래 가장자리**로 최소 스크롤. `.editor-wrap` 뷰포트 하단 ~50px는 `position:absolute; bottom:12px`의 플로팅 `.toolbar`가 덮음 → 캐럿이 툴바 아래서 계속 입력돼 "포커스가 안 따라가며 안 보이게" 느껴짐. CDP 실측: caret rel=513/514 (뷰포트 맨끝, 툴바 존 [462,502]과 겹침)
- 기대: 입력하는 위치가 항상 보여야 함(툴바 위 여백 확보)
- 원인: Chromium 최소 스크롤이 툴바 오버레이를 고려 못함 — 스크롤 여백 정의 부재
- 수정: `.editor-wrap`에 `scroll-padding-bottom: 72px` 추가(툴바 존 ~50px + 여유). scrollIntoView·캐럿 추적이 공통으로 존중하는 표준 속성이라 JS 추가 없이 해결
- 회귀 검사: selftest `scroll-padding-caret`(값 유지)+`scroll-follow-margin`(scrollIntoView 여백 존중) 추가
- 부수 발견·수정: selftest `reminder-missed` 연속 FAIL — 제품 경로는 정상(수동 주입 시 missed emit 확인). 원인은 **테스트 아티팩트**: 발화 래치 markReminderFired→외부 저장→패널 state 교체로 captured `idx`가 stale → 테스트의 reminders 쓰기가 디스크에 안 닿음. liveIdx()로 라이브 인덱스 재획득하도록 수정
- 검증: CDP 실측 캐럿 rel 513→449(툴바 위 확보, 일반 insertText·IME 조합 모두), selftest 88/88
- 사용자 store 오염 정리: CDP 재현 중 테스트 텍스트가 실제 메모에 저장된 것 복원(마지막 실관찰 내용 "할일"/"㌐테스"), conflict·bak 잔재 삭제

