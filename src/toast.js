// toast.js — 앱 내 토스트 창 렌더러 (D-2, OQ-02 확정 = 앱 내 토스트 단일).
//
// 이 창은 setup에서 미리 만들어지고(index.html?toast=1), handles.js가 소유한
// 발화 큐의 투영일 뿐이다 — 큐·타이머·위치 계산·발화 기록(lastFiredAt)은 전부
// handles 쪽 책임. 여기서는 받은 목록을 그리고 사용자 행동만 handles로 되돌린다:
//   본문 클릭 → guseok://toast-open   (해당 메모 패널 열기 + 그 토스트 제거)
//   × 클릭    → guseok://toast-dismiss
//   Esc      → guseok://toast-clear   (전부 닫기)
// 창은 focused(false)로 만들어져 클릭 직후처럼 포커스를 얻은 상태에서만 Esc가
// 도달한다 — × 버튼이 포커스 무관하게 동작하는 주 닫기 경로다.
import { emitTo, listen } from "@tauri-apps/api/event";
import { state, initStore } from "./store.js";
import { applyDarkMode, bindDarkMode } from "./darkmode.js";

const host = document.getElementById("toastHost");

function fmtTime(iso) {
  const m = /[T ](\d{2}):(\d{2})/.exec(iso || "");
  return m ? `${m[1]}:${m[2]}` : "";
}

function render(items) {
  host.innerHTML = "";
  (items || []).forEach((it) => {
    const el = document.createElement("div");
    el.className = "rem-toast" + (it.missed ? " missed" : "") + (it.kind === "conflict" ? " conflict" : "");

    const body = document.createElement("button");
    body.className = "rem-toast-body";
    body.type = "button";

    const title = document.createElement("div");
    title.className = "rem-toast-title";
    if (it.kind === "conflict") {
      // OQ-03 충돌본 보관 — 외부 변경이 적용됐고 편집 중이던 로컬본이
      // store.conflict-*.json에 보관됐음을 알린다. 클릭은 해당 메모를 연다.
      title.textContent = `${it.title || "메모"} — 외부 변경 적용`;
      const badge = document.createElement("span");
      badge.className = "rem-badge-miss conflict";
      badge.textContent = "충돌본 보관";
      title.appendChild(badge);
    } else {
      title.textContent = `${it.title || "메모"} — ${fmtTime(it.at)} 알림`;
      if (it.missed) {
        const badge = document.createElement("span");
        badge.className = "rem-badge-miss";
        badge.textContent = "놓침";
        title.appendChild(badge);
      }
    }
    body.appendChild(title);

    if (it.note) {
      const note = document.createElement("div");
      note.className = "rem-toast-note";
      note.textContent = it.note;
      body.appendChild(note);
    }

    body.addEventListener("click", () => {
      emitTo("handles", "guseok://toast-open", { indexId: it.indexId, reminderId: it.reminderId }).catch(() => {});
    });

    const x = document.createElement("button");
    x.className = "rem-toast-x";
    x.type = "button";
    x.textContent = "×";
    x.title = "닫기";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      emitTo("handles", "guseok://toast-dismiss", { reminderId: it.reminderId }).catch(() => {});
    });

    el.append(body, x);
    host.appendChild(el);
  });
}

async function boot() {
  // R-08 — 다크모드 적용을 위해 store를 읽고 guseok://store 변경을 구독한다.
  // 이 창은 저장하지 않으므로 브로드캐스트는 수신 전용이다.
  await initStore(async () => applyDarkMode(state.common.darkMode));
  bindDarkMode(() => state.common.darkMode); // 초기 적용 + system 모드 OS 추적
  await listen("guseok://toast-state", (e) => render(e.payload?.items || []));
  // 준비 통지 — 최초 상태 emit을 놓친 경우 handles가 큐를 다시 쏴준다.
  emitTo("handles", "guseok://toast-ready", {}).catch(() => {});
}

document.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Escape") {
    e.preventDefault();
    emitTo("handles", "guseok://toast-clear", {}).catch(() => {});
  }
});

boot();
