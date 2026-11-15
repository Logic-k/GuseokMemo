export const THEMES = [
  { name: "크림", bg: "#FDF3C9", fg: "#2E2A1E", accent: "#E9C866" },
  { name: "핑크", bg: "#FBDEE7", fg: "#4A2430", accent: "#F0A8BE" },
  { name: "블루", bg: "#DCEEFB", fg: "#16324A", accent: "#8CC6EC" },
  { name: "그린", bg: "#E2F4E0", fg: "#1F3A24", accent: "#9BD49A" },
  { name: "라벤더", bg: "#EDE6FB", fg: "#2E2148", accent: "#B9A3EC" },
];

export const RATIOS = [
  { id: "1:1", label: "1 : 1 (정사각)", v: 1 },
  { id: "4:3", label: "4 : 3", v: 4 / 3 },
  { id: "3:2", label: "3 : 2", v: 3 / 2 },
  { id: "16:9", label: "16 : 9", v: 16 / 9 },
  { id: "3:4", label: "3 : 4 (세로)", v: 3 / 4 },
  { id: "2:3", label: "2 : 3 (세로)", v: 2 / 3 },
];

export const FONTS = [
  { id: "system", label: "시스템 기본", css: '"Pretendard Variable", Pretendard, "Segoe UI", "Malgun Gothic", system-ui, sans-serif' },
  { id: "malgun", label: "맑은 고딕", css: '"Malgun Gothic", sans-serif' },
  { id: "nanum", label: "나눔고딕", css: '"NanumGothic", "Nanum Gothic", sans-serif' },
  { id: "gulim", label: "굴림", css: 'Gulim, "굴림", sans-serif' },
  { id: "dotum", label: "돋움", css: 'Dotum, "돋움", sans-serif' },
  { id: "batang", label: "바탕", css: 'Batang, "바탕", serif' },
  { id: "arial", label: "Arial", css: 'Arial, Helvetica, sans-serif' },
  { id: "georgia", label: "Georgia", css: 'Georgia, serif' },
  { id: "consolas", label: "Consolas", css: 'Consolas, "Courier New", monospace' },
];

export function ratioValue(id) {
  return (RATIOS.find((r) => r.id === id) || RATIOS[0]).v;
}

export function fontCss(id) {
  return (FONTS.find((f) => f.id === id) || FONTS[0]).css;
}

export function hexToRgba(hex, alpha) {
  const h = (hex || "#ffffff").replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function readableOn(hex) {
  const h = (hex || "#ffffff").replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.62 ? "#2A2A22" : "#FFFFFF";
}
