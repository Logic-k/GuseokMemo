import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, getAllWindows } from "@tauri-apps/api/window";
import { state, migrate, defaultIndex, activeIndex, visibleIndexes, setIndexHidden, MAX_INDEXES } from "./store.js";
import { getLayout, panelRect } from "./layout.js";
import { extractText, search } from "./search.js";
import { applyTemplate, insertSnippet, snippetValues } from "./templates.js";

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

    // --- 다운그레이드 안전 (phase-06-task-02, TD-10) ---
    // 출시 태그 v0.2.4의 migrate() 알고리즘을 그대로 시뮬레이션한다 — 당시 코드는
    // 버전 분기 없이 defaultState(v1)·defaultIndex에 raw를 spread merge할 뿐이라
    // (git show v0.2.4:src/store.js) 미지 키가 원본 그대로 살아남는다. v2 store를
    // 넣어 구버전 앱이 신규 키를 파괴하지 않음을 단언한다.
    const migrateV1 = (raw) => {
      const base = {
        version: 1,
        common: { lastIndexId: "welcome1", openKey: "ctrl_shift_m" },
        indexes: [{ id: "welcome1", title: "할일", content: "", images: [] }],
      };
      const s = { ...base, ...(raw && typeof raw === "object" ? raw : {}) };
      s.common = { ...base.common, ...(raw && raw.common ? raw.common : {}) };
      if (!Array.isArray(s.indexes) || s.indexes.length === 0) s.indexes = base.indexes;
      const seen = new Set();
      s.indexes = s.indexes.slice(0, MAX_INDEXES).map((it, i) => {
        // v0.2.4 defaultIndex 축약형 — `{ ...d, ...item }` 순서라 raw 키가 기본값을 덮어쓴다.
        const d = { id: "", title: `메모 ${i + 1}`, content: "", images: [] };
        const item = it && typeof it === "object" ? it : {};
        const merged = { ...d, ...item, images: Array.isArray(item.images) ? item.images : [] };
        if (!merged.id || seen.has(merged.id)) merged.id = "sim" + i;
        seen.add(merged.id);
        return merged;
      });
      return s;
    };
    const v2File = {
      version: 2,
      common: { lastIndexId: "dg1", darkMode: "dark", notifyMethod: "sound" },
      indexes: [
        {
          id: "dg1", title: "숨김", content: "<p>유지</p>", hidden: true,
          reminders: [{ id: "rdg1", at: "2027-03-01T09:00", repeat: "daily", note: "n", enabled: false, lastFiredAt: null }],
          images: [{ src: "data:image/png;base64,x", ratio: "1:1", scale: 100 }],
        },
        { id: "dg2", title: "표시", content: "<p>두번째</p>", hidden: false, reminders: [] },
      ],
      templates: [{ id: "utd", name: "사용자템플릿", content: "<p>t</p>", builtin: false }],
      snippets: [{ id: "usd", name: "사용자스니펫", text: "x {date}", builtin: false }],
      futureTop: { keep: "me" },
    };
    // 구버전 앱의 load→save 왕복: migrate 결과를 JSON 직렬화한 저장본과 같은 조건으로 단언.
    const downSaved = JSON.parse(JSON.stringify(migrateV1(v2File)));
    check(
      "downgrade-v1-preserves-v2",
      downSaved.version === 2 &&
        downSaved.common.darkMode === "dark" &&
        downSaved.common.notifyMethod === "sound" &&
        downSaved.templates?.length === 1 && downSaved.templates[0].id === "utd" &&
        downSaved.snippets?.length === 1 && downSaved.snippets[0].id === "usd" &&
        downSaved.futureTop?.keep === "me" &&
        downSaved.indexes[0].hidden === true &&
        downSaved.indexes[0].reminders?.length === 1 &&
        downSaved.indexes[0].reminders[0].at === "2027-03-01T09:00" &&
        downSaved.indexes[0].content === "<p>유지</p>",
      `v=${downSaved.version} tpl=${(downSaved.templates || []).length} rem=${(downSaved.indexes[0].reminders || []).length}`
    );
    // 왕복 — 다운그레이드된 파일을 다시 v2 앱이 읽으면 declared=2라 STEPS를 건너뛰고
    // 신규 필드가 그대로여야 한다(데이터 유실 없는 재업그레이드 경로).
    const reup = migrate(downSaved);
    check(
      "downgrade-reupgrade-roundtrip",
      reup.version === 2 &&
        reup.templates[0].id === "utd" &&
        reup.snippets[0].id === "usd" &&
        reup.futureTop?.keep === "me" &&
        reup.indexes[0].hidden === true &&
        reup.indexes[0].reminders[0].id === "rdg1" &&
        reup.indexes[0].reminders[0].repeat === "daily" &&
        reup.indexes[0].reminders[0].enabled === false,
      `idx0.hidden=${reup.indexes[0].hidden} rem=${reup.indexes[0].reminders.length}`
    );

    // --- 템플릿/스니펫 코어 (phase-05-task-01, R-06) ---
    // 메모리 내 가짜 state로만 수행 — 실사용자 store의 templates/snippets는 건드리지 않는다.
    const mtpl = migrate({
      version: 1,
      indexes: [{ id: "tp1", title: "t" }],
      templates: [
        { id: "ut1", name: "주간", content: "<p>주간 본문</p>", builtin: false },
        { name: "필드누락" }, // id/content/builtin 누락 → 기본값 병합
        "junk", // 비객체 → 제거
      ],
      snippets: [
        { id: "us1", name: "인사", text: "안녕 {date}" },
        { text: "이름없음" }, // id/name/builtin 누락 → 기본값 병합
        42, // 비객체 → 제거
      ],
    });
    check(
      "migrate-templates-normalize",
      mtpl.templates.length === 2 &&
        mtpl.templates[0].id === "ut1" &&
        mtpl.templates[0].content === "<p>주간 본문</p>" &&
        mtpl.templates[0].builtin === false &&
        mtpl.templates[1].name === "필드누락" &&
        mtpl.templates[1].content === "" &&
        mtpl.templates[1].builtin === false &&
        typeof mtpl.templates[1].id === "string" &&
        mtpl.templates[1].id.length > 0,
      JSON.stringify(mtpl.templates)
    );
    check(
      "migrate-snippets-normalize",
      mtpl.snippets.length === 2 &&
        mtpl.snippets[0].id === "us1" &&
        mtpl.snippets[0].text === "안녕 {date}" &&
        mtpl.snippets[0].builtin === false &&
        mtpl.snippets[1].name === "" &&
        mtpl.snippets[1].text === "이름없음" &&
        typeof mtpl.snippets[1].id === "string" &&
        mtpl.snippets[1].id.length > 0,
      JSON.stringify(mtpl.snippets)
    );
    // v1 파일에 snippets 키가 없으면 기본 제공분으로 채운다 (mv = 위의 migrate(V1_STORE)).
    check(
      "migrate-snippets-default",
      Array.isArray(mv.snippets) &&
        mv.snippets.length >= 3 &&
        mv.snippets.every((s) => s.builtin === true && !!s.id && !!s.name && typeof s.text === "string"),
      `snippets=${(mv.snippets || []).length}`
    );

    // applyTemplate — 새 인덱스 content용 HTML 문자열 반환 (가짜 목록으로 단언).
    const fakeTpls = [
      { id: "ft1", name: "회의", content: "<h2>주간 회의</h2><p>안건</p>", builtin: true },
      { id: "ft2", name: "일지", content: "<p>{iso} 일지</p>", builtin: false },
    ];
    const newIdx = { content: "" };
    newIdx.content = applyTemplate("ft1", fakeTpls);
    check("template-apply-html", newIdx.content === "<h2>주간 회의</h2><p>안건</p>", newIdx.content.slice(0, 60));
    check(
      "template-apply-object",
      applyTemplate(fakeTpls[0], fakeTpls) === newIdx.content &&
        applyTemplate("없는id", fakeTpls) === "" &&
        applyTemplate(null, fakeTpls) === "" &&
        applyTemplate({}, fakeTpls) === "" &&
        applyTemplate("ft1", "not-array") === ""
    );
    // 템플릿 본문의 치환자도 삽입 시점 값으로 치환된다 ({iso} → YYYY-MM-DD).
    const tplIso = applyTemplate("ft2", fakeTpls);
    check("template-apply-subst", /^<p>\d{4}-\d{2}-\d{2} 일지<\/p>$/.test(tplIso), tplIso);
    // builtin 기본 템플릿은 migrate 결과에서 id로 바로 적용 가능하다.
    const builtinIdx = { content: "" };
    builtinIdx.content = applyTemplate("tpl2", mv.templates);
    check("template-builtin-apply", builtinIdx.content.includes("주간 회의"), builtinIdx.content.slice(0, 40));

    // insertSnippet — {date} 등 치환자를 ko-KR 로컬 실제 값으로 치환 (R-06).
    const year = String(new Date().getFullYear());
    const snDate = insertSnippet("{date}");
    check("snippet-date", snDate.includes(year + "년") && !/[{}]/.test(snDate), snDate);
    check(
      "snippet-values-map",
      (() => {
        const sv = snippetValues(new Date(2026, 4, 7, 9, 30));
        return sv.iso === "2026-05-07" && sv.time === "09:30" && sv.year === "2026" && sv.date.includes("2026년 5월 7일");
      })()
    );
    check(
      "snippet-values-override",
      insertSnippet("메모 {date} {time}", { date: "2026년 1월 2일 금요일", time: "09:05" }) ===
        "메모 2026년 1월 2일 금요일 09:05"
    );
    // 미지 치환자는 원문 보존, 아는 치환자만 치환.
    const snUnk = insertSnippet("a {zzz} b {date}");
    check("snippet-unknown-kept", snUnk.includes("{zzz}") && !snUnk.includes("{date}"), snUnk);
    check("snippet-repeat", insertSnippet("{time}~{time}", { time: "10:00" }) === "10:00~10:00");
    check("snippet-nontext", insertSnippet(null) === "" && insertSnippet("") === "" && insertSnippet(42) === "");
    check("snippet-custom-value", insertSnippet("작성자 {who}", { who: "QA" }) === "작성자 QA");
    // builtin 스니펫이 실제 치환 경로를 탄다.
    const builtinSn = mv.snippets.find((s) => s.id === "snip1");
    check("snippet-builtin", !!builtinSn && insertSnippet(builtinSn.text).includes(year + "년"), builtinSn && builtinSn.text);

    // 삽입 위치 — 커서 자리에 들어가는지 기존 에디터 경로(insertText)로 단언.
    editor.innerHTML = "<p>앞</p><p>뒤</p>";
    editor.focus();
    const snP = editor.querySelectorAll("p")[1];
    const snRange = document.createRange();
    snRange.setStart(snP.firstChild || snP, 0);
    snRange.collapse(true);
    const snSel = window.getSelection();
    snSel.removeAllRanges();
    snSel.addRange(snRange);
    document.execCommand("insertText", false, insertSnippet("[{iso}] "));
    await new Promise((r) => setTimeout(r, 30));
    check("snippet-insert-position", /^앞\[\d{4}-\d{2}-\d{2}\] 뒤$/.test(editor.textContent), editor.textContent.slice(0, 60));

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

    // --- 인덱스 표시/숨김 코어 (phase-05-task-02, R-07) ---
    // migrate()는 idx.hidden을 boolean으로 정규화한다 — literal true만 유지,
    // truthy-but-not-true·누락은 false (STEPS[1] + defaultIndex merge 경로).
    const mh = migrate({
      version: 2,
      indexes: [
        { id: "h1", title: "a", hidden: true },
        { id: "h2", title: "b", hidden: "yes" },
        { id: "h3", title: "c" },
        { id: "h4", title: "d", hidden: 1 },
      ],
    });
    check(
      "hidden-migrate-normalize",
      mh.indexes[0].hidden === true &&
        mh.indexes[1].hidden === false &&
        mh.indexes[2].hidden === false &&
        mh.indexes[3].hidden === false &&
        JSON.stringify(mh).includes('"hidden":true'),
      JSON.stringify(mh.indexes.map((i) => i.hidden))
    );
    // 전부 숨김 store는 migrate가 첫 인덱스를 자동 표시해 불변식을 유지한다.
    const mall = migrate({
      version: 2,
      indexes: [
        { id: "ah1", title: "x", hidden: true },
        { id: "ah2", title: "y", hidden: true },
      ],
    });
    check(
      "hidden-migrate-all-hidden",
      mall.indexes[0].hidden === false && mall.indexes[1].hidden === true,
      JSON.stringify(mall.indexes.map((i) => i.hidden))
    );

    // live state — 실제 state를 바꾸고 끝에서 원복한다(종료 시 스냅샷 복원이 한 번 더 보장).
    // 검증이 항상 성립하도록 visible이 2개 미만이면 임시 인덱스를 끼워 넣는다.
    const hPrevLast = state.common.lastIndexId;
    let hTmp = null;
    if (visibleIndexes().length < 2) {
      hTmp = { ...defaultIndex(0), id: "qahidden" + Date.now().toString(36), title: "QA숨김" };
      state.indexes.push(hTmp);
    }
    const hTarget = visibleIndexes().find((i) => i.id !== idx.id) || visibleIndexes()[0];
    const hWas = hTarget ? hTarget.hidden === true : false;
    const visBefore = visibleIndexes().length;

    const hidOk = hTarget ? await setIndexHidden(hTarget.id, true) : false;
    const rawHidden = JSON.parse(await invoke("load_store"));
    const storedHidden = (rawHidden.indexes || []).find((i) => i.id === (hTarget && hTarget.id));
    check(
      "hidden-toggle-save",
      !!hTarget && hidOk === true && hTarget.hidden === true && !!storedHidden && storedHidden.hidden === true &&
        visibleIndexes().length === visBefore - 1,
      `ok=${hidOk} stored=${storedHidden && storedHidden.hidden} vis=${visibleIndexes().length}`
    );

    // 숨긴 인덱스를 lastIndexId로 두면 activeIndex()는 첫 visible로 폴백한다.
    state.common.lastIndexId = hTarget.id;
    const act = activeIndex();
    check(
      "hidden-active-fallback",
      !!act && act.id !== hTarget.id && act.hidden !== true,
      `act=${act && act.id} last=${state.common.lastIndexId}`
    );
    state.common.lastIndexId = hPrevLast;

    // 레이아웃 — 스트립 손잡이 수량이 visible 개수를 따라간다.
    const layHid = await getLayout(state);
    check(
      "hidden-layout-count",
      layHid.count === Math.max(1, visibleIndexes().length) && visibleIndexes().length === visBefore - 1,
      `count=${layHid.count} vis=${visibleIndexes().length}`
    );

    // Ctrl+번호 — 패널의 실제 keydown 경로로 n번째 *visible* 인덱스가 열리는지 단언.
    // hTarget이 숨겨진 상태에서 Ctrl+1은 첫 visible(=hTarget 건너뜀)을 열어야 한다.
    {
      const sib = visibleIndexes()[0];
      state.common.lastIndexId = hTarget.id; // 숨긴 인덱스를 가리키게 둬 변경 관찰을 확실하게
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", ctrlKey: true, bubbles: true, cancelable: true }));
      const ctrlOk = await waitFor(() => state.common.lastIndexId === sib.id, 4000);
      check("hidden-ctrl-n-skip", ctrlOk && !!sib && sib.id !== hTarget.id, `lastId=${state.common.lastIndexId} want=${sib && sib.id}`);
    }

    // 마지막 visible 1개 보호 — 나머지를 전부 숨긴 뒤 마지막 1개는 숨김 거절.
    for (const i of visibleIndexes().slice(0, -1)) await setIndexHidden(i.id, true);
    const lastV = visibleIndexes()[0];
    const refused = await setIndexHidden(lastV.id, true);
    check(
      "hidden-last-one-guard",
      refused === false && lastV.hidden === false && visibleIndexes().length === 1,
      `refused=${refused} visible=${visibleIndexes().length}`
    );

    // 원복 — 숨긴 것들을 전부 표시로, 임시 인덱스 제거, lastIndexId 복원 후 저장.
    for (const i of state.indexes) i.hidden = false;
    if (hTarget) hTarget.hidden = hWas;
    if (hTmp) state.indexes = state.indexes.filter((i) => i.id !== hTmp.id);
    state.common.lastIndexId = hPrevLast;
    await save();

    // --- 외부 변경 감지 + 자동 리로드 (phase-04-task-02, R-05/TD-04) ---
    // 실제 store.json을 앱 밖에서 쓰는 것처럼 write_text_file로 직접 덮어쓴다 —
    // Rust mtime 폴링(2s)이 감지 → guseok://store(src:"external") emit → migrate()
    // 경유 반영까지 실제 파일 경로로 확인한다. 감지 기록은 qa_log의
    // "store-watch :: reload" 라인으로 단언한다(emit 시뮬레이션 아님).
    const dd = await invoke("get_data_dir");
    const storeFile = String(dd.effectivePath || "").replace(/[\\/]+$/, "") + "/store.json";
    const markerTitle = "QAEXT" + Date.now().toString(36);
    const nextStore = JSON.parse(JSON.stringify(state));
    const extTarget = nextStore.indexes.find((i) => i.id === idx.id) || nextStore.indexes[0];
    const prevExtTitle = extTarget.title;
    extTarget.title = markerTitle;
    extTarget.content = "<p>EXTERNAL_CONTENT</p>";
    // 포커스된 에디터 + IME 조합 중에 리로드가 와도 DOM·포커스가 유지돼야 한다(NFR-02) —
    // 외부 내용과 다른 probe를 넣어 두고 강제 교체되지 않음을 단언한다.
    editor.innerHTML = "<p>EXT_FOCUS_PROBE</p>";
    editor.focus();
    editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    await invoke("write_text_file", { path: storeFile, content: JSON.stringify(nextStore) });
    const extApplied = await waitFor(() => state.indexes.some((i) => i.title === markerTitle), 9000);
    const extHits = await waitQa("store-watch :: reload", 3000);
    check("external-reload", extApplied && !!extHits, `applied=${extApplied} qa=${extHits ? "logged" : "none"}`);
    check(
      "external-ime-focus",
      document.activeElement === editor && editor.innerHTML.includes("EXT_FOCUS_PROBE"),
      `focused=${document.activeElement === editor} dom=${editor.innerHTML.slice(0, 50)}`
    );
    editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    // 마커 정리 + idx 재바인딩 — 리로드로 state 객체가 통째 교체됐으므로 이후
    // 복원·저장이 새 state의 인덱스를 보게 한다.
    const extHit = state.indexes.find((i) => i.title === markerTitle);
    if (extHit) extHit.title = prevExtTitle;
    idx = state.indexes.find((i) => i.id === idx.id) || state.indexes[0];
    // 자기 저장 에코 억제 — save_store가 rename 후 스탬프를 추적하므로 폴링이
    // 우리 저장을 외부 변경으로 오인하면 reload 라인이 늘어난다. 한 주기+α 관찰.
    const reloadLines = (s) => s.split("\n").filter((l) => l.includes("store-watch :: reload")).length;
    const reloadBefore = reloadLines(await readQa());
    await save();
    await sleep(2600);
    check("external-self-echo", reloadLines(await readQa()) === reloadBefore, `reload lines stayed ${reloadBefore}`);

    // --- 검색 창 (phase-02-task-02, R-01/D-1) ---
    // setup에서 미리 생성된 "search" 창이 있고, show_search/hide_search 커맨드로
    // 표시·숨김이 돌아가는지 단언 (런타임 생성 금지 = BUG-18 회귀 방지).
    const allWins = await getAllWindows();
    const searchWin = allWins.find((w) => w.label === "search");
    check("search-window-exists", !!searchWin, allWins.map((w) => w.label).join(","));
    if (searchWin) {
      await invoke("show_search");
      let sVis = false;
      for (let i = 0; i < 30 && !sVis; i++) {
        await sleep(100);
        sVis = await searchWin.isVisible();
      }
      await invoke("hide_search");
      let sHid = false;
      for (let i = 0; i < 30 && !sHid; i++) {
        await sleep(100);
        sHid = !(await searchWin.isVisible());
      }
      check("search-window-show-hide", sVis && sHid, `shown=${sVis} hidden=${sHid}`);
    }
    // 구버전 store는 common merge로 searchKey 기본값을 채운다 (마이그레이션 불필요 경로).
    check("migrate-searchkey-default", migrate({ version: 2, indexes: [{ id: "x1", title: "x" }] }).common.searchKey === "ctrl_shift_f");
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





