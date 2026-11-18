# phase-01-task-02 — attempt 1 (구현)

## 변경 요약

- `src-tauri/src/main.rs`만 변경.
  - `RENAME_RETRY_DELAYS_MS: [u64; 3] = [50, 100, 150]` — 첫 시도는 즉시, 이후 실패마다
    50/100/150ms 백오프. 최대 시도 4회, 총 대기 상한 300ms (< 1초, 보수적 명세 충족).
  - `rename_with_retry(delays_ms, rename, sleep) -> Result<u32, E>` — 재시도 루프를
    rename/sleep 주입 가능한 순수 함수로 분리. 반환: 성공까지 걸린 시도 횟수
    (1 = 첫 시도 성공) 또는 마지막 오류 Err.
  - `save_store`: `fs::rename(&tmp,&p)` 직행 → `rename_with_retry` 호출로 교체
    (`fs::rename` + `std::thread::sleep` 주입).
    - 재시도 경유 성공(attempts>1) 시 `save-store :: rename occupied, succeeded on attempt N`
      을 qa 로그(`%TEMP%\guseok-qa.log`)에 기록 — "점유 해제 후 성공" 관찰 지점.
    - 모든 시도 실패 시 `save-store :: rename still occupied after 4 attempts: <err>` 기록
      후에만 Err 반환. `guseok://store` emit은 성공 경로에서만(기존 의미 보존).
    - 로그 라인은 `FAIL ` 접두를 쓰지 않음 — run-e2e.ps1의 FAIL 카운트와 무관.
    - store.bak.json 복사 → tmp 쓰기 → rename → emit 순서 그대로.
  - Windows 디렉터리 fsync 불가 한계를 save_store 주석으로 기록 — .bak 사본이 완충 역할.
  - `#[cfg(test)] mod tests` 신설 — 단위 테스트 6개 (기준선 0건 → 6건).

## 재시도 파라미터

- 백오프 `[50, 100, 150]`ms, 최대 시도 4회(초기 1 + 재시도 3), 총 대기 상한 300ms.
- 근거: 260ms JS 디바운스 저장 경로를 오래 붙잡지 않으면서, 백신·인덱서·동기 클라이언트의
  보통 수십~수백 ms짜리 점유를 흡수. 명세(50~150ms × 3~5회, 총 1초 미만) 내 보수적 선택.

## 테스트 (cargo test, 6건)

- `rename_retry_succeeds_on_first_attempt` — 첫 성공 시 재시도·sleep 없음(attempts=1)
- `rename_retry_succeeds_after_occupation_clears` — 2회 실패 후 성공, sleep 순서 [50,100]
- `rename_retry_exhausted_returns_last_error` — 4회 모두 실패 → 마지막 오류 Err,
  sleep [50,100,150], 호출 4회
- `rename_retry_delays_fit_budget` — 간격 50~150ms·단조 비감소·총합 <1s 명세 단언
- `rename_retry_real_fs_rename` — 실제 파일 rename 경로 (잠금 없음, attempts=1)
- `rename_retry_recovers_when_occupation_released` (windows) —
  `OpenOptionsExt::share_mode(0)`으로 dst를 공유 없이 열어 실제 점유 재현, 60ms 뒤
  스레드가 drop 해 해제 → 재시도로 rename 성공(attempts≥2) + 내용 교체 단언.
  수용 기준 "점유 해제 후 저장 성공"을 코드 수준에서 직접 검증.
- 테스트 잔재: 각 테스트가 `%TEMP%\guseok-memo-*-test-<pid>`를 remove_dir_all로 정리.

## 실행한 검증과 결과

- `npm run build` — PASS
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` — PASS (fmt 적용 후)
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` — PASS 0 경고
- `cargo test --manifest-path src-tauri/Cargo.toml` — **6/6 PASS**
- `cargo build --manifest-path src-tauri/Cargo.toml` — PASS (debug exe)
- `powershell -File harness_setup/scripts/run-e2e.ps1` — **SUMMARY 29/29, FAIL 0, E2E: PASS**
  - 증거: `.devil/loop/qa-logs/guseok-qa-20261118-172840.log`
    (`PASS store-write` + `PASS store-restore :: 2119 bytes` 포함 — 수용 기준 4)
  - 주의: 1·2차 시도는 조정자 측 독립 검증 e2e와 충돌 — 앱 조기 종료
    (1차 code 1, 2차 code 0 = single-instance 전달 후 정상 종료). 환경 flake이며
    코드 결함 아님 — 직렬 재시도로 통과. 외부 실행이 만든 로그
    `guseok-qa-20261118-172213.log`(같은 바이너리로 29/29)는 본 커밋에 포함하지 않음.
  - 3차 실행은 부팅 toggle emit 유실(알려진 흔들림, e2e.md 기재)로 45s 침묵 →
    스크립트 내장 CDP nudge가 패널을 열어 자동 복구 후 29/29.
- 잔재 확인: guseok-memo.exe 0, :5183 LISTEN 0, :9223 LISTEN 0,
  사용자 store.json 스냅샷 복원(크기 1346B, selftest 문자열 없음), Run 키 미변경.

## 남은 문제·위험

- 실제 백신/인덱서/동기 클라이언트 점유 하의 동작은 수동 확인 항목 — 단위 테스트의
  share_mode(0) 점유는 같은 Win32 공유 위반 경로를 재현한다. 운영 중 관찰은
  qa 로그의 `save-store ::` 라인으로 가능.
- 신규 selftest 케이스는 추가하지 않음 — 점유 주입이 JS에서 불가해 Rust 단위 테스트가
  적절한 단언 위치(unit.md "순수 함수로 분리해 테스트" 원칙). e2e는 기존 29/29 회귀 유지.
- 디렉터리 fsync 불가는 Windows 한계로 그대로 잔존(주석 기록) — rename 성공 후에도
  극단적 전원 손실 시 .bak 경로가 복구 수단.
