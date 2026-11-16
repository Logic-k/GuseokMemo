import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import { save } from "@tauri-apps/plugin-dialog";
import { state, initStore, saveStore, indexById } from "./store.js";
import { hexToRgba, fontCss } from "./themes.js";
import { runSelfTest } from "./selftest.js";
import { getLayout, panelRect } from "./layout.js";

const MAX_IMAGES = 5;
const win = getCurrentWindow();

const card = document.getElementById("card");
const panelEl = document.getElementById("panel");
const editor = document.getElementById("editor");
const editorWrap = document.getElementById("editorWrap");
const titleInput = document.getElementById("titleInput");
const modeChip = document.getElementById("modeChip");
const savedEl = document.getElementById("saved");
const toastEl = document.getElementById("toast");
const imageGrid = document.getElementById("imageGrid");
const imgBar = document.getElementById("imgBar");
const imgScale = document.getElementById("imgScale");
const fileInput = document.getElementById("fileInput");

let idx = null;
let opened = false;
let busy = false;
let pointerInside = false;
let closeTimer = 0;
let saveTimer = 0;
let selImg = -1;
let testing = false;
let openedAt = 0;
let selfTested = false;
let lastGeomKey = "";

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove("show"), 1400);
}

function flashSaved() {
  savedEl.classList.add("show");
  clearTimeout(savedEl._t);
  savedEl._t = setTimeout(() => savedEl.classList.remove("show"), 900);
}

function persist(delay = 400) {
  if (testing) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await saveStore();
    flashSaved();
  }, delay);
}

function applyStyle(target, touchEditor = true) {
  card.style.setProperty("--bg", hexToRgba(target.bg, Math.max(0.25, target.opacity / 100)));
  card.style.setProperty("--fg", target.fg);
  card.style.setProperty("--accent", target.accent);
  // 포커스된 편집기의 속성/스타일을 바꾸면 IME 조합이 깨진다 — 입력 중엔 에디터는 건드리지 않는다.
  if (!touchEditor) return;
  editor.style.fontSize = target.fontSize + "px";
  editor.style.fontFamily = fontCss(target.font);
  editor.spellcheck = !!state.common.spellcheck;
}

function ensureParagraphs() {
  const kids = Array.from(editor.childNodes);
  const hasBlock = kids.some((n) => n.nodeType === 1 && /^(P|DIV|UL|OL|H1|H2|H3|BLOCKQUOTE)$/.test(n.tagName));
  if (!hasBlock) {
    const p = document.createElement("p");
    kids.forEach((n) => p.appendChild(n));
    editor.innerHTML = "";
    editor.appendChild(p);
  }
  if (!editor.firstElementChild) editor.innerHTML = "<p><br></p>";
}

function normalizeChecklist() {
  editor.querySelectorAll(".ck").forEach((ck) => {
    let span = null;
    Array.from(ck.children).forEach((c) => {
      if (!span && c.classList && c.classList.contains("ck-text")) span = c;
    });
    if (!span) {
      span = document.createElement("span");
      span.className = "ck-text";
      ck.appendChild(span);
    }
    Array.from(ck.childNodes).forEach((n) => {
      if (n === span || (n.nodeType === 1 && n.tagName === "INPUT")) return;
      span.appendChild(n);
    });
    if (!span.firstChild) span.innerHTML = "<br>";
  });
}

function renderContent(target) {
  editor.innerHTML = target.content || "<p><br></p>";
  normalizeChecklist();
  ensureParagraphs();
  updateEmptyState();
}

let composing = false;
editor.addEventListener("compositionstart", () => { composing = true; });
editor.addEventListener("compositionend", () => { composing = false; updateEmptyState(); });
editor.addEventListener("blur", () => { composing = false; });

function updateEmptyState() {
  // 한글 IME 조합 중에 클래스를 바꾸면 조합이 끊긴다 — compositionend 뒤로 미룬다.
  if (composing) return;
  const empty = !editor.textContent.trim() && !editor.querySelector(".ck, ul, ol, h1, h2, h3, img");
  editor.classList.toggle("is-empty", empty);
}

function renderImages(target) {
  imageGrid.innerHTML = "";
  (target.images || []).forEach((im, i) => {
    const block = document.createElement("div");
    block.className = "img-block" + (i === selImg ? " sel" : "");
    block.style.aspectRatio = (im.ratio || "1:1").replace(":", "/");
    block.style.width = (im.scale || 100) + "%";
    block.style.justifySelf = "center";

    const img = document.createElement("img");
    img.src = im.src;
    img.alt = "";
    block.appendChild(img);

    const del = document.createElement("button");
    del.className = "img-del";
    del.textContent = "×";
    del.onclick = (e) => {
      e.stopPropagation();
      target.images.splice(i, 1);
      if (selImg >= target.images.length) selImg = -1;
      renderImages(target);
      saveStore();
    };
    block.appendChild(del);

    block.onclick = () => {
      selImg = selImg === i ? -1 : i;
      renderImages(target);
      updateImgBar(target);
    };
    imageGrid.appendChild(block);
  });
  updateImgBar(target);
}

function updateImgBar(target) {
  const im = (target.images || [])[selImg];
  if (!im) {
    imgBar.classList.add("hidden");
    return;
  }
  imgBar.classList.remove("hidden");
  imgBar.querySelectorAll("[data-ratio]").forEach((b) => {
    b.classList.toggle("on", (im.ratio || "1:1") === b.dataset.ratio);
  });
  imgScale.value = im.scale || 100;
}

function geomKey() {
  return (idx?.ratio || "") + "|" + (state.common.side || "right") + "|" + (state.common.monitor || "auto");
}

function render(target) {
  const switched = !idx || idx.id !== target.id;
  idx = target;
  applyStyle(target);
  if (document.activeElement !== titleInput) titleInput.value = target.title || "";
  modeChip.textContent = target.mode === "ice" ? "얼음" : "빼꼼";
  modeChip.dataset.mode = target.mode || "peek";
  if (switched || !editor.matches(":focus")) renderContent(target);
  renderImages(target);
  syncToolbar();
  lastGeomKey = geomKey();
}

function placeCaretEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

/* ---------------- rich text ---------------- */

function exec(cmd, value = null) {
  editor.focus();
  document.execCommand(cmd, false, value);
  syncToolbar();
  scheduleContentSave();
}

function syncToolbar() {
  if (composing) return; // 조합 중 queryCommandState 난사는 IME를 흔들 수 있다
  const map = { bold: "bold", italic: "italic", underline: "underline", strikeThrough: "strikeThrough" };
  document.querySelectorAll("[data-cmd]").forEach((btn) => {
    const cmd = btn.dataset.cmd;
    let on = false;
    try {
      on = document.queryCommandState(cmd);
    } catch {}
    btn.classList.toggle("on", !!on && !!map[cmd]);
  });
}

function scheduleContentSave(delay = 350) {
  if (testing) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!idx) return;
    idx.content = editor.innerHTML;
    await saveStore({ immediate: true });
    flashSaved();
  }, delay);
}

function currentBlock() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  let node = sel.getRangeAt(0).startContainer;
  if (node.nodeType === 3) node = node.parentElement;
  if (!node) return null;
  if (node === editor) return null;
  const block = node.closest("p, div, li, h1, h2, h3");
  if (!block || block === editor || !editor.contains(block)) return null;
  return block;
}

function caretAtBlockEnd(block) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return false;
  const r = sel.getRangeAt(0).cloneRange();
  const tail = document.createRange();
  tail.selectNodeContents(block);
  tail.setStart(r.endContainer, r.endOffset);
  return tail.toString().length === 0;
}

function ckFromSelection() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  let node = sel.anchorNode;
  if (!node) return null;
  if (node.nodeType === 3) node = node.parentElement;
  const ck = node && node.closest ? node.closest(".ck") : null;
  return ck && editor.contains(ck) ? ck : null;
}

function caretAtBlockStart(block) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
  const r = sel.getRangeAt(0);
  const head = document.createRange();
  head.selectNodeContents(block);
  try {
    head.setEnd(r.startContainer, r.startOffset);
  } catch {
    return false;
  }
  return head.toString().length === 0;
}

function newParagraph() {
  const p = document.createElement("p");
  p.innerHTML = "<br>";
  return p;
}

function insertAfter(node, block) {
  block.parentNode.insertBefore(node, block.nextSibling);
}

function replaceBlock(block, node) {
  block.parentNode.replaceChild(node, block);
  return node;
}

function caretInto(el) {
  const target = el.querySelector(".ck-text") || el;
  target.focus?.();
  placeCaretEnd(target);
}

function autoFormat(block) {
  const text = block.textContent || "";
  let m;

  if ((m = text.match(/^(#{1,3})\s+(.*)$/))) {
    const lvl = m[1].length;
    const h = document.createElement("h" + lvl);
    h.textContent = m[2];
    const p = newParagraph();
    const parent = block.parentNode;
    parent.replaceChild(h, block);
    parent.insertBefore(p, h.nextSibling);
    placeCaretEnd(p);
    return true;
  }

  if ((m = text.match(/^[-*]\s+\[( |x|X)\]\s*(.*)$/))) {
    const box = document.createElement("div");
    box.className = "ck";
    box.dataset.ck = "1";
    if (m[1].toLowerCase() === "x") box.classList.add("done");
    box.innerHTML =
      `<input type="checkbox"${m[1].toLowerCase() === "x" ? " checked" : ""}><span class="ck-text">` +
      escapeHtml(m[2]) +
      "</span>";
    const p = newParagraph();
    const parent = block.parentNode;
    parent.replaceChild(box, block);
    parent.insertBefore(p, box.nextSibling);
    placeCaretEnd(p);
    return true;
  }

  if ((m = text.match(/^[-*]\s+(.*)$/))) {
    const ul = document.createElement("ul");
    const li = document.createElement("li");
    li.textContent = m[1];
    ul.appendChild(li);
    const p = newParagraph();
    const parent = block.parentNode;
    parent.replaceChild(ul, block);
    parent.insertBefore(p, ul.nextSibling);
    placeCaretEnd(p);
    return true;
  }

  if ((m = text.match(/^\d+\.\s+(.*)$/))) {
    const ol = document.createElement("ol");
    const li = document.createElement("li");
    li.textContent = m[1];
    ol.appendChild(li);
    const p = newParagraph();
    const parent = block.parentNode;
    parent.replaceChild(ol, block);
    parent.insertBefore(p, ol.nextSibling);
    placeCaretEnd(p);
    return true;
  }

  if ((m = text.match(/^\*\*([^*]+)\*\*$/) || text.match(/^__([^_]+)__$/))) {
    block.innerHTML = "<strong>" + escapeHtml(m[1]) + "</strong>";
    const p = newParagraph();
    insertAfter(p, block);
    placeCaretEnd(p);
    return true;
  }

  if ((m = text.match(/^\*([^*]+)\*$/)) || (m = text.match(/^_([^_]+)_$/))) {
    block.innerHTML = "<em>" + escapeHtml(m[1]) + "</em>";
    const p = newParagraph();
    insertAfter(p, block);
    placeCaretEnd(p);
    return true;
  }

  if ((m = text.match(/^~~([^~]+)~~$/))) {
    block.innerHTML = "<s>" + escapeHtml(m[1]) + "</s>";
    const p = newParagraph();
    insertAfter(p, block);
    placeCaretEnd(p);
    return true;
  }

  return false;
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

editor.addEventListener("keydown", (e) => {
  // IME 조합 중엔 브라우저가 키를 소비해야 한다 — 커스텀 처리(새 행/행 삭제/커서 이동)가
  // 조합을 강제 확정시켜 한글이 "ㅌ 테스"처럼 갈라지는 원인.
  if (e.isComposing || e.key === "Process" || e.keyCode === 229) return;
  if (e.key === "Enter" && !e.shiftKey) {
    const ck = ckFromSelection();
    if (ck) {
      e.preventDefault();
      const next = document.createElement("div");
      next.className = "ck";
      next.dataset.ck = "1";
      next.innerHTML = '<input type="checkbox"><span class="ck-text"><br></span>';
      ck.parentNode.insertBefore(next, ck.nextSibling);
      caretInto(next);
      scheduleContentSave();
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const block = currentBlock();
    if (!block) {
      e.preventDefault();
      const p = newParagraph();
      editor.appendChild(p);
      placeCaretEnd(p);
      return;
    }
    if (block.tagName === "LI") return;
    if (caretAtBlockEnd(block) && autoFormat(block)) {
      e.preventDefault();
      scheduleContentSave();
    }
    return;
  }

  if (e.key === "Backspace") {
    const ck = ckFromSelection();
    if (!ck) return;
    const textEl = ck.querySelector(".ck-text");
    const text = (textEl?.textContent || "").trim();
    if (!text) {
      e.preventDefault();
      const prev = ck.previousElementSibling;
      ck.remove();
      if (prev) placeCaretEnd(prev); else { const p = newParagraph(); editor.appendChild(p); placeCaretEnd(p); }
      scheduleContentSave();
      updateEmptyState();
      return;
    }
    if (textEl && caretAtBlockStart(textEl)) {
      e.preventDefault();
      const p = document.createElement("p");
      p.textContent = textEl.textContent || "";
      ck.parentNode.replaceChild(p, ck);
      const range = document.createRange();
      range.setStart(p.firstChild || p, 0);
      range.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      scheduleContentSave();
      updateEmptyState();
    }
  }
});

editor.addEventListener("input", () => {
  lastTyping = Date.now();
  if (!idx) return;
  idx.content = editor.innerHTML;
  scheduleContentSave();
  updateEmptyState();
});

editor.addEventListener("paste", (e) => {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData("text/plain");
  document.execCommand("insertText", false, text);
});

editor.addEventListener("change", (e) => {
  const box = e.target.closest('.ck > input[type="checkbox"]');
  if (!box) return;
  box.parentElement.classList.toggle("done", box.checked);
  if (box.checked) box.setAttribute("checked", ""); else box.removeAttribute("checked");
  scheduleContentSave();
});

editor.addEventListener("keyup", syncToolbar);
editor.addEventListener("mouseup", syncToolbar);
document.addEventListener("selectionchange", () => {
  if (document.activeElement === editor) syncToolbar();
});

document.querySelectorAll("[data-cmd]").forEach((btn) => {
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", () => exec(btn.dataset.cmd));
});

document.getElementById("btnAlign").addEventListener("mousedown", (e) => e.preventDefault());
document.getElementById("btnAlign").addEventListener("click", () => {
  const order = ["justifyLeft", "justifyCenter", "justifyRight"];
  let cur = 0;
  try {
    if (document.queryCommandState("justifyCenter")) cur = 1;
    if (document.queryCommandState("justifyRight")) cur = 2;
  } catch {}
  exec(order[(cur + 1) % 3]);
});

document.getElementById("btnCheck").addEventListener("mousedown", (e) => e.preventDefault());
document.getElementById("btnCheck").addEventListener("click", () => {
  const block = currentBlock();
  const row = document.createElement("div");
  row.className = "ck";
  row.dataset.ck = "1";
  row.innerHTML = '<input type="checkbox"><span class="ck-text"><br></span>';
  if (block && block.tagName !== "LI") {
    if ((block.textContent || "").trim() === "" && !block.querySelector("input")) {
      block.parentNode.replaceChild(row, block);
    } else {
      block.parentNode.insertBefore(row, block.nextSibling);
    }
  } else {
    editor.appendChild(row);
  }
  caretInto(row);
  scheduleContentSave();
  // <br>을 비동기로 지우던 정리는 제거 — 생성 직후 타이핑이 시작되면 조합이 지워졌다.
});

/* ---------------- font size ---------------- */

function changeFont(delta) {
  if (!idx) return;
  idx.fontSize = Math.max(10, Math.min(40, (idx.fontSize || 18) + delta));
  editor.style.fontSize = idx.fontSize + "px";
  fontVal.textContent = idx.fontSize;
  saveStore();
}

const fontPop = document.getElementById("fontPop");
const fontVal = document.getElementById("fontVal");
document.getElementById("btnFont").addEventListener("click", () => {
  fontPop.classList.toggle("hidden");
  if (idx) fontVal.textContent = idx.fontSize;
});
document.getElementById("fontMinus").addEventListener("click", () => {
  changeFont(-1);
  if (idx) fontVal.textContent = idx.fontSize;
});
document.getElementById("fontPlus").addEventListener("click", () => {
  changeFont(1);
  if (idx) fontVal.textContent = idx.fontSize;
});
document.addEventListener("pointerdown", (e) => {
  if (!fontPop.classList.contains("hidden") && !e.target.closest("#fontPop") && !e.target.closest("#btnFont")) {
    fontPop.classList.add("hidden");
  }
});

editorWrap.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    changeFont(e.deltaY < 0 ? 1 : -1);
  },
  { passive: false }
);

/* ---------------- images ---------------- */

function pickImage() {
  busy = true;
  fileInput.value = "";
  fileInput.click();
}

document.getElementById("btnImage").addEventListener("click", pickImage);

fileInput.addEventListener("change", async () => {
  const files = Array.from(fileInput.files || []);
  busy = false;
  if (!files.length || !idx) return;
  for (const file of files) {
    if (idx.images.length >= MAX_IMAGES) {
      toast(`이미지는 메모당 ${MAX_IMAGES}개까지 넣을 수 있어요`);
      break;
    }
    try {
      const src = await compressImage(file);
      idx.images.push({ src, ratio: "1:1", scale: 100 });
    } catch {
      toast("이미지를 읽지 못했어요");
    }
  }
  renderImages(idx);
  await saveStore({ immediate: true });
  flashSaved();
});

async function compressImage(file) {
  const bitmap = await createImageBitmap(file);
  const max = 1400;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL("image/jpeg", 0.82);
}

imgBar.querySelectorAll("[data-ratio]").forEach((b) => {
  b.addEventListener("click", () => {
    const im = idx?.images?.[selImg];
    if (!im) return;
    im.ratio = b.dataset.ratio;
    renderImages(idx);
    saveStore();
  });
});

imgScale.addEventListener("input", () => {
  const im = idx?.images?.[selImg];
  if (!im) return;
  im.scale = Number(imgScale.value);
  const block = imageGrid.children[selImg];
  if (block) block.style.width = im.scale + "%";
});
imgScale.addEventListener("change", () => saveStore());

document.getElementById("imgDelete").addEventListener("click", () => {
  if (!idx || selImg < 0) return;
  idx.images.splice(selImg, 1);
  selImg = -1;
  renderImages(idx);
  saveStore();
});

/* ---------------- head / mode ---------------- */

titleInput.addEventListener("input", () => {
  if (!idx) return;
  idx.title = titleInput.value.slice(0, 8);
  persist(300);
});

titleInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    titleInput.blur();
    editor.focus();
    placeCaretEnd(editor);
  }
});

modeChip.addEventListener("click", () => {
  if (!idx) return;
  idx.mode = idx.mode === "ice" ? "peek" : "ice";
  modeChip.textContent = idx.mode === "ice" ? "얼음" : "빼꼼";
  modeChip.dataset.mode = idx.mode;
  saveStore();
  toast(idx.mode === "ice" ? "얼음 모드 · 화면에 고정" : "빼꼼 모드 · 자동으로 접힘");
});

document.getElementById("openSettings").addEventListener("click", () => invoke("open_settings"));

document.getElementById("btnExport").addEventListener("click", async () => {
  if (!idx) return;
  const name = (idx.title || "memo").replace(/[\\/:*?"<>|]/g, "_");
  busy = true;
  try {
    const path = await save({
      defaultPath: name + ".txt",
      filters: [
        { name: "텍스트", extensions: ["txt"] },
        { name: "마크다운", extensions: ["md"] },
      ],
    });
    if (!path) return;
    const isMd = path.toLowerCase().endsWith(".md");
    const body = isMd ? htmlToMarkdown(editor) : editor.innerText;
    await invoke("write_text_file", { path, content: body });
    toast("보냈어요 · " + path.split(/[\\/]/).pop());
  } finally {
    busy = false;
  }
});

function htmlToMarkdown(root) {
  const lines = [];
  root.querySelectorAll("h1,h2,h3,p,li,.ck,div").forEach((el) => {
    if (el.closest(".ck") && !el.classList.contains("ck")) return;
    if (el.closest("li") && el.tagName !== "LI") return;
    if (el.classList.contains("ck")) {
      const box = el.querySelector('input[type="checkbox"]');
      const txt = (el.textContent || "").trim();
      lines.push(`- [${box?.checked ? "x" : " "}] ${txt}`);
    } else if (el.tagName === "LI") {
      lines.push(`- ${el.textContent}`);
    } else if (/^H[123]$/.test(el.tagName)) {
      lines.push("#".repeat(Number(el.tagName[1])) + " " + el.textContent);
    } else {
      const t = el.textContent;
      if (t.trim()) lines.push(t);
    }
  });
  return lines.join("\n");
}

/* ---------------- window behaviour ---------------- */

let lastTyping = 0;

function scheduleClose() {
  if (!opened || idx?.mode === "ice" || busy) return;
  clearTimeout(closeTimer);
  const delay = Math.max(80, state.common.peekDelay || 350);
  const attempt = () => {
    if (!opened || idx?.mode === "ice" || busy) return;
    if (document.documentElement.matches(":hover")) pointerInside = true;
    if (pointerInside) {
      closeTimer = setTimeout(attempt, 500);
      return;
    }
    if (Date.now() - lastTyping < 1800) {
      closeTimer = setTimeout(attempt, 700);
      return;
    }
    closePanel();
  };
  closeTimer = setTimeout(attempt, delay);
}

async function closePanel() {
  opened = false;
  clearTimeout(closeTimer);
  await invoke("hide_panel");
}

function cancelClose() {
  clearTimeout(closeTimer);
}

document.addEventListener("mouseenter", () => {
  pointerInside = true;
  cancelClose();
});
document.addEventListener("mouseleave", () => {
  pointerInside = false;
  scheduleClose();
});
document.addEventListener("pointerenter", () => {
  pointerInside = true;
  cancelClose();
});
document.addEventListener("pointerleave", () => {
  pointerInside = false;
  scheduleClose();
});

window.addEventListener("blur", () => {
  if (Date.now() - openedAt < 700) return;
  scheduleClose();
});
window.addEventListener("focus", () => {
  busy = false;
  cancelClose();
  if (!document.documentElement.matches(":hover")) {
    pointerInside = false;
    scheduleClose();
  }
});

document.addEventListener("keydown", async (e) => {
  if ((e.ctrlKey || e.metaKey) && /^[0-9]$/.test(e.key)) {
    const n = e.key === "0" ? 10 : Number(e.key);
    const target = state.indexes[n - 1];
    if (target) {
      e.preventDefault();
      const lay = await getLayout(state);
      const r = panelRect(target, lay);
      state.common.lastIndexId = target.id;
      await invoke("show_panel", { x: r.x, y: r.y, w: r.w, h: r.h, indexId: target.id });
    }
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    closePanel();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (idx) idx.content = editor.innerHTML;
    saveStore({ immediate: true }).then(() => flashSaved());
  }
});

async function boot() {
  await initStore(async (next) => {
    panelEl.dataset.side = next.common.side || "right";
    const current = next.indexes.find((i) => i.id === idx?.id) || next.indexes[0];
    if (!current) return;
    const wasFocused = editor.matches(":focus");
    const pinned = idx;
    idx = current;
    const switched = !pinned || pinned.id !== current.id;
    // 같은 인덱스를 편집 중이면 외부 stale 내용 대신 화면의 실제 DOM을 상태에 되심는다 —
    // 그래야 대기 중인 저장이 방금 친 텍스트를 지우지 않는다.
    if (!switched) {
      if (wasFocused) idx.content = editor.innerHTML;
      if (document.activeElement === titleInput) idx.title = titleInput.value;
    }
    applyStyle(idx, switched || !wasFocused);
    if (document.activeElement !== titleInput) titleInput.value = idx.title || "";
    modeChip.textContent = idx.mode === "ice" ? "얼음" : "빼꼼";
    modeChip.dataset.mode = idx.mode || "peek";
    if (switched || (!wasFocused && pinned.content !== current.content)) renderContent(idx);
    if (switched || !wasFocused) renderImages(idx);
    const nextGeomKey = geomKey();
    if (opened && (switched || !wasFocused) && lastGeomKey && nextGeomKey !== lastGeomKey) {
      const lay = await getLayout(state);
      const r = panelRect(current, lay);
      try {
        await win.setSize(new LogicalSize(r.w, r.h));
        await win.setPosition(new LogicalPosition(r.x, r.y));
      } catch {}
    }
    lastGeomKey = nextGeomKey;
  });
  panelEl.dataset.side = state.common.side || "right";

  await listen("guseok://panel-open", (e) => {
    const target = indexById(e.payload?.id) || state.indexes[0];
    if (!target) return;
    // 다른 인덱스로 전환하기 전에 현재 에디터 내용을 이전 메모에 확정하고,
    // 표시 중인 인덱스를 lastIndexId 로 즉시 저장해 다른 창의 디바운스 저장에 밀리지 않게 한다.
    if (idx && idx.id !== target.id && !testing) idx.content = editor.innerHTML;
    state.common.lastIndexId = target.id;
    if (!testing) saveStore({ immediate: true });
    opened = true;
    cancelClose();
    openedAt = Date.now();
    pointerInside = document.documentElement.matches(":hover");
    selImg = -1;
    render(target);
    setTimeout(() => {
      editor.focus();
      placeCaretEnd(editor);
    }, 30);
    if (!selfTested && new URLSearchParams(location.search).has("selftest")) {
      selfTested = true;
      setTimeout(async () => {
        const snapshot = JSON.stringify(state);
        testing = true;
        clearTimeout(saveTimer);
        await runSelfTest({ editor, idx: target, htmlToMarkdown, save: () => saveStore({ immediate: true }) });
        await new Promise((r) => setTimeout(r, 500));
        const snap = JSON.parse(snapshot);
        state.indexes = snap.indexes;
        state.common = snap.common;
        idx = state.indexes.find((i) => i.id === target.id) || state.indexes[0];
        testing = false;
        selImg = -1;
        editor.innerHTML = idx.content || "<p><br></p>";
        render(idx);
        await saveStore({ immediate: true });
        const raw = await invoke("load_store");
        const ok = raw.length > 0 && raw === JSON.stringify(state);
        await invoke("qa_log", { msg: `${ok ? "PASS" : "FAIL"} store-restore :: ${raw.length} bytes` });
        render(idx);
      }, 700);
    }
  });

  const params = new URLSearchParams(location.search);
  if (params.get("preview") === "1") {
    document.body.classList.add("preview");
  }
}

boot();














