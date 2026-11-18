import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { state, migrate } from "./store.js";
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

    // IME 조합 중 Enter/Backspace는 브라우저가 처리해야 한다 — ck 행 생성/삭제 가로채기 금지
    editor.innerHTML = '<div class="ck" data-ck="1"><input type="checkbox"><span class="ck-text">테</span></div>';
    const ckSel = editor.querySelector(".ck-text");
    const r9 = document.createRange();
    r9.selectNodeContents(ckSel); r9.collapse(false);
    const s9 = window.getSelection(); s9.removeAllRanges(); s9.addRange(r9);
    editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 30));
    check("ime-enter-no-row", editor.querySelectorAll(".ck").length === 1, `cks=${editor.querySelectorAll(".ck").length}`);
    editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 30));
    check("ime-enter-after-commit", editor.querySelectorAll(".ck").length === 2, `cks=${editor.querySelectorAll(".ck").length}`);

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

    // 패널 내 제목·투명도 직접 편집 회귀
    const titleEl = document.getElementById("titleInput");
    const opRange = document.getElementById("opacityRange");
    const opVal = document.getElementById("opacityVal");
    const prevTitle = idx.title;
    titleEl.value = "제목변경";
    titleEl.dispatchEvent(new Event("input", { bubbles: true }));
    check("title-edit-panel", idx.title === "제목변경", String(idx.title));
    idx.title = prevTitle;
    titleEl.value = prevTitle;

    const prevOpacity = idx.opacity;
    opRange.value = "55";
    opRange.dispatchEvent(new Event("input", { bubbles: true }));
    const bgVar = document.getElementById("card").style.getPropertyValue("--bg");
    check("opacity-panel", idx.opacity === 55 && opVal.textContent === "55%" && bgVar.includes("0.55"), `op=${idx.opacity} bg=${bgVar}`);
    idx.opacity = prevOpacity;
    opRange.value = String(prevOpacity);
    opRange.dispatchEvent(new Event("input", { bubbles: true }));

    check("placeholder-attr", editor.dataset.placeholder === "여기에 적어주세요", String(editor.dataset.placeholder));
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

    // 자기 저장 에코가 state 를 되돌리지 않는지 — 에코 도착 전 변경분이 살아 있어야 함
    const sBefore = state;
    const saveP = save();
    idx.title = "ECHO_PROBE";
    await saveP;
    await sleep(400);
    check("self-echo-skip", state === sBefore && state.indexes.find((i) => i.id === idx.id)?.title === "ECHO_PROBE", state === sBefore ? "kept" : "replaced");
    idx.title = "저장";

    // --- migrate v1 → v2 회귀 (phase-01-task-01, TD-03) ---
    // plan_setup/fixtures/store-v1.json과 동일 구조 — vite dev에서는 원본 fixture를 fetch해 단언.
    const V1_STORE = {
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
        lastIndexId: "i9x2ka",
      },
      indexes: [
        {
          id: "i9x2ka",
          title: "할일",
          theme: 0,
          bg: "#FDF3C9",
          fg: "#2E2A1E",
          accent: "#E9C866",
          fontSize: 18,
          font: "system",
          opacity: 100,
          ratio: "3:4",
          mode: "peek",
          content:
            '<div class="ck" data-ck="1"><input type="checkbox" checked=""><span class="ck-text">아침 메일 확인</span></div>' +
            '<div class="ck" data-ck="1"><input type="checkbox"><span class="ck-text">주간 보고서 초안</span></div><p><br></p>',
          images: [],
        },
        {
          id: "i4m7qz",
          title: "회의",
          theme: 2,
          bg: "#DCEEFB",
          fg: "#16324A",
          accent: "#8CC6EC",
          fontSize: 20,
          font: "malgun",
          opacity: 85,
          ratio: "4:3",
          mode: "ice",
          content: "<h2>주간 회의</h2><ul><li>지난주 진행 상황 공유</li><li>이번 주 우선순위 정리</li></ul><p><br></p>",
          images: [{ src: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//", ratio: "16:9", scale: 120 }],
        },
      ],
    };
    let v1 = V1_STORE;
    let v1Src = "inline";
    try {
      const fres = await fetch("/plan_setup/fixtures/store-v1.json");
      if (fres.ok) {
        v1 = await fres.json();
        v1Src = "fixture";
      }
    } catch {}
    const mv = migrate(v1);
    check(
      "migrate-v1-to-v2",
      mv.version === 2 &&
        mv.common.darkMode === "system" &&
        mv.common.notifyMethod === "panel" &&
        Array.isArray(mv.templates) &&
        mv.templates.length === 3 &&
        mv.templates.every((t) => t.builtin === true && !!t.id && !!t.name) &&
        mv.indexes.length === v1.indexes.length &&
        mv.indexes.every((i) => i.hidden === false && Array.isArray(i.reminders)),
      `src=${v1Src} idx=${mv.indexes.length} tpl=${(mv.templates || []).length}`
    );
    // TD-10: 알 수 없는 키 보존 + 기존 데이터 유지 (다운그레이드 안전)
    const mvKeep = migrate({ ...V1_STORE, futureField: { nested: 1 } });
    check(
      "migrate-keep-unknown",
      mvKeep.futureField?.nested === 1 &&
        mvKeep.indexes[0].content === V1_STORE.indexes[0].content &&
        mvKeep.indexes[1].images.length === 1 &&
        mvKeep.common.lastIndexId === V1_STORE.common.lastIndexId
    );
    // 구버전 백업(필드 일부 누락·형식 오류) — settings 복원 경로(migrate→Object.assign)와 동일하게 정규화
    const oldBackup = {
      version: 1,
      indexes: [
        { id: "old1", title: "옛 메모", content: "<p>보존</p>" },
        "not-an-object",
        { id: "old1", title: "중복 id" },
        { id: "old2", title: "형식 오류", reminders: "bad", hidden: true },
        { id: "old3", title: "리마인더", reminders: [{ at: "2027-01-01T09:00" }, 42] },
      ],
    };
    const mb = migrate(oldBackup);
    const restored = JSON.parse(JSON.stringify(state));
    Object.assign(restored, mb); // settings.js restore()의 Object.assign(state, migrate(parsed))와 동일 경로
    check(
      "migrate-old-backup",
      restored.version === 2 &&
        restored.indexes.length === 5 &&
        restored.indexes[0].content === "<p>보존</p>" &&
        restored.indexes[0].fontSize === 18 &&
        restored.indexes[0].hidden === false &&
        restored.indexes[2].id !== "old1" &&
        new Set(restored.indexes.map((i) => i.id)).size === restored.indexes.length &&
        restored.indexes[3].hidden === true &&
        restored.indexes[3].reminders.length === 0 &&
        restored.indexes[4].reminders.length === 1 &&
        restored.indexes[4].reminders[0].at === "2027-01-01T09:00" &&
        restored.indexes[4].reminders[0].repeat === "none" &&
        restored.indexes[4].reminders[0].enabled === true &&
        restored.common.darkMode === "system" &&
        restored.common.openKey === "ctrl_shift_m",
      `ids=${restored.indexes.map((i) => i.id).join(",")}`
    );
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





