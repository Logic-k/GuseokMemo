// darkmode.js — 다크모드 코어 (phase-05-task-03, R-08/D-4).
//
// common.darkMode("light" | "dark" | "system")를 해석해 html 요소의 `dark`
// 클래스만 토글한다. 에디터 DOM·인라인 인덱스 테마(--bg/--fg/--accent/--hbg/--hfg)는
// 건드리지 않는다 — IME 조합(NFR-02)·메모 카드 고유색 유지(R-08) 계약.
// system은 matchMedia("(prefers-color-scheme: dark)")로 해석하고, change 리스너로
// OS 테마 변경을 실시간 추적한다 (창당 bindDarkMode 1회).

const media =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

// settings 공통 탭 select·CDP·selftest가 공유하는 모드 선택지 (D-4).
export const DARK_MODES = [
  { id: "light", label: "라이트" },
  { id: "dark", label: "다크" },
  { id: "system", label: "시스템 따르기" },
];

// mode → 실제 다크 적용 여부. 미지 값은 라이트로 흘러간다 (보수적 — 화면을 깨지 않는 쪽).
export function resolveDark(mode) {
  if (mode === "dark") return true;
  if (mode === "system") return media ? media.matches : false;
  return false;
}

// documentElement의 dark 클래스만 토글한다 (body/에디터 자식은 미변경).
// 반환값 = 적용된 다크 여부 — selftest·CDP 단언용.
export function applyDarkMode(mode) {
  const dark = resolveDark(mode);
  document.documentElement.classList.toggle("dark", dark);
  return dark;
}

let bound = false;

// 창 부팅 시 1회 — getMode()로 현재 모드를 즉시 적용하고 OS 테마 변경을 추적한다.
// store 수신(다른 창 저장·외부 리로드) 시에는 각 창이 applyDarkMode를 직접 호출한다.
export function bindDarkMode(getMode) {
  if (!bound && media) {
    bound = true;
    media.addEventListener("change", () => applyDarkMode(getMode()));
  }
  return applyDarkMode(getMode());
}
