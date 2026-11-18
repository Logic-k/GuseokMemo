import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
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

// v2 — 스니펫 원소 기본형 (R-06). text는 {date} 같은 치환자를 담은 평문.
export const defaultSnippet = () => ({
  id: "s" + Math.random().toString(36).slice(2, 8),
  name: "",
  text: "",
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
      searchKey: "ctrl_shift_f", // v2 — 검색 창 전역키 (R-01, D-1). 구 store는 common merge로 기본값 채움
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
    // v2 — R-06 기본 스니펫: 치환자는 삽입 시점 값으로 치환 (templates.js insertSnippet 참조)
    snippets: [
      { id: "snip1", name: "오늘 날짜", text: "{date}", builtin: true },
      { id: "snip2", name: "현재 시각", text: "{time}", builtin: true },
      { id: "snip3", name: "일시", text: "{datetime}", builtin: true },
      { id: "snip4", name: "작성일", text: "작성일: {iso}", builtin: true },
    ],
  };
};

export let state = defaultState();

let saveTimer = null;
let externalHandler = null;
const WIN_LABEL = getCurrentWindow().label;

// OQ-03 — 디스크와 동기화된 마지막 state 직렬화. 외부 변경(src:"external") 도착
// 시 현재 state가 이 기준선과 다르면 "미저장 편집 있음 = 충돌"로 판정한다 —
// 디바운스 대기 중인 편집과, 아직 저장 호출조차 안 된 인메모리 변경을 둘 다 포착.
let lastSavedJson = "";
// guseok://store 적용을 도착 순서대로 직렬화 — 충돌본 파일 쓰기(비동기)가 진행
// 중일 때 후속 이벤트가 끼어들어 적용 순서가 뒤집히지 않게 한다.
let applyChain = Promise.resolve();

// OQ-03 충돌 판정 — 외부(src:"external") 변경에만 적용한다. 같은 앱의 다른 창
// 저장은 정상 브로드캐스트(기존 last-writer-wins)라 충돌 경로를 타지 않는다.
// localJson !== savedJson이면 디스크에 아직 반영되지 않은 로컬 편집이 있다.
export function isStoreConflict(src, localJson, savedJson) {
  return src === "external" && typeof localJson === "string" && localJson !== savedJson;
}

// 충돌 안내용 — 로컬본과 외부본이 실제로 다른 인덱스 목록(id·title).
// 토스트가 어떤 메모가 영향받았는지 보여주고 클릭 점프할 수 있게 한다.
// 반환이 비면 인덱스가 아닌 common/templates 등만 다른 경우다.
export function conflictingIndexes(local, incoming) {
  const inc = new Map((((incoming && incoming.indexes) || [])).map((i) => [i && i.id, i]));
  return ((local && local.indexes) || [])
    .filter((i) => {
      if (!i || typeof i !== "object") return false;
      const other = inc.get(i.id);
      return !other || JSON.stringify(i) !== JSON.stringify(other);
    })
    .map((i) => ({ id: i.id, title: i.title || "메모" }));
}

// 버전별 단계 변환 — STEPS[n]은 store를 version n → n+1로 변환한다 (TD-03 연쇄).
// 위의 spread merge가 알 수 없는 키를 이미 보존하므로(TD-10), 각 단계는
// 그 버전에 새로 생긴 필드의 형식 정규화만 담당한다.
const STEPS = {
  // v1 → v2: common.darkMode/notifyMethod, idx.hidden/reminders[], 최상위 templates[]/snippets[]
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
    s.snippets = Array.isArray(s.snippets)
      ? s.snippets
          .filter((sn) => sn && typeof sn === "object")
          .map((sn) => ({ ...defaultSnippet(), ...sn }))
      : base.snippets;
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
    // R-07 — hidden은 strict boolean 계약: v2 파일에서도 literal true만 숨김으로
    // 인정한다("yes"/1 같은 이형 값은 표시로 정규화 — 모든 필터가 `=== true` 기준).
    const merged = { ...d, ...item, images: Array.isArray(item.images) ? item.images : [], hidden: item.hidden === true };
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
  // R-07 — 전부 숨김은 어떤 경로로도 허용하지 않는다 (외부 편집·구버전 백업 포함).
  ensureOneVisible(s);
  return s;
}

export async function initStore(onExternal) {
  externalHandler = onExternal;
  try {
    const raw = await invoke("load_store");
    if (raw && raw.trim()) state = migrate(JSON.parse(raw));
    lastSavedJson = JSON.stringify(state); // 부팅 시점 = 디스크와 동기화된 기준선
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
      const localJson = JSON.stringify(state);
      if (JSON.stringify(incoming) === localJson) {
        // 내용 동일 — 디스크가 이미 우리 상태라 덮어쓰이는 것이 없다. 기준선만 맞춘다.
        lastSavedJson = localJson;
        return;
      }
      // OQ-03 — 외부 변경 + 로컬 미저장 편집 = 충돌: 외부본을 적용하되 덮어쓰이는
      // 로컬본 전체를 store.conflict-*.json으로 보관한다. 이 이벤트가 충돌을 소유하고
      // 기준선을 당겨 두면, 적용이 끝나기 전 도착한 후속 이벤트가 같은 로컬본을
      // 중복 보관하지 않는다(적용 완료 시 기준선은 어차피 새 state로 다시 놓인다).
      const conflict = isStoreConflict(payload.src, localJson, lastSavedJson);
      if (conflict) lastSavedJson = localJson;
      const diffs = conflict ? conflictingIndexes(state, incoming) : [];
      applyChain = applyChain
        .then(async () => {
          let conflictPath = null;
          if (conflict) {
            try {
              // 덮어쓰이는 로컬본을 먼저 파일로 보관한 뒤 외부본을 적용한다.
              conflictPath = await invoke("save_conflict_copy", { json: localJson });
            } catch (err) {
              invoke("qa_log", { msg: "FAIL conflict-copy :: " + String(err) }).catch(() => {});
            }
          }
          state = migrate(incoming);
          lastSavedJson = JSON.stringify(state);
          if (conflict) {
            invoke("qa_log", {
              msg:
                `conflict :: win=${WIN_LABEL} applied-external preserved=${conflictPath || "FAILED"} ` +
                `diffs=${diffs.map((d) => d.id).join(",") || "-"}`,
            }).catch(() => {});
            // 사용자 통지 — 상주하는 handles 창이 토스트 큐로 표시한다(전 창 브로드캐스트).
            emit("guseok://conflict", { win: WIN_LABEL, path: conflictPath, indexes: diffs }).catch(() => {});
          }
          externalHandler?.(state, { src: payload.src, conflict, conflictPath, diffs });
        })
        .catch(() => {}); // 한 이벤트의 실패가 뒤 이벤트 적용을 막지 않게 체인을 살린다
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
      // 저장 성공 — 디스크 기준선 갱신. 실패하면 기준선이 옛날 그대로라 state는
      // 계속 "미저장"으로 남고, 다음 외부 변경이 충돌로 판정된다(보존 대상 정확).
      lastSavedJson = json;
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

// R-07 — 스트립에 보이는(숨기지 않은) 인덱스 목록. 표시 관련 모든 필터는
// 이 순서·조건을 따른다 (handles 렌더·layout 높이·step·Ctrl+번호·검색 제외와 동일 기준).
export function visibleIndexes(s = state) {
  const list = s && Array.isArray(s.indexes) ? s.indexes : [];
  return list.filter((i) => i && i.hidden !== true);
}

// R-07 — 전부 숨김 금지: 표시 중인 인덱스가 하나도 없으면 첫 인덱스를 다시 표시한다.
// 삭제·복원·외부 편집 등 setIndexHidden을 거치지 않는 경로에서도 불변식을 유지한다.
export function ensureOneVisible(s = state) {
  const list = s && Array.isArray(s.indexes) ? s.indexes : [];
  if (list.length && !list.some((i) => i && i.hidden !== true)) list[0].hidden = false;
}

export function activeIndex() {
  const cur = state.indexes.find((i) => i.id === state.common.lastIndexId);
  // R-07 — lastIndexId가 숨긴 인덱스를 가리키면 첫 visible로 폴백한다.
  if (cur && cur.hidden !== true) return cur;
  return visibleIndexes()[0] || state.indexes[0] || null;
}

export function indexById(id) {
  return state.indexes.find((i) => i.id === id);
}

// R-07 — 인덱스 표시/숨김 코어 (토글 UI는 phase-05-task-04가 호출한다).
// 데이터·메모·리마인더는 유지하고 표시만 바꾼다. 마지막 visible 1개는 숨길 수
// 없고(전부 숨김 금지), 숨기는 인덱스가 lastIndexId면 첫 visible로 폴백시킨다.
// 반환: 적용(또는 이미 그 상태)이면 true, id 없음·마지막 1개 보호 거절이면 false.
export async function setIndexHidden(id, hidden) {
  const idx = indexById(id);
  if (!idx) return false;
  const want = hidden === true;
  if (idx.hidden === want) return true; // 멱등 — 불필요한 저장·브로드캐스트를 만들지 않는다
  if (want && visibleIndexes().length <= 1) return false;
  idx.hidden = want;
  if (want && state.common.lastIndexId === id) {
    const first = visibleIndexes()[0];
    if (first) state.common.lastIndexId = first.id;
  }
  await saveStore({ immediate: true });
  return true;
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




