---
topic: 구석메모 다음 개발 사이클 Loop 계약
updated: 2026-11-18
status: 준비 완료 — **Loop 시작은 사용자 승인 대기**
inputs: docs/PRD.md(자율운영 합의), plan_setup/PLAN.md·STATE.md, harness_setup/HARNESS.md
executor: .devin/skills/dod-runner/SKILL.md (Loop 실행 프로토콜)
---

# LOOP — 구석메모 개발 루프 계약

이 파일은 Loop의 운영 계약이다. 실행 절차(태스크 전이·subagent 위임·실패 기록·협조적
중지)는 **`/.devin/skills/dod-runner/SKILL.md` 규약을 따른다** — 이 파일은 그 규약에
프로젝트 실값을 바인딩한다. **Loop 시작 자체는 사용자 승인 대기**다.

## 1. 합의 위치와 경계

- **자율운영 합의 정본**: `docs/PRD.md` §7 — 목적·권한·예산·금지·한도 초과 처리.
- **허용**: 제품 코드(`src/`, `src-tauri/`, `index.html`, `settings.html`), `docs/`,
  `plan_setup/` 상태 파일 수정; `npm run build`, `cargo fmt/clippy/test/build`,
  debug exe `--selftest`, `plan_setup/cdp-*.cjs`, `harness_setup/scripts/*.ps1` 실행;
  **로컬 커밋** (의미 있는 체크포인트, `loop(<task-id>): <요약>` 형식 권장).
- **금지**: `git push`·GitHub Release·태그 발행(승인 전); 비밀값 커밋(필요 시
  `$secret:NAME` 참조만 — 서명키는 저장소 밖 유지); 자동시작·트레이·프로세스·
  임시 파일 잔재; 실사용자 `store.json` 파괴·초기화(스냅샷→복원만).
- **계약 문서 보호**: `harness_setup/`, `loop_setup/`, `docs/`의 계약 부분,
  `plan_setup/`의 태스크 내용(frontmatter `status:`·STATE·LOG 제외)은 구현 태스크가
  바꾸지 않는다 — 조정자가 관리한다 (dod-runner 규칙 절).

## 2. 실행 환경과 작업 주체

- **환경**: Windows 로컬 데스크톱, **일반 환경(워크트리·Orca 아님)** — 메인
  체크아웃 `D:\구석메모앱`에서 순차 실행.
- **주체**: dod-runner 규약의 조정자가 오케스트레이션, 구현·검증은 subagent 위임
  (`dod-implementer` / `dod-validator` 프로필). 검증은 구현과 다른 비상속 세션.
- **역할별 모델**: **(미정)** — 조정·구현·검증 모두 사용자만 정할 결정.
  정해지기 전까지 dod-runner 준비 절대로 "가장 보수적으로 선택 + LOG 근거"를 적용.

## 3. 게이트와 판정

- 순서 고정: **lint → unit → e2e → task_validation**
  (`harness_setup/quality_gates/` 네 정의 = `plan_setup/PLAN.md` 게이트 맵).
  앞 실패 복구 전 뒤를 열지 않는다.
- 태스크 `verification:` 키 → 같은 이름의 게이트 파일. 명령은 각 파일 frontmatter
  `command:` 또는 첫 코드 블록. `task_validation`은 명령이 없으므로 비상속
  검증 세션(`dod-validator`)이 수용 기준별 관찰로 판정 — `RESULT: PASS|FAIL`.
- 판정 중 제품 소스·수용 기준·통과 단언을 자동 수정하지 않는다. 수정은 구현 단계에서
  하고 영향받은 판정을 무효화해 재검증한다. 검사 약화·대상 축소·재실행 통과 만들기 금지.
- 완료(`completed`)는 수용 기준 증거 + 필요 회귀가 입증됐을 때만 — 0건·미실행·
  미활성·코드 작성만은 증거가 아니다. 같은 코드·설정·데이터 조건이면 결과 재사용·
  묶음 검사 가능(근거를 LOG에).

## 4. 작업 선택·차단·동시 상한

- 선택: `status: pending`이고 `depends_on` 전부 `completed`인 태스크, phase → id 순.
- **blocked 해제 조건** (STATE.md 차단 표가 정본):
  - `docs/DESIGN.md` 승인(버전·범위 기록) → 해당 범위 UI 태스크만 pending 전환.
  - OQ-02(알림 방식)·OQ-03(충돌 정책) 사용자 결정 → 해당 태스크만 해제.
  - OQ-01(릴리스 컷)은 구현 진행을 막지 않는다.
- **동시 구현 상한 = 1** (메인 체크아웃·워크트리 미사용). e2e/selftest/CDP는 항상
  직렬 — single-instance·CDP :9223 단일 포트·공유 store.json이 강제.
- e2e 실행 전 실행 중 `guseok-memo.exe` 0 확인(인자 전달로 selftest 무력화 방지).
- STATE.md와 태스크 파일이 어긋나면 실제 변경·검증 이력을 대조해 태스크 정본에
  맞추고 복구 이유를 기록한다.

## 5. 상태 기록·중단·재개

- **정본**: 태스크 frontmatter `status:` (완료 판정), `plan_setup/STATE.md` (재개
  기록 — 진행 중 작업·차단·잔여 예산·다음 행동), `plan_setup/LOG.md` (누적 이력,
  append만 — 요약으로 원기록 삭제 금지), `.devil/loop/<task-id>/attempt-<n>.md`
  (실패 시도), `.devil/loop/qa-logs/` (e2e 증거 로그).
- 전이(배정·판정·중단)마다 STATE 갱신 + LOG 한 줄 — dod-runner 규약 절차를 따른다.
- **협조적 중지**: `.devil/loop/STOP` 파일 감지 시 현재 태스크의 안전한 경계
  (판정 기록)까지 마치고 정지 — dod-runner "중지와 예산" 절.
- **재개**: LOOP → STATE → 관련 태스크 → 실제 코드·미커밋·실행자·미반영 결과 대조 →
  `pending`부터 재개. 완료 재구현·중복 실행·미관찰 PASS 추정 금지.
- 부모 세션이 끊기면 자동 재시작 없이 중단 — 사용자가 다시 부르면 기록과 실제 상태로 재개.

## 6. 예산·복구·종료

- **예산**: 보통 수준(통상 구현·검증 반복) — 세부 상한 미확인. 추적은 STATE.md
  "잔여 예산" 절 + LOG 누적. **한도 초과 시 보고 후 중지·재개 지시 대기** —
  자율 판단으로 계속 진행하거나 범위를 축소하지 않는다 (PRD 합의).
- **실패 복구**: 같은 방식 수정 3회 이내 → 전략 전환(관찰→가설→다른 접근). 그래도
  안 되면 `status: failed` + 사유 LOG + 다음 태스크. 실패는 코드 결함·검사/문서
  불일치·환경·흔들림·판정 불가로 분류해 원인에 맞게 고친다.
- **막힘 처리**: 권한 밖 작업·미해소 OQ는 해당 태스크만 `blocked`로 두고 독립
  작업 계속. 질문·사람 응답 대기 파일을 남기지 않는다.
- **종료 조건**: 전체 예산 소진 / 필수 권한 부재+대안 없음 / 분석 후 실행 경로
  없음 — 근거와 함께 변경·증거·재개 조건을 남긴 미완료 보고로 종료.
- **최종 보고**: 완료/실패/미검증 범위·게이트 증거(qa-logs 경로)·실패 원인·
  누적 시도·잔여 예산·재개 명령/조건.

## 7. 시작 전 체크리스트 (사용자 승인 시 확인)

- [ ] Loop 시작 승인 (본 파일 status 갱신)
- [ ] 역할별 모델 결정 → §2 갱신 ((미정)이면 보수적 선택 + LOG)
- [ ] OQ-01/02/03·`docs/DESIGN.md` 미리보기 — 묶어서 사용자 확인 요청
      (해소 시 blocked 해제 범위 확정)
- [ ] `harness_setup/scripts/check-env.ps1` 전항 PASS
- [ ] 실행 중 `guseok-memo.exe` 0 · 포트 5183/9223 정리
