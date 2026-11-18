// R-06 템플릿/스니펫 코어 (phase-05-task-01) — UI 없이 검증 가능한 순수 로직만 둔다.
// 템플릿 선택·스니펫 삽입 진입점과 IME 조합 중 삽입 금지(NFR-02)는 phase-05-task-04
// (UI)의 책임. 데이터는 store.json의 최상위 templates[]/snippets[]에 보존하고
// store.js migrate()가 {id,name,content|text,builtin} 형태로 정규화한다.
import { state } from "./store.js";

// 스니펫 치환자 테이블 — 로컬 시각, ko-KR 로케일 (R-06 "{date} 같은 치환자").
// now를 주입하면 결정적 테스트가 가능하다. 반환 키:
//   date     "2026년 5월 7일 목요일"
//   time     "09:30" (24시간제)
//   datetime "<date> <time>"
//   iso      "2026-05-07" (정렬·파일명용)
//   year/month/day  각각 "2026" / "5" / "7"
export function snippetValues(now = new Date()) {
  const d = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const date = d.toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });
  const time = d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
  return {
    date,
    time,
    datetime: `${date} ${time}`,
    iso: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    year: String(d.getFullYear()),
    month: String(d.getMonth() + 1),
    day: String(d.getDate()),
  };
}

// 스니펫 본문의 {name} 치환자를 실제 값으로 바꾼 평문을 반환한다 — 반환값은
// 기존 에디터 경로(execCommand("insertText"))에 그대로 넣을 수 있는 문자열.
// - values로 치환자를 추가·재정의할 수 있다(테스트 주입, 사용자 정의 치환자).
// - 테이블에 없는 치환자는 그대로 둔다 — 오타·미지원 치환자가 조용히 사라지는
//   것보다 원문 보존이 안전하다.
// - 치환자 키는 대소문자를 가리지 않고 앞뒤 공백을 허용한다 ("{ Date }").
export function insertSnippet(text, values = {}) {
  const src = typeof text === "string" ? text : "";
  const table = { ...snippetValues(), ...(values && typeof values === "object" ? values : {}) };
  return src.replace(/\{([^{}]+)\}/g, (m, key) => {
    const k = key.trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(table, k) && table[k] != null ? String(table[k]) : m;
  });
}

// 템플릿 적용 — 새 인덱스의 content로 넣을 HTML 문자열을 반환한다.
// templateOrId는 템플릿 객체이거나 목록 안의 id. 찾지 못하거나 content가
// 문자열이 아니면 ""를 반환한다(빈 본문 = 템플릿 미적용과 동일).
// templates 기본값은 현재 store의 목록 — 테스트는 가짜 목록을 넘긴다.
// 본문 안의 치환자도 스니펫과 같은 규칙으로 삽입 시점 값으로 치환한다 —
// "{iso} 회의록" 같은 템플릿이 가능해지고, builtin 템플릿에는 치환자가
// 없어 결과가 그대로라 기존 동작과 충돌하지 않는다.
export function applyTemplate(templateOrId, templates = state.templates) {
  const list = Array.isArray(templates) ? templates : [];
  const t =
    typeof templateOrId === "string"
      ? list.find((x) => x && typeof x === "object" && x.id === templateOrId)
      : templateOrId;
  if (!t || typeof t !== "object" || typeof t.content !== "string") return "";
  return insertSnippet(t.content);
}
