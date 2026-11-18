---
gate: e2e
command: powershell -File harness_setup/scripts/run-e2e.ps1
applies: verification 키에 e2e가 있는 태스크 + selftest 회귀 전체
---

# 게이트 — e2e (실제 성공·실패 흐름)

## 대상·근거

실행 중인 앱의 end-to-end 동작 — `src/selftest.js`의 in-app 테스트(현재 26개)와
`plan_setup/cdp-*.cjs`의 CDP 관찰. NFR-02(IME)·NFR-05(게이트)·각 R-요구 회귀의
주 수단. 기준선: **selftest 26/26 PASS** (LOG.md 2026-11-17).

## 명령 (권장 — 자동)

```powershell
powershell -File harness_setup/scripts/run-e2e.ps1
```

- 태스크가 지정한 CDP 검사가 있으면: `-Cdp "cdp-ime-check.cjs,cdp-xxx.cjs"`
- 자동시작 회귀가 필요한 태스크만: `-WithAutostartQa` (`--qa-autostart` 추가)

## 수동 절차 (스크립트 없이 재현할 때 — 같은 판정)

```powershell
powershell -File harness_setup/scripts/check-env.ps1   # 전제 점검
npm run dev                                             # 별도 터미널 — :5183 유지
Add-Content $env:TEMP\guseok-qa.log "==== e2e-manual ===="   # 실행 구간 마커(로그는 append-only)
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"
src-tauri\target\debug\guseok-memo.exe --selftest       # 트레이 상주로 안 끝남
# 마커 뒤에 SUMMARY가 찍힐 때까지 대기(통상 ~20초, 상한 120초) — 이전 실행의 SUMMARY 재사용 금지
Get-Content $env:TEMP\guseok-qa.log -Tail 40
node plan_setup\cdp-ping.cjs        # CDP 필요 시 — 같은 인스턴스에 접속
```

## 통과 조건

- `SUMMARY n/n passed`에서 **n == total**이고 `FAIL` 라인이 0 — 기준선 26/26 +
  신규 케이스. 총수 감소는 회귀로 본다.
- 실행한 `cdp-*.cjs` 전부 종료 코드 0.
- 로그는 `%TEMP%` 원본을 `.devil/loop/qa-logs/`에 복사해 보존 (스크립트 자동).
- **종료 후 잔재 0**: 띄운 exe PID·vite 프로세스 종료 확인, Run 키 원복
  (`--qa-autostart`는 자체 원복), `%TEMP%` 임시 파일 정리 — 전역 규칙.

## 전제·활성 범위·주의

- **실행 중 `guseok-memo.exe` 0개** — single-instance가 인자를 기존 인스턴스로 넘겨
  selftest가 돌지 않고 toggle만 발생한다 (LOG BUG 회귀). check-env.ps1이 차단.
- debug exe는 `devUrl(:5183)` 로드 — vite 200 응답 확인 후 기동 (포트 LISTEN만으로
  판정하지 않는다).
- selftest는 실사용자 `store.json`을 잠시 쓰고 복원한다 — run-e2e.ps1이 사전
  스냅샷·사후 복원을 추가 수행 (PRD "스냅샷→복원" 합의, 파괴 금지).
- CDP 스크립트는 Node ≥22(전역 WebSocket) + `localhost:9223/json` — gitignore된
  로컬 자산이므로 태스크가 요구하는 스크립트가 없으면 작성하고 `plan_setup/`에 둔다.
- 신규 기능 태스크는 수용 기준을 단언하는 selftest 케이스 또는 CDP 스크립트를
  동반하지 않으면 이 게이트의 e2e 증거로 인정하지 않는다 (NFR-05).
- 흔들림: `peek-autoclose` 계열은 지연 폴링 민감 — 1회 실패 시 환경(포커스·타이밍)
  확인 후 재실행하고, 재발하면 실패로 분류해 구현에 돌린다 (검사 약화 금지).
- selftest는 결과를 **전부 수집한 뒤 종료 시점에 일괄 기록**한다 — 실행 중 로그가
  조용한 것은 정상.
- **toggle emit 유실(2026-11-18 실측 확인)**: setup 1.4초 뒤 `guseok://shortcut`
  toggle을 emit하는데, handles가 listen을 등록하기 전이면 소실돼 패널이 열리지
  않고 selftest가 영구 침묵한다(부팅이 느릴 때 재현). `run-e2e.ps1`은 45초 무출력
  시 `scripts/cdp-nudge.cjs`로 패널 가시성을 확인해 닫혀 있으면 토글을 재발사해
  복구한다. 근본 수정(listen 준비 후 emit·재시도)은 제품 측 개선 — Loop 태스크 후보.
- `--selftest` 없는 재실행/수동 기동과 달리 dev 환경(`import.meta.env.DEV`)에서는
  자동 업데이트 확인이 꺼져 있다 — debug exe + vite 조합에서 updater 간섭은 없다.
