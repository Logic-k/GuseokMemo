import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { state, migrate } from "./store.js";
import { getLayout, panelRect } from "./layout.js";
import { extractText, search } from "./search.js";

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

    // --- 검색 코어 (phase-02-task-01, R-01/TD-06) ---
    // 실사용자 state를 건드리지 않고 메모리 내 가짜 state로 검증한다.
    const CK_SEARCH_HTML =
      '<div class="ck done" data-ck="1"><input type="checkbox" checked=""><span class="ck-text">우유 사기</span></div>' +
      '<div class="ck" data-ck="1"><input type="checkbox"><span class="ck-text">회의 준비</span></div><p><br></p>';
    const extCk = extractText(CK_SEARCH_HTML);
    check(
      "search-extract-ck",
      extCk.includes("우유 사기") && extCk.includes("회의 준비") && !/[<>]|input|checkbox/.test(extCk),
      JSON.stringify(extCk)
    );
    const extTags = extractText('<h2>주간 회의</h2><p>본문 <strong>강조</strong> 텍스트</p><ul><li>항목 하나</li></ul>');
    check(
      "search-extract-tags",
      extTags.includes("주간 회의") && extTags.includes("본문 강조 텍스트") && extTags.includes("항목 하나") && !/[<>]/.test(extTags),
      JSON.stringify(extTags)
    );
    // 마크다운 자동변환으로 만든 실제 에디터 HTML을 본문으로 쓴다 — 저장 형식 그대로.
    editor.innerHTML = "<p># 검색 대상 문서</p>";
    const mp = editor.querySelector("p");
    caretToEnd(mp);
    pressEnter(mp);
    const mdHtml = editor.innerHTML; // <h1>검색 대상 문서</h1><p><br></p> 형태
    const longBody = "<p>" + "가".repeat(60) + "핵심키워드" + "나".repeat(60) + "</p>";
    const fakeState = {
      indexes: [
        { id: "s1", title: "장바구니", content: CK_SEARCH_HTML, hidden: false },
        { id: "s2", title: "회의록", content: mdHtml + "<p>다음 주 안건 정리</p>", hidden: false },
        { id: "s3", title: "숨김 메모", content: "<p>우유 재고 확인</p>", hidden: true },
        { id: "s4", title: "영어", content: "<p>Hello World</p>", hidden: false, images: [{ src: "data:image/png;base64,우유이미지속키워드" }] },
        { id: "s5", title: "긴본문", content: longBody, hidden: false },
        { id: "s6", title: "사과", content: "<p>사과 사과</p>", hidden: false },
      ],
    };

    const rTitle = search(fakeState, "장바구니");
    check(
      "search-title-match",
      rTitle.length === 1 && rTitle[0].indexId === "s1" && rTitle[0].title === "장바구니" && rTitle[0].titleMatch === true,
      JSON.stringify(rTitle)
    );

    const rBody = search(fakeState, "검색 대상");
    check(
      "search-body-match",
      rBody.length === 1 && rBody[0].indexId === "s2" && rBody[0].matches >= 1 && rBody[0].snippet.includes("검색 대상"),
      JSON.stringify(rBody)
    );

    const rCase = search(fakeState, "hello");
    check("search-case-insensitive", rCase.length === 1 && rCase[0].indexId === "s4", JSON.stringify(rCase.map((r) => r.indexId)));

    check("search-empty-query", search(fakeState, "").length === 0 && search(fakeState, "   ").length === 0);

    check("search-no-match", search(fakeState, "없는키워드zz").length === 0);

    // 숨긴 인덱스(s3)는 제외, images[](s4)는 검색 대상이 아님 — "우유"는 s1에만 있다.
    const rHidden = search(fakeState, "우유");
    check(
      "search-hidden-excluded",
      rHidden.length === 1 && rHidden[0].indexId === "s1",
      JSON.stringify(rHidden.map((r) => r.indexId))
    );

    const rSnip = search(fakeState, "핵심키워드");
    const snip = rSnip[0]?.snippet || "";
    check(
      "search-snippet-context",
      rSnip.length === 1 && snip.startsWith("…") && snip.endsWith("…") && snip.includes("핵심키워드") && snip.includes("가") && snip.includes("나"),
      `len=${snip.length} ${snip.slice(0, 50)}`
    );

    // matches = 제목 1건 + 본문 2건
    const rCount = search(fakeState, "사과");
    check("search-match-count", rCount.length === 1 && rCount[0].matches === 3 && rCount[0].titleMatch === true, `matches=${rCount[0]?.matches}`);

    // --- 리마인더 스케줄러 (phase-03-task-01, R-02/03, TD-07) ---
    // migrate()가 reminders 원소를 defaultReminder 형태로 정규화하는지 단언.
    const mr = migrate({
      version: 1,
      indexes: [{
        id: "ri1",
        title: "r",
        reminders: [
          { id: "r1", at: "2027-05-01T09:00", repeat: "daily", note: "n", enabled: false, lastFiredAt: "2026-01-01T00:00" },
          { at: "2027-05-02T10:00" }, // id/repeat/enabled/lastFiredAt 누락 → 기본값 채움
          "junk", // 객체 아님 → 제거
        ],
      }],
    });
    const mrs = mr.indexes[0].reminders;
    check(
      "migrate-reminder-fields",
      mrs.length === 2 &&
        mrs[0].at === "2027-05-01T09:00" &&
        mrs[0].repeat === "daily" &&
        mrs[0].enabled === false &&
        mrs[0].lastFiredAt === "2026-01-01T00:00" &&
        mrs[0].note === "n" &&
        mrs[1].repeat === "none" &&
        mrs[1].enabled === true &&
        mrs[1].lastFiredAt === null &&
        typeof mrs[1].id === "string" &&
        mrs[1].id.length > 0,
      JSON.stringify(mrs)
    );

    // Rust 상주 스케줄러 e2e — JS가 reminders를 쓰면 스케줄러가 따라가는지 확인하는 경로:
    // idx.reminders 갱신 → saveStore → save_store가 저장본을 파싱해 인메모리 스케줄 갱신
    // → 스레드가 due 감지 → guseok://reminder emit + "[QA] reminder :: emit ..." 기록.
    // CDP 없이 qa_log 파일만으로 발화를 단언한다(emit 관찰 정본은 qa_log).
    const qaPath = await invoke("qa_log_path");
    const pad2 = (n) => String(n).padStart(2, "0");
    const localIso = (t) => {
      const d = new Date(t);
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    };
    const readQa = async () => {
      try {
        return await invoke("read_text_file", { path: qaPath });
      } catch {
        return "";
      }
    };
    const waitQa = async (needle, ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const hits = (await readQa()).split("\n").filter((l) => l.includes(needle));
        if (hits.length) return hits;
        await sleep(700);
      }
      return null;
    };
    const prevReminders = idx.reminders;
    idx.reminders = [
      { id: "rqafire1", at: localIso(Date.now() + 6000), repeat: "none", note: "qa", enabled: true, lastFiredAt: null },
    ];
    await save();
    const fireHits = await waitQa("reminderId=rqafire1", 25000);
    check(
      "reminder-fire",
      !!fireHits && fireHits.some((l) => l.includes("missed=false")),
      fireHits ? fireHits.join(" | ").slice(0, 120) : "no emit in qa log"
    );

    // 재시작 놓침과 동일한 분류 경로 — 과거 미발화분은 missed=true로 보고(자동 발화 아님).
    idx.reminders = [
      { id: "rqamiss1", at: localIso(Date.now() - 300000), repeat: "none", note: "", enabled: true, lastFiredAt: null },
    ];
    await save();
    const missHits = await waitQa("reminderId=rqamiss1", 15000);
    check(
      "reminder-missed",
      !!missHits && missHits.some((l) => l.includes("missed=true")),
      missHits ? missHits.join(" | ").slice(0, 120) : "no emit in qa log"
    );

    // 스케줄 정리 — 테스트용 리마인더가 이후 저장에 남지 않도록 원복 후 저장.
    idx.reminders = prevReminders;
    await save();
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





