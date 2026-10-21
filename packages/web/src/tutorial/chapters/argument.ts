import type { ArgumentEdge } from "@argelanderspace/contracts";
import { SAMPLE_ARGUMENT_IDS, SAMPLE_WORK_IDS } from "../sample-ids";
import type { ChapterDefinition, GateRun, Requirement, WorkbenchSnapshot } from "../types";

const WORK = SAMPLE_WORK_IDS.jerabkova2021;
const END = SAMPLE_ARGUMENT_IDS.end;
const ORPHAN = SAMPLE_ARGUMENT_IDS.orphanNative;
/** The Work's name in the "first go back to ..." line (data, the same in every language). */
const WORK_NAME = { work: "Jerabkova 2021" } as const;

/** Jerabkova 2021's argument graph page, when the active pane shows it. */
const graphPage = (s: WorkbenchSnapshot) => {
  const page = s.page.argument;
  return page && page.work.id === WORK ? page : null;
};
const selected = (s: WorkbenchSnapshot) => graphPage(s)?.selectedId ?? null;
/** The argument the user created in 5.5 while it still has no path to the End: a finding other than the orphan's. */
const selectedIsUnlinkedNew = (s: WorkbenchSnapshot) => {
  const page = graphPage(s);
  const id = page?.selectedId ?? null;
  return id !== null && id !== ORPHAN && (page?.audit?.noPathToEnd.includes(id) ?? false);
};
const selectedIsOrphan = (s: WorkbenchSnapshot) => selected(s) === ORPHAN;

/**
 * A "+N" gate's baseline: the value at the step's start, or — when the step started away from the page — the value the
 * first time the page is seen during this showing. Kept in the showing's scratch record.
 */
function baselineOf<T>(run: GateRun, name: string, read: (s: WorkbenchSnapshot) => T | null, now: WorkbenchSnapshot): T | null {
  if (run.memo[name] === undefined || run.memo[name] === null) run.memo[name] = read(run.baseline) ?? read(now);
  return (run.memo[name] as T | null) ?? null;
}
const revOf = (s: WorkbenchSnapshot) => graphPage(s)?.rev ?? null;
const edgesOf = (s: WorkbenchSnapshot): { count: number; list: readonly ArgumentEdge[] | null } | null => {
  const page = graphPage(s);
  if (!page || page.rev === null) return null;
  return { count: page.counts.edges, list: page.edges ?? page.graph?.edges ?? null };
};
const edgeKey = (e: ArgumentEdge) => `${e.from}>${e.to}:${e.role}`;

/** The anchors of chapter 5, constants checked by the static anchor test. */
const WORK_DETAIL = { ui: "work-detail", key: WORK } as const;
const OPEN_GRAPH = { ui: "open-argument-graph", within: WORK_DETAIL } as const;
const GRAPH_VIEW = { ui: "argument-graph-view", key: WORK } as const;
const OUTLINE = { ui: "argument-outline" } as const;
const END_NODE = { ui: "argument-node", key: END } as const;
const DETAIL = { ui: "argument-detail" } as const;
const AUDIT_SUMMARY = { ui: "argument-audit-summary" } as const;
const AUDIT_POPOVER = { ui: "argument-audit-popover" } as const;
const CREATE = { ui: "create-argument" } as const;
/** The panel of an argument being created carries the key "new". */
const NEW_PANEL = { ui: "argument-detail", key: "new" } as const;
const NEW_TITLE = { ui: "argument-title-input", within: NEW_PANEL } as const;
const ORPHANS = { ui: "argument-outline-orphans" } as const;
/** "Let another argument use it…" in the selected argument's panel, and the picker it opens. */
const ADD_USE = { ui: "add-argument-use" } as const;
const USE_PICKER = { ui: "argument-picker", key: "use" } as const;
/** The canvas's own way to link: dragging the selected node's handle onto another asks for the role here. */
const ROLE_CHOOSER = { ui: "argument-role-chooser" } as const;
const ORPHAN_NODE = { ui: "argument-node", key: ORPHAN } as const;

const JERABKOVA_SELECTED: Requirement = {
  test: (s) => graphPage(s) !== null || (s.page.view === "library" && s.page.library?.selectedRefId === WORK),
  where: "workDetail",
  whereValues: WORK_NAME,
  takeMeThere: { action: "select_work", refId: WORK },
};
const ON_GRAPH: Requirement = {
  test: (s) => graphPage(s) !== null,
  where: "argumentGraph",
  whereValues: WORK_NAME,
  takeMeThere: { action: "open_argument_graph", workId: WORK },
};

/** Chapter 5, "argument" (appendix A): Jerabkova 2021's argument graph, its audit finding, and the user's fix. */
export const ARGUMENT: ChapterDefinition = {
  id: "argument",
  n: 5,
  steps: [
    {
      id: "argument.open",
      kind: "do",
      anchors: [WORK_DETAIL, OPEN_GRAPH, GRAPH_VIEW],
      gate: (s) => graphPage(s) !== null,
      requires: JERABKOVA_SELECTED,
    },
    {
      id: "argument.read",
      kind: "look",
      anchors: [OUTLINE],
      requires: ON_GRAPH,
    },
    {
      id: "argument.detail",
      kind: "do",
      anchors: [END_NODE, DETAIL],
      gate: (s) => selected(s) !== null,
      requires: ON_GRAPH,
    },
    {
      id: "argument.audit",
      kind: "look",
      anchors: [AUDIT_SUMMARY, AUDIT_POPOVER],
      requires: ON_GRAPH,
    },
    {
      id: "argument.create",
      kind: "do",
      // Appendix A's ladder ends at "save"; anchored there the card sits over the very fields to fill (real browser,
      // 1440 px), so the top rung is the title input and the card goes beside the panel; "save" stays in the copy.
      anchors: [CREATE, NEW_TITLE],
      // Any write to the graph file bumps its rev; the step asks for one (saving the new argument).
      gate: (s, run) => {
        const base = baselineOf(run, "rev", revOf, s);
        const rev = revOf(s);
        return base !== null && rev !== null && rev > base;
      },
      requires: ON_GRAPH,
      preparedCopy: true,
    },
    {
      id: "argument.link-end",
      kind: "do",
      // The new argument waits under "no path to an End" in the outline; once it is selected, its panel's control.
      anchors: [ORPHANS, { ...ADD_USE, when: selectedIsUnlinkedNew }, { ...USE_PICKER, when: selectedIsUnlinkedNew }, ROLE_CHOOSER],
      // One edge more than at the start, and (when the page lists its edges) a new one: some argument used by the End as
      // Grounds.
      gate: (s, run) => {
        const base = baselineOf(run, "edges", edgesOf, s);
        const now = edgesOf(s);
        if (!base || !now || now.count < base.count + 1) return false;
        if (!now.list) return true;
        const before = new Set((base.list ?? []).map(edgeKey));
        return now.list.some((e) => !before.has(edgeKey(e)) && e.to === END && e.role === "grounds");
      },
      requires: ON_GRAPH,
    },
    {
      id: "argument.link-native",
      kind: "do",
      anchors: [ORPHAN_NODE, { ...ADD_USE, when: selectedIsOrphan }, { ...USE_PICKER, when: selectedIsOrphan }, ROLE_CHOOSER],
      gate: (s) => {
        const audit = graphPage(s)?.audit;
        return Boolean(audit) && audit!.total === 0;
      },
      requires: ON_GRAPH,
    },
    {
      id: "argument.agent",
      kind: "agent",
      anchors: [],
    },
  ],
};
