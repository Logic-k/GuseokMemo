---
id: phase-04-task-02
status: completed
depends_on: [phase-04-task-01]
acceptance_criteria:
  - Rust가 store.json의 mtime을 주기 감시하고, 자기 저장(save_store)과 구분해 외부 변경만 감지한다
  - 외부 변경 감지 시 파일을 읽어 guseok://store{src:"external", raw}로 브로드캐스트한다
  - 모든 창이 migrate() 경유로 새 내용을 반영하고 handles/panel이 갱신된다
  - 리로드가 편집 중 에디터의 IME 조합·포커스를 깨지 않는다(NFR-02)
  - 자기 저장 직후 재로드 루프(자기 에코)가 발생하지 않는다
verification: [lint, unit, e2e]
phase: "04"
---

# phase-04-task-02 — 외부 변경 감지 + 자동 리로드 (비충돌)

## 목표
동기 클라이언트·다른 PC가 바꾼 store.json을 앱이 자동으로 다시 읽는다 (R-05 비충돌 경로,
TD-04).

## 범위
- `src-tauri/src/main.rs`: mtime 폴링 루프 — "마지막으로 우리가 쓴/읽은 mtime"과 비교해
  자기 에코 억제 → 변경 감지 시 읽어 `guseok://store`(src:"external") emit
- `src/store.js`: src:"external" 수신 → migrate() → 기존 externalHandler 경로로 반영
  (창 라벨과 다른 src라 기존 자기 에코 필터를 자연 통과)

## 관련
- R-05, TD-04(폴링 채택 — notify 대안은 TRD), NFR-02
- Architecture §6.3 리로드 흐름
- 선행: phase-04-task-01(폴더 지정이 있어야 동기 편입 의미)
- **충돌(앱 미저장 편집 vs 외부 변경) 분기는 phase-04-task-03 — OQ-03 의존, 이 태스크는
  비충돌 경로만.**

## 참고
- 감지 지연은 수 초 이내 — CDP로 변경 시각→반영 시각 측정 가능.
