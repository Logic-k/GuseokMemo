---
id: phase-02-task-02
status: blocked
depends_on: [phase-02-task-01]
acceptance_criteria:
  - 검색 진입점(전역키/트레이/패널 버튼 — DESIGN 결정)으로 검색 UI가 열린다
  - 키워드 입력에 결과 목록이 실시간 갱신되고, 각 결과에 인덱스 제목+스니펫이 보인다
  - 결과 클릭 시 해당 인덱스 패널이 열린다(기존 show_panel 경로)
  - 검색 입력 중 IME 조합이 끊기지 않는다(NFR-02 — 조합 중 DOM/속성 변경 없음)
  - 매칭 0건이면 "결과 없음" 표시, 닫기 단축/외부 클릭으로 닫힌다
verification: [lint, e2e, task_validation]
phase: "02"
---

# phase-02-task-02 — 검색 UI + 진입점

## 목표
검색 코어를 사용자에게 노출하는 화면을 만든다 (R-01).

## 차단 사유
- **blocked — DESIGN 미승인**: 새 UI(검색 창 또는 패널 내 검색)는 `docs/DESIGN.md` 승인
  대상. 형태(별도 `search` 창 권장 vs 패널 내 오버레이)와 진입점을 DESIGN에서 확정.
- 해제 조건: DESIGN 승인 범위에 검색 UI 포함 → pending 전환.

## 범위 (승인 후)
- 신규 창이면 `setup`에서 생성·hide/show 재사용(NFR-06, BUG-18 회귀 방지)
- 진입점: 전역 단축키 후보 / 트레이 메뉴 / 패널 버튼 — DESIGN 결정대로
- 결과 클릭 → handles `open(id)`와 동일 경로로 점프

## 관련
- R-01, Architecture §2 창 경계·§6.1 흐름, NFR-02(IME)·NFR-06(창 수명)
- 선행: phase-02-task-01(검색 코어)
