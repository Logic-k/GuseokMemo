// search-window.js — 전체 검색 창 UI (R-01, DESIGN D-1).
// phase-02-task-01의 코어(src/search.js)를 소비한다. 창은 setup에서 미리 생성되고
// hide/show로 재사용된다 — show_search 커맨드가 위치를 맞춰 띄우고
// guseok://search-open emit으로 포커스·재검색을 통지한다.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { state, initStore, indexById } from "./store.js";
import { search } from "./search.js";
import { getLayout, panelRect } from "./layout.js";
import { applyDarkMode, bindDarkMode } from "./darkmode.js";

const input = document.getElementById("searchInput");
const listEl = document.getElementById("searchResults");
const emptyEl = document.getElementById("searchEmpty");

const DEBOUNCE_MS = 120; // D-1 — 입력 디바운스

let results = [];
let sel = -1;
let composing = false;    // IME 조합 중 — 결과 DOM 갱신 유예(NFR-02)
let pendingSearch = false; // 조합 중 밀린 재검색 요청
let debounceTimer = 0;
let openedAt = 0;

/* ---------------- render ---------------- */

// 텍스트 안의 쿼리(대소문자 무시)를 <b>로 감싼다 — textContent 조립이라
// 메모 본문의 임의 문자열이 HTML로 새지 않는다.
function highlightInto(el, text, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) {
    el.textContent = text;
    return;
  }
  const lower = text.toLowerCase();
  let pos = 0;
  let i = lower.indexOf(q, pos);
  while (i !== -1) {
    el.appendChild(document.createTextNode(text.slice(pos, i)));
    const b = document.createElement("b");
    b.textContent = text.slice(i, i + q.length);
    el.appendChild(b);
    pos = i + q.length;
    i = lower.indexOf(q, pos);
  }
  el.appendChild(document.createTextNode(text.slice(pos)));
}

function renderItem(r, i) {
  const idx = indexById(r.indexId);
  const item = document.createElement("div");
  item.className = "sr-item" + (i === sel ? " on" : "");
  item.dataset.id = r.indexId;

  const chip = document.createElement("span");
  chip.className = "sr-chip";
  chip.style.setProperty("--chip", (idx && idx.bg) || "#e9c866");
  item.appendChild(chip);

  const body = document.createElement("div");
  body.className = "sr-body";
  const title = document.createElement("div");
  title.className = "sr-title";
  highlightInto(title, r.title || "메모", input.value);
  const snip = document.createElement("div");
  snip.className = "sr-snippet";
  highlightInto(snip, r.snippet || "", input.value);
  body.append(title, snip);
  item.appendChild(body);

  // mousedown을 막아 입력 포커스를 유지하고, click으로 점프한다.
  item.addEventListener("mousedown", (e) => e.preventDefault());
  item.addEventListener("mouseenter", () => {
    if (sel !== i) {
      sel = i;
      applySel();
    }
  });
  item.addEventListener("click", () => jump(r.indexId));
  return item;
}

function render() {
  listEl.innerHTML = "";
  results.forEach((r, i) => listEl.appendChild(renderItem(r, i)));
  const q = input.value.trim();
  if (!results.length) {
    emptyEl.textContent = q ? "결과 없음" : "메모 제목과 본문에서 찾습니다";
    emptyEl.classList.remove("hidden");
  } else {
    emptyEl.classList.add("hidden");
  }
}

function applySel() {
  Array.from(listEl.children).forEach((el, i) => el.classList.toggle("on", i === sel));
  const el = listEl.children[sel];
  if (el) el.scrollIntoView({ block: "nearest" });
}

/* ---------------- search ---------------- */

// 조합 중이면 재검색을 유예한다 — 결과 DOM 갱신이 한글 IME 조합을 끊는 것을 막는다.
function runSearch() {
  if (composing) {
    pendingSearch = true;
    return;
  }
  pendingSearch = false;
  results = input.value.trim() ? search(state, input.value) : [];
  sel = results.length ? 0 : -1;
  render();
}

input.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runSearch, DEBOUNCE_MS);
});

input.addEventListener("compositionstart", () => {
  composing = true;
});
input.addEventListener("compositionend", () => {
  composing = false;
  if (pendingSearch) runSearch(); // 조합 확정 텍스트로 밀린 검색을 실행
});
input.addEventListener("blur", () => {
  composing = false;
});

/* ---------------- keys / close / jump ---------------- */

function moveSel(d) {
  if (!results.length) return;
  sel = (sel + d + results.length) % results.length;
  applySel();
}

async function hide() {
  clearTimeout(debounceTimer);
  await invoke("hide_search").catch(() => {});
}

async function jump(indexId) {
  const idx = indexById(indexId);
  try {
    if (idx) {
      // handles의 open(id)과 같은 경로 — 레이아웃 계산 → show_panel.
      // lastIndexId 확정·저장은 panel의 guseok://panel-open 리스너가 담당한다.
      const lay = await getLayout(state);
      const r = panelRect(idx, lay);
      await invoke("show_panel", { x: r.x, y: r.y, w: r.w, h: r.h, indexId: idx.id });
    }
  } catch (err) {
    console.warn("search jump failed", err);
  } finally {
    await hide(); // 점프 후 자동 닫힘
  }
}

document.addEventListener("keydown", (e) => {
  // IME 조합 중엔 브라우저가 키를 소비해야 한다 — 네비/점프/닫기 가로채기는
  // 조합을 강제 확정시켜 한글이 갈라지는 원인 (panel.js와 같은 가드).
  if (e.isComposing || e.key === "Process" || e.keyCode === 229) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    moveSel(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    moveSel(-1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const r = results[sel];
    if (r) jump(r.indexId);
  } else if (e.key === "Escape") {
    e.preventDefault();
    hide();
  }
});

// 외부 클릭 = 창 포커스 상실 → 닫기 (D-1). show 직후 포커스 안정화 짧게 유예.
window.addEventListener("blur", () => {
  if (Date.now() - openedAt < 400) return;
  hide();
});

/* ---------------- boot ---------------- */

async function boot() {
  // 외부 변경·다른 창 저장으로 state가 바뀌면 결과 재검색 (조합 중엔 runSearch가 유예).
  // darkMode 변경도 같은 경로로 도착 — html.dark 토글만이라 입력 조합에 안전.
  await initStore(async () => {
    applyDarkMode(state.common.darkMode);
    runSearch();
  });
  bindDarkMode(() => state.common.darkMode); // 초기 적용 + system 모드 OS 추적

  await listen("guseok://search-open", () => {
    openedAt = Date.now();
    runSearch(); // 마지막 쿼리 기준으로 최신 state 재검색
    setTimeout(() => {
      input.focus();
      input.select(); // 기존 입력은 전체선택 — 바로 덮어쓰기 가능
    }, 20);
  });

  render();
}

// CDP 테스트용 내부 훅
window.__search = {
  state: () => state,
  results: () => results,
  sel: () => sel,
  runSearch,
  hide,
};

boot();
