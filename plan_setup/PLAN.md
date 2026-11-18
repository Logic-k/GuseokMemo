---
topic: 구석메모 다음 개발 사이클 계획
updated: 2026-11-18
status: draft — DESIGN 미승인, OQ-01/02/03 미해소
inputs: docs/PRD.md, docs/TRD.md, docs/ARCHITECTURE/overview.md
---

# PLAN — 구석메모 다음 개발 사이클

## 게이트 맵 (verification 키 → 실제 명령)

| verification | 명령 | 통과 |
|---|---|---|
| lint | `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` + `cargo clippy --all-targets -- -D warnings` (선행: `npm run build`로 dist 생성) | 경고 0 |
| unit | `cargo test` (Rust 순수 로직) + migrate fixture 단언 | 전부 통과 |
| e2e | `npm run dev`(vite :5183) 후 debug exe `--selftest` → `%TEMP%\guseok-qa.log` + `plan_setup/cdp-*.cjs` | 기존 26/26 + 신규 케이스 PASS |
| task_validation | 비상속 별도 세션 — 요구·수용기준·계약·실행 접속을 인계받아 기준별 관찰 증거 반환 (구현 세션 판정으로 대체 금지) | 기준별 증거 |

- `tauri::generate_context!`가 frontendDist를 컴파일 타임 평가하므로 **모든 Rust 게이트 전에
  `npm run build` 선행**.
- debug exe는 devUrl(localhost:5183) 로드 → selftest 전 vite 필수.
- 테스트 후 자동시작·트레이·프로세스·임시 파일 잔재 정리(전역 규칙).

## DESIGN 승인 절차 (UI 구현 태스크의 차단 해제)

화면 제품이므로 새 UI는 `docs/DESIGN.md` 승인 전 구현 금지.

1. 디자인 단계에서 `docs/DESIGN.md` 작성 — 검색 UI 형태·리마인더 알림 방식(OQ-02)·
   다크모드 색 방향·템플릿/폴더 설정 화면의 미리보기 자산과 결정 대상을 포함.
2. 사용자가 검토 후 승인 — `docs/DESIGN.md`에 **승인 버전·적용 범위·선택 근거**를 기록.
3. 승인 범위에 해당하는 `blocked` 태스크만 `pending`으로 전환. 범위 밖은 차단 유지.
4. 시각 보존 변경(버그 수정·기존 화면 유지 리팩터)은 기존 화면이 승인 기준선이라
   새 DESIGN 절차 없이 진행 가능.

현재 `docs/DESIGN.md`는 미작성 → 모든 UI 구현 태스크 `blocked`.

## OQ 차단 목록

| OQ | 차단되는 태스크 | 해소 방법 |
|---|---|---|
| OQ-01 릴리스 컷 | (전체 — 진행 자체는 가능) | 사용자가 R 포함 범위 선택 |
| OQ-02 알림 방식 | phase-03-task-02 | DESIGN 미리보기와 함께 사용자 선택 |
| OQ-03 충돌 정책 | phase-04-task-03 | 사용자 정책 결정(최신 승/병합/보관) |
| DESIGN 승인 | phase-02-task-02, 03-02, 04-04, 05-03, 05-04 | 위 승인 절차 |

## Phase 색인

### phase-01 — 저장소·기반 보강 (NFR-01/04/05, TD-01/02/03/11/13)

| 태스크 | 내용 | 상태 |
|---|---|---|
| phase-01-task-01 | 스키마 version 2 + migrate 연쇄 + v1 fixture 회귀 | pending |
| phase-01-task-02 | save_store rename 재시도 + 저장 신뢰성 | pending |
| phase-01-task-03 | rust-version 1.90 갱신 + 게이트 명령 확정 | pending |

### phase-02 — 전체 검색 (R-01)

| 태스크 | 내용 | 상태 |
|---|---|---|
| phase-02-task-01 | 검색 코어 — 텍스트 추출·매칭·결과 모델 + selftest | pending |
| phase-02-task-02 | 검색 UI + 진입점 (별도 창 권장·형태 DESIGN 결정) | blocked — DESIGN |

### phase-03 — 리마인더 (R-02/03)

| 태스크 | 내용 | 상태 |
|---|---|---|
| phase-03-task-01 | 리마인더 모델 + Rust 스케줄러 + 발화 이벤트 + 재시작 복원 | pending |
| phase-03-task-02 | 리마인더 UI + 알림 전달 | blocked — OQ-02 + DESIGN |

### phase-04 — 폴더 동기 지원 (R-04/05)

| 태스크 | 내용 | 상태 |
|---|---|---|
| phase-04-task-01 | 저장 폴더 지정 — config.json 포인터 + set_data_dir + 이전 | pending |
| phase-04-task-02 | 외부 변경 감지 + 자동 리로드(비충돌 경로) | pending |
| phase-04-task-03 | 동기 충돌 처리 | blocked — OQ-03 |
| phase-04-task-04 | 동기 설정 UI(폴더 선택·경로 표시) | blocked — DESIGN |

### phase-05 — P1 묶음 (R-06/07/08)

| 태스크 | 내용 | 상태 |
|---|---|---|
| phase-05-task-01 | 템플릿/스니펫 모델 + 삽입 코어 | pending |
| phase-05-task-02 | 인덱스 표시/숨김 코어 — hidden 필드 + 필터 | pending |
| phase-05-task-03 | 다크모드 — 크롬 토큰 + 모드 저장 | blocked — DESIGN |
| phase-05-task-04 | P1 묶음 UI 노출 — 템플릿 선택/삽입·숨김 토글 | blocked — DESIGN |

### phase-06 — 기술 검토·수동 검증

| 태스크 | 내용 | 상태 |
|---|---|---|
| phase-06-task-01 | noRedirectionBitmap 적용 + 실기 검증 기록 | pending |
| phase-06-task-02 | allowDowngrades·다운그레이드 정책 결정 + 적용 | pending |
| phase-06-task-03 | 수동 검증 통합 — IME 손 타이핑·멀티모니터·외부 리로드 실기 | pending |

## 완료 목표

- P0(R-01/02) 기능이 DESIGN·OQ 해소 후 사용자 승인 기준으로 동작.
- P1(R-03~08) 코어가 구현·검증되고 UI는 DESIGN 승인 범위만큼 노출.
- 저장 신뢰성·스키마 호환·게이트가 회귀 없이 유지 (selftest 기존+신규 PASS).
- 모든 OQ는 해소되거나 해소 조건과 함께 명시된 상태로 사용자에게 보고.
