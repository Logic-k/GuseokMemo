---
id: phase-05-task-03
status: completed
depends_on: []
acceptance_criteria:
  - 설정/패널 크롬/스트립 비인덱스 영역에 라이트/다크/시스템 따르기 모드가 적용된다
  - 선택 모드가 common.darkMode에 보존되고 재시작 후 유지된다
  - 메모 카드의 인덱스별 테마(bg/fg)는 다크모드가 덮어쓰지 않는다
  - 색 방향이 DESIGN 승인 범위와 일치한다
verification: [lint, e2e, task_validation]
phase: "05"
---

# phase-05-task-03 — 다크모드

## 목표
앱 크롬에 다크모드를 적용한다 (R-08).

## 차단 사유
- **blocked — DESIGN 미승인**: 색 방향·적용 범위(설정 창? 패널 툴바? 스트립?)는 시각
  결정이라 `docs/DESIGN.md` 승인 필수. 팔레트·대비는 DESIGN 정본이 정한다.
- 해제 조건: DESIGN 승인 범위에 다크모드 포함 → pending 전환.

## 범위 (승인 후)
- `common.darkMode`(light/dark/system) + migrate
- settings.css·style.css 토큰(CSS 변수) 전환 — 승인 팔레트
- 시스템 따르기면 OS 테마 감지(matchMedia 등)

## 관련
- R-08 — 메모 카드는 인덱스 테마 우선(덮어쓰기 금지)
