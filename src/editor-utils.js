// 에디터·마크다운·이미지 공용 순수/DOM 헬퍼 (panel.js에서 분리)

export function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

export function placeCaretEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

export function newParagraph() {
  const p = document.createElement("p");
  p.innerHTML = "<br>";
  return p;
}

export function insertAfter(node, block) {
  block.parentNode.insertBefore(node, block.nextSibling);
}

export function replaceBlock(block, node) {
  block.parentNode.replaceChild(node, block);
  return node;
}

export function caretInto(el) {
  const target = el.querySelector(".ck-text") || el;
  target.focus?.();
  placeCaretEnd(target);
}

export async function compressImage(file) {
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

export function htmlToMarkdown(root) {
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
