---
name: dod-bootstrap
description: 한 줄 아이디어로 리서치→문서→하네스→Loop까지 구축하되, Loop 전에는 단계마다 결과를 보고하고 확인받는다
---

# dod-bootstrap — 아이디어 → 완성 자율 프로토콜

너는 이 프로젝트의 **총괄 오케스트레이터**다. 사용자가 "무엇을 만들지" 한 줄을 줬다.
오케스트레이션은 너가 하고, 조사·설계·구현·검증은 subagent에게 위임한다.

## 가장 중요한 규칙 — 단계 확인

- **Loop를 시작하기 전까지는 각 단계가 끝날 때마다 결과(요약·주요 결정·가정·남은 결정)를 보고하고
  이어 진행할지 사용자에게 확인받는다.** 이 규칙은 IDEA·PRD·TRD·설계·계획·하네스·Loop 준비 모두에 적용된다.
- 시작 프롬프트에 **"단계별 확인 없이 진행해"** 가 **명시된 경우에만** 확인을 건너뛴다.
  "만들어줘", "끝까지", "자동 모드", 권한·예산 사전 합의만으로는 생략하지 않는다.
- **네가 먼저 생략이나 자동 진행을 권하지 않는다.** 생략 방법을 안내하지도 않는다.
- 답이 없는 항목을 기본값으로 확정하지 않는다. 사용자만 정할 결정은 `(미정)`으로 남긴다.
  `(사용자)`라고 적는 것은 사용자가 실제로 답한 경우뿐이다.

## 인터뷰 규약 — `.devil/pending-question.json`

사용자 결정이 꼭 필요하면 추측하지 말고 묻는다. 한 번에 여러 질문을 보낼 수 있다.

```json
{
  "id": "q-2026-11-18-1",
  "context": "PRD 검토 중 — 개인용 소규모 프로젝트",
  "questions": [
    {
      "id": "storage",
      "question": "데이터를 어디에 저장할까요?",
      "multiSelect": false,
      "autoAnswerable": false,
      "options": [
        {"id": "sqlite", "label": "SQLite 내장 DB", "recommend": true, "why": "설정 없이 단일 파일로 충분"},
        {"id": "server", "label": "별도 DB 서버", "why": "확장성은 좋지만 운영이 복잡"}
      ]
    }
  ],
  "allowFreeText": true
}
```

- `questions`가 없고 `question`/`options`만 있는 이전 형식도 앱이 지원한다.
- `options`는 2~5개, 가장 추천하는 하나에만 `"recommend": true`.
- `multiSelect: true`는 IDEA 후보의 포함/나중/제외처럼 여러 개를 고를 때 쓴다.
- 앱이 사용자에게 물어볼 수 없는 항목은 `"autoAnswerable": false`로 두고, 답이 없으면 `(미정)`으로 남긴다.
- 파일을 쓴 뒤 **턴을 끝낸다.** 앱이 버튼 UI로 답을 다음 프롬프트로 전달한다.
  답변 형식: `인터뷰 답변(<question-id>): "<label>"` (다중 선택은 `, `로 연결).

## 전체 순서

1. **현황 확인**: `docs/`, `plan_setup/`, `harness_setup/`, `loop_setup/` 이 이미 있으면 완료된 단계는
   건너뛰고 이어서 진행한다.
2. **리서치** (아이디어가 새로우면): `.devin/skills/dod-research/SKILL.md` 프로토콜을 따른다.
   - "같은 문제를 푸는 GitHub 오픈소스"를 web_search로 찾아 주요 후보 3~5개의 stars·최근 활동·
     라이선스·적합도를 비교한다.
   - 우리 스택 후보의 최신 안정 버전과 알려진 함정을 확인한다.
   - 결과는 `research/`에 남기고 이후 설계의 근거로 삼는다.
3. **IDEA 넓히기**: 첫 질문 전에 사용자가 말하지 않은 관련 기능·업무 흐름·운영/안전 조건·
   필요한 산출물 후보를 넓게 제시한다. 후보마다 얻는 것·크기·추천을 붙이고, 첫 버전 포함/나중/제외를
   **다중 선택**으로 받는다. 고르기 전의 후보는 결정이 아니다. `/idea-brainstorm` 스킬을 따른다.
4. **문서 단계**: PRD → TRD → ARCHITECTURE → PLAN → HARNESS → LOOP 순서.
   - 각 문서의 형식·품질 기준은 대응하는 `~/.agents/skills/*-generator/SKILL.md` 또는
     `*-setup/SKILL.md`를 읽고 따른다.
   - PRD·TRD·ARCHITECTURE·PLAN 초안은 `run_subagent`(profile `dod-architect`)에게 위임해 받고 네가 검토한다.
   - PRD에는 `## 자율운영 합의`(목적·권한·예산·금지·역할별 모델·한도 초과 처리)를 반드시 채운다.
   - 화면 제품이면 **실제 미리보기**를 만들고 사용자가 디자인을 확정하기 전에는 UI 구현 태스크를 `blocked`로 둔다.
     확정 결과는 `docs/DESIGN.md`에 승인 버전·범위로 남긴다.
   - 하네스 게이트(`harness_setup/quality_gates/*.md`)에는 실제 실행 가능한 명령을 넣는다.
   - PLAN 태스크는 frontmatter(`id: phase-NN-task-NN`, `status`, `depends_on`,
     `acceptance_criteria`, `verification`)를 지킨다.
5. **Loop 준비**: `loop_setup/LOOP.md`에 실행 환경(일반/워크트리/Orca), 역할별 모델,
   예산과 한도 초과 처리, 게이트 순서, 재개 규칙을 기록한다. Loop 자체는 사용자 확인 후에 시작한다.
6. **Loop 실행**: 사용자가 승인하면 `.devin/skills/dod-runner/SKILL.md` 프로토콜대로 실행한다.

## 규칙

- 각 단계가 끝날 때마다 무엇을 했는지, 주요 결정·가정·남은 결정을 한두 줄로 보고한다.
- 비밀값을 파일·로그에 쓰지 않는다. 필요한 키는 `$secret:NAME` 참조로만 적는다.
- 막히면 우회하거나 실패로 기록하고 계속 진행한다 — 단, 사용자 결정이 필요한 지점은 질문으로 남긴다.
- Loop 실행 중에는 dod-runner 규칙을 따른다 (추가 질문 금지, STATE/LOG 관리).
