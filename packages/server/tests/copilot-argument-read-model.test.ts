/**
 * The `argument read` protocol against a model that does only what the notes say (argument graph ticket 09, review
 * round B). Many graphs (empty, normal, argument-heavy, edge-dense, the 500-argument worst case, huge arguments, odd ids,
 * Chinese and escape-dense text) x many rooms x the whole graph and `ids` forms: the walk always ends, every call that has
 * something left delivers something new, nothing is read twice, the assembled result equals the graph on disk exactly,
 * and no result is larger than the room it was given (UTF-8 bytes as the history counts them). A room too small for the
 * smallest part gets an honest `capacity` gap, never a result the window would have to withdraw.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ArgumentGraph, ArgumentGraphSchema } from "@argelanderspace/contracts";
import { argumentGraphPath, loadArgumentGraph } from "@argelanderspace/core";
import { describe, expect, test, vi } from "vitest";
import { ArgumentUndoRegistry, createArgumentTool } from "../src/copilot-argument-tool.js";
import { AsyncLock } from "../src/lock.js";
import { type Loose, walk } from "./argument-read-model.js";

// Each call would parse a graph of megabytes from disk again: the first load is the disk's, the rest are the same object.
const CACHE = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@argelanderspace/core", async (original) => {
  const real = await original<Loose>();
  return {
    ...real,
    loadArgumentGraph: (dir: string, id: string) => {
      const key = `${dir}\u0000${id}`;
      if (!CACHE.has(key)) CACHE.set(key, real.loadArgumentGraph(dir, id));
      return CACHE.get(key);
    },
  };
});

const dataDir = mkdtempSync(join(tmpdir(), "arg-read-model-"));
const works = new Map<string, { id: string; title: string; docIds: string[] }>();
let ROOM: number | undefined;
const tool = createArgumentTool({
  admitting: () => true,
  argument: {
    dataDir,
    lock: new AsyncLock(),
    onChanged: () => {},
    work: (id: string) => works.get(id) ?? null,
    undo: new ArgumentUndoRegistry(),
  },
  viewAction: async () => ({ kind: "none" }) as never,
  budget: () => ROOM as number,
} as never);
const toolNoRoom = createArgumentTool({
  admitting: () => true,
  argument: {
    dataDir,
    lock: new AsyncLock(),
    onChanged: () => {},
    work: (id: string) => works.get(id) ?? null,
    undo: new ArgumentUndoRegistry(),
  },
  viewAction: async () => ({ kind: "none" }) as never,
} as never);
let calls = 0;
const caller = async (params: Loose): Promise<string> => {
  const t = ROOM === undefined ? toolNoRoom : tool;
  const result = (await (t as Loose).execute(`c${calls++}`, params)) as Loose;
  return result.content[0].text as string;
};

const pattern = (tag: string, length: number) => {
  let out = "";
  for (let i = 0; out.length < length; i++) out += `${tag}${i}-`;
  return out.slice(0, length);
};
const repeatTo = (unit: string, length: number) =>
  unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
const A = (id: string, extra: Loose = {}) => ({
  id,
  title: `Title ${id}`.slice(0, 80),
  claim: `Claim ${id}`,
  grounds: `Grounds ${id}`,
  warrant: `Warrant ${id}`,
  backing: "",
  qualifier: "",
  rebuttal: "",
  warrant_implicit: false,
  kind: "normal",
  sources: [],
  ...extra,
});
const roles = ["grounds", "warrant", "backing", "rebuttal"] as const;
function pairs(ids: string[], count: number) {
  const out: Loose[] = [];
  outer: for (const role of roles)
    for (let d = 1; d < ids.length; d++)
      for (let i = 0; i < ids.length; i++) {
        if (out.length >= count) break outer;
        out.push({ from: ids[i], to: ids[(i + d) % ids.length], role });
      }
  return out;
}
const sources = (k: number, len: number, tag: string) =>
  Array.from({ length: k }, (_, i) => ({
    text: pattern(`${tag}${i}s`, len),
    ...(i % 3 === 0
      ? { target: { doc_id: `doc-${i}`, anchor: `sec-${i}` } }
      : i % 3 === 1
        ? { target: { doc_id: `pdf-${i}`, page: i + 1 } }
        : {}),
  }));
const huge = (id: string, fieldLen = 20000, nSources = 50, sourceLen = 20000) =>
  A(id, {
    claim: pattern("c", fieldLen),
    grounds: pattern("g", fieldLen),
    warrant: pattern("w", fieldLen),
    backing: pattern("b", fieldLen),
    qualifier: pattern("q", fieldLen),
    rebuttal: pattern("r", fieldLen),
    sources: sources(nSources, sourceLen, id.slice(0, 3)),
  });
const CJK = "观测数据表明潮汐尾的形状与理论预言不符，";
const DENSE = '\u0000\u0001"\\\n\t';

interface Case {
  graph: ArgumentGraph;
  title?: string;
  docs?: string[];
  ids: string[][];
}
let counter = 0;
function make(args: Loose[], edges: Loose[], over: Partial<Case> = {}): Case {
  const workId = `w:case${counter++}`;
  const graph = ArgumentGraphSchema.parse({
    version: 1,
    rev: 7,
    work_id: workId,
    arguments: args,
    edges,
  });
  works.set(workId, {
    id: workId,
    title: over.title ?? `Work ${workId}`,
    docIds: over.docs ?? ["d1", "d2"],
  });
  mkdirSync(dirname(argumentGraphPath(dataDir, workId)), { recursive: true });
  writeFileSync(argumentGraphPath(dataDir, workId), JSON.stringify(graph));
  return { graph, ids: over.ids ?? [], ...(over.title ? { title: over.title } : {}) };
}
const seq = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

const cases: Record<string, () => Case> = {
  empty: () => make([], [], { ids: [["ghost"], ["g1", "g2", "g1"]] }),
  normal: () => {
    const ids = seq("a", 12);
    return make(
      ids.map((i) => A(i)),
      ids.slice(1).map((id, i) => ({ from: id, to: ids[i], role: "grounds" })),
      {
        ids: [["a3", "ghost", "a1", "a3", "a11"], ids],
      }
    );
  },
  argsHeavy: () => {
    const ids = seq("m", 200);
    return make(
      ids.map((i) => A(i, { claim: pattern(i, 1500), grounds: pattern("g", 300) })),
      pairs(ids, 900),
      {
        ids: [
          ids.slice(0, 50),
          [...ids.slice(100, 120), "nope1", ...ids.slice(0, 20), "nope2", ids[100] as string],
        ],
      }
    );
  },
  argsHeavyMoreEdges: () => {
    const ids = seq("p", 100);
    return make(
      ids.map((i) => A(i, { claim: pattern(i, 800) })),
      pairs(ids, 1600),
      { ids: [ids.slice(0, 50)] }
    );
  },
  denseEdges: () => {
    const ids = seq("d", 40);
    return make(
      ids.map((i) => A(i)),
      pairs(ids, 5000),
      { ids: [ids.slice(0, 30), ["d0"]] }
    );
  },
  worst500: () => {
    const ids = Array.from(
      { length: 500 },
      (_, i) => `${"n".repeat(60)}${String(i).padStart(4, "0")}`
    );
    return make(
      ids.map((i, k) =>
        A(i, {
          title: "t".repeat(80),
          claim: pattern("c", 1500 + (k % 7) * 300),
          grounds: pattern("g", 900),
          warrant: k % 2 ? pattern("w", 700) : "",
          sources: sources(k % 4, 120, "x"),
        })
      ),
      pairs(ids, 5000),
      {
        title: "T".repeat(5000),
        docs: Array.from({ length: 300 }, (_, i) => `doc-${i}-${"d".repeat(400)}`),
        ids: [ids.slice(100, 150), ids.slice(0, 50).reverse()],
      }
    );
  },
  withHuge: () => {
    const ids = ["s0", "huge1", "s2", "s3", "huge2", "s5", "s6", "s7"];
    return make(
      ids.map((i) =>
        i === "huge1"
          ? huge(i)
          : i === "huge2"
            ? huge(i, 9000, 30, 4000)
            : A(i, { claim: pattern(i, 800) })
      ),
      pairs(ids, 60),
      { ids: [["huge1"], ["s0", "huge2", "ghost", "huge1", "s7"]] }
    );
  },
  weirdIds: () => {
    const ids = [
      'q"uote',
      "back\\slash",
      "new\nline",
      'x"], field "claim" and offset = 0',
      "论证一",
      "sp ace",
      "\u{1d465}\u{1d466}",
    ];
    return make(
      ids.map((i, k) =>
        k % 2 === 0
          ? A(i, {
              claim: pattern("c", 20000),
              grounds: pattern("g", 20000),
              warrant: pattern("w", 20000),
              backing: pattern("b", 20000),
              qualifier: pattern("q", 20000),
            })
          : A(i)
      ),
      pairs(ids, 12),
      { ids: [[ids[0] as string, ids[3] as string]] }
    );
  },
  astral: () => {
    const big = "\u{1d465}".repeat(4000) + DENSE.repeat(800) + "论证".repeat(2000);
    return make(
      [
        A("u0"),
        A("u1", {
          claim: big,
          grounds: `a${big}`,
          warrant: `ab${big}`,
          backing: `abc${big}`,
          sources: [
            { text: `x${big}` },
            { text: big, target: { doc_id: "D".repeat(512), anchor: "A".repeat(512) } },
          ],
        }),
        A("u2"),
      ],
      pairs(["u0", "u1", "u2"], 6),
      { ids: [["u1"]] }
    );
  },
  // Chinese: three bytes a character. 12 arguments of 3000 characters filled a 90 000-token window before the ruler was bytes.
  cjk12: () => {
    const ids = seq("c", 12);
    return make(
      ids.map((i) =>
        A(i, {
          title: `论证 ${i}`,
          claim: repeatTo(CJK, 3000),
          grounds: repeatTo(CJK, 1200),
          warrant: repeatTo(CJK, 800),
        })
      ),
      ids.slice(1).map((id, i) => ({ from: id, to: ids[i], role: "grounds" })),
      { title: "关于潮汐尾的论证".repeat(40), ids: [ids.slice(0, 6)] }
    );
  },
  cjkMany: () => {
    const ids = seq("k", 120);
    return make(
      ids.map((i) =>
        A(i, {
          title: `论证 ${i}`,
          claim: repeatTo(CJK, 2000),
          grounds: repeatTo(CJK, 900),
          sources: [{ text: repeatTo(CJK, 400), target: { doc_id: "文档", anchor: "第三节" } }],
        })
      ),
      pairs(ids, 900),
      { ids: [ids.slice(0, 40)] }
    );
  },
  cjkHuge: () => {
    const text = (n: number) => repeatTo(`${CJK}\u{1f600}"\n`, n);
    return make(
      [
        A("z0", { claim: text(800) }),
        A("zhuge", {
          title: "极大的论证",
          claim: text(20000),
          grounds: text(20000),
          warrant: text(20000),
          sources: Array.from({ length: 20 }, (_, i) => ({ text: text(6000 + i) })),
        }),
        A("z2", { claim: text(800) }),
      ],
      pairs(["z0", "zhuge", "z2"], 6),
      { ids: [["zhuge"]] }
    );
  },
  escapeDense: () => {
    const ids = seq("e", 30);
    return make(
      ids.map((i) =>
        A(i, { claim: repeatTo(DENSE, 3000), grounds: repeatTo(`"quoted" \\ \n`, 2000) })
      ),
      pairs(ids, 200),
      { ids: [ids.slice(0, 10)] }
    );
  },
};

// 3000 and 12000 are rooms too small for much of anything: a gap is the honest answer there. The rest must always read.
const ROOMS: (number | undefined)[] = [3_000, 12_000, 30_000, 60_000, 200_000, 400_000, undefined];
const MUST_READ_FROM = 12_000;

describe("a model that does only what the notes say reads every graph, in every room, to the end", () => {
  let groups = 0;
  for (const [name, build] of Object.entries(cases)) {
    test(name, async () => {
      const { graph, ids: idForms } = build();
      const onDisk = loadArgumentGraph(dataDir, graph.work_id);
      const failures: string[] = [];
      for (const room of ROOMS)
        for (const named of [undefined, ...idForms]) {
          ROOM = room;
          const report = await walk(caller, graph.work_id, room, named);
          groups++;
          const label = `${name} room=${room ?? "none"} ${named ? `ids(${named.length})` : "all"}`;
          if (report.gap) {
            // a gap is only honest when the room really cannot hold the smallest part, and only in a tiny room
            if (room === undefined || room >= MUST_READ_FROM)
              failures.push(
                `${label}: gap in a room that must read: ${report.gap.detail.slice(0, 200)}`
              );
            else if (report.gap.bytes < room - 8)
              failures.push(`${label}: gap of ${report.gap.bytes} in a room of ${room}`);
            continue;
          }
          if (!report.ok) {
            failures.push(`${label}: ${report.problems.join(" | ").slice(0, 700)}`);
            continue;
          }
          const byId = new Map(onDisk.arguments.map((a) => [a.id, a]));
          const uniq = named ? [...new Set(named)] : undefined;
          const wantArgs = uniq
            ? uniq.filter((i) => byId.has(i)).map((i) => byId.get(i))
            : onDisk.arguments;
          const wantMissing = uniq ? uniq.filter((i) => !byId.has(i)) : [];
          const touching = named ? new Set(named) : undefined;
          const wantEdges = touching
            ? onDisk.edges.filter((e) => touching.has(e.from) || touching.has(e.to))
            : onDisk.edges;
          try {
            expect(report.got.arguments).toEqual(wantArgs);
            expect(report.got.notFound).toEqual(wantMissing);
            expect(report.got.edges).toEqual(wantEdges);
            expect(report.repeats).toBe(0);
            expect(report.emptyCalls).toBe(0);
          } catch (error) {
            failures.push(`${label}: ${String((error as Error).message).slice(0, 400)}`);
          }
        }
      expect(failures).toEqual([]);
      expect(groups).toBeGreaterThan(0);
    }, 300_000);
  }
});

describe("what the model does, summed over the worst graphs", () => {
  test("a 200-argument x 1500-character, 900-edge graph needs a handful of calls, none of them empty", async () => {
    const ids = seq("m", 200);
    const { graph } = make(
      ids.map((i) => A(i, { claim: pattern(i, 1500) })),
      pairs(ids, 900)
    );
    ROOM = undefined;
    const report = await walk(caller, graph.work_id, undefined, undefined);
    expect(report.problems).toEqual([]);
    expect(report.calls).toBeLessThan(10);
    expect(report.emptyCalls).toBe(0);
  });
  test("100 arguments x 800 characters with 1600 edges ends in a 20 000-byte room", async () => {
    const ids = seq("q", 100);
    const { graph } = make(
      ids.map((i) => A(i, { claim: pattern(i, 800) })),
      pairs(ids, 1600)
    );
    ROOM = 20_000;
    const report = await walk(caller, graph.work_id, 20_000, undefined, 500);
    expect(report.problems).toEqual([]);
    expect(report.got.edges).toHaveLength(1600);
    expect(report.repeats).toBe(0);
    ROOM = undefined;
  });
});
