---
topic: 구석메모 검증 하네스 — 실행 전제·검증 목록·관찰 수단·한계
updated: 2026-11-18
status: 준비 완료 — Loop 시작 전 사용 가능
inputs: docs/PRD.md(NFR-05·자율운영 합의), docs/TRD.md(TD-12/13), plan_setup/PLAN.md(게이트 맵)
---

# HARNESS — 구석메모

Tauri 2 + WebView2 Windows 데스크톱 앱의 검증 하네스. 게이트 정의는
`harness_setup/quality_gates/`의 네 파일이 정본이고, 태스크의 `verification:` 키가
여기 이름으로 연결된다.

## 1. 실행 전제

| 항목 | 요구 | 확인 |
|---|---|---|
| OS | Windows 10/11 로컬 데스크톱 (인터랙티브 세션 — 트레이·창 관찰 필요) | `harness_setup/scripts/check-env.ps1` |
| Node.js | ≥20 (dev/build). `plan_setup/cdp-*.cjs`는 전역 `WebSocket`이 필요해 **≥22** | `node --version` |
| Rust | stable (`x86_64-pc-windows-msvc`), 실제 요구 ≥1.90 (TD-11) | `rustc --version` |
| WebView2 | Evergreen Runtime (Win11 기본 포함) | 레지스트리 `{F3017226-…}` 클라이언트 키 |
| 빌드 도구 | Visual Studio Build Tools (C++ 워크로드) | cargo build 성공으로 간접 확인 |
| 프로젝트 | `npm install` 완료, `dist/` 존재 (`npm run build` — `tauri::generate_context!` 컴파일 전제) | check-env.ps1 |
| 실행 중 인스턴스 | `guseok-memo.exe` 0개 — **single-instance가 인자를 기존 인스턴스로 전달**해 selftest가 안 돌고 toggle만 발생 (LOG BUG 회귀 이력) | check-env.ps1 |

환경 점검: `powershell -File harness_setup/scripts/check-env.ps1` — 실패 항목마다
FAIL을 출력하고 종료 코드 1.

## 2. 로컬 준비·실행·상태·종료

### 정상 경로 (수동 — 게이트 스크립트 없이 재현할 때)

```powershell
npm install            # 최초 1회
npm run build          # dist/ 생성 — 모든 Rust 게이트의 선행
cargo build --manifest-path src-tauri/Cargo.toml   # debug exe 생성
npm run dev            # vite :5183 — 별도 터미널, 종료까지 유지
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"
src-tauri\target\debug\guseok-memo.exe --selftest  # 트레이 상주, 종료하지 않음
```

- debug exe는 `devUrl(http://localhost:5183)`을 로드 → **vite 필수 선행**
  (vite strictPort — 5183 점유 시 기동 실패).
- `--selftest`는 panel 창을 `index.html?panel=1&selftest=1`로 열어
  `src/selftest.js`의 `runSelfTest`를 실행한다.
- 결과는 커맨드 `qa_log`가 `%TEMP%\guseok-qa.log`에 `[QA]` 라인으로 append —
  마지막 `SUMMARY n/n passed` 라인이 판정값.

### 자동 경로 (권장 — 한 명령)

```powershell
powershell -File harness_setup/scripts/run-e2e.ps1                     # selftest까지
powershell -File harness_setup/scripts/run-e2e.ps1 -Cdp "cdp-ime-check.cjs"   # + CDP
powershell -File harness_setup/scripts/run-e2e.ps1 -WithAutostartQa    # autostart QA 포함
```

스크립트가 vite 기동(또는 재사용)·실행 중 인스턴스 차단·SUMMARY 폴링·로그 증거 복사·
자기가 띄운 프로세스만 정리를 처리한다.

### 실제 접속 주소

| 용도 | 주소 |
|---|---|
| vite dev server (debug exe가 로드) | http://localhost:5183 |
| WebView2 CDP 목록 | http://localhost:9223/json |
| QA 로그 | `%TEMP%\guseok-qa.log` |
| 데이터 | `%APPDATA%\com.guseok.memo\store.json` (+ `store.bak.json`) |

### 종료·정리 (전역 규칙 — 잔재 금지)

- exe: 자기가 띄운 PID만 종료 (`run-e2e.ps1`이 자동 처리). 수동 시 `quit_app` IPC
  (CDP 경유) 또는 PID 지정 종료 — **이미지명 taskkill 금지**(설치된 정품 exe와 이름 같음).
- vite: 시작한 터미널/프로세스만 종료. 스크립트 기동분은 스크립트가 정리.
- `--qa-autostart`: HKCU Run 기존 값을 읽고 테스트 후 원복하는 `autostart_qa()` 경로만 사용.
- selftest는 실행 중 실사용자 `store.json`을 쓰고 원상 복구한다 — run-e2e.ps1이
  사전 스냅샷·종료 시 복원을 추가로 수행 (PRD "스냅샷→복원" 합의).
- 임시 파일: `%TEMP%\guseok-qa.log`는 실행 증거로 `.devil/loop/qa-logs/`에 복사 후
  남기지 않아도 됨(복사본이 정본).

## 3. 검증 목록 ↔ 수용 기준

| 게이트 | 정의 | 검사하는 것 | 해당 요구/기준 | 실행 시점 |
|---|---|---|---|---|
| lint | `quality_gates/lint.md` | fmt 위반·clippy 경고 0 (dist 선행) | NFR-05, TD-13 | `verification`에 lint 있는 태스크 전부 |
| unit | `quality_gates/unit.md` | `cargo test` + 신규 순수 로직의 단언 존재 | NFR-05, 태스크별 기준 | verification에 unit 있는 태스크 |
| e2e | `quality_gates/e2e.md` | selftest SUMMARY + cdp-*.cjs 실행·관찰 | NFR-02/05, R-계열 회귀, LOG의 26/26 기준선 | verification에 e2e 있는 태스크 |
| task_validation | `quality_gates/task_validation.md` | 비상속 별도 세션의 수용 기준별 관찰 판정 | 각 태스크 `acceptance_criteria` | 위 게이트 통과 후 |

- 판정 순서는 **lint → unit → e2e → task_validation** 고정 — 앞 실패 복구 전 뒤를 열지 않는다.
- 같은 코드·설정·데이터 조건임을 근거로 결과 재사용·태스크 묶음 검사 가능 — 근거를 LOG에 기록.
- 태스크 수용 기준 ↔ 검사의 대응은 태스크 파일 `acceptance_criteria`/`verification`이 정본.
- 준비 미활성·미실행·0건·skip은 PASS가 아니다.

## 4. 관찰 수단

| 수단 | 용도 |
|---|---|
| `%TEMP%\guseok-qa.log` | selftest PASS/FAIL 라인·SUMMARY — 판정 정본 |
| CDP (`localhost:9223/json`, WebSocket) | 창별 DOM·이벤트·`Runtime.evaluate` 관찰 — `plan_setup/cdp-*.cjs` (Node ≥22, **.gitignore된 로컬 자산**) |
| `Invoke-WebRequest :5183` | vite readiness (포트 LISTEN이 아니라 실제 200 응답) |
| Win32 관찰 | 모니터/작업 영역·트레이 — 수동 확인 또는 CDP `monitors` 커맨드 |
| 증거 경로 | `.devil/loop/qa-logs/*.log` — %TEMP% 원본의 지속 보존본 |

## 5. 테스트 데이터와 의존

- **실사용자 store 보호**: selftest는 `%APPDATA%\com.guseok.memo\store.json`을 실제로
  쓰고 복원한다. 사전 스냅샷·사후 복원(run-e2e.ps1 내장) 외에 데이터를 초기화하지 않는다.
- **fixture**: v1 스냅샷 JSON은 phase-01-task-01에서 추가 예정 — 추가 전까지 migrate
  단언은 selftest/코드 기준으로 판정.
- **외부 서비스 없음**: 네트워크 의존은 기동 5초 뒤 GitHub Releases 업데이트 확인뿐
  (실패해도 게이트 무관 — 로컬-퍼스트, NFR-03).

## 6. 미검증 범위·한계

- **selftest 트리거 경쟁(실측)**: setup 1.4초 고정 emit이 handles listen 준비 전이면
  소실 → selftest 영구 침묵. run-e2e.ps1이 45초 무출력 시 `scripts/cdp-nudge.cjs`로
  복구(2026-11-18 검증). 근본 수정은 제품 측 — Loop 개선 후보로 LOG에 기록 권장.
- **실키보드 IME 타이핑**(OQ-05)과 **멀티모니터 "자동" 실기**, 외부 동기 클라이언트 실기는
  자동 하네스가 못 덮는다 — `phase-06-task-03` 수동 검증 태스크로 연결.
- CDP `Input.imeSetComposition`은 실키보드 경로의 완전한 대체가 아니다(합성 이벤트).
- selftest는 실사용자 store를 잠시 쓰는 구조 — 동시에 다른 인스턴스가 store를 쓰면
  오염 가능. 실행 중 인스턴스 0 전제로 방어.
- `plan_setup/cdp-*.cjs`는 gitignore — 새 세션/머신에서 이 파일들이 없으면 e2e CDP
  단계는 해당 스크립트 부재로 skip이 아니라 **태스크가 요구하는 만큼 재작성**한다.
- UI 구현 태스크 6개는 DESIGN 미승인으로 `blocked` — 하네스 통과가 차단 해제를 대체하지
  않는다 (`docs/DESIGN.md` 승인 절, PLAN.md).
- `cargo test`는 현재 테스트 0건 — Rust 순수 로직을 추가하는 태스크부터 `#[cfg(test)]`
  동반이 없으면 unit 게이트 통과로 인정하지 않는다(quality_gates/unit.md 참조).
