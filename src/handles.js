import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalPosition } from "@tauri-apps/api/window";
import { state, initStore, saveStore, indexById, activeIndex } from "./store.js";
import { getLayout, panelRect, STRIP_W } from "./layout.js";

const win = getCurrentWindow();
const listEl = document.getElementById("handleList");

let lay = null;
let activeId = null;
let dragging = false;
let snapTimer = 0;
let downstream = false;

function render() {
  listEl.innerHTML = "";
  const hh = lay ? lay.hh : 96;
  state.indexes.forEach((idx) => {
    const el = document.createElement("div");
    el.className = "handle" + (idx.id === activeId ? " active" : "");
    el.style.height = Math.round(hh) + "px";
    el.style.setProperty("--hbg", idx.bg);
    el.style.setProperty("--hfg", idx.fg);
    const chars = (idx.title || "메모").slice(0, 8).split("");
    chars.forEach((c) => {
      const sp = document.createElement("span");
      sp.className = "ch";
      sp.textContent = c === " " ? "\u00a0" : c;
      el.appendChild(sp);
    });
    el.dataset.id = idx.id;
    el.title = idx.title;
    listEl.appendChild(el);
  });
}

async function place(show = true) {
  lay = await getLayout(state);
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
  return [state.common.side, state.common.monitor, state.common.anchor, state.common.mode, state.indexes.length].join("|");
}

function renderSig() {
  const h = lay ? Math.round(lay.hh) : 96;
  return activeId + "#" + h + "#" + state.indexes.map((i) => i.id + i.title + i.bg + i.fg).join(",");
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

async function open(id) {
  const idx = indexById(id);
  if (!idx) return;
  if (activeId === id) {
    await close();
    return;
  }
  lay = await getLayout(state);
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
  const list = state.indexes;
  const cur = list.findIndex((i) => i.id === activeId);
  const base = cur >= 0 ? cur : Math.max(0, list.findIndex((i) => i.id === state.common.lastIndexId));
  const next = list[(base + dir + list.length) % list.length];
  if (next && next.id !== activeId) await open(next.id);
}

async function snapToEdge(posY) {
  if (downstream) return;
  downstream = true;
  try {
    const wa = await invoke("work_area", { which: state.common.monitor });
    const stripH = lay ? lay.stripH : 112;
    const y = Math.max(wa.y, Math.min(wa.y + wa.h - stripH, posY));
    const x = state.common.side === "left" ? wa.x : wa.x + wa.w - STRIP_W;
    await win.setPosition(new LogicalPosition(x, y));
    if (lay) lay.y = y;
    state.common.anchor = Math.max(0, Math.min(1, (y - wa.y) / Math.max(1, wa.h - stripH)));
    await saveStore();
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
    await open(id);
  });
}

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
      await snapToEdge(payload.y / (await win.scaleFactor()));
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
    else if (action === "index") {
      const idx = state.indexes[(n || 1) - 1];
      if (idx) await open(idx.id);
    }
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

