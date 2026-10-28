/**
 * `argument read` in a real window (argument graph ticket 09, review round B): the real host counts the window in UTF-8
 * bytes, and the tool's ceilings, batches, cuts and field reads use the same ruler. A Chinese graph (three bytes a
 * character; four for an emoji; escape-dense text twice over) is read to the end in windows of many sizes, with only a
 * scripted provider: the task never fails with `capacity` because of a `read`, and what the model assembled is the
 * graph on disk, character for character. A window with no room for the smallest part gets an honest gap.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ArgumentGraphSchema } from "@argelanderspace/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  disk,
  fileOf,
  H,
  type Loose,
  setup,
  start,
  teardown,
  until,
  viewing,
  WORK,
} from "./argument-host-harness.js";

beforeEach(setup);
afterEach(teardown);

async function withWindow<T>(tokens: number, fn: () => Promise<T>): Promise<T> {
  const model = (await H.settings.getRuntime())
    .getModels("openai")
    .find((candidate: Loose) => candidate.id === "gpt-4.1") as Loose;
  const original = { contextWindow: model.contextWindow, maxTokens: model.maxTokens };
  model.contextWindow = tokens;
  model.maxTokens = 1024;
  try {
    return await fn();
  } finally {
    Object.assign(model, original);
  }
}

const repeatTo = (unit: string, length: number) =>
  unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
const CJK = "观测数据表明潮汐尾的形状与理论预言不符，";
const GRAPHS: Record<string, string> = {
  cjk: CJK,
  // four-byte characters and the escapes JSON doubles
  emoji: "\u{1f600}星系\u{1f4a5}",
  escapes: '"引用"\\\n\t观测',
  ascii: "evidence ",
};

/** What a model that follows the notes does: read, then call again as the note says, and read each cut text to its end. */
function followNotes(sink: {
  results: Loose[];
  args: Map<number, Loose>;
  edges: Map<number, Loose>;
  /** `id|field` of the cut texts whose rest has not been read (yet). */
  pending: Set<string>;
}) {
  const jobs: Loose[] = [];
  let field: {
    id: string;
    name: string;
    at: number;
    acc: string;
    into: Loose;
    key: string;
  } | null = null;
  let previous: Loose | null = null;
  return (context: { messages: Loose[] }): { call?: Loose; text?: string } => {
    const last = context.messages.filter((m) => m.role === "toolResult").at(-1);
    if (!last) return { call: { action: "read", workId: WORK } };
    const result = JSON.parse(last.content[0].text) as Loose;
    sink.results.push(result);
    if (result.status !== "ok") return { text: "stop" };
    if (field && result.field) {
      field.acc += result.field.text;
      if (result.field.status === "partial") {
        field.at = result.field.to;
        return {
          call: {
            action: "read",
            workId: WORK,
            ids: [field.id],
            field: field.name,
            offset: field.at,
          },
        };
      }
      if (field.name.startsWith("sources.")) {
        const index = Number(/^sources\.(\d+)/.exec(field.name)?.[1]);
        field.into.sources[index] = {
          ...(field.into.sources[index] ?? {}),
          text: (field.into.sources[index]?.text ?? "") + field.acc,
          ...(result.field.target ? { target: result.field.target } : {}),
        };
      } else field.into[field.name] += field.acc;
      sink.pending.delete(`${field.id}|${field.name}`);
      field = null;
    } else if (result.batch) {
      previous = result;
      for (let p = result.batch.from; p < result.batch.to; p++)
        sink.args.set(p, result.arguments[p - result.batch.from]);
      for (let i = result.edgesBatch.from; i < result.edgesBatch.to; i++)
        sink.edges.set(i, result.edges[i - result.edgesBatch.from]);
      for (const clip of (result.batch.clipped ?? []) as Loose[]) {
        const target = result.arguments.find((a: Loose) => a.id === clip.id) as Loose;
        if (clip.field === "sources") {
          for (let n = clip.shown; n < clip.chars; n++) {
            jobs.push({ id: clip.id, name: `sources.${n}`, at: 0, into: target });
            sink.pending.add(`${clip.id}|sources.${n}`);
          }
        } else {
          jobs.push({ id: clip.id, name: clip.field, at: clip.shown, into: target });
          sink.pending.add(`${clip.id}|${clip.field}`);
        }
      }
    }
    const next = jobs.shift();
    if (next) {
      field = { ...next, acc: "", key: "" } as never;
      return {
        call: { action: "read", workId: WORK, ids: [next.id], field: next.name, offset: next.at },
      };
    }
    const r = previous as Loose;
    if (r.batch.status === "partial" || r.edgesBatch.status === "partial") {
      // exactly what the note says: both positions
      return {
        call: { action: "read", workId: WORK, offset: r.batch.to, edgeOffset: r.edgesBatch.to },
      };
    }
    return { text: "read it all" };
  };
}

describe("a Chinese graph in a real window", () => {
  const seed = (unit: string) => {
    const ids = Array.from({ length: 12 }, (_, i) => `a${i}`);
    const graph = ArgumentGraphSchema.parse({
      version: 1,
      rev: 2,
      work_id: WORK,
      arguments: ids.map((id) => ({
        id,
        title: `论证 ${id}`,
        claim: repeatTo(unit, 3000),
        grounds: repeatTo(unit, 600),
        warrant: repeatTo(unit, 400),
        sources: [{ text: repeatTo(unit, 300), target: { doc_id: "d1", anchor: "第三节" } }],
      })),
      edges: ids.slice(1).map((id, i) => ({ from: id, to: ids[i], role: "grounds" })),
    });
    mkdirSync(dirname(fileOf()), { recursive: true });
    writeFileSync(fileOf(), JSON.stringify(graph, null, 2));
  };
  const walkIt = async (tokens: number) => {
    const sink = {
      results: [] as Loose[],
      args: new Map<number, Loose>(),
      edges: new Map<number, Loose>(),
      pending: new Set<string>(),
    };
    const step = followNotes(sink);
    await withWindow(tokens, async () => {
      H.script = Array.from({ length: 80 }, () => step as never);
      H.seen = [];
      const id = await start(viewing(), "read the graph");
      await until(id, ["completed", "failed", "stopped"]);
      const snapshot = await H.host.snapshot(id);
      sink.results.push({
        run: snapshot.conversation.run?.status,
        error: snapshot.conversation.run?.error,
      });
      sink.results.push(
        ...snapshot.messages
          .flatMap((m) => m.operations ?? [])
          .map((o) => ({ operation: o.status }))
      );
    });
    return sink;
  };
  const delivered = (sink: { args: Map<number, Loose>; edges: Map<number, Loose> }) => ({
    args: [...sink.args.entries()].sort(([a], [b]) => a - b).map(([, v]) => v),
    edges: [...sink.edges.entries()].sort(([a], [b]) => a - b).map(([, v]) => v),
  });

  // The graph does not fit these windows whole (the window is the instruction, the history and the room). Whatever the
  // task reads is exact; what it cannot read is an honest gap; the run itself never fails because of a read.
  for (const [kind, unit] of Object.entries(GRAPHS))
    for (const tokens of [50_000, 60_000, 75_000, 90_000, 110_000, 150_000]) {
      test(`${kind}: ${tokens}-token window: the run completes, every read is ok or an honest gap, what came is exact`, async () => {
        seed(unit);
        const sink = await walkIt(tokens);
        const run = sink.results.find((r) => r.run !== undefined) as Loose;
        expect({ status: run.run, error: run.error }).toEqual({ status: "completed", error: null });
        for (const r of sink.results.filter((x) => x.status !== undefined && x.status !== "ok"))
          expect({ status: r.status, capacity: String(r.detail).startsWith("capacity") }).toEqual({
            status: "rejected",
            capacity: true,
          });
        const got = delivered(sink);
        const unfinished = new Set([...sink.pending].map((key) => key.split("|")[0]));
        const whole = got.args.map((a, i) => (unfinished.has(a.id) ? disk().arguments[i] : a));
        expect(whole).toEqual(disk().arguments.slice(0, got.args.length));
        expect(got.edges).toEqual(disk().edges.slice(0, got.edges.length));
      }, 120_000);
    }

  // A window with room for the graph several times over: all of it, exactly.
  for (const [kind, unit] of Object.entries(GRAPHS))
    for (const tokens of [300_000, 500_000]) {
      test(`${kind}: ${tokens}-token window: the whole graph is read, character for character`, async () => {
        seed(unit);
        const sink = await walkIt(tokens);
        const run = sink.results.find((r) => r.run !== undefined) as Loose;
        expect({ status: run.run, error: run.error }).toEqual({ status: "completed", error: null });
        expect(sink.results.filter((r) => r.status !== undefined && r.status !== "ok")).toEqual([]);
        expect(
          sink.results.filter((r) => r.operation !== undefined && r.operation !== "ok")
        ).toEqual([]);
        const got = delivered(sink);
        expect(got.args).toEqual(disk().arguments);
        expect(got.edges).toEqual(disk().edges);
      }, 120_000);
    }

  test("a window with almost no room left gets an honest capacity gap, and the task still completes", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `a${i}`);
    const graph = ArgumentGraphSchema.parse({
      version: 1,
      rev: 2,
      work_id: WORK,
      arguments: ids.map((id) => ({ id, title: `论证 ${id}`, claim: repeatTo(CJK, 3000) })),
      edges: [],
    });
    mkdirSync(dirname(fileOf()), { recursive: true });
    writeFileSync(fileOf(), JSON.stringify(graph, null, 2));
    // 45 000 + 512 tokens (release-0.2 ticket 09: search_ads, footprint +896 B x 4/7): the instruction and tool schemas take almost all of it
    await withWindow(Number(process.env.GAP_WINDOW ?? 45_512), async () => {
      const results: Loose[] = [];
      H.script = [
        () => ({ call: { action: "read", workId: WORK } }),
        ((context: { messages: Loose[] }) => {
          const last = context.messages.filter((m) => m.role === "toolResult").at(-1);
          results.push(JSON.parse(last?.content[0].text ?? "{}"));
          return { text: "answer" };
        }) as never,
      ];
      H.seen = [];
      const id = await start(viewing(), "read the graph");
      await until(id, ["completed", "failed", "stopped"]);
      const snapshot = await H.host.snapshot(id);
      expect({
        run: snapshot.conversation.run?.status,
        error: snapshot.conversation.run?.error,
        results,
      }).toMatchObject({
        run: "completed",
      });
      expect(results[0]).toMatchObject({ ok: false, status: "rejected" });
      expect(String(results[0]?.detail)).toContain("capacity");
    });
  }, 60_000);
});
