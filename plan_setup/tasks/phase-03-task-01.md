---
id: phase-03-task-01
status: pending
depends_on: [phase-01-task-01]
acceptance_criteria:
  - indexes[].reminders[] 스키마가 migrate()로 정규화된다(at/repeat/enabled/lastFiredAt)
  - Rust 스케줄러가 save_store 파싱 결과로 인메모리 스케줄을 갱신하고 부팅 시 초기화한다
  - at <= now && enabled 인 리마인더에 guseok://reminder 이벤트가 emit된다
  - repeat:"daily"/"weekly"는 발화 후 다음 at이 자동 계산된다, "none"은 lastFiredAt만 기록
  - 재시작 후 미래 리마인더는 발화하고, 과거 미발화분은 "놓침"으로 구분된다
verification: [lint, unit, e2e]
phase: "03"
---

# phase-03-task-01 — 리마인더 모델 + Rust 스케줄러

## 목표
알림 방식(OQ-02)과 무관한 발화 코어를 만든다 — 예약 데이터 모델 + Rust 상주 스케줄러 +
발화 이벤트 + 재시작 복원 (R-02/03, TD-07).

## 범위
- `src-tauri/src/main.rs`: 백그라운드 스레드 주기 체크 → `guseok://reminder` emit,
  `save_store`에서 reminders 파싱해 스케줄 갱신, 부팅 시 초기화
- `src/store.js`: reminders 필드 기본값·migrate 처리(phase-01-task-01과 결합)
- selftest/단위: 스케줄 계산(다음 at), 재시작 놓침 분류

## 관련
- R-02, R-03 — TD-07(Rust 상주 스케줄러, JS 타이머 기각 이유는 TRD)
- Architecture §6.2 발화 흐름, §5 reminders 스키마
- 전달부(UI·알림 방식)는 phase-03-task-02 — OQ-02 확정 전 blocked

## 참고
- 트레이 상주로 메인 프로세스가 상시 생존 — 스레드 생명주기는 앱과 동일.
- 리마인더 CRUD는 store 필드라 별도 IPC 없이 save_store 경유 동기화.
