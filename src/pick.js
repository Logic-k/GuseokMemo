// pick.js — 템플릿 선택 창 렌더러 (R-06, DESIGN D-5).
//
// 이 창은 setup에서 미리 만들어지고(index.html?pick=1), handles.js가 place_pick
// 커맨드로 위치·표시를 지시한다. 여기서는 목록 렌더와 사용자 행동 통지만 담당한다:
//   항목 클릭 → guseok://pick-select { id }  (빈 메모는 id:"")
//   Esc      → guseok://pick-cancel
//   포커스 상실(외부 클릭) → guseok://pick-cancel
// 생성·열림·숨김 적용은 handles 쪽 책임 — toast 창과 같은 분리 패턴.
import { emitTo, listen } from "@tauri-apps/api/event";
import { state, initStore } from "./store.js";
import { applyDarkMode, bindDarkMode } from "./darkmode.js";

const listEl = document.getElementById("pickList");
let openedAt = 0;

// 목록 첫 항목은 항상 "빈 메모"(템플릿 미적용) — 이후 store의 templates[] 순서.
function items() {
  const tpls = Array.isArray(state.templates) ? state.templates : [];
  return [{ id: "", name: "빈 메모", content: "" }].concat(
    tpls.filter((t) => t && typeof t === "object")
  );
}

// 본문 HTML을 한 줄 미리보기 평문으로 — 목록에서 템플릿 구분용.
function previewText(html) {
  const s = String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > 22 ? s.slice(0, 22) + "…" : s;
}

function render() {
  listEl.innerHTML = "";
  for (const t of items()) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pick-item" + (t.id ? "" : " empty");
    b.dataset.id = t.id || "";

    const name = document.createElement("span");
    name.className = "pick-name";
    name.textContent = t.name || "템플릿";
    b.appendChild(name);

    const pv = previewText(t.content);
    if (pv) {
      const prev = document.createElement("span");
      prev.className = "pick-prev";
      prev.textContent = pv;
      b.appendChild(prev);
    }

    b.addEventListener("click", () => {
      emitTo("handles", "guseok://pick-select", { id: t.id || "" }).catch(() => {});
    });
    listEl.appendChild(b);
  }
}

function cancel() {
  emitTo("handles", "guseok://pick-cancel", {}).catch(() => {});
}

document.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Escape") {
    e.preventDefault();
    cancel();
  }
});

// 외부 클릭 = 창 포커스 상실 → 취소 닫기 (D-5). 표시 직후 포커스 안정화 시간은 유예
// (search-window.js와 같은 가드 — set_focus 도착 전 blur가 오면 바로 닫히므로).
window.addEventListener("blur", () => {
  if (Date.now() - openedAt < 400) return;
  cancel();
});

async function boot() {
  // 이 창은 저장하지 않는다 — 다른 창의 저장(템플릿 편집 등)만 받아 목록을 다시 그린다.
  await initStore(async () => {
    applyDarkMode(state.common.darkMode);
    render();
  });
  bindDarkMode(() => state.common.darkMode); // 초기 적용 + system 모드 OS 추적
  await listen("guseok://pick-open", () => {
    openedAt = Date.now();
    render();
  });
  render();
}

// CDP 테스트용 내부 훅
window.__pick = { state: () => state, items, render };

boot();
