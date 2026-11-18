# 리서치 교차 검증 — round 1 (2026-11-18)

대상: research/raw/q01..q04.md (경쟁, Tauri 함정, 기능 트렌드, 테스트 하네스)

## 모순·충돌 점검

- **contentEditable vs textarea** (q02): WebView2 IME 결함 때문에 "textarea 유지 권장"이나,
  우리 에디터는 리치텍스트라 contentEditable 유지가 전제. q02의 권고는 단순 텍스트 필드에 한정해 적용.
  이미 해결한 IME 버그(BUG-09/10)와 방향이 일치 — 조합 중 DOM/속성 변경 금지 원칙 재확인.
- **저장 방식** (q02): 원자적 교체는 last-writer-wins → 단일 라이터/SQLite 검토 권고.
  현재 JS가 260ms 디바운스 + Rust 브로드캐스트(src 라벨 에코 필터)로 사실상 직렬화되어 있음.
  SQLite 전환은 실익 낮음 — 유지 + rename 재시도 보강으로 축소.
- **동기화** (q01/q03): q01은 "클라우드 없음"을 경쟁 차이로, q03은 "파일시스템 동기 지원"을
  로컬-퍼스트 유지 해법으로 제시. 모순 아님 — 계정/서버 없이 폴더 지정+자동 리로드면
  OneDrive/Syncthing에 편입 가능(로컬-퍼스트 원칙 보존). 채택.
- **검색** (q01/q03): 두 조사가 독립적으로 "전체 검색/관리 창"을 최우선 공백으로 지목 → 신뢰도 상승.
- **리마인더**: q01(Stickies 알람) + q03(리마인더 불만 반복, 반복 리마인더 희소) 일치 → 채택.

## 빠진 관점·미검증

- 실제 Windows IME 손 타이핑은 CDP imeSetComposition으로 대체 검증된 상태(LOG의 미검증 항목) — 수동 확인 필요.
- 멀티모니터 "자동" 해석 실기 확인 — 미검증 잔존.
- q04의 Windows hosted runner GUI 테스트는 가능하나 트레이/UIA 상호작용은 불안정 — selftest+CDP 조합 유지.

## 결론

종합 보고서: research/guseok-memo-roadmap.md
