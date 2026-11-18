---
id: phase-01-task-01
status: pending
depends_on: []
acceptance_criteria:
  - store.json에 "version": 2가 기록되고, migrate()가 v1(필드 없는) 입력을 v2 스키마로 정규화한다
  - 신규 필드(darkMode, notifyMethod, idx.hidden, idx.reminders[], templates[])가 기본값으로 채워진다
  - 저장소에 v1 fixture JSON이 있고, migrate 결과가 v2 기대값과 일치함을 단언하는 테스트가 통과한다
  - 구버전 백업 파일(스키마 필드 일부 누락)도 settings 복원 경로로 정상 로드된다
verification: [lint, unit, e2e]
phase: "01"
---

# phase-01-task-01 — 스키마 version 2 + migrate 연쇄

## 목표
store.json 스키마 버전을 명시하고, 신규 필드를 수용할 마이그레이션 경로를 만든다 (TD-03, NFR-04).

## 범위
- `src/store.js`: `defaultState()`에 v2 필드 추가, `migrate()`를 버전별 단계 변환으로 구조화
- fixture JSON(v1 스냅샷) 추가 + migrate 단언 — selftest 또는 JS 단위 검증
- `src/selftest.js`에 "v1 store → migrate → v2" 회귀 케이스 추가

## 관련
- FR/NFR: NFR-04, R-02/06/07/08의 데이터 기반
- TD: TD-03 (기존 `version` 키 사용 — `__version` 신설 대신, 이유는 TRD에 기록)
- Architecture: overview.md §5 데이터 계약

## 참고
- 구버전 앱이 v2 파일을 읽는 역방향은 TD-10(다운그레이드)에서 별도 검토 — merge가
  알 수 없는 키를 보존하는 방식을 깨지 않는다.
- `migrate()`는 현재 BUG-10 수정으로 이미 방어적 — 연쇄 구조만 더한다.
