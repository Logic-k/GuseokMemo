import { invoke } from "@tauri-apps/api/core";
import { availableMonitors } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { state, initStore, saveStore, defaultIndex, applyTheme, migrate, MAX_INDEXES, ensureOneVisible } from "./store.js";
import { THEMES, RATIOS, FONTS } from "./themes.js";
import {
  setReminder,
  removeReminder,
  setReminderEnabled,
  reminderStatus,
  REM_STATUS_LABEL,
  fmtReminderAt,
  repeatLabel,
  listReminders,
  toLocalIso,
} from "./reminders.js";
import { DARK_MODES, applyDarkMode, bindDarkMode } from "./darkmode.js";

const win = getCurrentWindow();
const tabsEl = document.getElementById("tabs");
const bodyEl = document.getElementById("body");
const statusEl = document.getElementById("status");

const forcedTab = new URLSearchParams(location.search).get("tab");
let tab = "common";
let monitors = [];
let resetArmed = 0;
let appVersion = "";
// D-3 — 저장 탭: 마지막 외부 자동 불러오기 시각(이 창이 관찰한 것만), 실패 오류 문구,
// 비동기 렌더 시퀀스(늦게 온 렌더가 새 렌더를 덮지 않게 하는 토큰).
let lastExternalReload = null;
let storageError = "";
let storageSeq = 0;

const OPEN_KEYS = [
  { id: "ctrl_shift_m", label: "Ctrl + Shift + M" },
  { id: "alt_m", label: "Ctrl + Alt + M" },
  { id: "shift_space", label: "Ctrl + Shift + Space" },
  { id: "f9", label: "F9" },
];

// 검색 창 전역키 — 열기 프리셋과 겹치지 않는 별도 키셋 (main.rs shortcut_keys와 동기).
const SEARCH_KEYS = [
  { id: "ctrl_shift_f", label: "Ctrl + Shift + F" },
  { id: "ctrl_f", label: "Ctrl + F" },
  { id: "alt_f", label: "Ctrl + Alt + F" },
  { id: "f3", label: "F3" },
];

function status(msg) {
  statusEl.textContent = msg;
  clearTimeout(status._t);
  status._t = setTimeout(() => (statusEl.textContent = "모든 변경은 자동 저장됩니다"), 2200);
}

async function commit(msg = "저장됨") {
  await saveStore();
  status(msg);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function row(label, note, ctrl) {
  const r = el("div", "row");
  const left = el("div");
  left.appendChild(el("div", "row-label", label));
  if (note) left.appendChild(el("div", "row-note", note));
  const right = el("div", "row-ctrl");
  if (ctrl) right.appendChild(ctrl);
  r.append(left, right);
  return r;
}

function select(options, value, onChange, extra) {
  const s = el("select");
  options.forEach((o) => {
    const op = el("option", null, o.label);
    op.value = o.id;
    if (String(o.id) === String(value)) op.selected = true;
    s.appendChild(op);
  });
  if (extra) Object.assign(s, extra);
  s.addEventListener("change", () => onChange(s.value));
  return s;
}

function checkbox(checked, onChange) {
  const c = document.createElement("input");
  c.type = "checkbox";
  c.checked = !!checked;
  c.addEventListener("change", () => onChange(c.checked));
  return c;
}

function numberStepper(value, min, max, onChange) {
  const wrap = el("div", "row-ctrl");
  const minus = el("button", "btn", "−");
  const val = el("span", null, value + "px");
  val.style.minWidth = "44px";
  val.style.textAlign = "center";
  val.style.fontSize = "11.5px";
  const plus = el("button", "btn", "+");
  minus.onclick = () => {
    const v = Math.max(min, Math.min(max, value - 1));
    value = v;
    val.textContent = v + "px";
    onChange(v);
  };
  plus.onclick = () => {
    const v = Math.max(min, Math.min(max, value + 1));
    value = v;
    val.textContent = v + "px";
    onChange(v);
  };
  wrap.append(minus, val, plus);
  return wrap;
}

/* ---------------- tabs ---------------- */

function renderTabs() {
  tabsEl.innerHTML = "";
  const common = el("button", "tab" + (tab === "common" ? " on" : ""), "");
  common.innerHTML =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 3.2v2M12 18.8v2M3.2 12h2M18.8 12h2M5.8 5.8l1.4 1.4M16.8 16.8l1.4 1.4M18.2 5.8l-1.4 1.4M7.2 16.8l-1.4 1.4"/></svg>' +
    "<span>공통</span>";
  common.onclick = () => {
    tab = "common";
    render();
  };
  tabsEl.appendChild(common);

  // D-2 — 리마인더 목록·추가는 인덱스 무관한 전역 관리라 공통 다음의 고정 탭.
  const remTab = el("button", "tab" + (tab === "reminders" ? " on" : ""), "");
  remTab.innerHTML =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="8.4"/><path d="M12 7.4V12l3.2 2.1"/></svg>' +
    "<span>리마인더</span>";
  remTab.onclick = () => {
    tab = "reminders";
    render();
  };
  tabsEl.appendChild(remTab);

  state.indexes.forEach((idx) => {
    const b = el("button", "tab" + (tab === idx.id ? " on" : ""));
    const dot = el("span", "dot");
    dot.style.background = idx.accent;
    b.appendChild(dot);
    b.appendChild(el("span", null, idx.title || "메모"));
    b.onclick = () => {
      tab = idx.id;
      render();
    };
    tabsEl.appendChild(b);
  });

  if (state.indexes.length < MAX_INDEXES) {
    const add = el("button", "tab-add", "+");
    add.title = "인덱스 추가";
    add.onclick = async () => {
      const n = state.indexes.length + 1;
      const fresh = defaultIndex(n);
      fresh.theme = (n - 1) % THEMES.length;
      applyTheme(fresh, fresh.theme);
      state.indexes.push(fresh);
      tab = fresh.id;
      await commit("인덱스를 추가했어요");
      render();
    };
    tabsEl.appendChild(add);
  }

  // D-3 — 저장 폴더 탭은 탭열 맨 뒤(인덱스 + 버튼 다음)의 고정 탭.
  const stTab = el("button", "tab" + (tab === "storage" ? " on" : ""), "");
  stTab.innerHTML =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4.5h16v15H4z"/><path d="M8 4.5v5h8v-5"/><path d="M8 19.5v-6h8v6"/></svg>' +
    "<span>저장</span>";
  stTab.onclick = () => {
    tab = "storage";
    render();
  };
  tabsEl.appendChild(stTab);
}

/* ---------------- common ---------------- */

function renderCommon() {
  bodyEl.innerHTML = "";
  bodyEl.appendChild(el("p", "hint-top", "이 화면의 설정은 모든 메모에 똑같이 적용됩니다."));
  bodyEl.appendChild(el("div", "section-title", "표시"));

  const monOptions = [{ id: "auto", label: "자동 · 마우스가 있는 화면" }].concat(
    monitors.map((m, i) => ({ id: String(i), label: `${m.name || "모니터 " + (i + 1)}  (${Math.round(m.size.width)}×${Math.round(m.size.height)})` }))
  );

  bodyEl.appendChild(
    row("표시 모니터", "메모가 나타날 화면을 고정합니다.", select(monOptions, state.common.monitor, async (v) => {
      state.common.monitor = v;
      await commit();
    }))
  );

  bodyEl.appendChild(
    row("표시 위치", "오른쪽 가장자리가 기본입니다.", select(
      [
        { id: "right", label: "오른쪽" },
        { id: "left", label: "왼쪽" },
      ],
      state.common.side,
      async (v) => {
        state.common.side = v;
        await commit();
      }
    ))
  );

  // D-4 — 다크모드 선택 (common.darkMode). 메모 카드 색은 인덱스 테마가 유지하고,
  // 설정 창·패널 크롬·스트립 +·토스트·검색 창만 바뀐다. 저장 즉시 이 창에도 적용하고
  // 브로드캐스트로 나머지 창이 따라간다.
  const dmSel = select(DARK_MODES, state.common.darkMode || "system", async (v) => {
    state.common.darkMode = v;
    applyDarkMode(v);
    await commit();
  });
  dmSel.id = "darkModeSel";
  bodyEl.appendChild(
    row("다크 모드", "메모 색은 그대로 두고 앱 화면만 밝게·어둡게 합니다.", dmSel)
  );

  bodyEl.appendChild(el("div", "section-title", "동작"));
  bodyEl.appendChild(
    row("동작 방식", "마우스로 열거나, 단축키로 엽니다.", select(
      [
        { id: "mouse", label: "마우스 조작" },
        { id: "shortcut", label: "단축키 조작" },
      ],
      state.common.mode,
      async (v) => {
        state.common.mode = v;
        await commit();
      }
    ))
  );

  bodyEl.appendChild(
    row("열기 / 닫기 단축키", "Ctrl+1~9 로 인덱스를 바로 열 수 있어요.", select(OPEN_KEYS, state.common.openKey, async (v) => {
      state.common.openKey = v;
      await invoke("register_shortcuts", { preset: v, enabled: true, searchKey: state.common.searchKey || "ctrl_shift_f" }).catch(() => {});
      await commit();
    }))
  );

  bodyEl.appendChild(
    row("검색 단축키", "모든 메모의 제목·본문을 찾는 검색 창을 엽니다.", select(SEARCH_KEYS, state.common.searchKey || "ctrl_shift_f", async (v) => {
      state.common.searchKey = v;
      await invoke("register_shortcuts", { preset: state.common.openKey || "ctrl_shift_m", enabled: true, searchKey: v }).catch(() => {});
      await commit();
    }))
  );

  const delayVal = el("span", null, (state.common.peekDelay / 1000).toFixed(1) + "초");
  delayVal.style.fontSize = "11.5px";
  delayVal.style.minWidth = "38px";
  const delay = document.createElement("input");
  delay.type = "range";
  delay.min = "100";
  delay.max = "1500";
  delay.step = "50";
  delay.value = state.common.peekDelay;
  delay.addEventListener("input", () => {
    state.common.peekDelay = Number(delay.value);
    delayVal.textContent = (Number(delay.value) / 1000).toFixed(1) + "초";
  });
  delay.addEventListener("change", () => commit());
  const delayWrap = el("div", "row-ctrl");
  delayWrap.append(delay, delayVal);
  bodyEl.appendChild(row("자동 접힘 지연", "빼꼼 모드에서 마우스가 떠난 뒤 접히기까지.", delayWrap));

  bodyEl.appendChild(
    row("맞춤법 검사", "입력할 때 빨간 밑줄로 표시합니다.", checkbox(state.common.spellcheck, async (v) => {
      state.common.spellcheck = v;
      await commit();
    }))
  );

  bodyEl.appendChild(el("div", "section-title", "시작 및 데이터"));

  bodyEl.appendChild(
    row("Windows 시작 시 실행", "부팅하면 가장자리에 자동으로 나타납니다.", checkbox(state.common.autostart, async (v) => {
      state.common.autostart = v;
      try {
        await invoke("set_autostart", { enabled: v });
        await commit(v ? "시작 프로그램에 등록했어요" : "시작 프로그램에서 해제했어요");
      } catch (err) {
        status("등록 실패: " + String(err));
      }
    }))
  );

  const dataWrap = el("div", "row-ctrl");
  const backupBtn = el("button", "btn", "백업");
  const restoreBtn = el("button", "btn", "복원");
  const folderBtn = el("button", "btn", "폴더 열기");
  backupBtn.onclick = backup;
  restoreBtn.onclick = restore;
  folderBtn.onclick = () => invoke("open_data_dir").catch(() => {});
  dataWrap.append(backupBtn, restoreBtn, folderBtn);
  bodyEl.appendChild(row("백업 · 복원", "모든 인덱스를 JSON 파일 하나로 저장합니다.", dataWrap));

  const resetBtn = el("button", "btn danger", "초기화");
  resetBtn.onclick = async () => {
    if (Date.now() - resetArmed > 4000) {
      resetArmed = Date.now();
      status("한 번 더 누르면 모든 메모가 초기화됩니다");
      return;
    }
    resetArmed = 0;
    state.indexes = [];
    const fresh = defaultIndex(1);
    state.indexes.push(fresh);
    state.common.lastIndexId = fresh.id;
    tab = "common";
    await commit("초기화했어요");
    render();
  };
  bodyEl.appendChild(row("전체 초기화", "메모와 설정을 처음 상태로 되돌립니다.", resetBtn));

  bodyEl.appendChild(el("div", "section-title", "앱"));
  const updWrap = el("div", "row-ctrl");
  const updBtn = el("button", "btn", "지금 확인");
  const updStatus = el("span", null, appVersion ? "v" + appVersion : "");
  updStatus.style.fontSize = "11.5px";
  updStatus.style.minWidth = "60px";
  updBtn.onclick = async () => {
    updBtn.disabled = true;
    updStatus.textContent = "확인 중…";
    try {
      const { checkForUpdate, installUpdate } = await import("./updates.js");
      const u = await checkForUpdate();
      if (!u) {
        updStatus.textContent = "최신 버전입니다";
      } else {
        updStatus.textContent = "v" + u.version + " 설치 중…";
        await installUpdate(u, () => {});
        updStatus.textContent = "재시작합니다";
      }
    } catch (err) {
      updStatus.textContent = "확인 실패: " + String(err).slice(0, 40);
    }
    updBtn.disabled = false;
  };
  updWrap.append(updBtn, updStatus);
  bodyEl.appendChild(row("업데이트", "GitHub에서 새 버전을 확인하고 자동으로 설치합니다.", updWrap));
}

/* ---------------- index ---------------- */

function renderIndex(idx) {
  bodyEl.innerHTML = "";
  const pos = state.indexes.findIndex((i) => i.id === idx.id);
  bodyEl.appendChild(el("p", "hint-top", "이 화면의 설정은 이 인덱스의 메모에만 적용됩니다."));
  bodyEl.appendChild(el("div", "section-title", "기본"));

  const title = el("input");
  title.type = "text";
  title.maxLength = 8;
  title.value = idx.title;
  title.style.width = "130px";
  title.addEventListener("input", async () => {
    idx.title = title.value.slice(0, 8);
    renderTabs();
    await commit();
  });
  bodyEl.appendChild(row("인덱스 제목", "손잡이에 세로로 표시됩니다. (최대 8자)", title));

  const orderWrap = el("div", "row-ctrl");
  const up = el("button", "btn", "↑");
  const down = el("button", "btn", "↓");
  up.disabled = pos <= 0;
  down.disabled = pos >= state.indexes.length - 1;
  up.onclick = async () => {
    if (pos <= 0) return;
    [state.indexes[pos - 1], state.indexes[pos]] = [state.indexes[pos], state.indexes[pos - 1]];
    await commit();
    render();
  };
  down.onclick = async () => {
    if (pos >= state.indexes.length - 1) return;
    [state.indexes[pos + 1], state.indexes[pos]] = [state.indexes[pos], state.indexes[pos + 1]];
    await commit();
    render();
  };
  orderWrap.append(up, down);
  bodyEl.appendChild(row("손잡이 순서", "위아래 순서를 바꿉니다.", orderWrap));

  bodyEl.appendChild(
    row("글자 크기", "Ctrl + 휠 로도 바꿀 수 있어요.", numberStepper(idx.fontSize, 10, 40, async (v) => {
      idx.fontSize = v;
      await commit();
    }))
  );

  bodyEl.appendChild(
    row("글꼴", "선택한 글꼴이 없으면 기본 글꼴로 보입니다.", select(FONTS.map((f) => ({ id: f.id, label: f.label })), idx.font, async (v) => {
      idx.font = v;
      preview.style.fontFamily = (FONTS.find((f) => f.id === v) || FONTS[0]).css;
      await commit();
    }))
  );

  const preview = el("div", "preview-font", "오늘 할 일 · ABC 123");
  preview.style.fontFamily = (FONTS.find((f) => f.id === state.indexes.find((i) => i.id === idx.id).font) || FONTS[0]).css;
  bodyEl.appendChild(preview);

  bodyEl.appendChild(el("div", "section-title", "색상"));

  const swatches = el("div", "themes");
  THEMES.forEach((t, i) => {
    const sw = el("button", "swatch");
    sw.style.background = t.bg;
    sw.classList.toggle("on", i === idx.theme); // 선택 테두리는 .swatch.on 토큰이 그린다 (다크 대응)
    sw.title = t.name;
    sw.onclick = async () => {
      applyTheme(idx, i);
      await commit();
      render();
    };
    swatches.appendChild(sw);
  });
  bodyEl.appendChild(row("색 테마", "배경·글자·강조 색을 한 번에 바꿉니다.", swatches));

  const bg = document.createElement("input");
  bg.type = "color";
  bg.value = idx.bg;
  bg.addEventListener("input", () => {
    idx.bg = bg.value;
    idx.theme = -1;
  });
  bg.addEventListener("change", () => commit());

  const fg = document.createElement("input");
  fg.type = "color";
  fg.value = idx.fg;
  fg.addEventListener("input", () => {
    idx.fg = fg.value;
    idx.theme = -1;
  });
  fg.addEventListener("change", () => commit());

  const colors = el("div", "color-pair");
  colors.append(el("label", null, "배경"), bg, el("label", null, "글자"), fg);
  bodyEl.appendChild(row("직접 지정", "테마 대신 원하는 색을 고릅니다.", colors));

  const op = document.createElement("input");
  op.type = "range";
  op.min = "25";
  op.max = "100";
  op.step = "5";
  op.value = idx.opacity;
  const opv = el("span", null, idx.opacity + "%");
  opv.style.fontSize = "11.5px";
  opv.style.minWidth = "34px";
  op.addEventListener("input", () => {
    idx.opacity = Number(op.value);
    opv.textContent = op.value + "%";
  });
  op.addEventListener("change", () => commit());
  const opWrap = el("div", "row-ctrl");
  opWrap.append(op, opv);
  bodyEl.appendChild(row("불투명도", "메모 배경이 비치는 정도입니다.", opWrap));

  bodyEl.appendChild(el("div", "section-title", "모양"));

  bodyEl.appendChild(
    row("메모 비율", "손잡이 높이를 기준으로 크기가 정해집니다.", select(RATIOS.map((r) => ({ id: r.id, label: r.label })), idx.ratio, async (v) => {
      idx.ratio = v;
      await commit();
    }))
  );

  if (state.indexes.length > 1) {
    const del = el("button", "btn danger", "이 인덱스 삭제");
    del.onclick = async () => {
      const at = state.indexes.findIndex((i) => i.id === idx.id);
      state.indexes.splice(at, 1);
      // R-07 — 표시 중이던 마지막 인덱스를 지웠을 때 전부 숨김이 되지 않게 첫 인덱스를 다시 표시.
      ensureOneVisible();
      if (state.common.lastIndexId === idx.id) {
        const v = state.indexes.find((i) => i.hidden !== true) || state.indexes[0];
        if (v) state.common.lastIndexId = v.id;
      }
      tab = "common";
      await commit("인덱스를 삭제했어요");
      render();
    };
    bodyEl.appendChild(row("삭제", "이 인덱스의 메모도 함께 지워집니다.", del));
  }
}

/* ---------------- reminders (D-2) ---------------- */

// 예약된 리마인더 전체 목록 + 추가 폼. 해제는 항목을 남긴 채 발화만 끄고(켜기로 복귀),
// 삭제는 목록에서 지운다 — 둘 다 코어 함수를 거쳐 즉시 저장·스케줄 재동기화된다.
function renderReminders() {
  bodyEl.innerHTML = "";
  bodyEl.appendChild(el("p", "hint-top", "시각이 되면 스트립 옆에 알림이 뜹니다. 클릭하면 그 메모가 열립니다."));

  // --- 추가 폼 ---
  bodyEl.appendChild(el("div", "section-title", "리마인더 추가"));
  const idxSel = select(
    state.indexes.map((i) => ({
      id: i.id,
      label: (i.title || "메모") + (i.hidden === true ? " (숨김)" : ""),
    })),
    state.indexes[0] && state.indexes[0].id,
    () => {}
  );
  idxSel.id = "remAddIndex";
  const atInput = document.createElement("input");
  atInput.type = "datetime-local";
  atInput.id = "remAddAt";
  atInput.value = toLocalIso(new Date(Date.now() + 3600000));
  const repSel = select(
    [
      { id: "none", label: "반복 없음" },
      { id: "daily", label: "매일" },
      { id: "weekly", label: "매주" },
    ],
    "none",
    () => {}
  );
  repSel.id = "remAddRepeat";
  const addBtn = el("button", "btn primary", "+ 리마인더 추가");
  addBtn.id = "remAddBtn";
  addBtn.onclick = async () => {
    const indexId = idxSel.value;
    const at = atInput.value;
    if (!at) {
      status("알림 시각을 골라주세요");
      return;
    }
    const r = await setReminder(indexId, { at, repeat: repSel.value });
    if (!r) {
      status("시각 형식이 올바르지 않아요");
      return;
    }
    status("리마인더를 추가했어요");
    render();
  };
  const addWrap = el("div", "rem-add");
  addWrap.append(idxSel, atInput, repSel, addBtn);
  bodyEl.appendChild(addWrap);

  // --- 목록 ---
  const items = listReminders(state);
  bodyEl.appendChild(el("div", "section-title", `예약된 리마인더 ${items.length ? `(${items.length})` : ""}`));
  if (!items.length) {
    bodyEl.appendChild(el("p", "hint-top", "설정된 리마인더가 없어요. 메모 패널의 시계 버튼이나 위 폼으로 추가할 수 있어요."));
    return;
  }
  const now = Date.now();
  const list = el("div", "rem-rows");
  items.forEach(({ idx, r }) => {
    const st = reminderStatus(r, now);
    const rowEl = el("div", "rem-row" + (r.enabled === true ? "" : " off"));

    const left = el("div", "rem-left");
    const head = el("div", "rem-head");
    const dot = el("span", "dot");
    dot.style.background = idx.accent;
    head.append(dot, el("span", "rem-idx", idx.title || "메모"));
    const when = el("div", "rem-when" + (st.code === "missed" ? " overdue" : ""), fmtReminderAt(r.at));
    left.append(head, when);

    const mid = el("div", "rem-mid");
    mid.appendChild(el("span", "rem-rep", repeatLabel(r.repeat)));
    const badge = el("span", "rem-badge" + (st.code === "missed" ? " overdue" : ""), REM_STATUS_LABEL[st.code] || "");
    mid.appendChild(badge);
    if (r.note) mid.appendChild(el("span", "rem-note", r.note));

    const ctrl = el("div", "row-ctrl");
    const offBtn = el("button", "btn", r.enabled === true ? "해제" : "켜기");
    offBtn.onclick = async () => {
      const want = !(r.enabled === true); // setReminderEnabled가 r.enabled를 바꾸기 전에 의도를 먼저 잡는다
      await setReminderEnabled(idx.id, r.id, want);
      status(want ? "리마인더를 다시 켰어요" : "리마인더를 해제했어요");
      render();
    };
    const delBtn = el("button", "btn danger", "삭제");
    delBtn.onclick = async () => {
      await removeReminder(idx.id, r.id);
      status("리마인더를 삭제했어요");
      render();
    };
    ctrl.append(offBtn, delBtn);

    rowEl.append(left, mid, ctrl);
    list.appendChild(rowEl);
  });
  bodyEl.appendChild(list);
}

/* ---------------- 저장 (D-3) ---------------- */

// get_data_dir의 표시 계약은 {path, effectivePath, isDefault} — path는 config.json의
// 설정값(무효·폴백 중이어도 그대로), effectivePath는 store.json이 실제 있는 폴더.
// set_data_dir는 즉시 적용(포인터 재해석)이라 성공 시 "재시작 필요" 안내가 아니라
// 즉시 적용 메시지를 띄운다.

// 긴 경로의 중간 생략 — 앞 24자 + … + 뒤 28자 (D-3 "길면 중간 생략").
function ellipsizePath(p) {
  const s = String(p || "");
  if (s.length <= 56) return s;
  return s.slice(0, 24) + "…" + s.slice(-28);
}

// 설정값(path)과 실효 경로(effectivePath)의 철자 차이 흡수 — 폴백 감지용.
function normDir(s) {
  return String(s || "")
    .replace(/[\\/]+/g, "\\")
    .replace(/\\+$/, "")
    .toLowerCase();
}

// 폴더 선택 결과(또는 null=기본값 복귀)를 코어에 적용한다. 다이얼로그와 분리된
// 진입점이라 CDP가 오류 경로를 그대로 검증할 수 있다 (plan_setup/cdp-storage-ui.cjs).
// 성공 시 표시를 최신 get_data_dir로 갱신, 실패 시 오류 문구만 남기고 기존 경로 유지.
export async function applyDataDir(path) {
  storageError = "";
  try {
    await invoke("set_data_dir", { path: path ?? null });
    status(path ? "저장 폴더를 변경했어요 · 기존 메모를 새 폴더로 복사했어요" : "기본 저장 폴더로 되돌렸어요");
  } catch (err) {
    storageError = String(err && err.message ? err.message : err);
    status("저장 폴더를 바꾸지 못했어요 · 기존 폴더를 계속 사용합니다");
  }
  if (tab === "storage") render();
  return !storageError;
}

async function renderStorage() {
  // 비동기 렌더 — 탭을 열 때마다 실효 경로를 다시 읽는다(다른 창·외부에서 바뀐 경우 포함).
  // 응답이 늦게 와도 탭이 바뀌었거나 새 렌더가 시작됐으면 결과를 버린다.
  const my = ++storageSeq;
  bodyEl.innerHTML = "";
  bodyEl.appendChild(el("p", "hint-top", "메모와 설정이 저장되는 폴더입니다. 바꾸면 기존 데이터를 새 폴더로 복사하고 원본은 그대로 둡니다."));
  let info = null;
  let infoErr = "";
  try {
    info = await invoke("get_data_dir");
  } catch (err) {
    infoErr = String(err && err.message ? err.message : err);
  }
  if (my !== storageSeq || tab !== "storage") return;
  if (!info) {
    bodyEl.appendChild(el("div", "store-err", "저장 폴더 정보를 읽지 못했어요 · " + infoErr));
    return;
  }

  bodyEl.appendChild(el("div", "section-title", "저장 폴더"));

  // 지정 폴더가 무효(삭제·권한)면 코어가 기본 폴더로 폴백한다 — 설정값과 실효값이
  // 다르면 그 사실을 경고로 표시한다 (DataDirInfo.path의 의도된 용도).
  const fallback = !!info.path && normDir(info.path) !== normDir(info.effectivePath);

  const pathBtn = el("button", "btn store-path", ellipsizePath(info.effectivePath));
  pathBtn.id = "storagePath";
  pathBtn.title = info.effectivePath + " — 클릭하면 폴더를 엽니다";
  pathBtn.dataset.path = info.effectivePath; // 검증·접근용 원시 경로(title은 안내 문구가 붙는다)
  pathBtn.onclick = () => invoke("open_data_dir").catch(() => {});
  const kind = el("span", "rem-badge", fallback ? "폴백" : info.isDefault ? "기본" : "지정");
  kind.id = "storageKind";
  const pathCtrl = el("div", "row-ctrl");
  pathCtrl.append(kind, pathBtn);
  bodyEl.appendChild(
    row(
      "현재 저장 폴더",
      fallback ? "지정 폴더를 찾을 수 없어 기본 위치로 동작 중입니다." : info.isDefault ? "앱 기본 위치입니다." : "지정한 폴더입니다.",
      pathCtrl
    )
  );
  if (fallback) bodyEl.appendChild(el("div", "store-err", "지정된 폴더를 사용할 수 없습니다: " + info.path));

  const changeBtn = el("button", "btn", "폴더 변경…");
  changeBtn.id = "storageChange";
  changeBtn.onclick = async () => {
    const picked = await open({ directory: true, multiple: false, title: "메모 저장 폴더 선택" }).catch(() => null);
    if (!picked) return; // 취소 — 아무것도 바꾸지 않는다
    await applyDataDir(typeof picked === "string" ? picked : picked.path);
  };
  const resetBtn = el("button", "btn", "기본값으로 되돌리기");
  resetBtn.id = "storageReset";
  // 이미 기본이고 지정도 없으면 누를 필요가 없다 — 폴백(지정 남아있음)이면 포인터를
  // 지우는 경로라 활성 유지.
  resetBtn.disabled = !info.path && info.isDefault;
  resetBtn.onclick = () => applyDataDir(null);
  const chgCtrl = el("div", "row-ctrl");
  chgCtrl.append(changeBtn, resetBtn);
  bodyEl.appendChild(row("폴더 지정", "다른 폴더(동기화 폴더 포함)에 저장합니다.", chgCtrl));

  // 쓰기 불가·미존재 경로 선택 시 — 코어가 Err를 반환하고 기존 경로를 유지한다.
  const errLine = el("div", "store-err", storageError);
  errLine.id = "storageError";
  if (!storageError) errLine.style.display = "none";
  bodyEl.appendChild(errLine);

  bodyEl.appendChild(el("div", "section-title", "자동 불러오기"));
  const watchBadge = el("span", "rem-badge", "감시 중");
  watchBadge.id = "storageWatch";
  bodyEl.appendChild(
    row(
      "외부 변경 감시",
      "다른 프로그램이나 다른 컴퓨터가 저장 파일을 바꾸면 자동으로 다시 불러옵니다." +
        (lastExternalReload
          ? " 마지막 자동 불러오기: " +
            lastExternalReload.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
          : " 이번 실행에서는 아직 외부 변경이 없었습니다."),
      watchBadge
    )
  );
  // OQ-03 확정 정책 1줄 안내 (D-3 — 같은 탭에 안내만 추가).
  bodyEl.appendChild(
    el("p", "store-note", "외부 변경과 내 미저장 편집이 충돌하면 외부본을 적용하고 내 편집은 충돌본 파일(store.conflict-*.json)로 보관합니다.")
  );
}

/* ---------------- data ---------------- */

async function backup() {
  const path = await save({
    defaultPath: "guseok-memo-backup.json",
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!path) return;
  const clean = JSON.parse(JSON.stringify(state));
  await invoke("write_text_file", { path, content: JSON.stringify(clean, null, 2) });
  status("백업했어요 · " + path.split(/[\\/]/).pop());
}

async function restore() {
  const path = await open({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
  if (!path) return;
  try {
    const raw = await invoke("read_text_file", { path });
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.indexes)) throw new Error("형식이 올바르지 않습니다");
    Object.assign(state, migrate(parsed));
    await commit("복원했어요");
    render();
  } catch (err) {
    status("복원 실패: " + String(err));
  }
}

/* ---------------- boot ---------------- */

function render() {
  renderTabs();
  const idx = state.indexes.find((i) => i.id === tab);
  if (tab === "reminders") renderReminders();
  else if (tab === "storage") renderStorage();
  else if (idx) renderIndex(idx);
  else renderCommon();
}

function isInteracting() {
  const a = document.activeElement;
  return !!a && bodyEl.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName);
}

let renderQueued = false;
function renderUnlessBusy() {
  if (isInteracting()) {
    renderQueued = true;
    return;
  }
  renderQueued = false;
  render();
}
document.addEventListener("focusout", () => {
  if (renderQueued && !isInteracting()) setTimeout(renderUnlessBusy, 0);
});
document.addEventListener("pointerup", () => {
  if (renderQueued && !isInteracting()) renderUnlessBusy();
});

async function boot() {
  await initStore(async (_s, meta) => {
    // 외부/타 창 저장의 darkMode 변경을 즉시 반영 — html.dark 토글만이라
    // 입력 중인 컨트롤의 DOM을 건드리지 않는다.
    applyDarkMode(state.common.darkMode);
    // D-3 — 외부 저장본이 적용되면 저장 탭의 "마지막 자동 불러오기" 시각을 갱신한다.
    if (meta && meta.src === "external") lastExternalReload = new Date();
    renderUnlessBusy();
  });
  bindDarkMode(() => state.common.darkMode); // 초기 적용 + system 모드 OS 추적
  await listen("guseok://open-tab", (e) => {
    const t = e.payload?.tab;
    if (t === "index" && state.indexes[0]) tab = state.indexes[0].id;
    else if (t === "common") tab = "common";
    else if (t === "reminders") tab = "reminders";
    else if (t === "storage") tab = "storage";
    renderUnlessBusy();
  });
  try {
    monitors = await availableMonitors();
  } catch {
    monitors = [];
  }
  if (forcedTab === "index" && state.indexes[0]) tab = state.indexes[0].id;
  else if (forcedTab === "reminders") tab = "reminders";
  else if (forcedTab === "storage") tab = "storage";
  render();

  document.getElementById("closeBtn").onclick = () => win.close();
  document.getElementById("folderLink").onclick = (e) => {
    e.preventDefault();
    invoke("open_data_dir").catch(() => {});
  };
  getVersion()
    .then((v) => {
      appVersion = v;
      document.getElementById("versionLabel").textContent = "v" + v;
      render();
    })
    .catch(() => {});
  statusEl.textContent = "모든 변경은 자동 저장됩니다";
}

boot();


