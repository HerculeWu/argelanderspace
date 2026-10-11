/**
 * The argument graph contract (ADR 0009): schema round trip, each write-time
 * structural rule (positive + negative), the size limits, the WS message, and
 * the six audit findings — including that cycles / incompleteness / End with
 * out-edges / Native with in-edges are NOT write failures.
 */

import { describe, expect, it } from "vitest";
import {
  ARGUMENT_GRAPH_LIMITS,
  type Argument,
  type ArgumentEdge,
  type ArgumentGraph,
  ArgumentGraphSchema,
  auditArgumentGraph,
  checkArgumentGraphStructure,
  WsArgumentGraphChangedSchema,
} from "../src/argument-graph.js";
import { WsServerMessageSchema } from "../src/jobs.js";

const arg = (id: string, over: Partial<Argument> = {}): Argument => ({
  id,
  title: `title ${id}`,
  claim: `claim ${id}`,
  grounds: `grounds ${id}`,
  warrant: `warrant ${id}`,
  backing: "",
  qualifier: "",
  rebuttal: "",
  warrant_implicit: false,
  kind: "normal",
  sources: [],
  ...over,
});
const edge = (from: string, to: string, role: ArgumentEdge["role"] = "grounds"): ArgumentEdge => ({
  from,
  to,
  role,
});
const graph = (args: Argument[], edges: ArgumentEdge[], rev = 0): ArgumentGraph => ({
  version: 1,
  rev,
  work_id: "doi:10.1051/0004-6361/202039341",
  arguments: args,
  edges,
});

describe("ArgumentGraphSchema", () => {
  it("round-trips a full graph", () => {
    const g = graph(
      [
        arg("a", {
          kind: "native",
          warrant_implicit: true,
          sources: [
            { text: "Section 3.2", target: { doc_id: "arxiv-2501.17225", anchor: "sec-3" } },
            { text: "p. 4", target: { doc_id: "pdf-1", page: 4 } },
            { text: "somewhere" },
          ],
        }),
        arg("b", { kind: "end" }),
      ],
      [edge("a", "b", "warrant")],
      3
    );
    expect(ArgumentGraphSchema.parse(JSON.parse(JSON.stringify(g)))).toEqual(g);
  });

  it("defaults the optional argument fields", () => {
    const parsed = ArgumentGraphSchema.parse({
      version: 1,
      rev: 0,
      work_id: "w",
      arguments: [{ id: "a", title: "T" }],
      edges: [],
    });
    expect(parsed.arguments[0]).toEqual(
      arg("a", { title: "T", claim: "", grounds: "", warrant: "" })
    );
  });

  it("accepts the empty graph and rejects other versions / negative rev / unknown keys", () => {
    expect(ArgumentGraphSchema.safeParse(graph([], [])).success).toBe(true);
    expect(ArgumentGraphSchema.safeParse({ ...graph([], []), version: 2 }).success).toBe(false);
    expect(ArgumentGraphSchema.safeParse({ ...graph([], []), rev: -1 }).success).toBe(false);
    expect(ArgumentGraphSchema.safeParse({ ...graph([], []), extra: 1 }).success).toBe(false);
    expect(ArgumentGraphSchema.safeParse({ ...graph([], []), work_id: "" }).success).toBe(false);
  });

  describe("structural rules", () => {
    it("unique argument ids", () => {
      expect(ArgumentGraphSchema.safeParse(graph([arg("a"), arg("b")], [])).success).toBe(true);
      const r = ArgumentGraphSchema.safeParse(graph([arg("a"), arg("a")], []));
      expect(r.success).toBe(false);
    });

    it("short title non-empty after trim", () => {
      expect(ArgumentGraphSchema.safeParse(graph([arg("a", { title: " x " })], [])).success).toBe(
        true
      );
      for (const title of ["", "   ", "\n\t"]) {
        expect(ArgumentGraphSchema.safeParse(graph([arg("a", { title })], [])).success).toBe(false);
      }
    });

    it("both ends of every edge exist", () => {
      const args = [arg("a"), arg("b")];
      expect(ArgumentGraphSchema.safeParse(graph(args, [edge("a", "b")])).success).toBe(true);
      expect(ArgumentGraphSchema.safeParse(graph(args, [edge("a", "zz")])).success).toBe(false);
      expect(ArgumentGraphSchema.safeParse(graph(args, [edge("zz", "b")])).success).toBe(false);
    });

    it("no self-loop", () => {
      const r = ArgumentGraphSchema.safeParse(graph([arg("a")], [edge("a", "a", "rebuttal")]));
      expect(r.success).toBe(false);
    });

    it("at most one edge per (from, to, role); other roles and directions are fine", () => {
      const args = [arg("a"), arg("b")];
      expect(
        ArgumentGraphSchema.safeParse(
          graph(args, [
            edge("a", "b", "grounds"),
            edge("a", "b", "warrant"),
            edge("b", "a", "grounds"),
          ])
        ).success
      ).toBe(true);
      expect(
        ArgumentGraphSchema.safeParse(
          graph(args, [edge("a", "b", "grounds"), edge("a", "b", "grounds")])
        ).success
      ).toBe(false);
    });

    it("reports every violation", () => {
      const issues = checkArgumentGraphStructure({
        arguments: [{ id: "a" }, { id: "a" }],
        edges: [
          { from: "a", to: "a", role: "grounds" },
          { from: "a", to: "q", role: "grounds" },
        ],
      });
      expect(issues.map((i) => i.path.join("."))).toEqual([
        "arguments.1.id",
        "edges.0",
        "edges.1.to",
      ]);
    });

    it("source target carries an anchor or a page, not both", () => {
      const withTarget = (target: object) =>
        graph([arg("a", { sources: [{ text: "x", target: target as never }] })], []);
      expect(ArgumentGraphSchema.safeParse(withTarget({ doc_id: "d", page: 1 })).success).toBe(
        true
      );
      expect(
        ArgumentGraphSchema.safeParse(withTarget({ doc_id: "d", anchor: "sec-1", page: 1 })).success
      ).toBe(false);
      expect(ArgumentGraphSchema.safeParse(withTarget({ doc_id: "d", page: 0 })).success).toBe(
        false
      );
      expect(ArgumentGraphSchema.safeParse(withTarget({ doc_id: "" })).success).toBe(false);
    });

    it("a cycle, missing Claim/Grounds/Warrant, End with out-edge, Native with in-edge are NOT write failures", () => {
      const g = graph(
        [
          arg("a", { claim: "", kind: "end" }),
          arg("b", { grounds: "", warrant: "", kind: "native" }),
          arg("c"),
        ],
        [edge("a", "b"), edge("b", "c"), edge("c", "b", "warrant")]
      );
      expect(ArgumentGraphSchema.safeParse(g).success).toBe(true);
    });
  });

  describe("size limits", () => {
    const at = (n: number) => "x".repeat(n);
    it("arguments <= 500", () => {
      const many = (n: number) => Array.from({ length: n }, (_, i) => arg(`a${i}`));
      expect(
        ArgumentGraphSchema.safeParse(graph(many(ARGUMENT_GRAPH_LIMITS.arguments), [])).success
      ).toBe(true);
      expect(
        ArgumentGraphSchema.safeParse(graph(many(ARGUMENT_GRAPH_LIMITS.arguments + 1), [])).success
      ).toBe(false);
    });
    it("edges <= 5000", () => {
      // 100 arguments give 9900 ordered pairs; one role is enough.
      const args = Array.from({ length: 100 }, (_, i) => arg(`a${i}`));
      const edgesN = (n: number) => {
        const out: ArgumentEdge[] = [];
        for (let i = 0; i < 100 && out.length < n; i++)
          for (let j = 0; j < 100 && out.length < n; j++)
            if (i !== j) out.push(edge(`a${i}`, `a${j}`));
        return out;
      };
      expect(ArgumentGraphSchema.safeParse(graph(args, edgesN(5000))).success).toBe(true);
      expect(ArgumentGraphSchema.safeParse(graph(args, edgesN(5001))).success).toBe(false);
    });
    it("title <= 80 chars", () => {
      expect(ArgumentGraphSchema.safeParse(graph([arg("a", { title: at(80) })], [])).success).toBe(
        true
      );
      expect(ArgumentGraphSchema.safeParse(graph([arg("a", { title: at(81) })], [])).success).toBe(
        false
      );
    });
    it("each Toulmin field <= 20000 chars", () => {
      for (const f of [
        "claim",
        "grounds",
        "warrant",
        "backing",
        "qualifier",
        "rebuttal",
      ] as const) {
        expect(
          ArgumentGraphSchema.safeParse(graph([arg("a", { [f]: at(20_000) })], [])).success
        ).toBe(true);
        expect(
          ArgumentGraphSchema.safeParse(graph([arg("a", { [f]: at(20_001) })], [])).success
        ).toBe(false);
      }
    });
    it("sources per argument <= 50", () => {
      const sources = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `s${i}` }));
      expect(
        ArgumentGraphSchema.safeParse(graph([arg("a", { sources: sources(50) })], [])).success
      ).toBe(true);
      expect(
        ArgumentGraphSchema.safeParse(graph([arg("a", { sources: sources(51) })], [])).success
      ).toBe(false);
    });
  });
});

describe("argument-graph.changed", () => {
  const msg = {
    type: "argument-graph.changed",
    work_id: "doi:10.1/x",
    cause: "external",
    at: "2026-10-12T00:00:00Z",
  };
  it("parses standalone and as a member of the WsServerMessage union", () => {
    expect(WsArgumentGraphChangedSchema.safeParse(msg).success).toBe(true);
    expect(WsServerMessageSchema.safeParse(msg).success).toBe(true);
    expect(WsServerMessageSchema.safeParse({ ...msg, work_id: undefined }).success).toBe(false);
  });
});

describe("auditArgumentGraph", () => {
  const clean = () =>
    graph(
      [arg("n", { kind: "native" }), arg("m"), arg("e", { kind: "end" })],
      [edge("n", "m"), edge("m", "e", "warrant")]
    );

  it("a sound graph has no findings", () => {
    expect(auditArgumentGraph(clean())).toEqual({
      cycles: [],
      noPathToEnd: [],
      noEnd: false,
      endWithOutEdge: [],
      nativeWithInEdge: [],
      incomplete: [],
    });
  });

  it("1. cycles: SCCs of two or more with their edges; acyclic graphs and DAG diamonds have none", () => {
    const g = graph(
      [arg("a"), arg("b"), arg("c"), arg("d", { kind: "end" })],
      [edge("a", "b"), edge("b", "c"), edge("c", "a", "rebuttal"), edge("c", "d")]
    );
    expect(ArgumentGraphSchema.safeParse(g).success).toBe(true); // storable
    const audit = auditArgumentGraph(g);
    expect(audit.cycles).toEqual([
      {
        arguments: ["a", "b", "c"],
        edges: [edge("a", "b"), edge("b", "c"), edge("c", "a", "rebuttal")],
      },
    ]);
    expect(auditArgumentGraph(clean()).cycles).toEqual([]);
    const diamond = graph(
      [arg("a"), arg("b"), arg("c"), arg("d", { kind: "end" })],
      [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")]
    );
    expect(auditArgumentGraph(diamond).cycles).toEqual([]);
  });

  it("1. two separate cycles are two entries; a long chain does not overflow", () => {
    const g = graph(
      [arg("a"), arg("b"), arg("c"), arg("d")],
      [edge("a", "b"), edge("b", "a"), edge("c", "d"), edge("d", "c")]
    );
    expect(auditArgumentGraph(g).cycles.map((c) => c.arguments)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    const n = 500;
    const chain = graph(
      Array.from({ length: n }, (_, i) => arg(`a${i}`, i === n - 1 ? { kind: "end" } : {})),
      Array.from({ length: n - 1 }, (_, i) => edge(`a${i}`, `a${i + 1}`))
    );
    expect(auditArgumentGraph(chain).cycles).toEqual([]);
    expect(auditArgumentGraph(chain).noPathToEnd).toEqual([]);
  });

  it("2. arguments with no path to an End", () => {
    const g = graph(
      [arg("n", { kind: "native" }), arg("m"), arg("lost"), arg("e", { kind: "end" })],
      [edge("n", "m"), edge("m", "e")]
    );
    expect(auditArgumentGraph(g).noPathToEnd).toEqual(["lost"]);
    // Direction matters: an End's supporter reaches it, not the other way round.
    const rev = graph([arg("e", { kind: "end" }), arg("x")], [edge("e", "x")]);
    expect(auditArgumentGraph(rev).noPathToEnd).toEqual(["x"]);
    expect(auditArgumentGraph(clean()).noPathToEnd).toEqual([]);
  });

  it("3. no End argument (and then every non-End argument has no path)", () => {
    const g = graph([arg("a"), arg("b")], [edge("a", "b")]);
    const audit = auditArgumentGraph(g);
    expect(audit.noEnd).toBe(true);
    expect(audit.noPathToEnd).toEqual(["a", "b"]);
    expect(auditArgumentGraph(clean()).noEnd).toBe(false);
    expect(auditArgumentGraph(graph([], [])).noEnd).toBe(true);
  });

  it("4. End with an out-edge", () => {
    const g = graph(
      [arg("e", { kind: "end" }), arg("f", { kind: "end" }), arg("x")],
      [edge("e", "x"), edge("x", "f")]
    );
    expect(auditArgumentGraph(g).endWithOutEdge).toEqual(["e"]);
    expect(auditArgumentGraph(clean()).endWithOutEdge).toEqual([]);
  });

  it("5. Native with an in-edge", () => {
    const g = graph(
      [arg("n", { kind: "native" }), arg("m", { kind: "native" }), arg("e", { kind: "end" })],
      [edge("m", "n"), edge("n", "e")]
    );
    expect(auditArgumentGraph(g).nativeWithInEdge).toEqual(["n"]);
    expect(auditArgumentGraph(clean()).nativeWithInEdge).toEqual([]);
  });

  describe("6. incomplete", () => {
    it("missing Claim (blank counts)", () => {
      const g = graph([arg("a", { claim: "  \n" })], []);
      expect(auditArgumentGraph(g).incomplete).toEqual([{ id: "a", missing: ["claim"] }]);
    });
    it("Grounds / Warrant satisfied by own text", () => {
      const g = graph([arg("a", { grounds: "g", warrant: "w" })], []);
      expect(auditArgumentGraph(g).incomplete).toEqual([]);
    });
    it("Grounds / Warrant satisfied by an in-edge of that role only", () => {
      const g = graph(
        [arg("a", { grounds: "", warrant: "" }), arg("s"), arg("t")],
        [edge("s", "a", "grounds"), edge("t", "a", "backing")]
      );
      expect(auditArgumentGraph(g).incomplete).toEqual([{ id: "a", missing: ["warrant"] }]);
      const g2 = graph(
        [arg("a", { grounds: "", warrant: "" }), arg("s"), arg("t")],
        [edge("s", "a", "grounds"), edge("t", "a", "warrant")]
      );
      expect(auditArgumentGraph(g2).incomplete).toEqual([]);
    });
    it("an out-edge of the role does not count; an implicit warrant does not satisfy", () => {
      const g = graph(
        [arg("a", { grounds: "", warrant: "", warrant_implicit: true }), arg("s")],
        [edge("a", "s", "grounds")]
      );
      expect(auditArgumentGraph(g).incomplete).toEqual([
        { id: "a", missing: ["grounds", "warrant"] },
      ]);
    });
    it("all three missing", () => {
      const g = graph([arg("a", { claim: "", grounds: "", warrant: "" })], []);
      expect(auditArgumentGraph(g).incomplete).toEqual([
        { id: "a", missing: ["claim", "grounds", "warrant"] },
      ]);
    });
  });

  it("does not throw on a dangling edge (input that skipped validation)", () => {
    const g = { arguments: [arg("a")], edges: [edge("a", "ghost")] };
    expect(() => auditArgumentGraph(g)).not.toThrow();
  });
});
