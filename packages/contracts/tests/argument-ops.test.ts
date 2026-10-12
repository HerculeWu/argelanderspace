/**
 * The argument graph page for the Copilot (ticket 04): the budget between the whole and the partial form, the strict
 * shape, the audit it carries, the summary and the observation form.
 */
import { describe, expect, it } from "vitest";
import type { ArgumentGraph } from "../src/argument-graph.js";
import {
  ARGUMENT_NOTE_MAX,
  ARGUMENT_PAGE_FULL_MAX,
  ARGUMENT_PAGE_MAX,
  ArgumentPageSchema,
  argumentKey,
  buildArgumentPage,
  observationArgumentPage,
  summarizeArgumentPage,
} from "../src/argument-ops.js";
import { CopilotObservationSchema, PageContextSchema } from "../src/copilot.js";
import { copilotContextObjects } from "../src/reader-ops.js";

const graphOf = (count: number, claimChars = 0, rev = 2): ArgumentGraph => ({
  version: 1,
  rev,
  work_id: "doi:10.1/x",
  arguments: Array.from({ length: count }, (_, i) => ({
    id: `a${i}`,
    title: `T${i}`,
    claim: claimChars ? "c".repeat(claimChars) : `Claim ${i}`,
    grounds: "",
    warrant: "",
    backing: "",
    qualifier: "",
    rebuttal: "",
    warrant_implicit: false,
    kind: "normal" as const,
    sources: [],
  })),
  edges: Array.from({ length: Math.max(0, count - 1) }, (_, i) => ({
    from: `a${i + 1}`,
    to: `a${i}`,
    role: "grounds" as const,
  })),
});
const build = (
  graph: ArgumentGraph | null,
  selectedId: string | null = null,
  phase: "ready" | "loading" | "error" = "ready"
) => buildArgumentPage({ workId: "doi:10.1/x", title: "W", phase, graph, selectedId });

describe("buildArgumentPage", () => {
  it("carries a graph within the budget whole", () => {
    const graph = graphOf(5);
    const page = build(graph, "a2");
    expect(page).toMatchObject({
      phase: "ready",
      rev: 2,
      partial: false,
      selectedId: "a2",
      outline: null,
      edges: null,
      selected: null,
    });
    expect(page.graph).toEqual(graph);
    expect(page.note).toContain("read-only");
    expect(ArgumentPageSchema.safeParse(page).success).toBe(true);
  });

  it("switches to the partial form exactly when the graph JSON passes the budget", () => {
    // find the claim length at which the graph first passes the budget, then check both sides of it
    const size = (chars: number) => JSON.stringify(graphOf(10, chars)).length;
    let chars = 1000;
    while (size(chars) <= ARGUMENT_PAGE_FULL_MAX) chars += 100;
    while (size(chars - 1) > ARGUMENT_PAGE_FULL_MAX) chars -= 1;
    const inside = size(chars - 1);
    expect(inside).toBeLessThanOrEqual(ARGUMENT_PAGE_FULL_MAX);
    expect(build(graphOf(10, chars - 1)).partial).toBe(false);
    const over = build(graphOf(10, chars), "a3");
    expect(over.partial).toBe(true);
    expect(over.graph).toBeNull();
    expect(over.outline).toHaveLength(10);
    expect(over.edges).toHaveLength(9);
    expect(over.selected?.claim.length).toBe(chars);
    expect(over.note).toContain("Partial");
    expect(ArgumentPageSchema.safeParse(over).success).toBe(true);
  });

  it("a partial page lists which fields have text and carries no other field text", () => {
    const graph = graphOf(10, 20_000);
    graph.arguments = graph.arguments.map((a) =>
      a.id === "a1" ? { ...a, grounds: "g", warrant_implicit: true } : a
    );
    const page = build(graph, "a4");
    const entry = page.outline?.[1];
    expect(entry).toMatchObject({
      id: "a1",
      title: "T1",
      kind: "normal",
      warrantImplicit: true,
      filled: { claim: true, grounds: true, warrant: false },
    });
    expect(JSON.stringify(page.outline)).not.toContain("cccc");
    expect(page.selected?.id).toBe("a4");
    // the largest page stays bounded: 500 arguments of the largest size still serialise far below the graph itself
    const largest = build(graphOf(500, 20_000), "a7");
    expect(largest.partial).toBe(true);
    expect(JSON.stringify(largest).length).toBeLessThanOrEqual(ARGUMENT_PAGE_MAX);
  });

  it("an unknown selection is dropped, a graph with no arguments is empty, and a failure has no graph", () => {
    expect(build(graphOf(2), "gone").selectedId).toBeNull();
    expect(build(graphOf(0))).toMatchObject({
      phase: "empty",
      counts: { arguments: 0, edges: 0 },
      rev: 2,
    });
    expect(build(null, "a1", "error")).toMatchObject({
      phase: "error",
      graph: null,
      rev: null,
      audit: null,
      selectedId: null,
    });
    expect(build(graphOf(2), null, "loading").phase).toBe("loading");
  });

  it("carries the audit by argument id in both forms", () => {
    const small = build(graphOf(3));
    // no End anywhere: one graph-level finding; every argument lacks Grounds/Warrant text or an in-edge of that role
    expect(small.audit).toMatchObject({
      noEnd: true,
      noPathToEnd: [],
      cycles: [],
      endWithOutEdge: [],
      nativeWithInEdge: [],
    });
    expect(small.audit?.incomplete.find((i) => i.id === "a2")?.missing).toEqual([
      "grounds",
      "warrant",
    ]);
    const big = build(graphOf(10, 20_000));
    expect(big.partial).toBe(true);
    expect(big.audit?.noEnd).toBe(true);
    const a = big.audit;
    expect(a?.total).toBe(1 + (a?.incomplete.length ?? 0));
  });
});

describe("ArgumentPageSchema", () => {
  it("is strict and rejects inconsistent pages", () => {
    const page = build(graphOf(3), "a1");
    expect(ArgumentPageSchema.safeParse({ ...page, extra: 1 }).success).toBe(false);
    expect(
      ArgumentPageSchema.safeParse({ ...page, counts: { arguments: 9, edges: 2 } }).success
    ).toBe(false);
    expect(ArgumentPageSchema.safeParse({ ...page, selectedId: "zz" }).success).toBe(false);
    expect(ArgumentPageSchema.safeParse({ ...page, graph: null }).success).toBe(false);
    expect(ArgumentPageSchema.safeParse({ ...page, rev: null }).success).toBe(false);
    expect(ArgumentPageSchema.safeParse({ ...page, partial: true }).success).toBe(false);
    expect(ArgumentPageSchema.safeParse({ ...page, phase: "loading" }).success).toBe(false);
  });
});

describe("PageContext", () => {
  const context = (
    argument: ReturnType<typeof build>,
    status: "complete" | "unavailable" | "error"
  ) => ({
    version: 1,
    viewId: "7d2f6d2e-5b3b-4f6a-9d7e-0a1b2c3d4e5f",
    revision: 1,
    paneId: 1,
    view: "library",
    otherPanes: [],
    status,
    plan: null,
    argument,
  });
  it("is complete exactly when the graph really loaded", () => {
    expect(PageContextSchema.safeParse(context(build(graphOf(2)), "complete")).success).toBe(true);
    expect(PageContextSchema.safeParse(context(build(graphOf(0)), "complete")).success).toBe(true);
    expect(PageContextSchema.safeParse(context(build(graphOf(2)), "unavailable")).success).toBe(
      false
    );
    expect(
      PageContextSchema.safeParse(context(build(null, null, "loading"), "complete")).success
    ).toBe(false);
    expect(PageContextSchema.safeParse(context(build(null, null, "error"), "error")).success).toBe(
      true
    );
  });
  it("names the Work at the graph's revision as the context object", () => {
    expect(copilotContextObjects({ argument: build(graphOf(2)) })).toEqual([
      { id: "doi:10.1/x", rev: 2 },
    ]);
    expect(copilotContextObjects({ argument: build(null, null, "loading") })).toEqual([
      { id: "doi:10.1/x", rev: 0 },
    ]);
  });
});

describe("summary and observation", () => {
  it("summarises what the message carried", () => {
    expect(summarizeArgumentPage(build(graphOf(4), "a1"))).toMatchObject({
      state: "ready",
      rev: 2,
      arguments: 4,
      edges: 3,
      selectedId: "a1",
      partial: false,
    });
  });
  it("names the selected argument by its short title in every form", () => {
    expect(summarizeArgumentPage(build(graphOf(4), "a1")).selectedTitle).toBe("T1");
    expect(summarizeArgumentPage(build(graphOf(60, 2000), "a5")).selectedTitle).toBe("T5");
    expect(summarizeArgumentPage(build(graphOf(4))).selectedTitle).toBeNull();
  });
  it("lists a whole graph the task holds and leaves any other page alone", () => {
    const page = build(graphOf(4, 3000), "a2");
    const held = new Set([argumentKey("doi:10.1/x", 2)]);
    const listed = observationArgumentPage({ argument: page }, held).argument;
    expect(listed).toMatchObject({
      partial: true,
      graph: null,
      selectedId: "a2",
      selected: { id: "a2" },
    });
    expect(ArgumentPageSchema.safeParse(listed).success).toBe(true);
    // another revision, nothing held, or a page that is already partial are returned as they are
    expect(
      observationArgumentPage({ argument: build(graphOf(4, 3000, 3), "a2") }, held).argument
        ?.partial
    ).toBe(false);
    expect(observationArgumentPage({ argument: page }).argument).toBe(page);
    const partial = build(graphOf(10, 20_000), "a1");
    expect(observationArgumentPage({ argument: partial }, held).argument).toBe(partial);
    expect(observationArgumentPage({ argument: null }, held).argument).toBeNull();
  });
});

// ---- fix round C: capacity, the empty graph, the notes ------------------------------------------------------------- //

const ACTIONS = "Library page actions";
const length = (value: unknown) => JSON.stringify(value).length;
const longId = (i: number) => `arg-${String(i).padStart(4, "0")}-`.padEnd(64, "x");
/** The worst graph the limits allow: 500 arguments, 5000 edges, ids and titles at their limits. */
function worstGraph(selectedFull = true): ArgumentGraph {
  const args = Array.from({ length: 500 }, (_, i) => ({
    id: longId(i),
    title: "t".repeat(80),
    claim: "c".repeat(selectedFull ? 20_000 : 3),
    grounds: "g".repeat(selectedFull ? 20_000 : 3),
    warrant: "w".repeat(selectedFull ? 20_000 : 3),
    backing: "b".repeat(selectedFull ? 20_000 : 3),
    qualifier: "q".repeat(selectedFull ? 20_000 : 3),
    rebuttal: "r".repeat(selectedFull ? 20_000 : 3),
    warrant_implicit: false,
    kind: (i === 0 ? "end" : i === 499 ? "native" : "normal") as "end" | "native" | "normal",
    sources: Array.from({ length: 50 }, (_, k) => ({
      text: "s".repeat(selectedFull ? 20_000 : 3),
      target: { doc_id: "d".repeat(512), anchor: "a".repeat(512 - k) },
    })),
  }));
  const edges: ArgumentGraph["edges"] = [];
  const roles = ["grounds", "warrant", "backing", "rebuttal"] as const;
  for (let i = 0; edges.length < 5000; i++)
    for (const role of roles)
      if (edges.length < 5000)
        edges.push({ from: longId((i * 7 + 1) % 500), to: longId(i % 500), role });
  return { version: 1, rev: 9, work_id: "doi:10.1/x", arguments: args, edges };
}

describe("capacity: a hard ceiling for every page", () => {
  it("the ceiling is of the order of the whole-graph budget", () => {
    expect(ARGUMENT_PAGE_MAX).toBeGreaterThan(ARGUMENT_PAGE_FULL_MAX);
    expect(ARGUMENT_PAGE_MAX).toBeLessThanOrEqual(2 * ARGUMENT_PAGE_FULL_MAX);
  });

  it("the worst graph (500 arguments, 5000 edges, the selected one at every limit) stays under it, selected or not", () => {
    const graph = worstGraph();
    // the first edge pairs differ from the selected argument's: select one that also has many edges
    for (const selected of [null, longId(0), longId(250), longId(499)]) {
      const page = build(graph, selected);
      expect(page.partial).toBe(true);
      expect(length(page)).toBeLessThanOrEqual(ARGUMENT_PAGE_MAX);
      expect(ArgumentPageSchema.safeParse(page).success).toBe(true);
      expect(page.note?.length).toBeLessThanOrEqual(ARGUMENT_NOTE_MAX);
      expect(page.note).toContain(ACTIONS);
    }
  });

  it("the worst graph with escape-heavy ids and titles still fits (the last level keeps what fits)", () => {
    const graph = worstGraph(false);
    graph.arguments = graph.arguments.map((a, i) => ({
      ...a,
      id: `${i}`.padStart(4, "0") + '"\\\n\u0001'.repeat(10).slice(0, 60),
      title: '"\n'.repeat(26),
    }));
    graph.edges = [];
    const page = build(graph, graph.arguments[3]?.id ?? null);
    expect(length(page)).toBeLessThanOrEqual(ARGUMENT_PAGE_MAX);
    expect(ArgumentPageSchema.safeParse(page).success).toBe(true);
  });

  it("goes through the levels one by one, each shorter than the one before it, each a valid page", () => {
    // 60 arguments with long claims: level 1 (selected in full) fits
    const level1 = build(graphOf(60, 2000), "a5");
    expect(level1.reduction).toMatchObject({ level: 1, textLimit: null, truncated: [] });
    expect(level1.edges).toHaveLength(59);
    expect(level1.selected?.claim.length).toBe(2000);

    // a selected argument at every limit: level 2 cuts its texts and says which
    const heavy = graphOf(3);
    heavy.arguments[1] = {
      ...(heavy.arguments[1] as ArgumentGraph["arguments"][number]),
      claim: "c".repeat(20_000),
      grounds: "g".repeat(20_000),
      warrant: "w".repeat(20_000),
      backing: "b".repeat(20_000),
      qualifier: "q".repeat(20_000),
      rebuttal: "r".repeat(20_000),
      sources: Array.from({ length: 50 }, (_, i) => ({
        text: "s".repeat(20_000),
        target: { doc_id: `d${i}`, page: 3 },
      })),
    };
    const level2 = build(heavy, "a1");
    expect(level2.partial).toBe(true);
    expect(level2.reduction?.level).toBe(2);
    expect(level2.reduction?.textLimit).toEqual({ field: 4000, source: 500 });
    expect(level2.reduction?.truncated).toContain("claim");
    expect(level2.reduction?.truncated).toContain("sources.49.text");
    expect(level2.selected?.claim.length).toBe(4000);
    expect(level2.selected?.sources[49]?.text.length).toBe(500);
    expect(level2.selected?.sources[0]?.target).toEqual({ doc_id: "d0", page: 3 });
    expect(level2.edges).toHaveLength(2);
    expect(level2.note).toContain("cut to 4000");
    expect(level2.note).toContain(ACTIONS);
    expect(ArgumentPageSchema.safeParse(level2).success).toBe(true);
    expect(length(level2)).toBeLessThanOrEqual(ARGUMENT_PAGE_MAX);

    // thousands of edges: level 3 keeps only the edges that touch the selected argument
    const dense = graphOf(100);
    const roles = ["grounds", "warrant", "backing", "rebuttal"] as const;
    dense.edges = [];
    for (let i = 0; dense.edges.length < 5000; i++)
      for (const role of roles)
        if (dense.edges.length < 5000)
          dense.edges.push({ from: `a${(i * 7 + 1) % 100}`, to: `a${i % 100}`, role });
    dense.arguments = dense.arguments.map((a, i) => ({ ...a, id: longId(i) }));
    dense.edges = dense.edges.map((e) => ({
      ...e,
      from: longId(Number(e.from.slice(1))),
      to: longId(Number(e.to.slice(1))),
    }));
    dense.arguments[1] = {
      ...(dense.arguments[1] as ArgumentGraph["arguments"][number]),
      claim: "c".repeat(20_000),
    };
    const level3 = build(dense, longId(1));
    expect(level3.reduction?.level).toBe(3);
    expect(level3.counts.edges).toBe(5000);
    expect(level3.edges?.length).toBeLessThan(5000);
    expect(level3.edges?.every((e) => e.from === longId(1) || e.to === longId(1))).toBe(true);
    expect(level3.note).toContain("only the selected argument's edges");
    expect(ArgumentPageSchema.safeParse(level3).success).toBe(true);
    expect(length(level3)).toBeLessThanOrEqual(ARGUMENT_PAGE_MAX);

    // an outline that alone does not fit: level 4 keeps id, title, kind, caps the audit and says how many it left out
    const level4 = build(worstGraph(), longId(250));
    expect(level4.reduction?.level).toBe(4);
    expect(level4.outline?.every((e) => e.filled === undefined && e.sources === undefined)).toBe(
      true
    );
    expect(level4.outline?.some((e) => e.id === longId(250))).toBe(true);
    expect(level4.audit?.total).toBeGreaterThan(0);
    expect(ArgumentPageSchema.safeParse(level4).success).toBe(true);
    expect(length(level4)).toBeLessThanOrEqual(ARGUMENT_PAGE_MAX);
  });

  it("never picks a form longer than the whole page: 500 short arguments", () => {
    const graph = graphOf(500, 0);
    graph.arguments = graph.arguments.map((a) => ({
      ...a,
      title: "T".repeat(40),
      claim: "c".repeat(40),
      grounds: "g".repeat(40),
    }));
    const graphLength = length(graph);
    expect(graphLength).toBeGreaterThan(ARGUMENT_PAGE_FULL_MAX / 2);
    const page = build(graph, "a7");
    const wholeLength = length({ ...page, partial: false });
    expect(length(page)).toBeLessThanOrEqual(ARGUMENT_PAGE_MAX);
    if (graphLength > ARGUMENT_PAGE_FULL_MAX) {
      // over the budget: whatever form is chosen is not longer than the whole graph's page would have been
      const whole = {
        ...page,
        partial: false,
        graph,
        outline: null,
        edges: null,
        selected: null,
        reduction: null,
      };
      expect(length(page)).toBeLessThanOrEqual(length(whole));
    }
    expect(wholeLength).toBeGreaterThan(0);
  });

  it("a sparse graph just over the budget is sent whole when every reduction would be longer", () => {
    // 500 arguments of one-word text: the graph is ~110 KB but a listing of it is longer than the graph
    const graph = graphOf(500, 0);
    graph.arguments = graph.arguments.map((a) => ({ ...a, claim: "c", grounds: "" }));
    graph.edges = [];
    const padded = {
      ...graph,
      arguments: graph.arguments.map((a, i) => ({ ...a, id: longId(i), grounds: "", title: "T" })),
    };
    const page = build(padded, null);
    const wholeLength = length({
      ...page,
      partial: false,
      graph: padded,
      outline: null,
      edges: null,
      selected: null,
      reduction: null,
    });
    expect(length(page)).toBeLessThanOrEqual(Math.min(wholeLength, ARGUMENT_PAGE_MAX));
    expect(ArgumentPageSchema.safeParse(page).success).toBe(true);
  });
});

describe("the schema holds each form to its shape", () => {
  const page = () => build(graphOf(60, 2000), "a5");
  it("a partial page must say what it left out and must match it", () => {
    const p = page();
    expect(ArgumentPageSchema.safeParse(p).success).toBe(true);
    expect(ArgumentPageSchema.safeParse({ ...p, reduction: null }).success).toBe(false);
    expect(
      ArgumentPageSchema.safeParse({ ...p, reduction: { ...p.reduction, level: 3 } }).success
    ).toBe(false);
    expect(
      ArgumentPageSchema.safeParse({
        ...p,
        reduction: { ...p.reduction, level: 4, textLimit: { field: 1, source: 1 } },
      }).success
    ).toBe(false);
    expect(ArgumentPageSchema.safeParse({ ...p, edges: (p.edges ?? []).slice(1) }).success).toBe(
      false
    );
    expect(
      ArgumentPageSchema.safeParse({ ...p, reduction: { ...p.reduction, extra: 1 } }).success
    ).toBe(false);
    const whole = build(graphOf(3), "a1");
    expect(ArgumentPageSchema.safeParse({ ...whole, reduction: p.reduction }).success).toBe(false);
  });
  it("a whole page's graph belongs to its Work", () => {
    const whole = build(graphOf(3), "a1");
    expect(
      ArgumentPageSchema.safeParse({
        ...whole,
        graph: { ...whole.graph, work_id: "doi:10.1/other" },
      }).success
    ).toBe(false);
  });
});

describe("every phase says why Library actions are refused", () => {
  it.each(["loading", "not-found", "corrupt", "error"] as const)("%s", (phase) => {
    const page = buildArgumentPage({
      workId: "w",
      title: "W",
      phase,
      graph: null,
      selectedId: null,
    });
    expect(page.note).toContain(ACTIONS);
    expect(ArgumentPageSchema.safeParse(page).success).toBe(true);
  });
  it("whole, partial, empty and stale forms", () => {
    expect(build(graphOf(3), "a1").note).toContain(ACTIONS);
    expect(build(graphOf(60, 2000), "a1").note).toContain(ACTIONS);
    expect(build(graphOf(0)).note).toContain(ACTIONS);
    const stale = buildArgumentPage({
      workId: "doi:10.1/x",
      title: "W",
      phase: "ready",
      graph: graphOf(3),
      selectedId: null,
      stale: true,
    });
    expect(stale.note).toContain("may be out of date");
    expect(ArgumentPageSchema.safeParse(stale).success).toBe(true);
  });
});

describe("the observation form", () => {
  const observation = (
    argument: ReturnType<typeof build>,
    status: "complete" | "unavailable" | "error"
  ) => ({
    version: 1,
    taskContextId: "7d2f6d2e-5b3b-4f6a-9d7e-0a1b2c3d4e5f",
    page: {
      version: 1,
      viewId: "7d2f6d2e-5b3b-4f6a-9d7e-0a1b2c3d4e5f",
      revision: 2,
      paneId: 1,
      view: "library",
      otherPanes: [],
      status,
      plan: null,
      argument,
    },
  });

  it("an empty graph that the task holds is left as it is: still a legal page", () => {
    const empty = build(graphOf(0));
    expect(empty.phase).toBe("empty");
    const held = new Set([argumentKey("doi:10.1/x", 2)]);
    const listed = observationArgumentPage({ argument: empty }, held).argument;
    expect(listed).toBe(empty);
    expect(ArgumentPageSchema.safeParse(listed).success).toBe(true);
    expect(
      CopilotObservationSchema.safeParse(observation(listed as never, "complete")).success
    ).toBe(true);
  });

  it.each([
    ["loading", "unavailable"],
    ["not-found", "error"],
    ["corrupt", "error"],
    ["error", "error"],
  ] as const)("a %s page round-trips through the observation schema", (phase, status) => {
    const page = buildArgumentPage({
      workId: "doi:10.1/x",
      title: "W",
      phase,
      graph: null,
      selectedId: null,
    });
    const held = new Set([argumentKey("doi:10.1/x", 2)]);
    const listed = observationArgumentPage({ argument: page }, held).argument;
    expect(CopilotObservationSchema.safeParse(observation(listed as never, status)).success).toBe(
      true
    );
  });

  it("a ready page that the task holds round-trips as the reduced form", () => {
    const page = build(graphOf(60, 100), "a5");
    const held = new Set([argumentKey("doi:10.1/x", 2)]);
    expect(page.partial).toBe(false);
    const listed = observationArgumentPage({ argument: page }, held).argument;
    expect(listed?.partial).toBe(true);
    expect(listed?.note).toContain("in the task's context");
    expect(listed?.note).toContain(ACTIONS);
    expect(
      CopilotObservationSchema.safeParse(observation(listed as never, "complete")).success
    ).toBe(true);
  });

  it("a held form is never longer than the page it replaces", () => {
    // sparse, wide ids: a listing of it is longer than the graph itself
    const graph = graphOf(10, 0);
    graph.arguments = graph.arguments.map((a) => ({ ...a, claim: "", grounds: "" }));
    const page = build(graph, "a3");
    const held = new Set([argumentKey("doi:10.1/x", 2)]);
    const listed = observationArgumentPage({ argument: page }, held).argument;
    expect(length(listed)).toBeLessThanOrEqual(length(page));
  });
});
