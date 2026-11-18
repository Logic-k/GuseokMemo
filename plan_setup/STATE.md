---
topic: 구석메모 다음 개발 사이클 상태
updated: 2026-11-18
status: 계획·하네스·Loop 계약 준비 완료 — Loop 시작 승인 대기
---

# STATE — 다음 개발 사이클

## 현재 단계
문서화 완료: PRD → TRD → ARCHITECTURE → PLAN → 하네스(harness_setup/) → Loop 계약
(loop_setup/LOOP.md). 구현 Loop 미착수 — **시작은 사용자 승인 대기**.
기존 `plan_setup/LOG.md`는 v0.2.4까지의 버그/개선 이력으로 보존(미검증 항목은 아래 연결).

## 태스크 현황 (18)

| 상태 | 개수 | 태스크 |
|---|---|---|
| pending | 12 | 01-01, 01-02, 01-03, 02-01, 03-01, 04-01, 04-02, 05-01, 05-02, 06-01, 06-02, 06-03 |
| blocked | 6 | 02-02(DESIGN), 03-02(OQ-02+DESIGN), 04-03(OQ-03), 04-04(DESIGN), 05-03(DESIGN), 05-04(DESIGN) |

## 차단과 해소 조건

| 차단 | 대상 | 해소 |
|---|---|---|
| docs/DESIGN.md 미작성·미승인 | 02-02, 03-02, 04-04, 05-03, 05-04 | PLAN.md "DESIGN 승인 절차" — 미리보기 작성→사용자 승인(버전·범위 기록)→blocked 해제 |
| OQ-02 리마인더 알림 방식 | 03-02 | DESIGN과 함께 사용자 선택(토스트/패널 강조/소리) |
| OQ-03 동기 충돌 정책 | 04-03 | 사용자 정책 결정(최신 승/병합/보관) |
| OQ-01 첫 릴리스 범위 | 릴리스 계획 | 사용자가 R-01~R-08 중 선택 — 구현 진행 자체는 무관 |

## 다음 행동 (재개 지점)

1. (Loop 시작 승인 후) phase-01-task-01~03 (pending, 독립) — 스키마 v2, rename 재시도, 툴체인.
2. 이어서 phase-02-task-01, 03-01, 04-01, 04-02, 05-01, 05-02 (pending, 코어) — 순차.
3. 사용자에게 묶어서 확인: OQ-01/02/03 + DESIGN 미리보기 요청 → blocked 해제.
4. 게이트: lint → unit → e2e → task_validation — 정의는 `harness_setup/quality_gates/`,
   실행기는 `harness_setup/scripts/` (e2e 26/26 실검증 2026-11-18).
5. Loop 운영 계약: `loop_setup/LOOP.md` + `.devin/skills/dod-runner/SKILL.md`.

## 합의 참조

- `docs/PRD.md` ## 자율운영 합의 — 권한(파일 수정·빌드·selftest/CDP), 예산(보통),
  금지(비밀 커밋·자동시작 잔재·데이터 파괴·push 승인 전 금지), 한도 초과=보고 후 중지.
- 역할별 모델: (미정). 실행 환경: Windows 로컬 데스크톱.

## 잔여 예산
보통 수준(통상 구현·검증 반복) — 세부 상한 미확인.

## 미검증 잔존 (기존 LOG 연결)
- 실 Windows IME 손 타이핑, 멀티모니터 "자동" 실기, 외부 리로드 실기 → phase-06-task-03.
- TD-09 noRedirectionBitmap, TD-10 allowDowngrades → 잠정, phase-06-task-01/02.
- selftest 트리거 경쟁(setup 1.4s emit 유실 → selftest 침묵, 2026-11-18 실측) —
  하네스는 cdp-nudge.cjs로 복구, 제품 측 근본 수정은 Loop 개선 후보
  (harness_setup/quality_gates/e2e.md 주의 절).
