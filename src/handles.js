import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { state, initStore, saveStore, indexById, activeIndex, defaultIndex, applyTheme, MAX_INDEXES, visibleIndexes, ensureOneVisible, setIndexHidden as setIndexHiddenCore } from "./store.js";
import { THEMES } from "./themes.js";
import { getLayout, panelRect, STRIP_W } from "./layout.js";

const win = getCurrentWindow();
const listEl = document.getElementById("handleList");

let lay = null;
let activeId = null;
let dragging = false;
let snapTimer = 0;
let downstream = false;
let pendingDelete = null; // { id, timer } — 우클릭으로 무장된 삭제 대기 핸들

const showAdd = () => state.indexes.length < MAX_INDEXES;

function render() {
  listEl.innerHTML = "";
  const hh = lay ? lay.hh : 96;
  // R-07 — 숨긴 인덱스는 스트립에 렌더하지 않는다 (데이터는 유지, 표시만 제외).
  visibleIndexes().forEach((idx) => {
    const el = document.createElement("div");
    const armed = pendingDelete && pendingDelete.id === idx.id;
    el.className = "handle" + (idx.id === activeId ? " active" : "") + (armed ? " del-armed" : "");
    el.style.height = Math.round(hh) + "px";
    el.style.setProperty("--hbg", idx.bg);
    el.style.setProperty("--hfg", idx.fg);
    const chars = (armed ? "삭제" : idx.title || "메모").slice(0, 8).split("");
    chars.forEach((c) => {
      const sp = document.createElement("span");
      sp.className = "ch";
      sp.textContent = c === " " ? "\u00a0" : c;
      el.appendChild(sp);
    });
    el.dataset.id = idx.id;
    el.title = armed ? "한 번 더 클릭하면 삭제" : idx.title;
    listEl.appendChild(el);
  });
  if (showAdd()) {
    const add = document.createElement("div");
    add.className = "handle-add";
    add.textContent = "+";
    add.title = "메모 추가";
    listEl.appendChild(add);
  }
}

async function place(show = true) {
  lay = await getLayout(state, showAdd());
  await invoke("place_handles", {
    x: lay.x,
    y: lay.y,
    w: STRIP_W,
    h: Math.round(lay.stripH),
    visible: show && state.common.mode !== "shortcut",
  });
}

let lastLayoutSig = "";
let lastRenderSig = "";

function layoutSig() {
  // 전체 개수는 + 버튼(ADD_H) 유무를, visible 개수는 스트립 높이를 바꾼다 — 둘 다 시그니처에 포함.
  return [state.common.side, state.common.monitor, state.common.anchor, state.common.mode, state.indexes.length, visibleIndexes().length].join("|");
}

function renderSig() {
  const h = lay ? Math.round(lay.hh) : 96;
  return activeId + "#" + h + "#" + visibleIndexes().map((i) => i.id + i.title + i.bg + i.fg).join(",");
}

async function refresh() {
  const ls = layoutSig();
  if (ls !== lastLayoutSig) {
    await place(true);
    lastLayoutSig = ls;
  }
  const rs = renderSig();
  if (rs !== lastRenderSig) {
    render();
    lastRenderSig = rs;
  }
}

async function addIndex() {
  if (!showAdd()) return;
  const n = state.indexes.length + 1;
  const fresh = defaultIndex(n);
  fresh.theme = (n - 1) % THEMES.length;
  applyTheme(fresh, fresh.theme);
  state.indexes.push(fresh);
  await saveStore({ immediate: true });
  await refresh();
  await open(fresh.id);
}

async function removeIndex(id) {
  if (state.indexes.length <= 1) return;
  const wasActive = activeId === id;
  state.indexes = state.indexes.filter((i) => i.id !== id);
  // R-07 — 표시 중이던 마지막 인덱스를 지우면 남은 첫 인덱스를 자동 표시해 전부 숨김을 막는다.
  ensureOneVisible();
  if (state.common.lastIndexId === id) state.common.lastIndexId = (visibleIndexes()[0] || state.indexes[0]).id;
  if (pendingDelete) {
    clearTimeout(pendingDelete.timer);
    pendingDelete = null;
  }
  await saveStore({ immediate: true });
  if (wasActive) {
    activeId = null;
    await invoke("hide_panel");
  }
  await refresh();
}

function armDelete(id) {
  if (state.indexes.length <= 1) return;
  if (pendingDelete) clearTimeout(pendingDelete.timer);
  pendingDelete = {
    id,
    timer: setTimeout(() => {
      pendingDelete = null;
      render();
    }, 2600),
  };
  render();
}

async function open(id) {
  const idx = indexById(id);
  if (!idx) return;
  if (activeId === id) {
    await close();
    return;
  }
  lay = await getLayout(state, showAdd());
  const r = panelRect(idx, lay);
  activeId = id;
  state.common.lastIndexId = id;
  await saveStore({ immediate: true });
  render();
  await invoke("show_panel", { x: r.x, y: r.y, w: r.w, h: r.h, indexId: id });
}

async function close() {
  activeId = null;
  render();
  await invoke("hide_panel");
}

async function toggle() {
  if (activeId) await close();
  else {
    const idx = activeIndex();
    if (idx) await open(idx.id);
  }
}

async function step(dir) {
  // R-07 — ↑/↓ 순환은 표시 중인 인덱스만 대상으로 한다 (숨긴 인덱스 건너뜀).
  const list = visibleIndexes();
  if (!list.length) return;
  const cur = list.findIndex((i) => i.id === activeId);
  const base = cur >= 0 ? cur : Math.max(0, list.findIndex((i) => i.id === state.common.lastIndexId));
  const next = list[(base + dir + list.length) % list.length];
  if (next && next.id !== activeId) await open(next.id);
}

// R-07 — Ctrl+번호 직접 열기: 번호는 스트립에 보이는 순서 기준 n번째 visible 인덱스.
async function openNthVisible(n) {
  const idx = visibleIndexes()[(n || 1) - 1];
  if (idx) await open(idx.id);
}

// R-07 — 표시/숨김 코어 호출 + 스트립 재배치·재렌더. 토글 UI(phase-05-task-04)가
// 없어도 __handles 훅·모듈 import로 호출 가능하다. 데이터 계약·보호·저장은
// store.js의 setIndexHidden이 담당한다.
export async function setIndexHidden(id, hidden) {
  const ok = await setIndexHiddenCore(id, hidden);
  if (ok) await refresh();
  return ok;
}

// 드래그 종료 지점에서 가장 가까운 모니터의 좌/우 가장자리로 자석 스냅.
// 모든 모니터의 작업 영역을 후보로 두고, 그중 x 거리가 최소인 가장자리를 고른다.
async function snapToEdge(posX, posY) {
  if (downstream) return;
  downstream = true;
  try {
    const scale = await win.scaleFactor();
    const wx = posX / scale;
    const wy = posY / scale;
    const areas = await invoke("monitors");
    let best = null;
    for (const wa of areas) {
      // 상하 배치 모니터 구분용 — 드롭 y가 작업 영역 밖이면 패널티
      const outY = wy < wa.y ? wa.y - wy : wy > wa.y + wa.h ? wy - (wa.y + wa.h) : 0;
      for (const side of ["left", "right"]) {
        const targetX = side === "left" ? wa.x : wa.x + wa.w - STRIP_W;
        const d = Math.abs(wx - targetX) + outY * 0.5;
        if (!best || d < best.d) best = { d, wa, side };
      }
    }
    const wa = best ? best.wa : await invoke("work_area", { which: state.common.monitor });
    const stripH = lay ? lay.stripH : 112;
    const y = Math.max(wa.y, Math.min(wa.y + wa.h - stripH, wy));
    state.common.side = best ? best.side : state.common.side;
    state.common.monitor = String(wa.index);
    state.common.anchor = Math.max(0, Math.min(1, (y - wa.y) / Math.max(1, wa.h - stripH)));
    await place(true);
    lastLayoutSig = layoutSig();
    render();
    lastRenderSig = renderSig();
    await saveStore({ immediate: true });
  } finally {
    setTimeout(() => {
      downstream = false;
    }, 400);
  }
}

function bindDrag() {
  let pressed = null;

  listEl.addEventListener("pointerdown", (e) => {
    const el = e.target.closest(".handle");
    if (!el || e.button !== 0) return;
    pressed = { id: el.dataset.id, x: e.clientX, y: e.clientY, moved: false };
  });

  window.addEventListener("pointermove", async (e) => {
    if (!pressed || pressed.moved || !e.buttons) return;
    if (Math.abs(e.clientX - pressed.x) + Math.abs(e.clientY - pressed.y) < 5) return;
    pressed.moved = true;
    dragging = true;
    if (activeId) await close();
    try {
      await win.startDragging();
    } catch {}
  });

  window.addEventListener("pointerup", async () => {
    if (!pressed) return;
    const wasDrag = pressed.moved;
    const id = pressed.id;
    pressed = null;
    if (wasDrag) {
      clearTimeout(snapTimer);
      snapTimer = setTimeout(() => {
        dragging = false;
      }, 500);
      return;
    }
    if (pendingDelete && pendingDelete.id === id) {
      await removeIndex(id);
      return;
    }
    if (pendingDelete) {
      clearTimeout(pendingDelete.timer);
      pendingDelete = null;
      render();
    }
    await open(id);
  });

  listEl.addEventListener("click", (e) => {
    if (e.target.closest(".handle-add")) addIndex();
  });

  listEl.addEventListener("contextmenu", (e) => {
    const el = e.target.closest(".handle");
    if (!el) return;
    e.preventDefault();
    armDelete(el.dataset.id);
  });
}

// CDP 테스트용 내부 훅
window.__handles = { snapToEdge, addIndex, removeIndex, armDelete, step, openNthVisible, setIndexHidden, state: () => state, lay: () => lay };

async function boot() {
  await initStore(async () => {
    await refresh();
  });
  await refresh();
  bindDrag();

  await win.onMoved(({ payload }) => {
    if (!dragging) return;
    clearTimeout(snapTimer);
    snapTimer = setTimeout(async () => {
      dragging = false;
      await snapToEdge(payload.x, payload.y);
    }, 320);
  });

  await listen("guseok://panel-closed", () => {
    activeId = null;
    render();
  });

  await listen("guseok://panel-open", (e) => {
    activeId = e.payload?.id || null;
    render();
  });

  await listen("guseok://shortcut", async (e) => {
    const { action, n } = e.payload || {};
    if (action === "toggle") await toggle();
    else if (action === "prev") await step(-1);
    else if (action === "next") await step(1);
    else if (action === "index") await openNthVisible(n);
  });

  invoke("register_shortcuts", { preset: state.common.openKey || "ctrl_shift_m", enabled: true })
    .then(() => invoke("qa_log", { msg: "PASS shortcuts :: " + (state.common.openKey || "ctrl_shift_m") }))
    .catch((e) => invoke("qa_log", { msg: "FAIL shortcuts :: " + String(e) }));

  // 자동 업데이트 — 시작 5초 뒤 GitHub Release 확인, 새 버전이 있으면 설치 후 재시작
  if (!import.meta.env.DEV) {
    setTimeout(async () => {
      try {
        const { checkForUpdate, installUpdate } = await import("./updates.js");
        const u = await checkForUpdate();
        if (u) {
          invoke("qa_log", { msg: "update found v" + u.version + " — installing" }).catch(() => {});
          await installUpdate(u);
        }
      } catch (e) {
        invoke("qa_log", { msg: "update check failed :: " + String(e) }).catch(() => {});
      }
    }, 5000);
  }
}

boot();

