---
id: phase-05-task-02
status: pending
depends_on: [phase-01-task-01]
acceptance_criteria:
  - idx.hidden 필드가 migrate()로 정규화되고 store.json에 보존된다
  - hidden:true인 인덱스는 handles 스트립 렌더·layout 계산에서 제외된다
  - Ctrl+번호 직접 열기·↑/↓ 순환이 숨긴 인덱스를 건너뛴다
  - 전부 숨김 상태는 발생하지 않는다(마지막 1개 보호)
  - 검색 대상에서도 제외된다(phase-02-task-01 정책과 일치)
verification: [lint, unit, e2e]
phase: "05"
---

# phase-05-task-02 — 인덱스 표시/숨김 코어

## 목표
인덱스를 스트립에서 숨기는 데이터+필터 로직을 만든다 (R-07).

## 범위
- `src/store.js`: hidden 필드·migrate
- `src/handles.js`: render/place에 visible 필터, step()·Ctrl+번호 대상에서 제외,
  마지막 1개 보호
- `src/layout.js`: getLayout이 visible 개수로 스트립 높이 계산

## 관련
- R-07 — 근거 q03(linuxmint #78 show/hide)
- 후속: phase-05-task-04(설정·스트립의 토글 UI 노출은 별도 blocked 태스크)
- 연결: phase-02-task-01 검색 제외 정책과 일치

## 참고
- 데이터·메모는 유지 — 숨김은 표시만. 숨긴 인덱스가 lastIndexId면 열기 시 첫 visible로.
