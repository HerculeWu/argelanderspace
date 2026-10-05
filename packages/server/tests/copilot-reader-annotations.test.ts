/**
 * Copilot `reader` tool annotation writes (copilot ticket 19), end to end on the real seam: real Pi
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
  buildStructureTarget,
  type ConversationSnapshot,
  irIndex,
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

// ---- annotation writes ------------------------------------------------------------------------------ //
const P1 = "Paragraph 1 of the synthetic paper with some body text. $E=mc^2$";
const readCall = (docId = DOC) => ({ call: { action: "read", docId } });
type Epoch = { fingerprint: string; annotationsRev: number };
/** The epoch the model's last `reader read` result carried, as a model would copy it into its next call. */
const epochOf = (context: TranscriptContext): Epoch => lastResult(context).reading.epoch;
/** Read first, then write with the epoch that reading carried. */
const afterRead =
  (build: (epoch: Epoch) => Record<string, unknown>): Step =>
  (context) => {
    const epoch = epochOf(context);
    return { call: build(epoch) };
  };
const withEpoch = (action: string, epoch: Epoch, rest: Record<string, unknown>) => ({
  action,
  docId: DOC,
  fingerprint: epoch.fingerprint,
  rev: epoch.annotationsRev,
  ...rest,
});
const stored = () => JSON.parse(readFileSync(currentFile(), "utf8"));
const archiveDir = () => join(root, "data", "annotations", DOC, "archive");
const putEvents = () =>
  broadcasts.filter((m) => m.type === "annotation.changed" && m.doc_id === DOC);
const httpGet = async () =>
  (await (await app.request(`/api/paper/${DOC}/annotations?coherent=1`)).json()) as {
    file: { rev: number; content_fingerprint: string; annotations: { id: string }[] };
  };
const httpPut = (file: object) =>
  app.request(`/api/paper/${DOC}/annotations`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(file),
  });

test("create_annotation goes through the page's own save: file, revision, notification and the page's GET all agree", async () => {
  script = [
    () => readCall(),
    afterRead((e) =>
      withEpoch("create_annotation", e, { target: { type: "document" }, body: "  exact bytes \n" })
    ),
    () => ({ text: "done" }),
  ];
  const { snapshot } = await run(page(null));
  const result = lastResult(seenAt(2));
  expect(result).toMatchObject({
    ok: true,
    status: "ok",
    annotation: { body: "  exact bytes \n" },
  });
  expect(result.epoch).toEqual({ fingerprint: fingerprintNow(), annotationsRev: 1 });
  const file = stored();
  expect(file.rev).toBe(1);
  expect(file.content_fingerprint).toBe(fingerprintNow());
  expect(file.annotations).toEqual([result.annotation]);
  expect(file.annotations[0].created_at).toBe(file.annotations[0].updated_at);
  expect(file.annotations[0].id).toMatch(/^a_[0-9a-f]{8}$/);
  // the page's own GET returns the same file; one `put` notification, no `invalidate`
  expect((await httpGet()).file).toEqual(file);
  expect(putEvents().map((m) => (m.type === "annotation.changed" ? m.cause : null))).toEqual([
    "put",
  ]);
  expect(existsSync(archiveDir())).toBe(false);
  expect(ops(snapshot)[1]).toMatchObject({
    tool: "reader",
    action: "create_annotation",
    status: "ok",
    object: { kind: "doc", id: DOC },
  });
});

test("a structure target takes its kind and full snapshot from the stored document, the figure's hash from the manifest", async () => {
  script = [
    () => readCall(),
    afterRead((e) =>
      withEpoch("create_annotation", e, { target: { type: "structure", id: "fig-1" }, body: "f" })
    ),
    () => ({
      call: withEpoch(
        "create_annotation",
        { fingerprint: fingerprintNow(), annotationsRev: 1 },
        { target: { type: "structure", id: "sec-1" }, body: "s" }
      ),
    }),
    () => ({ text: "done" }),
  ];
  await run(page(null));
  const file = stored();
  expect(file.annotations).toHaveLength(2);
  const asset = readDocumentForReading(join(root, "data"), DOC).assets[0];
  expect(file.annotations[0].target).toEqual({
    type: "structure",
    id: "fig-1",
    kind: "figure",
    snapshot: { caption: "Plot.", asset_hash: asset?.sha256 },
  });
  expect(file.annotations[1].target).toEqual({
    type: "structure",
    id: "sec-1",
    kind: "section",
    snapshot: { number: "1", heading: "Introduction" },
  });
});

test("a text target is validated with the UI's rules: UTF-16 offsets, one container, atoms widened, target and quote stored", async () => {
  const m = P1.indexOf("$E=mc^2$");
  script = [
    () => readCall(),
    afterRead((e) =>
      withEpoch("create_annotation", e, {
        target: {
          type: "text",
          block: "p-1",
          container: { type: "content" },
          start: m + 3,
          end: m + 5,
          quote: P1.slice(m + 3, m + 5),
        },
        body: "about the formula",
      })
    ),
    () => ({ text: "done" }),
  ];
  await run(page(null));
  const result = lastResult(seenAt(2));
  expect(result.status).toBe("ok");
  expect(result.widened).toMatch(/whole mark/);
  expect(stored().annotations[0].target).toEqual({
    type: "text",
    block: "p-1",
    container: { type: "content" },
    start: m,
    end: m + 8,
    quote: "$E=mc^2$",
  });
});

test("targets the UI cannot make are refused and write nothing: across blocks, structure-only positions, bad ranges, a wrong quote", async () => {
  writeCurrent(fingerprintNow());
  const before = userData();
  const bad = [
    {
      type: "text",
      block: "p-1",
      container: { type: "content" },
      start: 0,
      end: 4000,
      quote: "Para",
    },
    { type: "text", block: "p-1", container: { type: "caption" }, start: 0, end: 3, quote: "Par" },
    {
      type: "text",
      block: "tab-1",
      container: { type: "caption" },
      start: 0,
      end: 3,
      quote: "Par",
    },
    {
      type: "text",
      block: "sec-1",
      container: { type: "content" },
      start: 0,
      end: 3,
      quote: "Par",
    },
    { type: "text", block: "p-1", container: { type: "content" }, start: 5, end: 5, quote: "x" },
    { type: "text", block: "p-1", container: { type: "content" }, start: 0, end: 4, quote: "Nope" },
    { type: "structure", id: "ref-1" },
    { type: "structure", id: "nope" },
  ];
  script = [
    () => readCall(),
    ...bad.map((target, i) => (context: TranscriptContext) => {
      if (i > 0) expect(lastResult(context)).toMatchObject({ ok: false, status: "invalid" });
      return {
        call: withEpoch(
          "create_annotation",
          { fingerprint: fingerprintNow(), annotationsRev: 2 },
          { target, body: "x" }
        ),
      };
    }),
    () => ({ text: "done" }),
  ];
  const { snapshot } = await run(page(null));
  expect(lastResult(seenAt(bad.length + 1))).toMatchObject({ ok: false, status: "invalid" });
  expect(userData()).toEqual(before);
  expect(putEvents()).toEqual([]);
  expect(ops(snapshot).filter((o) => o.action === "create_annotation")).toHaveLength(bad.length);
  expect(ops(snapshot).filter((o) => o.status === "invalid")).toHaveLength(bad.length);
});

test("kind, snapshot, colour or any other field a UI creation could not set is not accepted", async () => {
  writeCurrent(fingerprintNow());
  const before = userData();
  script = [
    () => ({
      call: withEpoch(
        "create_annotation",
        { fingerprint: fingerprintNow(), annotationsRev: 2 },
        {
          target: { type: "structure", id: "p-1", kind: "paragraph", snapshot: { text: "forged" } },
          body: "b",
        }
      ),
    }),
    () => ({
      call: withEpoch(
        "create_annotation",
        { fingerprint: fingerprintNow(), annotationsRev: 2 },
        { target: { type: "document" }, body: " \n\t" }
      ),
    }),
    () => ({
      call: { action: "create_annotation", docId: DOC, target: { type: "document" }, body: "b" },
    }),
    () => ({ text: "done" }),
  ];
  await run(page(null));
  // a forged kind/snapshot never reaches the tool: the parameter schema itself refuses it
  const raw = (context: TranscriptContext) => {
    const last = context.messages.filter((m) => m.role === "toolResult").at(-1);
    const part = last?.role === "toolResult" ? last.content[0] : undefined;
    return part && part.type === "text" ? part.text : "";
  };
  expect(raw(seenAt(1))).toMatch(/validation|additional|invalid/i);
  expect(lastResult(seenAt(2))).toMatchObject({ ok: false, status: "invalid" });
  expect(lastResult(seenAt(3))).toMatchObject({ ok: false, status: "invalid" });
  expect(userData()).toEqual(before);
});

test("update_annotation changes only the body and bumps updated_at; an identical body is noop and writes nothing", async () => {
  writeCurrent(fingerprintNow(), [
    { ...NOTE, target: { type: "document" }, body: "old", id: "a_0000aaaa" },
  ]);
  const before = userData();
  script = [
    () => readCall(),
    // identical bytes first: noop, nothing written, no notification
    afterRead((e) =>
      withEpoch("update_annotation", e, {
        annotationId: "a_0000aaaa",
        expectedUpdatedAt: NOTE.updated_at,
        body: NOTE_BODY_OLD,
      })
    ),
    (context) => {
      expect(lastResult(context)).toMatchObject({ ok: true, status: "noop" });
      expect(userData()).toEqual(before);
      expect(putEvents()).toEqual([]);
      return {
        call: withEpoch(
          "update_annotation",
          { fingerprint: fingerprintNow(), annotationsRev: 2 },
          { annotationId: "a_0000aaaa", expectedUpdatedAt: NOTE.updated_at, body: "new body \n" }
        ),
      };
    },
    () => ({ text: "done" }),
  ];
  await run(page(null));
  const result = lastResult(seenAt(3));
  expect(result).toMatchObject({ ok: true, status: "ok" });
  const file = stored();
  expect(file.rev).toBe(3);
  expect(file.annotations[0]).toMatchObject({
    id: "a_0000aaaa",
    target: { type: "document" },
    body: "new body \n",
    created_at: NOTE.created_at,
  });
  expect(file.annotations[0].updated_at).not.toBe(NOTE.updated_at);
  expect(putEvents()).toHaveLength(1);
});
const NOTE_BODY_OLD = "old";

test("delete_annotation removes exactly one annotation at once, with no confirmation; an unknown id is not_found and writes nothing", async () => {
  writeCurrent(fingerprintNow(), [NOTE, { ...NOTE, id: "a_0000bbbb", body: "keep me" }]);
  script = [
    () => readCall(),
    afterRead((e) =>
      withEpoch("delete_annotation", e, {
        annotationId: "a_0000bbbb",
        expectedUpdatedAt: NOTE.updated_at,
      })
    ),
    (context) => ({
      call: withEpoch(
        "delete_annotation",
        { fingerprint: fingerprintNow(), annotationsRev: lastResult(context).epoch.annotationsRev },
        { annotationId: "a_0000bbbb", expectedUpdatedAt: NOTE.updated_at }
      ),
    }),
    () => ({ text: "done" }),
  ];
  const { snapshot } = await run(page(null));
  expect(lastResult(seenAt(2))).toMatchObject({ ok: true, status: "ok", deleted: "a_0000bbbb" });
  expect(lastResult(seenAt(3))).toMatchObject({ ok: false, status: "not_found" });
  expect(stored().annotations.map((a: { id: string }) => a.id)).toEqual(["a_0000aaaa"]);
  expect(stored().rev).toBe(3);
  expect(snapshot.messages.flatMap((m) => m.operations ?? []).map((o) => o.status)).not.toContain(
    "confirmation_required"
  );
  expect(putEvents()).toHaveLength(1);
});

test("a write planned against an older revision is refused: the user's annotation is untouched and the retry after a reread works", async () => {
  writeCurrent(fingerprintNow(), [NOTE]);
  const userAdd = async () => {
    const file = stored();
    const res = await httpPut({
      ...file,
      annotations: [...file.annotations, { ...NOTE, id: "a_0000cccc", body: "USER ADDED" }],
    });
    expect(res.status).toBe(200);
  };
  script = [
    () => readCall(),
    async (context) => {
      await userAdd(); // the user saves in the page after the agent's reading
      return { call: afterReadCall(context) };
    },
    (context) => {
      expect(lastResult(context)).toMatchObject({
        ok: false,
        status: "conflict",
        reason: "rev_mismatch",
        current: { annotationsRev: 3 },
      });
      expect(lastResult(context).detail).toMatch(/do not resend/);
      return readCall();
    },
    afterRead((e) =>
      withEpoch("create_annotation", e, { target: { type: "document" }, body: "AGENT" })
    ),
    () => ({ text: "done" }),
  ];
  const afterReadCall = (context: TranscriptContext) =>
    withEpoch("create_annotation", epochOf(context), {
      target: { type: "document" },
      body: "AGENT",
    });
  const { snapshot } = await run(page(null));
  expect(ops(snapshot)[1]).toMatchObject({ action: "create_annotation", status: "conflict" });
  const bodies = stored().annotations.map((a: { body: string }) => a.body);
  expect(bodies).toEqual(["  my exact note bytes  ", "USER ADDED", "AGENT"]);
  expect(stored().rev).toBe(4);
});

test("a replaced document refuses the write, and the new text never receives the old reading's offsets", async () => {
  writeCurrent(fingerprintNow(), [NOTE]);
  const originalCurrent = readFileSync(currentFile());
  script = [
    () => readCall(),
    (context) => {
      // the document is replaced after the agent's reading
      writeDoc(docIr(3, "A completely different last paragraph"));
      const ir = JSON.parse(readFileSync(irFile(), "utf8"));
      ir.sections[0].blocks[0].segments[0].text = "Different first paragraph. ";
      writeFileSync(irFile(), JSON.stringify(ir));
      return {
        call: withEpoch("create_annotation", epochOf(context), {
          target: {
            type: "text",
            block: "p-1",
            container: { type: "content" },
            start: 0,
            end: 9,
            quote: "Paragraph",
          },
          body: "stale selection",
        }),
      };
    },
    () => ({ text: "done" }),
  ];
  const { snapshot } = await run(page(null));
  const result = lastResult(seenAt(2));
  expect(result).toMatchObject({ ok: false, status: "conflict", reason: "document_changed" });
  expect(result.current.fingerprint).toBe(fingerprintNow());
  expect(ops(snapshot)[1]).toMatchObject({ status: "conflict" });
  // the page's own access path archived the old epoch (the same as opening the Doc), nothing new was written
  expect(stored()).toMatchObject({
    rev: 0,
    content_fingerprint: fingerprintNow(),
    annotations: [],
  });
  const archives = readdirSync(archiveDir());
  expect(archives).toHaveLength(1);
  expect(readFileSync(join(archiveDir(), archives[0] as string))).toEqual(originalCurrent);
  expect(JSON.stringify(seen)).not.toContain('stale selection"}]'); // the body never reached the file
  expect(JSON.stringify(stored())).not.toContain("stale selection");
});

test("a Doc a job is replacing or deleting is busy: rejected, no ensure, no archive, no write", async () => {
  writeCurrent("e".repeat(64), [NOTE]); // an older epoch that a normal access would archive
  const before = userData();
  docMutations.pinWriter(DOC);
  script = [
    () => ({
      call: withEpoch(
        "create_annotation",
        { fingerprint: fingerprintNow(), annotationsRev: 0 },
        { target: { type: "document" }, body: "x" }
      ),
    }),
    () => ({ text: "x" }),
  ];
  const { snapshot } = await run(page(null));
  docMutations.unpinWriter(DOC);
  expect(lastResult(seenAt(1))).toMatchObject({ ok: false, status: "rejected" });
  expect(ops(snapshot)[0]).toMatchObject({ status: "rejected" });
  expect(userData()).toEqual(before);
  expect(existsSync(archiveDir())).toBe(false);
  expect(putEvents()).toEqual([]);
});

test("a system error is an error, never a mismatch: damaged data, a missing image and a damaged store keep every byte and archive nothing", async () => {
  const fp = fingerprintNow();
  const write = {
    call: withEpoch(
      "create_annotation",
      { fingerprint: fp, annotationsRev: 2 },
      {
        target: { type: "document" },
        body: "x",
      }
    ),
  };
  // damaged annotations store
  writeCurrent(fp);
  writeFileSync(currentFile(), "{ broken");
  let before = userData();
  script = [() => write, () => ({ text: "x" })];
  await run(page(null));
  let result = lastResult(seenAt(1));
  expect(result).toMatchObject({ ok: false, status: "error" });
  expect(result.detail).toContain("annotations");
  expect(JSON.stringify(result)).not.toContain(root);
  expect(userData()).toEqual(before);

  // an image the IR declares is missing: the document cannot be verified
  writeCurrent("e".repeat(64));
  rmSync(join(docDir(), "assets", "plot.svg"));
  before = userData();
  seen = [];
  script = [() => write, () => ({ text: "x" })];
  await run(page(null));
  result = lastResult(seenAt(1));
  expect(result).toMatchObject({ ok: false, status: "error" });
  expect(userData()).toEqual(before);
  expect(existsSync(archiveDir())).toBe(false);

  // damaged IR
  writeDoc();
  writeFileSync(irFile(), "{ not json");
  before = userData();
  seen = [];
  script = [() => write, () => ({ text: "x" })];
  await run(page(null));
  result = lastResult(seenAt(1));
  expect(result).toMatchObject({ ok: false, status: "error" });
  expect(userData()).toEqual(before);
  expect(existsSync(archiveDir())).toBe(false);
  expect(putEvents()).toEqual([]);

  // an unknown Doc is not_found and creates nothing
  seen = [];
  script = [
    () => ({
      call: { ...write.call, docId: "nope" },
    }),
    () => ({ text: "x" }),
  ];
  await run(page(null));
  expect(lastResult(seenAt(1))).toMatchObject({ ok: false, status: "not_found" });
  expect(existsSync(join(root, "data", "annotations", "nope"))).toBe(false);
});

test("a PDF Doc is unsupported and writes no sidecar", async () => {
  const published = publishPdfDoc(paths, {
    workId: W1,
    filename: "mine.pdf",
    bytes: readFileSync(new URL("./fixtures/pdf/scanned-no-text.pdf", import.meta.url)),
    pages: [{ width: 612, height: 792, rotation: 0 }],
  });
  const before = userData();
  script = [
    () => ({
      call: {
        action: "create_annotation",
        docId: published.doc_id,
        fingerprint: "a".repeat(64),
        rev: 0,
        target: { type: "document" },
        body: "x",
      },
    }),
    () => ({ text: "x" }),
  ];
  await run(page(null));
  expect(lastResult(seenAt(1))).toMatchObject({ ok: false, status: "unsupported" });
  expect(userData()).toEqual(before);
});

test("the first annotation of a Doc with no current file is saved through the same path (like the first PUT); no archive appears", async () => {
  expect(existsSync(currentFile())).toBe(false);
  script = [
    () => readCall(),
    afterRead((e) =>
      withEpoch("create_annotation", e, { target: { type: "document" }, body: "first" })
    ),
    () => ({ text: "x" }),
  ];
  await run(page(null));
  expect(stored()).toMatchObject({ rev: 1, content_fingerprint: fingerprintNow() });
  expect(existsSync(archiveDir())).toBe(false);
});

test("the archive is never read or written by a write: its bytes and listing stay as they were", async () => {
  writeCurrent(fingerprintNow());
  mkdirSync(archiveDir(), { recursive: true });
  const archived = join(archiveDir(), "20260901T000000000Z-ffffffff.json");
  writeFileSync(archived, JSON.stringify({ annotations: [{ body: "ARCHIVED-SECRET" }] }));
  const archiveBefore = readFileSync(archived);
  script = [
    () => readCall(),
    afterRead((e) =>
      withEpoch("create_annotation", e, { target: { type: "document" }, body: "n" })
    ),
    () => ({ text: "x" }),
  ];
  await run(page(null));
  expect(JSON.stringify(seen)).not.toContain("ARCHIVED-SECRET");
  expect(readdirSync(archiveDir())).toEqual(["20260901T000000000Z-ffffffff.json"]);
  expect(readFileSync(archived)).toEqual(archiveBefore);
});

test("the page's PUT and the tool are one handler: an agent write bumps the revision a page PUT is checked against, and the same structure target is built", async () => {
  script = [
    () => readCall(),
    afterRead((e) =>
      withEpoch("create_annotation", e, { target: { type: "structure", id: "p-1" }, body: "agent" })
    ),
    () => ({ text: "x" }),
  ];
  await run(page(null));
  const file = stored();
  // a page whose copy is one revision behind is refused exactly like any stale PUT
  const stale = await httpPut({ ...file, rev: file.rev - 1 });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ detail: "rev mismatch", rev: file.rev });
  const wrongEpoch = await httpPut({ ...file, content_fingerprint: "0".repeat(64) });
  expect(wrongEpoch.status).toBe(409);
  expect(await wrongEpoch.json()).toMatchObject({ detail: "document changed" });
  // the target the tool built is the one the shared builder gives the page for the same node
  const ir = JSON.parse(readFileSync(irFile(), "utf8"));
  const { blocks } = irIndex(ir);
  expect(file.annotations[0].target).toEqual(buildStructureTarget(blocks.get("p-1") as never));
  // and a page-side save on top of the agent's file works
  const ok = await httpPut({ ...file });
  expect(ok.status).toBe(200);
});

test("a write names its own Doc: a task about A writes A while the page shows B", async () => {
  writeOtherDoc();
  const otherCurrent = join(root, "data", "annotations", OTHER, "current.json");
  script = [
    () => readCall(OTHER),
    (context) => ({
      call: {
        action: "create_annotation",
        docId: OTHER,
        fingerprint: lastResult(context).reading.epoch.fingerprint,
        rev: lastResult(context).reading.epoch.annotationsRev,
        target: { type: "document" },
        body: "for the other doc",
      },
    }),
    () => ({ text: "x" }),
  ];
  await run(page()); // the page shows DOC
  expect(JSON.parse(readFileSync(otherCurrent, "utf8")).annotations[0].body).toBe(
    "for the other doc"
  );
  expect(existsSync(currentFile())).toBe(false);
});

test("the Reader page tells the model about unsaved drafts (presence only) and a write never touches them", async () => {
  script = [() => ({ text: "seen" })];
  const withDrafts = page(
    readerPage({ drafts: { create: true, edit: [{ annotationId: "a_0000aaaa", blocked: false }] } })
  );
  expect((await request(`/views/${withDrafts.viewId}`, "PUT", withDrafts)).status).toBe(200);
  const rejected = {
    ...withDrafts,
    reader: {
      ...withDrafts.reader,
      drafts: { create: true, edit: [{ annotationId: "a_x", blocked: false, body: "typed text" }] },
    },
  };
  expect((await request(`/views/${withDrafts.viewId}`, "PUT", rejected)).status).toBe(400);
  await run(withDrafts);
  expect(JSON.stringify(seenAt(0))).toContain('\\"drafts\\":{\\"create\\":true');
});

// ---- fix round 1 ------------------------------------------------------------------------------------ //
const T0 = NOTE.updated_at;
const userSaves = async (annotations: object[]) => {
  const file = stored();
  const res = await httpPut({ ...file, annotations });
  expect(res.status).toBe(200);
};
const events = () =>
  broadcasts
    .filter((m) => m.type === "annotation.changed" && m.doc_id === DOC)
    .map((m) => (m.type === "annotation.changed" ? m.cause : null));

test("F1: an update planned from an old reading never overwrites a body the user saved after it, even with the epoch numbers current again", async () => {
  writeCurrent(fingerprintNow(), [NOTE]);
  const userBody = {
    ...NOTE,
    body: "USER'S NEWER WORDS",
    updated_at: "2026-10-05T09:00:00.000Z",
  };
  let current: { annotationsRev: number; fingerprint: string };
  script = [
    () => readCall(),
    async (context) => {
      await userSaves([userBody]); // rev 2 -> 3 after the agent's reading
      return {
        call: withEpoch("update_annotation", epochOf(context), {
          annotationId: "a_0000aaaa",
          expectedUpdatedAt: T0,
          body: "agent from the old reading",
        }),
      };
    },
    (context) => {
      const r = lastResult(context);
      expect(r).toMatchObject({ status: "conflict", reason: "rev_mismatch" });
      current = r.current;
      // the agent resends with the NEW epoch numbers but its OLD expectation of the annotation
      return {
        call: withEpoch("update_annotation", current, {
          annotationId: "a_0000aaaa",
          expectedUpdatedAt: T0,
          body: "agent from the old reading",
        }),
      };
    },
    (context) => {
      expect(lastResult(context)).toMatchObject({
        ok: false,
        status: "conflict",
        reason: "annotation_changed",
        annotation: { body: "USER'S NEWER WORDS", updated_at: userBody.updated_at },
      });
      // the same for a delete
      return {
        call: withEpoch("delete_annotation", current, {
          annotationId: "a_0000aaaa",
          expectedUpdatedAt: T0,
        }),
      };
    },
    (context) => {
      expect(lastResult(context)).toMatchObject({
        status: "conflict",
        reason: "annotation_changed",
      });
      expect(stored().annotations[0].body).toBe("USER'S NEWER WORDS");
      // after reading what the user wrote the agent may decide again
      return {
        call: withEpoch("update_annotation", current, {
          annotationId: "a_0000aaaa",
          expectedUpdatedAt: userBody.updated_at,
          body: "agent, having read the user's words",
        }),
      };
    },
    () => ({ text: "done" }),
  ];
  const { snapshot } = await run(page(null));
  expect(lastResult(seenAt(5))).toMatchObject({ ok: true, status: "ok" });
  expect(stored().annotations[0].body).toBe("agent, having read the user's words");
  expect(ops(snapshot).map((o) => o.status)).toEqual([
    "ok",
    "conflict",
    "conflict",
    "conflict",
    "ok",
  ]);
});

test("F1: offsets resent after the document changed cannot anchor to different text: the quote must still match", async () => {
  writeCurrent(fingerprintNow(), [NOTE]);
  const target = {
    type: "text",
    block: "p-1",
    container: { type: "content" },
    start: 0,
    end: 9,
    quote: "Paragraph",
  };
  script = [
    () => readCall(),
    (context) => {
      // the document is replaced after the reading; the first words of p-1 are different now
      const ir = JSON.parse(readFileSync(irFile(), "utf8"));
      ir.sections[0].blocks[0].segments[0].text = "Different words here. ";
      writeFileSync(irFile(), JSON.stringify(ir));
      return { call: withEpoch("create_annotation", epochOf(context), { target, body: "x" }) };
    },
    (context) => {
      const r = lastResult(context);
      expect(r).toMatchObject({ status: "conflict", reason: "document_changed" });
      // resend the same offsets with the new epoch (what a careless retry does)
      return {
        call: withEpoch(
          "create_annotation",
          { fingerprint: r.current.fingerprint, annotationsRev: r.current.annotationsRev },
          { target, body: "x" }
        ),
      };
    },
    () => ({ text: "done" }),
  ];
  await run(page(null));
  const r = lastResult(seenAt(3));
  expect(r).toMatchObject({ ok: false, status: "invalid" });
  expect(r.detail).toMatch(/quote/);
  expect(stored().annotations).toEqual([]);
  // a text target without any quote is not even a valid request
  seen = [];
  script = [
    () => ({
      call: withEpoch(
        "create_annotation",
        { fingerprint: fingerprintNow(), annotationsRev: 0 },
        {
          target: { ...target, quote: undefined },
          body: "x",
        }
      ),
    }),
    () => ({ text: "x" }),
  ];
  await run(page(null));
  expect(lastResult(seenAt(1))).toMatchObject({ ok: false, status: "invalid" });
});

test("F2: keys this application does not know survive an agent create, update and delete, and the saved file still passes the schema", async () => {
  writeCurrent(fingerprintNow(), [
    { ...NOTE, x_ann: "keep-1", target: { type: "document", x_t: 1 } },
    { ...NOTE, id: "a_0000bbbb", body: "second", x_ann: "keep-2" },
  ]);
  const raw = JSON.parse(readFileSync(currentFile(), "utf8"));
  writeFileSync(currentFile(), JSON.stringify({ ...raw, x_top: { nested: [1, 2] } }, null, 2));
  script = [
    () => readCall(),
    afterRead((e) =>
      withEpoch("create_annotation", e, { target: { type: "document" }, body: "new" })
    ),
    (context) => ({
      call: withEpoch("update_annotation", lastResult(context).epoch, {
        annotationId: "a_0000aaaa",
        expectedUpdatedAt: T0,
        body: "changed",
      }),
    }),
    (context) => ({
      call: withEpoch("delete_annotation", lastResult(context).epoch, {
        annotationId: "a_0000bbbb",
        expectedUpdatedAt: T0,
      }),
    }),
    () => ({ text: "done" }),
  ];
  await run(page(null));
  const file = stored();
  expect(file.x_top).toEqual({ nested: [1, 2] });
  expect(file.annotations[0]).toMatchObject({
    id: "a_0000aaaa",
    body: "changed",
    x_ann: "keep-1",
    target: { type: "document", x_t: 1 },
    created_at: T0,
  });
  expect(file.annotations.map((a: { id: string }) => a.id)).toHaveLength(2);
  expect(file.annotations.some((a: { x_ann?: string }) => a.x_ann === "keep-2")).toBe(false); // the deleted one is gone
  // schema gate and the page's own GET accept the bytes
  expect((await httpGet()).file.annotations).toHaveLength(2);
  expect(file.rev).toBe(5);
});

test("F3: the annotations of older text that cannot be archived stay byte for byte; the error says so, nothing is announced", async () => {
  writeCurrent("e".repeat(64), [NOTE]);
  mkdirSync(join(root, "data", "annotations", DOC), { recursive: true });
  writeFileSync(archiveDir(), "not a directory"); // the archive cannot be created
  const before = userData();
  script = [
    () => ({
      call: withEpoch(
        "create_annotation",
        { fingerprint: fingerprintNow(), annotationsRev: 0 },
        {
          target: { type: "document" },
          body: "x",
        }
      ),
    }),
    () => ({ text: "x" }),
  ];
  const { snapshot } = await run(page(null));
  const r = lastResult(seenAt(1));
  expect(r).toMatchObject({ ok: false, status: "error" });
  expect(r.detail).toMatch(/archive/);
  expect(r.detail).toMatch(/left exactly as they were/);
  expect(r.archivedOlder).toBeUndefined();
  expect(r.detail).not.toMatch(/image/);
  expect(userData()).toEqual(before);
  expect(events()).toEqual([]);
  expect(ops(snapshot)[0]).toMatchObject({ status: "error" });
});

test("F3: archived but the new current could not be created: the error says so; the archive is the old bytes, nothing of the request is written, no put", async () => {
  writeCurrent("e".repeat(64), [NOTE]);
  const oldBytes = readFileSync(currentFile());
  mkdirSync(join(root, "data", "annotations", DOC, "current.json.tmp"), { recursive: true });
  script = [
    () => ({
      call: withEpoch(
        "create_annotation",
        { fingerprint: fingerprintNow(), annotationsRev: 0 },
        {
          target: { type: "document" },
          body: "x",
        }
      ),
    }),
    () => ({ text: "x" }),
  ];
  await run(page(null));
  const r = lastResult(seenAt(1));
  expect(r).toMatchObject({ ok: false, status: "error", archivedOlder: true });
  expect(r.detail).toMatch(/were archived/);
  expect(r.detail).toMatch(/new, empty annotations file could not be created/);
  const archives = readdirSync(archiveDir());
  expect(archives).toHaveLength(1);
  expect(readFileSync(join(archiveDir(), archives[0] as string))).toEqual(oldBytes);
  expect(readFileSync(currentFile())).toEqual(oldBytes); // the old current is still what is on disk
  expect(JSON.stringify(stored())).not.toContain('"x"');
  expect(events()).toEqual([]); // no put and no invalidate: the new current never existed
});

test("F3: a corrupt PDF metadata file is a metadata error, not a mismatch or a silent success", async () => {
  const dir = join(root, "data", "output", "bad-pdf");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "original.pdf"), "%PDF-broken"); // a PDF marker without its metadata
  const before = userData();
  script = [
    () => ({
      call: {
        action: "create_annotation",
        docId: "bad-pdf",
        fingerprint: "a".repeat(64),
        rev: 0,
        target: { type: "document" },
        body: "x",
      },
    }),
    () => ({ text: "x" }),
  ];
  await run(page(null));
  const r = lastResult(seenAt(1));
  expect(r).toMatchObject({ ok: false, status: "error" });
  expect(r.detail).toBe("the Doc's metadata could not be read; nothing was changed");
  expect(userData()).toEqual(before);
});

test("F4: a write that finds the text replaced archives the older batch once, says so, and announces invalidate before put", async () => {
  writeCurrent("e".repeat(64), [NOTE, { ...NOTE, id: "a_0000bbbb" }]);
  const oldBytes = readFileSync(currentFile());
  script = [
    () => readCall(), // the reading of stale annotations is empty and bound to the current text
    afterRead((e) =>
      withEpoch("create_annotation", e, { target: { type: "document" }, body: "fresh" })
    ),
    () => ({ text: "done" }),
  ];
  await run(page(null));
  const r = lastResult(seenAt(2));
  expect(r).toMatchObject({ ok: true, status: "ok", archivedOlder: 2 });
  expect(r.archivedNote).toMatch(/tell the user/);
  const archives = readdirSync(archiveDir());
  expect(archives).toHaveLength(1);
  expect(readFileSync(join(archiveDir(), archives[0] as string))).toEqual(oldBytes);
  expect(events()).toEqual(["invalidate", "put"]);
  expect(stored()).toMatchObject({ rev: 1 });
});

test("F5: duplicate ids behave as the page does: delete removes every match, update changes every match, a same first body is noop", async () => {
  writeCurrent(fingerprintNow(), [
    { ...NOTE, body: "dup" },
    { ...NOTE, id: "a_0000bbbb", body: "other" },
    { ...NOTE, body: "dup-second" },
  ]);
  script = [
    () => readCall(),
    afterRead((e) =>
      withEpoch("update_annotation", e, {
        annotationId: "a_0000aaaa",
        expectedUpdatedAt: T0,
        body: "dup",
      })
    ),
    (context) => {
      expect(lastResult(context)).toMatchObject({ status: "noop" });
      return {
        call: withEpoch("update_annotation", lastResult(context).epoch, {
          annotationId: "a_0000aaaa",
          expectedUpdatedAt: T0,
          body: "both changed",
        }),
      };
    },
    (context) => {
      expect(lastResult(context).status).toBe("ok");
      expect(stored().annotations.map((a: { body: string }) => a.body)).toEqual([
        "both changed",
        "other",
        "both changed",
      ]);
      return {
        call: withEpoch("delete_annotation", lastResult(context).epoch, {
          annotationId: "a_0000aaaa",
          expectedUpdatedAt: stored().annotations[0].updated_at,
        }),
      };
    },
    () => ({ text: "done" }),
  ];
  await run(page(null));
  expect(stored().annotations.map((a: { id: string }) => a.id)).toEqual(["a_0000bbbb"]);
});

test("F6: the operation record carries the Doc title, what was annotated and the resulting revision", async () => {
  script = [
    () => readCall(),
    afterRead((e) =>
      withEpoch("create_annotation", e, {
        target: {
          type: "text",
          block: "p-1",
          container: { type: "content" },
          start: 0,
          end: 9,
          quote: "Paragraph",
        },
        body: "x",
      })
    ),
    () => ({ text: "done" }),
  ];
  const { snapshot } = await run(page(null));
  expect(ops(snapshot)[1]).toMatchObject({
    action: "create_annotation",
    status: "ok",
    rev: 1,
    label: "A Synthetic Reader Paper · “Paragraph”",
  });
});
