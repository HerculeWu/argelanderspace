/**
 * The argument graph edit operations (ticket 05): the pure half of the one commit path. Each operation's accepted and
 * refused cases, that results are always schema-valid, the delete/restore round trip, and the readable issues.
 */

import { describe, expect, it } from "vitest";
import {
  addEdge,
  autoSourceText,
  checkArgumentGraphForWrite,
  clearArgumentGraph,
  createArgument,
  deleteArgument,
  nextArgumentId,
  removeEdge,
  restoreArgument,
  sameArgument,
  updateArgument,
} from "../src/argument-edit.js";
import {
  ARGUMENT_GRAPH_LIMITS,
  type Argument,
  type ArgumentGraph,
  ArgumentGraphSchema,
} from "../src/argument-graph.js";

const empty: ArgumentGraph = { version: 1, rev: 3, work_id: "w", arguments: [], edges: [] };
const must = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
};
const built = () => {
  let g = must(createArgument(empty, { title: "A", claim: "a" }, "a")).graph;
  g = must(createArgument(g, { title: "B" }, "b")).graph;
  g = must(createArgument(g, { title: "C", kind: "end" }, "c")).graph;
  g = must(addEdge(g, { from: "a", to: "b", role: "grounds" })).graph;
  g = must(addEdge(g, { from: "b", to: "c", role: "grounds" })).graph;
  g = must(addEdge(g, { from: "a", to: "c", role: "warrant" })).graph;
  return g;
};

describe("createArgument / updateArgument", () => {
  it("appends with a fresh id, keeps rev, and fills every other field with its default", () => {
    const r = must(createArgument(empty, { title: "  Gaia  " }));
    expect(r.id).toMatch(/^a[0-9a-z]{5}$/);
    expect(r.graph.rev).toBe(3);
    expect(r.graph.arguments[0]).toMatchObject({
      id: r.id,
      title: "  Gaia  ",
      claim: "",
      kind: "normal",
      warrant_implicit: false,
      sources: [],
    });
    expect(ArgumentGraphSchema.safeParse(r.graph).success).toBe(true);
    expect(nextArgumentId(r.graph)).not.toBe(r.id);
  });
  it("an id is never the smallest free number: deleting the last argument does not hand its id to the next one", () => {
    const seq = [0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5];
    const draws = (): (() => number) => {
      let i = 0;
      return () => seq[i++ % seq.length] ?? 0;
    };
    expect(nextArgumentId({ arguments: [] }, draws())).toBe("a00000");
    // the pinned draw repeats until the id is free
    expect(nextArgumentId({ arguments: [{ id: "a00000" }] }, draws())).toBe("aiiiii");
    const first = must(createArgument(empty, { title: "一" }));
    const gone = must(deleteArgument(first.graph, first.id));
    const second = must(createArgument(gone.graph, { title: "二" }));
    expect(second.id).not.toBe(first.id);
  });
  it("refuses a blank title and a taken id, saying which", () => {
    expect(createArgument(empty, { title: "  " })).toEqual({
      ok: false,
      rejection: {
        code: "invalid",
        issues: [{ code: "title_blank", argumentId: expect.stringMatching(/^a[0-9a-z]{5}$/) }],
      },
    });
    const g = built();
    const dup = createArgument(g, { title: "x" }, "a");
    expect(dup.ok).toBe(false);
    if (!dup.ok)
      expect(dup.rejection).toMatchObject({
        code: "invalid",
        issues: [{ code: "duplicate_id", argumentId: "a" }],
      });
  });
  it("updates only the given fields and refuses an unknown argument", () => {
    const g = built();
    const r = must(
      updateArgument(g, "b", {
        claim: "new",
        kind: "native",
        warrant_implicit: true,
        sources: [{ text: "Section 3.2", target: { doc_id: "d", anchor: "sec-3" } }],
      })
    );
    expect(r.graph.arguments[1]).toMatchObject({
      id: "b",
      title: "B",
      claim: "new",
      kind: "native",
      warrant_implicit: true,
    });
    expect(r.graph.arguments[1]?.sources).toHaveLength(1);
    expect(r.graph.edges).toEqual(g.edges);
    expect(updateArgument(g, "zz", { claim: "x" })).toEqual({
      ok: false,
      rejection: { code: "not_found", id: "zz" },
    });
  });
  it("reports the limits as readable issues: long title, long field, blank source text, too many sources", () => {
    const g = built();
    const long = "x".repeat(ARGUMENT_GRAPH_LIMITS.titleChars + 1);
    expect(updateArgument(g, "a", { title: long })).toMatchObject({
      ok: false,
      rejection: { issues: [{ code: "title_too_long", argumentId: "a", limit: 80 }] },
    });
    expect(updateArgument(g, "a", { claim: "x".repeat(20_001) })).toMatchObject({
      ok: false,
      rejection: { issues: [{ code: "field_too_long", field: "claim", limit: 20_000 }] },
    });
    expect(updateArgument(g, "a", { sources: [{ text: "" }] })).toMatchObject({
      ok: false,
      rejection: { issues: [{ code: "source_text_blank", index: 0 }] },
    });
    expect(
      updateArgument(g, "a", { sources: Array.from({ length: 51 }, () => ({ text: "s" })) })
    ).toMatchObject({
      ok: false,
      rejection: { issues: [{ code: "too_many_sources", limit: 50 }] },
    });
  });
  it("refuses a 501st argument", () => {
    let g = empty;
    for (let i = 0; i < 500; i++) g = must(createArgument(g, { title: `t${i}` })).graph;
    expect(createArgument(g, { title: "one more" })).toMatchObject({
      ok: false,
      rejection: { issues: [{ code: "too_many_arguments", limit: 500 }] },
    });
  });
});

describe("edges", () => {
  it("refuses a self-loop, an unknown end and a duplicate (same pair, same role) but allows another role", () => {
    const g = built();
    expect(addEdge(g, { from: "a", to: "a", role: "grounds" })).toEqual({
      ok: false,
      rejection: { code: "self_loop", id: "a" },
    });
    expect(addEdge(g, { from: "a", to: "zz", role: "grounds" })).toEqual({
      ok: false,
      rejection: { code: "not_found", id: "zz" },
    });
    expect(addEdge(g, { from: "a", to: "b", role: "grounds" })).toEqual({
      ok: false,
      rejection: { code: "duplicate_edge", from: "a", to: "b", role: "grounds" },
    });
    expect(must(addEdge(g, { from: "a", to: "b", role: "backing" })).graph.edges).toHaveLength(4);
  });
  it("allows cycles (an audit finding, not a write failure) and removes exactly one edge", () => {
    const g = built();
    const cyc = must(addEdge(g, { from: "c", to: "a", role: "grounds" })).graph;
    expect(cyc.edges).toHaveLength(4);
    const r = must(removeEdge(g, { from: "a", to: "c", role: "warrant" }));
    expect(r.graph.edges.map((e) => `${e.from}>${e.to}:${e.role}`)).toEqual([
      "a>b:grounds",
      "b>c:grounds",
    ]);
    expect(removeEdge(g, { from: "a", to: "c", role: "grounds" })).toMatchObject({
      ok: false,
      rejection: { code: "edge_not_found" },
    });
  });
});

describe("delete and restore", () => {
  it("deleting takes the argument and its edges; restoring on the graph it produced gives back the original", () => {
    const g = built();
    const d = must(deleteArgument(g, "b"));
    expect(d.graph.arguments.map((a) => a.id)).toEqual(["a", "c"]);
    expect(d.graph.edges).toEqual([{ from: "a", to: "c", role: "warrant" }]);
    expect(d.removed.edges.map((e) => e.index)).toEqual([0, 1]);
    const back = must(restoreArgument(d.graph, d.removed));
    expect(back.graph).toEqual(g);
    expect(deleteArgument(g, "zz")).toEqual({
      ok: false,
      rejection: { code: "not_found", id: "zz" },
    });
  });
  it("clearing empties the graph and keeps the Work and rev", () => {
    const r = must(clearArgumentGraph(built()));
    expect(r.graph).toEqual(empty);
  });
});

describe("helpers", () => {
  it("auto text for a target: Section 3.2, Figure 4, Table 2, Equation 7, Page 5, never the section sign", () => {
    expect(autoSourceText("section", "3.2")).toBe("Section 3.2");
    expect(autoSourceText("figure", "4")).toBe("Figure 4");
    expect(autoSourceText("table", 2)).toBe("Table 2");
    expect(autoSourceText("equation", "7")).toBe("Equation 7");
    expect(autoSourceText("page", 5)).toBe("Page 5");
    expect(autoSourceText("section", "3.2")).not.toContain("§");
  });
  it("sameArgument compares content; checkArgumentGraphForWrite is [] for a valid graph and never throws on junk", () => {
    const g = built();
    expect(
      sameArgument(g.arguments[0] as Argument, structuredClone(g.arguments[0]) as Argument)
    ).toBe(true);
    expect(sameArgument(g.arguments[0] as Argument, g.arguments[1] as Argument)).toBe(false);
    expect(checkArgumentGraphForWrite(g)).toEqual([]);
    expect(checkArgumentGraphForWrite(null).length).toBeGreaterThan(0);
  });
});
