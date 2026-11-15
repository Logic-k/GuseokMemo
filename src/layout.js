import { invoke } from "@tauri-apps/api/core";
import { ratioValue } from "./themes.js";

export const STRIP_W = 40;
export const HANDLE_GAP = 7;

export async function getLayout(state) {
  const wa = await invoke("work_area", { which: state.common.monitor || "auto" });
  const count = Math.max(1, state.indexes.length);
  const maxStrip = wa.h * 0.84;
  const stripH = Math.min(maxStrip, count * 112 + (count - 1) * HANDLE_GAP);
  const hh = (stripH - (count - 1) * HANDLE_GAP) / count;
  const span = Math.max(0, wa.h - stripH);
  const y = wa.y + Math.round(span * (state.common.anchor ?? 0.5));
  const side = state.common.side === "left" ? "left" : "right";
  const x = side === "right" ? wa.x + wa.w - STRIP_W : wa.x;
  return { wa, count, stripH, hh, x, y, side, span };
}

export function panelRect(index, lay) {
  const ratio = ratioValue(index.ratio);
  let h = Math.max(340, Math.min(lay.wa.h * 0.55, 660));
  let w = Math.round(h * ratio);
  const maxW = lay.wa.w * 0.62;
  if (w > maxW) {
    w = Math.round(maxW);
    h = Math.round(w / ratio);
  }
  if (w < 336) {
    w = 336;
    h = Math.round(w / ratio);
  }
  const y = Math.max(lay.wa.y + 8, Math.min(lay.wa.y + lay.wa.h - h - 8, lay.y + lay.stripH / 2 - h / 2));
  const x = lay.side === "right" ? lay.wa.x + lay.wa.w - STRIP_W - w : lay.wa.x + STRIP_W;
  return { x, y, w, h };
}

