import { invoke } from "@tauri-apps/api/core";
import { availableMonitors } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { state, initStore, saveStore, defaultIndex, applyTheme, migrate, MAX_INDEXES, ensureOneVisible } from "./store.js";
import { THEMES, RATIOS, FONTS } from "./themes.js";

const win = getCurrentWindow();
const tabsEl = document.getElementById("tabs");
const bodyEl = document.getElementById("body");
const statusEl = document.getElementById("status");

const forcedTab = new URLSearchParams(location.search).get("tab");
let tab = "common";
let monitors = [];
let resetArmed = 0;
let appVersion = "";

const OPEN_KEYS = [
  { id: "ctrl_shift_m", label: "Ctrl + Shift + M" },
  { id: "alt_m", label: "Ctrl + Alt + M" },
  { id: "shift_space", label: "Ctrl + Shift + Space" },
  { id: "f9", label: "F9" },
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
      await invoke("register_shortcuts", { preset: v, enabled: true }).catch(() => {});
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
    sw.style.borderColor = i === idx.theme ? "#23252f" : "transparent";
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
  if (idx) renderIndex(idx);
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
  await initStore(async () => {
    renderUnlessBusy();
  });
  await listen("guseok://open-tab", (e) => {
    const t = e.payload?.tab;
    if (t === "index" && state.indexes[0]) tab = state.indexes[0].id;
    else if (t === "common") tab = "common";
    renderUnlessBusy();
  });
  try {
    monitors = await availableMonitors();
  } catch {
    monitors = [];
  }
  if (forcedTab === "index" && state.indexes[0]) tab = state.indexes[0].id;
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


