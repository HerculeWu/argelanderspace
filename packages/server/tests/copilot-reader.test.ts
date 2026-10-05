/**
 * Copilot `reader` tool and the Reader's page context (copilot ticket 18), end to end on the real seam: real Pi
 * session, real HTTP routes, real Doc/annotation files on disk, real /ws sockets as browser tabs. Only the model
 * provider is scripted; no network.
 */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReaderReading,
  type ConversationSnapshot,
  type PageContext,
  type ReaderPage,
  type TexDocIr,
  type WsServerMessage,
} from "@argelanderspace/contracts";
import {
  docContentFingerprint,
  libraryPaths,
  plansPath,
  publishPdfDoc,
  readDocumentForReading,
} from "@argelanderspace/core";
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
import { DocMutationRegistry } from "../src/doc-mutations.js";
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
let docMutations: DocMutationRegistry;
let paths: ReturnType<typeof libraryPaths>;
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
const W1 = "doi:10.1000/w1";
const request = (path: string, method = "GET", body?: unknown) =>
  app.request(`/api/copilot${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
/** The request the scripted model saw at that point; a missing one is a test failure, not an undefined. */
const seenAt = (index: number): TranscriptContext => {
  const context = seen[index];
  if (!context) throw new Error(`model request ${index} was never made`);
  return context;
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
  writeDoc();
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
                  name: out.tool ?? "reader",
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
  host = new CopilotHost(join(root, "data"), settings, () => {});
  docMutations = new DocMutationRegistry();
  app = createApp({
    docMutations,
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

// ---- a synthetic Doc on disk ------------------------------------------------------------------------ //
const DOC = "read-doc";
const LAST = "UNIQUE-LAST-PARAGRAPH-MARKER-7f3a";
const TABLE_CELL = "TABLE-LAST-CELL-91bc";
const REF_RAW = "REFERENCE-LAST-RAW-TEXT-4d2e";
const docDir = () => join(root, "data", "output", DOC);
const irFile = () => join(docDir(), `${DOC}.json`);
const currentFile = () => join(root, "data", "annotations", DOC, "current.json");
function docIr(paragraphs = 3, last = LAST): TexDocIr {
  const body = Array.from({ length: paragraphs }, (_, n) => ({
    id: `p-${n + 1}`,
    type: "paragraph" as const,
    segments: [
      {
        type: "text" as const,
        text: `Paragraph ${n + 1} of the synthetic paper with some body text. `,
      },
      { type: "math" as const, latex: "E=mc^2" },
    ],
  }));
  return {
    version: 1,
    docId: DOC,
    title: "A Synthetic Reader Paper",
    sections: [
      {
        id: "sec-1",
        level: 1,
        number: "1",
        heading: "Introduction",
        blocks: [
          ...body,
          {
            id: "fig-1",
            type: "figure",
            imgPath: "plot.svg",
            captionSegments: [{ type: "text", text: "Plot." }],
          },
          {
            id: "tab-1",
            type: "table",
            tableBody: `<table><tr><th colspan="2">H</th></tr><tr><td>${TABLE_CELL}</td><td>b</td></tr></table>`,
          },
          { id: "p-last", type: "paragraph", segments: [{ type: "text", text: last }] },
        ],
        children: [],
      },
    ],
    refsManifest: [],
    bib: [{ id: "ref-1", short: "Lee 2020", raw: REF_RAW }],
    citationsByBlock: {},
    source: { type: "latex", origin: "x", main_tex: "main.tex" },
    meta: { title: "A Synthetic Reader Paper" },
  };
}
function writeDoc(ir: TexDocIr = docIr()) {
  mkdirSync(join(docDir(), "assets"), { recursive: true });
  writeFileSync(irFile(), JSON.stringify(ir));
  writeFileSync(join(docDir(), "assets", "plot.svg"), "<svg>v1</svg>");
}
/** A second, different Doc the user can open while a task about the first one runs. */
const OTHER = "other-doc";
function writeOtherDoc() {
  const dir = join(root, "data", "output", OTHER);
  mkdirSync(join(dir, "assets"), { recursive: true });
  const ir: TexDocIr = {
    ...docIr(1, "OTHER-DOC-MARKER"),
    docId: OTHER,
    title: "The Other Paper",
    sections: [
      {
        id: "sec-1",
        level: 1,
        heading: "Other",
        blocks: [
          { id: "p-1", type: "paragraph", segments: [{ type: "text", text: "OTHER-DOC-MARKER" }] },
        ],
        children: [],
      },
    ],
    bib: [],
  };
  writeFileSync(join(dir, `${OTHER}.json`), JSON.stringify(ir));
}
const NOTE = {
  id: "a_0000aaaa",
  target: { type: "document" as const },
  body: "  my exact note bytes  ",
  created_at: "2026-09-10T10:00:00.000Z",
  updated_at: "2026-09-10T10:00:00.000Z",
};
function writeCurrent(fingerprint: string, annotations: object[] = [NOTE]) {
  mkdirSync(join(root, "data", "annotations", DOC), { recursive: true });
  writeFileSync(
    currentFile(),
    `${JSON.stringify({ version: 1, rev: 2, content_fingerprint: fingerprint, annotations }, null, 2)}\n`
  );
}
const fingerprintNow = () =>
  docContentFingerprint(JSON.parse(readFileSync(irFile(), "utf8")), { docDir: docDir() });
/** Every file under the user's data (Docs and annotations, archive included) with its bytes. */
function userData(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[p.slice(root.length)] = readFileSync(p).toString("base64");
    }
  };
  walk(join(root, "data", "output"));
  walk(join(root, "data", "annotations"));
  return out;
}

// ---- page + conversation helpers -------------------------------------------------------------------- //
/** The page exactly as the browser publishes it: the reading of the admitted epoch the Reader shows. */
function readerPage(over: Partial<ReaderPage> = {}, docId = DOC): ReaderPage {
  const { ir, file, assets } = readDocumentForReading(join(root, "data"), docId);
  return {
    docId,
    format: "latex",
    sync: { phase: "ready" },
    reading: buildReaderReading({ ir, file, assets }),
    position: { activeSectionId: "sec-1", visibleBlockIds: ["p-1"] },
    selection: null,
    panels: { outlineCollapsed: false, rightCollapsed: false, rightTab: "references" },
    canGoBack: false,
    ...over,
  };
}
function page(
  reader: ReaderPage | null = readerPage(),
  revision = 1,
  viewId: string = randomUUID()
): PageContext {
  return {
    version: 1,
    viewId,
    revision,
    paneId: 1,
    view: "doc",
    status: reader?.reading ? "complete" : "unavailable",
    otherPanes: [],
    plan: null,
    reader,
  };
}
async function run(
  context: PageContext,
  text = "Look at this paper",
  tab = false,
  answer?: (a: Record<string, unknown>) => { ok: boolean; detail?: string }
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
const read = (docId = DOC) => ({ call: { action: "read", docId } });

test("the reader tool is registered beside plan, workspace and library and nothing else", async () => {
  script = [() => read(), () => ({ text: "ok" })];
  await run(page());
  expect(getCurrentTools(seen[0]?.messages ?? []).map((tool) => tool.name)).toEqual([
    "plan",
    "workspace",
    "library",
    "reader",
  ]);
});

test("the whole reading reaches the model with the message: the last unique paragraph, the table body and the bibliography", async () => {
  script = [() => ({ text: "seen" })];
  const { snapshot } = await run(page());
  const sent = JSON.stringify(seen[0]?.messages);
  expect(sent).toContain(LAST);
  expect(sent).toContain(TABLE_CELL);
  expect(sent).toContain(REF_RAW);
  expect(sent).toContain(`\\"fingerprint\\":\\"${fingerprintNow()}`);
  // the message records what the Reader carried and which Doc it is about
  expect(snapshot.messages[0]?.context).toMatchObject({
    view: "doc",
    status: "complete",
    reader: {
      docId: DOC,
      phase: "ready",
      fingerprint: fingerprintNow(),
      sections: 1,
      references: 1,
    },
    objects: [{ id: DOC, rev: 0, name: "A Synthetic Reader Paper" }],
  });
});

test("a reading that is not an admitted epoch is no content: the model is told the phase, not given old text", async () => {
  script = [() => ({ text: "seen" })];
  const syncing = page(readerPage({ sync: { phase: "syncing", reason: "busy" }, reading: null }));
  syncing.status = "unavailable";
  const { snapshot } = await run(syncing);
  const sent = JSON.stringify(seen[0]?.messages);
  expect(sent).not.toContain(LAST);
  expect(sent).toContain('\\"phase\\":\\"syncing\\"');
  expect(snapshot.messages[0]?.context).toMatchObject({
    status: "unavailable",
    reader: { phase: "syncing", fingerprint: null },
  });
});

test("the page is refused when a selection names another epoch than its reading or the reading is not admitted", async () => {
  const context = page(readerPage());
  const target = {
    type: "text",
    block: "p-1",
    container: { type: "content" },
    start: 0,
    end: 4,
    quote: "Para",
  };
  const good = {
    ...context,
    reader: { ...context.reader, selection: { fingerprint: fingerprintNow(), target } },
  };
  expect((await request(`/views/${context.viewId}`, "PUT", good)).status).toBe(200);
  const stale = {
    ...context,
    reader: { ...context.reader, selection: { fingerprint: "0".repeat(64), target } },
  };
  expect((await request(`/views/${context.viewId}`, "PUT", stale)).status).toBe(400);
  const wrongPhase = {
    ...context,
    reader: { ...context.reader, sync: { phase: "error", reason: "read" } },
  };
  expect((await request(`/views/${context.viewId}`, "PUT", wrongPhase)).status).toBe(400);
});

test("a conversation that carried a Reader page loads back after a service restart", async () => {
  script = [() => ({ text: "seen" })];
  const { id } = await run(page());
  await host.close();
  const again = new CopilotHost(join(root, "data"), settings, () => {});
  try {
    const snapshot = await again.snapshot(id);
    expect(snapshot.messages[0]?.context?.objects).toEqual([
      { id: DOC, rev: 0, name: "A Synthetic Reader Paper" },
    ]);
  } finally {
    await again.close();
  }
  host = new CopilotHost(join(root, "data"), settings, () => {});
});

test("read returns the whole Doc from disk in the background: nothing moves, nothing is written", async () => {
  writeCurrent(fingerprintNow());
  const before = userData();
  script = [() => read(), () => ({ text: "read" })];
  const { snapshot, actions } = await run(page(null), "Read the paper", true);
  const result = lastResult(seenAt(1));
  expect(result).toMatchObject({ ok: true, status: "ok" });
  const reading = result.reading;
  expect(reading.entries.at(-1)).toMatchObject({ id: "p-last", text: LAST });
  expect(JSON.stringify(reading)).toContain(TABLE_CELL);
  expect(reading.references[0].raw).toBe(REF_RAW);
  expect(reading.annotations).toEqual([NOTE]);
  expect(reading.epoch).toEqual({
    fingerprint: fingerprintNow(),
    annotationsRev: 2,
    annotations: "current",
  });
  expect(reading.entries.find((e: { id: string }) => e.id === "fig-1").asset.sha256).toMatch(
    /^[0-9a-f]{64}$/
  );
  // a background read never asks the browser to show anything and writes nothing
  expect(actions).toEqual([]);
  expect(userData()).toEqual(before);
  expect(ops(snapshot)[0]).toMatchObject({
    tool: "reader",
    action: "read",
    status: "ok",
    object: { kind: "doc", id: DOC },
  });
});

test("saved annotations of older content are left out and are neither archived nor changed by a read", async () => {
  writeCurrent("e".repeat(64), [{ ...NOTE, body: "OLD-CONTENT-NOTE" }]);
  const before = userData();
  script = [() => read(), () => ({ text: "read" })];
  await run(page(null));
  const result = lastResult(seenAt(1));
  expect(result.reading.annotations).toEqual([]);
  expect(result.reading.epoch.annotations).toBe("stale");
  expect(JSON.stringify(result)).not.toContain("OLD-CONTENT-NOTE");
  expect(existsSync(join(root, "data", "annotations", DOC, "archive"))).toBe(false);
  expect(userData()).toEqual(before);
});

test("the archive is never read: its notes reach neither the model nor the page", async () => {
  writeCurrent(fingerprintNow());
  mkdirSync(join(root, "data", "annotations", DOC, "archive"), { recursive: true });
  writeFileSync(
    join(root, "data", "annotations", DOC, "archive", "20260901T000000000Z-ffffffff.json"),
    JSON.stringify({ annotations: [{ body: "ARCHIVED-SECRET" }] })
  );
  script = [() => read(), () => ({ text: "read" })];
  await run(page(null));
  expect(JSON.stringify(seen)).not.toContain("ARCHIVED-SECRET");
});

test("unreadable data is an explicit error that names no path and leaves every byte alone", async () => {
  // unknown Doc
  script = [() => read("nope"), () => ({ text: "x" })];
  await run(page(null));
  expect(lastResult(seenAt(1))).toMatchObject({ ok: false, status: "not_found" });

  // damaged IR
  writeFileSync(irFile(), "{ not json");
  writeCurrent("e".repeat(64));
  let before = userData();
  seen = [];
  script = [() => read(), () => ({ text: "x" })];
  await run(page(null));
  let result = lastResult(seenAt(1));
  expect(result).toMatchObject({ ok: false, status: "error" });
  expect(JSON.stringify(result)).not.toContain(root);
  expect(userData()).toEqual(before);

  // damaged annotations store: nothing is reset
  writeDoc();
  writeFileSync(currentFile(), "{ broken");
  before = userData();
  seen = [];
  script = [() => read(), () => ({ text: "x" })];
  await run(page(null));
  result = lastResult(seenAt(1));
  expect(result).toMatchObject({ ok: false, status: "error" });
  expect(result.detail).toContain("annotations");
  expect(userData()).toEqual(before);

  // an image the IR declares is missing: the document cannot be verified, so it is not read and not archived
  writeCurrent("e".repeat(64));
  rmSync(join(docDir(), "assets", "plot.svg"));
  before = userData();
  seen = [];
  script = [() => read(), () => ({ text: "x" })];
  await run(page(null));
  result = lastResult(seenAt(1));
  expect(result).toMatchObject({ ok: false, status: "error" });
  expect(existsSync(join(root, "data", "annotations", DOC, "archive"))).toBe(false);
  expect(userData()).toEqual(before);
});

test("a Doc a job is replacing or deleting is busy: nothing half-written is read", async () => {
  docMutations.pinWriter(DOC);
  script = [() => read(), () => ({ text: "x" })];
  const { snapshot } = await run(page(null));
  expect(lastResult(seenAt(1))).toMatchObject({ ok: false, status: "rejected" });
  expect(ops(snapshot)[0]).toMatchObject({ action: "read", status: "rejected" });
  docMutations.unpinWriter(DOC);
});

test("a PDF Doc is not a LaTeX reading", async () => {
  const published = publishPdfDoc(paths, {
    workId: W1,
    filename: "mine.pdf",
    bytes: readFileSync(new URL("./fixtures/pdf/scanned-no-text.pdf", import.meta.url)),
    pages: [{ width: 612, height: 792, rotation: 0 }],
  });
  script = [() => read(published.doc_id), () => ({ text: "x" })];
  await run(page(null));
  expect(lastResult(seenAt(1))).toMatchObject({ ok: false, status: "unsupported" });
});

test("a reading larger than the room left in the window is refused whole with its size, never cut", async () => {
  writeDoc(docIr(900));
  const model = (await settings.getRuntime())
    .getModels("openai")
    .find((candidate) => candidate.id === "gpt-4.1");
  if (!model) throw new Error("fixture model");
  const original = { contextWindow: model.contextWindow, maxTokens: model.maxTokens };
  model.contextWindow = 24_000;
  model.maxTokens = 1024;
  try {
    script = [() => read(), () => ({ text: "x" })];
    const { snapshot } = await run(page(null));
    const result = lastResult(seenAt(1));
    expect(result).toMatchObject({ ok: false, status: "rejected" });
    expect(result.detail).toMatch(/capacity/);
    expect(result.detail).toMatch(/not cut/);
    expect(result.coverage.blocks).toBe(903);
    expect(result.reading).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(LAST);
    expect(ops(snapshot)[0]).toMatchObject({ status: "rejected" });
  } finally {
    Object.assign(model, original);
  }
});

test("navigation reaches only the bound tab and reports the Reader's own answer, including a paused Reader", async () => {
  script = [
    () => ({ call: { action: "navigate", docId: DOC, anchor: "p-last" } }),
    () => ({ call: { action: "navigate", docId: DOC, anchor: "sec-1" } }),
    () => ({ text: "done" }),
  ];
  let first = true;
  const { snapshot, actions } = await run(page(), "Show me the end", true, () => {
    if (first) {
      first = false;
      return { ok: true };
    }
    return { ok: false, detail: "unavailable" };
  });
  expect(actions).toEqual([
    { action: "navigate", docId: DOC, anchor: "p-last" },
    { action: "navigate", docId: DOC, anchor: "sec-1" },
  ]);
  expect(ops(snapshot).map((o) => o.status)).toEqual(["ok", "not_displayed"]);
  expect(lastResult(seenAt(2))).toMatchObject({ ok: false, status: "not_displayed" });
});

test("every Reader control action is a closed, bound-view action; selectors and paths are refused, and an annotation write without its epoch and target writes nothing (ticket 19)", async () => {
  script = [
    () => ({ call: { action: "set_panel", docId: DOC, panel: "outline", collapsed: true } }),
    () => ({ call: { action: "set_right_tab", docId: DOC, tab: "annotations" } }),
    () => ({ call: { action: "jump_back", docId: DOC } }),
    () => ({ call: { action: "retry_sync", docId: DOC } }),
    () => ({ call: { action: "create_annotation", docId: DOC, body: "x" } }),
    () => ({ call: { action: "navigate", docId: DOC, anchor: "p-1", selector: "#x" } }),
    () => ({ text: "done" }),
  ];
  const { snapshot, actions } = await run(page(), "Drive the reader", true);
  expect(actions.map((a) => a.action)).toEqual([
    "set_panel",
    "set_right_tab",
    "jump_back",
    "retry_sync",
  ]);
  // the last two never reach the browser: a write is not a view action, and the tool's own schema is closed (no selector)
  expect(ops(snapshot).map((o) => o.status)).toEqual(["ok", "ok", "ok", "ok", "invalid", "error"]);
});

test("a later page observation does not repeat the reading; it still says which epoch it was", async () => {
  const context = page(readerPage());
  script = [
    async () => {
      // the user scrolls while the run works: a new revision of the same page reaches the service
      const next = {
        ...context,
        revision: 2,
        reader: {
          ...(context.reader as ReaderPage),
          position: { activeSectionId: "sec-1", visibleBlockIds: ["p-last"] },
        },
      };
      expect((await request(`/views/${context.viewId}`, "PUT", next)).status).toBe(200);
      return read();
    },
    () => ({ text: "done" }),
  ];
  const { id } = await run(context);
  const second = JSON.stringify(seen[1]?.messages);
  // the full reading is in the task's own message and in the read result, but not a third time as an observation
  const observation = (seen[1]?.messages ?? []).filter(
    (m) => m.role !== "system" && JSON.stringify(m).includes("taskContextId")
  );
  expect(observation.length).toBeGreaterThan(0);
  for (const message of observation) {
    expect(JSON.stringify(message)).not.toContain(LAST);
    expect(JSON.stringify(message)).toContain("readingOmitted");
    expect(JSON.stringify(message)).toContain(fingerprintNow());
  }
  expect(second.split(LAST).length - 1).toBe(2);
  // the observation is saved in the history: it still validates when the service restarts and loads it
  await host.close();
  const again = new CopilotHost(join(root, "data"), settings, () => {});
  try {
    expect((await again.snapshot(id)).messages[0]?.context?.reader).toMatchObject({
      docId: DOC,
      phase: "ready",
    });
  } finally {
    await again.close();
  }
  host = new CopilotHost(join(root, "data"), settings, () => {});
});

test("the task keeps its Doc when the user opens another one: reads and navigation name the Doc, the page change is only an observation", async () => {
  writeOtherDoc();
  const context = page(readerPage());
  script = [
    async () => {
      // the user opens the other Doc while the run works: a new revision of the view, about another Doc
      const next = { ...page(readerPage({}, OTHER), 2, context.viewId) };
      expect((await request(`/views/${context.viewId}`, "PUT", next)).status).toBe(200);
      return { call: { action: "read", docId: DOC } };
    },
    () => ({ call: { action: "navigate", docId: DOC, anchor: "p-last" } }),
    () => ({ text: "done" }),
  ];
  const { snapshot, actions } = await run(context, "Summarise this paper", true);
  // the read is about the task's Doc, not the page the user moved to
  const result = lastResult(seenAt(1));
  expect(result.reading.docId).toBe(DOC);
  expect(JSON.stringify(result)).toContain(LAST);
  expect(JSON.stringify(result)).not.toContain("OTHER-DOC-MARKER");
  // the message still names the Doc it was sent from; the model learns of the new page from the observation
  expect(snapshot.messages[0]?.context?.objects).toEqual([
    { id: DOC, rev: 0, name: "A Synthetic Reader Paper" },
  ]);
  const observation = (seen[1]?.messages ?? []).filter(
    (m) => m.role !== "system" && JSON.stringify(m).includes("taskContextId")
  );
  expect(JSON.stringify(observation)).toContain(`\\"docId\\":\\"${OTHER}\\"`);
  // navigation is explicit about the Doc too (the bound tab opens/uses it); nothing was sent for the other Doc
  expect(actions).toEqual([{ action: "navigate", docId: DOC, anchor: "p-last" }]);
});

test("a reading beyond the page-context limit is refused with capacity, never truncated", async () => {
  writeDoc(docIr(60_000));
  const context = page(readerPage());
  const response = await request(`/views/${context.viewId}`, "PUT", context);
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ code: "capacity" });
});

test("a reading larger than the model's window cannot be sent as a message: capacity, nothing partial is accepted", async () => {
  writeDoc(docIr(900));
  const model = (await settings.getRuntime())
    .getModels("openai")
    .find((candidate) => candidate.id === "gpt-4.1");
  if (!model) throw new Error("fixture model");
  const original = { contextWindow: model.contextWindow, maxTokens: model.maxTokens };
  model.contextWindow = 24_000;
  model.maxTokens = 1024;
  try {
    const context = page(readerPage());
    const created = (await (
      await request("/conversations", "POST", { model: choice })
    ).json()) as ConversationSnapshot;
    expect((await request(`/views/${context.viewId}`, "PUT", context)).status).toBe(200);
    const sent = await request(`/conversations/${created.conversation.id}/messages`, "POST", {
      clientMessageId: randomUUID(),
      text: "Read it all",
      viewId: context.viewId,
      contextRevision: context.revision,
    });
    expect(sent.status).toBeGreaterThanOrEqual(400);
    expect(await sent.json()).toMatchObject({ code: "capacity" });
    expect(seen).toHaveLength(0);
    expect((await host.snapshot(created.conversation.id)).messages).toEqual([]);
  } finally {
    Object.assign(model, original);
  }
});

test("a scroll republishes the page by reference: the service puts the held reading back, and an unknown reference is stale", async () => {
  const context = page(readerPage());
  expect((await request(`/views/${context.viewId}`, "PUT", context)).status).toBe(200);
  const reading = context.reader?.reading;
  if (!reading) throw new Error("fixture");
  const ref = {
    fingerprint: reading.epoch.fingerprint,
    annotationsRev: reading.epoch.annotationsRev,
  };
  const scrolled = {
    ...context,
    revision: 2,
    reader: {
      ...(context.reader as ReaderPage),
      reading: null,
      readingRef: ref,
      position: { activeSectionId: "sec-1", visibleBlockIds: ["p-last"] },
    },
  };
  expect((await request(`/views/${context.viewId}`, "PUT", scrolled)).status).toBe(200);
  // a message sent now carries the whole document and the new position
  script = [() => ({ text: "seen" })];
  const created = (await (
    await request("/conversations", "POST", { model: choice })
  ).json()) as ConversationSnapshot;
  await request(`/conversations/${created.conversation.id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text: "Look",
    viewId: context.viewId,
    contextRevision: 2,
  });
  await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: 8000 });
  const sent = JSON.stringify(seen[0]?.messages);
  expect(sent).toContain(LAST);
  expect(sent).toContain('\\"visibleBlockIds\\":[\\"p-last\\"]');
  expect(sent).not.toContain("readingRef");
  // a reference the service does not hold (another fingerprint, or another view) is refused, so the view sends it whole
  const unknown = {
    ...scrolled,
    revision: 3,
    reader: { ...scrolled.reader, readingRef: { ...ref, fingerprint: "0".repeat(64) } },
  };
  expect((await request(`/views/${context.viewId}`, "PUT", unknown)).status).toBe(409);
  const stranger = { ...scrolled, viewId: randomUUID() };
  expect((await request(`/views/${stranger.viewId}`, "PUT", stranger)).status).toBe(409);
});

test("a view cannot publish an omitted reading", async () => {
  const context = page(readerPage());
  const reader = context.reader as ReaderPage;
  const forged = {
    ...context,
    reader: {
      ...reader,
      reading: null,
      readingOmitted: {
        fingerprint: reader.reading?.epoch.fingerprint,
        annotationsRev: 0,
        coverage: reader.reading?.coverage,
        note: "x",
      },
    },
  };
  expect((await request(`/views/${context.viewId}`, "PUT", forged)).status).toBe(400);
});

test("an observation names a reading as held only for the Doc and epoch the task was sent with", async () => {
  writeOtherDoc();
  const context = page(readerPage());
  script = [
    async () => {
      const other = page(readerPage({}, OTHER), 2, context.viewId);
      expect((await request(`/views/${context.viewId}`, "PUT", other)).status).toBe(200);
      return { call: { action: "read", docId: DOC } };
    },
    async () => {
      // the document is replaced and the user's Reader admits the new epoch
      writeDoc(docIr(3, "REPLACED-LAST-PARAGRAPH"));
      const next = page(readerPage(), 3, context.viewId);
      expect((await request(`/views/${context.viewId}`, "PUT", next)).status).toBe(200);
      return { call: { action: "read", docId: DOC } };
    },
    () => ({ text: "done" }),
  ];
  await run(context);
  const observations = (index: number) =>
    JSON.stringify(
      (seen[index]?.messages ?? []).filter(
        (m) => m.role !== "system" && JSON.stringify(m).includes("taskContextId")
      )
    );
  expect(observations(1)).toContain("not in the task's context");
  expect(observations(1)).not.toContain("is in the task's context");
  expect(observations(2)).toContain("not in the task's context");
  expect(observations(2)).not.toContain("REPLACED-LAST-PARAGRAPH");
});
