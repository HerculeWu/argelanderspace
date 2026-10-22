import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL as NodeURL } from "node:url";
import {
  type Argument,
  type ArgumentEdge,
  type ArgumentGraph,
  type PageContext,
  type Plan,
  type PlanPage,
  type Task,
  BLANK_ARGUMENT,
  auditArgumentGraph,
} from "@argelanderspace/contracts";
import { describe, expect, it } from "vitest";
import { activeRungs } from "../src/tutorial/anchors";
import { CHAPTERS } from "../src/tutorial/chapters";
import { SAMPLE_ARGUMENT_IDS, SAMPLE_DOC_ID, SAMPLE_PLAN_ID, SAMPLE_TASK_IDS, SAMPLE_WORK_IDS } from "../src/tutorial/sample-ids";
import type { GateRun, StepDefinition, TutorialAnchor, WorkbenchSnapshot } from "../src/tutorial/types";
import { fakeDom, fakePage } from "./tutorial-fixtures";

// in-app-tutorial ticket 22: chapters 5 (argument graph) and 6 (plan) against fake snapshots — the gates with their
// baselines, the requirements and their take-me-there actions, the conditional ladder rungs, and the audit walk
// 1 -> 2 -> 1 -> 0 on the sample's real argument graph.

const J = SAMPLE_WORK_IDS.jerabkova2021;
const END = SAMPLE_ARGUMENT_IDS.end;
const ORPHAN = SAMPLE_ARGUMENT_IDS.orphanNative;
const SAMPLE = fileURLToPath(new NodeURL("../../../tutorial-sample/literatures", import.meta.url));

const step = (id: string): StepDefinition => {
  for (const c of CHAPTERS) for (const s of c.steps) if (s.id === id) return s;
  throw new Error(`no step ${id}`);
};
const runOf = (baseline: WorkbenchSnapshot): GateRun => ({ baseline, memo: {} });

function snap(view: string, extra: Partial<PageContext> = {}): WorkbenchSnapshot {
  return { page: { ...fakePage(view), ...extra } as PageContext, modalOpen: false, paletteOpen: false, dom: fakeDom(), data: {} };
}

// ---- The argument graph page as the Shell publishes it (only what the tutorial reads is meaningful) ---------------- //

function sampleGraph(): ArgumentGraph {
  const dir = join(SAMPLE, "argument-graphs");
  const file = readdirSync(dir).find((f) => f.endsWith(".json"))!;
  return JSON.parse(readFileSync(join(dir, file), "utf8")) as ArgumentGraph;
}

function argumentPage(graph: ArgumentGraph, over: { selectedId?: string | null; workId?: string; withEdges?: boolean } = {}) {
  const audit = auditArgumentGraph(graph);
  const cycles = audit.cycles.map((c) => c.arguments);
  const total = cycles.length + (audit.noEnd ? 1 : 0) + audit.noPathToEnd.length + audit.endWithOutEdge.length + audit.nativeWithInEdge.length + audit.incomplete.length;
  return {
    work: { id: over.workId ?? J, title: "Jerabkova 2021" },
    phase: "ready",
    rev: graph.rev,
    counts: { arguments: graph.arguments.length, edges: graph.edges.length },
    audit: { total, cycles, noPathToEnd: audit.noPathToEnd, noEnd: audit.noEnd, endWithOutEdge: audit.endWithOutEdge, nativeWithInEdge: audit.nativeWithInEdge, incomplete: audit.incomplete },
    selectedId: over.selectedId ?? null,
    partial: false,
    graph,
    outline: null,
    edges: over.withEdges === false ? null : graph.edges,
    selected: null,
    reduction: null,
  };
}
const onGraph = (graph: ArgumentGraph, over: Parameters<typeof argumentPage>[1] = {}) =>
  snap("library", { library: null, argument: argumentPage(graph, over) } as unknown as Partial<PageContext>);

/** What the user does in 5.5–5.7, as the page writes it: a new argument, then two edges, each a new rev. */
const NEW_ID = "anew01";
function withNewArgument(g: ArgumentGraph): ArgumentGraph {
  const created: Argument = { ...BLANK_ARGUMENT, id: NEW_ID, kind: "normal", title: "tails reach far", claim: "c", grounds: "g", warrant: "w" } as Argument;
  return { ...g, rev: g.rev + 1, arguments: [...g.arguments, created] };
}
const withEdge = (g: ArgumentGraph, edge: ArgumentEdge): ArgumentGraph => ({ ...g, rev: g.rev + 1, edges: [...g.edges, edge] });

// ---- The plan page --------------------------------------------------------------------------------------------- //

function samplePlan(): Plan {
  const file = JSON.parse(readFileSync(join(SAMPLE, "..", "status", "plans.json"), "utf8"));
  return file.plans.find((p: Plan) => p.id === SAMPLE_PLAN_ID) as Plan;
}
const task = (id: string, links: string[] = []): Task => ({ id, title: "t", status: "todo", due: "2026-11-01", links: links.map((doc_id) => ({ doc_id })), focused: false, created_at: "2026-10-21T00:00:00.000Z" });
function planPage(plan: Plan, over: Partial<PlanPage> = {}): PlanPage {
  return { rev: 0, mode: "list", selectedPlanId: plan.id, plans: [plan], groups: [], detail: null, saveState: "saved", ...over };
}
const onPlan = (page: PlanPage | null) => snap("plan", { plan: page });
const withTask = (plan: Plan, t: Task): Plan => ({ ...plan, tasks: [...plan.tasks, t] });

const rungNames = (s: StepDefinition, snapshot: WorkbenchSnapshot) => activeRungs(s.anchors, snapshot).map((a: TutorialAnchor) => (a.key ? `${a.ui}[${a.key}]` : a.ui));

describe("chapters 5 and 6 are registered in order", () => {
  it("chapter 5 (argument) and 6 (plan) follow chapter 1 in the registry with appendix A's steps", () => {
    const ids = CHAPTERS.map((c) => c.id);
    expect(ids.indexOf("argument")).toBeGreaterThan(ids.indexOf("tour"));
    expect(ids.indexOf("plan")).toBe(ids.indexOf("argument") + 1);
    const argument = CHAPTERS.find((c) => c.id === "argument")!;
    const plan = CHAPTERS.find((c) => c.id === "plan")!;
    expect(argument.n).toBe(5);
    expect(plan.n).toBe(6);
    expect(argument.steps.map((s) => s.id)).toEqual(["argument.open", "argument.read", "argument.detail", "argument.audit", "argument.create", "argument.link-end", "argument.link-native", "argument.agent"]);
    expect(plan.steps.map((s) => s.id)).toEqual(["plan.open", "plan.tasks", "plan.create-task", "plan.link-doc", "plan.views", "plan.agent"]);
  });
  it("the gated steps are exactly appendix A's; look steps and agent cards have none", () => {
    const gated = [...CHAPTERS.find((c) => c.id === "argument")!.steps, ...CHAPTERS.find((c) => c.id === "plan")!.steps].filter((s) => s.gate).map((s) => s.id);
    expect(gated).toEqual(["argument.open", "argument.detail", "argument.create", "argument.link-end", "argument.link-native", "plan.open", "plan.create-task", "plan.link-doc"]);
    expect(step("argument.agent").kind).toBe("agent");
    expect(step("plan.agent").kind).toBe("agent");
    expect(step("argument.agent").anchors).toEqual([]);
    expect(step("plan.agent").anchors).toEqual([]);
  });
  it("5.5 and 6.3 show translated prepared text; nothing in these chapters needs TeX or has L2 sources (L1 suffices)", () => {
    expect(step("argument.create").preparedCopy).toBe(true);
    expect(step("plan.create-task").preparedCopy).toBe(true);
    for (const c of CHAPTERS.filter((c) => c.id === "argument" || c.id === "plan"))
      for (const s of c.steps) {
        expect(s.needsTex).toBeFalsy();
        expect(s.sources ?? []).toEqual([]);
      }
  });
});

describe("chapter 5 gates against fake snapshots (L1: the argument page)", () => {
  const g = sampleGraph();
  it("the sample's graph has exactly one finding: the orphan Native has no path to the End", () => {
    const page = argumentPage(g);
    expect(page.audit.total).toBe(1);
    expect(page.audit.noPathToEnd).toEqual([ORPHAN]);
  });
  it("5.1 passes once Jerabkova's argument graph is open", () => {
    const gate = step("argument.open").gate!;
    const s = onGraph(g);
    expect(gate(s, runOf(s))).toBe(true);
    const other = onGraph(g, { workId: SAMPLE_WORK_IDS.roser2019 });
    expect(gate(other, runOf(other))).toBe(false);
    const lib = snap("library", { library: { selectedRefId: J } } as unknown as Partial<PageContext>);
    expect(gate(lib, runOf(lib))).toBe(false);
  });
  it("5.1 requires Jerabkova selected in the library (or its graph already open); take me there selects it", () => {
    const r = step("argument.open").requires!;
    expect(r.test(snap("library", { library: { selectedRefId: J } } as unknown as Partial<PageContext>))).toBe(true);
    expect(r.test(onGraph(g))).toBe(true);
    expect(r.test(snap("library", { library: { selectedRefId: SAMPLE_WORK_IDS.roser2019 } } as unknown as Partial<PageContext>))).toBe(false);
    expect(r.test(snap("plan"))).toBe(false);
    expect(r.where).toBe("workDetail");
    expect(r.whereValues?.work).toMatch(/Jerabkova/);
    expect(r.takeMeThere).toEqual({ action: "select_work", refId: J });
  });
  it("5.2-5.7 require Jerabkova's argument graph; take me there opens it", () => {
    for (const id of ["argument.read", "argument.detail", "argument.audit", "argument.create", "argument.link-end", "argument.link-native"]) {
      const r = step(id).requires!;
      expect(r.test(onGraph(g))).toBe(true);
      expect(r.test(onGraph(g, { workId: SAMPLE_WORK_IDS.roser2019 }))).toBe(false);
      expect(r.test(snap("library", { library: { selectedRefId: J } } as unknown as Partial<PageContext>))).toBe(false);
      expect(r.where).toBe("argumentGraph");
      expect(r.takeMeThere).toEqual({ action: "open_argument_graph", workId: J });
    }
  });
  it("5.3 passes once an argument is selected", () => {
    const gate = step("argument.detail").gate!;
    const none = onGraph(g);
    expect(gate(none, runOf(none))).toBe(false);
    const sel = onGraph(g, { selectedId: END });
    expect(gate(sel, runOf(none))).toBe(true);
  });
  it("5.5 passes when the graph's rev is above the baseline taken at the step's start", () => {
    const gate = step("argument.create").gate!;
    const start = onGraph(g);
    const run = runOf(start);
    expect(gate(start, run)).toBe(false);
    expect(gate(onGraph(withNewArgument(g)), run)).toBe(true);
  });
  it("5.5 entered away from the graph takes its baseline when the graph is first seen", () => {
    const gate = step("argument.create").gate!;
    const away = snap("plan");
    const run = runOf(away);
    expect(gate(away, run)).toBe(false);
    expect(gate(onGraph(g), run)).toBe(false);
    expect(gate(onGraph(withNewArgument(g)), run)).toBe(true);
  });
  it("5.6 passes on one more edge than the baseline: the new argument used by the End as Grounds", () => {
    const gate = step("argument.link-end").gate!;
    const g1 = withNewArgument(g);
    const start = onGraph(g1, { selectedId: NEW_ID });
    const run = runOf(start);
    expect(gate(start, run)).toBe(false);
    expect(gate(onGraph(withEdge(g1, { from: NEW_ID, to: END, role: "grounds" })), run)).toBe(true);
  });
  it("5.6 does not pass on an edge in another role, or not to the End", () => {
    const gate = step("argument.link-end").gate!;
    const g1 = withNewArgument(g);
    const start = onGraph(g1);
    expect(gate(onGraph(withEdge(g1, { from: NEW_ID, to: END, role: "backing" })), runOf(start))).toBe(false);
    expect(gate(onGraph(withEdge(g1, { from: NEW_ID, to: "ap8q2z", role: "grounds" })), runOf(start))).toBe(false);
  });
  it("5.6 falls back to the edge count when the page carries no edge list", () => {
    const gate = step("argument.link-end").gate!;
    const g1 = withNewArgument(g);
    const start = onGraph(g1, { withEdges: false });
    const run = runOf(start);
    expect(gate(start, run)).toBe(false);
    expect(gate(onGraph(withEdge(g1, { from: NEW_ID, to: END, role: "grounds" }), { withEdges: false }), run)).toBe(true);
  });
  it("5.7 passes when the audit is empty, not before, and not without a graph", () => {
    const gate = step("argument.link-native").gate!;
    const g2 = withEdge(withNewArgument(g), { from: NEW_ID, to: END, role: "grounds" });
    const s1 = onGraph(g2);
    expect(gate(s1, runOf(s1))).toBe(false);
    const g3 = withEdge(g2, { from: ORPHAN, to: NEW_ID, role: "grounds" });
    expect(gate(onGraph(g3), runOf(s1))).toBe(true);
    const loading = snap("library", { argument: { ...argumentPage(g3), phase: "loading", audit: null, rev: null } } as unknown as Partial<PageContext>);
    expect(gate(loading, runOf(loading))).toBe(false);
  });
  it("the audit walks 1 -> 2 -> 1 -> 0 through 5.5-5.7 on the sample's graph, and each gate passes on its own step", () => {
    const g0 = g;
    const g1 = withNewArgument(g0);
    const g2 = withEdge(g1, { from: NEW_ID, to: END, role: "grounds" });
    const g3 = withEdge(g2, { from: ORPHAN, to: NEW_ID, role: "grounds" });
    expect([g0, g1, g2, g3].map((x) => argumentPage(x).audit.total)).toEqual([1, 2, 1, 0]);
    expect(argumentPage(g1).audit.noPathToEnd.sort()).toEqual([NEW_ID, ORPHAN].sort());
    const create = step("argument.create").gate!;
    const linkEnd = step("argument.link-end").gate!;
    const linkNative = step("argument.link-native").gate!;
    expect(create(onGraph(g1), runOf(onGraph(g0)))).toBe(true);
    expect(linkEnd(onGraph(g2), runOf(onGraph(g1)))).toBe(true);
    expect(linkNative(onGraph(g2), runOf(onGraph(g2)))).toBe(false);
    expect(linkNative(onGraph(g3), runOf(onGraph(g2)))).toBe(true);
  });
});

describe("chapter 5 ladders", () => {
  const g = sampleGraph();
  const g1 = withNewArgument(g);
  it("5.1 climbs from Jerabkova's detail to its graph button, inside that detail, to the graph view", () => {
    const names = step("argument.open").anchors.map((a) => (a.key ? `${a.ui}[${a.key}]` : a.ui));
    expect(names).toEqual([`work-detail[${J}]`, "open-argument-graph", `argument-graph-view[${J}]`]);
    expect(step("argument.open").anchors[1]!.within).toEqual({ ui: "work-detail", key: J });
  });
  it("5.3 starts at the End argument's node; 5.7 at the orphan Native's", () => {
    expect(step("argument.detail").anchors[0]).toEqual({ ui: "argument-node", key: END });
    expect(step("argument.link-native").anchors[0]).toEqual({ ui: "argument-node", key: ORPHAN });
  });
  it("5.5 climbs from 'new argument' to the title input of the new argument's panel (not 'save': the card would cover the fields)", () => {
    expect(step("argument.create").anchors).toEqual([{ ui: "create-argument" }, { ui: "argument-title-input", within: { ui: "argument-detail", key: "new" } }]);
  });
  it("5.6 offers the 'let another argument use it' control only while the new, unlinked argument is selected", () => {
    const s = step("argument.link-end");
    expect(rungNames(s, onGraph(g1, { selectedId: NEW_ID }))).toEqual(["argument-outline-orphans", "add-argument-use", "argument-picker[use]", "argument-role-chooser"]);
    expect(rungNames(s, onGraph(g1, { selectedId: END }))).toEqual(["argument-outline-orphans", "argument-role-chooser"]);
    expect(rungNames(s, onGraph(g1, { selectedId: ORPHAN }))).toEqual(["argument-outline-orphans", "argument-role-chooser"]);
    expect(rungNames(s, onGraph(g1))).toEqual(["argument-outline-orphans", "argument-role-chooser"]);
  });
  it("5.7 offers the same control only while the orphan Native is selected", () => {
    const s = step("argument.link-native");
    const g2 = withEdge(g1, { from: NEW_ID, to: END, role: "grounds" });
    expect(rungNames(s, onGraph(g2, { selectedId: ORPHAN }))).toEqual([`argument-node[${ORPHAN}]`, "add-argument-use", "argument-picker[use]", "argument-role-chooser"]);
    expect(rungNames(s, onGraph(g2, { selectedId: NEW_ID }))).toEqual([`argument-node[${ORPHAN}]`, "argument-role-chooser"]);
  });
});

describe("chapter 6 gates against fake snapshots (L1: the plan page)", () => {
  const plan = samplePlan();
  it("the sample plan has its preset tasks (two hand-written, one from the Copilot conversation); the first already links Jerabkova's Doc", () => {
    expect(plan.tasks.map((t) => t.id)).toEqual([...SAMPLE_TASK_IDS]);
    expect(plan.tasks[0]!.links.map((l) => l.doc_id)).toEqual([SAMPLE_DOC_ID]);
  });
  it("6.1 passes on the plan page", () => {
    const gate = step("plan.open").gate!;
    const s = onPlan(planPage(plan));
    expect(gate(s, runOf(s))).toBe(true);
    const lib = snap("library");
    expect(gate(lib, runOf(lib))).toBe(false);
  });
  it("6.1 climbs from the navigation to the page to the preset plan", () => {
    expect(step("plan.open").anchors).toEqual([{ ui: "navigate-view", key: "plan" }, { ui: "plan-view" }, { ui: "plan-item", key: SAMPLE_PLAN_ID }]);
  });
  it("6.2-6.4 require the preset plan selected in the list view; take me there shows it", () => {
    for (const id of ["plan.tasks", "plan.create-task", "plan.link-doc"]) {
      const r = step(id).requires!;
      expect(r.test(onPlan(planPage(plan)))).toBe(true);
      expect(r.test(onPlan(planPage(plan, { selectedPlanId: null })))).toBe(false);
      expect(r.test(onPlan(planPage(plan, { mode: "timeline" })))).toBe(false);
      expect(r.test(snap("library"))).toBe(false);
      expect(r.where).toBe("plan");
      expect(r.takeMeThere).toEqual({ action: "show", view: "list", planId: SAMPLE_PLAN_ID });
    }
    // creating a task works on the board too
    expect(step("plan.create-task").requires!.test(onPlan(planPage(plan, { mode: "board" })))).toBe(true);
    expect(step("plan.tasks").requires!.test(onPlan(planPage(plan, { mode: "board" })))).toBe(false);
  });
  it("6.3 passes when the preset plan has one more task than at the step's start", () => {
    const gate = step("plan.create-task").gate!;
    const start = onPlan(planPage(plan));
    const run = runOf(start);
    expect(gate(start, run)).toBe(false);
    expect(gate(onPlan(planPage(withTask(plan, task("t_0000aaaa")))), run)).toBe(true);
  });
  it("6.3 entered away from the plan takes its baseline when the plan's tasks are first seen; the focus view does not count", () => {
    const gate = step("plan.create-task").gate!;
    const away = snap("library");
    const run = runOf(away);
    expect(gate(away, run)).toBe(false);
    expect(gate(onPlan(planPage(plan, { mode: "focus", plans: [{ ...plan, tasks: [plan.tasks[0]!] }] })), run)).toBe(false);
    expect(gate(onPlan(planPage(plan)), run)).toBe(false);
    expect(gate(onPlan(planPage(withTask(plan, task("t_0000aaaa")))), run)).toBe(true);
  });
  it("6.4 passes when a task other than the preset ones links Jerabkova's Doc (open in the drawer or not)", () => {
    const gate = step("plan.link-doc").gate!;
    const fresh = task("t_0000aaaa");
    const p1 = withTask(plan, fresh);
    const start = onPlan(planPage(p1, { detail: { planId: plan.id, task: fresh } }));
    expect(gate(start, runOf(start))).toBe(false);
    const linked = task("t_0000aaaa", [SAMPLE_DOC_ID]);
    const p2 = { ...plan, tasks: [...plan.tasks, linked] };
    expect(gate(onPlan(planPage(p2, { detail: { planId: plan.id, task: linked } })), runOf(start))).toBe(true);
    expect(gate(onPlan(planPage(p2)), runOf(start))).toBe(true);
  });
  it("6.4 does not pass on the preset task that already links the Doc, nor on another Doc", () => {
    const gate = step("plan.link-doc").gate!;
    const preset = plan.tasks[0]!;
    const s = onPlan(planPage(plan, { detail: { planId: plan.id, task: preset } }));
    expect(gate(s, runOf(s))).toBe(false);
    const other = task("t_0000aaaa", ["arxiv-2202.06973"]);
    const s2 = onPlan(planPage(withTask(plan, other), { detail: { planId: plan.id, task: other } }));
    expect(gate(s2, runOf(s2))).toBe(false);
  });
  it("6.4 climbs list -> drawer -> add linked document -> Jerabkova's choice, the drawer rungs only for a new task", () => {
    const s = step("plan.link-doc");
    expect(s.anchors[3]).toMatchObject({ ui: "task-doc-choice", key: SAMPLE_DOC_ID });
    const fresh = task("t_0000aaaa");
    expect(rungNames(s, onPlan(planPage(withTask(plan, fresh), { detail: { planId: plan.id, task: fresh } })))).toEqual(["plan-task-list", "task-drawer", "add-task-doc", `task-doc-choice[${SAMPLE_DOC_ID}]`]);
    expect(rungNames(s, onPlan(planPage(plan, { detail: { planId: plan.id, task: plan.tasks[0]! } })))).toEqual(["plan-task-list"]);
    expect(rungNames(s, onPlan(planPage(plan)))).toEqual(["plan-task-list"]);
  });
  it("6.5 requires the plan page; take me there switches to it", () => {
    const r = step("plan.views").requires!;
    expect(r.test(onPlan(planPage(plan, { mode: "timeline" })))).toBe(true);
    expect(r.test(snap("library"))).toBe(false);
    expect(r.takeMeThere).toEqual({ action: "switch_view", view: "plan" });
  });
});
