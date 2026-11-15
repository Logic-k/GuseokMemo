import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { THEMES } from "./themes.js";

export const APP_NAME = "구석메모";
export const MAX_INDEXES = 10;

export const defaultIndex = (n = 1) => ({
  id: "i" + Math.random().toString(36).slice(2, 8),
  title: n === 1 ? "할일" : `메모 ${n}`,
  theme: 0,
  bg: THEMES[0].bg,
  fg: THEMES[0].fg,
  accent: THEMES[0].accent,
  fontSize: 18,
  font: "system",
  opacity: 100,
  ratio: "3:4",
  mode: "peek",
  content: "",
  images: [],
});

const STARTERS = [
  {
    title: "할일",
    theme: 0,
    content:
      '<div class="ck done" data-ck="1"><input type="checkbox" checked=""><span class="ck-text">아침 메일 확인</span></div>' +
      '<div class="ck" data-ck="1"><input type="checkbox"><span class="ck-text">주간 보고서 초안</span></div>' +
      '<div class="ck" data-ck="1"><input type="checkbox"><span class="ck-text">팀 회의 14:00</span></div><p><br></p>',
  },
  {
    title: "회의",
    theme: 2,
    content:
      "<h2>주간 회의</h2><ul><li>지난주 진행 상황 공유</li><li>이번 주 우선순위 정리</li><li>결정 사항은 담당자와 함께 기록</li></ul><p><br></p>",
  },
  {
    title: "아이디어",
    theme: 3,
    content:
      "<p>떠오른 생각을 바로 적어 두세요.</p><p><strong>Ctrl+Shift+M</strong> 으로 언제든 열 수 있습니다.</p>",
  },
];

export const defaultState = () => {
  const indexes = STARTERS.map((s, i) => {
    const t = THEMES[s.theme] || THEMES[0];
    return { ...defaultIndex(i + 1), id: "welcome" + (i + 1), ...s, bg: t.bg, fg: t.fg, accent: t.accent };
  });
  return {
    version: 1,
    common: {
      monitor: "auto",
      side: "right",
      mode: "mouse",
      openKey: "ctrl_shift_m",
      peekDelay: 350,
      toggleBy: "chip",
      spellcheck: false,
      autostart: false,
      hideTaskbar: true,
      anchor: 0.42,
      lastIndexId: "welcome1",
    },
    indexes,
  };
};

export let state = defaultState();

let saveTimer = null;
let externalHandler = null;
const INSTANCE = Math.random().toString(36).slice(2);

export function migrate(raw) {
  const base = defaultState();
  const s = { ...base, ...(raw && typeof raw === "object" ? raw : {}) };
  s.common = { ...base.common, ...(raw && raw.common ? raw.common : {}) };
  if (!Array.isArray(s.indexes) || s.indexes.length === 0) s.indexes = base.indexes;
  s.indexes = s.indexes.slice(0, MAX_INDEXES).map((it, i) => {
    const d = defaultIndex(i + 1);
    const item = it && typeof it === "object" ? it : {};
    return { ...d, ...item, images: Array.isArray(item.images) ? item.images : [] };
  });
  return s;
}

export async function initStore(onExternal) {
  externalHandler = onExternal;
  try {
    const raw = await invoke("load_store");
    if (raw && raw.trim()) state = migrate(JSON.parse(raw));
  } catch (err) {
    console.warn("store load failed", err);
  }
  await listen("guseok://store", (event) => {
    try {
      const payload = JSON.parse(event.payload);
      if (!payload || payload.src === INSTANCE) return;
      const incoming = JSON.parse(payload.raw);
      if (!incoming) return;
      if (JSON.stringify(incoming) === JSON.stringify(state)) return;
      state = migrate(incoming);
      externalHandler?.(state);
    } catch {}
  });
}

export function saveStore({ immediate = false } = {}) {
  if (saveTimer) clearTimeout(saveTimer);
  const run = async () => {
    const json = JSON.stringify(state);
    try {
      await invoke("save_store", { json });
      await emit("guseok://store", JSON.stringify({ src: INSTANCE, raw: json }));
    } catch (err) {
      console.warn("store save failed", err);
    }
  };
  if (immediate) return run();
  return new Promise((resolve) => {
    saveTimer = setTimeout(() => {
      saveTimer = null;
      run().then(resolve, resolve);
    }, 260);
  });
}

window.addEventListener("pagehide", () => {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    invoke("save_store", { json: JSON.stringify(state) });
  } catch {}
});

export function activeIndex() {
  return state.indexes.find((i) => i.id === state.common.lastIndexId) || state.indexes[0];
}

export function indexById(id) {
  return state.indexes.find((i) => i.id === id);
}

export function applyTheme(index, themeIdx) {
  const t = THEMES[themeIdx] || THEMES[0];
  index.theme = themeIdx;
  index.bg = t.bg;
  index.fg = t.fg;
  index.accent = t.accent;
}

export function uid() {
  return "i" + Math.random().toString(36).slice(2, 8);
}




