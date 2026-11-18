---
name: dod-research
description: 주제를 병렬 researcher subagent로 조사해 research/INDEX.md와 종합 md로 정리
---

# dod-research — 리서치 프로토콜

Loop가 시작되기 전 단계에서는 사용자에게 확인을 받는다. 조사 자체는 질문 없이 끝까지 진행한다.

1. 주제를 분석해 겹치지 않는 조사 질문 3~6개로 나눈다 (동향·함정·도구·경쟁·비용 등 다양한 각도).
2. 각 질문을 `run_subagent`(profile `dod-researcher`, background 병렬)로 조사시킨다.
   결과는 `research/raw/qNN.md`에 한국어로 쓰게 한다.
3. 수집물을 교차 검증한다 — 모순, 출처 없는 주장, 빠진 관점을 찾아
   `research/review/round-1.md`에 정리한다. 필요하면 부족한 부분을 한 번 더 조사시킨다.
4. 검증된 내용만 종합해 `research/<slug>.md`를 쓴다:
   frontmatter(topic, updated, confidence), `## 결정`, `## 근거`, `## 출처`(표), `## 미결`.
5. `research/INDEX.md`에 종합 보고서로 가는 한 줄 링크를 추가한다.

비밀값을 쓰지 않고, 실제로 fetch한 페이지만 출처로 인용한다.
