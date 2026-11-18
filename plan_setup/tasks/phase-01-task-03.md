---
id: phase-01-task-03
status: completed
depends_on: []
acceptance_criteria:
  - src-tauri/Cargo.toml의 rust-version이 실제 요구(Rust ≥1.90)와 일치한다
  - tauri 코어·플러그인 버전 조합이 npx tauri info 등으로 확인·기록된다
  - 게이트 명령 순서(npm build → fmt → clippy → test → selftest → CDP)가 문서에 확정돼 있다
  - 갱신 후 cargo build/clippy가 통과한다
verification: [lint, unit]
phase: "01"
---

# phase-01-task-03 — 툴체인 정합 + 게이트 명령 확정

## 목표
`rust-version = "1.77"` 표기를 실제 요구와 일치시키고(TD-11), 품질 게이트 명령을
확정한다(TD-13, NFR-05).

## 범위
- `src-tauri/Cargo.toml`: `rust-version = "1.90"`(tauri·updater MSRV 기준, q02 §3)
- 사용 중인 tauri/플러그인 실제 버전 세트 확인·기록(`cargo tree`/`tauri info`)
- 게이트 명령을 PLAN.md/개발 문서에 확정 — frontendDist 선행 순서 포함

## 관련
- TD-11, TD-13 — 근거는 TRD §TD-11/13(q04 §D-1 generate_context! 전제).
- 이후 모든 태스크의 게이트 기준.

## 참고
- 로컬 툴체인이 1.90 미만이면 rustup 업데이트 필요 — 환경 변경은 합의 범위 안(빌드 환경).
