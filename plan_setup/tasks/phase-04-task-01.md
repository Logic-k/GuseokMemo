---
id: phase-04-task-01
status: completed
depends_on: [phase-01-task-02]
acceptance_criteria:
  - %APPDATA%\com.guseok.memo\config.json에 지정 폴더 경로가 보관되고 store_path()가 그것을 해석한다
  - get_data_dir이 {path, effectivePath, isDefault}를 반환한다
  - set_data_dir(path) 호출 시 쓰기 가능 확인→기존 store.json 복사→포인터 갱신 후 신규 경로가 사용된다
  - 미존재/쓰기 불가 경로는 Err를 반환하고 기존 경로·데이터가 유지된다(데이터 파괴 없음)
  - 재시작 후에도 지정 경로가 유지된다
verification: [lint, unit, e2e]
phase: "04"
---

# phase-04-task-01 — 저장 폴더 지정 (config.json 포인터)

## 목표
store.json 위치를 사용자가 바꿀 수 있는 포인터+명령을 만든다 (R-04, TD-05).

## 범위
- `src-tauri/src/main.rs`: `config.json` 읽기/쓰기, `store_path()`가 포인터 해석,
  `get_data_dir`/`set_data_dir` 커맨드 추가
- 이전: 지정 시 기존 store.json 복사→검증(읽기 확인) 후 전환 — 원본은 삭제하지 않고 보존
- `common.dataDir` 같은 UI용 표시값(필요시)은 store 아닌 config 포인터가 정본

## 관련
- R-04, TD-05(포인터 방식 — 레지스트리/환경변수 대안 비교는 TRD)
- 선행: phase-01-task-02(rename 재시도) — 경로 변경과 저장 파이프라인 결합
- 후속: phase-04-task-04(설정 UI), phase-04-task-02(리로드)

## 참고
- 설정 UI(폴더 선택 대화상자·현재 경로 표시)는 별도 blocked 태스크 — 여기선 IPC·동작만.
- 폴더 선택은 기존 tauri-plugin-dialog의 open(directory) 재사용.
