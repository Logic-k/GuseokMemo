---
topic: 구석메모 아키텍처 — 현재 + 다음 사이클 목표
updated: 2026-11-18
status: draft — 잠정 구성요소 표시, OQ/CF 연결
inputs: docs/PRD.md, docs/TRD.md
---

# Architecture — 구석메모

## 1. 구성요소와 경계

```mermaid
flowchart TB
    subgraph OS[Windows]
        TRAY[트레이 아이콘]
        GS[전역 단축키]
        REG[HKCU Run 자동시작]
        MON[모니터/작업 영역 Win32]
    end

    subgraph RUST[Rust 코어 src-tauri/src — 단일 프로세스]
        CMD[windows.rs: 창 배치·전역 단축키]
        STOREIO[store_io.rs: store I/O · 원자적 교체 · 재시도 · mtime 감시 · 충돌본]
        SCHED[scheduler.rs: 리마인더 스케줄러]
        WIN32[win32.rs: 모니터/작업영역 Win32 · 자동시작]
        TRAYH[main.rs: 부팅·트레이·window_ready·qa_log]
    end

    subgraph WV[WebView2 창 — 모두 setup에서 생성, hide/show 재사용]
        H[handles — 40px 투명 스트립<br/>handles.js]
        P[panel — 메모 카드<br/>panel.js]
        S[settings — 설정<br/>settings.js]
        Q[search — 검색 · 신규(잠정)]
    end

    subgraph DISK[디스크]
        CFG[config.json — 폴더 지정 포인터 · 신규]
        ST[store.json — 원자적 교체]
        BAK[store.bak.json]
        EXT[외부 변경 — 동기 클라이언트/다른 PC]
    end

    TRAY --> TRAYH
    GS --> CMD
    MON --> WIN32
    REG --> WIN32
    CMD <--> WV
    WIN32 <--> WV
    STOREIO --> ST & BAK
    STOREIO --> CFG
    EXT -. mtime .-> STOREIO
    SCHED -. 발화 .-> WV
    H & P & S & Q <-->|guseok://store · panel-open · shortcut · open-tab · reminder| RUST
```

**경계 원칙**

- 창은 `setup`에서 전부 생성하고 닫기는 hide로 전환(BUG-18: 런타임 커맨드 내 webview
  생성 = 데드락). 신규 search 창도 동일 규칙(NFR-06).
- 저장은 JS 260ms 디바운스 → `save_store` → Rust가 원자적 교체 + `guseok://store`
  (src=저장한 창 라벨) 브로드캐스트 → 다른 창이 `migrate()` 후 반영. 자기 에코는 라벨로 억제.
- 외부 파일 변경도 같은 `guseok://store`(src:"external") 경로로 합류 — JS 측 신규 경로 최소화
  (TD-04).

## 2. 창 경계

| 창 | 라벨 | 책임 | 생성/수명 |
|---|---|---|---|
| handles | `handles` | 스트립 렌더·드래그·스냅·인덱스 추가/삭제·열기 토글·부팅 업데이트 확인 | setup 생성, 상주 |
| panel | `panel` | 리치텍스트 편집·이미지·체크리스트·빼꼼/얼음·내보내기·제목/투명도 | setup 생성, show/hide |
| settings | `settings` | 공통/인덱스 설정·백업/복원·자동시작·업데이트 수동 확인 | setup 생성, show/hide(재사용) |
| search | `search`(잠정) | 전체 검색 입력·결과 목록·점프 요청 — R-01 | setup 생성, show/hide — **형태(별도 창 vs 패널 내)는 DESIGN 결정** |

- **검색 UI 형태 잠정**: 별도 `search` 창을 권장안으로 둔다 — 검색은 전역 기능이라 인덱스
  컨텍스트인 panel과 분리가 자연스럽고, settings와 같은 생성·재사용 패턴을 따른다.
  패널 내 오버레이는 대안(창 추가 없음)으로 DESIGN 단계에서 확정(OQ 아닌 설계 결정).

## 3. 이벤트 계약

| 이벤트 | 발신 → 수신 | 페이로드 | 용도 |
|---|---|---|---|
| `guseok://store` | Rust(save_store/외부 감지) → 전 창 | `{src: 창라벨\|"external", raw: storeJSON}` | 상태 동기화. 자기 에코는 src 라벨로 억제 |
| `guseok://panel-open` | Rust(show_panel) → 전 창 | `{id}` | 인덱스 전환 통지 — panel이 내용 확정·렌더, handles 활성 표시 |
| `guseok://panel-closed` | Rust(hide_panel) → handles | `{}` | 활성 해제 |
| `guseok://shortcut` | 단축키 콜백/single-instance/트레이 → handles | `{action: toggle\|prev\|next\|index, n?}` | 열기/순환/직접 인덱스 |
| `guseok://open-tab` | Rust(open_settings_with) → settings | `{tab: "index"\|"common"}` | 설정 탭 지정 |
| `guseok://reminder` | Rust 스케줄러 → 전 창 — **신규** | `{indexId, reminderId, at, firedAt}` | 리마인더 발화 통지 — 전달 방식 OQ-02 |

## 4. IPC 커맨드

기존(15): `load_store` `save_store` `set_autostart` `read_text_file` `write_text_file`
`open_data_dir` `open_settings` `show_panel` `hide_panel` `place_handles` `work_area`
`monitors` `register_shortcuts` `qa_log` `quit_app`

신규(후보):

| 커맨드 | 인자 → 반환 | 책임 | 근거 |
|---|---|---|---|
| `get_data_dir` | `()` → `{path, effectivePath, isDefault}` | 포인터(config.json)와 실효 저장 경로 조회 | TD-05 |
| `set_data_dir` | `{path: string\|null}` → `()` | 저장 폴더 지정/해제 — 기존 store.json 이전(복사+검증), 쓰기 불가·미존재는 Err | R-04, TD-05 |
| (검색·리마인더 CRUD는 IPC 없음) | — | 검색은 JS 메모리 상태 대상, 리마인더는 store 필드라 `save_store`/`load_store`로 동기화 | TD-06/07 |

## 5. 데이터 계약 — store.json

현재(v1) + 다음 사이클 신규(v2). 마이그레이션은 `migrate()` 단계 연쇄(TD-03), 신규 필드는
기본값 채움으로 구버전 백업 복원 호환(NFR-04).

```jsonc
{
  "version": 2,                      // v1→v2: 신규 필드 채움(기존 키 재사용, TD-03)
  "common": {
    "monitor": "auto",               // 기존
    "side": "right",                 // 기존
    "mode": "mouse",                 // 기존
    "openKey": "ctrl_shift_m",       // 기존
    "peekDelay": 350,                // 기존
    "spellcheck": false,             // 기존
    "autostart": false,              // 기존
    "anchor": 0.42,                  // 기존
    "lastIndexId": "welcome1",       // 기존
    "darkMode": "system",            // 신규 — "light"|"dark"|"system" (R-08)
    "notifyMethod": "(미정)"          // 신규 — OQ-02 결정 후 채움: toast|panel|sound
  },
  "indexes": [{
    "id": "i…", "title": "…",        // 기존
    "theme": 0, "bg": "…", "fg": "…", "accent": "…",
    "fontSize": 18, "font": "system", "opacity": 100, "ratio": "3:4",
    "mode": "peek",                  // 기존
    "content": "<p>…</p>",           // 기존 HTML
    "images": [],                    // 기존
    "hidden": false,                 // 신규 — R-07 스트립 비표시
    "reminders": [{                  // 신규 — R-02/03
      "id": "r…",
      "at": "2026-11-19T09:00",      // 로컬 시각 ISO (반복이면 다음 발생 시각)
      "repeat": "none",              // "none"|"daily"|"weekly"
      "note": "",                    // 선택 메모
      "enabled": true,
      "lastFiredAt": null            // 놓침 판정·반복 진행용
    }]
  }],
  "templates": [{                    // 신규 — R-06 (공통 자산)
    "id": "t…", "name": "할일", "content": "<div class=\"ck\">…",
    "builtin": true
  }]
}
```

별도 파일: `%APPDATA%\com.guseok.memo\config.json` = `{ "dataDir": "D:\\…" | null }`
— store 위치 지정 포인터(TD-05). store.json과 분리(포인터는 고정 위치 유지).

스키마 주의: `hidden`/`reminders`/`templates`/`darkMode`/`notifyMethod` 추가는 v2.
구버전 앱이 v2 파일을 읽어도 알 수 없는 키를 보존하는 merge 방식을 유지해야
TD-10 다운그레이드 안전.

## 6. 신규 구성요소와 흐름

### 6.1 전체 검색 (R-01, TD-06)

```
진입점(전역키/트레이/버튼 — DESIGN) → search 창 show → JS가 state.indexes
  제목+본문 HTML→텍스트 추출 → 순차 매칭 → 결과 {indexId, title, snippet} 렌더
  → 결과 클릭 → handles의 open(id)과 동일 경로(layout 계산→show_panel)로 점프
```

- 검색은 메모리의 `state` 대상이라 디스크 읽기 없음. 리로드로 state가 갱신되면 결과도 갱신.
- 숨긴 인덱스(`hidden:true`)는 검색 대상 제외(R-07 정책 — 사용자 노출 면적과 일치).

### 6.2 리마인더 스케줄러 (R-02/03, TD-07)

```
save_store 시 Rust가 JSON 파싱 → indexes[].reminders[] 추출 → 인메모리 스케줄 갱신
부팅 시 load_store 경로로 초기화
스레드가 주기(수십 초) 체크 → at <= now && enabled → guseok://reminder emit
  → 반복이면 다음 at 계산 후 유지 / none이면 lastFiredAt 기록
재시작 시 at < now && !lastFiredAt → "놓침"으로 분류해 전달(자동 발화 아님)
```

- 전달: emit을 받은 창이 OQ-02 방식으로 알림 — 토스트(네이티브 알림 후보), 패널 강조
  (해당 인덱스 자동 오픈/핸들 펄스), 소리. **미정이므로 발화부만 확정, 전달부는 blocked**.

### 6.3 저장 폴더 지정 + 자동 리로드 (R-04/05, TD-04/05)

```
[지정] settings → set_data_dir(path) → Rust: 쓰기 가능 확인 → 기존 store.json 복사
  → config.json 갱신 → 이후 store_path()는 신규 경로 → guseok://store 전파
[리로드] Rust mtime 감시 루프 → 외부 변경 감지(자기 저장 mtime과 비교해 자기 에코 억제)
  → 파일 읽기 → guseok://store{src:"external", raw} → 각 창 migrate() 후 반영
[충돌] 앱에 미저장 편집 + 외부 변경 동시 → OQ-03 정책(미정) — 비충돌 경로만 구현 확정
```

- 실패·권한 지점: 지정 폴더 미존재/쓰기 불가 → set_data_dir Err → UI 오류 표시, 기존 경로 유지.
- 동기 클라이언트가 파일을 점유 → save rename 실패 → TD-02 재시도.

## 7. 충돌·잠정·미결

- **CF**: 검토한 계약 간 실제 충돌 0건 — 신규 필드는 merge 친화적, 기존 이벤트/IPC 경로 재사용.
- **잠정 설계**: search 창 형태(별도 창 권장·DESIGN 확정), 리마인더 전달부(OQ-02),
  충돌 해결 분기(OQ-03), `noRedirectionBitmap`(TD-09 잠정), `allowDowngrades`(TD-10 잠정).
- **미결 연결**: OQ-01(릴리스 컷)은 전체 위, OQ-05(실기 검증)는 NFR-02 최종 판정.

## 8. 관찰 기준 (구조 검증)

- 이벤트: CDP로 `guseok://store` 수신 후 handles 재렌더·panel 내용 반영 확인(기존
  cdp-index-isolation 계열 패턴 재사용).
- 신규: 외부 파일 수정→자동 반영 지연 측정, 리마인더 발화 이벤트 도달 확인,
  set_data_dir 후 load/save 경로 전환 확인.
- 회귀: selftest 26/26 + 신규 케이스, `%TEMP%\guseok-qa.log` PASS 라인.
