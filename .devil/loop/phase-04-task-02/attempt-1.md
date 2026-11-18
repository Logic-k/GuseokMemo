# phase-04-task-02 — attempt 1

## 목표
외부 프로세스(동기 클라이언트·다른 PC)가 바꾼 store.json을 앱이 자동 리로드
(R-05 비충돌 경로, TD-04 mtime 폴링). 충돌 분기는 task-03/OQ-03 — 미구현.

## 변경 — `src-tauri/src/main.rs` (제품 코드 유일)

### 감지 방식 — mtime 폴링 2초 (TD-04)
- `STORE_WATCH_INTERVAL = 2s`, detached 스레드(리마인더 스케줄러와 같은 패턴).
  매 틱 `store_path()`를 **재해석**하므로 set_data_dir 전환도 자동 추적 —
  `watch_tick`이 경로 변경을 감지하면 조용히 재기준(emit 없음, 이전은 이미 복사 완료).
- `FileStamp { modified: SystemTime, len: u64 }` — mtime + 길이.
  len 보조 이유: FAT(2초)·일부 네트워크 드라이브 mtime 해상도가 같은 시각의
  다른 쓰기를 못 가르는 경우 흡수. (같은 mtime+len의 다른 내용은 미감지 — 해시 비용으로 채택 안 함)

### 자기 에코 억제 — "우리가 마지막으로 쓴/읽은 스탬프" 추적
- `WatchState { path, stamp }` in `STORE_WATCH: OnceLock<Mutex<..>>`.
- `save_store`: rename 성공 직후 **실제 파일의 스탬프를 다시 읽어** `note_store_stamp`에 기록.
  tmp→rename이라 벽시계 추측 불필요 — 기록된 실제 스탬프와 관찰값만 비교.
- 부팅: `store_path` 해석 후 현재 스탬프로 기준 설정(로드한 그 상태가 "우리가 아는" 상태).
- `load_store`는 기록하지 않음 — 다른 창에도 반영돼야 하므로 읽기가 감지를 억제하면 안 됨.

### 판정 — 순수 함수 (테스트 대상)
- `watch_decision(tracked, current)`: 동일→Quiet(자기 에코), 다른 존재→Reload,
  존재→부재→Gone(삭제는 리로드 아님 — 빈 내용 덮어쓰기 방지, 재생성은 다음 틱이 잡음).
- `watch_tick(state, path, cur)` → (decision, 이전 스탬프): 경로 전환 재기준·추적값 전진 포함.
- Reload 판정 후 `fs::read_to_string` **실패 시 스탬프를 되돌려 다음 틱 재시도**
  (점유 중 반쯤 쓰인 파일; 연속 실패 로그는 첫 건만 기록해 무한 증식 방지).
  빈 파일·JSON 무효는 스탬프 전진 유지 + emit 없음(후속 완성 쓰기는 스탬프가 달라 재감지).

### emit 페이로드
- `app.emit("guseok://store", json!({"src":"external","raw":<파일 내용>}).to_string())`
  — save_store와 같은 String 페이로드 관례 (JS `JSON.parse(event.payload)` 계약).
  전 창 브로드캐스트 → 기존 리스너가 `src !== 창라벨`이라 자기 에코 필터를 자연 통과.

## 변경 — `src/selftest.js`
- 신규 3케이스 (45/45):
  - `external-reload`: `write_text_file`로 실제 store.json을 직접 덮어써(외부 쓰기 흉내)
    폴링 감지 → emit → migrate 반영 + qa_log `store-watch :: reload` 라인 단언.
  - `external-ime-focus`: 에디터 포커스 + compositionstart 중 리로드 → 외부 내용으로
    DOM 강제 교체·포커스 이탈 없음 단언(NFR-02 — 기존 externalHandler의 wasFocused 되심기 경로).
  - `external-self-echo`: save() 직후 한 주기+α(2.6s) 동안 reload 라인 수 불변 단언.

## 변경 없음 — `src/store.js`, `src/panel.js`, `src/handles.js`, `src/settings.js`
- src:"external"은 모든 창 라벨과 달라 기존 리스너가 migrate() 경유로 자연 처리
  (확인만, 코드 수정 0). panel externalHandler의 포커스 보호·DOM 되심기가 NFR-02 커버.

## 검증 (직접 실행)
- `npm run build` PASS / `cargo fmt --check` PASS / `cargo clippy -D warnings` PASS
- `cargo test` — **32/32 PASS** (기존 25 + 신규 7):
  `watch_decision`(자기에코 Quiet·mtime/len 변경 Reload·부재→생성 Reload·삭제 Gone),
  `watch_tick`(첫 틱/경로 전환 재기준·Gone→재생성·Reload 후 전진),
  `file_stamp` 실 FS(부재 None·len·디렉터리 None).
- `run-e2e.ps1 -Cdp "cdp-external-reload.cjs"` — **E2E PASS**
  - selftest **45/45** (외부 리로드 실제 파일 경로 + IME/포커스 보존 + 자기에코 억제).
  - CDP **5/5**: 외부 수정→반영 **실측 1.2s** (detect→emit→handles 적용),
    되돌림 왕복 **2.1s**, qa_log reload 라인 단언.

## 실측 지연
- 폴링 주기 2s — 외부 쓰기→전 창 반영 0.6~1.5s 실측(수동 314ms·e2e 1206ms·1537ms,
  틱 위상에 따름). 복구(원본 되쓰기)도 동일 경로로 ~2s 왕복.

## 남은 문제·결정 근거
- run-e2e CDP가 처음 2회 `ext-detected` 타임아웃 — 원인은 스크립트 시작이 selftest의
  SUMMARY 직후 복원 저장(`store-restore`)과 겹쳐 "대기 중인 자기 저장 vs 외부 쓰기"
  충돌이 된 것(비충돌 범위 밖 = task-03/OQ-03). 스크립트에 파일 안정화 대기
  (`ext-file-stable`)를 추가해 비충돌 조건에서 측정 — 이후 5/5.
- 삭제(Gone)는 반영하지 않고 추적만 리셋 — 빈 state 덮어쓰기 방지(보수적 선택).
- 같은 mtime+len의 내용만 다른 극단은 미감지(해시 미채택 — FileStamp 주석에 명시).
- 커밋 대상: src-tauri/src/main.rs, src/selftest.js, .devil 증거.
  plan_setup/cdp-external-reload.cjs는 gitignore 로컬 자산. 조정자 파일(tasks/*) 제외.
