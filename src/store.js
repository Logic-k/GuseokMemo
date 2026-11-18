import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { THEMES } from "./themes.js";

export const APP_NAME = "구석메모";
export const MAX_INDEXES = 10;
// store.json 스키마 버전 — TD-03: 기존 `version` 키 재사용, migrate()의 단계 연쇄 대상.
export const SCHEMA_VERSION = 2;

// v2 — 리마인더 원소 기본형 (ARCH §5, R-02/03). at은 로컬 ISO 문자열(반복이면 다음 발생 시각).
export const defaultReminder = () => ({
  id: "r" + Math.random().toString(36).slice(2, 8),
  at: null,
  repeat: "none", // "none" | "daily" | "weekly"
  note: "",
  enabled: true,
  lastFiredAt: null,
});

// v2 — 템플릿 원소 기본형 (R-06). builtin은 앱 제공 템플릿 여부.
export const defaultTemplate = () => ({
  id: "t" + Math.random().toString(36).slice(2, 8),
  name: "",
  content: "",
  builtin: false,
});

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
  hidden: false, // v2 — R-07 스트립 비표시
  reminders: [], // v2 — R-02/03 (defaultReminder 원소)
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
    version: SCHEMA_VERSION,
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
      darkMode: "system", // v2 — "light"|"dark"|"system" (R-08)
      notifyMethod: "panel", // v2 — OQ-02 결정 전 보수적 기본값 (후보: toast|panel|sound)
    },
    indexes,
    // v2 — R-06 기본 템플릿: STARTERS 3종 재사용 + builtin 표시 (공통 자산)
    templates: STARTERS.map((s, i) => ({
      id: "tpl" + (i + 1),
      name: s.title,
      content: s.content,
      builtin: true,
    })),
  };
};

export let state = defaultState();

let saveTimer = null;
let externalHandler = null;
const WIN_LABEL = getCurrentWindow().label;

// 버전별 단계 변환 — STEPS[n]은 store를 version n → n+1로 변환한다 (TD-03 연쇄).
// 위의 spread merge가 알 수 없는 키를 이미 보존하므로(TD-10), 각 단계는
// 그 버전에 새로 생긴 필드의 형식 정규화만 담당한다.
const STEPS = {
  // v1 → v2: common.darkMode/notifyMethod, idx.hidden/reminders[], 최상위 templates[]
  1(s, base) {
    if (typeof s.common.darkMode !== "string") s.common.darkMode = base.common.darkMode;
    if (typeof s.common.notifyMethod !== "string") s.common.notifyMethod = base.common.notifyMethod;
    for (const idx of s.indexes) {
      idx.hidden = idx.hidden === true;
      idx.reminders = Array.isArray(idx.reminders)
        ? idx.reminders
            .filter((r) => r && typeof r === "object")
            .map((r) => ({ ...defaultReminder(), ...r }))
        : [];
    }
    s.templates = Array.isArray(s.templates)
      ? s.templates
          .filter((t) => t && typeof t === "object")
          .map((t) => ({ ...defaultTemplate(), ...t }))
      : base.templates;
  },
};

export function migrate(raw) {
  const base = defaultState();
  const s = { ...base, ...(raw && typeof raw === "object" ? raw : {}) };
  s.common = { ...base.common, ...(raw && raw.common ? raw.common : {}) };
  if (!Array.isArray(s.indexes) || s.indexes.length === 0) s.indexes = base.indexes;
  const seen = new Set();
  s.indexes = s.indexes.slice(0, MAX_INDEXES).map((it, i) => {
    const d = defaultIndex(i + 1);
    const item = it && typeof it === "object" ? it : {};
    const merged = { ...d, ...item, images: Array.isArray(item.images) ? item.images : [] };
    if (!merged.id || seen.has(merged.id)) merged.id = uid();
    seen.add(merged.id);
    return merged;
  });
  // 입력이 선언한 버전부터 단계 적용 — version 키 없는 구버전 파일은 1로 간주.
  // 미래 버전 파일은 단계를 건너뛰고 version을 그대로 보존한다(TD-10 다운그레이드 안전).
  const declared =
    raw && typeof raw === "object" && Number.isInteger(raw.version) && raw.version >= 1 ? raw.version : 1;
  for (let v = declared; v < SCHEMA_VERSION; v++) STEPS[v]?.(s, base);
  s.version = Math.max(declared, SCHEMA_VERSION);
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
      // 자기 창이 저장한 에코는 무시한다 — 타이핑 도중 state 교체로 IME 조합이 깨지는 것을 막는다.
      if (!payload || payload.src === WIN_LABEL) return;
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
      // 저장 성공 시 Rust 쪽에서 guseok://store 를 브로드캐스트한다(pagehide 플러시도 전파됨).
      await invoke("save_store", { json });
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




