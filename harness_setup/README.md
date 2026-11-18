# harness_setup — 구석메모 검증 하네스

정본 문서는 `HARNESS.md`. 이 파일은 구성과 로컬 실행 요약이다.

## 구성

| 경로 | 역할 |
|---|---|
| `HARNESS.md` | 실행 전제·검증 목록·관찰 수단·미검증 한계 (정본) |
| `quality_gates/lint.md` | fmt + clippy 경고 0 (`npm run build` 선행) |
| `quality_gates/unit.md` | `cargo test` + 신규 순수 로직 단언 |
| `quality_gates/e2e.md` | selftest SUMMARY + `plan_setup/cdp-*.cjs` |
| `quality_gates/task_validation.md` | 비상속 별도 세션 독립 판정 규약 |
| `scripts/check-env.ps1` | 환경 전제 점검 (Node·Rust·WebView2·인스턴스·포트) |
| `scripts/run-e2e.ps1` | e2e 자동 실행기 (vite→selftest→CDP→정리) |
| `scripts/cdp-nudge.cjs` | selftest 트리거 유실 시 패널 토글 복구 (45초 가드) |

게이트 판정 순서는 **lint → unit → e2e → task_validation** 고정이다
(`plan_setup/PLAN.md` 게이트 맵과 동일).

## 로컬 실행 요약

```powershell
npm run build                                       # dist — Rust 게이트 전제
cargo build --manifest-path src-tauri/Cargo.toml    # debug exe
npm run dev                                         # vite http://localhost:5183 (유지)
src-tauri\target\debug\guseok-memo.exe --selftest   # → %TEMP%\guseok-qa.log
```

- debug exe는 devUrl(:5183)을 로드 — **vite 먼저**.
- 결과 판정: `%TEMP%\guseok-qa.log`의 `SUMMARY n/n passed` 라인 (기준선: 기존 26/26).
- 한 명령으로: `powershell -File harness_setup/scripts/run-e2e.ps1`

## CDP 검사 (WebView2 원격 디버깅)

exe를 환경변수와 함께 띄우면 WebView2가 CDP를 연다:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"
src-tauri\target\debug\guseok-memo.exe --selftest
node plan_setup\cdp-ping.cjs          # http://localhost:9223/json 접속 확인
node plan_setup\cdp-ime-check.cjs     # 필요한 검사만 선택 실행
```

- 포트: **9223** (기존 cdp-*.cjs가 하드코드). `http://localhost:9223/json`에서 창별
  타겟(handles/panel/settings)을 골라 WebSocket으로 `Runtime.evaluate`를 보낸다.
- Node ≥22 필요 (전역 `WebSocket`). 스크립트는 `.gitignore`된 로컬 자산.

## 주의

- `guseok-memo.exe` 실행 중 인스턴스 0 전제 — single-instance가 두 번째 실행의 인자를
  기존 인스턴스로 전달해 selftest가 돌지 않는다.
- selftest는 실사용자 `store.json`을 잠시 쓰고 복원 — `run-e2e.ps1`이 사전 스냅샷·
  사후 복원을 추가로 수행한다.
- 종료: 자기가 띄운 exe PID·vite만 정리 (이미지명 taskkill 금지 — 설치본과 동명).
  `--qa-autostart`는 HKCU Run을 자체 원복한다.
- UI 태스크는 `docs/DESIGN.md` 승인 전 `blocked` — 하네스 통과가 해제를 대체하지 않는다.
