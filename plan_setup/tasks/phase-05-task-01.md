---
id: phase-05-task-01
status: pending
depends_on: [phase-01-task-01]
acceptance_criteria:
  - store.templates[]에 기본 템플릿(빈/할일/회의 등)이 있고 migrate()로 정규화된다
  - 템플릿 적용 함수가 새 인덱스의 content로 HTML을 넣는다
  - 스니펫 삽입 함수가 {date} 등 치환자를 실제 값으로 치환해 삽입 위치에 넣는다
  - selftest 또는 CDP로 모델·삽입 동작을 단언할 수 있다
verification: [lint, unit, e2e]
phase: "05"
---

# phase-05-task-01 — 템플릿/스니펫 모델 + 삽입 코어

## 목표
템플릿·스니펫 데이터와 삽입 로직을 UI 없이 검증 가능한 코어로 만든다 (R-06).

## 범위
- `src/store.js`: templates 기본값·migrate(phase-01-task-01과 결합)
- `src/` 모듈: `applyTemplate(content)`, `insertSnippet(text)` — 치환자 처리
- 기본 템플릿 정의(할일/회의/아이디어 재사용 + 추가분 — 구성은 구현 시)

## 관련
- R-06, Architecture §5 templates 스키마
- 후속: phase-05-task-04(UI 노출) — 선택/삽입 진입점은 DESIGN 결정

## 참고
- 템플릿은 store 안에 두어 사용자 수정 가능하게(기본 제공분 builtin 표시).
- 삽입은 기존 에디터 경로(insertText 계열)와 호환 — IME 조합 중 삽입 금지(NFR-02).
