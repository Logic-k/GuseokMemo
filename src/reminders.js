// reminders.js — 리마인더 UI·전달부 코어 (phase-03-task-02, R-02/03, DESIGN D-2).
//
// phase-03-task-01의 발화 코어(Rust 스케줄러 + store 스키마) 위에서, 설정/해제/삭제
// 변경 함수와 목록·상태 표시용 순수 헬퍼, 그리고 앱 내 토스트(OQ-02 확정)의 큐
// 로직을 제공한다. 시간 표현은 store 계약과 동일한 naive 로컬 ISO 문자열
// ("YYYY-MM-DDTHH:MM[:SS]") — Rust 스케줄러가 같은 문자열을 로컬 벽시계 일련초로
// 해석하므로 양쪽 판정이 일치한다.
//
// 저장은 setIndexHidden과 같은 패턴: 변경 함수가 saveStore({immediate:true})를
// 내부에서 호출한다 — save_store가 저장본을 파싱해 Rust 스케줄을 재동기화하므로
// 즉시 저장이 곧 스케줄 갱신 경로다.

import { state, indexById, saveStore, defaultReminder } from "./store.js";

/* ---------------- 로컬 ISO 파싱/표시 ---------------- */

// naive 로컬 시각 → Date (로컬 타임존 해석 = Rust의 벽시계 일련초와 동일 의미).
// "YYYY-MM-DD[THH:MM[:SS]]" — 'T' 또는 공백 구분 허용. 형식이 아니면 null.
export function parseLocal(iso) {
  if (typeof iso !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(iso.trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad2 = (n) => String(n).padStart(2, "0");

// Date → store 계약의 naive 로컬 ISO(분 정밀도). datetime-local 입력 값과 같은 형식.
export function toLocalIso(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 목록 표시용 — 올해는 "11월 19일 09:00", 해가 다르면 연도 포함.
export function fmtReminderAt(iso) {
  const d = parseLocal(iso);
  if (!d) return "시각 오류";
  const y = d.getFullYear() === new Date().getFullYear() ? "" : d.getFullYear() + "년 ";
  return `${y}${d.getMonth() + 1}월 ${d.getDate()}일 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function repeatLabel(repeat) {
  return { none: "반복 없음", daily: "매일", weekly: "매주" }[repeat] || "반복 없음";
}

/* ---------------- 상태 판정 (Rust plan_reminder의 JS 거울) ---------------- */

// T_k = anchor + k·period — 반복 리마인더의 "다음 발생". 로컬 날짜 필드에 일/주를
// 더해 벽시계 기준으로 계산한다 (Rust가 벽시계 일련초에 86400·604800을 더하는 것과
// 동치 — DST 전환도 로컬 시계 그대로).
export function nextOccurrence(anchor, repeat, after) {
  const stepDays = repeat === "daily" ? 1 : repeat === "weekly" ? 7 : 0;
  if (!stepDays || !(anchor instanceof Date) || !(after instanceof Date)) return null;
  const stepMs = stepDays * 86400000;
  const k = Math.floor((after.getTime() - anchor.getTime()) / stepMs) + 1;
  const d = new Date(anchor.getTime());
  if (k <= 0) return d; // anchor가 아직 미래 — 첫 발생은 anchor 자체
  d.setDate(d.getDate() + k * stepDays);
  return d;
}

// Rust plan_reminder와 같은 분류 — pending = 첫 T_k > lastFired.
//  - disabled : enabled !== true (해제된 리마인더는 목록에 남되 발화 안 함)
//  - invalid  : at 파싱 불가 (스케줄러도 대상에서 제외)
//  - fired    : 반복 없음 + lastFiredAt >= at — 이미 전달된 일회성
//  - missed   : enabled + 발생(pending) 시각이 now 이하인데 아직 미발화 — "지남"
//  - scheduled: 다음 발생이 미래
// 반환 { code, next } — next는 다음(또는 놓친) 발생 시각 Date.
export function reminderStatus(r, now = Date.now()) {
  if (!r || r.enabled !== true) return { code: "disabled", next: null };
  const at = parseLocal(r.at);
  if (!at) return { code: "invalid", next: null };
  const last = r.lastFiredAt ? parseLocal(r.lastFiredAt) : null;
  const isRepeat = r.repeat === "daily" || r.repeat === "weekly";
  if (!isRepeat) {
    if (last && last.getTime() >= at.getTime()) return { code: "fired", next: null };
    if (at.getTime() <= now) return { code: "missed", next: at };
    return { code: "scheduled", next: at };
  }
  const pending = last ? nextOccurrence(at, r.repeat, last) : at;
  if (pending && pending.getTime() <= now) return { code: "missed", next: pending };
  return { code: "scheduled", next: pending };
}

// 목록/뱃지 문구 — settings 리마인더 탭과 패널 팝오버가 같은 라벨을 쓴다.
export const REM_STATUS_LABEL = {
  disabled: "해제됨",
  invalid: "형식 오류",
  fired: "발화됨",
  missed: "지남",
  scheduled: "예약됨",
};

// 전체 인덱스의 리마인더를 평탄하게 — 설정 탭 목록용. 시각 순 정렬
// (파싱 불가·없음은 뒤). 숨긴 인덱스의 리마인더도 알림은 유효하므로 포함한다.
export function listReminders(s = state) {
  const out = [];
  for (const idx of (s && s.indexes) || []) {
    for (const r of (idx && idx.reminders) || []) out.push({ idx, r });
  }
  out.sort((a, b) => {
    const ta = parseLocal(a.r.at)?.getTime() ?? Infinity;
    const tb = parseLocal(b.r.at)?.getTime() ?? Infinity;
    return ta - tb;
  });
  return out;
}

/* ---------------- 변경 함수 (저장 내부 호출 = 스케줄 동기화) ---------------- */

// 새 리마인더 추가(기본) 또는 같은 id의 기존 항목 갱신. at은 필수·파싱 가능해야 함.
// 재설정 시 enabled=true·lastFiredAt=null로 되돌린다(새 약속 = 새 발화 대상).
// 반환 리마인더 객체 또는 null(인덱스 없음·at 무효).
export async function setReminder(indexId, { id, at, repeat = "none", note = "" } = {}) {
  const idx = indexById(indexId);
  if (!idx || !parseLocal(at)) return null;
  idx.reminders = Array.isArray(idx.reminders) ? idx.reminders : [];
  let r = id ? idx.reminders.find((x) => x.id === id) : null;
  if (r) {
    r.at = at;
    r.repeat = repeat;
    if (typeof note === "string") r.note = note;
    r.enabled = true;
    r.lastFiredAt = null;
  } else {
    r = { ...defaultReminder(), at, repeat, note: note || "" };
    idx.reminders.push(r);
  }
  await saveStore({ immediate: true });
  return r;
}

export async function removeReminder(indexId, reminderId) {
  const idx = indexById(indexId);
  if (!idx || !Array.isArray(idx.reminders)) return false;
  const next = idx.reminders.filter((r) => r && r.id !== reminderId);
  if (next.length === idx.reminders.length) return false;
  idx.reminders = next;
  await saveStore({ immediate: true });
  return true;
}

// 해제(enabled=false)는 항목을 남긴 채 발화만 끈다 — 켜기로 되돌릴 수 있다.
// 재활성화해도 lastFiredAt은 유지 — 이미 발화된 일회성은 되살아나지 않는다.
export async function setReminderEnabled(indexId, reminderId, enabled) {
  const idx = indexById(indexId);
  const r = idx && Array.isArray(idx.reminders) ? idx.reminders.find((x) => x.id === reminderId) : null;
  if (!r) return false;
  const want = enabled === true;
  if (r.enabled === want) return true;
  r.enabled = want;
  await saveStore({ immediate: true });
  return true;
}

// 발화/놓침 보고의 디스크 기록 — 전달부(handles 토스트 호스트)가 guseok://reminder
// 수신 시 호출한다. atIso는 이벤트의 발생 시각(at): 일회성은 lastFiredAt >= at가 돼
// inert로 수렴하고, 반복은 다음 발생으로 pending이 진행된다. 재시작 후 같은
// 놓침이 재보고되지 않게 하는 래치 역할.
export async function markReminderFired(indexId, reminderId, atIso) {
  const idx = indexById(indexId);
  const r = idx && Array.isArray(idx.reminders) ? idx.reminders.find((x) => x.id === reminderId) : null;
  if (!r || typeof atIso !== "string" || !atIso) return false;
  r.lastFiredAt = atIso;
  await saveStore({ immediate: true });
  return true;
}

/* ---------------- 토스트 큐 (D-2 앱 내 토스트, OQ-02) ---------------- */

export const TOAST_MAX = 3; // 화면에 동시에 보이는 토스트 수
export const TOAST_PENDING_MAX = 8; // 넘치면 가장 오래된 대기분을 버린다
export const TOAST_MS = 4000; // 각 토스트의 표시 시간
export const TOAST_W = 300;
export const TOAST_ITEM_H = 56;
export const TOAST_GAP = 8;
export const TOAST_PAD = 8;

// 아래 네 함수는 순수 배열 로직 — 타이머는 호출부(handles.js)가 관리한다.
// item = { reminderId, indexId, title, at, missed, note }.

// live가 가득 차기 전엔 live에, 아니면 pending에 담는다. 같은 reminderId는
// 먼저 빼고 넣어 중복이 쌓이지 않게 한다(반복 리마인더의 연속 발화).
export function toastEnqueue(live, pending, item) {
  const li = live.findIndex((t) => t.reminderId === item.reminderId);
  if (li >= 0) live.splice(li, 1);
  const pi = pending.findIndex((t) => t.reminderId === item.reminderId);
  if (pi >= 0) pending.splice(pi, 1);
  if (live.length < TOAST_MAX) {
    live.push(item);
    return "live";
  }
  pending.push(item);
  if (pending.length > TOAST_PENDING_MAX) pending.shift();
  return "pending";
}

export function toastRemove(live, pending, reminderId) {
  const li = live.findIndex((t) => t.reminderId === reminderId);
  if (li >= 0) {
    live.splice(li, 1);
    return "live";
  }
  const pi = pending.findIndex((t) => t.reminderId === reminderId);
  if (pi >= 0) {
    pending.splice(pi, 1);
    return "pending";
  }
  return null;
}

// 만료·닫힘으로 빈자리가 생기면 대기분을 순서대로 올린다. 올라간 항목 배열 반환.
export function toastPromote(live, pending) {
  const moved = [];
  while (live.length < TOAST_MAX && pending.length) {
    const it = pending.shift();
    live.push(it);
    moved.push(it);
  }
  return moved;
}
