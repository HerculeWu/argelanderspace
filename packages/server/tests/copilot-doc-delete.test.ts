/**
 * Copilot `library` tool `delete_doc` (copilot ticket 16) end to end on the real seam: real Pi session, real HTTP
 * routes, real DocMutationRegistry / JobRunner / library lock / disk / annotations access path, real /ws sockets as
 * browser tabs. Only the model provider is scripted. A delete waits for the real user's card; chat never approves.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Annotation,
  type AnnotationsFile,
  type ConversationSnapshot,
  type CopilotConfirmation,
  type LibraryPage,
  type PageContext,
  summarizeLibraryRef,
  type WsServerMessage,
} from "@argelanderspace/contracts";
import type { MetadataSources } from "@argelanderspace/core";
import { libraryPaths, plansPath, publishPdfDoc, uploadDocId } from "@argelanderspace/core";
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
import { createLibraryTool } from "../src/copilot-library-tool.js";
import { DocMutationRegistry } from "../src/doc-mutations.js";
import { JobRunner } from "../src/jobs.js";
import { ProviderSettings } from "../src/providers.js";
import { WsHub } from "../src/ws.js";
import { makeZip, stubPipelines, stubSources } from "./helpers.js";

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
let runner: JobRunner;
let docMutations: DocMutationRegistry;
let pipelines: ReturnType<typeof stubPipelines>;
let statusDir: string;
let sourcesFactory: () => MetadataSources;
const PDF_FIXTURE = new URL("./fixtures/pdf/scanned-no-text.pdf", import.meta.url);
const choice = { provider: "openai", model: "gpt-4.1", thinking: null };

const W_MULTI1 = "doi:10.1000/multi1";
const W_MULTI2 = "doi:10.1000/multi2";
const W_SOLO = "doi:10.1000/solo";
const W_PDF = "arxiv:2603.00105";
const W_NONE = "doi:10.1000/none";
const SHARED = "arxiv-2603.00101";
const OWN1 = "arxiv-2603.00102";
const OWN2 = "arxiv-2603.00103";
const SOLO = "arxiv-2603.00104";
const UPLOAD_DOC = uploadDocId(W_SOLO);
let pdfDocId = "";
const work = (id: string, extra: object = {}) => ({
  id,
  title: `Work ${id}`,
  authors: ["Author"],
  year: 2026,
  venue: "arXiv",
  type: "article",
  doi: id.startsWith("doi:") ? id.slice(4) : undefined,
  arxiv_id: id.startsWith("arxiv:") ? id.slice(6) : undefined,
  cite_key: id.replace(/[^a-z0-9]/gi, ""),
  doc_ids: [],
  ...extra,
});
const seedFile = () => ({
  version: 1,
  project: { name: "Synthetic", short: "S", field: "", x_project: "keep" },
  x_top: { nested: [1] },
  works: [
    work(W_MULTI1, { doc_ids: [SHARED, OWN1], x_work: "keep-1", note: "Private note", read: true }),
    work(W_MULTI2, { doc_ids: [OWN2, SHARED], x_work: "keep-2" }),
    work(W_SOLO, { doc_ids: [SOLO, UPLOAD_DOC], x_work: "keep-3" }),
    work(W_PDF, { x_work: "keep-4" }),
    work(W_NONE, { x_work: "keep-5" }),
  ],
});
const docIr = (docId: string, text = "Hello world") => ({
  version: 1,
  docId,
  sections: [
    {
      id: "sec-1",
      level: 1,
      number: "1",
      heading: "Introduction",
      blocks: [{ id: "p-1", type: "paragraph", segments: [{ type: "text", text }] }],
      children: [],
    },
  ],
  refsManifest: [],
  bib: [],
  citationsByBlock: {},
  source: { type: "latex", origin: "/tmp/src", main_tex: "main.tex" },
  meta: { title: `Doc ${docId}` },
});
const irPath = (docId: string) => join(paths.outputDir, docId, `${docId}.json`);
function writeDoc(docId: string, text?: string) {
  mkdirSync(join(paths.outputDir, docId), { recursive: true });
  writeFileSync(irPath(docId), JSON.stringify(docIr(docId, text)));
}
const writeLibrary = (file: object = seedFile()) =>
  writeFileSync(paths.libraryJson, JSON.stringify(file, null, 2));
const bytes = () => readFileSync(paths.libraryJson, "utf8");
const disk = () => JSON.parse(bytes());
const workOnDisk = (id: string) =>
  disk().works.find((w: { id: string }) => w.id === id) as Record<string, unknown>;
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
const patchRef = (id: string, doc_id: string) =>
  app.request("/api/library/refs", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, doc_id }),
  });
const BIB_SENTINEL = "% sentinel bib, doc_ids are not part of the BibTeX projection\n";

beforeEach(async () => {
  originalEnv = process.env;
  root = mkdtempSync(join(tmpdir(), "copilot-doc-delete-"));
  process.env = { PATH: originalEnv.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "config") };
  vi.stubGlobal("fetch", () => {
    throw new Error("unexpected external fetch");
  });
  statusDir = join(root, "status");
  mkdirSync(statusDir, { recursive: true });
  writeFileSync(plansPath(statusDir), JSON.stringify({ version: 1, rev: 1, plans: [] }, null, 2));
  paths = libraryPaths(join(root, "data"));
  mkdirSync(paths.libraryDir, { recursive: true });
  writeLibrary();
  for (const docId of [SHARED, OWN1, OWN2, SOLO, UPLOAD_DOC]) writeDoc(docId);
  const published = publishPdfDoc(paths, {
    workId: W_PDF,
    filename: "mine.pdf",
    bytes: readFileSync(PDF_FIXTURE),
    pages: [{ width: 612, height: 792, rotation: 0 }],
  });
  pdfDocId = published.doc_id;
  writeFileSync(paths.libraryBib, BIB_SENTINEL);
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
  sourcesFactory = () => stubSources();
  pipelines = stubPipelines();
  runner = new JobRunner({ dir: join(root, "jobs") });
  docMutations = new DocMutationRegistry();
  host = new CopilotHost(join(root, "data"), settings, () => {});
  makeApp();
});
function makeApp() {
  app = createApp({
    paths,
    statusDir,
    makeSources: () => sourcesFactory(),
    pipelines,
    fetchArxivPdf: async () => readFileSync(PDF_FIXTURE),
    autoIngestArxiv: () => false,
    runner,
    docMutations,
    providerSettings: settings,
    copilot: host,
    broadcast: (message) => broadcasts.push(message),
  });
}

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
async function openTab(viewId: string, conversationId: string, actions: Record<string, unknown>[]) {
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
      ok: true,
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
function libraryPage(): LibraryPage {
  const works = seedFile().works.map((w) => ({
    id: w.id,
    title: w.title,
    authors: "Author",
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
  };
}
const page = (viewId = randomUUID()): PageContext => ({
  version: 1,
  viewId,
  revision: 1,
  paneId: 1,
  view: "library",
  status: "complete",
  otherPanes: [],
  plan: null,
  library: libraryPage(),
});
async function start(
  context: PageContext,
  tab?: Record<string, unknown>[],
  text = "Delete that doc"
) {
  const created = (await (
    await request("/conversations", "POST", { model: choice })
  ).json()) as ConversationSnapshot;
  const id = created.conversation.id;
  if (tab) await openTab(context.viewId, id, tab);
  expect((await request(`/views/${context.viewId}`, "PUT", context)).status).toBe(200);
  const sent = await request(`/conversations/${id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text,
    viewId: context.viewId,
    contextRevision: context.revision,
  });
  expect(sent.status).toBe(202);
  return id;
}
const settled = (id: string, wanted = ["completed", "stopped", "failed"]) =>
  vi.waitFor(
    async () => expect(wanted).toContain((await host.snapshot(id)).conversation.run?.status),
    { timeout: 10000 }
  );
const ops = (snapshot: ConversationSnapshot) =>
  snapshot.messages.flatMap((m) => m.operations ?? []);
const changed = () => broadcasts.filter((m) => m.type === "library.changed");
const del = (docId: string, extra: Record<string, unknown> = {}): Out => ({
  call: { action: "delete_doc", docId, ...extra },
});
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
const answerCard = (
  confirmation: CopilotConfirmation,
  viewId: string,
  decision: "approve" | "decline"
) =>
  request(`/confirmations/${confirmation.id}`, "POST", {
    decision,
    viewId,
    action: confirmation.action,
    objectId: confirmation.object.id,
    baseRev: confirmation.baseRev,
  });
const annotation = (n: number): Annotation => ({
  id: `a_0123abc${n}`,
  target: {
    type: "text",
    block: "p-1",
    container: { type: "content" },
    start: 0,
    end: 5,
    quote: "Hello",
  },
  body: `note ${n}`,
  created_at: "2026-09-10T10:00:00.000Z",
  updated_at: "2026-09-10T10:00:00.000Z",
});
async function annotate(docId: string, count: number) {
  const url = `/api/paper/${docId}/annotations`;
  const current = (await (await app.request(url)).json()) as AnnotationsFile;
  const res = await app.request(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      version: 1,
      rev: current.rev,
      content_fingerprint: current.content_fingerprint,
      annotations: Array.from({ length: count }, (_, i) => annotation(i + 1)),
    }),
  });
  expect(res.status).toBe(200);
}
const annotationDir = (docId: string) => join(paths.dataDir, "annotations", docId);
/** A snapshot of the Doc's annotation files: current bytes + archive listing. */
const annotationFiles = (docId: string) => ({
  current: existsSync(join(annotationDir(docId), "current.json"))
    ? readFileSync(join(annotationDir(docId), "current.json"), "utf8")
    : null,
  archive: existsSync(join(annotationDir(docId), "archive"))
    ? readdirSync(join(annotationDir(docId), "archive"))
    : [],
});
function seedArchive(docId: string) {
  mkdirSync(join(annotationDir(docId), "archive"), { recursive: true });
  writeFileSync(join(annotationDir(docId), "archive", "20260901T000000000Z-eeeeeeee.json"), "{}");
}
const keptUnknownKeys = () => {
  const after = disk();
  const seeded = seedFile();
  expect(after.x_top).toEqual(seeded.x_top);
  expect(after.project).toEqual(seeded.project);
  for (const w of seeded.works)
    expect(workOnDisk(w.id).x_work, w.id).toEqual((w as Record<string, unknown>).x_work);
  expect(workOnDisk(W_MULTI1).note).toBe("Private note");
};
const everyOtherByteOfTheDoc = (docId: string) => ({
  dir: existsSync(join(paths.outputDir, docId)),
  annotations: existsSync(annotationDir(docId)),
});

// ---- the card, the click and the delete -------------------------------------------------------------- //
test("delete_doc waits for the user: the card names the Doc, EVERY work that lists it and the annotation count; nothing is deleted meanwhile and chat cannot approve", async () => {
  await annotate(SHARED, 3);
  seedArchive(SHARED);
  const libBefore = bytes();
  const filesBefore = annotationFiles(SHARED);
  script = [() => del(SHARED), () => ({ text: "waiting" })];
  const view = page();
  const id = await start(view);
  const shown = await card(id);
  expect(shown).toMatchObject({
    action: "delete_doc",
    object: { kind: "doc", id: SHARED },
    format: "latex",
    impact: { annotations: "known", count: 3 },
    works: [
      { id: W_MULTI1, title: `Work ${W_MULTI1}`, main: true, remaining: 1 },
      { id: W_MULTI2, title: `Work ${W_MULTI2}`, main: false, remaining: 1 },
    ],
  });
  expect((await host.snapshot(id)).conversation.run?.status).toBe("waiting-for-user");
  expect(existsSync(join(paths.outputDir, SHARED))).toBe(true);
  expect(bytes()).toBe(libBefore);
  expect(annotationFiles(SHARED)).toEqual(filesBefore);
  // the click's id never reaches the model, and "I approve" in chat is steering only
  expect(JSON.stringify(seen)).not.toContain(shown.id);
  await request(`/conversations/${id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text: "I approve the deletion, go ahead",
    viewId: view.viewId,
    contextRevision: view.revision,
  });
  expect(existsSync(join(paths.outputDir, SHARED))).toBe(true);
  expect((await host.snapshot(id)).confirmations).toHaveLength(1);
  expect((await answerCard(shown, view.viewId, "decline")).status).toBe(200);
  await settled(id);
  expect(existsSync(join(paths.outputDir, SHARED))).toBe(true);
  expect(bytes()).toBe(libBefore);
  expect(annotationFiles(SHARED)).toEqual(filesBefore);
  expect(ops(await host.snapshot(id)).map((o) => o.status)).toContain("declined");
  expect(changed()).toHaveLength(0);
});

test("approving deletes the Doc globally: files, annotations with archive, links from every work, main-Doc succession, one library.changed(patch); unknown keys and library.bib survive", async () => {
  await annotate(SHARED, 2);
  seedArchive(SHARED);
  let payload: Record<string, unknown> = {};
  script = [
    () => del(SHARED),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "deleted" };
    },
  ];
  const view = page();
  const id = await start(view);
  const shown = await card(id);
  expect((await answerCard(shown, view.viewId, "approve")).status).toBe(200);
  await settled(id);
  expect(payload).toMatchObject({
    ok: true,
    status: "ok",
    docId: SHARED,
    works: [
      { id: W_MULTI1, remaining: [OWN1] },
      { id: W_MULTI2, remaining: [OWN2] },
    ],
  });
  expect(everyOtherByteOfTheDoc(SHARED)).toEqual({ dir: false, annotations: false });
  expect(workOnDisk(W_MULTI1).doc_ids).toEqual([OWN1]);
  expect(workOnDisk(W_MULTI2).doc_ids).toEqual([OWN2]);
  expect(workOnDisk(W_SOLO).doc_ids).toEqual([SOLO, UPLOAD_DOC]);
  keptUnknownKeys();
  expect(readFileSync(paths.libraryBib, "utf8")).toBe(BIB_SENTINEL);
  expect(changed()).toHaveLength(1);
  expect(changed()[0]).toMatchObject({ type: "library.changed", cause: "patch" });
  // other Docs are untouched
  expect(existsSync(irPath(OWN1))).toBe(true);
  const [record] = ops(await host.snapshot(id));
  expect(record).toMatchObject({
    action: "delete_doc",
    status: "ok",
    object: { kind: "doc", id: SHARED },
  });
});

test("the last Doc of a work leaves it without a main Doc, and the bound view is told the page's three-state update with the keeper's remaining Docs", async () => {
  const actions: Record<string, unknown>[] = [];
  script = [() => del(SOLO), () => ({ text: "done" })];
  const view = page();
  const id = await start(view, actions);
  const shown = await card(id);
  expect(shown).toMatchObject({ works: [{ id: W_SOLO, main: true, remaining: 1 }] });
  await answerCard(shown, view.viewId, "approve");
  await settled(id);
  expect(workOnDisk(W_SOLO).doc_ids).toEqual([UPLOAD_DOC]);
  await vi.waitFor(() =>
    expect(actions).toContainEqual({ action: "doc_deleted", docId: SOLO, remaining: [UPLOAD_DOC] })
  );
  // a Doc whose Work keeps nothing: remaining is empty (the Shell then shows no Doc)
  actions.length = 0;
  script = [() => del(UPLOAD_DOC), () => ({ text: "done" })];
  seen = [];
  const second = await start(view, actions);
  await answerCard(await card(second), view.viewId, "approve");
  await settled(second);
  expect(workOnDisk(W_SOLO).doc_ids).toEqual([]);
  await vi.waitFor(() =>
    expect(actions).toContainEqual({ action: "doc_deleted", docId: UPLOAD_DOC, remaining: [] })
  );
});

test("the model cannot call the shell sync itself: doc_deleted is not a tool action", async () => {
  let raw = "";
  script = [
    () => ({ call: { action: "doc_deleted", docId: SOLO, remaining: [] } }),
    (ctx) => {
      const last = ctx.messages.filter((m) => m.role === "toolResult").at(-1);
      raw = last?.role === "toolResult" ? JSON.stringify(last.content) : "";
      return { text: "done" };
    },
  ];
  const id = await start(page());
  await settled(id);
  expect(raw).toContain("action");
  expect(ops(await host.snapshot(id)).every((o) => o.status !== "ok")).toBe(true);
  expect(existsSync(irPath(SOLO))).toBe(true);
});

test("a PDF Doc: the card says pdf with the sidecar count; approving removes the original, metadata and sidecars and the work", async () => {
  const snapshot = (await (await app.request(`/api/paper/${pdfDocId}/pdf/snapshot`)).json()) as {
    annotations: Record<string, unknown>;
  };
  const at = "2026-09-24T12:00:00.000Z";
  const put = await app.request(`/api/paper/${pdfDocId}/pdf/annotations`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...snapshot.annotations,
      annotations: [
        {
          id: "doc-1",
          kind: "document_comment",
          body: "Document note",
          created_at: at,
          updated_at: at,
        },
      ],
    }),
  });
  expect(put.status).toBe(200);
  const dir = join(paths.outputDir, pdfDocId);
  expect(readdirSync(dir).sort()).toEqual(
    ["annotations.json", `${pdfDocId}.json`, "original.pdf", "reading-position.json"].sort()
  );
  script = [() => del(pdfDocId), () => ({ text: "done" })];
  const view = page();
  const id = await start(view);
  const shown = await card(id);
  expect(shown).toMatchObject({
    format: "pdf",
    impact: { annotations: "known", count: 1 },
    works: [{ id: W_PDF, main: true, remaining: 0 }],
  });
  await answerCard(shown, view.viewId, "approve");
  await settled(id);
  expect(existsSync(dir)).toBe(false);
  expect(workOnDisk(W_PDF).doc_ids).toEqual([]);
  keptUnknownKeys();
});

// ---- counts: read-only, unknown is not zero ---------------------------------------------------------- //
test("the count is read without ensure: a Doc whose text changed shows 0 and its annotation files are left exactly as they were (nothing archived)", async () => {
  await annotate(SHARED, 2);
  const filesBefore = annotationFiles(SHARED);
  writeDoc(SHARED, "A different text, so the stored fingerprint no longer matches");
  script = [() => del(SHARED), () => ({ text: "waiting" })];
  const view = page();
  const id = await start(view);
  const shown = await card(id);
  expect(shown).toMatchObject({ impact: { annotations: "known", count: 0 } });
  expect(annotationFiles(SHARED)).toEqual(filesBefore);
  // library / annotation notifications revalidate the pending card; that read does not archive either
  expect((await patchRef(W_MULTI2, SHARED)).status).toBe(200);
  await vi.waitFor(async () => expect((await host.snapshot(id)).confirmations).toHaveLength(0));
  expect(annotationFiles(SHARED)).toEqual(filesBefore);
});

test("an annotations file that cannot be read shows an unknown count, never zero, and the delete is still the user's call", async () => {
  await annotate(SHARED, 1);
  writeFileSync(join(annotationDir(SHARED), "current.json"), "{ broken");
  script = [() => del(SHARED), () => ({ text: "done" })];
  const view = page();
  const id = await start(view);
  const shown = await card(id);
  expect(shown).toMatchObject({ impact: { annotations: "unknown" } });
  await answerCard(shown, view.viewId, "approve");
  await settled(id);
  expect(existsSync(join(paths.outputDir, SHARED))).toBe(false);
  expect(existsSync(annotationDir(SHARED))).toBe(false);
});

// ---- stale, Stop, restart ---------------------------------------------------------------------------- //
test("an annotation added, a work's Docs changed or the Doc itself changed while the card waits ends it: the click is refused and nothing is deleted", async () => {
  const answers: Record<string, unknown>[] = [];
  script = [
    () => del(SHARED),
    (ctx) => {
      answers.push(lastResult(ctx));
      return del(SHARED);
    },
    (ctx) => {
      answers.push(lastResult(ctx));
      return { text: "done" };
    },
  ];
  const view = page();
  const id = await start(view);
  const first = await card(id);
  await annotate(SHARED, 1); // annotation.changed revalidates the card
  await vi.waitFor(async () =>
    expect((await host.snapshot(id)).confirmations[0]?.id).not.toBe(first.id)
  );
  expect((await answerCard(first, view.viewId, "approve")).status).toBeGreaterThanOrEqual(404);
  const second = await card(id);
  expect(second.id).not.toBe(first.id);
  expect(second).toMatchObject({ impact: { annotations: "known", count: 1 } });
  // the user sets another main Doc on a work that lists it: the card is bound to the works' Doc lists
  expect((await patchRef(W_MULTI1, OWN1)).status).toBe(200);
  await vi.waitFor(async () => expect((await host.snapshot(id)).confirmations).toHaveLength(0));
  expect((await answerCard(second, view.viewId, "approve")).status).toBeGreaterThanOrEqual(404);
  await settled(id);
  expect(answers[0]).toMatchObject({ ok: false, status: "expired" });
  expect(existsSync(join(paths.outputDir, SHARED))).toBe(true);
  expect(workOnDisk(W_MULTI1).doc_ids).toEqual([OWN1, SHARED]);
});

test("the Doc becoming busy after the card was shown refuses the click: nothing is deleted", async () => {
  script = [() => del(SHARED), () => ({ text: "done" })];
  const view = page();
  const id = await start(view);
  const shown = await card(id);
  docMutations.pinWriter(SHARED); // an upload/refresh job started writing it
  expect((await answerCard(shown, view.viewId, "approve")).status).toBe(409);
  await settled(id);
  expect(existsSync(join(paths.outputDir, SHARED))).toBe(true);
  expect(workOnDisk(W_MULTI1).doc_ids).toEqual([SHARED, OWN1]);
  docMutations.unpinWriter(SHARED);
});

test("Stop while the card waits withdraws it; a restart revives no approval; nothing is deleted", async () => {
  script = [() => del(SHARED), () => ({ text: "must not run" })];
  const view = page();
  const id = await start(view);
  const shown = await card(id);
  const libBefore = bytes();
  expect((await request(`/conversations/${id}/stop`, "POST")).status).toBe(200);
  await settled(id);
  expect(existsSync(join(paths.outputDir, SHARED))).toBe(true);
  expect(bytes()).toBe(libBefore);
  host = new CopilotHost(join(root, "data"), settings, () => {});
  makeApp();
  expect((await host.snapshot(id)).confirmations).toEqual([]);
  expect((await request(`/views/${view.viewId}`, "PUT", view)).status).toBe(200);
  expect((await answerCard(shown, view.viewId, "approve")).status).toBe(404);
  expect(existsSync(join(paths.outputDir, SHARED))).toBe(true);
  expect(bytes()).toBe(libBefore);
});

test("a restart revives no authorization: the record says expired and the resume note says nothing was deleted", async () => {
  script = [() => del(SHARED), () => ({ text: "after restart" })];
  const view = page();
  const id = await start(view);
  const shown = await card(id);
  const libBefore = bytes();
  const crashed = host;
  host = new CopilotHost(join(root, "data"), settings, () => {});
  makeApp();
  const restarted = await host.snapshot(id);
  expect(restarted.conversation.run?.status).toBe("interrupted");
  expect(restarted.confirmations).toEqual([]);
  expect(ops(restarted).map((o) => o.status)).toEqual(["expired"]);
  expect((await request(`/views/${view.viewId}`, "PUT", view)).status).toBe(200);
  expect((await answerCard(shown, view.viewId, "approve")).status).toBe(404);
  expect(existsSync(join(paths.outputDir, SHARED))).toBe(true);
  expect(bytes()).toBe(libBefore);
  const resumed = await request(`/conversations/${id}/resume`, "POST", {
    clientMessageId: randomUUID(),
    viewId: view.viewId,
    contextRevision: view.revision,
  });
  expect(resumed.status).toBe(202);
  await settled(id);
  const transcript = JSON.stringify(seen.at(-1)?.messages);
  expect(transcript).toContain("delete_doc arxiv-2603.00101");
  expect(transcript).toContain("nothing was deleted and the request is no longer valid");
  expect(existsSync(join(paths.outputDir, SHARED))).toBe(true);
  await crashed.close();
});

test("a click already made is a submitted delete: Stop right after it does not undo it and the record says it was deleted", async () => {
  script = [() => del(SHARED), () => ({ text: "done" })];
  const view = page();
  const id = await start(view);
  const shown = await card(id);
  expect((await answerCard(shown, view.viewId, "approve")).status).toBe(200);
  await request(`/conversations/${id}/stop`, "POST");
  await settled(id);
  expect(existsSync(join(paths.outputDir, SHARED))).toBe(false);
  expect(workOnDisk(W_MULTI1).doc_ids).toEqual([OWN1]);
  expect(ops(await host.snapshot(id))).toMatchObject([
    { action: "delete_doc", status: "ok", object: { kind: "doc", id: SHARED } },
  ]);
});

// ---- busy, not found, failure -------------------------------------------------------------------------- //
test("a Doc an upload job is writing is rejected up front with no card; once the job is done the delete is asked again", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const base = pipelines.ingestLatexZip;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  pipelines.ingestLatexZip = async (zipPath, opts) => {
    entered();
    await gate;
    return base(zipPath, opts);
  };
  makeApp();
  const upload = await app.request(`/api/library/upload?id=${encodeURIComponent(W_SOLO)}`, {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: makeZip({
      "main.tex": "\\documentclass{article}\\begin{document}Hello\\end{document}\n",
    }),
  });
  expect(upload.status).toBe(202);
  await started;
  const answers: Record<string, unknown>[] = [];
  script = [
    () => del(UPLOAD_DOC),
    (ctx) => {
      answers.push(lastResult(ctx));
      return { text: "busy" };
    },
  ];
  const id = await start(page());
  await settled(id);
  expect(answers[0]).toMatchObject({ ok: false, status: "rejected" });
  expect(String(answers[0]?.detail)).toContain("busy");
  expect((await host.snapshot(id)).confirmations).toEqual([]);
  expect(existsSync(join(paths.outputDir, UPLOAD_DOC))).toBe(true);
  // the page itself says the same thing
  expect((await app.request(`/api/paper/${UPLOAD_DOC}`, { method: "DELETE" })).status).toBe(409);
  release();
});

test("while the approved delete runs, an upload of that Doc is refused (reverse pin): the tool claims the page's own delete slot", async () => {
  // A manual import holds the library lock (the sources never answer), so the approved delete waits behind it
  // with its slot already claimed.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  sourcesFactory = () => ({
    ads: { status: "no-token", resolve: async () => null, exportBibtex: async () => null },
    crossref: {
      resolve: async () => {
        await gate;
        return null;
      },
    },
    oa: {
      resolve: async () => {
        await gate;
        return null;
      },
    },
  });
  makeApp();
  script = [() => del(UPLOAD_DOC), () => ({ text: "done" })];
  const view = page();
  const id = await start(view);
  const shown = await card(id);
  const importing = app.request("/api/library/works", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "identifier", value: "10.1000/gated" }),
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect((await answerCard(shown, view.viewId, "approve")).status).toBe(200);
  await vi.waitFor(() => expect(docMutations.isDeleting(UPLOAD_DOC)).toBe(true));
  const upload = await app.request(`/api/library/upload?id=${encodeURIComponent(W_SOLO)}`, {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: makeZip({
      "main.tex": "\\documentclass{article}\\begin{document}Hello\\end{document}\n",
    }),
  });
  expect(upload.status).toBe(409);
  expect(runner.list().filter((job) => job.kind === "upload")).toHaveLength(0);
  release();
  await importing;
  await settled(id);
  expect(docMutations.isDeleting(UPLOAD_DOC)).toBe(false);
  expect(existsSync(irPath(UPLOAD_DOC))).toBe(false);
  expect(workOnDisk(W_SOLO).doc_ids).toEqual([SOLO]);
});

test("an unknown Doc is not_found with no card", async () => {
  const answers: Record<string, unknown>[] = [];
  script = [
    () => del("arxiv-2603.99999"),
    (ctx) => {
      answers.push(lastResult(ctx));
      return { text: "done" };
    },
  ];
  const id = await start(page());
  await settled(id);
  expect(answers[0]).toMatchObject({ ok: false, status: "not_found" });
  expect(ops(await host.snapshot(id))[0]).toMatchObject({ status: "not_found" });
  expect(changed()).toHaveLength(0);
});

test("a Doc deleted elsewhere while the card waits ends the card and the tool does not claim a delete", async () => {
  const answers: Record<string, unknown>[] = [];
  script = [
    () => del(SOLO),
    (ctx) => {
      answers.push(lastResult(ctx));
      return { text: "done" };
    },
  ];
  const view = page();
  const id = await start(view);
  const shown = await card(id);
  expect((await app.request(`/api/paper/${SOLO}`, { method: "DELETE" })).status).toBe(200);
  await vi.waitFor(async () => expect((await host.snapshot(id)).confirmations).toHaveLength(0));
  expect((await answerCard(shown, view.viewId, "approve")).status).toBeGreaterThanOrEqual(404);
  await settled(id);
  expect(answers[0]).toMatchObject({ ok: false, status: "expired" });
  expect(ops(await host.snapshot(id))[0]).not.toMatchObject({ status: "ok" });
});

test("a delete that fails part-way is an error that says so (files may be gone, library still lists the Doc); library.json keeps its bytes", async () => {
  const nested = join(paths.outputDir, SOLO, "assets", "nested");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "deep.png"), "x");
  chmodSync(nested, 0o555);
  const libBefore = bytes();
  let payload: Record<string, unknown> = {};
  script = [
    () => del(SOLO),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "done" };
    },
  ];
  const view = page();
  const id = await start(view);
  try {
    await answerCard(await card(id), view.viewId, "approve");
    await settled(id);
  } finally {
    chmodSync(nested, 0o755);
  }
  expect(payload).toMatchObject({ ok: false, status: "error" });
  expect(String(payload.detail)).toContain("part-way");
  expect(bytes()).toBe(libBefore);
  expect(changed()).toHaveLength(0);
  expect(docMutations.isDeleting(SOLO)).toBe(false);
  expect(ops(await host.snapshot(id))[0]).toMatchObject({ action: "delete_doc", status: "error" });
});

test("an unreadable library.json refuses the delete before anything is removed", async () => {
  writeFileSync(paths.libraryJson, "{ not json");
  let payload: Record<string, unknown> = {};
  script = [
    () => del(SOLO),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "done" };
    },
  ];
  const id = await start(page());
  await settled(id);
  expect(payload).toMatchObject({ ok: false, status: "error" });
  expect((await host.snapshot(id)).confirmations).toEqual([]);
  expect(existsSync(irPath(SOLO))).toBe(true);
  expect(bytes()).toBe("{ not json");
});

// ---- continuation: orphans, lock-time check, bound view, duplicates, PDF ownership ----------------------- //
test("a Doc no work lists is rejected with no card: the Files tab does not offer it, so neither does the tool", async () => {
  writeDoc("arxiv-2603.00999");
  const answers: Record<string, unknown>[] = [];
  script = [
    () => del("arxiv-2603.00999"),
    (ctx) => {
      answers.push(lastResult(ctx));
      return { text: "done" };
    },
  ];
  const id = await start(page());
  await settled(id);
  expect(answers[0]).toMatchObject({ ok: false, status: "rejected" });
  expect(String(answers[0]?.detail)).toContain("no work lists");
  expect((await host.snapshot(id)).confirmations).toEqual([]);
  expect(existsSync(irPath("arxiv-2603.00999"))).toBe(true);
  expect(changed()).toHaveLength(0);
});

test("a library write that gets in between the click and the delete (inside the library lock) ends it: a main-Doc change queued first means nothing is deleted", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  sourcesFactory = () => ({
    ads: { status: "no-token", resolve: async () => null, exportBibtex: async () => null },
    crossref: {
      resolve: async () => {
        await gate;
        return null;
      },
    },
    oa: {
      resolve: async () => {
        await gate;
        return null;
      },
    },
  });
  makeApp();
  const answers: Record<string, unknown>[] = [];
  script = [
    () => del(SHARED),
    (ctx) => {
      answers.push(lastResult(ctx));
      return { text: "done" };
    },
  ];
  const view = page();
  const id = await start(view);
  const shown = await card(id);
  const importing = app.request("/api/library/works", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "identifier", value: "10.1000/gated" }),
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const patching = patchRef(W_MULTI1, OWN1); // queued behind the import, ahead of the delete
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect((await answerCard(shown, view.viewId, "approve")).status).toBe(200);
  await vi.waitFor(() => expect(docMutations.isDeleting(SHARED)).toBe(true));
  release();
  await importing;
  expect((await patching).status).toBe(200);
  await settled(id);
  expect(answers[0]).toMatchObject({ ok: false, status: "expired" });
  expect(existsSync(irPath(SHARED))).toBe(true);
  expect(workOnDisk(W_MULTI1).doc_ids).toEqual([OWN1, SHARED]);
  expect(workOnDisk(W_MULTI2).doc_ids).toEqual([OWN2, SHARED]);
  expect(docMutations.isDeleting(SHARED)).toBe(false);
  keptUnknownKeys();
});

test("only the view the run is bound to may decide a Doc delete: another tab's click is refused and the card stays", async () => {
  script = [() => del(SHARED), () => ({ text: "done" })];
  const view = page();
  const id = await start(view);
  const shown = await card(id);
  const other = page();
  expect((await request(`/views/${other.viewId}`, "PUT", other)).status).toBe(200);
  expect((await answerCard(shown, other.viewId, "approve")).status).toBe(409);
  expect((await answerCard(shown, other.viewId, "decline")).status).toBe(409);
  expect((await host.snapshot(id)).confirmations).toHaveLength(1);
  expect(existsSync(irPath(SHARED))).toBe(true);
  expect((await answerCard(shown, view.viewId, "approve")).status).toBe(200);
  await settled(id);
  expect(existsSync(irPath(SHARED))).toBe(false);
});

test("the kept-Docs count ignores duplicate entries, as the removal does", async () => {
  const raw = disk();
  raw.works[0].doc_ids = [SHARED, OWN1, OWN1, SHARED];
  writeLibrary(raw);
  script = [() => del(SHARED), () => ({ text: "waiting" })];
  const view = page();
  const id = await start(view);
  const shown = await card(id);
  expect(shown).toMatchObject({
    works: [{ id: W_MULTI1, main: true, remaining: 1 }, { id: W_MULTI2 }],
  });
  await answerCard(shown, view.viewId, "decline");
  await settled(id);
});

test("a PDF Doc that two works list is an ownership error: the count is unknown, as the page's count route reports it", async () => {
  const raw = disk();
  raw.works.find((w: { id: string }) => w.id === W_NONE).doc_ids = [pdfDocId];
  writeLibrary(raw);
  script = [() => del(pdfDocId), () => ({ text: "waiting" })];
  const view = page();
  const id = await start(view);
  const shown = await card(id);
  expect(shown).toMatchObject({ format: "pdf", impact: { annotations: "unknown" }, baseRev: 0 });
  expect(shown.action === "delete_doc" && shown.works.map((w) => w.id).sort()).toEqual(
    [W_NONE, W_PDF].sort()
  );
  await answerCard(shown, view.viewId, "decline");
  await settled(id);
});

// ---- idempotence, labels, the chat record ---------------------------------------------------------------- //
test("a repeated operationId returns the first result: no second card, no second delete", async () => {
  const payloads: Record<string, unknown>[] = [];
  script = [
    () => del(SOLO, { operationId: "op-1" }),
    (ctx) => {
      payloads.push(lastResult(ctx));
      return del(SOLO, { operationId: "op-1" });
    },
    (ctx) => {
      payloads.push(lastResult(ctx));
      return del(OWN1, { operationId: "op-1" });
    },
    (ctx) => {
      payloads.push(lastResult(ctx));
      return { text: "done" };
    },
  ];
  const view = page();
  const id = await start(view);
  await answerCard(await card(id), view.viewId, "approve");
  await settled(id);
  expect(payloads[0]).toMatchObject({ ok: true, status: "ok" });
  expect(payloads[0]?.duplicate).toBeUndefined();
  expect(payloads[1]).toMatchObject({ ok: true, status: "ok", duplicate: true });
  expect(payloads[2]).toMatchObject({ ok: false, status: "rejected" });
  expect(changed()).toHaveLength(1);
  expect(existsSync(irPath(OWN1))).toBe(true);
});

test("files the user attached to an earlier message are chat records: deleting a Doc leaves them and the message chip alone", async () => {
  const created = (await (
    await request("/conversations", "POST", { model: choice })
  ).json()) as ConversationSnapshot;
  const id = created.conversation.id;
  const attach = await app.request(`/api/copilot/conversations/${id}/attachments`, {
    method: "POST",
    headers: { "Content-Type": "application/pdf", "X-Filename": encodeURIComponent("kept.pdf") },
    body: readFileSync(PDF_FIXTURE),
  });
  expect(attach.status).toBe(201);
  const attachmentId = ((await attach.json()) as { id: string }).id;
  script = [() => del(SOLO), () => ({ text: "done" })];
  const view = page();
  expect((await request(`/views/${view.viewId}`, "PUT", view)).status).toBe(200);
  await request(`/conversations/${id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text: "Delete that doc",
    viewId: view.viewId,
    contextRevision: view.revision,
    attachmentIds: [attachmentId],
  });
  await answerCard(await card(id), view.viewId, "approve");
  await settled(id);
  expect(existsSync(irPath(SOLO))).toBe(false);
  const dir = join(paths.dataDir, "copilot", "attachments", id);
  expect(readdirSync(dir).sort()).toEqual([`${attachmentId}.bin`, `${attachmentId}.json`]);
  expect(
    createHash("sha256")
      .update(readFileSync(join(dir, `${attachmentId}.bin`)))
      .digest("hex")
  ).toBe(createHash("sha256").update(readFileSync(PDF_FIXTURE)).digest("hex"));
  const messages = (await host.snapshot(id)).messages;
  expect(messages[0]?.attachments?.[0]).toMatchObject({ id: attachmentId, filename: "kept.pdf" });
});

test("the tool is only offered with a confirmation port: without one delete_doc is unsupported and deletes nothing", async () => {
  const tool = createLibraryTool({
    library: {
      paths,
      libraryLock: new (await import("../src/lock.js")).AsyncLock(),
      onChanged: () => {},
      readPayload: async () => {
        throw new Error("unused");
      },
      deletion: {
        describe: async () => ({
          kind: "ready",
          docId: SOLO,
          format: "latex",
          works: [],
          impact: { annotations: "unknown" },
          rev: 0,
          digest: "d",
          holders: "h",
        }),
        delete: async () => {
          throw new Error("must not run");
        },
      },
    },
    viewAction: async () => ({ status: "displayed" }),
    admitting: () => true,
  });
  const result = await tool.execute(
    "call_x",
    { action: "delete_doc", docId: SOLO } as never,
    undefined,
    undefined,
    undefined as never
  );
  const text = (result.content[0] as { text: string }).text;
  expect(JSON.parse(text)).toMatchObject({ ok: false, status: "unsupported" });
  expect(existsSync(irPath(SOLO))).toBe(true);
});

// ---- the tool against a scripted confirmation port: what happens AFTER the click ------------------------------- //
type Port = NonNullable<Parameters<typeof createLibraryTool>[0]["library"]["deletion"]>;
const ready = (digest: string): Awaited<ReturnType<Port["describe"]>> => ({
  kind: "ready",
  docId: SOLO,
  format: "latex",
  works: [{ id: W_SOLO, title: "T", main: true, remaining: 1 }],
  impact: { annotations: "known", count: 2 },
  rev: 1,
  digest,
  holders: "h",
});
async function callTool(options: {
  describe: Port["describe"];
  remove: Port["delete"];
  confirm?: { request: (entry: unknown) => Promise<unknown> };
  admitting?: () => boolean;
}) {
  const { AsyncLock } = await import("../src/lock.js");
  const tool = createLibraryTool({
    library: {
      paths,
      libraryLock: new AsyncLock(),
      onChanged: () => {},
      readPayload: async () => {
        throw new Error("unused");
      },
      deletion: { describe: options.describe, delete: options.remove },
    },
    confirm: (options.confirm ?? {
      request: async () => ({ outcome: "approved" }),
    }) as never,
    viewAction: async () => ({ status: "displayed" }),
    admitting: options.admitting ?? (() => true),
  });
  const result = await tool.execute(
    "call_x",
    { action: "delete_doc", docId: SOLO } as never,
    undefined,
    undefined,
    undefined as never
  );
  return JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
}
test("the digest is checked again after the click: a Doc that changed in between is expired and the delete never runs", async () => {
  const remove = vi.fn(
    async (): Promise<Awaited<ReturnType<Port["delete"]>>> => ({ kind: "deleted", works: [] })
  );
  let calls = 0;
  const payload = await callTool({
    describe: async () => ready(++calls === 1 ? "before" : "after"),
    remove,
  });
  expect(payload).toMatchObject({ ok: false, status: "expired" });
  expect(remove).not.toHaveBeenCalled();
});

test("a Stop that closes admission after the click does not stop the delete: the click is the commit, as on the page", async () => {
  const remove = vi.fn(
    async (): Promise<Awaited<ReturnType<Port["delete"]>>> => ({
      kind: "deleted",
      works: [{ id: W_SOLO, title: "T", remaining: [] }],
    })
  );
  let open = true;
  const payload = await callTool({
    describe: async () => ready("same"),
    remove,
    confirm: {
      request: async () => {
        open = false;
        return { outcome: "approved" };
      },
    },
    admitting: () => open,
  });
  expect(payload).toMatchObject({ ok: true, status: "ok", docId: SOLO });
  expect(remove).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledWith(SOLO, { holders: "h" });
});

test("the shared delete's outcomes are told as they are: busy and bad id are rejected, a vanished Doc is not_found (never ok), a failure says it may be partial", async () => {
  const tell = async (outcome: Awaited<ReturnType<Port["delete"]>>) =>
    callTool({ describe: async () => ready("same"), remove: async () => outcome });
  expect(await tell({ kind: "busy" })).toMatchObject({ ok: false, status: "rejected" });
  expect(await tell({ kind: "bad_id" })).toMatchObject({ ok: false, status: "rejected" });
  const gone = await tell({ kind: "not_found" });
  expect(gone).toMatchObject({ ok: false, status: "not_found" });
  expect(gone.ok).not.toBe(true);
  const failed = await tell({ kind: "failed", message: "EACCES" });
  expect(failed).toMatchObject({ ok: false, status: "error" });
  expect(String(failed.detail)).toContain("part-way");
  expect(String(failed.detail)).toContain("EACCES");
  expect(
    await tell({ kind: "deleted", works: [{ id: W_SOLO, title: "T", remaining: [] }] })
  ).toMatchObject({
    ok: true,
    status: "ok",
    docId: SOLO,
  });
});

test("SYSTEM_PROMPT and the tool description tell the model the truth about delete_doc", async () => {
  script = [() => ({ text: "hello" })];
  const id = await start(page());
  await settled(id);
  const transcript = JSON.stringify(seen[0]);
  expect(transcript).toContain("delete_doc");
  expect(transcript).toContain("global, permanent delete");
  expect(transcript).toContain("never just from one work");
  expect(transcript).toContain("a delete_doc error (it may have failed part-way)");
  expect(transcript).not.toContain("It never deletes Docs");
});
