# phase-05-task-01 — attempt 1

## 목표
템플릿·스니펫 데이터와 삽입 로직의 코어 (R-06) — UI 없이 검증 가능하게.
선택·삽입 진입점·IME 가드는 phase-05-task-04(UI) 책임 — 코어는 순수 문자열 함수.

## 데이터 모델 결정
- `templates[]` (기존 v2, ARCH §5 문서화 그대로): `{id,name,content(HTML),builtin}` —
  새 인덱스 content용. 기본 3종 = STARTERS 재사용 (phase-01-task-01이 이미 도입).
- `snippets[]` (신규 v2 최상위): `{id,name,text(평문),builtin}` — 커서 삽입용.
  기본 4종: snip1 `{date}` / snip2 `{time}` / snip3 `{datetime}` / snip4 `작성일: {iso}`.
- 근거(보수적 선택): ARCH §5는 templates[]만 문서화 — 스니펫을 별도 최상위 배열로
  두면 templates[] 원소 형태를 그대로 유지하고, 원소 형태가 다른 스니펫(text 평문 +
  치환자)을 섞지 않는다. `templates[].kind` 혼합안도 가능했으나 단일 배열 스키마를
  건드리지 않는 쪽을 택함. TD-10 spread merge가 구버전 앱의 읽기·재저장에서
  snippets를 자연 보존. SCHEMA_VERSION 증가 없이 v2 STEPS[1]에 추가 — templates와
  같은 개발 주기(v2 아직 릴리스 전)의 공통 자산.

## 변경 — `src/store.js`
- `defaultSnippet()` 추가 (defaultReminder/defaultTemplate와 같은 패턴).
- `defaultState().snippets` — builtin 4종.
- `STEPS[1]`: `s.snippets` 정규화 — 비객체 필터 + `{...defaultSnippet(), ...sn}` 병합,
  없으면 `base.snippets` (templates 처리와 동일 구조).

## 변경 — `src/templates.js` (신규, store.js만 import — 순환 없음)
- `snippetValues(now = new Date())` — 치환자 테이블. 로컬 시각·ko-KR.
  키: `date`("2026년 5월 7일 목요일"), `time`("09:30", 24h),
  `datetime`("<date> <time>"), `iso`("YYYY-MM-DD"), `year`/`month`/`day`.
- `insertSnippet(text, values?)` → 치환된 평문 문자열.
  `{name}` 패턴을 테이블에서 조회(키 대소문자 무시·공백 허용).
  values로 추가·재정의 가능(테스트 주입·사용자 정의). 미지 치환자는 원문 보존 —
  오타·미지원 키가 조용히 사라지는 것보다 안전. 반환값은 기존 에디터 경로
  (panel.js paste의 `execCommand("insertText")`)에 그대로 넣을 수 있는 평문.
- `applyTemplate(templateOrId, templates = state.templates)` → 새 인덱스
  content용 HTML 문자열. 객체 또는 id 조회, 실패 시 `""`.
  본문 치환자도 동일 규칙으로 치환 — "{iso} 회의록" 템플릿이 가능하고 builtin은
  치환자가 없어 그대로라 기존 동작과 충돌 없음(스펙 최소 요건의 보수적 상위집합).

## 변경 — `src/selftest.js` (신규 16케이스 → 61/61)
- migrate: `migrate-templates-normalize`(비객체 제거·필드 누락 기본값 병합),
  `migrate-snippets-normalize`(동일), `migrate-snippets-default`(v1 파일에 키 없으면
  builtin 채움).
- applyTemplate: `template-apply-html`(id 조회→HTML→가짜 인덱스 content 대입),
  `template-apply-object`(객체 입력·없는id·null·비객체·비배열 → ""),
  `template-apply-subst`(본문 {iso} → 실제 날짜),
  `template-builtin-apply`(migrate 결과의 tpl2를 바로 적용).
- insertSnippet: `snippet-date`(실제 ko-KR 날짜 치환), `snippet-values-map`
  (주입 시각 결정값), `snippet-values-override`, `snippet-unknown-kept`
  (미지 키 보존), `snippet-repeat`, `snippet-nontext`, `snippet-custom-value`,
  `snippet-builtin`.
- `snippet-insert-position`: 에디터 커서 자리에 execCommand("insertText")로
  넣어 `[{iso}] `가 실제 날짜로 삽입되는지 단언 — 기존 삽입 경로 호환 증거.
- 전부 메모리 내 가짜 state/목록 — 실사용자 store의 templates/snippets 무접촉
  (mv는 기존 V1_STORE migrate 결과 재사용).

## 검증 (직접 실행)
- `npm run build` PASS / `cargo fmt --check` PASS / `cargo clippy -D warnings` PASS
- `cargo test` — **32/32 PASS** (Rust 변경 없음 — 기준선 유지)
- `run-e2e.ps1` — **E2E PASS**, selftest **61/61** (기존 45 + 신규 16)
  - 증거: .devil/loop/qa-logs/guseok-qa-20261118-192825.log
  - store 스냅샷 복원·프로세스 정리 확인(guseok-memo 0, :5183 LISTEN 없음)

## 남은 문제·결정 근거
- UI 진입점 없음 — phase-05-task-04에서 templates[]/snippets[] 목록을 읽어
  applyTemplate/insertSnippet을 호출하는 구조로 이어진다.
- applyTemplate의 치환자 처리는 스펙 최소 요건(본문 그대로)을 넘는 선택 — builtin
  템플릿에 치환자가 없어 실동작 차이는 없고, 사용자 템플릿의 "{iso} 회의" 같은
  용례를 지원한다. 리터럴 `{date}`를 원하는 템플릿은 values 미지원이라 치환됨 —
  극단적 사례로 수용(attempt 기록).
- 스니펫 text는 평문 전용 — HTML 스니펫은 insertText 경로가 이스케이프하므로
  지원하지 않는다(UI 태스크에서 pasteHTML 경로가 필요해지면 별도 결정).
- 커밋 대상: src/store.js, src/templates.js, src/selftest.js, .devil 증거.
  조정자 파일(plan_setup/tasks/*) 제외.
