---
id: phase-03-task-02
status: blocked
depends_on: [phase-03-task-01]
acceptance_criteria:
  - 사용자가 인덱스에 시각(및 반복) 리마인더를 설정·해제·목록 조회할 수 있다
  - 발화 시 OQ-02로 확정된 방식(토스트/패널 강조/소리)으로 알림이 도달한다
  - 패널이 닫혀 있어도 알림이 도달한다
  - 놓친 리마인더는 목록/표시로 구분된다
  - 알림·설정 UI가 DESIGN 승인 방향과 일치한다
verification: [lint, e2e, task_validation]
phase: "03"
---

# phase-03-task-02 — 리마인더 UI + 알림 전달

## 목표
리마인더 설정 UI와 알림 전달부를 만든다 (R-02/03).

## 차단 사유
- **blocked — OQ-02(알림 방식 미정) + DESIGN 미승인**: 토스트/패널 강조/소리는 사용자
  결정 + 미리보기 후 확정. 새 설정·알림 UI도 DESIGN 승인 대상.
- 해제 조건: OQ-02 확정 + DESIGN 승인 범위 포함 → pending 전환.

## 범위 (승인 후)
- 인덱스별 리마인더 설정(시각·반복)·목록 UI — 위치는 DESIGN 결정(패널/설정)
- `guseok://reminder` 수신 → 확정 방식으로 전달
- 놓친 알림 표시

## 관련
- R-02, R-03, OQ-02 — 전달부가 방식에 의존
- 선행: phase-03-task-01(발화 코어)
