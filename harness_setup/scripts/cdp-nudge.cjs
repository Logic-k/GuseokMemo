// cdp-nudge.cjs -- rescue a stalled --selftest run.
// The app emits guseok://shortcut {action:"toggle"} 1.4s after setup; if handles.js
// has not finished registering its listener by then (slow boot), the emit is lost
// and the selftest panel never opens. This script nudges via CDP:
//   - if the selftest panel is HIDDEN -> emit one toggle (same path as the startup emit)
//   - if the panel is VISIBLE -> selftest is presumably running -> do nothing
// Requires the app started with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223
// and Node >= 22 (global fetch/WebSocket). Used by run-e2e.ps1 on timeout guard.
const CDP = "http://localhost:9223/json";

function evalOn(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("eval timeout")); }, 8000);
    ws.onopen = () => ws.send(JSON.stringify({
      id: 1, method: "Runtime.evaluate",
      params: { expression, awaitPromise: true, returnByValue: true },
    }));
    ws.onmessage = (m) => {
      const r = JSON.parse(m.data);
      if (r.id === 1) { clearTimeout(timeout); try { ws.close(); } catch {} resolve(r.result?.result?.value ?? r.result); }
    };
    ws.onerror = (e) => { clearTimeout(timeout); reject(e); };
  });
}

async function main() {
  const targets = await (await fetch(CDP)).json();
  const panel = targets.find((t) => t.url.includes("selftest=1")) || targets.find((t) => t.url.includes("panel=1"));
  const handles = targets.find((t) => t.url === "http://localhost:5183/" || t.url.endsWith(":5183/"));
  if (!panel || !handles) {
    console.log("nudge: targets missing", targets.map((t) => t.url).join(" | "));
    process.exit(2);
  }
  const visible = await evalOn(panel.webSocketDebuggerUrl,
    `import('/node_modules/@tauri-apps/api/window.js').then(m=>m.getCurrentWindow().isVisible()).catch(()=>null)`);
  console.log("nudge: panel visible =", visible);
  if (visible === false) {
    const r = await evalOn(handles.webSocketDebuggerUrl,
      `import('/node_modules/@tauri-apps/api/event.js').then(m=>m.emit('guseok://shortcut',{action:'toggle'})).then(()=>'emitted').catch(e=>'ERR:'+String(e))`);
    console.log("nudge: emit ->", r);
  } else {
    console.log("nudge: skipped (panel already open)");
  }
  process.exit(0);
}

main().catch((e) => { console.error("nudge error:", e && e.message ? e.message : e); process.exit(1); });
