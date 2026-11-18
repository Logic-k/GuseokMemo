---
id: phase-04-task-04
status: completed
depends_on: [phase-04-task-01]
acceptance_criteria:
  - 설정에서 저장 폴더를 대화상자로 선택·해제할 수 있다
  - 현재 실효 저장 경로가 표시된다(get_data_dir)
  - 쓰기 불가/미존재 선택 시 오류 메시지가 보이고 기존 경로가 유지된다
  - UI가 DESIGN 승인 방향과 일치한다
verification: [lint, e2e, task_validation]
phase: "04"
---

# phase-04-task-04 — 동기 설정 UI

## 목표
저장 폴더 지정·현재 경로 표시를 설정 창에 노출한다 (R-04 UI).

## 차단 사유
- **blocked — DESIGN 미승인**: 설정 화면의 새 섹션/행은 `docs/DESIGN.md` 승인 대상.
- 해제 조건: DESIGN 승인 범위에 포함 → pending 전환.

## 범위 (승인 후)
- `src/settings.js`: 폴더 선택(tauri-plugin-dialog open directory) + `set_data_dir` 호출 +
  현재 경로·오류 표시
- 외부 리로드 상태 표시가 필요하면 DESIGN 범위에 포함

## 관련
- R-04 — 선행: phase-04-task-01(IPC·동작)
