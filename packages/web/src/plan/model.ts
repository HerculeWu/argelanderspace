import i18n, { DEFAULT_LANGUAGE, type AppLanguage } from "../i18n";
import type { Plan, PlansFile, Task, TaskStatus } from "@argelanderspace/contracts";

// Pure plan-domain helpers (Stage 4): status maps, local-date arithmetic,
// progress, the today's-focus grouping, the timeline scale, and the task-array
// reorder operations the drag interactions persist. Everything here is a
// pure function so the behaviors are unit-testable without the DOM.

export type { Plan, PlansFile, Task, TaskStatus };

export const STATUS_ORDER: TaskStatus[] = ["todo", "doing", "blocked", "done"];

/** Localized status label, resolved at call time so a language switch takes
 *  effect (an explicit typed mapping — no key concatenation). */
export function statusLabel(s: TaskStatus): string {
  switch (s) {
    case "todo":
      return i18n.t("plan.status.todo");
    case "doing":
      return i18n.t("plan.status.doing");
    case "blocked":
      return i18n.t("plan.status.blocked");
    case "done":
      return i18n.t("plan.status.done");
  }
}

export const STATUS_ICON: Record<TaskStatus, string> = {
  todo: "circle",
  doing: "circle-dot",
  blocked: "circle-alert",
  done: "circle-check",
};

/** The status-button cycle (blocked is only reachable from the drawer/modal). */
export const STATUS_CYCLE: TaskStatus[] = ["todo", "doing", "done"];

export function nextStatus(s: TaskStatus): TaskStatus {
  const i = STATUS_CYCLE.indexOf(s);
  return STATUS_CYCLE[(i + 1) % STATUS_CYCLE.length] as TaskStatus;
}

export function emptyPlansFile(): PlansFile {
  return { version: 1, rev: 0, plans: [] };
}

/** done/total as a 0..100 percentage (0 when the plan has no tasks). */
export function planProgress(p: Plan): number {
  if (!p.tasks.length) return 0;
  return Math.round((p.tasks.filter((t) => t.status === "done").length / p.tasks.length) * 100);
}

// --------------------------------------------------------------------------- //
// Local dates — a `due` is a plain `YYYY-MM-DD` local calendar date
// --------------------------------------------------------------------------- //

const pad2 = (n: number) => String(n).padStart(2, "0");

export function toISO(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local `Date` for a `YYYY-MM-DD` string (never the UTC-parsing Date ctor). */
export function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y as number, (m as number) - 1, d);
}

export function addDaysISO(iso: string, days: number): string {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + days);
  return toISO(d);
}

export function todayISO(): string {
  return toISO(new Date());
}

/** Per-locale Intl options: day = short date, month = timeline month ticks. */
const DATE_FORMATS: Record<AppLanguage, { day: Intl.DateTimeFormatOptions; month: Intl.DateTimeFormatOptions }> = {
  "zh-CN": { day: { month: "long", day: "numeric" }, month: { year: "numeric", month: "long" } },
  en: { day: { month: "short", day: "numeric" }, month: { year: "numeric", month: "short" } },
};

/** The active i18next language narrowed to a known app locale. */
function dateLocale(): AppLanguage {
  const l = i18n.language;
  return l === "zh-CN" || l === "en" ? l : DEFAULT_LANGUAGE;
}

/** ISO-date → localized short date (month + day) via Intl, resolved at call
 *  time so a language switch takes effect. */
export function fmtDate(iso: string): string {
  const locale = dateLocale();
  return new Intl.DateTimeFormat(locale, DATE_FORMATS[locale].day).format(parseISODate(iso));
}

/** ISO datetime (`created_at`) → its local calendar date. */
export function dateOf(isoDatetime: string): string {
  const d = new Date(isoDatetime);
  return Number.isNaN(d.getTime()) ? todayISO() : toISO(d);
}

/** due badge state vs today: lexicographic compare IS chronological on ISO dates. */
export function dueState(due: string | undefined, today: string): "overdue" | "today" | "future" | null {
  if (!due) return null;
  if (due < today) return "overdue";
  if (due === today) return "today";
  return "future";
}

// --------------------------------------------------------------------------- //
// Today's-focus grouping
// --------------------------------------------------------------------------- //

export interface FocusItem {
  task: Task;
  plan: Plan;
}

export interface FocusGroup {
  key: "pinned" | "overdue" | "today" | "tomorrow";
  label: string;
  items: FocusItem[];
}

/**
 * Derived view (no extra storage): pinned (not done) → overdue → due today →
 * due tomorrow. A task lands in the FIRST group it matches; done tasks never
 * appear; empty groups are dropped by the caller. Group labels resolve at
 * call time so a language switch takes effect.
 */
export function focusGroups(plans: Plan[], today: string): FocusGroup[] {
  const tomorrow = addDaysISO(today, 1);
  const groups: FocusGroup[] = [
    { key: "pinned", label: i18n.t("plan.focus.groups.pinned"), items: [] },
    { key: "overdue", label: i18n.t("plan.focus.groups.overdue"), items: [] },
    { key: "today", label: i18n.t("plan.focus.groups.today"), items: [] },
    { key: "tomorrow", label: i18n.t("plan.focus.groups.tomorrow"), items: [] },
  ];
  for (const plan of plans) {
    for (const task of plan.tasks) {
      if (task.status === "done") continue;
      const item = { task, plan };
      if (task.focused) groups[0]?.items.push(item);
      else if (task.due && task.due < today) groups[1]?.items.push(item);
      else if (task.due === today) groups[2]?.items.push(item);
      else if (task.due === tomorrow) groups[3]?.items.push(item);
    }
  }
  return groups.filter((g) => g.items.length > 0);
}

// --------------------------------------------------------------------------- //
// Timeline scale (read-only view)
// --------------------------------------------------------------------------- //

export interface TimelineScale {
  t0: string;
  /** Span in days from t0 (≥ 1). */
  days: number;
  weekly: boolean; // < 6 weeks → week ticks, else month ticks
  ticks: { at: string; label: string }[];
}

/**
 * The axis covers every plan's created_at→due span, every task due, and
 * today. Ticks adapt: < 6 weeks → weekly (localized short date via fmtDate),
 * otherwise monthly (localized year+month via Intl in the active language).
 */
export function timelineScale(plans: Plan[], today: string): TimelineScale | null {
  if (!plans.length) return null;
  let lo = today;
  let hi = today;
  for (const p of plans) {
    const start = dateOf(p.created_at);
    if (start < lo) lo = start;
    if (p.due > hi) hi = p.due;
    for (const t of p.tasks) {
      if (t.due && t.due > hi) hi = t.due;
    }
  }
  const days = Math.max(1, Math.round((parseISODate(hi).getTime() - parseISODate(lo).getTime()) / 86_400_000));
  const weekly = days < 42;
  const ticks: { at: string; label: string }[] = [];
  if (weekly) {
    for (let k = 0; k <= days; k += 7) ticks.push({ at: addDaysISO(lo, k), label: fmtDate(addDaysISO(lo, k)) });
  } else {
    // first of each month intersecting the span, labeled with the year —
    // a bare month number is ambiguous the moment the span crosses a year boundary
    const locale = dateLocale();
    const monthFmt = new Intl.DateTimeFormat(locale, DATE_FORMATS[locale].month);
    const d = parseISODate(lo);
    d.setDate(1);
    if (toISO(d) < lo) d.setMonth(d.getMonth() + 1);
    while (toISO(d) <= hi) {
      ticks.push({ at: toISO(d), label: monthFmt.format(d) });
      d.setMonth(d.getMonth() + 1);
    }
  }
  return { t0: lo, days, weekly, ticks };
}

/** Date → 0..1 position on the axis (clamped so out-of-span dues hug an edge). */
export function timelineFrac(iso: string, scale: TimelineScale): number {
  const n = Math.round((parseISODate(iso).getTime() - parseISODate(scale.t0).getTime()) / 86_400_000);
  return Math.min(1, Math.max(0, n / scale.days));
}

// --------------------------------------------------------------------------- //
// Task-array reorder operations (drag results, persisted as the array order)
// --------------------------------------------------------------------------- //

function spliceMove<T>(arr: T[], from: number, to: number): T[] {
  const out = [...arr];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x as T);
  return out;
}

/**
 * List mode: move *activeId* to *overId*'s position among the tasks sharing
 * *status* (their order inside the full array IS the group order). The group
 * is reordered in place — tasks of other statuses keep their exact array
 * positions. Same array back when either id is unknown or they coincide.
 */
export function reorderWithinStatus(
  tasks: Task[],
  status: TaskStatus,
  activeId: string,
  overId: string
): Task[] {
  if (activeId === overId) return tasks;
  const groupIdx = tasks.flatMap((t, i) => (t.status === status ? [i] : []));
  const fromPos = groupIdx.findIndex((i) => tasks[i]?.id === activeId);
  const toPos = groupIdx.findIndex((i) => tasks[i]?.id === overId);
  if (fromPos < 0 || toPos < 0) return tasks;
  const group = groupIdx.map((i) => tasks[i] as Task);
  const [moved] = group.splice(fromPos, 1);
  group.splice(toPos, 0, moved as Task);
  const out = [...tasks];
  groupIdx.forEach((idx, k) => {
    out[idx] = group[k] as Task;
  });
  return out;
}

/** Array index right after the last *status* task (array end when none). */
function endOfStatus(tasks: Task[], status: TaskStatus): number {
  for (let i = tasks.length - 1; i >= 0; i--) {
    if (tasks[i]?.status === status) return i + 1;
  }
  return tasks.length;
}

/**
 * Board mode: drop *activeId* into column *status*. Same column → take the
 * over card's place (arrayMove semantics; the column body is a no-op).
 * Cross column = status change + position in one gesture: before the over
 * card, or after the column's last card when dropped on the column body.
 */
export function moveToColumn(
  tasks: Task[],
  activeId: string,
  status: TaskStatus,
  overId: string | null
): Task[] {
  const from = tasks.findIndex((t) => t.id === activeId);
  if (from < 0) return tasks;
  const cur = tasks[from] as Task;
  if (cur.status === status) {
    if (!overId || overId === activeId) return tasks;
    const to = tasks.findIndex((t) => t.id === overId);
    return to < 0 ? tasks : spliceMove(tasks, from, to);
  }
  const moved = { ...cur, status };
  const rest = tasks.filter((t) => t.id !== activeId);
  let at = endOfStatus(rest, status);
  if (overId && overId !== activeId) {
    const i = rest.findIndex((t) => t.id === overId);
    if (i >= 0) at = i;
  }
  const out = [...rest];
  out.splice(at, 0, moved);
  return out;
}
