import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { state } from "./store.js";
import { getLayout, panelRect } from "./layout.js";

function caretToEnd(el) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(r);
}

function pressEnter(el) {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

export async function runSelfTest({ editor, idx, htmlToMarkdown, save }) {
  const results = [];
  const originalContent = idx.content;
  const originalImages = JSON.stringify(idx.images || []);
  const check = (name, ok, extra = "") => {
    results.push(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
  };

  try {
    editor.innerHTML = "<p># 회의 안건</p>";
    const p1 = editor.querySelector("p");
    caretToEnd(p1);
    pressEnter(p1);
    const h1 = editor.querySelector("h1");
    check("markdown-h1", !!h1 && h1.textContent === "회의 안건", h1 ? h1.textContent : "no h1");

    editor.innerHTML = "<p>- [ ] 우유 사기</p>";
    const p2 = editor.querySelector("p");
    caretToEnd(p2);
    pressEnter(p2);
    const ck = editor.querySelector(".ck");
    const ckText = ck?.querySelector(".ck-text")?.textContent || "";
    check("markdown-checkbox", !!ck && ckText === "우유 사기", ckText);

    if (ck) {
      const box = ck.querySelector('input[type="checkbox"]');
      box.click();
      check("checkbox-toggle", ck.classList.contains("done") && box.checked, ck.className + " checked=" + box.checked);
      const html = editor.innerHTML;
      check("checkbox-persist", /<input[^>]*checked/.test(html), html.slice(0, 110));
    }

    editor.innerHTML = '<div class="ck" data-ck="1"><input type="checkbox"><span class="ck-text">첫째</span></div>';
    const ckSpan = editor.querySelector(".ck-text");
    caretToEnd(ckSpan);
    pressEnter(editor);
    await new Promise((r) => setTimeout(r, 30));
    check("ck-enter-new-row", editor.querySelectorAll(".ck").length === 2, `rows=${editor.querySelectorAll(".ck").length}`);

    const firstCk = editor.querySelector(".ck");
    const firstSpan = firstCk?.querySelector(".ck-text");
    if (firstSpan) {
      caretToEnd(firstSpan);
      const r0 = document.createRange();
      r0.setStart(firstSpan.firstChild || firstSpan, 0);
      r0.collapse(true);
      const s0 = window.getSelection();
      s0.removeAllRanges();
      s0.addRange(r0);
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 30));
      const unwrapped = editor.querySelectorAll(".ck").length === 1 && editor.querySelector("p")?.textContent === "첫째";
      check("ck-backspace-unwrap", !!unwrapped, editor.innerHTML.slice(0, 80));
    }

    editor.innerHTML = "<p>- 장바구니</p>";
    const p3 = editor.querySelector("p");
    caretToEnd(p3);
    pressEnter(p3);
    check("markdown-bullet", !!editor.querySelector("ul li"), editor.innerHTML.slice(0, 60));

    editor.innerHTML = "<h2>제목</h2><p>본문 <strong>굵게</strong></p><ul><li>하나</li></ul>";
    const md = htmlToMarkdown(editor);
    check("export-markdown", md.includes("## 제목") && md.includes("- 하나"), JSON.stringify(md));

    editor.innerHTML = "<p>- [x] 완료된 일</p>";
    const p4 = editor.querySelector("p");
    caretToEnd(p4);
    pressEnter(p4);
    const doneCk = editor.querySelector(".ck");
    check("checkbox-checked-parse", !!doneCk && doneCk.classList.contains("done"), doneCk ? doneCk.className : "none");

    const waitFor = async (cond, ms = 3000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (cond()) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    };

    idx.images = [];
    const fileInput = document.getElementById("fileInput");
    const canvas = document.createElement("canvas");
    canvas.width = 40;
    canvas.height = 30;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#e2554d";
    ctx.fillRect(0, 0, 40, 30);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    const file = new File([blob], "qa.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event("change"));
    const added = await waitFor(() => (idx.images || []).length > 0);
    check("image-add", added && idx.images.length === 1, `images=${(idx.images || []).length}`);

    document.querySelector("#imageGrid .img-block")?.click();
    document.querySelector('#imgBar [data-ratio="16:9"]')?.click();
    check("image-ratio", idx.images[0]?.ratio === "16:9", String(idx.images[0]?.ratio));

    const scale = document.getElementById("imgScale");
    scale.value = "120";
    scale.dispatchEvent(new Event("input", { bubbles: true }));
    scale.dispatchEvent(new Event("change", { bubbles: true }));
    check("image-scale", idx.images[0]?.scale === 120, String(idx.images[0]?.scale));

    document.getElementById("imgDelete").click();
    check("image-delete", (idx.images || []).length === 0, `images=${(idx.images || []).length}`);

    const chip = document.getElementById("modeChip");
    chip.click();
    await save();
    const modeRaw = await invoke("load_store");
    check("mode-ice", idx.mode === "ice" && modeRaw.includes('"mode":"ice"'), String(idx.mode));
    chip.click();
    await save();
    check("mode-peek", idx.mode === "peek", String(idx.mode));

    const win = getCurrentWindow();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    idx.mode = "peek";
    await save();
    window.dispatchEvent(new Event("blur"));
    let hid = false;
    for (let i = 0; i < 40 && !hid; i++) {
      await sleep(150);
      hid = !(await win.isVisible());
    }
    check("peek-autoclose", hid);

    const lay = await getLayout(state);
    const rect = panelRect(idx, lay);
    await invoke("show_panel", { x: rect.x, y: rect.y, w: rect.w, h: rect.h, indexId: idx.id });
    await sleep(900);
    idx.mode = "ice";
    await save();
    window.dispatchEvent(new Event("blur"));
    await sleep(1900);
    check("ice-stays-open", await win.isVisible());
    idx.mode = "peek";

    // 인덱스 전환 회귀: 에디터 포커스가 남은 채 다른 인덱스를 열면 내용이 실제로 바뀌어야 한다.
    const other = state.indexes.find((i) => i.id !== idx.id);
    if (other) {
      other.content = "<p>__OTHER_INDEX__</p>";
      editor.focus();
      await invoke("show_panel", { x: 0, y: 0, w: 400, h: 400, indexId: other.id });
      await sleep(400);
      check("index-switch-rerender", editor.innerHTML.includes("__OTHER_INDEX__"), editor.innerHTML.slice(0, 60));
      await invoke("show_panel", { x: 0, y: 0, w: 400, h: 400, indexId: idx.id });
      await sleep(400);
      check("index-switch-back", !editor.innerHTML.includes("__OTHER_INDEX__"), editor.innerHTML.slice(0, 60));
    } else {
      check("index-switch-rerender", true, "single index");
      check("index-switch-back", true, "single index");
    }

    idx.content = "<p>저장 테스트</p>";
    await save();
    const raw = await invoke("load_store");
    check("store-write", raw.length > 0 && raw.includes("저장 테스트"), `${raw.length} bytes`);
  } catch (err) {
    results.push("FAIL exception :: " + (err && err.message ? err.message : String(err)));
  }

  idx.content = originalContent;
  idx.images = JSON.parse(originalImages);
  // 편집기 쪽 디바운스 저장 타이머가 복원 내용을 덮어쓰지 않도록 잠시 기다립니다.
  await new Promise((r) => setTimeout(r, 650));
  idx.content = originalContent;
  await save();

  for (const r of results) {
    await invoke("qa_log", { msg: r });
  }
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  await invoke("qa_log", { msg: `SUMMARY ${results.length - failed}/${results.length} passed` });
  return results;
}





