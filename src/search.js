// search.js — 전체 검색 코어 (R-01, TD-06).
// 순수 로직만 담는다 — UI는 후속 태스크(phase-02-task-02)가 이 모듈을 소비한다.
// 검색 대상은 메모리 상의 state.indexes(제목 + 본문 HTML) — 디스크 읽기 없이
// 인덱스 ≤10개를 순차 매칭한다(TD-06: FTS 불필요).

// 스니펫: 첫 매칭 위치 전후로 이 길이(문자 수)만큼의 문맥을 발췌한다.
const SNIPPET_RADIUS = 40;

// 본문 HTML에서 사람이 읽는 텍스트만 추출한다.
// 체크박스 input·img 같은 비텍스트 노드는 제외하고(ck-text/li/h1~h3/p/div 텍스트는
// 포함), 블록 경계를 공백으로 두고 연속 공백을 정리해 반환한다.
export function extractText(html) {
  if (!html || typeof html !== "string") return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  // 비텍스트 노드 제거 — .ck input(체크박스)·이미지 등은 검색 대상이 아니다.
  doc.querySelectorAll("input, img, script, style, textarea, select, button").forEach((n) => n.remove());
  const BLOCK = /^(P|DIV|LI|H1|H2|H3|H4|H5|H6|UL|OL|BLOCKQUOTE|PRE|TABLE|TR|BR|HR)$/;
  const parts = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        parts.push(child.textContent || "");
      } else if (child.nodeType === 1) {
        if (BLOCK.test(child.tagName)) parts.push(" ");
        walk(child);
        if (BLOCK.test(child.tagName)) parts.push(" ");
      }
    }
  };
  walk(doc.body);
  return parts
    .join("")
    .replace(/\s+/g, " ") // 연속 공백·줄바꿈·&nbsp;를 하나의 공백으로
    .trim();
}

// haystack(소문자 정규화) 안 needle(소문자)의 비중복 등장 횟수.
function countMatches(hayLower, needleLower) {
  let n = 0;
  let pos = 0;
  while (needleLower && (pos = hayLower.indexOf(needleLower, pos)) !== -1) {
    n++;
    pos += needleLower.length;
  }
  return n;
}

// text[pos .. pos+len] 매칭을 중심으로 전후 문맥을 발췌한다. 잘린 쪽은 …로 표시.
function makeSnippet(text, pos, len) {
  const start = Math.max(0, pos - SNIPPET_RADIUS);
  const end = Math.min(text.length, pos + len + SNIPPET_RADIUS);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

// state.indexes를 순차 검색해 매칭 인덱스 목록을 돌려준다.
// 반환: [{ indexId, title, snippet, matches, titleMatch }]
//  - matches: 제목+본문의 총 매칭 수 (대소문자 무시)
//  - titleMatch: 제목에 매칭이 있었는지 — UI의 "제목 매칭" 표시용
//  - snippet: 본문 첫 매칭 전후 문맥 ~40자. 제목만 매칭이면 제목 문맥.
// 정책: 빈/공백 키워드는 검색하지 않음([]), hidden:true 인덱스는 제외(R-07),
// images[]는 대상이 아니다.
export function search(state, query) {
  const q = (query || "").trim();
  if (!q) return [];
  const needle = q.toLowerCase();
  const indexes = state && Array.isArray(state.indexes) ? state.indexes : [];
  const results = [];
  for (const idx of indexes) {
    if (!idx || typeof idx !== "object") continue;
    if (idx.hidden === true) continue; // R-07 — 숨긴 인덱스는 검색 대상 제외
    const title = typeof idx.title === "string" ? idx.title : "";
    const body = extractText(idx.content || "");
    const titleLower = title.toLowerCase();
    const bodyLower = body.toLowerCase();
    const titleMatches = countMatches(titleLower, needle);
    const bodyMatches = countMatches(bodyLower, needle);
    const matches = titleMatches + bodyMatches;
    if (matches === 0) continue;
    const bodyPos = bodyLower.indexOf(needle);
    const snippet =
      bodyPos >= 0
        ? makeSnippet(body, bodyPos, needle.length)
        : makeSnippet(title, titleLower.indexOf(needle), needle.length);
    results.push({ indexId: idx.id, title, snippet, matches, titleMatch: titleMatches > 0 });
  }
  return results;
}
