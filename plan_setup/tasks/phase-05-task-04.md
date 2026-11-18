---
id: phase-05-task-04
status: blocked
depends_on: [phase-05-task-01, phase-05-task-02]
acceptance_criteria:
  - 새 인덱스 생성 시 템플릿을 선택할 수 있다(위치·형태 DESIGN 결정)
  - 편집 중 스니펫을 목록에서 골라 커서에 삽입할 수 있다
  - 인덱스를 스트립/설정에서 숨기고 다시 표시할 수 있다(토글 UI DESIGN 결정)
  - 각 UI가 DESIGN 승인 방향과 일치한다
verification: [lint, e2e, task_validation]
phase: "05"
---

# phase-05-task-04 — P1 묶음 UI 노출

## 목표
템플릿 선택/스니펫 삽입·인덱스 숨김 토글을 화면에 노출한다 (R-06/07 UI).

## 차단 사유
- **blocked — DESIGN 미승인**: 새 진입점(템플릿 선택 UI, 스니펫 삽입 메뉴/단축키,
  숨김 토글 위치)은 `docs/DESIGN.md` 승인 대상.
- 해제 조건: DESIGN 승인 범위에 포함 → pending 전환.

## 범위 (승인 후)
- 템플릿 선택: `+` 인덱스 추가 흐름에 선택 단계 또는 설정에서 — DESIGN 결정
- 스니펫 삽입: 패널 메뉴/단축키 — DESIGN 결정
- 숨김 토글: 설정 행·핸들 우클릭 메뉴 등 — DESIGN 결정

## 관련
- R-06, R-07 — 선행: phase-05-task-01/02(코어)
