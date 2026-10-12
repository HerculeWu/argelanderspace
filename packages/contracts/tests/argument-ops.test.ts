/**
 * The argument graph page for the Copilot (ticket 04): the budget between the whole and the partial form, the strict
 * shape, the audit it carries, the summary and the observation form.
 */
import { describe, expect, it } from "vitest";
import type { ArgumentGraph } from "../src/argument-graph.js";
import {
  ARGUMENT_PAGE_FULL_MAX,
  ArgumentPageSchema,
  argumentKey,
  buildArgumentPage,
  observationArgumentPage,
  summarizeArgumentPage,
} from "../src/argument-ops.js";
import { PageContextSchema } from "../src/copilot.js";
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
    expect(JSON.stringify(largest).length).toBeLessThan(
      ARGUMENT_PAGE_FULL_MAX + 25_000 + 500 * 400
    );
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
  it("lists a whole graph the task holds and leaves any other page alone", () => {
    const page = build(graphOf(4), "a2");
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
      observationArgumentPage({ argument: build(graphOf(4, 0, 3), "a2") }, held).argument?.partial
    ).toBe(false);
    expect(observationArgumentPage({ argument: page }).argument).toBe(page);
    const partial = build(graphOf(10, 20_000), "a1");
    expect(observationArgumentPage({ argument: partial }, held).argument).toBe(partial);
    expect(observationArgumentPage({ argument: null }, held).argument).toBeNull();
  });
});
