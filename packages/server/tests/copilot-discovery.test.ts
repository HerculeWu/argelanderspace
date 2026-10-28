/**
 * Copilot `library` tool, literature exploration (copilot ticket 17), end to end on the real seam: real Pi session,
 * real HTTP routes, real library lock/store/disk and library.changed notification, real /ws sockets as browser tabs.
 * Only the model provider is scripted; no network. Discovery itself lives in the browser tab, so the exploration the
 * model sees is the page that tab published, and its controls are view actions answered by that tab.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConversationSnapshot,
  type DiscoveryPage,
  type DiscoveryPaper,
  LIBRARY_OPERATION_ACTIONS,
  type LibraryPage,
  type PageContext,
  summarizeLibraryRef,
  type WsServerMessage,
} from "@argelanderspace/contracts";
import type { MetadataSources } from "@argelanderspace/core";
import { canonicalId, libraryPaths, plansPath } from "@argelanderspace/core";
import { AdsClient } from "@argelanderspace/infra";
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  getCurrentTools,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "../src/app.js";
import { CopilotHost } from "../src/copilot.js";
import { JobRunner } from "../src/jobs.js";
import { ProviderSettings } from "../src/providers.js";
import { WsHub } from "../src/ws.js";
import { stubPipelines, stubSources } from "./helpers.js";

type Out = { text?: string; call?: Record<string, unknown>; tool?: string };
type Step = (context: TranscriptContext) => Out | Promise<Out>;
let root: string;
let host: CopilotHost;
let app: ReturnType<typeof createApp>;
let settings: ProviderSettings;
let originalEnv: NodeJS.ProcessEnv;
let script: Step[];
let seen: TranscriptContext[];
let broadcasts: WsServerMessage[];
let paths: ReturnType<typeof libraryPaths>;
let sources: MetadataSources;
let runner: JobRunner;
let autoPdf = false;
const choice = { provider: "openai", model: "gpt-4.1", thinking: null };

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
const seedFile = () => ({
  version: 1,
  project: { name: "Synthetic", short: "S", field: "", x_project: "keep" },
  x_top: { nested: [1] },
  works: [
    work(1, { doc_ids: ["d1", "d2", "d3"], x_work: "keep-me", read: true, note: "Private note" }),
    work(2, { doc_ids: ["e1"], x_other: 7 }),
    work(3),
  ],
});
const writeLibrary = (file: object = seedFile()) =>
  writeFileSync(paths.libraryJson, JSON.stringify(file, null, 2));
const disk = () => JSON.parse(readFileSync(paths.libraryJson, "utf8"));
const bytes = () => readFileSync(paths.libraryJson, "utf8");
const request = (path: string, method = "GET", body?: unknown) =>
  app.request(`/api/copilot${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const lastText = (context: TranscriptContext): string => {
  const last = context.messages.filter((m) => m.role === "toolResult").at(-1);
  const part = last?.role === "toolResult" ? last.content[0] : undefined;
  return part && part.type === "text" ? part.text : "";
};
const lastResult = (context: TranscriptContext) => {
  const results = context.messages.filter((m) => m.role === "toolResult");
  const last = results.at(-1);
  if (last?.role !== "toolResult") throw new Error("no tool result yet");
  const part = last.content[0];
  return JSON.parse(part && part.type === "text" ? part.text : "{}");
};

beforeEach(async () => {
  originalEnv = process.env;
  root = mkdtempSync(join(tmpdir(), "copilot-discovery-"));
  process.env = { PATH: originalEnv.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "config") };
  vi.stubGlobal("fetch", () => {
    throw new Error("unexpected external fetch");
  });
  const statusDir = join(root, "status");
  mkdirSync(statusDir, { recursive: true });
  writeFileSync(plansPath(statusDir), JSON.stringify({ version: 1, rev: 1, plans: [] }, null, 2));
  paths = libraryPaths(join(root, "data"));
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
      const step = script[seen.length - 1];
      const index = seen.length;
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
                  name: out.tool ?? "library",
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
  sources = stubSources();
  autoPdf = false;
  runner = new JobRunner({ dir: join(root, "jobs") });
  host = new CopilotHost(join(root, "data"), settings, () => {});
  app = createApp({
    paths,
    statusDir,
    makeSources: () => sources,
    pipelines: stubPipelines(),
    fetchArxivPdf: async () =>
      readFileSync(new URL("./fixtures/pdf/scanned-no-text.pdf", import.meta.url)),
    autoIngestArxiv: () => autoPdf,
    runner,
    providerSettings: settings,
    copilot: host,
    broadcast: (message) => broadcasts.push(message),
  });
});

// ---- fake browser tab over the real /ws hub ------------------------------------------------------- //
let server: Server | undefined;
let hub: WsHub | undefined;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  hub?.close();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  hub = undefined;
  server = undefined;
  await host.close();
  process.env = originalEnv;
  vi.unstubAllGlobals();
});
async function openTab(
  viewId: string,
  conversationId: string,
  actions: Record<string, unknown>[],
  answer: (
    action: Record<string, unknown>
  ) => { ok: boolean; detail?: string; http?: number } | null = () => ({
    ok: true,
  })
) {
  server = createServer();
  hub = new WsHub(server, { heartbeatMs: 0, onViewSubscribed: (id) => host.viewConnected(id) });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  host.useViewDelivery((id, message) => hub?.sendToView(id, message) ?? false);
  const port = (server.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.type !== "copilot.view-action") return;
    actions.push(message.action);
    const result = answer(message.action);
    if (result)
      void request(`/views/${viewId}/action-results`, "POST", {
        actionId: message.actionId,
        ...result,
      });
  });
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  const subscribed = new Promise<void>((resolve) =>
    ws.on("message", (data) => {
      if (JSON.parse(data.toString()).type === "copilot.subscribed") resolve();
    })
  );
  ws.send(JSON.stringify({ type: "copilot.subscribe", conversationId, viewId }));
  await subscribed;
}

// ---- page + conversation helpers -------------------------------------------------------------------- //
function libraryPage(extra: Partial<LibraryPage> = {}): LibraryPage {
  const works = seedFile().works.map((w) => ({
    id: w.id,
    title: w.title,
    authors: `${w.authors[0]}`,
    year: w.year,
    venue: w.venue,
    type: "article" as const,
    cite: w.cite_key,
    tags: [],
    pdf: false,
    read: false,
    star: false,
    doc_ids: w.doc_ids,
  }));
  return {
    source: "live",
    query: "",
    total: works.length,
    matched: works.length,
    refs: works.map((w) => summarizeLibraryRef(w)),
    links: [],
    selectedRefId: null,
    detail: null,
    temporaryLabels: {},
    sidebarCollapsed: false,
    graph: { labelsOn: false },
    ...extra,
  };
}
function page(
  library: LibraryPage = libraryPage(),
  revision = 1,
  viewId = randomUUID()
): PageContext {
  return {
    version: 1,
    viewId,
    revision,
    paneId: 1,
    view: "library",
    status: library.source === "live" ? "complete" : "unavailable",
    otherPanes: [],
    plan: null,
    library,
  };
}
const SEEDB = "2018ApJ...800..100S";
const CA = "2020MNRAS.499.1234X";
const CB = "2021ApJ...900...12D";
const CU = "2017A&A...600A..10U";
const paper = (bibcode: string, over: Partial<DiscoveryPaper> = {}): DiscoveryPaper => ({
  bibcode,
  title: `Candidate ${bibcode}`,
  authors: ["Doe, J."],
  year: 2020,
  venue: "MNRAS",
  abstract: `Abstract of ${bibcode}`,
  citationCount: 3,
  doi: null,
  arxivId: null,
  roles: ["related"],
  libraryId: null,
  ...over,
});
const baseGraph = (): NonNullable<DiscoveryPage["graph"]> => {
  const graph = discoveryPage().graph;
  if (!graph) throw new Error("fixture has a graph");
  return graph;
};
/** The exploration page the bound view publishes: seed SEED1, related CAND1/CAND2, useful USE1. */
function discoveryPage(over: Partial<DiscoveryPage> = {}): DiscoveryPage {
  // the page's nodes carry no abstract (only the open candidate's detail does)
  const nodes = [
    paper(SEEDB, { roles: ["seed"] }),
    paper(CA),
    paper(CB),
    paper(CU, { roles: ["useful"] }),
  ].map(({ abstract: _abstract, ...node }) => node);
  return {
    history: { index: 0, seeds: [SEEDB] },
    graph: {
      provider: "ads",
      seed: SEEDB,
      filter: "all",
      query: "",
      nodes,
      edges: [{ from: SEEDB, to: CA, kind: "citation" }],
      totals: { nodes: 4, related: 2, useful: 1, saved: 0 },
      warnings: [],
      empty: false,
    },
    display: "graph",
    selectedBibcode: null,
    detail: null,
    loading: null,
    error: null,
    saving: { adding: null, failed: null },
    graphView: { labelsOn: false },
    ...over,
  };
}
function exploring(discovery: DiscoveryPage = discoveryPage(), revision = 1): PageContext {
  return {
    version: 1,
    viewId: randomUUID(),
    revision,
    paneId: 1,
    view: "library",
    status: discovery.graph ? "complete" : "unavailable",
    otherPanes: [],
    plan: null,
    library: null,
    discovery,
  };
}
async function run(
  context: PageContext,
  text = "Check my library",
  tab = false,
  answer?: (
    action: Record<string, unknown>
  ) => { ok: boolean; detail?: string; http?: number } | null
) {
  const created = (await (
    await request("/conversations", "POST", { model: choice })
  ).json()) as ConversationSnapshot;
  const id = created.conversation.id;
  const actions: Record<string, unknown>[] = [];
  if (tab) await openTab(context.viewId, id, actions, answer);
  expect((await request(`/views/${context.viewId}`, "PUT", context)).status).toBe(200);
  const sent = await request(`/conversations/${id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text,
    viewId: context.viewId,
    contextRevision: context.revision,
  });
  expect(sent.status).toBe(202);
  await vi.waitFor(
    async () => {
      expect((await host.snapshot(id)).conversation.run?.status).not.toBe("running");
    },
    { timeout: 8000 }
  );
  return { id, snapshot: await host.snapshot(id), actions };
}
const ops = (snapshot: ConversationSnapshot) =>
  snapshot.messages.flatMap((m) => m.operations ?? []);
const changed = () => broadcasts.filter((m) => m.type === "library.changed");

// ---- ADS export stub: what the page's own bibcode import reads -------------------------------------- //
const RECORDS: Record<string, string> = {
  [CA]: `@ARTICLE{${CA},\n  author = {{Doe}, J.},\n  title = {A fresh MNRAS paper},\n  journal = {\\mnras},\n  year = {2020},\n  volume = {499},\n  pages = {1234},\n  doi = {10.1093/mnras/staa9999}\n}`,
  [CB]: `@ARTICLE{${CB},\n  author = {{Roe}, K.},\n  title = {A second candidate},\n  journal = {\\apj},\n  year = {2021},\n  doi = {10.3847/apj/b}\n}`,
  "2022ApJ...910...99S": `@ARTICLE{2022ApJ...910...99S,\n  author = {{Bob}},\n  title = {Observations of the open cluster population of the Milky Way II. Ages},\n  year = {2020}\n}`,
  "2019BRIDGE..001B": `@ARTICLE{2019BRIDGE..001B,\n  author = {{Author1}},\n  title = {Work number 3},\n  year = {2003},\n  doi = {10.1000/w1}\n}`,
};
let exportCalls: string[][];
const adsSources = (): MetadataSources => ({
  ...stubSources(),
  ads: {
    status: "ok",
    resolve: async () => null,
    exportBibtex: async (codes: string[]) => {
      exportCalls.push(codes);
      const found = codes.map((code) => RECORDS[code]).filter(Boolean);
      return found.length ? found.join("\n") : null;
    },
  },
});
beforeEach(() => {
  exportCalls = [];
  sources = adsSources();
});
const uiAdd = async (bibcode: string) => {
  const res = await app.request("/api/library/works", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "bibcode", bibcode }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { results: Record<string, unknown>[] }).results;
};
const stable = () => {
  const raw = disk();
  for (const w of raw.works) w.added_at = undefined;
  return JSON.stringify(raw);
};
const save = (bibcode: string, extra: object = {}) => ({
  call: { action: "save_candidate", bibcode, ...extra },
});
const synced = (actions: Record<string, unknown>[]) =>
  actions.filter((a) => a.action === "discovery_saved");

describe("read_discovery", () => {
  test("returns the exploration the bound view published, flagged as an observation", async () => {
    const shown = discoveryPage({ selectedBibcode: CA });
    let payload: Record<string, unknown> = {};
    script = [
      () => ({ call: { action: "read_discovery" } }),
      (ctx) => {
        payload = lastResult(ctx);
        return { text: "read" };
      },
    ];
    const before = bytes();
    const { snapshot, actions } = await run(exploring(shown), "What is open?", true);
    expect(payload).toMatchObject({ ok: true, exploring: true, discovery: shown });
    expect(String(payload.observed)).toContain("last report");
    expect(ops(snapshot)).toMatchObject([
      { tool: "library", action: "read_discovery", status: "ok" },
    ]);
    expect(bytes()).toBe(before);
    expect(actions).toEqual([]); // reading never drives the page
    expect(changed()).toHaveLength(0);
  });

  test("with no exploration open it says so, and a non-Library page is not claimed to hold one", async () => {
    let payload: Record<string, unknown> = {};
    script = [
      () => ({ call: { action: "read_discovery" } }),
      (ctx) => {
        payload = lastResult(ctx);
        return { text: "read" };
      },
    ];
    await run(page());
    expect(payload).toMatchObject({ ok: true, exploring: false, discovery: null });
    expect(String(payload.detail)).toContain("no exploration is open");
    const plan: PageContext = {
      version: 1,
      viewId: randomUUID(),
      revision: 1,
      paneId: 1,
      view: "plan",
      status: "unavailable",
      otherPanes: [],
      plan: null,
    };
    script = [
      () => ({ call: { action: "read_discovery" } }),
      (ctx) => {
        payload = lastResult(ctx);
        return { text: "read" };
      },
    ];
    seen = [];
    await run(plan);
    expect(payload).toMatchObject({ exploring: false });
    expect(String(payload.detail)).toContain("plan page");
  });

  test("a loading or failed exploration is reported as it is, with the earlier graph if any", async () => {
    const shown = discoveryPage({ loading: { seed: CB }, error: { seed: CA, status: 503 } });
    let payload: { discovery?: DiscoveryPage } = {};
    script = [
      () => ({ call: { action: "read_discovery" } }),
      (ctx) => {
        payload = lastResult(ctx);
        return { text: "read" };
      },
    ];
    await run(exploring(shown));
    expect(payload.discovery?.loading).toEqual({ seed: CB });
    expect(payload.discovery?.error).toEqual({ seed: CA, status: 503 });
    expect(payload.discovery?.graph?.seed).toBe(SEEDB);
  });
});

describe("save_candidate", () => {
  test("the page's own Add and the tool give the same Work identity, results and event; the tab is told to mark the node saved", async () => {
    const viaUi = await uiAdd(CA);
    const uiBytes = stable();
    const uiEvents = changed().map((m) => (m as { cause: string }).cause);
    expect(uiEvents).toEqual(["add"]);
    writeLibrary();
    broadcasts = [];
    exportCalls = [];
    let payload: { results?: Record<string, unknown>[]; object?: { id: string } } = {};
    script = [
      () => save(CA),
      (ctx) => {
        payload = lastResult(ctx);
        return { text: "saved" };
      },
    ];
    const { snapshot, actions } = await run(exploring(), "Save the first candidate", true);
    expect(payload.results).toEqual(viaUi);
    expect(stable()).toBe(uiBytes);
    expect(changed().map((m) => (m as { cause: string }).cause)).toEqual(uiEvents);
    expect(ops(snapshot)).toMatchObject([{ action: "save_candidate", status: "ok" }]);
    expect(payload).toMatchObject({ ok: true, status: "ok", candidate: CA, created: 1 });
    // the view marks it saved in place (state sync, not navigation)
    await vi.waitFor(() => expect(synced(actions)).toHaveLength(1));
    expect(synced(actions)[0]).toEqual({
      action: "discovery_saved",
      bibcode: CA,
      workId: payload.object?.id,
    });
    expect(actions.filter((a) => a.action !== "discovery_saved")).toEqual([]);
    expect(exportCalls).toEqual([[CA]]); // one ADS export, for that candidate only
  });

  test("only the one candidate is saved: no other node, no recommendation, no extra requests", async () => {
    script = [() => save(CA), () => ({ text: "done" })];
    await run(exploring());
    const ids = disk().works.map((w: { id: string }) => w.id);
    expect(ids).toHaveLength(4);
    expect(exportCalls).toEqual([[CA]]);
    expect(disk().works.filter((w: { bibcode?: string }) => w.bibcode === CB)).toHaveLength(0);
  });

  test("a candidate string with whitespace is still the single import, never a batch", async () => {
    const odd = `${CA} ${CB}`;
    const shown = discoveryPage();
    shown.graph?.nodes.push({ ...paper(odd), abstract: undefined } as never);
    let payload: Record<string, unknown> = {};
    script = [
      () => save(odd),
      (ctx) => {
        payload = lastResult(ctx);
        return { text: "done" };
      },
    ];
    await run(exploring(shown));
    // the single path asks ADS for the one string as given; a batch would have split it into two codes
    expect(exportCalls).toEqual([[odd]]);
    expect(payload).toMatchObject({ ok: false, status: "error", candidate: odd });
    for (const key of ["entries", "requested", "reasons", "batch"])
      expect(payload).not.toHaveProperty(key);
  });

  test("a bibcode the open exploration does not show is rejected: nothing is written, announced or exported", async () => {
    const before = bytes();
    let payload: Record<string, unknown> = {};
    script = [
      () => save("2099ZZZZ..999..999Z"),
      (ctx) => {
        payload = lastResult(ctx);
        return { text: "refused" };
      },
    ];
    const { snapshot, actions } = await run(exploring(), "Save it", true);
    expect(payload).toMatchObject({ ok: false, status: "rejected" });
    expect(String(payload.detail)).toContain("not a candidate");
    expect(ops(snapshot)).toMatchObject([{ action: "save_candidate", status: "rejected" }]);
    expect(bytes()).toBe(before);
    expect(changed()).toHaveLength(0);
    expect(exportCalls).toEqual([]);
    expect(actions).toEqual([]);
  });

  test("without an open exploration there is no candidate: rejected, nothing written", async () => {
    const before = bytes();
    let payload: Record<string, unknown> = {};
    script = [
      () => save(CA),
      (ctx) => {
        payload = lastResult(ctx);
        return { text: "refused" };
      },
    ];
    await run(page());
    expect(payload).toMatchObject({ ok: false, status: "rejected" });
    expect(String(payload.detail)).toContain("no exploration is open");
    expect(bytes()).toBe(before);
    expect(exportCalls).toEqual([]);
  });

  test("a candidate the filter hides is still one when the open inspector or its citations name it; one it does not name is not", async () => {
    const hidden = discoveryPage({
      graph: {
        ...baseGraph(),
        filter: "useful",
        nodes: [paper(SEEDB, { roles: ["seed"] }), paper(CU, { roles: ["useful"] })],
      },
      selectedBibcode: CB,
      detail: { paper: paper(CB), tab: "citations", references: [CA], citedBy: [] },
    });
    script = [() => save(CA), () => save(CB), () => ({ text: "done" })];
    const { snapshot } = await run(exploring(hidden));
    expect(ops(snapshot).map((o) => o.status)).toEqual(["ok", "ok"]);
    const noDetail = discoveryPage({
      graph: {
        ...baseGraph(),
        filter: "useful",
        nodes: [paper(SEEDB, { roles: ["seed"] }), paper(CU, { roles: ["useful"] })],
      },
    });
    writeLibrary();
    script = [() => save(CA), (ctx) => ({ text: String(lastResult(ctx).status) })];
    seen = [];
    const second = await run(exploring(noDetail));
    expect(ops(second.snapshot)[0]).toMatchObject({ status: "rejected" });
  });

  test("saving the same candidate again resolves to the existing Work: noop, one Work, one notification", async () => {
    const results: Record<string, unknown>[] = [];
    script = [
      () => save(CA),
      (ctx) => {
        results.push(lastResult(ctx));
        return save(CA);
      },
      (ctx) => {
        results.push(lastResult(ctx));
        return { text: "done" };
      },
    ];
    const { snapshot, actions } = await run(exploring(), "Save it twice", true);
    expect(results[0]).toMatchObject({ status: "ok", created: 1 });
    expect(results[1]).toMatchObject({
      ok: true,
      status: "noop",
      created: 0,
      existing: 1,
      results: [{ status: "exists" }],
    });
    expect(disk().works.filter((w: { bibcode?: string }) => w.bibcode === CA)).toHaveLength(1);
    expect(disk().works).toHaveLength(4);
    expect(changed()).toHaveLength(1);
    expect(ops(snapshot).map((o) => o.status)).toEqual(["ok", "noop"]);
    // both calls name the same Work, so the view marks the same node with the same id
    await vi.waitFor(() => expect(synced(actions)).toHaveLength(2));
    expect(synced(actions)[0]?.workId).toBe(synced(actions)[1]?.workId);
  });

  test("operationId: the same request returns the first result without a second write; another request on that key is rejected", async () => {
    const results: Record<string, unknown>[] = [];
    script = [
      () => save(CA, { operationId: "save-1" }),
      (ctx) => {
        results.push(lastResult(ctx));
        return save(CA, { operationId: "save-1" });
      },
      (ctx) => {
        results.push(lastResult(ctx));
        return save(CB, { operationId: "save-1" });
      },
      (ctx) => {
        results.push(lastResult(ctx));
        return { text: "done" };
      },
    ];
    await run(exploring());
    expect(results[0]).toMatchObject({ status: "ok" });
    expect(results[1]).toMatchObject({ status: "ok", duplicate: true, candidate: CA });
    expect(results[2]).toMatchObject({ ok: false, status: "rejected" });
    expect(exportCalls).toEqual([[CA]]);
    expect(changed()).toHaveLength(1);
  });

  test("a source failure saves nothing, leaves the candidate unsaved (no sync) and never shows the token", async () => {
    const TOKEN = "SYNTHETIC-ADS-TOKEN-1234";
    const requests: string[] = [];
    sources = {
      ...stubSources(),
      ads: new AdsClient({
        token: TOKEN,
        delay: 0,
        cacheDir: join(root, "ads-cache"),
        fetchImpl: (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
          requests.push(String(init?.headers?.Authorization));
          throw new Error(`network down, header Authorization: Bearer ${TOKEN}`);
        }) as never,
      }),
    };
    const before = bytes();
    let payload: Record<string, unknown> = {};
    script = [
      () => save(CA),
      (ctx) => {
        payload = lastResult(ctx);
        return { text: "failed" };
      },
    ];
    const { id, snapshot, actions } = await run(exploring(), "Save", true);
    expect(requests.length).toBeGreaterThan(0); // the real client really used the token and failed
    expect(payload).toMatchObject({ ok: false, status: "error", candidate: CA });
    expect(ops(snapshot)[0]).toMatchObject({ action: "save_candidate", status: "error" });
    expect(bytes()).toBe(before);
    expect(changed()).toHaveLength(0);
    expect(actions).toEqual([]);
    const everything = JSON.stringify([
      payload,
      snapshot,
      seen,
      await (await request(`/conversations/${id}`)).json(),
    ]);
    expect(everything).not.toContain(TOKEN);
  });

  test("a failing store write is unknown, not claimed unchanged, and the bytes stay", async () => {
    const before = bytes();
    mkdirSync(join(paths.libraryDir, "library.json.tmp")); // the staging path is a directory: the real save fails
    let payload: Record<string, unknown> = {};
    script = [
      () => save(CA),
      (ctx) => {
        payload = lastResult(ctx);
        return { text: "unsure" };
      },
    ];
    const { actions } = await run(exploring(), "Save", true);
    expect(payload).toMatchObject({ ok: false, status: "unknown" });
    expect(String(payload.detail)).toContain("read the library");
    expect(bytes()).toBe(before);
    expect(changed()).toHaveLength(0);
    expect(actions).toEqual([]);
  });

  test("keeps the top level, project, other works and every unknown key (the narrow write)", async () => {
    script = [() => save(CA), () => ({ text: "done" })];
    await run(exploring());
    const after = disk();
    const seeded = seedFile();
    expect(after.x_top).toEqual(seeded.x_top);
    expect(after.project).toEqual(seeded.project);
    expect(after.works.slice(0, 3)).toEqual(seeded.works);
    expect(after.works[3]).toMatchObject({ bibcode: CA });
  });

  test("a candidate whose derived work id belongs to a different stored paper is refused with a reason; that paper is untouched", async () => {
    const series = "Observations of the open cluster population of the Milky Way";
    const raw = seedFile();
    raw.works.push({
      id: canonicalId({ title: `${series} I. Survey`, year: 2020 }),
      title: `${series} I. Survey`,
      authors: ["Ann"],
      year: 2020,
      type: "article",
      cite_key: "ann2020",
      note: "mine",
      star: true,
      x_series: 1,
    } as never);
    writeLibrary(raw);
    const before = bytes();
    const candidate = "2022ApJ...910...99S";
    const shown = discoveryPage({
      graph: {
        ...baseGraph(),
        nodes: [paper(SEEDB, { roles: ["seed"] }), paper(candidate)],
      },
    });
    let payload: Record<string, unknown> = {};
    script = [
      () => save(candidate),
      (ctx) => {
        payload = lastResult(ctx);
        return { text: "refused" };
      },
    ];
    const { actions } = await run(exploring(shown), "Save", true);
    expect(payload).toMatchObject({ ok: false, status: "error" });
    expect(JSON.stringify(payload.results)).toContain("already used by a different paper");
    expect(bytes()).toBe(before);
    expect(changed()).toHaveLength(0);
    expect(actions).toEqual([]);
  });

  test("a candidate that would merge two stored works is rejected by the tool: nothing written, no sync", async () => {
    const candidate = "2019BRIDGE..001B";
    const shown = discoveryPage({
      graph: {
        ...baseGraph(),
        nodes: [paper(SEEDB, { roles: ["seed"] }), paper(candidate)],
      },
    });
    const before = bytes();
    let payload: Record<string, unknown> = {};
    script = [
      () => save(candidate),
      (ctx) => {
        payload = lastResult(ctx);
        return { text: "refused" };
      },
    ];
    const { actions } = await run(exploring(shown), "Save", true);
    expect(payload).toMatchObject({ ok: false, status: "rejected" });
    expect(bytes()).toBe(before);
    expect(changed()).toHaveLength(0);
    expect(actions).toEqual([]);
  });

  test("only a bibcode is accepted: no DOI, path or URL field", async () => {
    const before = bytes();
    // The SDK's closed parameter schema (no doi/path/url property exists) refuses before the tool runs.
    const outcomes: string[] = [];
    script = [
      () => ({ call: { action: "save_candidate", bibcode: CA, doi: "10.1/x" } }),
      (ctx) => {
        outcomes.push(lastText(ctx));
        return { call: { action: "save_candidate", path: "/etc/passwd" } };
      },
      (ctx) => {
        outcomes.push(lastText(ctx));
        return { call: { action: "save_candidate" } };
      },
      (ctx) => {
        outcomes.push(lastResult(ctx).status);
        return { text: "done" };
      },
    ];
    await run(exploring());
    expect(outcomes[0]).toContain("Validation failed");
    // `path` is a parameter of attach_local_pdf (project intake ticket 01): it passes the SDK's check and the shared
    // schema refuses it for save_candidate
    expect(JSON.parse(outcomes[1] ?? "{}")).toMatchObject({ ok: false, status: "unsupported" });
    // a save without a bibcode passes the SDK schema and is refused by the shared one
    expect(outcomes[2]).toBe("unsupported");
    expect(bytes()).toBe(before);
    expect(exportCalls).toEqual([]);
  });
});

describe("the exploration's controls are view actions for the bound tab", () => {
  const callsOf = (...calls: Record<string, unknown>[]): Step[] => [
    ...calls.map((call, index) =>
      index === 0 ? () => ({ call }) : (_: TranscriptContext) => ({ call })
    ),
    () => ({ text: "done" }),
  ];

  test("each control reaches only the bound tab, unchanged, and writes nothing", async () => {
    const calls: Record<string, unknown>[] = [
      { action: "explore_work", refId: "doi:10.1000/w1" },
      { action: "explore_candidate", bibcode: CA },
      { action: "retry_exploration" },
      { action: "cancel_exploration" },
      { action: "step_exploration", direction: "back" },
      { action: "exit_exploration" },
      { action: "resume_exploration" },
      { action: "filter_discovery", filter: "useful" },
      { action: "search_discovery", query: "alpha" },
      { action: "set_discovery_display", display: "list" },
      { action: "select_candidate", bibcode: null },
      { action: "set_discovery_tab", tab: "citations" },
      { action: "dismiss_discovery_error" },
      { action: "view_candidate_in_library", bibcode: CA },
      { action: "set_discovery_graph_labels", on: true },
      { action: "discovery_graph_control", control: "focus_seed" },
    ];
    script = callsOf(...calls);
    const before = bytes();
    const { snapshot, actions } = await run(exploring(), "Drive it", true);
    expect(actions).toEqual(calls);
    expect(ops(snapshot).map((o) => [o.action, o.status])).toEqual(
      calls.map((c) => [c.action, "ok"])
    );
    expect(bytes()).toBe(before);
    expect(changed()).toHaveLength(0);
    expect(exportCalls).toEqual([]);
  });

  test("a failed exploration is an error with its status (nothing saved, nothing else started); a cancelled one is not displayed", async () => {
    const results: Record<string, unknown>[] = [];
    script = [
      () => ({ call: { action: "explore_candidate", bibcode: CA } }),
      (ctx) => {
        results.push(lastResult(ctx));
        return { call: { action: "retry_exploration" } };
      },
      (ctx) => {
        results.push(lastResult(ctx));
        return { text: "done" };
      },
    ];
    const answers = [
      { ok: false, detail: "failed", http: 503 },
      { ok: false, detail: "cancelled" },
    ];
    const before = bytes();
    const { snapshot, actions } = await run(
      exploring(),
      "Explore",
      true,
      () => answers.shift() ?? { ok: true }
    );
    expect(results[0]).toMatchObject({ ok: false, status: "error", http: 503 });
    expect(String(results[0]?.detail)).toContain("HTTP 503");
    expect(String(results[0]?.detail)).toContain("nothing was saved");
    expect(results[1]).toMatchObject({ ok: false, status: "not_displayed" });
    expect(String(results[1]?.detail)).toContain("cancelled");
    expect(ops(snapshot).map((o) => o.status)).toEqual(["error", "not_displayed"]);
    expect(actions).toHaveLength(2); // exactly one request per call, no automatic retry or hop
    expect(bytes()).toBe(before);
  });

  test("a disabled or unavailable control is reported, not claimed shown", async () => {
    const results: Record<string, unknown>[] = [];
    script = [
      () => ({ call: { action: "step_exploration", direction: "forward" } }),
      (ctx) => {
        results.push(lastResult(ctx));
        return { call: { action: "exit_exploration" } };
      },
      (ctx) => {
        results.push(lastResult(ctx));
        return { text: "done" };
      },
    ];
    const answers = [
      { ok: false, detail: "disabled" },
      { ok: false, detail: "unavailable" },
    ];
    await run(exploring(), "Go", true, () => answers.shift() ?? { ok: true });
    expect(results[0]).toMatchObject({ ok: false, status: "rejected" });
    expect(String(results[0]?.detail)).toContain("disabled");
    expect(results[1]).toMatchObject({ ok: false, status: "not_displayed" });
  });

  test("an exploration request is given a long report window; a click-sized action keeps the short one", async () => {
    const spy = vi.spyOn(host, "dispatchViewAction");
    script = callsOf(
      { action: "explore_candidate", bibcode: CA },
      { action: "explore_work", refId: "doi:10.1000/w1" },
      { action: "retry_exploration" },
      { action: "filter_discovery", filter: "all" },
      { action: "step_exploration", direction: "back" }
    );
    await run(exploring(), "Go", true);
    const options = spy.mock.calls.map((call) => [(call[1] as { action: string }).action, call[3]]);
    expect(options).toEqual([
      ["explore_candidate", { reportMs: 120_000 }],
      ["explore_work", { reportMs: 120_000 }],
      ["retry_exploration", { reportMs: 120_000 }],
      ["filter_discovery", {}],
      ["step_exploration", {}],
    ]);
  });

  test("the report window option is honoured: a view that does not answer in time is not displayed", async () => {
    const viewId = randomUUID();
    const context = { ...exploring(), viewId };
    const created = (await (
      await request("/conversations", "POST", { model: choice })
    ).json()) as ConversationSnapshot;
    const actions: Record<string, unknown>[] = [];
    await openTab(viewId, created.conversation.id, actions, () => null); // the tab never reports
    expect((await request(`/views/${viewId}`, "PUT", context)).status).toBe(200);
    const started = Date.now();
    const outcome = await host.dispatchViewAction(
      viewId,
      { action: "retry_exploration" } as never,
      undefined,
      { reportMs: 60 }
    );
    expect(outcome).toEqual({ status: "not_displayed", detail: "no_report" });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("the service's own state sync is not a tool action", async () => {
    const outcomes: string[] = [];
    script = [
      () => ({ call: { action: "discovery_saved", bibcode: CA, workId: "doi:10.1000/w1" } }),
      (ctx) => {
        outcomes.push(lastText(ctx));
        return { text: "done" };
      },
    ];
    const { actions } = await run(exploring(), "Sync", true);
    expect(outcomes[0]).toContain("Validation failed"); // not in the tool's action enum at all
    expect(actions).toEqual([]);
  });
});

describe("what the model is told", () => {
  test("the page's exploration is in the message context and its summary is recorded; the tool and prompt describe the actions", async () => {
    script = [() => ({ call: { action: "read_discovery" } }), () => ({ text: "ok" })];
    const shown = discoveryPage({
      selectedBibcode: CA,
      graph: { ...baseGraph(), filter: "related" },
    });
    const { snapshot } = await run(exploring(shown));
    const envelope = JSON.stringify(seen[0]?.messages);
    expect(envelope).toContain(CB);
    expect(envelope).toContain('\\"discovery\\"');
    expect(snapshot.messages[0]?.context?.discovery).toEqual({
      state: "ready",
      seed: SEEDB,
      filter: "related",
      shown: 4,
      total: 4,
      selectedBibcode: CA,
    });
    const tool = getCurrentTools(seen[0]?.messages ?? []).find((t) => t.name === "library");
    for (const word of [
      "read_discovery",
      "save_candidate",
      "explore_candidate",
      "one fixed ADS request",
      "never an edge",
    ])
      expect(tool?.description + JSON.stringify(seen[0]?.messages)).toContain(word);
    expect(tool?.description).toContain("never save candidates in bulk");
    const sent = JSON.stringify(seen[0]?.messages);
    expect(sent).toMatch(/save_candidate is the only exploration write/);
    expect(sent).toMatch(/never in bulk/);
    // every tool action the contracts list is in the tool's closed enum
    const schema = JSON.stringify(tool?.parameters);
    for (const action of LIBRARY_OPERATION_ACTIONS) expect(schema).toContain(`"${action}"`);
  });
});

describe("tabs and size", () => {
  test("a view action reaches the bound tab only: a second tab of the same conversation hears nothing", async () => {
    const created = (await (
      await request("/conversations", "POST", { model: choice })
    ).json()) as ConversationSnapshot;
    const bound = exploring();
    const other = { ...exploring(), viewId: randomUUID() };
    const boundActions: Record<string, unknown>[] = [];
    await openTab(bound.viewId, created.conversation.id, boundActions);
    // a second browser tab (its own view id) on the same /ws hub
    if (!server) throw new Error("the first tab started the server");
    const port = (server.address() as AddressInfo).port;
    const second = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(second);
    const heard: Record<string, unknown>[] = [];
    second.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "copilot.view-action") heard.push(message.action);
    });
    await new Promise<void>((resolve, reject) => {
      second.on("open", () => resolve());
      second.on("error", reject);
    });
    const subscribed = new Promise<void>((resolve) =>
      second.on("message", (data) => {
        if (JSON.parse(data.toString()).type === "copilot.subscribed") resolve();
      })
    );
    second.send(
      JSON.stringify({
        type: "copilot.subscribe",
        conversationId: created.conversation.id,
        viewId: other.viewId,
      })
    );
    await subscribed;
    expect((await request(`/views/${other.viewId}`, "PUT", other)).status).toBe(200);
    expect((await request(`/views/${bound.viewId}`, "PUT", bound)).status).toBe(200);
    script = [
      () => ({ call: { action: "filter_discovery", filter: "useful" } }),
      () => save(CA),
      () => ({ text: "done" }),
    ];
    expect(
      (
        await request(`/conversations/${created.conversation.id}/messages`, "POST", {
          clientMessageId: randomUUID(),
          text: "Go",
          viewId: bound.viewId,
          contextRevision: bound.revision,
        })
      ).status
    ).toBe(202);
    await vi.waitFor(
      async () =>
        expect((await host.snapshot(created.conversation.id)).conversation.run?.status).not.toBe(
          "running"
        ),
      { timeout: 8000 }
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(boundActions.map((a) => a.action)).toEqual(["filter_discovery", "discovery_saved"]);
    expect(heard).toEqual([]);
  });

  test("a long exploration reaches the model whole: the last node is in the request, the report is valid", async () => {
    const nodes = Array.from({ length: 300 }, (_, i) => {
      const { abstract: _a, ...node } = paper(`2020LONG..${String(i).padStart(4, "0")}X`, {
        title: `Long list candidate ${i}`,
      });
      return node;
    });
    const long = discoveryPage({
      graph: {
        ...baseGraph(),
        nodes,
        edges: [],
        totals: { nodes: 300, related: 300, useful: 0, saved: 0 },
      },
    });
    script = [() => ({ text: "seen" })];
    await run(exploring(long));
    const sent = JSON.stringify(seen[0]?.messages);
    expect(sent).toContain("2020LONG..0299X");
    expect(sent).toContain("Long list candidate 299");
  });
});
