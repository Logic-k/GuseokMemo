# phase-06-task-01 — attempt 1

## 목표
tauri 2.12의 `noRedirectionBitmap`(WS_EX_NOREDIRECTIONBITMAP)을 투명 창(handles·panel)에
적용해 흰 플래시·DWM 경합을 줄이는지 실기 검증 — TD-09 잠정 → 확정/기각.

## 결론: **TD-09 기각 — 롤백 완료**
`src-tauri/src/main.rs`는 HEAD와 동일(설정 두 줄 넣었다가 되돌림).
적용 위치는 `setup()`의 handles·panel `WebviewWindowBuilder`에 `.no_redirection_bitmap(true)`
(conf는 `windows:[]`라 빌더가 유일 경로, settings는 불투명이라 비대상).
API 존재 확인: tauri 2.12.5 `webview_window.rs:658`, tao 0.37.2 `window_state.rs:262`.

## 환경 정정 (중요)
조정자 안내 "Win11+WebView2 157"과 달리 실측은 **Windows 10 Education build 19045**
(+WebView2 157.0.4341.60) — #15947이 말하는 바로 그 대상 OS. 단 이 앱은
`set_ignore_cursor_events`를 전혀 쓰지 않고 두 투명 창 모두 `minimizable(false)`라
#15947의 원래 트리거 경로는 존재하지 않는다.

## 관찰 방법
`plan_setup/cdp-nrb-check.cjs`(gitignore 로컬 자산) — base/nrb 두 exe를 동일 시나리오로:
- `__handles` 훅으로 패널 open/close ×11, addIndex+step 재배치, snapToEdge,
  **실제 마우스 드래그**(SendInput LEFTDOWN→Cursor.Position 단계이동→LEFTUP
  → startDragging+onMoved+snapToEdge 실경로).
- 각 전이 전후 PowerShell `CopyFromScreen` 영역 캡처 → 160×120 축소 히스토그램
  (white≥245 / black≤10 비율). 패널 영역은 layout.js `panelRect` 복제로 정확 계산.
- store.json 스냅샷→복원, 프로세스·포트 잔재 정리 포함.
- 주의: 캡처 간격 ~100-250ms(PS 기동+히스토그램 비용) — 수ms짜리 단프레임은
  사이로 빠질 수 있는 해상도 한계.

## 관찰 결과 (동일 시나리오 대조)
| run | binary | 이상 프레임 |
|---|---|---|
| base-1 | HEAD | 0 / ~130 caps |
| base-2 | HEAD | 0 / ~130 caps |
| nrb-1 | +noRedirectionBitmap | `cycle1-close` 버스트 중 **black=1.00** 1프레임 |
| nrb-2 | +noRedirectionBitmap | `final-open` 정착 캡처 **black=0.9817** |
| nrb-3 | +noRedirectionBitmap | 0 / ~130 caps |

- **흰 플래시: 양쪽 모두 0건** — 베이스라인에서도 비관측(해결할 문제가 원래 없음).
- **검은 영역: nrb에서만 2/3회 실행 재현** — panel rect에 정확히 한정된 순수 검정
  (strip은 동시 정상 렌더). show/hide 전이 중 발생, 자연 회복(지속 ≤~1s 미측정 상한).
- 메커니즘 정합: tao는 `transparent && !nrb`이면 `DwmEnableBlurBehindWindow`+빈 region
  (알파 합성, 비어 있으면 투과) 경로, `nrb`이면 그 경로를 스킵하고
  `WS_EX_NOREDIRECTIONBITMAP`만 부여 — 미제시(present 안 된) 서페이스가 전이 중
  **불투명 검정**으로 합성된다. 관찰과 정확히 일치.
- **기능 회귀 없음**: selftest 68/68(nrb 상태에서 E2E PASS), `.handle.active` DOM 정상,
  snapToEdge·실제 드래그 right↔left 양방향 want=got 전부 성공.
- `panel-open-dom`의 activeHandle이 base-1에서만 false 1건 — 타이밍 노이즈로 판단
  (이후 전 run true, DOM 단언 아님).

## 판정 근거
1. 이득 비관측: 베이스라인 ~260 caps에서 흰 프레임 0 — 제거할 플래시가 없었다.
2. 실측 회귀: 검은 프레임이 플래그 적용 빌드에서만 재현(2/3 runs, 전이 중 한정).
3. 트리거 경로 부재(#15947의 ignore_cursor_events/minimize 미사용)라 원래 위험도 낮음.
4. 태스크 규칙 "회귀 있으면 롤백·기각" + 합의 밖 결정은 보수적 선택 → **기각**.

## 검증 (직접 실행)
- 적용 상태: `npm run build` PASS / `cargo fmt --check` PASS /
  `cargo clippy -D warnings` PASS / `cargo test` **32/32** / `cargo build` PASS /
  `run-e2e.ps1` **E2E PASS selftest 68/68** (증거 `.devil/loop/qa-logs/guseok-qa-20261118-195542.log`)
- 롤백 후(최종 상태): fmt·clippy·test **32/32**·build 재확인 PASS,
  `run-e2e.ps1` **E2E PASS selftest 68/68** (증거 `.devil/loop/qa-logs/guseok-qa-20261118-201319.log`)
- 실기 관찰: 위 표 — nrb 3회/base 2회 실행, 계측 로그는 attempt 본문이 정본
  (PNG 미보존: 실제 화면 캡처는 프라이버시상 수치만 기록).

## 남은 문제·결정 근거
- 간헐 이벤트라 표본이 작다(2/~400 nrb caps) — 그러나 이득 0×회귀>0 구도에서
  통계적 확실성이 판정을 바꾸지 않는다. Win11 등 다른 환경의 효과는 미검증으로 남김.
- 관찰 스크립트 `plan_setup/cdp-nrb-check.cjs`는 재검증 가능한 로컬 자산으로 보존
  (gitignore). 단일 인스턴스 포워딩 감지·store 복원·프로세스 정리 내장.
- 시행 중 발견한 함정: 수동 기동 잔재(exe 파일명이 달라 `guseok-memo` 이름 필터를
  빠져나감)가 single-instance 포워딩으로 첫 nrb 관측을 무효화 — 스크립트에
  "spawn한 pid 생존" 가드를 추가해 재발 방지. 해당 run은 폐기하고 재측정했다.
- 커밋 대상: `.devil/loop/{phase-06-task-01,qa-logs}` 뿐 — 소스 변경은 롤백으로 무잔재.
  조정자 파일(plan_setup/*, docs/TRD.md의 TD-09 표기)은 건드리지 않는다.
