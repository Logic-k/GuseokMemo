---
topic: 구석메모 다음 개발 사이클 기술 결정
updated: 2026-11-18
status: draft — 일부 잠정(TD-09/10), OQ 의존 표시
inputs: docs/PRD.md, research/guseok-memo-roadmap.md, research/raw/q01..q04.md
---

# TRD — 구석메모 다음 개발 사이클 기술 결정

스택은 기존 유지가 전제: **Tauri 2 (Rust) + WebView2 + Vanilla JS + Vite**.
아래는 이번 사이클에서 갈리는 실제 선택만 다룬다. 데이터/API 계약 상세는
`docs/ARCHITECTURE/overview.md`, 순서·태스크는 `plan_setup/PLAN.md`.

## 결정 요약

| ID | 결정 | 상태 |
|---|---|---|
| TD-01 | 저장: 단일 JSON + 원자적 교체 유지 (SQLite 보류) | 확정 |
| TD-02 | rename 점유 실패 재시도 추가 | 확정 |
| TD-03 | 스키마 버전: 기존 `version` 키 사용 + migrate 연쇄 | 확정 |
| TD-04 | 외부 변경 감지: Rust mtime 폴링 (notify 보류) | 확정 |
| TD-05 | 폴더 지정: 기본 dir의 `config.json` 포인터 방식 | 확정 |
| TD-06 | 검색: 인메모리 순차 텍스트 검색 (FTS 불필요) | 확정 |
| TD-07 | 리마인더: Rust 상주 스케줄러 (JS 타이머 기각) | 확정 |
| TD-08 | 에디터: contentEditable 유지 + IME 원칙 | 확정 |
| TD-09 | `noRedirectionBitmap` 적용 검토 | 잠정 — 실기 검증 필요 |
| TD-10 | updater `allowDowngrades` 설정 검토 | 잠정 — 정책 결정 필요 |
| TD-11 | `rust-version` → "1.90" 갱신 | 확정 |
| TD-12 | 테스트: selftest + CDP 유지 (wdio/Playwright 이관 보류) | 확정 |
| TD-13 | 게이트 순서: npm build → fmt → clippy → test → selftest+CDP | 확정 |

---

## TD-01 저장: 단일 JSON 파일 + 원자적 교체 유지

- **선택**: `store.json` 단일 파일, 임시 파일 기록→rename 원자적 교체, `.bak` 유지 — 현행 유지.
- **근거**: q02 §4.1 — JSON 한 파일 ≲1MB·키 수십 개면 자체 JSON이 정답. 구석메모는 인덱스
  최대 10개·메모 본문 HTML이라 SQLite의 인덱스/쿼리/부분 갱신 실익이 없다.
  last-writer-wins 약점은 이미 JS 260ms 디바운스 + Rust `save_store` 브로드캐스트
  (src 라벨 에코 필터)로 사실상 직렬화돼 있다(review/round-1).
- **대안**: `tauri-plugin-sql`(SQLite) — 마이그레이션 불변성·의존성·런타임 복잡도 증가 대비
  실익 없어 **보류**. 전환 재검토 시점: 인덱스 수십~수백 개 + 전문 검색(FTS)이 요구될 때.
  `tauri-plugin-store` — 자체 원자적 저장이 이미 더 안전(플러그인의 window-state는
  비원자적 `fs::write`). 불채택.
- **되돌리기 비용**: 큼(저장 포맷·복원 경로 전면 교체) — 이번에 유지로 확정.
- **검증**: selftest `store-write`/`store-restore` 통과 유지 + R-05 리로드 회귀.

## TD-02 rename 점유 실패 재시도

- **선택**: `fs::rename(tmp, store.json)` 실패 시 짧은 백오프로 재시도(예: 50ms×N회, 구현 시
  횟수·간격 확정 — 관찰 가능 범위는 "점유 해제 후 성공").
- **근거**: q02 §4.2 — Windows는 대상 파일이 백신/인덱서/**동기 클라이언트**(R-04/R-05로
  실제 노출 증가)에 열려 있으면 rename이 대기 없이 실패한다. 폴더 동기를 지원하면 이 경로가
  상시 발생하므로 사이클 선행 보강.
- **대안**: safe-write 크레이트 — 재시도+fsync 내장이나 단일 함수용 의존성 추가. 자체
  재시도 루프로 충분. Windows 디렉터리 fsync 한계는 그대로 존재(문서화).
- **검증**: 저장 경로를 점유한 상태에서 저장 → 재시도 로그·최종 성공 관찰(수동/CDP),
  selftest 기존 통과.

## TD-03 스키마 버전: 기존 `version` 키 + migrate 연쇄

- **선택**: 이미 존재하는 `version`(현재 1)을 스키마 버전으로 사용해 2로 올리고,
  `migrate()`를 버전별 단계 변환 연쇄(v1→v2→…)로 구조화. 신규 필드는 default 채움.
- **근거**: q04 §E-2 — 사실상 표준은 `__version` 키 + 로드 시 마이그레이션.
  **리서치와 다른 점**: 종합본은 `__version` 신설을 권하나, store에 이미 `version` 키가
  존재하므로 중복 키를 만들지 않고 그것을 쓴다 — 리서치 의도(버전 명시+단계 마이그레이션)는
  동일하게 충족.
- **회귀 수단**: q04 §E-3 — 구버전 fixture JSON을 저장소에 두고 migrate 결과를 단언하는
  fixture 테스트 + selftest에 "구버전 store → 정규화" 케이스 추가.
- **검증**: v1 fixture → migrate → v2 스키마 일치 단언, 기존 백업 복원 경로(settings.js
  `migrate(parsed)`) 그대로 통과.

## TD-04 외부 변경 감지: Rust mtime 폴링

- **선택**: Rust 측 주기적(수 초) 폴링으로 store.json mtime을 감시, 변경 감지 시 파일을
  읽어 `guseok://store`(src:"external")로 브로드캐스트 → 기존 JS `migrate()`+전파 경로 재사용.
- **근거**: q03 — 자동 리로드는 linuxmint/sticky 최다 요청. 구석메모는 이미 "다른 창 저장 →
  전 창 반영" 경로가 있어, 외부 원본만 같은 이벤트로 실어 보내면 JS 측 신규 경로가 거의
  없다.
- **대안**: `notify` 크레이트 — 정확·저지연이나 의존성+플랫폼 이벤트 편차 추가. 동기
  클라이언트 반영에 수 초 지연은 허용되므로 폴링 채택. 반응 속도가 문제되면 재검토.
- **주의**: 자기 저장(save_store) 직후 mtime 변화는 외부 변경으로 오인하면 안 됨 —
  "우리가 마지막으로 쓴/읽은 mtime"과 비교해 자기 에코 억제. 충돌(앱 미저장 편집 vs 외부
  변경) 해결 정책은 **OQ-03(미정)** — 감지·리로드 파이프라인만 확정.
- **검증**: 실행 중 외부 편집기로 store.json 저장 → 수 초 내 창 반영 CDP 관찰;
  자기 저장은 재로드 루프를 만들지 않음 확인.

## TD-05 저장 폴더 지정: `config.json` 포인터 방식

- **선택**: 고정 위치(`%APPDATA%\com.guseok.memo\config.json`)에 지정 폴더 경로만 보관하고,
  `store_path()`가 그 포인터를 먼저 읽어 실제 store.json 경로를 해석한다.
- **근거**: 포인터를 store.json 안에 두면 "폴더를 바꾼 사실"이 옮겨간 파일에만 있어
  부팅 시 위치를 알 수 없다(치킨앤에그). 고정 위치 포인터가 가장 단순.
- **대안**: 레지스트리(HKCU) — autostart와 같은 계열이나, 폴더 옮김/포터블 맥락에서
  파일 포인터가 더 투명·이식성 높음. 환경변수 — 설정 UI와 불일치.
- **이전 정책**: 지정 시 기존 store.json을 새 폴더로 복사→검증 후 전환(원본은 `.bak`/
  원위치 보존 — 삭제하지 않음, 데이터 파괴 금지 합의).
- **검증**: 폴더 지정→재시작→신규 경로 사용 확인; 미존재/쓰기 불가 경로는 오류 표시+
  기존 경로 유지.

## TD-06 검색: 인메모리 순차 텍스트 검색

- **선택**: `state.indexes`의 제목+본문 HTML→텍스트 추출 후 순차 매칭(JS).
- **근거**: 인덱스 최대 10개·본문 수 KB — 후보가 최대 10건이라 FTS·인덱싱이 과잉.
  q03도 "순차 검색+하이라이트면 충분"(S~M).
- **대안**: SQLite FTS(=TD-01 전환 전제), MiniSearch 같은 JS 라이브러리 — 의존성·번들 증가
  대비 실익 없음. 불채택.
- **검증**: selftest/CDP로 "키워드→매칭 인덱스 목록·스니펫·없음 처리" 단언.

## TD-07 리마인더: Rust 상주 스케줄러

- **선택**: Rust 메인 프로세스의 백그라운드 스레드가 리마인더 데이터를 주기 체크하고,
  발화 시 `guseok://reminder` 이벤트를 전 창에 emit. 예약 데이터는 store.json 안
  (indexes[].reminders[]). `save_store`가 저장된 JSON을 파싱해 스케줄러 인메모리 상태를
  갱신, 부팅 시 load에서 초기화.
- **근거**: 트레이 상주 앱이라 메인 프로세스가 상시 생존 — JS setTimeout은 창 숨김/타이머
  스로틀/페이지 언로드에 취약해 신뢰할 수 없다. 알림 데이터 자체는 store 일부라 별도
  DB 불필요.
- **대안**: JS 측 타이머(간단하나 창이 꺼지면 죽음) — 기각. OS 스케줄러/토스트 스케줄 —
  앱 외 수명이 필요 없어 과잉.
- **미정 결합**: 알림 전달(토스트/패널 강조/소리)은 **OQ-02(미정)** — 스케줄러·발화 이벤트는
  방식과 무관하게 확정 가능.
- **검증**: 1분 후 리마인더 → 발화 이벤트 관찰, 재시작 후 미래 리마인더 발화, 과거분
  놓침 표시.

## TD-08 에디터: contentEditable 유지 + IME 원칙

- **선택**: 본문 에디터는 contentEditable 유지. 모든 신규 기능(검색·리로드 반영)에
  "조합 중 DOM/속성 변경 금지" 원칙 적용.
- **근거**: q02는 WebView2 CJK 결함으로 textarea를 권하나, 리치텍스트(체크리스트·이미지·
  자동마크다운)가 요구라 textarea 전환 불가 — review/round-1에서 "q02 권고는 단순 텍스트
  필드에 한정"으로 정리. 이미 BUG-09/10으로 자기 에코·조합 중 DOM 변경을 차단해 검증됨.
- **검증**: CDP `imeSetComposition` 시나리오(cdp-ime-*.cjs) + selftest ime-* 케이스 유지,
  실기 손 타이핑(OQ-05).

## TD-09 `noRedirectionBitmap` 적용 검토 — 잠정

- **후보**: tauri ≥2.12의 `noRedirectionBitmap`(WS_EX_NOREDIRECTIONBITMAP)을 투명 창
  (handles/panel)에 적용.
- **근거**: q02 §1.1 — 투명 창 생성 시 흰 플래시 방지 + DWM BlurBehind 해킹 경로 우회로
  Win10 투명+AOT의 DWM 합성 경합 완화 기대.
- **잠정 이유**: 실기(특히 Windows 10)에서의 렌더 회귀 가능성이 문서 확인만으로는 판정
  불가 — **검증 필요**. 적용 후 흰 플래시·검은 영역·드래그 동작을 실기 관찰하고, 문제 있으면
  롤백(설정 한 줄).
- **검증**: 적용 전후 흰 플래시·투명 렌더·스냅 드래그 실기 확인 기록(phase-06-task-01).

## TD-10 updater `allowDowngrades` 설정 검토 — 잠정

- **후보**: `plugins.updater.allowDowngrades: true`(2.12.0부터 플러그인 설정으로 이동)로
  롤백 배포 경로 확보.
- **근거**: q02 §2.3 — 업데이트로 회귀가 나갔을 때 latest.json을 이전 버전으로 되돌리는
  핫픽스 경로. 기본 false라 지금은 불가.
- **잠정 이유**: ①다운그레이드 시 **store 스키마 역방향 호환** — v2 필드를 구버전 앱이 읽을 때
  migrate(구버전)가 신규 필드를 파괴하지 않는지(현재 merge 방식은 보존적이나 검증 필요).
  ②롤백을 실제 운용할지는 배포 정책 결정 — 사용자 정책 성격. 미정으로 두되 문서에
  "스키마 다운그레이드 주의"를 연결(phase-06-task-02).
- **검증**: 적용 시 구버전 설치본→신버전 store→다운그레이드 흐름을 문서 절차로 정리
  (실 다운그레이드 배포는 사용자 승인 대상).

## TD-11 `rust-version` → "1.90" 갱신

- **선택**: `Cargo.toml`의 `rust-version = "1.77"`을 `"1.90"`으로 갱신.
- **근거**: q02 §3 — tauri 본체·updater 플러그인 MSRV가 Rust ≥1.90(2.13.0 시점). 현 표기는
  실제 요구와 불일치해 오래된 툴체인에서 빌드 실패 원인이 된다.
- **검증**: `cargo build`/`clippy`가 갱신된 rust-version과 일치한 툴체인에서 통과.

## TD-12 테스트: selftest + CDP 스크립트 유지

- **선택**: 기존 `--selftest`(→`%TEMP%\guseok-qa.log`) + `plan_setup/cdp-*.cjs` 조합 유지.
  신규 기능 회귀도 같은 하네스에 추가.
- **근거**: q04 §A-3 — 현재 CDP 방식이 Playwright 공식 문서의 WebView2 자동화
  (remote-debugging-port + connectOverCDP)와 동일 구조. hosted Windows runner의
  트레이/UIA 불안정성도 우리 하네스가 덜 타는 범위.
- **대안**: `@wdio/tauri-service` — 공식 권장이나 드라이버/버전 관리 부담이 현 규모 대비
  큼. Playwright test runner 이관 — fixture(포트 분리·user-data-dir 격리·정리) 이점은
  있으나 현 수작업이 동작 중이라 **보류**(CDP 스크립트가 늘어나면 재검토).
- **검증**: 기존 26/26 통과 유지 + 신규 케이스 추가분.

## TD-13 품질 게이트 순서

- **선택**(게이트 명령, Loop의 lint→unit→e2e→task_validation에 대응):
  1. `npm run build` — `tauri::generate_context!`가 컴파일 타임에 `frontendDist`(dist/)를
     평가하므로 Rust 게이트 전에 선행 필수(q04 §D-1).
  2. `cargo fmt -- --check` (lint)
  3. `cargo clippy --all-targets -- -D warnings` (lint)
  4. `cargo test` (unit — Rust 순수 로직)
  5. `npm run dev`(vite :5183) + debug exe `--selftest` → `guseok-qa.log` (e2e)
  6. `plan_setup/cdp-*.cjs` (e2e)
  7. task_validation — 비상속 별도 세션 독립 검증(Loop 단계).
- **근거**: q04 §D — 실제 Tauri CI 표준 순서 + generate_context! 전제.
- **주의**: debug exe는 devUrl(localhost:5183)을 로드 — selftest 전 vite 필수(기존 LOG 참조).

## 미해소 의존

- TD-09/10은 잠정 — 실기 관찰/정책 결정 후 확정 갱신.
- OQ-02(알림 방식)는 TD-07의 전달부 구현을, OQ-03(충돌 정책)은 TD-04의 충돌 경로를 차단한다.
- OQ-01(릴리스 컷)은 TD와 무관하게 모든 TD를 진행 가능.
