# REA 적용 기록 (morluto/rea)

## 1. 무엇을 했나
- `morluto/rea` 저장소의 `reverse-engineer-anything` 스킬 문서를 읽고, 그 절차(증거 기반·정적/런타임 구분·한계 명시)를 따랐습니다.
- REA CLI 6.9.0 으로 **이 프로젝트의 릴리스 산출물(`dist/`)** 을 분석했습니다.
  - 대상은 Peekom의 유료 바이너리가 아니라, 우리가 직접 만든 코드입니다.
  - REA의 DISCLAIMER는 "proprietary software 복제, DRM/라이선스 우회"를 금지하므로, Peekom 바이너리는 분석하지 않았습니다.

## 2. 실행 명령
```powershell
# REA는 Node >= 22.23.4 필요 (시스템 Node 22.14 → npx node@22.23.4 로 실행)
npx -y node@22.23.4 --version
node <rea-agents>/scripts/rea.mjs analyze-javascript-application "D:\구석메모앱\dist" `
  --detail summary --evidence_output "D:\구석메모앱\docs\rea-evidence.json" --format json
```

## 3. 결과 (Evidence)
| 항목 | 값 |
|---|---|
| REA 버전 | 6.9.0 |
| authority | `shipped-artifact` |
| 분석 JS 파일 | 11개 (실패 0) |
| 관련 파일 | 13개 (index.html, settings.html 포함) |
| 읽은 텍스트 | 59,585 bytes |
| 방문 AST 노드 | 15,119 |
| findings | 117 |
| semantic relations | 10,155+ (call-flow 815, data-flow 7,385, closure 1,011 등) |
| Electron IPC | 0 (Tauri이므로 해당 없음) |
| native addon / preload / utility process | 0 |

원본 Evidence 번들: 24 MB (`docs/rea-evidence.json`) — 저장소 크기를 위해 요약 후 삭제.

## 4. 해석
- 릴리스 번들에 **개발용 파일이나 예상 밖 모듈이 섞이지 않았음**을 인벤토리로 확인했습니다.
  - `main`, `handles`, `panel`, `settings`, `store`, `themes`, `layout`, `selftest` 청크가 전부 우리 코드입니다.
- Electron 전용 추출기(ipcMain, preload, contextBridge)는 0으로 나옵니다.
  - 이는 결함이 아니라 **Tauri 앱이라 Electron 경계가 없기 때문**입니다.
  - Tauri `invoke()` 호출은 `window.__TAURI_INTERNALS__` 를 거치므로 REA의 Electron IPC 모델에 잡히지 않습니다.
  - 따라서 IPC 표면은 `src-tauri/src/main.rs` 의 `#[tauri::command]` 목록으로 별도 확인했습니다(load_store, save_store, set_autostart, show_panel, place_handles, work_area, register_shortcuts 등).
- 정적 분석은 코드를 실행하지 않으므로, 동작 검증은 앱 내 셀프테스트와 실제 실행 캡처로 보완했습니다.

## 5. 한계 (REA가 명시한 것)
- 그래프 커버리지는 partial이며, 없는 사실을 "없음"으로 읽으면 안 됩니다.
- 번들 부트스트랩 코드는 실행되지 않았습니다.
- 동적 속성/난독화된 경로는 unknown으로 남습니다.
- alias 선택 예산(512)에 도달해 일부 별칭 관계는 미해석입니다.

## 6. 결론
REA는 **"우리가 만든 산출물이 의도한 구성과 일치하는지" 검증하는 용도**로 사용했습니다.
Peekom 기능 재현은 공개 문서/스크린샷 기반의 클린룸 재구현이며, 원본 코드·에셋을 복제하지 않았습니다.