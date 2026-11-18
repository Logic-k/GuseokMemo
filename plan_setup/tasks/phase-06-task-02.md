---
id: phase-06-task-02
status: pending
depends_on: [phase-01-task-01]
acceptance_criteria:
  - allowDowngrades 적용 여부가 근거와 함께 결정·기록된다
  - 적용 시 tauri.conf.json plugins.updater.allowDowngrades가 설정된다
  - 다운그레이드 시 v2 스키마(신규 필드)를 구버전 앱이 읽어도 파괴하지 않는지 확인·기록된다
  - 롤백 운용 절차(latest.json 이전 버전 교체 등)가 문서로 남는다
verification: [lint, unit]
phase: "06"
---

# phase-06-task-02 — allowDowngrades·다운그레이드 정책 결정

## 목표
롤백 배포 경로(`allowDowngrades`, updater ≥2.12 플러그인 설정)를 검토·확정한다
(TD-10 잠정 → 확정/보류).

## 범위
- `src-tauri/tauri.conf.json`: `plugins.updater.allowDowngrades` 설정 여부 결정
- 스키마 역방향 확인: v2 store(신규 필드 포함)를 v1 migrate가 읽을 때 신규 키 보존 여부
  — merge가 알 수 없는 키를 버리지 않는지 단언(phase-01-task-01과 결합)
- 롤백 절차 문서: 회귀 릴리스 → latest.json 이전 버전 지시 → 사용자 다운그레이드 수신

## 관련
- TD-10 — 근거 q02 §2.3(2.12.0부터 플러그인 설정, 보안상 JS 옵션 제거)
- **미정 성격**: 실제 롤백 배포 실행은 사용자 승인 대상 — 이 태스크는 경로 확보·문서화만.

## 참고
- 스키마 다운그레이드가 안전하지 않으면(신규 필드 유실) allowDowngrades는 보류 권고.
