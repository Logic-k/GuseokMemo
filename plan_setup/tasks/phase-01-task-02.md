---
id: phase-01-task-02
status: completed
depends_on: []
acceptance_criteria:
  - save_store의 fs::rename 실패(파일 점유) 시 짧은 백오프로 재시도하고, 최종 성공/실패가 구분된다
  - 재시도 경로를 거쳐도 store.bak.json 백업과 guseok://store 브로드캐스트가 유지된다
  - 점유 해제 후 저장이 성공하는 것을 로그/동작으로 확인할 수 있다
  - 기존 selftest store-write/store-restore가 통과한다
verification: [lint, unit, e2e]
phase: "01"
---

# phase-01-task-02 — save_store rename 재시도 + 저장 신뢰성

## 목표
Windows 파일 점유(백신·인덱서·동기 클라이언트)로 rename이 실패해도 저장이 성공하도록
짧은 재시도를 추가한다 (TD-02, NFR-01). R-04/05 폴더 동기로 이 경로가 상시 노출되기 전 선행 보강.

## 범위
- `src-tauri/src/main.rs` `save_store`: rename 실패 → 지연 재시도(횟수·간격 구현 시 확정) →
  최종 실패만 Err. 성공 시에만 기존 브로드캐스트 emit.
- Windows 디렉터리 fsync 불가 한계는 코드 주석/문서로 기록.

## 관련
- NFR-01, TD-02 — 대안(safe-write) 비교와 이유는 TRD.
- 후속 phase-04(외부 동기 클라이언트가 같은 파일을 엶)의 전제.

## 참고
- 재시도는 "점유 해제 후 성공"이 관찰 가능해야 한다 — 백신/인덱서 재현은 수동 확인 항목으로
  LOG에 남긴다.
