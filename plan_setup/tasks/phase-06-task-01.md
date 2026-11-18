---
id: phase-06-task-01
status: pending
depends_on: []
acceptance_criteria:
  - noRedirectionBitmap 적용 여부가 결정되고, 적용 시 handles/panel 창에 설정된다
  - 적용 전후 흰 플래시·투명 렌더·검은 영역·드래그 스냅 동작이 실기 관찰로 기록된다
  - 회귀가 있으면 롤백(설정 한 줄)하고 결과가 LOG에 남는다
verification: [lint, e2e]
phase: "06"
---

# phase-06-task-01 — noRedirectionBitmap 적용 + 실기 검증

## 목표
tauri ≥2.12의 `noRedirectionBitmap`을 투명 창에 적용해 흰 플래시·DWM 경합을 줄이는지
검토·확정한다 (TD-09 잠정 → 확정/기각).

## 범위
- `src-tauri/tauri.conf.json` 또는 창 빌더에 `noRedirectionBitmap` 설정 — 대상: handles·panel
  (settings는 불투명 일반 창이라 대상 아님)
- 실기 관찰: 생성 시 흰 플래시, 드래그·스냅·show/hide, 투명 영역 렌더 — 결과 LOG 기록

## 관련
- TD-09 — 근거 q02 §1.1(WS_EX_NOREDIRECTIONBITMAP, BlurBehind 경로 우회)
- **검증 필요**: Win10 특정 DWM 경합 재현은 이 환경(Win11?)에서 불완전할 수 있어
  "적용해도 회귀 없음" 판정이 최소 기준.

## 참고
- 미적용 결정이어도 관찰 근거를 남겨 잠정을 해소한다.
