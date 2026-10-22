import { SAMPLE_DOC_ID, SAMPLE_PLAN_ID, SAMPLE_TASK_IDS } from "../sample-ids";
import type { ChapterDefinition, GateRun, Requirement, WorkbenchSnapshot } from "../types";

const PLAN = SAMPLE_PLAN_ID;
const PRESET_TASKS: ReadonlySet<string> = new Set(SAMPLE_TASK_IDS);

/** The plan page of the active pane. */
const planPage = (s: WorkbenchSnapshot) => (s.page.view === "plan" ? (s.page.plan ?? null) : null);
const presetSelected = (s: WorkbenchSnapshot) => planPage(s)?.selectedPlanId === PLAN;
/**
 * The preset plan's task count, from the page's plans (implementation check of 6.3: in the list, board and timeline
 * views the page carries the whole plan with its tasks; the focus view carries only today's and overdue ones, so it
 * does not count).
 */
const taskCount = (s: WorkbenchSnapshot): number | null => {
  const page = planPage(s);
  if (!page || page.mode === "focus") return null;
  return page.plans.find((p) => p.id === PLAN)?.tasks.length ?? null;
};
/** A task the user made (not one of the sample's) that links Jerabkova's Doc. */
const linksDoc = (task: { id: string; links: readonly { doc_id: string }[] }) => !PRESET_TASKS.has(task.id) && task.links.some((l) => l.doc_id === SAMPLE_DOC_ID);
/** The drawer shows a task the user made in the preset plan. */
const drawerOnNewTask = (s: WorkbenchSnapshot) => {
  const detail = planPage(s)?.detail;
  return Boolean(detail && detail.planId === PLAN && !PRESET_TASKS.has(detail.task.id));
};

/** The anchors of chapter 6, constants checked by the static anchor test. */
const NAV_PLAN = { ui: "navigate-view", key: "plan" } as const;
const PLAN_VIEW = { ui: "plan-view" } as const;
const PRESET_PLAN = { ui: "plan-item", key: PLAN } as const;
const TASK_LIST = { ui: "plan-task-list" } as const;
const CREATE_TASK = { ui: "create-task" } as const;
const TASK_TITLE = { ui: "task-title-input" } as const;
const SUBMIT_TASK = { ui: "submit-task-form" } as const;
const TASK_DRAWER = { ui: "task-drawer" } as const;
const ADD_TASK_DOC = { ui: "add-task-doc", within: TASK_DRAWER } as const;
const DOC_CHOICE = { ui: "task-doc-choice", key: SAMPLE_DOC_ID } as const;
/** The list / board switch of the plan; the sidebar's views (today's focus, timeline) are the rung above it. */
const DISPLAY_BOARD = { ui: "plan-display-mode", key: "board" } as const;
const FOCUS_VIEW = { ui: "plan-special-view", key: "focus" } as const;

const SHOW_PRESET = { action: "show", view: "list", planId: PLAN } as const;
/** The preset plan in the list view (its task list and grouped rows are there). */
const PRESET_IN_LIST: Requirement = {
  test: (s) => presetSelected(s) && planPage(s)?.mode === "list",
  where: "plan",
  takeMeThere: SHOW_PRESET,
};
/** The preset plan in the list or the board: either has "New task". */
const PRESET_SHOWN: Requirement = {
  test: (s) => presetSelected(s) && (planPage(s)?.mode === "list" || planPage(s)?.mode === "board"),
  where: "plan",
  takeMeThere: SHOW_PRESET,
};
const ON_PLAN: Requirement = {
  test: (s) => s.page.view === "plan",
  where: "plan",
  takeMeThere: { action: "switch_view", view: "plan" },
};

/** Chapter 6, "plan" (appendix A): the preset plan, a new task, a linked Doc, the special views. */
export const PLAN_CHAPTER: ChapterDefinition = {
  id: "plan",
  n: 6,
  steps: [
    {
      id: "plan.open",
      kind: "do",
      anchors: [NAV_PLAN, PLAN_VIEW, PRESET_PLAN],
      gate: (s) => s.page.view === "plan",
    },
    {
      id: "plan.tasks",
      kind: "look",
      anchors: [TASK_LIST],
      requires: PRESET_IN_LIST,
    },
    {
      id: "plan.create-task",
      kind: "do",
      anchors: [CREATE_TASK, TASK_TITLE, SUBMIT_TASK],
      gate: (s, run: GateRun) => {
        if (run.memo.base === undefined || run.memo.base === null) run.memo.base = taskCount(run.baseline) ?? taskCount(s);
        const base = run.memo.base as number | null;
        const now = taskCount(s);
        return base !== null && now !== null && now >= base + 1;
      },
      requires: PRESET_SHOWN,
      preparedCopy: true,
    },
    {
      id: "plan.link-doc",
      kind: "do",
      // Supplementary item 2: no keyed task row (the new task's id is not known in advance); the drawer rungs apply only
      // while it shows a task the user made, not a preset one.
      anchors: [TASK_LIST, { ...TASK_DRAWER, when: drawerOnNewTask }, { ...ADD_TASK_DOC, when: drawerOnNewTask }, { ...DOC_CHOICE, when: drawerOnNewTask }],
      // Implementation check of 6.4: the page's open task (`detail.task`) carries its links; the plan's tasks carry them
      // too, so a task linked and closed again still counts.
      gate: (s) => {
        const page = planPage(s);
        if (!page) return false;
        if (page.detail && page.detail.planId === PLAN && linksDoc(page.detail.task)) return true;
        return page.plans.some((p) => p.id === PLAN && p.tasks.some(linksDoc));
      },
      requires: PRESET_IN_LIST,
    },
    {
      id: "plan.views",
      kind: "look",
      anchors: [DISPLAY_BOARD, FOCUS_VIEW],
      requires: ON_PLAN,
    },
    {
      id: "plan.agent",
      kind: "agent",
      anchors: [],
    },
  ],
};
