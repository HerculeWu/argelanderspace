/**
 * Copilot `library` tool acquisition (copilot ticket 15): acquire_arxiv_pdf, attach_arxiv and read_jobs end to end
 * on the real seam: real Pi session, real HTTP routes, real JobRunner (serial, persisted), real PDFium publication,
 * real library lock/disk, real annotations access path and library.changed, real /ws sockets as browser tabs.
 * Only the model provider and the two arXiv network boundaries (the PDF bytes, the e-print compile) are scripted.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
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
  type Job,
  type LibraryPage,
  type PageContext,
  summarizeLibraryRef,
  type WsServerMessage,
} from "@argelanderspace/contracts";
import type { MetadataSources } from "@argelanderspace/core";
import {
  LibraryStore,
  libraryPaths,
  plansPath,
  publishPdfDoc,
  uploadDocId,
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
import { createLibraryTool } from "../src/copilot-library-tool.js";
import { JobRunner } from "../src/jobs.js";
import { AsyncLock } from "../src/lock.js";
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
let sources: MetadataSources;
let runner: JobRunner;
let pdfFetch: (arxivId: string) => Promise<Buffer>;
let pipelines: ReturnType<typeof stubPipelines>;
let waitMs: number | undefined;
let statusDir: string;
let copilotEvents: { conversationId?: string; type: string }[];
const PDF_FIXTURE = new URL("./fixtures/pdf/scanned-no-text.pdf", import.meta.url);
const choice = { provider: "openai", model: "gpt-4.1", thinking: null };

const W_DOCLESS = "arxiv:2603.00001";
const W_REFRESH = "arxiv:2603.00002";
const W_NOARXIV = "doi:10.1000/noarxiv";
const W_ZIP = "arxiv:2603.00004";
const W_PDFONLY = "arxiv:2603.00005";
const REFRESH_DOC = "arxiv-2603.00002";
const work = (id: string, extra: object = {}) => ({
  id,
  title: `Work ${id}`,
  authors: ["Author"],
  year: 2026,
  venue: "arXiv",
  type: "article",
  ...(id.startsWith("arxiv:") ? { arxiv_id: id.slice(6) } : { doi: id.slice(4) }),
  cite_key: id.replace(/[^a-z0-9]/gi, ""),
  doc_ids: [],
  ...extra,
});
const seedFile = () => ({
  version: 1,
  project: { name: "Synthetic", short: "S", field: "", x_project: "keep" },
  x_top: { nested: [1] },
  works: [
    work(W_DOCLESS, { x_work: "keep-me", read: true, note: "Private note" }),
    work(W_REFRESH, { doc_ids: [REFRESH_DOC], x_other: 7 }),
    work(W_NOARXIV),
    work(W_ZIP, { doc_ids: ["upload-user-doc"] }),
    work(W_PDFONLY),
  ],
});
const refreshIr = (text = "Hello world") => ({
  version: 1,
  docId: REFRESH_DOC,
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
  source: { type: "latex", origin: "/tmp/src", main_tex: "main.tex", arxiv_id: "2603.00002" },
  meta: { title: "Existing arXiv Doc" },
});
function writeRefreshDoc() {
  const dir = join(paths.outputDir, REFRESH_DOC);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${REFRESH_DOC}.json`), JSON.stringify(refreshIr()));
}
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
  statusDir = join(root, "status");
  mkdirSync(statusDir, { recursive: true });
  writeFileSync(plansPath(statusDir), JSON.stringify({ version: 1, rev: 1, plans: [] }, null, 2));
  paths = libraryPaths(join(root, "data"));
  mkdirSync(paths.libraryDir, { recursive: true });
  writeLibrary();
  writeRefreshDoc();
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
  pdfFetch = async () => readFileSync(PDF_FIXTURE);
  pipelines = stubPipelines();
  waitMs = undefined;
  runner = new JobRunner({ dir: join(root, "jobs") });
  copilotEvents = [];
  host = new CopilotHost(join(root, "data"), settings, (event) => copilotEvents.push(event));
  makeApp();
});
function makeApp() {
  app = createApp({
    paths,
    statusDir,
    makeSources: () => sources,
    pipelines,
    fetchArxivPdf: (arxivId) => pdfFetch(arxivId),
    autoIngestArxiv: () => false,
    acquisitionWaitMs: waitMs,
    runner,
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

// ---- helpers for this ticket ------------------------------------------------------------------------ //
const toolCall = (call: Record<string, unknown>): Out => ({ call });
const acquirePdf = (refId: string, extra: Record<string, unknown> = {}) =>
  toolCall({ action: "acquire_arxiv_pdf", refId, ...extra });
const attach = (refId: string, extra: Record<string, unknown> = {}) =>
  toolCall({ action: "attach_arxiv", refId, ...extra });
const jobsOf = (kind?: Job["kind"]) => runner.list().filter((job) => !kind || job.kind === kind);
const pdfDirs = () =>
  existsSync(paths.outputDir)
    ? readdirSync(paths.outputDir).filter((name) => name.startsWith("pdf-"))
    : [];
const workOnDisk = (id: string) =>
  disk().works.find((w: { id: string }) => w.id === id) as Record<string, unknown>;
const keptUnknownKeys = () => {
  const after = disk();
  const seeded = seedFile();
  expect(after.x_top).toEqual(seeded.x_top);
  expect(after.project).toEqual(seeded.project);
  for (const w of seeded.works) {
    const stored = workOnDisk(w.id);
    for (const key of ["x_work", "x_other", "note", "read"])
      if (key in w)
        expect(stored[key], `${w.id}.${key}`).toEqual((w as Record<string, unknown>)[key]);
  }
};
async function start(context: PageContext, text = "Get the full text") {
  const created = (await (
    await request("/conversations", "POST", { model: choice })
  ).json()) as ConversationSnapshot;
  const id = created.conversation.id;
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
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};
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
async function annotate(count: number) {
  const url = `/api/paper/${REFRESH_DOC}/annotations`;
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
const annotationFiles = () => {
  const dir = join(paths.dataDir, "annotations", REFRESH_DOC);
  return {
    current: existsSync(join(dir, "current.json"))
      ? readFileSync(join(dir, "current.json"), "utf8")
      : null,
    archive: existsSync(join(dir, "archive")) ? readdirSync(join(dir, "archive")) : [],
  };
};
const refreshIrBytes = () =>
  readFileSync(join(paths.outputDir, REFRESH_DOC, `${REFRESH_DOC}.json`), "utf8");
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
const sha = (file: string | URL) => readFileSync(file);

// ---- acquire_arxiv_pdf ------------------------------------------------------------------------------ //
test("fetching the PDF through the tool runs the page's own job, creates a new Doc with every sidecar, and keeps all other data", async () => {
  let payload: Record<string, unknown> = {};
  script = [
    () => acquirePdf(W_DOCLESS),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "done" };
    },
  ];
  const { snapshot } = await run(page());
  const [record] = ops(snapshot);
  const job = payload.job as { id: string; status: string };
  const docId = payload.docId as string;
  expect(payload).toMatchObject({ ok: true, status: "ok", job: { status: "done" } });
  expect(docId).toMatch(/^pdf-[0-9a-f-]{36}$/);
  // The job is the application's own: one upload job, format arxiv-pdf, payload names the work.
  expect(jobsOf()).toHaveLength(1);
  expect(runner.get(job.id)).toMatchObject({
    kind: "upload",
    status: "done",
    payload: { workId: W_DOCLESS, docId, format: "arxiv-pdf", automatic: false },
  });
  // The operation record names the actual job and Doc.
  expect(record).toMatchObject({
    action: "acquire_arxiv_pdf",
    status: "ok",
    job: { id: job.id, status: "done" },
    docId,
    object: { kind: "work", id: W_DOCLESS },
  });
  // Original, metadata, annotation sidecar and reading-position sidecar are all there.
  const dir = join(paths.outputDir, docId);
  expect(readdirSync(dir).sort()).toEqual(
    ["annotations.json", `${docId}.json`, "original.pdf", "reading-position.json"].sort()
  );
  const metadata = JSON.parse(readFileSync(join(dir, `${docId}.json`), "utf8"));
  expect(metadata).toMatchObject({
    format: "pdf",
    acquired_via: "arxiv_pdf",
    arxiv_id: "2603.00001",
    byte_length: sha(PDF_FIXTURE).length,
  });
  expect(sha(join(dir, "original.pdf")).equals(sha(PDF_FIXTURE))).toBe(true);
  expect(workOnDisk(W_DOCLESS).doc_ids).toEqual([docId]);
  keptUnknownKeys(); // the narrow append: no typed whole-library save
  expect(disk().works).toHaveLength(5);
  // job.done precedes the one library.changed{upload}.
  const order = broadcasts
    .map((m) => (m.type === "library.changed" ? `${m.type}:${m.cause}` : m.type))
    .filter((t) => t === "job.done" || t.startsWith("library.changed"));
  expect(order).toEqual(["job.done", "library.changed:upload"]);
});

test("every successful fetch is a new Doc even with identical bytes; the earlier Doc, its sidecars and the main position are untouched", async () => {
  const ids: string[] = [];
  script = [
    () => acquirePdf(W_DOCLESS),
    (ctx) => {
      ids.push(lastResult(ctx).docId);
      return acquirePdf(W_DOCLESS);
    },
    (ctx) => {
      ids.push(lastResult(ctx).docId);
      return { text: "done" };
    },
  ];
  await run(page());
  expect(new Set(ids).size).toBe(2);
  const [first, second] = ids as [string, string];
  const hash = (id: string) =>
    JSON.parse(readFileSync(join(paths.outputDir, id, `${id}.json`), "utf8")).sha256;
  expect(hash(first)).toBe(hash(second)); // same bytes, still two Docs
  expect(workOnDisk(W_DOCLESS).doc_ids).toEqual([first, second]); // the first stays main
  expect(jobsOf("upload")).toHaveLength(2);
});

test("a fetch for a work that has another Doc appends and does not take the main position", async () => {
  script = [() => acquirePdf(W_REFRESH), () => ({ text: "done" })];
  await run(page());
  const docs = workOnDisk(W_REFRESH).doc_ids as string[];
  expect(docs[0]).toBe(REFRESH_DOC);
  expect(docs).toHaveLength(2);
  expect(docs[1]).toMatch(/^pdf-/);
});

test("the page's route and the tool give the same Doc shape and the same refusals", async () => {
  const res = await app.request(
    `/api/library/acquire-arxiv-pdf?id=${encodeURIComponent(W_DOCLESS)}`,
    {
      method: "POST",
    }
  );
  expect(res.status).toBe(202);
  const routeJob = ((await res.json()) as { job: Job }).job;
  await runner.waitFor(routeJob.id);
  const viaPage = ((runner.get(routeJob.id) as Job).result as { doc: Record<string, unknown> }).doc;
  let viaTool: Record<string, unknown> = {};
  const answers: Record<string, unknown>[] = [];
  script = [
    () => acquirePdf(W_PDFONLY),
    (ctx) => {
      viaTool = lastResult(ctx);
      return acquirePdf("arxiv:0000.00000");
    },
    (ctx) => {
      answers.push(lastResult(ctx));
      return acquirePdf(W_NOARXIV);
    },
    (ctx) => {
      answers.push(lastResult(ctx));
      return { text: "done" };
    },
  ];
  await run(page());
  const toolDoc = JSON.parse(
    readFileSync(join(paths.outputDir, viaTool.docId as string, `${viaTool.docId}.json`), "utf8")
  );
  const keys = (o: Record<string, unknown>) => Object.keys(o).sort();
  expect(keys(toolDoc)).toEqual(keys(viaPage));
  expect(toolDoc).toMatchObject({
    acquired_via: viaPage.acquired_via,
    sha256: viaPage.sha256,
    format: "pdf",
  });
  // Refusals match the route's 404 / 400.
  expect(answers[0]).toMatchObject({ ok: false, status: "not_found" });
  expect(answers[1]).toMatchObject({
    ok: false,
    status: "rejected",
    detail: "this work has no arXiv id",
  });
  const noRoute = await app.request(
    `/api/library/acquire-arxiv-pdf?id=${encodeURIComponent(W_NOARXIV)}`,
    { method: "POST" }
  );
  expect(noRoute.status).toBe(400);
  const missing = await app.request("/api/library/acquire-arxiv-pdf?id=arxiv:0000.00000", {
    method: "POST",
  });
  expect(missing.status).toBe(404);
});

test("a job already queued for the work is reused, not stacked; one Doc comes out", async () => {
  const hold = gate();
  pdfFetch = async () => {
    await hold.opened;
    return readFileSync(PDF_FIXTURE);
  };
  const res = await app.request(
    `/api/library/acquire-arxiv-pdf?id=${encodeURIComponent(W_DOCLESS)}`,
    { method: "POST" }
  );
  const uiJob = ((await res.json()) as { job: Job }).job;
  let payload: Record<string, unknown> = {};
  script = [
    () => acquirePdf(W_DOCLESS),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "done" };
    },
  ];
  const id = await start(page());
  await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: 8000 });
  hold.open();
  await settled(id);
  expect(payload).toMatchObject({ ok: true, status: "ok", reused: true, job: { id: uiJob.id } });
  expect(jobsOf("upload")).toHaveLength(1);
  expect(workOnDisk(W_DOCLESS).doc_ids).toHaveLength(1);
  expect(pdfDirs()).toHaveLength(1);
});

test("the run holds no job slot: while it waits for its job another job queues behind it and both finish", async () => {
  const hold = gate();
  const entered = gate();
  pdfFetch = async () => {
    entered.open();
    await hold.opened;
    return readFileSync(PDF_FIXTURE);
  };
  let toolDone = false;
  script = [
    () => acquirePdf(W_DOCLESS),
    () => {
      toolDone = true;
      return { text: "done" };
    },
  ];
  const id = await start(page());
  await entered.opened;
  // The tool is waiting on its job; the only job in the table is that job (the run is not one).
  expect(jobsOf().map((j) => `${j.kind}:${j.status}`)).toEqual(["upload:running"]);
  expect((await host.snapshot(id)).conversation.run?.status).toBe("running");
  // A UI upload for another work is queued behind it, not blocked by the waiting run.
  const pdf = readFileSync(PDF_FIXTURE);
  const second = await app.request(`/api/library/upload-pdf?id=${encodeURIComponent(W_PDFONLY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/pdf", "X-Filename": "mine.pdf" },
    body: pdf,
  });
  expect(second.status).toBe(202);
  const queued = ((await second.json()) as { job: Job }).job;
  expect(runner.get(queued.id)?.status).toBe("queued");
  expect(toolDone).toBe(false);
  hold.open();
  await settled(id);
  await runner.waitFor(queued.id);
  expect(jobsOf("upload").map((j) => j.status)).toEqual(["done", "done"]);
  // FIFO: the Copilot job ran first.
  expect(
    (runner.get(queued.id)?.startedAt as string) >=
      (jobsOf("upload").find((j) => j.id !== queued.id)?.finishedAt as string)
  ).toBe(true);
  expect(pdfDirs()).toHaveLength(2);
});

test("Stop while the job is queued/running releases the run at once, starts nothing new, and the submitted job still finishes with a visible Doc", async () => {
  const hold = gate();
  const entered = gate();
  pdfFetch = async () => {
    entered.open();
    await hold.opened;
    return readFileSync(PDF_FIXTURE);
  };
  script = [() => acquirePdf(W_DOCLESS), () => ({ text: "must not run" })];
  const id = await start(page());
  await entered.opened;
  expect((await request(`/conversations/${id}/stop`, "POST")).status).toBe(200);
  // The run reaches its terminal state while the job is still running (the wait does not hold Stop hostage).
  await settled(id);
  expect(jobsOf("upload").map((j) => j.status)).toEqual(["running"]);
  const afterStop = ops(await host.snapshot(id));
  expect(afterStop).toHaveLength(1);
  expect(afterStop[0]).toMatchObject({
    action: "acquire_arxiv_pdf",
    status: "pending",
    job: { id: jobsOf("upload")[0]?.id, status: "running" },
  });
  expect(seen).toHaveLength(1); // no later model step
  // The job finishes by itself: the Doc exists, the library names it, and the Job table says which job made it.
  const eventsBefore = copilotEvents.length;
  hold.open();
  const job = await runner.waitFor(jobsOf("upload")[0]?.id as string);
  expect(job.status).toBe("done");
  const docId = (job.result as { doc: { doc_id: string } }).doc.doc_id;
  expect(workOnDisk(W_DOCLESS).doc_ids).toEqual([docId]);
  expect(jobsOf()).toHaveLength(1); // nothing was resubmitted
  // The record the user sees follows the Job table: the real job and Doc, and the open panel is told to reread.
  await vi.waitFor(async () => {
    expect(ops(await host.snapshot(id))[0]).toMatchObject({
      action: "acquire_arxiv_pdf",
      status: "ok",
      job: { id: job.id, status: "done" },
      docId,
    });
  });
  expect(copilotEvents.length).toBeGreaterThan(eventsBefore);
  // read_jobs (what the next run would use) shows the real Doc.
  script = [
    () => toolCall({ action: "read_jobs", refId: W_DOCLESS }),
    (ctx) => {
      expect(lastResult(ctx).jobs[0]).toMatchObject({ id: job.id, status: "done", docId });
      return { text: "seen" };
    },
  ];
  seen = [];
  await run(page());
});

test("a job still unfinished after the bound is pending with its job id, not a failure and not done", async () => {
  waitMs = 150;
  makeApp();
  const hold = gate();
  pdfFetch = async () => {
    await hold.opened;
    return readFileSync(PDF_FIXTURE);
  };
  let payload: Record<string, unknown> = {};
  script = [
    () => acquirePdf(W_DOCLESS),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "pending" };
    },
  ];
  const { snapshot } = await run(page());
  expect(payload).toMatchObject({ ok: true, status: "pending", job: { status: "running" } });
  expect(String(payload.detail)).toContain("do not submit it again");
  expect(ops(snapshot)[0]).toMatchObject({ status: "pending", job: { status: "running" } });
  expect(ops(snapshot)[0]?.docId).toBeUndefined();
  expect(bytes()).toBe(JSON.stringify(seedFile(), null, 2));
  hold.open();
  await runner.waitFor(jobsOf("upload")[0]?.id as string);
  expect(workOnDisk(W_DOCLESS).doc_ids).toHaveLength(1);
});

test("a failed job is an error that names the job and its reason; nothing is written and no change is announced", async () => {
  pdfFetch = async () => {
    throw new Error("arXiv said no");
  };
  const before = bytes();
  let payload: Record<string, unknown> = {};
  script = [
    () => acquirePdf(W_DOCLESS),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "failed" };
    },
  ];
  const { snapshot } = await run(page());
  expect(payload).toMatchObject({
    ok: false,
    status: "error",
    job: { status: "failed", error: "arXiv said no" },
  });
  expect(ops(snapshot)[0]).toMatchObject({ status: "error", job: { status: "failed" } });
  expect(bytes()).toBe(before);
  expect(pdfDirs()).toEqual([]);
  expect(changed()).toHaveLength(0);
  // The Job table (which the Files tab shows) says the same.
  expect(runner.get((payload.job as { id: string }).id)).toMatchObject({
    status: "failed",
    error: "arXiv said no",
  });
});

test("bytes that are not a readable PDF fail the job and create no Doc, like the page's validation", async () => {
  pdfFetch = async () => Buffer.from("this is not a pdf");
  const before = bytes();
  let payload: Record<string, unknown> = {};
  script = [
    () => acquirePdf(W_DOCLESS),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "failed" };
    },
  ];
  await run(page());
  expect(payload).toMatchObject({ ok: false, status: "error", job: { status: "failed" } });
  expect(bytes()).toBe(before);
  expect(pdfDirs()).toEqual([]);
  expect(readdirSync(paths.outputDir).filter((n) => n.startsWith(".pdf-stage"))).toEqual([]);
});

test("the same operationId returns the first result without a second job; another request under it is rejected", async () => {
  const results: Record<string, unknown>[] = [];
  script = [
    () => acquirePdf(W_DOCLESS, { operationId: "acq-1" }),
    (ctx) => {
      results.push(lastResult(ctx));
      return acquirePdf(W_DOCLESS, { operationId: "acq-1" });
    },
    (ctx) => {
      results.push(lastResult(ctx));
      return acquirePdf(W_REFRESH, { operationId: "acq-1" });
    },
    (ctx) => {
      results.push(lastResult(ctx));
      return { text: "done" };
    },
  ];
  await run(page());
  expect(results[1]).toMatchObject({ ...results[0], duplicate: true });
  expect(results[2]).toMatchObject({ ok: false, status: "rejected" });
  expect(jobsOf("upload")).toHaveLength(1);
  expect(pdfDirs()).toHaveLength(1);
});

test("the page's own PDF upload now keeps unknown keys too (the shared publication is a narrow append)", async () => {
  const res = await app.request(`/api/library/upload-pdf?id=${encodeURIComponent(W_DOCLESS)}`, {
    method: "POST",
    headers: { "Content-Type": "application/pdf", "X-Filename": "mine.pdf" },
    body: readFileSync(PDF_FIXTURE),
  });
  expect(res.status).toBe(202);
  await runner.waitFor(((await res.json()) as { job: Job }).job.id);
  keptUnknownKeys();
  expect(workOnDisk(W_DOCLESS).doc_ids).toHaveLength(1);
});

// ---- attach_arxiv ----------------------------------------------------------------------------------- //
test("attach_arxiv on a docless work compiles through the page's job and makes the arXiv Doc main, with no card", async () => {
  let payload: Record<string, unknown> = {};
  script = [
    () => attach(W_DOCLESS),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "done" };
    },
  ];
  const { id, snapshot } = await run(page());
  expect(payload).toMatchObject({
    ok: true,
    status: "ok",
    docId: "arxiv-2603.00001",
    job: { status: "done" },
  });
  expect(runner.get((payload.job as { id: string }).id)).toMatchObject({
    kind: "ingest",
    payload: { workId: W_DOCLESS, arxivId: "2603.00001" },
  });
  expect(ops(snapshot)[0]).toMatchObject({
    action: "attach_arxiv",
    status: "ok",
    docId: "arxiv-2603.00001",
  });
  expect((await host.snapshot(id)).confirmations).toEqual([]);
  expect(workOnDisk(W_DOCLESS).doc_ids as string[]).toEqual(["arxiv-2603.00001"]);
  const order = broadcasts
    .map((m) => (m.type === "library.changed" ? `${m.type}:${m.cause}` : m.type))
    .filter((t) => t === "job.done" || t.startsWith("library.changed"));
  expect(order[0]).toBe("job.done");
  expect(order).toContain("library.changed:ingest");
});

test("attach_arxiv on a PDF-only work appends the LaTeX Doc after the PDFs and keeps the PDF main", async () => {
  const pdf = publishPdfDoc(paths, {
    workId: W_PDFONLY,
    filename: "mine.pdf",
    bytes: readFileSync(PDF_FIXTURE),
    pages: [{ width: 612, height: 792, rotation: 0 }],
  });
  const original = readFileSync(join(paths.outputDir, pdf.doc_id, "original.pdf"));
  script = [() => attach(W_PDFONLY), () => ({ text: "done" })];
  await run(page());
  expect(workOnDisk(W_PDFONLY).doc_ids).toEqual([pdf.doc_id, "arxiv-2603.00005"]);
  expect(readFileSync(join(paths.outputDir, pdf.doc_id, "original.pdf")).equals(original)).toBe(
    true
  );
});

test("attach_arxiv refuses what the endpoint refuses and starts no job", async () => {
  const answers: Record<string, unknown>[] = [];
  const before = bytes();
  script = [
    () => attach(W_ZIP),
    (ctx) => {
      answers.push(lastResult(ctx));
      return attach(W_NOARXIV);
    },
    (ctx) => {
      answers.push(lastResult(ctx));
      return attach("arxiv:0000.00000");
    },
    (ctx) => {
      answers.push(lastResult(ctx));
      return { text: "done" };
    },
  ];
  await run(page());
  expect(answers[0]).toMatchObject({ ok: false, status: "rejected" });
  expect(String(answers[0]?.detail)).toContain("non-arXiv document");
  expect(answers[1]).toMatchObject({
    ok: false,
    status: "rejected",
    detail: "this work has no arXiv id",
  });
  expect(answers[2]).toMatchObject({ ok: false, status: "not_found" });
  expect(jobsOf()).toHaveLength(0);
  expect(bytes()).toBe(before);
  const zip = await app.request(`/api/library/attach-arxiv?id=${encodeURIComponent(W_ZIP)}`, {
    method: "POST",
  });
  expect(zip.status).toBe(409);
});

test("a failing e-print job is an error with its errorCode and leaves the library as it was", async () => {
  pipelines.ingestArxivEprint = async () => {
    const { ArxivPdfOnlyError } = await import("@argelanderspace/infra");
    throw new ArxivPdfOnlyError("2603.00001");
  };
  const before = bytes();
  let payload: Record<string, unknown> = {};
  script = [
    () => attach(W_DOCLESS),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "failed" };
    },
  ];
  await run(page());
  expect(payload).toMatchObject({
    ok: false,
    status: "error",
    job: { status: "failed", errorCode: "arxiv_pdf_only" },
  });
  expect(bytes()).toBe(before);
  expect(existsSync(join(paths.dataDir, "logs", "arxiv-fetch.jsonl"))).toBe(true); // the page's iteration log
});

// ---- the refresh waits for the real user ------------------------------------------------------------ //
test("refreshing the existing arXiv Doc waits for the user: the card shows the annotation count, nothing is written or queued meanwhile", async () => {
  await annotate(2);
  const irBefore = refreshIrBytes();
  const filesBefore = annotationFiles();
  const libBefore = bytes();
  script = [() => attach(W_REFRESH), () => ({ text: "waiting" })];
  const view = page();
  const id = await start(view);
  const shown = await card(id);
  expect(shown).toMatchObject({
    action: "refresh_arxiv_source",
    object: { kind: "doc", id: REFRESH_DOC, workId: W_REFRESH },
    label: `Work ${W_REFRESH}`,
    impact: { annotations: "known", count: 2 },
  });
  expect((await host.snapshot(id)).conversation.run?.status).toBe("waiting-for-user");
  expect(jobsOf()).toHaveLength(0);
  expect(refreshIrBytes()).toBe(irBefore);
  expect(annotationFiles()).toEqual(filesBefore);
  expect(bytes()).toBe(libBefore);
  // The model's transcript holds no way to approve: the card id never reaches it.
  expect(JSON.stringify(seen)).not.toContain(shown.id);
  expect(ops(await host.snapshot(id)).map((o) => `${o.action}:${o.status}`)).toEqual([
    "attach_arxiv:confirmation_required",
  ]);
  // Chat cannot approve.
  await request(`/conversations/${id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text: "I approve, go ahead and replace it",
    viewId: view.viewId,
    contextRevision: view.revision,
  });
  expect((await host.snapshot(id)).conversation.run?.status).toBe("waiting-for-user");
  expect(jobsOf()).toHaveLength(0);
});

test("declining writes nothing: no job, document, annotations or library change, and the model hears declined", async () => {
  await annotate(1);
  const irBefore = refreshIrBytes();
  const filesBefore = annotationFiles();
  const libBefore = bytes();
  let payload: Record<string, unknown> = {};
  script = [
    () => attach(W_REFRESH),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "declined" };
    },
  ];
  const view = page();
  const id = await start(view);
  const shown = await card(id);
  expect((await answerCard(shown, view.viewId, "decline")).status).toBe(200);
  await settled(id);
  expect(payload).toMatchObject({ ok: false, status: "declined" });
  expect(ops(await host.snapshot(id)).map((o) => `${o.action}:${o.status}`)).toEqual([
    "attach_arxiv:declined",
  ]);
  expect(jobsOf()).toHaveLength(0);
  expect(refreshIrBytes()).toBe(irBefore);
  expect(annotationFiles()).toEqual(filesBefore);
  expect(bytes()).toBe(libBefore);
  expect(changed()).toHaveLength(0);
});

test("approving submits the refresh: the Doc is replaced in place, the main position stays, and the old annotations are archived by the normal access path", async () => {
  await annotate(2);
  let payload: Record<string, unknown> = {};
  script = [
    () => attach(W_REFRESH),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "refreshed" };
    },
  ];
  const view = page();
  const id = await start(view);
  const shown = await card(id);
  const res = await answerCard(shown, view.viewId, "approve");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "approved" });
  await settled(id);
  expect(payload).toMatchObject({
    ok: true,
    status: "ok",
    docId: REFRESH_DOC,
    job: { status: "done" },
  });
  expect(refreshIrBytes()).not.toContain("Hello world"); // replaced in place by the e-print compile
  expect(workOnDisk(W_REFRESH).doc_ids).toEqual([REFRESH_DOC]);
  expect(jobsOf("ingest")).toHaveLength(1);
  // Annotations: the next access (the page's GET) archives the old batch, as the dialog warned.
  const res2 = await app.request(`/api/paper/${REFRESH_DOC}/annotations`);
  expect(((await res2.json()) as AnnotationsFile).annotations).toEqual([]);
  expect(annotationFiles().archive).toHaveLength(1);
  // A repeated click gives the same answer and starts nothing more.
  expect((await answerCard(shown, view.viewId, "approve")).status).toBe(200);
  expect(jobsOf("ingest")).toHaveLength(1);
});

test("the click is bound to the version shown: an annotation added meanwhile expires the card and no job starts", async () => {
  await annotate(1);
  let payload: Record<string, unknown> = {};
  script = [
    () => attach(W_REFRESH),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "expired" };
    },
  ];
  const view = page();
  const id = await start(view);
  const shown = await card(id);
  await annotate(3); // the user keeps annotating while the card waits
  const res = await answerCard(shown, view.viewId, "approve");
  expect(res.status).toBe(409);
  await settled(id);
  expect(payload).toMatchObject({ ok: false, status: "expired" });
  expect(jobsOf()).toHaveLength(0);
  expect((await host.snapshot(id)).confirmations).toEqual([]);
  expect(ops(await host.snapshot(id)).map((o) => o.status)).toEqual(["expired"]);
});

test("a library change that alters the target ends the waiting card by itself", async () => {
  script = [() => attach(W_REFRESH), () => ({ text: "expired" })];
  const view = page();
  const id = await start(view);
  await card(id);
  // The user (the page) sets another main Doc / changes the Work's Docs: the card no longer describes it.
  const raw = disk();
  raw.works[1].doc_ids = [REFRESH_DOC, "other-doc"];
  writeFileSync(paths.libraryJson, JSON.stringify(raw, null, 2));
  const res = await app.request("/api/library/refs", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: W_REFRESH, doc_id: "other-doc" }),
  });
  expect(res.status).toBe(200);
  await settled(id);
  expect(jobsOf()).toHaveLength(0);
  expect(ops(await host.snapshot(id)).map((o) => o.status)).toEqual(["expired"]);
});

test("Stop while the refresh waits withdraws it: nothing is replaced, no job starts, no later step runs", async () => {
  script = [() => attach(W_REFRESH), () => ({ text: "must not run" })];
  const id = await start(page());
  await card(id);
  expect((await request(`/conversations/${id}/stop`, "POST")).status).toBe(200);
  await settled(id);
  expect(jobsOf()).toHaveLength(0);
  expect(refreshIrBytes()).toContain("Hello world");
  expect(seen).toHaveLength(1);
  expect((await host.snapshot(id)).confirmations).toEqual([]);
});

test("a restart revives no authorization and the resume note says nothing was replaced", async () => {
  script = [() => attach(W_REFRESH), () => ({ text: "after restart" })];
  const view = page();
  const id = await start(view);
  const shown = await card(id);
  const irBefore = refreshIrBytes();
  host = new CopilotHost(join(root, "data"), settings, () => {});
  makeApp();
  const restarted = await host.snapshot(id);
  expect(restarted.conversation.run?.status).toBe("interrupted");
  expect(restarted.confirmations).toEqual([]);
  expect(ops(restarted).map((o) => o.status)).toEqual(["expired"]);
  expect((await request(`/views/${view.viewId}`, "PUT", view)).status).toBe(200);
  expect((await answerCard(shown, view.viewId, "approve")).status).toBe(404);
  expect(jobsOf()).toHaveLength(0);
  expect(refreshIrBytes()).toBe(irBefore);
  const resumed = await request(`/conversations/${id}/resume`, "POST", {
    clientMessageId: randomUUID(),
    viewId: view.viewId,
    contextRevision: view.revision,
  });
  expect(resumed.status).toBe(202);
  await settled(id);
  const transcript = JSON.stringify(seen.at(-1)?.messages);
  expect(transcript).toContain("nothing was replaced and no job was started");
  expect(transcript).toContain("Jobs you submitted before the run ended");
  expect(jobsOf()).toHaveLength(0);
});

test("a target that no longer exists is refused up front with no card", async () => {
  rmSync(join(paths.outputDir, REFRESH_DOC), { recursive: true });
  let payload: Record<string, unknown> = {};
  script = [
    () => attach(W_REFRESH),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "done" };
    },
  ];
  const { id } = await run(page());
  expect(payload).toMatchObject({ ok: false, status: "rejected" });
  expect(String(payload.detail)).toContain("no longer exists");
  expect((await host.snapshot(id)).confirmations).toEqual([]);
  expect(jobsOf()).toHaveLength(0);
});

test("a target that is busy (a job is writing it) is refused up front: the dialog's risk step would block the submit too", async () => {
  const hold = gate();
  const entered = gate();
  const base = pipelines.ingestArxivEprint;
  pipelines.ingestArxivEprint = async (arxivId, opts) => {
    entered.open();
    await hold.opened;
    return base(arxivId, opts);
  };
  // The page's own refresh is running and pins the Doc.
  const ui = await app.request(`/api/library/attach-arxiv?id=${encodeURIComponent(W_REFRESH)}`, {
    method: "POST",
  });
  expect(ui.status).toBe(202);
  await entered.opened;
  let payload: Record<string, unknown> = {};
  script = [
    () => attach(W_REFRESH),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "done" };
    },
  ];
  const { id } = await run(page());
  expect(payload).toMatchObject({ ok: false, status: "rejected" });
  expect(String(payload.detail)).toContain("busy");
  expect((await host.snapshot(id)).confirmations).toEqual([]);
  expect(jobsOf("ingest")).toHaveLength(1); // only the page's job
  hold.open();
  await runner.waitFor(jobsOf("ingest")[0]?.id as string);
});

// ---- read_jobs and the boundary --------------------------------------------------------------------- //
test("read_jobs shows the Files tab's lines: newest first, only the asked work, with progress, error, errorCode and the Doc", async () => {
  // One done and one failed job for W_DOCLESS, one for W_PDFONLY.
  const ok = await app.request(
    `/api/library/acquire-arxiv-pdf?id=${encodeURIComponent(W_DOCLESS)}`,
    { method: "POST" }
  );
  await runner.waitFor(((await ok.json()) as { job: Job }).job.id);
  pdfFetch = async () => {
    throw new Error("arXiv said no");
  };
  const bad = await app.request(
    `/api/library/acquire-arxiv-pdf?id=${encodeURIComponent(W_DOCLESS)}`,
    { method: "POST" }
  );
  await runner.waitFor(((await bad.json()) as { job: Job }).job.id);
  const other = await app.request(
    `/api/library/acquire-arxiv-pdf?id=${encodeURIComponent(W_PDFONLY)}`,
    { method: "POST" }
  );
  await runner.waitFor(((await other.json()) as { job: Job }).job.id);
  const lines: Record<string, unknown>[] = [];
  script = [
    () => toolCall({ action: "read_jobs", refId: W_DOCLESS }),
    (ctx) => {
      lines.push(lastResult(ctx));
      return toolCall({ action: "read_jobs" });
    },
    (ctx) => {
      lines.push(lastResult(ctx));
      return toolCall({ action: "read_jobs", refId: W_DOCLESS, path: "/etc/passwd" });
    },
    (ctx) => {
      lines.push({ raw: JSON.stringify(ctx.messages.at(-1)) });
      return { text: "done" };
    },
  ];
  await run(page());
  const mine = lines[0]?.jobs as {
    status: string;
    workId: string;
    error: string | null;
    docId?: string;
    format?: string;
    progress: string | null;
  }[];
  expect(mine.map((j) => j.status)).toEqual(["failed", "done"]);
  expect(mine.every((j) => j.workId === W_DOCLESS)).toBe(true);
  expect(mine[0]).toMatchObject({ error: "arXiv said no", format: "arxiv-pdf" });
  expect(mine[1]?.docId).toMatch(/^pdf-/);
  expect(mine[1]?.progress).toBe("Publishing PDF Doc");
  expect((lines[1]?.jobs as unknown[] | undefined)?.length).toBe(3);
  expect(String(lines[2]?.raw)).toContain("Validation failed");
});

test("there is no path, URL or file field in the tool: such a call is refused by the closed schema and nothing runs", async () => {
  const before = bytes();
  const calls: Record<string, unknown>[] = [
    { action: "upload_pdf", refId: W_DOCLESS, path: "/etc/hosts" },
    { action: "upload_latex_zip", refId: W_DOCLESS, url: "https://example.org/a.zip" },
    { action: "acquire_arxiv_pdf", refId: W_DOCLESS, path: "/etc/hosts" },
    { action: "acquire_arxiv_pdf", refId: W_DOCLESS, url: "https://example.org/a.pdf" },
    { action: "attach_arxiv", refId: W_DOCLESS, file: "a.zip" },
    { action: "acquire_arxiv_pdf" },
  ];
  const answers: string[] = [];
  const raw = (ctx: TranscriptContext) => {
    const last = ctx.messages.filter((m) => m.role === "toolResult").at(-1);
    const part = last?.role === "toolResult" ? last.content[0] : undefined;
    return part && part.type === "text" ? part.text : "";
  };
  script = [
    ...calls.map(
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
  expect(answers).toHaveLength(calls.length);
  for (const answer of answers.slice(0, 5)) expect(answer).toContain("Validation failed");
  expect(JSON.parse(answers[5] as string)).toMatchObject({ ok: false, status: "unsupported" });
  expect(ops(snapshot).filter((o) => o.status === "ok")).toEqual([]);
  expect(jobsOf()).toHaveLength(0);
  expect(bytes()).toBe(before);
});

test("the prompt and the tool say what the agent can and cannot do with acquisition", async () => {
  script = [() => ({ call: { action: "read", limit: 1 } }), () => ({ text: "ok" })];
  await run(page());
  const tool = getCurrentTools(seen[0]?.messages ?? []).find((t) => t.name === "library");
  for (const phrase of [
    "acquire_arxiv_pdf",
    "attach_arxiv",
    "read_jobs",
    "NEW PDF Doc",
    "pending means",
    "waits for the user's confirmation card",
    "upload_pdf",
    "upload_latex_zip",
    "replace_upload_source",
    "never get a path, a URL or the bytes",
    "Stop never cancels a submitted job",
  ])
    expect(tool?.description, phrase).toContain(phrase);
  expect(tool?.description).not.toContain("fetches full text");
  const sent = JSON.stringify(seen[0]?.messages);
  expect(sent).toMatch(/acquire_arxiv_pdf fetches the current arXiv PDF as a new Doc/);
  expect(sent).toMatch(/only when the user attached it to a message of this conversation/);
  expect(sent).toMatch(/pending means it had not finished/);
});

// ---- repair round 1 --------------------------------------------------------------------------------- //
const putLib = async (method: string, path: string, body: unknown) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const BIB_ONE =
  "@article{freshA,\n  author = {Doe, J.},\n  title = {A fresh paper},\n  year = {2024}\n}\n";

test("D1: an import and a field edit made while the LaTeX attach compiles survive it, and unknown keys and the bib are right", async () => {
  const hold = gate();
  const entered = gate();
  const base = pipelines.ingestArxivEprint;
  pipelines.ingestArxivEprint = async (arxivId, opts) => {
    entered.open();
    await hold.opened;
    return base(arxivId, opts);
  };
  let payload: Record<string, unknown> = {};
  script = [
    () => attach(W_DOCLESS),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "done" };
    },
  ];
  const id = await start(page());
  await entered.opened;
  // While the job compiles (outside the lock), the user imports a Work and edits another field.
  const imported = await putLib("POST", "/api/library/works", { mode: "bib", bib: BIB_ONE });
  expect(imported.status).toBe(200);
  expect((await putLib("PATCH", "/api/library/refs", { id: W_DOCLESS, star: true })).status).toBe(
    200
  );
  hold.open();
  await settled(id);
  expect(payload).toMatchObject({ ok: true, status: "ok", docId: "arxiv-2603.00001" });
  const after = disk();
  const titles = after.works.map((w: { title: string }) => w.title);
  expect(titles).toContain("A fresh paper"); // the import is still there
  expect(workOnDisk(W_DOCLESS)).toMatchObject({ star: true, doc_ids: ["arxiv-2603.00001"] });
  expect(after.works).toHaveLength(6);
  keptUnknownKeys(); // x_top, project, x_work, x_other all survive the attach and its rebuild
  // library.bib is the typed projection of the resulting file, byte for byte.
  expect(readFileSync(paths.libraryBib, "utf8")).toBe(LibraryStore.load(paths).toBibtex());
  expect(readFileSync(paths.libraryBib, "utf8")).toContain("A fresh paper");
});

test("D1: a concurrent main-Doc change on a PDF-only work survives the LaTeX append", async () => {
  const pdf = publishPdfDoc(paths, {
    workId: W_PDFONLY,
    filename: "mine.pdf",
    bytes: readFileSync(PDF_FIXTURE),
    pages: [{ width: 612, height: 792, rotation: 0 }],
  });
  const second = publishPdfDoc(paths, {
    workId: W_PDFONLY,
    filename: "second.pdf",
    bytes: readFileSync(PDF_FIXTURE),
    pages: [{ width: 612, height: 792, rotation: 0 }],
    deduplicate: false,
  });
  const hold = gate();
  const entered = gate();
  const base = pipelines.ingestArxivEprint;
  pipelines.ingestArxivEprint = async (arxivId, opts) => {
    entered.open();
    await hold.opened;
    return base(arxivId, opts);
  };
  script = [() => attach(W_PDFONLY), () => ({ text: "done" })];
  const id = await start(page());
  await entered.opened;
  expect(
    (await putLib("PATCH", "/api/library/refs", { id: W_PDFONLY, doc_id: second.doc_id })).status
  ).toBe(200);
  hold.open();
  await settled(id);
  expect(workOnDisk(W_PDFONLY).doc_ids).toEqual([second.doc_id, pdf.doc_id, "arxiv-2603.00005"]);
  keptUnknownKeys();
});

test("D2: a library refresh through the page also keeps unknown keys, and the bib is the typed projection", async () => {
  const res = await app.request("/api/library/refresh?offline=true", { method: "POST" });
  expect(res.status).toBe(200);
  keptUnknownKeys();
  expect(readFileSync(paths.libraryBib, "utf8")).toBe(LibraryStore.load(paths).toBibtex());
});

test("D3: the risk read for the card never archives; a Doc replaced by the page while the card waits ends the card and is archived only by a normal access", async () => {
  await annotate(2);
  const before = annotationFiles();
  script = [() => attach(W_REFRESH), () => ({ text: "waiting" })];
  const view = page();
  const id = await start(view);
  const shown = await card(id);
  expect((shown as { impact?: unknown }).impact).toEqual({ annotations: "known", count: 2 });
  const events = () => broadcasts.filter((m) => m.type === "annotation.changed");
  expect(events()).toHaveLength(1); // only the user's own annotate() PUT
  // The page (another refresh) replaces the Doc's text under the waiting card.
  writeFileSync(
    join(paths.outputDir, REFRESH_DOC, `${REFRESH_DOC}.json`),
    JSON.stringify(refreshIr("A replaced text"))
  );
  expect((await putLib("PATCH", "/api/library/refs", { id: W_REFRESH, star: true })).status).toBe(
    200
  ); // library.changed → revalidation
  await settled(id);
  expect(ops(await host.snapshot(id)).map((o) => o.status)).toEqual(["expired"]);
  // Nothing archived and no invalidate broadcast came from the card, the revalidation or the expiry.
  expect(annotationFiles()).toEqual(before);
  expect(events()).toHaveLength(1);
  // The user's normal access (the page's GET) is what archives.
  const got = (await (
    await app.request(`/api/paper/${REFRESH_DOC}/annotations`)
  ).json()) as AnnotationsFile;
  expect(got.annotations).toEqual([]);
  expect(annotationFiles().archive).toHaveLength(1);
  expect(events().at(-1)).toMatchObject({ cause: "invalidate" });
});

test("D3: a Doc that is already stale when asked shows 0 annotations on the card and still nothing is archived", async () => {
  await annotate(2);
  writeFileSync(
    join(paths.outputDir, REFRESH_DOC, `${REFRESH_DOC}.json`),
    JSON.stringify(refreshIr("Replaced before the request"))
  );
  const before = annotationFiles();
  script = [() => attach(W_REFRESH), () => ({ text: "waiting" })];
  const view = page();
  const id = await start(view);
  const shown = await card(id);
  expect((shown as { impact?: unknown }).impact).toEqual({ annotations: "known", count: 0 });
  expect(annotationFiles()).toEqual(before);
  expect((await answerCard(shown, view.viewId, "decline")).status).toBe(200);
  await settled(id);
  expect(annotationFiles()).toEqual(before); // declining, too, writes nothing
});

test("D3: an unreadable annotation store is an unknown-count card, never a guessed count", async () => {
  mkdirSync(join(paths.dataDir, "annotations", REFRESH_DOC), { recursive: true });
  writeFileSync(join(paths.dataDir, "annotations", REFRESH_DOC, "current.json"), "{ not json");
  script = [() => attach(W_REFRESH), () => ({ text: "waiting" })];
  const id = await start(page());
  const shown = await card(id);
  expect((shown as { impact?: unknown }).impact).toEqual({ annotations: "unknown" });
  expect(
    readFileSync(join(paths.dataDir, "annotations", REFRESH_DOC, "current.json"), "utf8")
  ).toBe("{ not json");
});

test("N1: the journal names the job right after the submit, so a restart's resume note can point at it", async () => {
  const hold = gate();
  const entered = gate();
  pdfFetch = async () => {
    entered.open();
    await hold.opened;
    return readFileSync(PDF_FIXTURE);
  };
  script = [() => acquirePdf(W_DOCLESS), () => ({ text: "after restart" })];
  const view = page();
  const id = await start(view);
  await entered.opened;
  const jobId = jobsOf("upload")[0]?.id as string;
  host = new CopilotHost(join(root, "data"), settings, () => {});
  makeApp();
  expect((await host.snapshot(id)).conversation.run?.status).toBe("interrupted");
  expect((await request(`/views/${view.viewId}`, "PUT", view)).status).toBe(200);
  const resumed = await request(`/conversations/${id}/resume`, "POST", {
    clientMessageId: randomUUID(),
    viewId: view.viewId,
    contextRevision: view.revision,
  });
  expect(resumed.status).toBe(202);
  await settled(id);
  const transcript = JSON.stringify(seen.at(-1)?.messages);
  expect(transcript).toContain(`(job ${jobId})`);
  hold.open();
});

test("N4: repeating a pending operation returns the job's state now, with the Doc once it finished", async () => {
  waitMs = 100;
  makeApp();
  const hold = gate();
  pdfFetch = async () => {
    await hold.opened;
    return readFileSync(PDF_FIXTURE);
  };
  const results: Record<string, unknown>[] = [];
  script = [
    () => acquirePdf(W_DOCLESS, { operationId: "acq-pending" }),
    (ctx) => {
      results.push(lastResult(ctx));
      return { text: "pending" };
    },
  ];
  const first = page();
  const { id } = await run(first);
  expect(results[0]).toMatchObject({ status: "pending" });
  hold.open();
  await runner.waitFor(jobsOf("upload")[0]?.id as string);
  script = [
    () => acquirePdf(W_DOCLESS, { operationId: "acq-pending" }),
    (ctx) => {
      results.push(lastResult(ctx));
      return { text: "now" };
    },
  ];
  seen = [];
  // The same conversation asks again (the journal is per conversation).
  const sent = await request(`/conversations/${id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text: "Check again",
    viewId: first.viewId,
    contextRevision: first.revision,
  });
  expect(sent.status).toBe(202);
  await vi.waitFor(() => expect(results).toHaveLength(2), { timeout: 8000 });
  await settled(id);
  const snapshot = await host.snapshot(id);
  expect(results[1]).toMatchObject({
    ok: true,
    status: "ok",
    duplicate: true,
    job: { status: "done" },
  });
  expect(String(results[1]?.docId)).toMatch(/^pdf-/);
  expect(jobsOf("upload")).toHaveLength(1);
  expect(ops(snapshot).at(-1)).toMatchObject({ status: "ok", docId: results[1]?.docId });
});

test("S1: a library that cannot be loaded is the framework's own 500 for the PDF route, with no parse error in the body", async () => {
  writeFileSync(paths.libraryJson, "{ definitely not json");
  const res = await app.request(
    `/api/library/acquire-arxiv-pdf?id=${encodeURIComponent(W_DOCLESS)}`,
    { method: "POST" }
  );
  expect(res.status).toBe(500);
  expect(await res.text()).not.toContain("JSON");
});

test("S3/S4: the prompt points library unknowns at the work and read_jobs, and a failed job says what it may have left", async () => {
  pdfFetch = async () => {
    throw new Error("arXiv said no");
  };
  let payload: Record<string, unknown> = {};
  script = [
    () => acquirePdf(W_DOCLESS),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "failed" };
    },
  ];
  await run(page());
  expect(String(payload.detail)).toContain("unlinked bundle");
  expect(String(payload.detail)).toContain(
    "already have linked the Doc when the later index rebuild failed"
  );
  expect(JSON.stringify(seen[0]?.messages)).toContain("for library calls: the work, and read_jobs");
});

// ---- ticket 15 round 2: user attachments, uploads by attachment id ---------------------------------- //
const PDF_BYTES = () => readFileSync(PDF_FIXTURE);
const LATEX_ZIP = () =>
  makeZip({ "main.tex": "\\documentclass{article}\\begin{document}Hello\\end{document}\n" });
type Pick = { name: string; bytes: Buffer; type?: string };
const attachmentsRoot = () => join(paths.dataDir, "copilot", "attachments");
async function newConversation(): Promise<string> {
  const created = (await (
    await request("/conversations", "POST", { model: choice })
  ).json()) as ConversationSnapshot;
  return created.conversation.id;
}
/** The attachment ids the model was told about, read from the user envelopes it received. */
const attachedIds = (ctx: TranscriptContext): string[] =>
  ctx.messages.flatMap((m) => {
    if (m.role !== "user") return [];
    const text =
      typeof m.content === "string"
        ? m.content
        : m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
    try {
      return ((JSON.parse(text) as { attachments?: { id: string }[] }).attachments ?? []).map(
        (a) => a.id
      );
    } catch {
      return [];
    }
  });
async function rawAttach(conversationId: string, pick: Pick) {
  return app.request(`/api/copilot/conversations/${conversationId}/attachments`, {
    method: "POST",
    headers: {
      "Content-Type": pick.type ?? "application/octet-stream",
      "X-Filename": encodeURIComponent(pick.name),
    },
    body: pick.bytes,
  });
}
/** Create a conversation, hand it files and send one message that carries them. */
async function startWithFiles(context: PageContext, picks: Pick[], text = "Use my file") {
  const id = await newConversation();
  const ids: string[] = [];
  for (const pick of picks) {
    const res = await rawAttach(id, pick);
    expect(res.status).toBe(201);
    ids.push(((await res.json()) as { id: string }).id);
  }
  expect((await request(`/views/${context.viewId}`, "PUT", context)).status).toBe(200);
  const sent = await request(`/conversations/${id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text,
    viewId: context.viewId,
    contextRevision: context.revision,
    attachmentIds: ids,
  });
  expect(sent.status).toBe(202);
  return { id, ids };
}
const uploadPdf = (refId: string, attachmentId: string, extra: Record<string, unknown> = {}) =>
  toolCall({ action: "upload_pdf", refId, attachmentId, ...extra });
const uploadZip = (refId: string, attachmentId: string) =>
  toolCall({ action: "upload_latex_zip", refId, attachmentId });
const replaceZip = (refId: string, docId: string, attachmentId: string) =>
  toolCall({ action: "replace_upload_source", refId, docId, attachmentId });

test("A1: a chosen file is stored by the application under dataDir/copilot with id, name, size, type and sha256, written atomically", async () => {
  const id = await newConversation();
  const bytes = PDF_BYTES();
  const res = await rawAttach(id, { name: "../../evil/paper.pdf", bytes, type: "application/pdf" });
  expect(res.status).toBe(201);
  const meta = (await res.json()) as Record<string, unknown>;
  expect(meta).toMatchObject({
    filename: "paper.pdf",
    size: bytes.length,
    contentType: "application/pdf",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  const dir = join(attachmentsRoot(), id);
  expect(readdirSync(dir).sort()).toEqual([`${meta.id}.bin`, `${meta.id}.json`]); // no temp files left
  expect(readFileSync(join(dir, `${meta.id}.bin`)).equals(bytes)).toBe(true);
  // Not a Reader Doc and not in the library.
  expect(readdirSync(paths.outputDir).filter((n) => n.includes(String(meta.id)))).toEqual([]);
  expect(disk().works).toHaveLength(5);
});

test("A1: an empty file, an over-size file and an unknown conversation store nothing", async () => {
  const id = await newConversation();
  expect((await rawAttach(id, { name: "e.pdf", bytes: Buffer.alloc(0) })).status).toBe(400);
  expect(
    (await rawAttach(id, { name: "big.pdf", bytes: Buffer.alloc(50 * 1024 * 1024 + 1, 1) })).status
  ).toBe(413);
  expect((await rawAttach(randomUUID(), { name: "a.pdf", bytes: PDF_BYTES() })).status).toBe(404);
  expect(
    existsSync(join(attachmentsRoot(), id)) ? readdirSync(join(attachmentsRoot(), id)) : []
  ).toEqual([]);
});

test("A1: only ids and metadata reach the model with the message; the bytes never do, and the message shows the file", async () => {
  const bytes = PDF_BYTES();
  script = [() => ({ text: "seen" })];
  const { id, ids } = await startWithFiles(page(), [
    { name: "mine.pdf", bytes, type: "application/pdf" },
  ]);
  await settled(id);
  const sentToModel = JSON.stringify(seen[0]?.messages);
  expect(sentToModel).toContain(ids[0]);
  expect(sentToModel).toContain("mine.pdf");
  expect(sentToModel).toContain(createHash("sha256").update(bytes).digest("hex"));
  const user = (await host.snapshot(id)).messages.find((m) => m.role === "user");
  expect(user?.attachments?.map((a) => a.filename)).toEqual(["mine.pdf"]);
});

test("A1: an unsent attachment can be removed; a sent one stays part of the record; a foreign or forged id refuses the message", async () => {
  const id = await newConversation();
  const other = await newConversation();
  const keep = (
    (await (await rawAttach(id, { name: "a.pdf", bytes: PDF_BYTES() })).json()) as { id: string }
  ).id;
  const gone = (
    (await (await rawAttach(id, { name: "b.pdf", bytes: PDF_BYTES() })).json()) as { id: string }
  ).id;
  const foreign = (
    (await (await rawAttach(other, { name: "c.pdf", bytes: PDF_BYTES() })).json()) as { id: string }
  ).id;
  const del = (conv: string, att: string) =>
    request(`/conversations/${conv}/attachments/${att}`, "DELETE");
  expect((await del(id, gone)).status).toBe(200);
  expect(existsSync(join(attachmentsRoot(), id, `${gone}.bin`))).toBe(false);
  expect((await del(id, foreign)).status).toBe(404); // another conversation's file is not this one's
  const view = page();
  expect((await request(`/views/${view.viewId}`, "PUT", view)).status).toBe(200);
  const send = (attachmentIds: string[]) =>
    request(`/conversations/${id}/messages`, "POST", {
      clientMessageId: randomUUID(),
      text: "go",
      viewId: view.viewId,
      contextRevision: view.revision,
      attachmentIds,
    });
  expect((await send([foreign])).status).toBe(404);
  expect((await send([randomUUID()])).status).toBe(404);
  expect((await send([gone])).status).toBe(404);
  expect(seen).toHaveLength(0); // none of them started a run
  script = [() => ({ text: "ok" })];
  expect((await send([keep])).status).toBe(202);
  await settled(id);
  expect((await del(id, keep)).status).toBe(409); // sent: stays
  expect(existsSync(join(attachmentsRoot(), id, `${keep}.bin`))).toBe(true);
  expect((await send([keep])).status).toBe(400); // and cannot be sent twice
});

test("A2: upload_pdf with an attached file is the page's own upload: same job, new Doc, unknown keys kept; the agent never sees the bytes", async () => {
  let payload: Record<string, unknown> = {};
  script = [
    (ctx) => uploadPdf(W_DOCLESS, attachedIds(ctx)[0] as string),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "done" };
    },
  ];
  const { id } = await startWithFiles(page(), [
    { name: "mine.pdf", bytes: PDF_BYTES(), type: "application/pdf" },
  ]);
  await settled(id);
  expect(payload).toMatchObject({ ok: true, status: "ok", job: { status: "done" } });
  const docId = payload.docId as string;
  expect(docId).toMatch(/^pdf-/);
  expect(runner.get((payload.job as { id: string }).id)).toMatchObject({
    kind: "upload",
    payload: { workId: W_DOCLESS, format: "pdf" },
  });
  const metadata = JSON.parse(readFileSync(join(paths.outputDir, docId, `${docId}.json`), "utf8"));
  expect(metadata).toMatchObject({
    format: "pdf",
    acquired_via: "user_pdf_upload",
    original_filename: "mine.pdf",
  });
  expect(workOnDisk(W_DOCLESS).doc_ids).toEqual([docId]);
  keptUnknownKeys();
  expect(JSON.stringify(seen.at(-1)?.messages)).not.toContain(
    PDF_BYTES().toString("base64").slice(0, 60)
  );
});

test("A2: identical bytes on the same work return the existing Doc (noop); another work gets its own Doc; the main Doc is not displaced", async () => {
  const results: Record<string, unknown>[] = [];
  script = [
    (ctx) => uploadPdf(W_DOCLESS, attachedIds(ctx)[0] as string),
    (ctx) => {
      results.push(lastResult(ctx));
      return uploadPdf(W_DOCLESS, attachedIds(ctx)[0] as string);
    },
    (ctx) => {
      results.push(lastResult(ctx));
      return uploadPdf(W_REFRESH, attachedIds(ctx)[0] as string);
    },
    (ctx) => {
      results.push(lastResult(ctx));
      return { text: "done" };
    },
  ];
  const { id } = await startWithFiles(page(), [{ name: "mine.pdf", bytes: PDF_BYTES() }]);
  await settled(id);
  expect(results[1]).toMatchObject({ ok: true, status: "noop", docId: results[0]?.docId });
  expect(workOnDisk(W_DOCLESS).doc_ids).toEqual([results[0]?.docId]);
  expect(results[2]?.docId).not.toBe(results[0]?.docId);
  expect((workOnDisk(W_REFRESH).doc_ids as string[])[0]).toBe(REFRESH_DOC);
  expect(pdfDirs()).toHaveLength(2);
});

test("A2: an unsent, foreign, forged or wrongly named attachment is refused before any job", async () => {
  const other = await newConversation();
  const foreign = (
    (await (await rawAttach(other, { name: "x.pdf", bytes: PDF_BYTES() })).json()) as { id: string }
  ).id;
  const unsent = (
    (await (
      await rawAttach(await newConversation(), { name: "u.pdf", bytes: PDF_BYTES() })
    ).json()) as { id: string }
  ).id;
  const answers: Record<string, unknown>[] = [];
  script = [
    () => uploadPdf(W_DOCLESS, foreign),
    (ctx) => {
      answers.push(lastResult(ctx));
      return uploadPdf(W_DOCLESS, randomUUID());
    },
    (ctx) => {
      answers.push(lastResult(ctx));
      return uploadPdf(W_DOCLESS, unsent);
    },
    (ctx) => {
      answers.push(lastResult(ctx));
      return uploadPdf(W_DOCLESS, attachedIds(ctx)[0] as string); // a .zip named file for upload_pdf
    },
    (ctx) => {
      answers.push(lastResult(ctx));
      return { text: "done" };
    },
  ];
  const before = bytes();
  const { id } = await startWithFiles(page(), [{ name: "notes.zip", bytes: LATEX_ZIP() }]);
  await settled(id);
  expect(answers.slice(0, 3).map((a) => a.status)).toEqual(["not_found", "not_found", "not_found"]);
  expect(answers[3]).toMatchObject({ ok: false, status: "rejected" });
  expect(jobsOf()).toHaveLength(0);
  expect(bytes()).toBe(before);
});

test("A2/A3: upload_latex_zip makes the upload Doc main and keeps imports and edits made while it was ingested, unknown keys and the bib", async () => {
  const hold = gate();
  const entered = gate();
  const base = pipelines.ingestLatexZip;
  pipelines.ingestLatexZip = async (zipPath, opts) => {
    entered.open();
    await hold.opened;
    return base(zipPath, opts);
  };
  let payload: Record<string, unknown> = {};
  script = [
    (ctx) => uploadZip(W_DOCLESS, attachedIds(ctx)[0] as string),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "done" };
    },
  ];
  const { id } = await startWithFiles(page(), [
    { name: "src.zip", bytes: LATEX_ZIP(), type: "application/zip" },
  ]);
  await entered.opened;
  expect((await putLib("POST", "/api/library/works", { mode: "bib", bib: BIB_ONE })).status).toBe(
    200
  );
  expect((await putLib("PATCH", "/api/library/refs", { id: W_DOCLESS, star: true })).status).toBe(
    200
  );
  hold.open();
  await settled(id);
  const docId = uploadDocId(W_DOCLESS);
  expect(payload).toMatchObject({ ok: true, status: "ok", docId, job: { status: "done" } });
  expect(runner.get((payload.job as { id: string }).id)).toMatchObject({
    kind: "upload",
    payload: { workId: W_DOCLESS },
  });
  const after = disk();
  expect(after.works.map((w: { title: string }) => w.title)).toContain("A fresh paper");
  expect(after.works).toHaveLength(6);
  expect(workOnDisk(W_DOCLESS)).toMatchObject({ star: true, doc_ids: [docId] });
  keptUnknownKeys();
  expect(readFileSync(paths.libraryBib, "utf8")).toBe(LibraryStore.load(paths).toBibtex());
});

test("A2: upload_latex_zip for a work that already has an uploaded source points at replace_upload_source and starts nothing", async () => {
  const answers: Record<string, unknown>[] = [];
  script = [
    (ctx) => uploadZip(W_DOCLESS, attachedIds(ctx)[0] as string),
    (ctx) => {
      answers.push(lastResult(ctx));
      return uploadZip(W_DOCLESS, attachedIds(ctx)[0] as string);
    },
    (ctx) => {
      answers.push(lastResult(ctx));
      return { text: "done" };
    },
  ];
  const { id } = await startWithFiles(page(), [{ name: "src.zip", bytes: LATEX_ZIP() }]);
  await settled(id);
  expect(answers[0]).toMatchObject({ ok: true, status: "ok" });
  expect(answers[1]).toMatchObject({ ok: false, status: "rejected" });
  expect(String(answers[1]?.detail)).toContain("replace_upload_source");
  expect(jobsOf("upload")).toHaveLength(1);
});

test("A2: a file that is not a zip is refused like the page refuses it, with no job", async () => {
  let payload: Record<string, unknown> = {};
  script = [
    (ctx) => uploadZip(W_DOCLESS, attachedIds(ctx)[0] as string),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "done" };
    },
  ];
  const before = bytes();
  const { id } = await startWithFiles(page(), [
    { name: "fake.zip", bytes: Buffer.from("not a zip at all") },
  ]);
  await settled(id);
  expect(payload).toMatchObject({ ok: false, status: "rejected" });
  expect(jobsOf()).toHaveLength(0);
  expect(bytes()).toBe(before);
});

// Replacement of an uploaded source: first make the Work have one, with annotations on it.
async function seedUploadDoc(): Promise<string> {
  const docId = uploadDocId(W_DOCLESS);
  const dir = join(paths.outputDir, docId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${docId}.json`),
    JSON.stringify({
      ...refreshIr(),
      docId,
      source: { type: "latex", origin: "/tmp/src", main_tex: "main.tex" },
    })
  );
  const raw = disk();
  raw.works[0].doc_ids = [docId];
  writeFileSync(paths.libraryJson, JSON.stringify(raw, null, 2));
  const url = `/api/paper/${docId}/annotations`;
  const current = (await (await app.request(url)).json()) as AnnotationsFile;
  const put = await app.request(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      version: 1,
      rev: current.rev,
      content_fingerprint: current.content_fingerprint,
      annotations: [annotation(1), annotation(2), annotation(3)],
    }),
  });
  expect(put.status).toBe(200);
  return docId;
}
const uploadIr = (docId: string) =>
  readFileSync(join(paths.outputDir, docId, `${docId}.json`), "utf8");

test("A2: replace_upload_source waits for the user: the card names the file and the annotation count, nothing is written meanwhile", async () => {
  const docId = await seedUploadDoc();
  const irBefore = uploadIr(docId);
  const libBefore = bytes();
  script = [
    (ctx) => replaceZip(W_DOCLESS, docId, attachedIds(ctx)[0] as string),
    () => ({ text: "waiting" }),
  ];
  const view = page();
  const { id } = await startWithFiles(view, [{ name: "new-src.zip", bytes: LATEX_ZIP() }]);
  const shown = await card(id);
  expect(shown).toMatchObject({
    action: "replace_upload_source",
    object: { kind: "doc", id: docId, workId: W_DOCLESS },
    impact: { annotations: "known", count: 3 },
    attachment: { filename: "new-src.zip" },
  });
  expect(jobsOf()).toHaveLength(0);
  expect(uploadIr(docId)).toBe(irBefore);
  expect(bytes()).toBe(libBefore);
  expect((await host.snapshot(id)).conversation.run?.status).toBe("waiting-for-user");
  await request(`/conversations/${id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text: "I approve the replacement",
    viewId: view.viewId,
    contextRevision: view.revision,
  });
  expect(jobsOf()).toHaveLength(0); // chat cannot approve
  expect((await answerCard(shown, view.viewId, "decline")).status).toBe(200);
  await settled(id);
  expect(uploadIr(docId)).toBe(irBefore);
  expect(jobsOf()).toHaveLength(0);
  expect(ops(await host.snapshot(id)).map((o) => o.status)).toContain("declined");
});

test("A2: approving the replacement runs the page's zip job, replaces the Doc in place and keeps unknown keys", async () => {
  const docId = await seedUploadDoc();
  let payload: Record<string, unknown> = {};
  script = [
    (ctx) => replaceZip(W_DOCLESS, docId, attachedIds(ctx)[0] as string),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "replaced" };
    },
  ];
  const view = page();
  const { id } = await startWithFiles(view, [{ name: "new-src.zip", bytes: LATEX_ZIP() }]);
  const shown = await card(id);
  expect((await answerCard(shown, view.viewId, "approve")).status).toBe(200);
  await settled(id);
  expect(payload).toMatchObject({ ok: true, status: "ok", docId, job: { status: "done" } });
  expect(uploadIr(docId)).toContain("Stub LaTeX of");
  expect(workOnDisk(W_DOCLESS).doc_ids).toEqual([docId]);
  keptUnknownKeys();
  expect(jobsOf("upload")).toHaveLength(1);
});

test("A2: an annotation added while the replacement card waits expires it; a Doc that is not the upload source is refused up front", async () => {
  const docId = await seedUploadDoc();
  const answers: Record<string, unknown>[] = [];
  script = [
    (ctx) => replaceZip(W_DOCLESS, "arxiv-2603.99999", attachedIds(ctx)[0] as string),
    (ctx) => {
      answers.push(lastResult(ctx));
      return replaceZip(W_DOCLESS, docId, attachedIds(ctx)[0] as string);
    },
    (ctx) => {
      answers.push(lastResult(ctx));
      return { text: "done" };
    },
  ];
  const view = page();
  const { id } = await startWithFiles(view, [{ name: "new-src.zip", bytes: LATEX_ZIP() }]);
  const shown = await card(id);
  expect(answers[0]).toMatchObject({ ok: false, status: "rejected" });
  const url = `/api/paper/${docId}/annotations`;
  const current = (await (await app.request(url)).json()) as AnnotationsFile;
  await app.request(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      version: 1,
      rev: current.rev,
      content_fingerprint: current.content_fingerprint,
      annotations: [annotation(1)],
    }),
  });
  expect((await answerCard(shown, view.viewId, "approve")).status).toBe(409);
  await settled(id);
  expect(answers[1]).toMatchObject({ ok: false, status: "expired" });
  expect(jobsOf()).toHaveLength(0);
});

test("A2: Stop while the replacement waits withdraws it, and a restart revives no approval; nothing is replaced", async () => {
  const docId = await seedUploadDoc();
  script = [
    (ctx) => replaceZip(W_DOCLESS, docId, attachedIds(ctx)[0] as string),
    () => ({ text: "must not run" }),
  ];
  const view = page();
  const { id } = await startWithFiles(view, [{ name: "new-src.zip", bytes: LATEX_ZIP() }]);
  const shown = await card(id);
  const irBefore = uploadIr(docId);
  expect((await request(`/conversations/${id}/stop`, "POST")).status).toBe(200);
  await settled(id);
  expect(jobsOf()).toHaveLength(0);
  expect(uploadIr(docId)).toBe(irBefore);
  host = new CopilotHost(join(root, "data"), settings, () => {});
  makeApp();
  expect((await host.snapshot(id)).confirmations).toEqual([]);
  expect((await request(`/views/${view.viewId}`, "PUT", view)).status).toBe(200);
  expect((await answerCard(shown, view.viewId, "approve")).status).toBe(404);
  expect(jobsOf()).toHaveLength(0);
  expect(uploadIr(docId)).toBe(irBefore);
});

test("A3: the page's synchronous zip upload also keeps unknown keys through the narrow link", async () => {
  const res = await app.request(`/api/library/upload?id=${encodeURIComponent(W_DOCLESS)}&sync=1`, {
    method: "POST",
    body: LATEX_ZIP(),
  });
  expect(res.status).toBe(200);
  expect(workOnDisk(W_DOCLESS).doc_ids).toEqual([uploadDocId(W_DOCLESS)]);
  keptUnknownKeys();
});

test("A4: a rebuild that fails after it saved still gets the unknown keys back, and the failure is reported", async () => {
  mkdirSync(paths.graphJson, { recursive: true }); // the graph cache cannot be written: rebuild fails after saving library.json
  const res = await app.request("/api/library/refresh?offline=true", { method: "POST" });
  expect(res.status).toBe(500);
  keptUnknownKeys();
});

test("A1/A2: a file uploaded to this conversation but not sent with a message is not the agent's to use", async () => {
  const id = await newConversation();
  const sentFile = (
    (await (await rawAttach(id, { name: "sent.pdf", bytes: PDF_BYTES() })).json()) as { id: string }
  ).id;
  const heldBack = (
    (await (await rawAttach(id, { name: "held.pdf", bytes: PDF_BYTES() })).json()) as { id: string }
  ).id;
  let payload: Record<string, unknown> = {};
  script = [
    () => uploadPdf(W_DOCLESS, heldBack),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "done" };
    },
  ];
  const view = page();
  expect((await request(`/views/${view.viewId}`, "PUT", view)).status).toBe(200);
  const sent = await request(`/conversations/${id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text: "use the held back one",
    viewId: view.viewId,
    contextRevision: view.revision,
    attachmentIds: [sentFile],
  });
  expect(sent.status).toBe(202);
  await settled(id);
  expect(payload).toMatchObject({ ok: false, status: "not_found" });
  expect(jobsOf()).toHaveLength(0);
  expect(pdfDirs()).toEqual([]);
});

// ---- ticket 15 round 3 ------------------------------------------------------------------------------ //
const pageZip = (workId: string) =>
  app.request(`/api/library/upload?id=${encodeURIComponent(workId)}`, {
    method: "POST",
    body: LATEX_ZIP(),
  });

test("B1: a page upload that is queued or running is not stacked on or replaced by the agent's upload_latex_zip", async () => {
  const hold = gate();
  const entered = gate();
  const base = pipelines.ingestLatexZip;
  pipelines.ingestLatexZip = async (zipPath, opts) => {
    entered.open();
    await hold.opened;
    return base(zipPath, opts);
  };
  const page1 = await pageZip(W_DOCLESS);
  expect(page1.status).toBe(202);
  await entered.opened;
  const userJob = ((await page1.json()) as { job: Job }).job;
  let payload: Record<string, unknown> = {};
  script = [
    (ctx) => uploadZip(W_DOCLESS, attachedIds(ctx)[0] as string),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "done" };
    },
  ];
  const { id } = await startWithFiles(page(), [{ name: "agent.zip", bytes: LATEX_ZIP() }]);
  await settled(id);
  expect(payload).toMatchObject({ ok: false, status: "rejected" });
  expect(String(payload.detail)).toContain("already queued or running");
  expect(jobsOf("upload")).toHaveLength(1); // only the user's job
  expect((await host.snapshot(id)).confirmations).toEqual([]);
  hold.open();
  expect((await runner.waitFor(userJob.id)).status).toBe("done");
});

test("B1: an agent zip job that finds an uploaded source on its turn ends skipped and writes nothing", async () => {
  // A long job ahead in the serial queue, so the agent's job waits and the situation can change meanwhile.
  const hold = gate();
  const entered = gate();
  pdfFetch = async () => {
    entered.open();
    await hold.opened;
    return readFileSync(PDF_FIXTURE);
  };
  expect(
    (
      await app.request(`/api/library/acquire-arxiv-pdf?id=${encodeURIComponent(W_PDFONLY)}`, {
        method: "POST",
      })
    ).status
  ).toBe(202);
  await entered.opened;
  let payload: Record<string, unknown> = {};
  script = [
    (ctx) => uploadZip(W_DOCLESS, attachedIds(ctx)[0] as string),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "done" };
    },
  ];
  const { id } = await startWithFiles(page(), [{ name: "agent.zip", bytes: LATEX_ZIP() }]);
  await vi.waitFor(() => expect(jobsOf("upload")).toHaveLength(2), { timeout: 8000 });
  // While it waits, an uploaded source appears (the user's work from somewhere else).
  const upId = uploadDocId(W_DOCLESS);
  mkdirSync(join(paths.outputDir, upId), { recursive: true });
  writeFileSync(
    join(paths.outputDir, upId, `${upId}.json`),
    JSON.stringify({ ...refreshIr(), docId: upId })
  );
  const raw = disk();
  raw.works[0].doc_ids = [upId];
  writeFileSync(paths.libraryJson, JSON.stringify(raw, null, 2));
  const before = readFileSync(join(paths.outputDir, upId, `${upId}.json`), "utf8");
  const changesBefore = broadcasts.filter(
    (m) => m.type === "library.changed" && m.cause === "upload"
  ).length;
  hold.open();
  await settled(id);
  expect(payload).toMatchObject({ ok: false, status: "rejected" });
  expect(readFileSync(join(paths.outputDir, upId, `${upId}.json`), "utf8")).toBe(before); // not replaced
  // Only the PDF job announced a change: the skipped zip job announced none.
  expect(
    broadcasts.filter((m) => m.type === "library.changed" && m.cause === "upload")
  ).toHaveLength(changesBefore + 1);
});

test("N2: filling a blank identifier while a zip is ingested is not a new identity; changing one it had is, and says the text may have been replaced", async () => {
  const hold = gate();
  const entered = gate();
  const base = pipelines.ingestLatexZip;
  pipelines.ingestLatexZip = async (zipPath, opts) => {
    entered.open();
    await hold.opened;
    return base(zipPath, opts);
  };
  const first = await pageZip(W_DOCLESS);
  await entered.opened;
  const enrich = disk();
  enrich.works[0].doi = "10.1000/filled-in"; // a blank field is completed (enrichment)
  writeFileSync(paths.libraryJson, JSON.stringify(enrich, null, 2));
  hold.open();
  const done1 = await runner.waitFor(((await first.json()) as { job: Job }).job.id);
  expect(done1.status).toBe("done");
  expect(workOnDisk(W_DOCLESS).doc_ids).toEqual([uploadDocId(W_DOCLESS)]);
  // Second: an identifier the work HAD is changed meanwhile.
  const hold2 = gate();
  const entered2 = gate();
  pipelines.ingestLatexZip = async (zipPath, opts) => {
    entered2.open();
    await hold2.opened;
    return base(zipPath, opts);
  };
  const second = await pageZip(W_NOARXIV);
  await entered2.opened;
  const change = disk();
  const target = change.works.find((w: { id: string }) => w.id === W_NOARXIV);
  target.doi = "10.1000/someone-else";
  writeFileSync(paths.libraryJson, JSON.stringify(change, null, 2));
  hold2.open();
  const done2 = await runner.waitFor(((await second.json()) as { job: Job }).job.id);
  expect(done2.status).toBe("failed");
  expect(done2.error).toContain("may already have been replaced");
  expect(done2.error).toContain("read the work");
});

test("N3: direction-control and control characters never survive in an attachment's name", async () => {
  const id = await newConversation();
  const res = await rawAttach(id, { name: "inv‮oice⁦.pdf‎", bytes: PDF_BYTES() });
  expect(res.status).toBe(201);
  const { filename } = (await res.json()) as { filename: string };
  expect(filename).toBe("inv_oice_.pdf_");
  expect(/[‪-‮⁦-⁩‎‏]/.test(filename)).toBe(false);
});

test("T1: the replacement card is bound to the file: another file gives another digest, and a file changed on disk ends the card", async () => {
  const docId = await seedUploadDoc();
  const ask = async (zip: Buffer) => {
    seen = []; // the scripted steps are counted per request
    script = [
      (ctx) => replaceZip(W_DOCLESS, docId, attachedIds(ctx)[0] as string),
      () => ({ text: "waiting" }),
    ];
    const view = page();
    const started = await startWithFiles(view, [{ name: "new-src.zip", bytes: zip }]);
    return { view, ...started, shown: await card(started.id) };
  };
  const one = await ask(LATEX_ZIP());
  const two = await ask(
    makeZip({ "main.tex": "\\documentclass{article}\\begin{document}Other\\end{document}\n" })
  );
  expect(one.shown.objectDigest).not.toBe(two.shown.objectDigest);
  // Tamper with the stored file behind the card: the click is refused as stale, nothing starts.
  const attId = one.ids[0] as string;
  writeFileSync(join(attachmentsRoot(), one.id, `${attId}.bin`), LATEX_ZIP().subarray(0, 40));
  expect((await answerCard(one.shown, one.view.viewId, "approve")).status).toBe(409);
  await settled(one.id);
  expect(jobsOf()).toHaveLength(0);
  expect(ops(await host.snapshot(one.id)).map((o) => o.status)).toContain("expired");
});

test("T1: a file that changes after the user approved is caught before the job is submitted", async () => {
  let sha = "a".repeat(64);
  let started = 0;
  const port = {
    describeUpload: () => ({
      kind: "work" as const,
      docId: "upload-x",
      title: "T",
      docIds: ["upload-x"],
      hasUpload: true,
    }),
    annotationRisk: async () => ({
      state: "known" as const,
      count: 1,
      rev: 1,
      stale: false,
      fingerprint: "f",
    }),
    checkZip: () => true,
    startZipUpload: () => {
      started += 1;
      return { kind: "error" as const, status: 500, detail: "must not start" };
    },
    jobs: { list: () => [], get: () => undefined, waitFor: async () => ({}) as Job },
  };
  const tool = createLibraryTool({
    library: {
      paths,
      libraryLock: new AsyncLock(),
      onChanged: () => {},
      readPayload: async () => ({}) as never,
      acquisition: port as never,
    },
    attachment: () => ({
      meta: {
        id: randomUUID(),
        filename: "n.zip",
        size: 3,
        contentType: "application/zip",
        sha256: sha,
        createdAt: "t",
      },
      bytes: Buffer.from("zip"),
    }),
    confirm: {
      request: async () => {
        sha = "b".repeat(64); // the file changes while the user is deciding
        return { outcome: "approved" as const };
      },
    },
    admitting: () => true,
    viewAction: async () => ({ ok: true }) as never,
  });
  const result = await tool.execute(
    "call-1",
    {
      action: "replace_upload_source",
      refId: W_DOCLESS,
      docId: "upload-x",
      attachmentId: randomUUID(),
    } as never,
    undefined as never,
    undefined as never,
    undefined as never
  );
  const first = result.content[0];
  expect(JSON.parse(first && first.type === "text" ? first.text : "{}")).toMatchObject({
    ok: false,
    status: "expired",
  });
  expect(started).toBe(0);
});

test("W3: removing an attachment cannot slip between a send's check and its record", async () => {
  const id = await newConversation();
  const keep = (
    (await (await rawAttach(id, { name: "a.pdf", bytes: PDF_BYTES() })).json()) as { id: string }
  ).id;
  const view = page();
  expect((await request(`/views/${view.viewId}`, "PUT", view)).status).toBe(200);
  const original = settings.captureConversation.bind(settings);
  vi.spyOn(settings, "captureConversation").mockImplementation(async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 150)); // the send is in flight for a moment
    return original(...args);
  });
  script = [() => ({ text: "ok" })];
  const sending = request(`/conversations/${id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text: "go",
    viewId: view.viewId,
    contextRevision: view.revision,
    attachmentIds: [keep],
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const removing = request(`/conversations/${id}/attachments/${keep}`, "DELETE");
  expect((await sending).status).toBe(202);
  expect((await removing).status).toBe(409); // it waited for the send and found the file carried by the message
  expect(existsSync(join(attachmentsRoot(), id, `${keep}.bin`))).toBe(true);
  await settled(id);
});

test("W5: a PDF of 25 MiB or more waits for the user's acceptance of the resource warning before any job", async () => {
  const big = Buffer.concat([PDF_BYTES(), Buffer.alloc(25 * 1024 * 1024)]);
  script = [
    (ctx) => uploadPdf(W_DOCLESS, attachedIds(ctx)[0] as string),
    () => ({ text: "waiting" }),
  ];
  const view = page();
  const { id } = await startWithFiles(view, [
    { name: "big.pdf", bytes: big, type: "application/pdf" },
  ]);
  const shown = await card(id);
  expect(shown).toMatchObject({
    action: "accept_pdf_resource_warning",
    object: { kind: "attachment", workId: W_DOCLESS },
    attachment: { filename: "big.pdf", size: big.length },
  });
  expect(jobsOf()).toHaveLength(0);
  expect(pdfDirs()).toEqual([]);
  expect((await answerCard(shown, view.viewId, "decline")).status).toBe(200);
  await settled(id);
  expect(jobsOf()).toHaveLength(0);
  expect(ops(await host.snapshot(id)).map((o) => o.status)).toContain("declined");
});

test("W5: accepting the warning submits the page's own upload job", async () => {
  const big = Buffer.concat([PDF_BYTES(), Buffer.alloc(25 * 1024 * 1024)]);
  script = [(ctx) => uploadPdf(W_DOCLESS, attachedIds(ctx)[0] as string), () => ({ text: "done" })];
  const view = page();
  const { id } = await startWithFiles(view, [
    { name: "big.pdf", bytes: big, type: "application/pdf" },
  ]);
  const shown = await card(id);
  expect((await answerCard(shown, view.viewId, "approve")).status).toBe(200);
  await settled(id);
  expect(jobsOf("upload")).toHaveLength(1);
  expect(runner.list()[0]?.payload).toMatchObject({ workId: W_DOCLESS, format: "pdf" });
});

test("W6: a replacement with something that is not a zip is refused before any card", async () => {
  const docId = await seedUploadDoc();
  let payload: Record<string, unknown> = {};
  script = [
    (ctx) => replaceZip(W_DOCLESS, docId, attachedIds(ctx)[0] as string),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "done" };
    },
  ];
  const { id } = await startWithFiles(page(), [
    { name: "fake.zip", bytes: Buffer.from("this is not a zip") },
  ]);
  await settled(id);
  expect(payload).toMatchObject({ ok: false, status: "rejected" });
  expect((await host.snapshot(id)).confirmations).toEqual([]);
  expect(jobsOf()).toHaveLength(0);
});
