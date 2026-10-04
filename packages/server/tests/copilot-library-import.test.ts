/**
 * Copilot `library` tool import_works (copilot ticket 14), end to end on the real seam: real Pi session, real HTTP
 * routes, real library lock/store/disk and library.changed notification, real /ws sockets as browser tabs.
 * Only the model provider is scripted; no network.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConversationSnapshot,
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
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "../src/app.js";
import { CopilotHost } from "../src/copilot.js";
import { createLibraryTool } from "../src/copilot-library-tool.js";
import { digest } from "../src/copilot-plan-tool.js";
import { JobRunner } from "../src/jobs.js";
import { AsyncLock } from "../src/lock.js";
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
const lastResult = (context: TranscriptContext) => {
  const results = context.messages.filter((m) => m.role === "toolResult");
  const last = results.at(-1);
  if (last?.role !== "toolResult") throw new Error("no tool result yet");
  const part = last.content[0];
  return JSON.parse(part && part.type === "text" ? part.text : "{}");
};

beforeEach(async () => {
  originalEnv = process.env;
  root = mkdtempSync(join(tmpdir(), "copilot-library-"));
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
  answer: (action: Record<string, unknown>) => { ok: boolean; detail?: string } = () => ({
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
    void request(`/views/${viewId}/action-results`, "POST", {
      actionId: message.actionId,
      ...answer(message.action),
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
async function run(context: PageContext, text = "Check my library", tab = false) {
  const created = (await (
    await request("/conversations", "POST", { model: choice })
  ).json()) as ConversationSnapshot;
  const id = created.conversation.id;
  const actions: Record<string, unknown>[] = [];
  if (tab) await openTab(context.viewId, id, actions);
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

// ---- import helpers --------------------------------------------------------------------------------- //
const BIBCODE = "2020MNRAS.499.1234X";
const adsSources = (): MetadataSources => ({
  ...stubSources(),
  ads: {
    status: "ok",
    resolve: async () => null,
    exportBibtex: async (codes: string[]) =>
      codes.includes(BIBCODE)
        ? `@ARTICLE{${BIBCODE},\n  author = {{Doe}, J.},\n  title = {A fresh MNRAS paper},\n  journal = {\\mnras},\n  year = {2020},\n  volume = {499},\n  pages = {1234},\n  doi = {10.1093/mnras/staa9999}\n}`
        : null,
  },
});
const BIB_TWO = `@article{freshA,\n  author = {Doe, J.},\n  title = {A fresh paper},\n  year = {2024}\n}\n@article{freshB,\n  author = {Roe, K.},\n  title = {Another fresh paper},\n  year = {2023}\n}\n`;
const inputs = {
  identifier: { mode: "identifier", text: "arXiv:2603.99999" },
  bibcode: { mode: "bibcode", text: BIBCODE },
  bib: { mode: "bib", text: BIB_TWO },
} as const;
type Mode = keyof typeof inputs;
const uiRequest = (mode: Mode, text: string = inputs[mode].text) =>
  mode === "identifier"
    ? { mode, value: text }
    : mode === "bibcode"
      ? { mode, bibcode: text }
      : { mode, bib: text };
const uiImport = async (body: object) => {
  const res = await app.request("/api/library/works", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { results: Record<string, unknown>[] }).results;
};
/** Library file without the creation timestamps (the only legitimately differing field). */
const stable = () => {
  const raw = disk();
  for (const w of raw.works) w.added_at = undefined;
  return JSON.stringify(raw);
};
const toolImport = (mode: Mode, text?: string, extra: object = {}) => ({
  call: { action: "import_works", mode, text: text ?? inputs[mode].text, ...extra },
});
const casesAll: Mode[] = ["identifier", "bibcode", "bib"];

test.each(casesAll)(
  "%s: the UI request and the tool give the same Work identity, results and event",
  async (mode) => {
    sources = adsSources();
    const viaUi = await uiImport(uiRequest(mode));
    const uiBytes = stable();
    const uiEvents = changed().map((m) => (m as { cause: string }).cause);
    expect(uiEvents).toEqual(["add"]);
    writeLibrary();
    broadcasts = [];
    let payload: { results?: Record<string, unknown>[] } = {};
    script = [
      () => toolImport(mode),
      (ctx) => {
        payload = lastResult(ctx);
        return { text: "imported" };
      },
    ];
    const { snapshot } = await run(page());
    expect(payload.results).toEqual(viaUi);
    expect(stable()).toBe(uiBytes);
    expect(changed().map((m) => (m as { cause: string }).cause)).toEqual(uiEvents);
    expect(ops(snapshot)).toMatchObject([{ action: "import_works", status: "ok" }]);
  }
);

test("every error the dialog shows is the tool's result, and nothing is written or announced", async () => {
  sources = adsSources();
  const cases: [Mode, string][] = [
    ["identifier", "hello world"],
    ["identifier", "2603.99999"],
    ["bibcode", "2099A&A...1..1Z"],
    ["bib", "not bibtex at all"],
  ];
  for (const [mode, text] of cases) {
    writeLibrary();
    broadcasts = [];
    const before = bytes();
    const viaUi = await uiImport(uiRequest(mode, text));
    expect(viaUi[0]?.status).toBe("error");
    let payload: { results?: unknown; status?: string } = {};
    script = [
      () => toolImport(mode, text),
      (ctx) => {
        payload = lastResult(ctx);
        return { text: "failed" };
      },
    ];
    seen = [];
    const { snapshot } = await run(page());
    expect(payload).toMatchObject({ ok: false, status: "error", results: viaUi });
    expect(ops(snapshot).at(-1)).toMatchObject({ action: "import_works", status: "error" });
    expect(bytes()).toBe(before);
    expect(changed()).toHaveLength(0);
  }
});

test("business de-duplication is by identity; operationId only guards the repeat of one request", async () => {
  sources = adsSources();
  const results: Record<string, unknown>[] = [];
  script = [
    () => toolImport("identifier", "arXiv:2603.99999", { operationId: "imp-1" }),
    (ctx) => {
      results.push(lastResult(ctx));
      return toolImport("identifier", "arXiv:2603.99999", { operationId: "imp-1" });
    },
    (ctx) => {
      results.push(lastResult(ctx));
      // same key, different request
      return toolImport("identifier", "arXiv:2603.88888", { operationId: "imp-1" });
    },
    (ctx) => {
      results.push(lastResult(ctx));
      // new operation, same identity: the library already has it
      return toolImport("identifier", "https://arxiv.org/abs/2603.99999", { operationId: "imp-2" });
    },
    (ctx) => {
      results.push(lastResult(ctx));
      return { text: "done" };
    },
  ];
  const { snapshot } = await run(page());
  expect(results[0]).toMatchObject({ ok: true, status: "ok", created: 1 });
  expect(results[1]).toMatchObject({ ok: true, status: "ok", duplicate: true });
  expect(results[2]).toMatchObject({ ok: false, status: "rejected" });
  expect(results[3]).toMatchObject({
    ok: true,
    status: "noop",
    created: 0,
    existing: 1,
    results: [{ status: "exists" }],
  });
  expect(disk().works.filter((w: { id: string }) => w.id.startsWith("arxiv:"))).toHaveLength(1);
  expect(disk().works).toHaveLength(4);
  expect(changed()).toHaveLength(1);
  expect(ops(snapshot).map((o) => o.status)).toEqual(["ok", "ok", "rejected", "noop"]);
});

test("a source failure keeps the library bytes, saves no guessed stub and never shows the token", async () => {
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
    () => toolImport("bibcode", BIBCODE),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "failed" };
    },
  ];
  const { id, snapshot } = await run(page());
  // the real client really used the token and really failed
  expect(requests.length).toBeGreaterThan(0);
  expect(payload).toMatchObject({ ok: false, status: "error" });
  expect(bytes()).toBe(before);
  expect(changed()).toHaveLength(0);
  expect(ops(snapshot)[0]).toMatchObject({ status: "error" });
  const everything = JSON.stringify([
    payload,
    snapshot,
    seen,
    await (await request(`/conversations/${id}`)).json(),
  ]);
  expect(everything).not.toContain(TOKEN);
});

test("an identifier whose sources all fail still saves the bare Work like the page, and keeps every other Work", async () => {
  sources = {
    ads: {
      status: "ok",
      resolve: async () => {
        throw new Error("down");
      },
      exportBibtex: async () => null,
    },
    crossref: {
      resolve: async () => {
        throw new Error("down");
      },
    },
    oa: { resolve: async () => null },
  };
  const before = disk();
  script = [
    () => toolImport("identifier", "10.5555/offline.1"),
    (ctx) => {
      expect(lastResult(ctx)).toMatchObject({ ok: true, status: "ok", created: 1 });
      return { text: "saved" };
    },
  ];
  await run(page());
  const after = disk();
  // every seeded Work, with its unknown keys, and the top level and project are kept
  expect(after.works.slice(0, 3)).toEqual(before.works);
  expect(after.x_top).toEqual(before.x_top);
  expect(after.project).toEqual(before.project);
  expect(after.works[0]).toMatchObject({
    x_work: "keep-me",
    note: "Private note",
    doc_ids: ["d1", "d2", "d3"],
  });
  expect(after.works[1]).toMatchObject({ x_other: 7 });
  expect(after.works[3]).toMatchObject({ id: "doi:10.5555/offline.1" });
});

test("a failing save is unknown, never claimed as unchanged, and the library bytes stay", async () => {
  const before = bytes();
  // a directory where the store stages its temporary file makes the real save fail
  mkdirSync(join(paths.libraryDir, "library.json.tmp"));
  let payload: Record<string, unknown> = {};
  script = [
    () => toolImport("bib", BIB_TWO),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "unsure" };
    },
  ];
  const { snapshot } = await run(page());
  expect(payload).toMatchObject({ ok: false, status: "unknown" });
  expect(String(payload.detail)).toContain("read the library");
  expect(ops(snapshot)[0]).toMatchObject({ action: "import_works", status: "unknown" });
  expect(bytes()).toBe(before);
  expect(changed()).toHaveLength(0);
});

test("a repeat of an import whose begin was recorded without a result is unknown, not a second import", async () => {
  const request1 = { action: "import_works", mode: "identifier", text: "arXiv:2603.99999" };
  const imports: unknown[] = [];
  const tool = createLibraryTool({
    library: {
      paths,
      libraryLock: new AsyncLock(),
      onChanged: () => {},
      readPayload: async () => {
        throw new Error("unused");
      },
      importWorks: async (req) => {
        imports.push(req);
        return { results: [], changed: false, updated: [], rejected: false };
      },
    },
    journal: {
      lookup: () => ({ state: "begun", hash: digest(request1) }),
      begin: () => {
        throw new Error("must not begin again");
      },
      done: () => {},
    },
    viewAction: async () => ({ ok: true }) as never,
    admitting: () => true,
  });
  const result = await tool.execute(
    "call-1",
    { ...request1, operationId: "imp-x" } as never,
    undefined as never,
    undefined as never,
    undefined as never
  );
  const first = result.content[0];
  expect(JSON.parse(first && first.type === "text" ? first.text : "{}")).toMatchObject({
    ok: false,
    status: "unknown",
  });
  expect(result.details).toMatchObject({ action: "import_works", status: "unknown" });
  expect(imports).toEqual([]);
});

test("only dialog text is accepted: paths, files and unknown modes are refused with nothing written", async () => {
  const before = bytes();
  const bad: Record<string, unknown>[] = [
    { action: "import_works", mode: "bib", path: "/etc/hosts" },
    { action: "import_works", mode: "bib", text: "x", path: "/tmp/a.bib" },
    { action: "import_works", mode: "file", text: "/tmp/a.bib" },
    { action: "import_works", mode: "identifier", text: "   " },
    { action: "import_works", text: "arXiv:2603.99999" },
  ];
  const raw = (ctx: TranscriptContext) => {
    const last = ctx.messages.filter((m) => m.role === "toolResult").at(-1);
    const part = last?.role === "toolResult" ? last.content[0] : undefined;
    return part && part.type === "text" ? part.text : "";
  };
  const answers: string[] = [];
  script = [
    ...bad.map(
      (call, index): Step =>
        (ctx) => {
          if (index > 0) answers.push(raw(ctx));
          return { call };
        }
    ),
    (ctx) => {
      answers.push(raw(ctx));
      return { text: "done" };
    },
  ];
  const { snapshot } = await run(page());
  expect(answers).toHaveLength(bad.length);
  // the first three never reach the handler (the SDK's closed schema); the last two fail the shared zod schema
  for (const answer of answers.slice(0, 3)) expect(answer).toContain("Validation failed");
  for (const answer of answers.slice(3))
    expect(JSON.parse(answer)).toMatchObject({ ok: false, status: "unsupported" });
  expect(ops(snapshot).filter((o) => o.status === "ok")).toEqual([]);
  expect(bytes()).toBe(before);
  expect(changed()).toHaveLength(0);
});

test("a partly failed batch is ok with the failed entries reported, keeps the user's cite keys", async () => {
  const clash = `@article{author1,\n  author = {Evil, I.},\n  title = {Totally different},\n  year = {1900}\n}\n@article{fine1,\n  author = {Fine, F.},\n  title = {A fine one},\n  year = {2021}\n}\n`;
  let payload: Record<string, unknown> = {};
  script = [
    () => toolImport("bib", clash),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "partial" };
    },
  ];
  const { snapshot } = await run(page());
  expect(payload).toMatchObject({
    ok: true,
    status: "ok",
    created: 1,
    failed: 1,
    warnings: ["import_partial"],
  });
  expect((payload.results as { status: string }[]).map((r) => r.status)).toEqual([
    "error",
    "created",
  ]);
  expect(ops(snapshot)[0]).toMatchObject({ status: "ok", warnings: ["import_partial"] });
  expect(disk().works.map((w: { cite_key: string }) => w.cite_key)).toContain("fine1");
});

test("the default arXiv PDF job follows the page's rule: identifier yes, BibTeX never", async () => {
  autoPdf = true;
  const pdfJobs = () =>
    runner
      .list()
      .filter((j) => (j.payload as { format?: unknown } | undefined)?.format === "arxiv-pdf");
  await uiImport(uiRequest("identifier", "arXiv:2603.77777"));
  const viaUi = pdfJobs().length;
  expect(viaUi).toBe(1);
  script = [
    () => toolImport("identifier", "arXiv:2603.66666"),
    () =>
      toolImport(
        "bib",
        `@article{ax,\n author={A, B.},\n title={With arxiv},\n year={2022},\n eprint={2603.55555},\n archiveprefix={arXiv}\n}`
      ),
    () => ({ text: "done" }),
  ];
  await run(page());
  expect(pdfJobs()).toHaveLength(viaUi + 1);
});

test("importing is a background edit: nothing is selected or opened, and the new work can then be opened in the sidebar", async () => {
  const created = "arxiv:2603.99999";
  script = [
    () => toolImport("identifier", "arXiv:2603.99999"),
    (ctx) => {
      expect(lastResult(ctx)).toMatchObject({ results: [{ ref: { id: created } }] });
      return { call: { action: "select_work", refId: created } };
    },
    () => ({ text: "shown" }),
  ];
  const { snapshot, actions } = await run(page(), "Import it", true);
  expect(ops(snapshot).map((o) => `${o.action}:${o.status}`)).toEqual([
    "import_works:ok",
    "select_work:ok",
  ]);
  expect(ops(snapshot)[0]).toMatchObject({ object: { kind: "work", id: created } });
  // the only view action is the explicit select_work
  expect(actions).toEqual([{ action: "select_work", refId: created }]);
});

test("the import request is only the dialog's text: the system prompt and tool say so", async () => {
  script = [() => ({ call: { action: "read", limit: 1 } }), () => ({ text: "ok" })];
  await run(page());
  const tool = getCurrentTools(seen[0]?.messages ?? []).find((t) => t.name === "library");
  expect(tool?.description).toContain("import_works");
  expect(tool?.description).toContain("it cannot read files");
  const sent = JSON.stringify(seen[0]?.messages);
  expect(sent).toMatch(/import_works[\s\S]*never a file path/);
  expect(sent).toMatch(/never saves recommendation candidates/);
});

// ---- ticket 14 repair round ------------------------------------------------------------------------- //
const keptUnknownKeys = () => {
  const after = disk();
  const seeded = seedFile();
  expect(after.x_top).toEqual(seeded.x_top);
  expect(after.project).toEqual(seeded.project);
  expect(after.works.slice(0, 3)).toEqual(seeded.works);
};

test.each(casesAll)(
  "%s: importing through the tool keeps the top level, project and every unknown key",
  async (mode) => {
    sources = adsSources();
    script = [() => toolImport(mode), () => ({ text: "done" })];
    await run(page());
    keptUnknownKeys();
    expect(disk().works.length).toBeGreaterThan(3);
  }
);

test("the page's own import route keeps the unknown keys too", async () => {
  sources = adsSources();
  await uiImport(uiRequest("bib"));
  keptUnknownKeys();
});

const FILL =
  "@article{author2,\n author={Author2},\n title={Work number 2},\n year={2002},\n doi={10.1000/w2},\n journal={Nature}\n}\n";

test("an existing work whose blank fields are filled is ok with its id in updated and one notification; the identical repeat is noop and silent", async () => {
  let first: Record<string, unknown> = {};
  let second: Record<string, unknown> = {};
  let afterFirst = "";
  script = [
    () => toolImport("bib", FILL),
    (ctx) => {
      first = lastResult(ctx);
      afterFirst = bytes();
      return toolImport("bib", FILL);
    },
    (ctx) => {
      second = lastResult(ctx);
      return { text: "done" };
    },
  ];
  const { snapshot } = await run(page());
  expect(first).toMatchObject({
    ok: true,
    status: "ok",
    created: 0,
    existing: 1,
    updated: ["doi:10.1000/w2"],
  });
  expect(disk().works[1]).toMatchObject({ venue: "MNRAS", x_other: 7 });
  expect(second).toMatchObject({ ok: true, status: "noop", updated: [] });
  expect(bytes()).toBe(afterFirst);
  expect(changed().map((m) => (m as { cause: string }).cause)).toEqual(["add"]);
  expect(ops(snapshot).map((o) => o.status)).toEqual(["ok", "noop"]);
});

test("the page's route announces an updated existing work exactly as the tool does", async () => {
  await uiImport(uiRequest("bib", FILL));
  expect(changed().map((m) => (m as { cause: string }).cause)).toEqual(["add"]);
});

// A record carrying work 1's DOI and work 3's title bridges two stored works.
const BRIDGE =
  "@article{bridge1,\n author={Author1},\n title={Work number 3},\n year={2003},\n doi={10.1000/w1}\n}\n";

test("a record that would merge two stored works is rejected by the tool: nothing written, no event, both works named", async () => {
  const before = bytes();
  let payload: Record<string, unknown> = {};
  script = [
    () => toolImport("bib", BRIDGE),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "refused" };
    },
  ];
  const { snapshot } = await run(page());
  expect(payload).toMatchObject({ ok: false, status: "rejected" });
  expect(JSON.stringify(payload.results)).toContain("doi:10.1000/w3");
  expect(JSON.stringify(payload.results)).toContain("doi:10.1000/w1");
  expect(bytes()).toBe(before);
  expect(changed()).toHaveLength(0);
  expect(ops(snapshot)[0]).toMatchObject({ action: "import_works", status: "rejected" });
});

test("the page still merges such a record (known behaviour, not changed by this ticket)", async () => {
  const results = await uiImport(uiRequest("bib", BRIDGE));
  expect(results[0]?.status).toBe("exists");
  expect(disk().works.map((w: { id: string }) => w.id)).toEqual([
    "doi:10.1000/w1",
    "doi:10.1000/w2",
  ]);
});

test("after an unknown outcome the guidance works: read finds a titleless stub by the identifier it was imported with", async () => {
  sources = adsSources();
  let found: { matched?: number; refs?: { id: string }[] } = {};
  script = [
    () => toolImport("identifier", "arXiv:2603.99999"),
    () => ({ call: { action: "read", query: "arXiv:2603.99999" } }),
    (ctx) => {
      found = lastResult(ctx);
      return { call: { action: "read", query: "https://doi.org/10.1093/mnras/staa9999" } };
    },
    () => ({ text: "done" }),
  ];
  await run(page());
  expect(found.matched).toBe(1);
  expect(found.refs?.[0]?.id).toBe("arxiv:2603.99999");
});

test("the journal describes an import in one readable line", async () => {
  const begun: { object?: { summary?: string } }[] = [];
  const tool = createLibraryTool({
    library: {
      paths,
      libraryLock: new AsyncLock(),
      onChanged: () => {},
      readPayload: async () => {
        throw new Error("unused");
      },
      importWorks: async () => ({ results: [], changed: false, updated: [], rejected: false }),
    },
    journal: { lookup: () => null, begin: (entry) => void begun.push(entry), done: () => {} },
    viewAction: async () => ({ ok: true }) as never,
    admitting: () => true,
  });
  await tool.execute(
    "call-2",
    {
      action: "import_works",
      mode: "bib",
      text: `@article{a,\n  title={${"long ".repeat(40)}}\n}`,
    } as never,
    undefined as never,
    undefined as never,
    undefined as never
  );
  const summary = begun[0]?.object?.summary ?? "";
  expect(summary.startsWith("bib: @article{a, title={long long")).toBe(true);
  expect(summary.length).toBeLessThanOrEqual(90);
  expect(summary).not.toContain("\n");
});

test("Stop during an import lets the submitted import finish, reports it, and starts no later step", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  sources = {
    ...adsSources(),
    ads: {
      ...adsSources().ads,
      exportBibtex: async (codes: string[]) => {
        entered = true;
        await gate;
        return adsSources().ads.exportBibtex(codes);
      },
    },
  };
  script = [() => toolImport("bibcode", BIBCODE), () => ({ text: "must not run" })];
  const context = page();
  const created = (await (
    await request("/conversations", "POST", { model: choice })
  ).json()) as ConversationSnapshot;
  const id = created.conversation.id;
  expect((await request(`/views/${context.viewId}`, "PUT", context)).status).toBe(200);
  await request(`/conversations/${id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text: "Import it",
    viewId: context.viewId,
    contextRevision: context.revision,
  });
  await vi.waitFor(() => expect(entered).toBe(true), { timeout: 8000 });
  expect((await request(`/conversations/${id}/stop`, "POST")).status).toBe(200);
  release();
  await vi.waitFor(
    async () =>
      expect(["stopped", "completed"]).toContain(
        (await host.snapshot(id)).conversation.run?.status
      ),
    { timeout: 8000 }
  );
  expect(disk().works.map((w: { id: string }) => w.id)).toContain("doi:10.1093/mnras/staa9999");
  expect(ops(await host.snapshot(id)).map((o) => `${o.action}:${o.status}`)).toEqual([
    "import_works:ok",
  ]);
  expect(changed()).toHaveLength(1);
  expect(seen).toHaveLength(1);
});

test("a title-derived work id already held by a different paper is refused, the stored paper keeps its note, star and unknown keys", async () => {
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
  let payload: Record<string, unknown> = {};
  script = [
    () =>
      toolImport(
        "bib",
        `@article{bob2020,\n author={Bob},\n title={${series} II. Ages},\n year={2020}\n}\n`
      ),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "refused" };
    },
  ];
  const { snapshot } = await run(page());
  expect(payload).toMatchObject({ ok: false, status: "error" });
  expect(JSON.stringify(payload.results)).toContain("already used by a different paper");
  expect(bytes()).toBe(before);
  expect(changed()).toHaveLength(0);
  expect(ops(snapshot)[0]).toMatchObject({ status: "error" });
});
