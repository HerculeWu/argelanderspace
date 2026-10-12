/**
 * The Copilot's `argument` tool (argument graph ticket 09, ADR 0005), end to end on the real seam: the real host, Pi
 * session, HTTP routes, argument-graph store and lock; only the model provider is scripted. Every operation goes through
 * the page's own pure edits and the page's own write function; the replace/clear card is the one human confirmation.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ARGUMENT_PAGE_WRITE_TOOL,
  ARGUMENT_READ_MAX_CHARS,
  ARGUMENT_TOOL_ACTIONS,
  type ArgumentGraph,
  type ArgumentViewAction,
  addEdge,
  buildArgumentPage,
  type ConversationSnapshot,
  type CopilotConfirmation,
  clearArgumentGraph,
  createArgument,
  deleteArgument,
  OPERATION_CONFIRMATION_TYPE,
  OPERATION_JOURNAL_TYPE,
  type PageContext,
  removeEdge,
  restoreArgument,
  updateArgument,
  type WsServerMessage,
} from "@argelanderspace/contracts";
import {
  argumentGraphPath,
  libraryPaths,
  loadArgumentGraph,
  plansPath,
} from "@argelanderspace/core";
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import { CopilotHost } from "../src/copilot.js";
import { JobRunner } from "../src/jobs.js";
import { ProviderSettings } from "../src/providers.js";
import { stubPipelines, stubSources } from "./helpers.js";

type Out = { text?: string; call?: Record<string, unknown>; tool?: string };
type Step = (context: TranscriptContext) => Out | Promise<Out>;
let root: string;
let dataDir: string;
let host: CopilotHost;
let app: ReturnType<typeof createApp>;
let settings: ProviderSettings;
let originalEnv: NodeJS.ProcessEnv;
let script: Step[];
let seen: TranscriptContext[];
let broadcasts: WsServerMessage[];
let paths: ReturnType<typeof libraryPaths>;
// biome-ignore lint/suspicious/noExplicitAny: tool results are read by shape, field by field, in the assertions
type Loose = Record<string, any>;
const choice = { provider: "openai", model: "gpt-4.1", thinking: null };
const WORK = "doi:10.1000/w1";
const OTHER = "doi:10.1000/w2";

const work = (n: number, extra: object = {}) => ({
  id: `doi:10.1000/w${n}`,
  title: `Work number ${n}`,
  authors: [`Author${n}`],
  year: 2000 + n,
  venue: "MNRAS",
  type: "article",
  doi: `10.1000/w${n}`,
  cite_key: `author${n}`,
  doc_ids: [],
  ...extra,
});
const writeLibrary = () =>
  writeFileSync(
    paths.libraryJson,
    JSON.stringify(
      {
        version: 1,
        project: { name: "Synthetic", short: "S", field: "" },
        works: [work(1, { doc_ids: ["d1", "d2"] }), work(2), work(3, { doc_ids: ["e1"] })],
      },
      null,
      2
    )
  );
const request = (path: string, method = "GET", body?: unknown) =>
  app.request(`/api/copilot${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const lastResult = (context: TranscriptContext) => {
  const last = context.messages.filter((m) => m.role === "toolResult").at(-1);
  if (last?.role !== "toolResult") throw new Error("no tool result yet");
  const part = last.content[0];
  return JSON.parse(part && part.type === "text" ? part.text : "{}");
};

beforeEach(async () => {
  originalEnv = process.env;
  root = mkdtempSync(join(tmpdir(), "copilot-argument-tool-"));
  process.env = { PATH: originalEnv.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "config") };
  vi.stubGlobal("fetch", () => {
    throw new Error("unexpected external fetch");
  });
  const statusDir = join(root, "status");
  mkdirSync(statusDir, { recursive: true });
  writeFileSync(plansPath(statusDir), JSON.stringify({ version: 1, rev: 1, plans: [] }, null, 2));
  dataDir = join(root, "data");
  paths = libraryPaths(dataDir);
  mkdirSync(paths.libraryDir, { recursive: true });
  writeLibrary();
  script = [];
  seen = [];
  broadcasts = [];
  settings = new ProviderSettings();
  await settings.credential("openai", "SYNTHETIC_COPILOT_KEY");
  (await settings.getRuntime()).registerProvider("openai", {
    api: "openai-responses",
    streamSimple(model: Model<Api>, context: TranscriptContext) {
      seen.push(structuredClone(context));
      const index = seen.length;
      const step = script[index - 1];
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const out = step ? await step(context) : { text: "done" };
        const message: AssistantMessage = {
          role: "assistant",
          content: out.call
            ? [
                {
                  type: "toolCall",
                  id: `call_${index}`,
                  name: out.tool ?? "argument",
                  arguments: out.call as never,
                },
              ]
            : [{ type: "text", text: out.text ?? "done" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          stopReason: out.call ? "toolUse" : "stop",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      })();
      return stream;
    },
  });
  host = new CopilotHost(dataDir, settings, () => {});
  app = createApp({
    paths,
    statusDir,
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(root, "jobs") }),
    providerSettings: settings,
    copilot: host,
    broadcast: (message) => broadcasts.push(message),
  });
});
afterEach(async () => {
  await host.close().catch(() => {});
  process.env = originalEnv;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- graphs and conversations ------------------------------------------------------------------------------ //
const arg = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Title ${id}`,
  claim: `Claim ${id}`,
  grounds: `Grounds ${id}`,
  warrant: `Warrant ${id}`,
  backing: "",
  qualifier: "",
  rebuttal: "",
  warrant_implicit: false,
  kind: "normal" as const,
  sources: [],
  ...extra,
});
const graph = (ids: string[], rev = 0, workId = WORK): ArgumentGraph =>
  ({
    version: 1,
    rev,
    work_id: workId,
    arguments: ids.map((id) => arg(id)),
    edges: ids
      .slice(1)
      .map((id, i) => ({ from: id, to: ids[i] as string, role: "grounds" as const })),
  }) as ArgumentGraph;
/** What the page does to save: a whole-graph PUT carrying the rev it read. */
async function userPuts(next: ArgumentGraph) {
  const res = await app.request(`/api/works/${encodeURIComponent(next.work_id)}/argument-graph`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(next),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ArgumentGraph;
}
const disk = (workId = WORK) => loadArgumentGraph(dataDir, workId);
const fileOf = (workId = WORK) => argumentGraphPath(dataDir, workId);
const bytes = (workId = WORK) => {
  try {
    return readFileSync(fileOf(workId), "utf8");
  } catch {
    return "";
  }
};

function viewing(viewId: string = randomUUID(), revision = 1): PageContext {
  const argument = buildArgumentPage({
    workId: WORK,
    title: "Work number 1",
    phase: "loading",
    graph: null,
    selectedId: null,
  });
  return {
    version: 1,
    viewId,
    revision,
    paneId: 1,
    view: "library",
    status: "unavailable",
    otherPanes: [],
    plan: null,
    library: null,
    argument,
  };
}
async function start(view: PageContext, text = "Organize the argument graph of this paper") {
  const created = (await (
    await request("/conversations", "POST", { model: choice })
  ).json()) as ConversationSnapshot;
  const id = created.conversation.id;
  expect((await request(`/views/${view.viewId}`, "PUT", view)).status).toBe(200);
  const sent = await request(`/conversations/${id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text,
    viewId: view.viewId,
    contextRevision: view.revision,
  });
  expect(sent.status).toBe(202);
  return id;
}
const runStatus = async (id: string) => (await host.snapshot(id)).conversation.run?.status;
async function until(id: string, wanted: string[]) {
  await vi.waitFor(async () => expect(wanted).toContain(await runStatus(id)), { timeout: 8000 });
}
/** Runs the scripted steps to the end and returns the results the model saw, in order. */
async function run(steps: Step[], view: PageContext = viewing()) {
  script = steps;
  const id = await start(view);
  await until(id, ["completed", "failed", "stopped"]);
  const results = seen.slice(1).map((context) => lastResult(context));
  return { id, results, view };
}
const operations = async (id: string) =>
  (await host.snapshot(id)).messages.flatMap((m) => m.operations ?? []);
async function card(id: string): Promise<CopilotConfirmation> {
  let found: CopilotConfirmation | undefined;
  await vi.waitFor(
    async () => {
      found = (await host.snapshot(id)).confirmations[0];
      expect(found).toBeDefined();
    },
    { timeout: 8000 }
  );
  return found as CopilotConfirmation;
}
const answer = (
  confirmation: CopilotConfirmation,
  view: PageContext,
  decision: "approve" | "decline",
  over: Record<string, unknown> = {}
) =>
  request(`/confirmations/${confirmation.id}`, "POST", {
    decision,
    viewId: view.viewId,
    action: confirmation.action,
    objectId: confirmation.object.id,
    baseRev: confirmation.baseRev,
    ...over,
  });
const userEnvelopes = (context: TranscriptContext) =>
  context.messages
    .filter((m) => m.role === "user")
    .map((m) => {
      const text =
        typeof m.content !== "string"
          ? m.content.map((p) => (p.type === "text" ? p.text : "")).join("")
          : String(m.content);
      return JSON.parse(text) as { context: PageContext };
    });
const call = (action: string, over: Record<string, unknown> = {}) => ({
  call: { action, workId: WORK, ...over },
});
const changed = () => broadcasts.filter((m) => m.type === "argument-graph.changed");

// ---- reading -------------------------------------------------------------------------------------------------- //
describe("read and guide", () => {
  test("a Work with no graph reads as empty at rev 0, lists its Docs (the first is the main Doc) and writes nothing", async () => {
    const { results } = await run([() => call("read"), () => ({ text: "ok" })]);
    expect(results[0]).toMatchObject({
      ok: true,
      rev: 0,
      work: {
        id: WORK,
        title: "Work number 1",
        docs: [
          { id: "d1", main: true },
          { id: "d2", main: false },
        ],
      },
      counts: { arguments: 0, edges: 0 },
      arguments: [],
      edges: [],
      batch: { from: 0, to: 0, total: 0, status: "complete" },
    });
    expect(bytes()).toBe("");
  });

  test("a Work without a body reads with an empty Docs list; an unknown Work is not_found; an unreadable file is an error, never an empty graph", async () => {
    mkdirSync(dirname(fileOf(OTHER)), { recursive: true });
    writeFileSync(fileOf(OTHER), "{ not json");
    const garbage = bytes(OTHER);
    const { results, id } = await run([
      () => call("read", { workId: "doi:10.1000/w3" }),
      () => call("read", { workId: "doi:10.1000/none" }),
      () => call("read", { workId: OTHER }),
      () => ({ text: "ok" }),
    ]);
    expect(results[0]).toMatchObject({ ok: true, work: { docs: [{ id: "e1", main: true }] } });
    expect(results[1]).toMatchObject({ ok: false, status: "not_found" });
    expect(results[2]).toMatchObject({ ok: false, status: "error" });
    expect(JSON.stringify(results[2])).not.toContain(root);
    expect(bytes(OTHER)).toBe(garbage);
    expect((await operations(id)).map((o) => o.status)).toEqual(["ok", "not_found", "error"]);
  });

  test("a graph the room cannot hold comes in parts: batch says what is unread, offset continues, ids fetch whole arguments", async () => {
    const big = graph(Array.from({ length: 30 }, (_, i) => `a${i}`));
    big.arguments = big.arguments.map((a) => ({ ...a, claim: `${a.id} `.padEnd(5000, "x") }));
    await userPuts(big);
    let first: Loose = {};
    const { results } = await run([
      () => call("read"),
      (ctx) => {
        first = lastResult(ctx);
        return call("read", { offset: first.batch.to });
      },
      () => call("read", { ids: ["a29", "nope"] }),
      () => ({ text: "ok" }),
    ]);
    expect(first.batch.status).toBe("partial");
    expect(first.batch.from).toBe(0);
    expect(first.batch.to).toBeGreaterThan(5);
    expect(first.batch.to).toBeLessThan(30);
    expect(JSON.stringify(first.arguments).length).toBeLessThanOrEqual(ARGUMENT_READ_MAX_CHARS);
    expect(first.note).toContain("NOT read");
    expect(first.counts).toEqual({ arguments: 30, edges: 29 });
    expect(first.edgesBatch).toMatchObject({ total: 29, status: "complete" });
    expect(results[1].batch.from).toBe(first.batch.to);
    expect(results[1].arguments[0].id).toBe(`a${first.batch.to}`);
    expect(results[2].arguments.map((a: { id: string }) => a.id)).toEqual(["a29"]);
    expect(results[2].arguments[0].claim.length).toBe(5000);
    expect(results[2]).toMatchObject({ notFound: ["nope"], batch: { status: "complete" } });
    expect(results[2].edges).toEqual([{ from: "a29", to: "a28", role: "grounds" }]);
  });

  test("guide returns the method (the same rules as the argument skill)", async () => {
    const { results } = await run([
      () => call("guide", { workId: undefined }),
      () => ({ text: "ok" }),
    ]);
    expect(results[0].ok).toBe(true);
    expect(results[0].guide).toContain("Toulmin");
    expect(results[0].guide).toContain("Find the Native arguments");
  });

  test("the audit is part of a read, so 'which arguments are incomplete' can be answered from it", async () => {
    const g = graph(["a1", "a2"]);
    g.arguments[0] = { ...g.arguments[0], claim: "", kind: "end" } as never;
    await userPuts(g);
    const { results } = await run([() => call("read"), () => ({ text: "ok" })]);
    expect(results[0].audit.incomplete).toEqual([{ id: "a1", missing: ["claim"] }]);
    expect(results[0].audit.total).toBeGreaterThan(0);
  });
});

// ---- the edits -------------------------------------------------------------------------------------------------- //
describe("one-by-one edits (no confirmation)", () => {
  test("create, update, add_edge, remove_edge and delete write through the page's path: each result carries the new rev and the user's page is told", async () => {
    const { results, id } = await run([
      () =>
        call("create", { expectedRev: 0, argument: { title: "First", claim: "C1" }, id: "one" }),
      () =>
        call("create", { expectedRev: 1, argument: { title: "Second", kind: "end" }, id: "two" }),
      () =>
        call("update", {
          expectedRev: 2,
          id: "two",
          patch: { claim: "C2", warrant_implicit: true },
        }),
      () => call("add_edge", { expectedRev: 3, from: "one", to: "two", role: "grounds" }),
      () => call("remove_edge", { expectedRev: 4, from: "one", to: "two", role: "grounds" }),
      () => call("add_edge", { expectedRev: 5, from: "one", to: "two", role: "backing" }),
      () => call("delete", { expectedRev: 6, id: "one" }),
      () => ({ text: "ok" }),
    ]);
    expect(results.map((r) => r.rev)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(results[0]).toMatchObject({
      ok: true,
      status: "ok",
      id: "one",
      counts: { arguments: 1, edges: 0 },
    });
    expect(results[6]).toMatchObject({ removed: { id: "one", title: "First", edges: 1 } });
    const final = disk();
    expect(final.rev).toBe(7);
    expect(final.arguments.map((a) => a.id)).toEqual(["two"]);
    expect(final.arguments[0]).toMatchObject({ claim: "C2", warrant_implicit: true, kind: "end" });
    expect(final.edges).toEqual([]);
    expect(changed()).toHaveLength(7);
    expect((await operations(id)).every((o) => o.status === "ok" && o.object?.id === WORK)).toBe(
      true
    );
  });

  test("create without an id draws a fresh one that the graph does not hold", async () => {
    await userPuts(graph(["a1"]));
    const { results } = await run([
      () => call("create", { expectedRev: 1, argument: { title: "New" } }),
      () => ({ text: "ok" }),
    ]);
    expect(results[0].id).toMatch(/^a[0-9a-z]{5}/);
    expect(disk().arguments.map((a) => a.id)).toContain(results[0].id);
  });

  test("refused edits say why and write nothing: blank title, over-long title, duplicate id, unknown id, self-loop, duplicate and missing edge", async () => {
    const stored = await userPuts(graph(["a1", "a2"]));
    const before = bytes();
    const events = changed().length;
    const rev = stored.rev;
    const { results, id } = await run([
      () => call("create", { expectedRev: rev, argument: { title: "   " } }),
      () => call("create", { expectedRev: rev, argument: { title: "x".repeat(81) } }),
      () => call("create", { expectedRev: rev, argument: { title: "dup" }, id: "a1" }),
      () => call("update", { expectedRev: rev, id: "ghost", patch: { claim: "x" } }),
      () => call("update", { expectedRev: rev, id: "a1", patch: { title: "" } }),
      () => call("add_edge", { expectedRev: rev, from: "a1", to: "a1", role: "grounds" }),
      () => call("add_edge", { expectedRev: rev, from: "a2", to: "a1", role: "grounds" }),
      () => call("add_edge", { expectedRev: rev, from: "a2", to: "ghost", role: "grounds" }),
      () => call("remove_edge", { expectedRev: rev, from: "a1", to: "a2", role: "grounds" }),
      () => call("delete", { expectedRev: rev, id: "ghost" }),
      () => call("create", { expectedRev: rev, argument: { title: "ok", bogus: 1 } }),
      () => ({ text: "ok" }),
    ]);
    expect(results.map((r) => r.status)).toEqual([
      "invalid",
      "invalid",
      "invalid",
      "not_found",
      "invalid",
      "rejected",
      "rejected",
      "not_found",
      "rejected",
      "not_found",
      "unsupported",
    ]);
    expect(results[0].issues).toEqual([expect.objectContaining({ code: "title_blank" })]);
    expect(results[1].issues).toEqual([
      expect.objectContaining({ code: "title_too_long", limit: 80 }),
    ]);
    expect(results[2].issues).toEqual([
      expect.objectContaining({ code: "duplicate_id", argumentId: "a1" }),
    ]);
    expect(bytes()).toBe(before);
    expect(changed()).toHaveLength(events);
    expect((await operations(id)).map((o) => o.status)).toEqual([
      "invalid",
      "invalid",
      "invalid",
      "not_found",
      "invalid",
      "rejected",
      "rejected",
      "not_found",
      "rejected",
      "not_found",
      "unsupported",
    ]);
  });

  test("a stale rev writes nothing and the result carries the latest graph; the next write on that rev lands, and the user's edit is kept", async () => {
    const stored = await userPuts(graph(["a1"]));
    let latest: Loose = {};
    const { results } = await run([
      () => call("read"),
      async () => {
        // the user edits on the page between the model's read and its write
        await userPuts({
          ...disk(),
          arguments: [arg("a1", { claim: "the user's words" })],
        } as ArgumentGraph);
        return call("update", {
          expectedRev: stored.rev,
          id: "a1",
          patch: { claim: "the model's words" },
        });
      },
      (ctx) => {
        latest = lastResult(ctx);
        return call("update", {
          expectedRev: latest.currentRev,
          id: "a1",
          patch: { grounds: "added" },
        });
      },
      () => ({ text: "ok" }),
    ]);
    expect(results[1]).toMatchObject({ ok: false, status: "conflict", currentRev: stored.rev + 1 });
    expect(latest.latest.arguments[0].claim).toBe("the user's words");
    expect(results[2]).toMatchObject({ ok: true, rev: stored.rev + 2 });
    expect(disk().arguments[0]).toMatchObject({ claim: "the user's words", grounds: "added" });
  });

  test("undo_delete puts the argument back with its edges and position, only onto the graph the delete produced", async () => {
    const stored = await userPuts(graph(["a1", "a2", "a3"]));
    let afterDelete = 0;
    const { results } = await run([
      () => call("delete", { expectedRev: stored.rev, id: "a2" }),
      (ctx) => {
        afterDelete = lastResult(ctx).rev;
        return call("undo_delete", { expectedRev: afterDelete, id: "a2" });
      },
      () => call("undo_delete", { expectedRev: afterDelete + 1, id: "a2" }),
      () => call("delete", { expectedRev: afterDelete + 1, id: "a3" }),
      async (ctx) => {
        // someone else writes after the delete: the undo is a conflict, not a blind restore
        await userPuts({ ...disk(), arguments: [...disk().arguments, arg("a9")] } as ArgumentGraph);
        return call("undo_delete", { expectedRev: lastResult(ctx).rev, id: "a3" });
      },
      () => ({ text: "ok" }),
    ]);
    expect(results[1]).toMatchObject({ ok: true });
    expect(results[2]).toMatchObject({ ok: false, status: "not_found" });
    expect(results[4]).toMatchObject({ ok: false, status: "conflict" });
    const final = disk();
    expect(final.arguments.map((a) => a.id)).toEqual(["a1", "a2", "a9"]);
    expect(final.edges).toEqual(
      graph(["a1", "a2", "a3"]).edges.filter((e) => e.from !== "a3" && e.to !== "a3")
    );
  });

  test("a Work that is not in the library, and a repeated operationId, are answered honestly", async () => {
    const { results } = await run([
      () =>
        call("create", { workId: "doi:10.1000/none", expectedRev: 0, argument: { title: "x" } }),
      () =>
        call("create", {
          expectedRev: 0,
          argument: { title: "once" },
          id: "o",
          operationId: "same",
        }),
      () =>
        call("create", {
          expectedRev: 0,
          argument: { title: "once" },
          id: "o",
          operationId: "same",
        }),
      () =>
        call("create", {
          expectedRev: 5,
          argument: { title: "other" },
          id: "p",
          operationId: "same",
        }),
      () => ({ text: "ok" }),
    ]);
    expect(results[0]).toMatchObject({ ok: false, status: "not_found" });
    expect(results[1]).toMatchObject({ ok: true, rev: 1 });
    expect(results[2]).toMatchObject({ ok: true, rev: 1, duplicate: true });
    expect(results[3]).toMatchObject({ ok: false, status: "rejected" });
    expect(disk().rev).toBe(1);
    expect(bytes("doi:10.1000/none")).toBe("");
  });

  test("an unreadable stored graph is never written over", async () => {
    mkdirSync(dirname(fileOf()), { recursive: true });
    writeFileSync(fileOf(), "{ corrupt");
    const { results } = await run([
      () => call("create", { expectedRev: 0, argument: { title: "x" } }),
      () => ({ text: "ok" }),
    ]);
    expect(results[0]).toMatchObject({ ok: false, status: "error" });
    expect(bytes()).toBe("{ corrupt");
  });
});

// ---- replace and clear ---------------------------------------------------------------------------------------- //
describe("replace and clear", () => {
  const newBody = (ids: string[]) => {
    const g = graph(ids);
    return { arguments: g.arguments, edges: g.edges };
  };

  test("on an empty graph (including a zero-argument one at a later rev) replace writes at once, with no card", async () => {
    await userPuts({ ...graph([]), rev: 0 });
    const { results, id } = await run([
      () => call("replace", { expectedRev: 1, graph: newBody(["a1", "a2"]) }),
      () => ({ text: "ok" }),
    ]);
    expect(results[0]).toMatchObject({ ok: true, rev: 2, counts: { arguments: 2, edges: 1 } });
    expect(disk().arguments).toHaveLength(2);
    expect((await host.snapshot(id)).confirmations).toEqual([]);
    expect((await operations(id)).map((o) => o.status)).toEqual(["ok"]);
  });

  test("clear on an empty graph is a noop and writes nothing", async () => {
    const { results } = await run([
      () => call("clear", { expectedRev: 0 }),
      () => ({ text: "ok" }),
    ]);
    expect(results[0]).toMatchObject({ ok: true, status: "noop" });
    expect(bytes()).toBe("");
  });

  test("a replacement that would be invalid is refused before any card is shown", async () => {
    const stored = await userPuts(graph(["a1"]));
    const body = newBody(["a1", "a2"]);
    body.edges = [{ from: "a1", to: "ghost", role: "grounds" }];
    const { results, id } = await run([
      () => call("replace", { expectedRev: stored.rev, graph: body }),
      () =>
        call("replace", {
          expectedRev: stored.rev,
          graph: { arguments: [arg("x", { title: " " })], edges: [] },
        }),
      () => ({ text: "ok" }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["invalid", "invalid"]);
    expect((await host.snapshot(id)).confirmations).toEqual([]);
    expect(disk().rev).toBe(stored.rev);
  });

  test("a replacement of a non-empty graph waits for the user: the card names the title and both sizes, the run waits and nothing is written", async () => {
    const stored = await userPuts(graph(["a1", "a2", "a3"]));
    const before = bytes();
    script = [
      () => call("replace", { expectedRev: stored.rev, graph: newBody(["n1", "n2"]) }),
      (ctx) => ({ text: `got ${lastResult(ctx).status}` }),
    ];
    const view = viewing();
    const id = await start(view);
    const shown = await card(id);
    expect(shown).toMatchObject({
      action: "replace_argument_graph",
      object: { kind: "work", id: WORK, workId: WORK },
      label: "Work number 1",
      mode: "replace",
      current: { arguments: 3, edges: 2 },
      next: { arguments: 2, edges: 1 },
      baseRev: stored.rev,
    });
    expect(await runStatus(id)).toBe("waiting-for-user");
    expect((await operations(id)).map((o) => `${o.action}:${o.status}`)).toEqual([
      "replace:confirmation_required",
    ]);
    expect(bytes()).toBe(before);
    // the model's transcript holds no way to approve: the card id never reaches it
    expect(JSON.stringify(seen)).not.toContain(shown.id);
    expect((await answer(shown, view, "decline")).status).toBe(200);
    await until(id, ["completed"]);
  });

  test("approving runs in order — requested, resolved, then the write — replaces exactly the proposed graph and the model hears ok", async () => {
    const stored = await userPuts(graph(["a1", "a2", "a3"]));
    script = [
      () => call("replace", { expectedRev: stored.rev, graph: newBody(["n1", "n2"]) }),
      (ctx) => ({ text: `rev ${lastResult(ctx).rev}` }),
    ];
    const view = viewing();
    const id = await start(view);
    const shown = await card(id);
    const response = await answer(shown, view, "approve");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "approved" });
    await until(id, ["completed"]);
    expect(disk()).toMatchObject({ rev: stored.rev + 1 });
    expect(disk().arguments.map((a) => a.id)).toEqual(["n1", "n2"]);
    const loaded = (
      host as unknown as {
        loaded: Map<
          string,
          {
            manager: {
              getEntries(): { type: string; customType?: string; data?: { phase?: string } }[];
            };
          }
        >;
      }
    ).loaded.get(id);
    const trail = (loaded?.manager.getEntries() ?? [])
      .filter(
        (e) =>
          e.type === "custom" &&
          [OPERATION_CONFIRMATION_TYPE, OPERATION_JOURNAL_TYPE].includes(e.customType ?? "")
      )
      .map(
        (e) =>
          `${e.customType === OPERATION_CONFIRMATION_TYPE ? "confirmation" : "journal"}:${e.data?.phase}`
      );
    expect(trail).toEqual([
      "confirmation:requested",
      "confirmation:resolved",
      "journal:begin",
      "journal:done",
    ]);
    expect((await operations(id)).map((o) => `${o.action}:${o.status}`)).toEqual(["replace:ok"]);
    expect(changed()).toHaveLength(2); // the user's seed and the approved replacement
    // a repeated click does not write again
    expect((await answer(shown, view, "approve")).status).toBe(200);
    expect(disk().rev).toBe(stored.rev + 1);
  });

  test("declining writes nothing at all and the model hears declined", async () => {
    const stored = await userPuts(graph(["a1", "a2"]));
    const before = bytes();
    const events = changed().length;
    script = [
      () => call("clear", { expectedRev: stored.rev }),
      (ctx) => ({ text: String(lastResult(ctx).status) }),
    ];
    const view = viewing();
    const id = await start(view);
    const shown = await card(id);
    expect(shown).toMatchObject({
      mode: "clear",
      current: { arguments: 2, edges: 1 },
      next: { arguments: 0, edges: 0 },
    });
    expect((await answer(shown, view, "decline")).status).toBe(200);
    await until(id, ["completed"]);
    expect(bytes()).toBe(before);
    expect(changed()).toHaveLength(events);
    expect((await operations(id)).map((o) => o.status)).toEqual(["declined"]);
    expect((await host.snapshot(id)).messages.at(-1)?.text).toBe("declined");
  });

  test("approving a clear empties the graph; the file keeps its place with a bumped rev", async () => {
    const stored = await userPuts(graph(["a1", "a2"]));
    script = [() => call("clear", { expectedRev: stored.rev }), () => ({ text: "ok" })];
    const view = viewing();
    const id = await start(view);
    expect((await answer(await card(id), view, "approve")).status).toBe(200);
    await until(id, ["completed"]);
    expect(disk()).toMatchObject({ rev: stored.rev + 1, arguments: [], edges: [] });
  });

  test("a graph that changes after the card was shown voids it: the click is refused, nothing is replaced, the model hears expired", async () => {
    const stored = await userPuts(graph(["a1", "a2"]));
    script = [
      () => call("replace", { expectedRev: stored.rev, graph: newBody(["n1"]) }),
      (ctx) => ({ text: String(lastResult(ctx).status) }),
    ];
    const view = viewing();
    const id = await start(view);
    const shown = await card(id);
    // the user edits the graph on the page while the card is up: the card ends by itself (a background recheck)
    await userPuts({ ...disk(), arguments: [...disk().arguments, arg("a3")] } as ArgumentGraph);
    await until(id, ["completed"]);
    expect((await operations(id)).map((o) => o.status)).toEqual(["expired"]);
    expect((await host.snapshot(id)).messages.at(-1)?.text).toBe("expired");
    expect((await answer(shown, view, "approve")).status).toBe(409);
    expect(disk().arguments.map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
    expect((await host.snapshot(id)).confirmations).toEqual([]);
  });

  test("a hand edit that leaves the rev alone also voids the card (the content digest), and an unreadable graph at the click is a system error, not a change", async () => {
    const stored = await userPuts(graph(["a1", "a2"]));
    script = [() => call("clear", { expectedRev: stored.rev }), () => ({ text: "ok" })];
    const view = viewing();
    const id = await start(view);
    const shown = await card(id);
    const edited = JSON.parse(bytes());
    edited.arguments[0].claim = "edited by hand";
    writeFileSync(fileOf(), JSON.stringify(edited, null, 2));
    const refused = await answer(shown, view, "approve");
    expect(refused.status).toBe(409);
    await until(id, ["completed"]);
    expect(disk().arguments).toHaveLength(2);

    // an unreadable file at the click
    script = [() => call("clear", { expectedRev: disk().rev }), () => ({ text: "ok" })];
    seen = [];
    const second = viewing();
    const id2 = await start(second);
    const shown2 = await card(id2);
    writeFileSync(fileOf(), "{ broken");
    const response = await answer(shown2, second, "approve");
    expect(response.status).toBeGreaterThanOrEqual(400);
    await until(id2, ["completed"]);
    expect(bytes()).toBe("{ broken");
    expect((await operations(id2)).map((o) => o.status)).toEqual(["error"]);
  });

  test("a rev the model read earlier is a conflict that carries the latest graph, before any card", async () => {
    const stored = await userPuts(graph(["a1"]));
    await userPuts({ ...disk(), arguments: [arg("a1"), arg("a2")] } as ArgumentGraph);
    const { results, id } = await run([
      () => call("replace", { expectedRev: stored.rev, graph: newBody(["n1"]) }),
      () => ({ text: "ok" }),
    ]);
    expect(results[0]).toMatchObject({ ok: false, status: "conflict", currentRev: stored.rev + 1 });
    expect(results[0].latest.counts).toEqual({ arguments: 2, edges: 0 });
    expect((await host.snapshot(id)).confirmations).toEqual([]);
  });
});

// ---- the page context and the tool ---------------------------------------------------------------------------- //
describe("the published page and the read tool", () => {
  const readyPage = (g: ArgumentGraph, selectedId: string | null = null): PageContext => ({
    ...viewing(),
    status: "complete",
    argument: buildArgumentPage({
      workId: WORK,
      title: "Work number 1",
      phase: "ready",
      graph: g,
      selectedId,
    }),
  });
  const userEnvelope = (context: TranscriptContext) => {
    const first = context.messages.find((m) => m.role === "user");
    const text =
      first && typeof first.content !== "string"
        ? first.content.map((p) => (p.type === "text" ? p.text : "")).join("")
        : String(first?.content);
    return JSON.parse(text) as { context: PageContext };
  };
  const incomplete = (ids: string[]): ArgumentGraph => {
    const g = graph(ids);
    g.arguments[1] = { ...g.arguments[1], grounds: "", warrant: "" } as never;
    g.arguments[2] = { ...g.arguments[2], claim: "" } as never;
    return g;
  };

  test("which arguments are incomplete is answered from the page the model is sent: the audit names them, whole or partial", async () => {
    const small = incomplete(["a0", "a1", "a2"]);
    const { id } = await run([() => ({ text: "a1 and a2" })], readyPage(small));
    const page = userEnvelope(seen[0] as TranscriptContext).context.argument;
    expect(page).toMatchObject({
      partial: false,
      audit: { incomplete: expect.arrayContaining([{ id: "a2", missing: ["claim"] }]) },
    });
    expect(page?.audit?.incomplete.map((entry) => entry.id)).toEqual(["a1", "a2"]);
    expect(page?.graph?.arguments).toHaveLength(3);
    expect((await host.snapshot(id)).conversation.run?.status).toBe("completed");
  });

  test("a graph past the page budget is sent as an outline whose note names the tool; the omitted text comes back from argument read, exactly", async () => {
    const big = graph(Array.from({ length: 40 }, (_, i) => `b${i}`));
    big.arguments = big.arguments.map((a) => ({ ...a, claim: `${a.id} `.padEnd(3000, "y") }));
    big.arguments[7] = { ...big.arguments[7], grounds: "", warrant: "" } as never;
    const stored = await userPuts({ ...big, rev: 0 });
    const view = readyPage({ ...stored, rev: stored.rev });
    expect(view.argument?.partial).toBe(true);
    let fetched: Loose = {};
    await run(
      [
        () => call("read", { ids: ["b7"] }),
        (ctx) => {
          fetched = lastResult(ctx);
          return { text: "done" };
        },
      ],
      view
    );
    const sent = userEnvelope(seen[0] as TranscriptContext).context.argument;
    expect(sent).toMatchObject({ partial: true, graph: null });
    expect(sent?.note).toContain("argument tool");
    expect(sent?.audit?.incomplete).toEqual([{ id: "b7", missing: ["warrant"] }]);
    expect(JSON.stringify(sent)).not.toContain("yyyyyyyy");
    expect(fetched.arguments[0]).toEqual(disk().arguments[7]);
    expect(fetched.arguments[0].claim).toHaveLength(3000);
  });

  test("a later message of the same conversation lists a graph the conversation already holds whole, and sends it whole again once the rev changes", async () => {
    // long enough that listing the graph is shorter than carrying it (a short graph is always sent whole)
    const g = graph(Array.from({ length: 8 }, (_, i) => `c${i}`));
    g.arguments = g.arguments.map((a) => ({ ...a, claim: `Claim ${a.id} `.padEnd(1500, "z") }));
    const stored = await userPuts(g);
    const first = readyPage(stored);
    script = [() => ({ text: "one" }), () => ({ text: "two" }), () => ({ text: "three" })];
    const id = await start(first);
    await until(id, ["completed"]);
    const send = async (view: PageContext) => {
      const put = await request(`/views/${view.viewId}`, "PUT", view);
      expect({ status: put.status, body: put.status === 200 ? "" : await put.text() }).toEqual({
        status: 200,
        body: "",
      });
      const sent = await request(`/conversations/${id}/messages`, "POST", {
        clientMessageId: randomUUID(),
        text: "and now?",
        viewId: view.viewId,
        contextRevision: view.revision,
      });
      expect(sent.status).toBe(202);
      await vi.waitFor(async () => expect(await runStatus(id)).toBe("completed"), {
        timeout: 8000,
      });
    };
    const second = { ...readyPage(stored), viewId: randomUUID() };
    await send(second);
    const listed = userEnvelopes(seen.at(-1) as TranscriptContext).at(-1)?.context.argument;
    expect(listed).toMatchObject({ partial: true, graph: null });
    expect(listed?.note).toContain("is in the task's context and is not repeated");
    expect(listed?.outline).toHaveLength(8);
    // the whole text is still in the conversation, in the first message
    expect(JSON.stringify(seen.at(-1)?.messages)).toContain("Claim c1 zzzz");
    // a changed graph is carried whole again
    const changed_ = await userPuts({
      ...disk(),
      arguments: [...disk().arguments, arg("c8")],
    } as ArgumentGraph);
    await send({ ...readyPage(changed_), viewId: randomUUID() });
    const again = userEnvelopes(seen.at(-1) as TranscriptContext).at(-1)?.context.argument;
    expect(again).toMatchObject({ partial: false });
    expect(again?.graph?.arguments).toHaveLength(9);
  });
});

// ---- view actions --------------------------------------------------------------------------------------------- //
describe("view actions", () => {
  test("open, select and exit are delivered to the bound view as navigation; reading and writing never are", async () => {
    const delivered: ArgumentViewAction[] = [];
    host.useViewDelivery((viewId, message) => {
      delivered.push(message.action as ArgumentViewAction);
      queueMicrotask(() =>
        host.resolveViewAction(viewId, { actionId: message.actionId, ok: true })
      );
      return true;
    });
    await userPuts(graph(["a1", "a2"]));
    const { results, id } = await run([
      () => call("read"),
      () => call("create", { expectedRev: 1, argument: { title: "x" }, id: "x" }),
      () => call("open"),
      () => call("select", { id: "a2" }),
      () => call("select", { id: "ghost" }),
      () => call("select"),
      () => call("exit", { workId: undefined }),
      () => call("open", { workId: "doi:10.1000/none" }),
      () => ({ text: "ok" }),
    ]);
    expect(delivered).toEqual([
      { action: "open_argument_graph", workId: WORK },
      { action: "select_argument", workId: WORK, argumentId: "a2" },
      { action: "select_argument", workId: WORK, argumentId: null },
      { action: "exit_argument_graph" },
    ]);
    expect(results.map((r) => r.status)).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
      "not_found",
      "ok",
      "ok",
      "not_found",
    ]);
    expect((await operations(id)).map((o) => `${o.action}:${o.status}`)).toEqual([
      "read:ok",
      "create:ok",
      "open:ok",
      "select:ok",
      "select:not_found",
      "select:ok",
      "exit:ok",
      "open:not_found",
    ]);
  });

  test("the page refuses to leave an unsaved draft: leave_blocked is reported as not displayed, with the reason", async () => {
    host.useViewDelivery((viewId, message) => {
      queueMicrotask(() =>
        host.resolveViewAction(viewId, {
          actionId: message.actionId,
          ok: false,
          detail: "leave_blocked",
        })
      );
      return true;
    });
    const { results } = await run([
      () => call("exit", { workId: undefined }),
      () => ({ text: "ok" }),
    ]);
    expect(results[0]).toMatchObject({ ok: false, status: "not_displayed" });
    expect(results[0].detail).toContain("unsaved");
  });
});

// ---- parity with the page ------------------------------------------------------------------------------------- //
describe("parity with the argument graph page", () => {
  /** What the page writes for one operation: the pure edit applied to the stored graph, saved as a whole-graph PUT. */
  async function pageResult(
    start: ArgumentGraph,
    edit: (g: ArgumentGraph) => { ok: true; graph: ArgumentGraph } | { ok: false }
  ) {
    const stored = await userPuts(start);
    const edited = edit(stored);
    if (!edited.ok) throw new Error("the page's edit was refused");
    const saved = await userPuts({ ...edited.graph, rev: stored.rev });
    return { arguments: saved.arguments, edges: saved.edges };
  }

  test("every write the page offers has a tool operation, and each gives the same new graph as the page's save", async () => {
    // the table is complete and points at operations that exist
    for (const operation of Object.values(ARGUMENT_PAGE_WRITE_TOOL))
      expect(ARGUMENT_TOOL_ACTIONS).toContain(operation);
    expect(Object.keys(ARGUMENT_PAGE_WRITE_TOOL).sort()).toEqual(
      [
        "clear graph",
        "connect (drag or picker)",
        "delete",
        "new argument",
        "remove relation",
        "save argument form",
        "undo delete",
      ].sort()
    );
    const base = (): ArgumentGraph => ({
      ...graph(["a1", "a2", "a3"]),
      edges: [
        { from: "a2", to: "a1", role: "grounds" },
        { from: "a3", to: "a2", role: "warrant" },
      ],
    });
    const cases: {
      name: string;
      page: (g: ArgumentGraph) => { ok: true; graph: ArgumentGraph } | { ok: false };
      tool: (rev: number) => Record<string, unknown>;
      confirm?: boolean;
    }[] = [
      {
        name: "new argument",
        page: (g) =>
          createArgument(
            g,
            { title: "Brand new", claim: "C", kind: "native", sources: [{ text: "Section 2" }] },
            "fresh"
          ),
        tool: (rev) => ({
          action: "create",
          expectedRev: rev,
          id: "fresh",
          argument: {
            title: "Brand new",
            claim: "C",
            kind: "native",
            sources: [{ text: "Section 2" }],
          },
        }),
      },
      {
        name: "save argument form",
        page: (g) =>
          updateArgument(g, "a2", {
            claim: "changed",
            warrant_implicit: true,
            sources: [{ text: "Figure 1", target: { doc_id: "d1", anchor: "fig-1" } }],
          }),
        tool: (rev) => ({
          action: "update",
          expectedRev: rev,
          id: "a2",
          patch: {
            claim: "changed",
            warrant_implicit: true,
            sources: [{ text: "Figure 1", target: { doc_id: "d1", anchor: "fig-1" } }],
          },
        }),
      },
      {
        name: "delete",
        page: (g) => deleteArgument(g, "a2"),
        tool: (rev) => ({ action: "delete", expectedRev: rev, id: "a2" }),
      },
      {
        name: "connect",
        page: (g) => addEdge(g, { from: "a3", to: "a1", role: "backing" }),
        tool: (rev) => ({
          action: "add_edge",
          expectedRev: rev,
          from: "a3",
          to: "a1",
          role: "backing",
        }),
      },
      {
        name: "remove relation",
        page: (g) => removeEdge(g, { from: "a3", to: "a2", role: "warrant" }),
        tool: (rev) => ({
          action: "remove_edge",
          expectedRev: rev,
          from: "a3",
          to: "a2",
          role: "warrant",
        }),
      },
      {
        name: "clear graph",
        page: (g) => clearArgumentGraph(g),
        tool: (rev) => ({ action: "clear", expectedRev: rev }),
        confirm: true,
      },
    ];
    for (const item of cases) {
      // fresh data dir per case: a Work whose graph the page saves, and a twin whose graph the tool edits
      const expected = await pageResult(base(), item.page);
      await userPuts({ ...base(), work_id: OTHER, rev: 0 });
      seen = [];
      script = [() => ({ call: { workId: OTHER, ...item.tool(1) } }), () => ({ text: "ok" })];
      const view = viewing();
      const id = await start(view);
      if (item.confirm) expect((await answer(await card(id), view, "approve")).status).toBe(200);
      await until(id, ["completed"]);
      expect({
        name: item.name,
        arguments: disk(OTHER).arguments,
        edges: disk(OTHER).edges,
      }).toEqual({
        name: item.name,
        ...expected,
      });
      // reset both Works for the next case
      await rmFiles();
    }
    // undo delete: the page restores the removed argument onto the graph the delete produced
    const g = base();
    const removed = deleteArgument(g, "a2");
    if (!removed.ok) throw new Error("unreachable");
    const restored = restoreArgument(removed.graph, removed.removed);
    if (!restored.ok) throw new Error("unreachable");
    await userPuts({ ...base(), work_id: OTHER, rev: 0 });
    script = [
      () => ({ call: { action: "delete", workId: OTHER, expectedRev: 1, id: "a2" } }),
      () => ({ call: { action: "undo_delete", workId: OTHER, expectedRev: 2, id: "a2" } }),
      () => ({ text: "ok" }),
    ];
    seen = [];
    const id = await start(viewing());
    await until(id, ["completed"]);
    expect({ arguments: disk(OTHER).arguments, edges: disk(OTHER).edges }).toEqual({
      arguments: restored.graph.arguments,
      edges: restored.graph.edges,
    });
  });
});

async function rmFiles() {
  const { rmSync } = await import("node:fs");
  for (const workId of [WORK, OTHER]) rmSync(fileOf(workId), { force: true });
}
