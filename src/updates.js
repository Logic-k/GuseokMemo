// 자동 업데이트 — GitHub Release 의 latest.json 을 확인하고, 있으면 내려받아 설치 후 재시작한다.
// 릴리스 에셋: {제품명}_{버전}_x64-setup.exe + .sig + latest.json
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

let pending = null;

export async function checkForUpdate() {
  const u = await check();
  pending = u ?? null;
  return u;
}

export async function installUpdate(u, onProgress) {
  const update = u ?? pending;
  if (!update) return;
  await update.downloadAndInstall((ev) => {
    if (ev.event === "Progress" && onProgress) onProgress(ev.data.chunkLength);
  });
  await relaunch();
}
