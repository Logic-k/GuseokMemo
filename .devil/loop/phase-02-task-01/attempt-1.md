# phase-02-task-01 — attempt 1

## 변경
- `src/search.js` (신규): 검색 코어 — UI 없음.
  - `extractText(html)`: DOMParser 파싱 → `input,img,script,style,textarea,select,button` 제거 →
    블록 태그(P/DIV/LI/H1-H6/UL/OL/BLOCKQUOTE/PRE/TABLE/TR/BR/HR) 경계를 공백으로 두고
    텍스트 노드를 수집, `\s+` → 단일 공백 정리 후 trim. ck-text/li/h1~h3/p/div 텍스트 포함,
    `.ck input`·img 제외.
  - `search(state, query)` → `[{indexId, title, snippet, matches, titleMatch}]`.
    - 제목+본문(extractText 결과) 대상, `toLowerCase()` 대소문자 무시, 순차 매칭(TD-06).
    - 빈/공백 쿼리 → `[]`. 매칭 0건 인덱스는 결과에서 제외. `hidden:true` 인덱스 제외(R-07).
    - `matches` = 제목 매칭 수 + 본문 매칭 수(비중복 등장 횟수). `titleMatch` = 제목 매칭 유무.
    - `snippet` = 본문 첫 매칭 ±40자(`SNIPPET_RADIUS`) 문맥, 잘린 쪽 `…` 표시.
      제목만 매칭 시 제목 문맥 발췌. images[]는 대상 아님.
- `src/selftest.js`: `search.js` import + 케이스 10개 추가(기존 check() 패턴, 메모리 가짜 state —
  실사용자 store 무관):
  search-extract-ck, search-extract-tags, search-title-match, search-body-match(마크다운 변환
  결과 HTML 사용), search-case-insensitive, search-empty-query, search-no-match,
  search-hidden-excluded(hidden + images[] 비대상 동시 단언 — "우유"가 hidden 본문과
  images.src에 각각 있지만 결과는 보이는 s1 하나), search-snippet-context(±40자 … 표시),
  search-match-count(제목1+본문2=3).

## 검증
- `npm run build` — PASS (vite build, 104ms)
- `cargo fmt --check` — PASS
- `cargo clippy --all-targets -- -D warnings` — PASS (0 warnings)
- `cargo test` — PASS 6/6 (rename_retry 기존 유지)
- `powershell -File harness_setup/scripts/run-e2e.ps1` — **E2E: PASS, SUMMARY 39/39** (기존 29 + 신규 10).
  45s 무출력으로 cdp-nudge 1회 발동(기존 문서화된 흔들림 — toggle emit 유실), 이후 정상 완료.
  증거 로그: `.devil/loop/qa-logs/guseok-qa-20261118-174202.log`. store 스냅샷 복원 완료.

## 남은 위험/결정
- snippet 반경 40자는 임의 확정(태스크가 "길이 기준 구현 시 확정" 허용 — ~40자 내외 명세 충족).
- 유니코드 정규화(NFC/NFD)·중복 매칭 정렬 가중치는 미적용 — 인덱스 ≤10개 규모에서 순차+순서 유지로 충분.
- `titleMatch` 필드는 수용 기준의 "제목 매칭도 표시"를 위해 추가(명세 외 필드, UI 소비 시 사용).
- 실행 중 발생한 nudge는 제품 결함이 아닌 기존 알려진 부팅 레이스(harness e2e.md 문서화) — 변경 없음.
