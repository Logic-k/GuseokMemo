---
id: phase-02-task-01
status: completed
depends_on: []
acceptance_criteria:
  - 인덱스의 content HTML에서 텍스트만 추출하는 순수 함수가 있다(태그·input·img 제외, ck-text/li/h1~3/p 포함)
  - 키워드 입력 시 제목+본문 매칭 인덱스 목록이 {indexId, title, snippet} 형태로 반환된다
  - 대소문자 무시 매칭, 빈 키워드는 검색 수행하지 않음, 매칭 0건은 빈 결과 반환
  - 숨긴 인덱스(hidden:true)는 결과에서 제외된다(R-07 정책)
  - selftest 또는 CDP로 위 동작을 단언할 수 있다
verification: [lint, unit, e2e]
phase: "02"
---

# phase-02-task-01 — 검색 코어

## 목표
전체 검색의 순수 로직을 구현한다 — UI 없이 검증 가능한 코어 (R-01, TD-06).

## 범위
- `src/` 신규 모듈(예: `search.js`): `extractText(html)`, `search(state, query)` → 결과 목록
- 스니펫: 매칭 전후 문맥 발췌(길이 기준 구현 시 확정)
- selftest 케이스: 마크다운·체크리스트·제목 매칭, 0건, 숨김 제외

## 관련
- R-01, TD-06(인메모리 순차 검색 — 인덱스 10개라 FTS 불필요)
- Architecture §6.1 검색 흐름
- 후속 phase-02-task-02(UI)가 이 코어를 소비

## 참고
- 이미지(images[])는 대상 아님. 본문 HTML에서 `.ck input` 등 비텍스트 노드는 제외.
- state는 메모리 상의 현재본 — 외부 리로드 후 자동 최신.
