/**
 * The PDF Reader's original-page material for the Copilot and the `/pdf/pages` routes (copilot ticket 20), end to
 * end on the real seam: real Pi session, real HTTP routes, the real PDFium engine in Node, real Doc files on disk,
 * real /ws sockets as browser tabs. Only the model provider is scripted; no network.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConversationSnapshot,
  type PageContext,
  PDF_IMAGE_HISTORY_MAX_BYTES,
  PDF_IMAGE_LONG_EDGE,
  type PdfPage,
  PdfPageSchema,
  PdfPagesResponseSchema,
  type WsServerMessage,
} from "@argelanderspace/contracts";
import { libraryPaths, plansPath, publishPdfDoc } from "@argelanderspace/core";
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "../src/app.js";
import { CopilotHost } from "../src/copilot.js";
import { DocMutationRegistry } from "../src/doc-mutations.js";
import { JobRunner } from "../src/jobs.js";
import { probePdf } from "../src/pdfium-probe.js";
import { ProviderSettings } from "../src/providers.js";
import { WsHub } from "../src/ws.js";
import { stubPipelines, stubSources } from "./helpers.js";
import { syntheticPdf } from "./pdf-fixture.js";

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
    work(1, { x_work: "keep-me", read: true, note: "Private note" }),
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
  rmSync(root, { recursive: true, force: true });
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

// ---- synthetic PDF Docs on disk --------------------------------------------------------------------- //
const LAST_PAGE_MARKER = "PAGE 12 UNIQUE";
/** A 12-page PDF whose last page carries the unique marker and whose third page is a picture with no text. */
async function publish(bytes: Buffer = syntheticPdf({ pageCount: 12, outline: true })) {
  const probed = await probePdf(bytes);
  const metadata = publishPdfDoc(paths, {
    workId: W1,
    filename: "synthetic.pdf",
    bytes,
    pages: probed.pages,
  });
  return { docId: metadata.doc_id, sha: metadata.sha256, bytes };
}
const pdfDir = (docId: string) => join(root, "data", "output", docId);
/** Every byte of the PDF Doc (original, metadata, annotations and reading-position sidecars). */
function pdfFiles(docId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(pdfDir(docId)))
    out[name] = readFileSync(join(pdfDir(docId), name)).toString("base64");
  return out;
}
function pdfPage(docId: string, sha: string | null, over: Partial<PdfPage> = {}): PdfPage {
  return {
    docId,
    format: "pdf",
    phase: "ready",
    sha256: sha,
    pageCount: 12,
    currentPage: 0,
    zoom: { mode: "fit_width", percent: 100 },
    outline: [],
    outlineTruncated: false,
    search: null,
    selection: null,
    panels: { outlineCollapsed: false, annotationsCollapsed: false },
    ...over,
  };
}
function page(pdf: PdfPage | null, revision = 1, viewId: string = randomUUID()): PageContext {
  return {
    version: 1,
    viewId,
    revision,
    paneId: 1,
    view: "doc",
    status: pdf?.phase === "ready" ? "complete" : "unavailable",
    otherPanes: [],
    plan: null,
    pdf,
  };
}
async function run(
  context: PageContext,
  text = "Look at this PDF",
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
  if (sent.status !== 202) throw new Error(`send ${sent.status} ${await sent.text()}`);
  await vi.waitFor(
    async () => {
      expect((await host.snapshot(id)).conversation.run?.status).not.toBe("running");
    },
    { timeout: 20000 }
  );
  return { id, snapshot: await host.snapshot(id), actions };
}
const ops = (snapshot: ConversationSnapshot) =>
  snapshot.messages.flatMap((m) => m.operations ?? []);
/** The envelope the model was sent with the first user message. */
const envelopeOf = (context: TranscriptContext) => {
  const first = context.messages.find((m) => m.role === "user");
  if (first?.role !== "user") throw new Error("no user message");
  const content = first.content;
  const text =
    typeof content === "string"
      ? content
      : content.map((block) => (block.type === "text" ? block.text : "")).join("");
  return JSON.parse(text);
};
const imageBlocks = (context: TranscriptContext) =>
  context.messages
    .filter((m) => m.role === "toolResult")
    .flatMap((m) => (m.role === "toolResult" ? m.content.filter((b) => b.type === "image") : []));
const get = (path: string) => app.request(path);

// ---- the routes -------------------------------------------------------------------------------------- //
test("GET /pdf/pages answers every page's real text zero-based, the outline, and a page without text as such", async () => {
  const { docId, sha, bytes } = await publish();
  const before = pdfFiles(docId);
  const res = await get(`/api/paper/${docId}/pdf/pages?hash=${sha}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = PdfPagesResponseSchema.parse(await res.json());
  expect(body).toMatchObject({ doc_id: docId, content_sha256: sha, page_count: 12 });
  expect(body.range).toEqual({ first: 0, last: 11 });
  expect(body.pages.map((p) => p.pageIndex)).toEqual([...Array(12).keys()]);
  expect(body.pages[11]?.text).toContain(LAST_PAGE_MARKER);
  expect(body.pages[0]?.text).toContain("PAGE 1 UNIQUE");
  expect(body.pages[2]).toMatchObject({ hasTextLayer: false, text: null });
  expect(body.outline.map((o) => [o.title, o.pageIndex])).toEqual([
    ["Chapter One", 0],
    ["Section 1.1", 1],
    ["Chapter Two", 11],
  ]);
  expect(body.image.longEdge).toEqual(PDF_IMAGE_LONG_EDGE);
  // a range is zero-based and inclusive
  const part = PdfPagesResponseSchema.parse(
    await (await get(`/api/paper/${docId}/pdf/pages?first=10&last=11`)).json()
  );
  expect(part.pages.map((p) => p.pageIndex)).toEqual([10, 11]);
  expect(part.content_sha256).toBe(sha);
  // reading the original changes nothing: original, metadata and both sidecars keep their bytes
  expect(pdfFiles(docId)).toEqual(before);
  expect(readFileSync(join(pdfDir(docId), "original.pdf")).equals(bytes)).toBe(true);
});

test("the page routes tell a bad hash, a bad page, a missing text layer, a missing Doc and a LaTeX Doc apart", async () => {
  const { docId, sha } = await publish();
  const other = "0".repeat(64);
  expect((await get(`/api/paper/${docId}/pdf/pages?hash=${other}`)).status).toBe(409);
  expect((await get(`/api/paper/${docId}/pdf/pages?hash=zzz`)).status).toBe(400);
  expect((await get(`/api/paper/${docId}/pdf/pages?first=-1`)).status).toBe(400);
  expect((await get(`/api/paper/${docId}/pdf/pages?first=12`)).status).toBe(400);
  expect((await get(`/api/paper/${docId}/pdf/pages?first=5&last=2`)).status).toBe(400);
  expect((await get(`/api/paper/nope/pdf/pages`)).status).toBe(404);
  // the image: the hash is required, the page is zero-based, the resolution is controlled
  expect((await get(`/api/paper/${docId}/pdf/pages/0/image`)).status).toBe(400);
  expect((await get(`/api/paper/${docId}/pdf/pages/0/image?hash=${other}`)).status).toBe(409);
  expect((await get(`/api/paper/${docId}/pdf/pages/12/image?hash=${sha}`)).status).toBe(400);
  expect((await get(`/api/paper/${docId}/pdf/pages/-1/image?hash=${sha}`)).status).toBe(400);
  expect((await get(`/api/paper/${docId}/pdf/pages/1.5/image?hash=${sha}`)).status).toBe(400);
  expect((await get(`/api/paper/${docId}/pdf/pages/0/image?hash=${sha}&edge=10`)).status).toBe(400);
  expect((await get(`/api/paper/${docId}/pdf/pages/0/image?hash=${sha}&edge=99999`)).status).toBe(
    400
  );
  expect((await get(`/api/paper/nope/pdf/pages/0/image?hash=${sha}`)).status).toBe(404);
  // a LaTeX Doc is not a PDF Doc
  mkdirSync(join(root, "data", "output", "tex-doc"), { recursive: true });
  writeFileSync(
    join(root, "data", "output", "tex-doc", "tex-doc.json"),
    JSON.stringify({ version: 1 })
  );
  // unowned: not found; once a Work owns it, a Doc without PDF metadata is a data error (500), as GET /pdf answers
  expect((await get(`/api/paper/tex-doc/pdf/pages`)).status).toBe(404);
  const library = JSON.parse(readFileSync(paths.libraryJson, "utf8"));
  library.works[0].doc_ids.push("tex-doc");
  writeFileSync(paths.libraryJson, JSON.stringify(library));
  expect((await get(`/api/paper/tex-doc/pdf/pages`)).status).toBe(500);
  expect((await get(`/api/paper/tex-doc/pdf`)).status).toBe(500);
  expect((await get(`/api/paper/tex-doc/pdf/pages/0/image?hash=${sha}`)).status).toBe(500);
  // the page without a text layer still has an image: the picture is the source material
  const scan = await get(`/api/paper/${docId}/pdf/pages/2/image?hash=${sha}&edge=512`);
  expect(scan.status).toBe(200);
  expect(scan.headers.get("x-pdf-has-text-layer")).toBe("false");
});

test("the image is a PNG bound to the same verified original: hash, page and size come back, and a changed original is refused", async () => {
  const { docId, sha } = await publish();
  const before = pdfFiles(docId);
  const res = await get(`/api/paper/${docId}/pdf/pages/0/image?hash=${sha}&edge=800`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(res.headers.get("x-pdf-content-sha256")).toBe(sha);
  expect(res.headers.get("x-pdf-page-index")).toBe("0");
  expect(res.headers.get("x-pdf-page-count")).toBe("12");
  const png = Buffer.from(await res.arrayBuffer());
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  expect(png.readUInt32BE(16)).toBe(Number(res.headers.get("x-pdf-image-width")));
  expect(png.readUInt32BE(20)).toBe(Number(res.headers.get("x-pdf-image-height")));
  expect(Math.max(png.readUInt32BE(16), png.readUInt32BE(20))).toBe(800);
  expect(pdfFiles(docId)).toEqual(before);
  // the original on disk is replaced behind the application's back: both routes refuse, no cached page answers
  const original = join(pdfDir(docId), "original.pdf");
  writeFileSync(original, syntheticPdf({ pageCount: 2 }));
  expect((await get(`/api/paper/${docId}/pdf/pages/0/image?hash=${sha}`)).status).toBe(409);
  expect((await get(`/api/paper/${docId}/pdf/pages`)).status).toBe(409);
  expect((await get(`/api/paper/${docId}/pdf/pages?hash=${sha}`)).status).toBe(409);
});

test("material is not read while a job is replacing or deleting the Doc", async () => {
  const { docId, sha } = await publish();
  docMutations.pinWriter(docId);
  expect((await get(`/api/paper/${docId}/pdf/pages`)).status).toBe(409);
  expect((await get(`/api/paper/${docId}/pdf/pages/0/image?hash=${sha}`)).status).toBe(409);
  docMutations.unpinWriter(docId);
  expect((await get(`/api/paper/${docId}/pdf/pages`)).status).toBe(200);
});

// ---- the page context and the model input ------------------------------------------------------------ //
test("every page's material reaches the model with the message, however little of it the Reader has rendered", async () => {
  const { docId, sha } = await publish();
  script = [() => ({ text: "seen" })];
  const { snapshot } = await run(page(pdfPage(docId, sha, { currentPage: 0 })));
  const envelope = envelopeOf(seenAt(0));
  expect(envelope.context.pdf).toMatchObject({ docId, sha256: sha, currentPage: 0 });
  // the page is identity and position: the pages' content is the service's material
  expect(JSON.stringify(envelope.context)).not.toContain("PAGE 1 UNIQUE");
  expect(envelope.pdf.status).toBe("ok");
  const reading = envelope.pdf.reading;
  expect(reading.sha256).toBe(sha);
  expect(reading.pages).toHaveLength(12);
  // the last page's unique content is in the model input although the viewer is on page 0 (zero-based)
  expect(reading.pages[11]).toMatchObject({ pageIndex: 11 });
  expect(reading.pages[11].text).toContain(LAST_PAGE_MARKER);
  expect(reading.pages[2]).toMatchObject({ pageIndex: 2, hasTextLayer: false, text: null });
  expect(reading.imageOnlyPages).toEqual([2]);
  expect(reading.coverage).toMatchObject({ pages: 12, pagesWithText: 11, pagesWithoutText: 1 });
  expect(reading.images).toMatchObject({ modelAcceptsImages: true });
  expect(reading.outline).toHaveLength(3);
  // the record the user sees names what was attached
  expect(snapshot.messages[0]?.context?.pdf).toMatchObject({
    docId,
    sha256: sha,
    material: { status: "ok", pages: 12, pagesWithText: 11, pagesWithoutText: 1 },
  });
  expect(snapshot.messages[0]?.context?.objects).toEqual([{ id: docId, rev: 0 }]);
});

test("a PDF page that is not ready carries no material and says why; a missing page never reads as an empty PDF", async () => {
  const { docId, sha } = await publish();
  script = [() => ({ text: "x" })];
  await run(page(pdfPage(docId, sha, { phase: "error" })));
  const loading = envelopeOf(seenAt(0));
  expect(loading.pdf).toBeUndefined();
  expect(loading.context.status).toBe("unavailable");
  // the original changed between the page and the message: the material says so instead of mixing two originals
  seen = [];
  script = [() => ({ text: "x" })];
  await run(page(pdfPage(docId, "f".repeat(64))));
  expect(envelopeOf(seenAt(0)).pdf).toMatchObject({ status: "changed" });
  // a Doc that was deleted: not_found, not an empty reading
  seen = [];
  script = [() => ({ text: "x" })];
  await run(page(pdfPage("gone-doc", sha)));
  expect(envelopeOf(seenAt(0)).pdf).toMatchObject({ status: "not_found" });
});

test("PdfPage refuses a selection of another original and a selection or search outside a ready Reader", async () => {
  const { docId, sha } = await publish();
  const selection = { sha256: sha, text: "PAGE 1", firstPage: 0, lastPage: 0 };
  expect(PdfPageSchema.safeParse(pdfPage(docId, sha, { selection })).success).toBe(true);
  expect(
    PdfPageSchema.safeParse(
      pdfPage(docId, sha, { selection: { ...selection, sha256: "a".repeat(64) } })
    ).success
  ).toBe(false);
  expect(
    PdfPageSchema.safeParse(pdfPage(docId, sha, { phase: "loading", selection })).success
  ).toBe(false);
  const context = page(
    pdfPage(docId, sha, { selection: { ...selection, sha256: "b".repeat(64) } })
  );
  expect((await request(`/views/${context.viewId}`, "PUT", context)).status).toBe(400);
});

// ---- the reader tool ---------------------------------------------------------------------------------- //
test("read of a PDF Doc returns the whole material in the background: nothing moves, nothing is written", async () => {
  const { docId, sha } = await publish();
  const before = pdfFiles(docId);
  script = [() => ({ call: { action: "read", docId } }), () => ({ text: "read" })];
  const { snapshot, actions } = await run(page(null), "Read the pdf", true);
  const result = lastResult(seenAt(1));
  expect(result).toMatchObject({ ok: true, status: "ok" });
  expect(result.reading.format).toBe("pdf");
  expect(result.reading.sha256).toBe(sha);
  expect(result.reading.pages[11].text).toContain(LAST_PAGE_MARKER);
  expect(result.reading.pages[2]).toMatchObject({ hasTextLayer: false, text: null });
  expect(ops(snapshot)[0]).toMatchObject({ action: "read", status: "ok" });
  expect(actions).toEqual([]);
  expect(pdfFiles(docId)).toEqual(before);
});

test("read_page_image puts the original page's real bytes into the model's image input, any page", async () => {
  const { docId, sha } = await publish();
  const before = pdfFiles(docId);
  script = [
    () => ({
      call: { action: "read_page_image", docId, pageIndex: 11, sha256: sha, longEdge: 640 },
    }),
    () => ({ call: { action: "read_page_image", docId, pageIndex: 2, sha256: sha } }),
    () => ({ text: "looked" }),
  ];
  const { snapshot, actions } = await run(
    page(pdfPage(docId, sha)),
    "Show page 12 and the scan",
    true
  );
  const images = imageBlocks(seenAt(2));
  expect(images).toHaveLength(2);
  // the first image is exactly what the HTTP route serves for the same original, page and resolution
  const served = Buffer.from(
    await (await get(`/api/paper/${docId}/pdf/pages/11/image?hash=${sha}&edge=640`)).arrayBuffer()
  );
  const first = images[0];
  if (first?.type !== "image") throw new Error("no image");
  expect(first.mimeType).toBe("image/png");
  expect(Buffer.from(first.data, "base64").equals(served)).toBe(true);
  expect(Math.max(served.readUInt32BE(16), served.readUInt32BE(20))).toBe(640);
  const results = seenAt(2).messages.filter((m) => m.role === "toolResult");
  const text = (m: (typeof results)[number]) => {
    const part = m.role === "toolResult" ? m.content[0] : undefined;
    return JSON.parse(part && part.type === "text" ? part.text : "{}");
  };
  expect(text(results[0] as (typeof results)[number])).toMatchObject({
    ok: true,
    status: "ok",
    sha256: sha,
    page: { pageIndex: 11, pageCount: 12, hasTextLayer: true },
  });
  // the page without a text layer says so next to its image; no text was invented
  expect(text(results[1] as (typeof results)[number])).toMatchObject({
    page: { pageIndex: 2, hasTextLayer: false },
  });
  expect(ops(snapshot).map((o) => [o.action, o.status])).toEqual([
    ["read_page_image", "ok"],
    ["read_page_image", "ok"],
  ]);
  expect(actions).toEqual([]);
  expect(pdfFiles(docId)).toEqual(before);
});

test("a model that cannot take images gets a clear notice and no image, never a guess at a scanned page", async () => {
  const { docId, sha } = await publish();
  const model = (await settings.getRuntime())
    .getModels("openai")
    .find((candidate) => candidate.id === "gpt-4.1");
  if (!model) throw new Error("fixture model");
  const original = [...model.input];
  model.input = ["text"];
  try {
    script = [
      () => ({ call: { action: "read_page_image", docId, pageIndex: 2, sha256: sha } }),
      () => ({ text: "cannot" }),
    ];
    const { snapshot } = await run(page(pdfPage(docId, sha)));
    const result = lastResult(seenAt(1));
    expect(result).toMatchObject({ ok: false, status: "unsupported" });
    expect(result.detail).toMatch(/cannot take images/);
    expect(result.detail).toMatch(/do not guess/);
    expect(imageBlocks(seenAt(1))).toHaveLength(0);
    expect(ops(snapshot)[0]).toMatchObject({ action: "read_page_image", status: "unsupported" });
    // the message already told the model: the scan is unreadable, here is why
    const reading = envelopeOf(seenAt(0)).pdf.reading;
    expect(reading.images).toMatchObject({ modelAcceptsImages: false });
    expect(reading.images.notice).toMatch(/choose an image-capable model/);
    expect(reading.imageOnlyPages).toEqual([2]);
    expect(reading.pages[2].text).toBeNull();
  } finally {
    model.input = original as typeof model.input;
  }
});

test("a bad hash, a bad page, a bad resolution and a changed original are each refused with their own state", async () => {
  const { docId, sha } = await publish();
  script = [
    () => ({ call: { action: "read_page_image", docId, pageIndex: 12, sha256: sha } }),
    () => ({ call: { action: "read_page_image", docId, pageIndex: 0, sha256: "0".repeat(64) } }),
    () => ({ call: { action: "read_page_image", docId, pageIndex: -1, sha256: sha } }),
    () => ({
      call: { action: "read_page_image", docId, pageIndex: 0, sha256: sha, longEdge: 100 },
    }),
    () => ({
      call: { action: "read_page_image", docId: "no-such-doc", pageIndex: 0, sha256: sha },
    }),
    () => ({ text: "refused" }),
  ];
  const { snapshot } = await run(page(pdfPage(docId, sha)));
  // pageIndex -1 and longEdge 100 are refused by the tool's own parameter schema before anything runs; the page
  // past the end, the changed original and the unknown Doc are answered by the service with their own state
  expect(ops(snapshot).map((o) => o.status)).toEqual([
    "invalid",
    "conflict",
    "error",
    "error",
    "not_found",
  ]);
  const results = seenAt(5).messages.filter((m) => m.role === "toolResult");
  const part = (index: number) => {
    const message = results[index];
    const first = message?.role === "toolResult" ? message.content[0] : undefined;
    return JSON.parse(first && first.type === "text" ? first.text : "{}");
  };
  expect(part(0).detail).toMatch(/zero-based/);
  expect(part(1).detail).toMatch(/document changed/);
  expect(imageBlocks(seenAt(5))).toHaveLength(0);
});

test("a PDF image larger than the room left in the window is refused whole with a way forward", async () => {
  const { docId, sha } = await publish();
  const model = (await settings.getRuntime())
    .getModels("openai")
    .find((candidate) => candidate.id === "gpt-4.1");
  if (!model) throw new Error("fixture model");
  const original = { contextWindow: model.contextWindow, maxTokens: model.maxTokens };
  model.contextWindow = 34_000;
  model.maxTokens = 1024;
  try {
    script = [
      () => ({
        call: { action: "read_page_image", docId, pageIndex: 0, sha256: sha, longEdge: 4096 },
      }),
      () => ({ text: "x" }),
    ];
    // a page that is still loading carries no material, so the message itself fits the small window
    await run(page(pdfPage(docId, sha, { phase: "loading" })));
    const result = lastResult(seenAt(1));
    expect(result).toMatchObject({ ok: false, status: "rejected" });
    expect(result.detail).toMatch(/smaller longEdge/);
    expect(imageBlocks(seenAt(1))).toHaveLength(0);
  } finally {
    Object.assign(model, original);
  }
});

test("annotation writes stay refused on a PDF Doc (ticket 21) and the reader tool does not write files", async () => {
  const { docId, sha } = await publish();
  const before = pdfFiles(docId);
  script = [
    () => ({
      call: {
        action: "create_annotation",
        docId,
        fingerprint: "x".repeat(8),
        rev: 0,
        target: { type: "document" },
        body: "note",
      },
    }),
    () => ({ text: "x" }),
  ];
  await run(page(pdfPage(docId, sha)));
  expect(lastResult(seenAt(1))).toMatchObject({ ok: false, status: "unsupported" });
  expect(pdfFiles(docId)).toEqual(before);
});

// ---- the Reader's own controls ----------------------------------------------------------------------- //
test("every PDF control is a closed, bound-view action with zero-based pages; the Reader's own answer is reported", async () => {
  const { docId, sha } = await publish();
  script = [
    () => ({ call: { action: "goto_page", docId, pageIndex: 11 } }),
    () => ({ call: { action: "next_page", docId } }),
    () => ({ call: { action: "previous_page", docId } }),
    () => ({ call: { action: "open_outline_item", docId, outlineId: "pdf-outline-1" } }),
    () => ({ call: { action: "zoom", docId, mode: "fit_page" } }),
    () => ({ call: { action: "set_panel", docId, panel: "outline", collapsed: true } }),
    () => ({ call: { action: "goto_page", docId, pageIndex: -1 } }),
    () => ({ call: { action: "goto_page", docId, pageIndex: 99 } }),
    () => ({ text: "done" }),
  ];
  const { snapshot, actions } = await run(page(pdfPage(docId, sha)), "Walk the pdf", true, (a) =>
    a.action === "goto_page" && a.pageIndex === 99
      ? { ok: false, detail: "not_found" }
      : { ok: true }
  );
  expect(actions).toEqual([
    { action: "goto_page", docId, pageIndex: 11 },
    { action: "next_page", docId },
    { action: "previous_page", docId },
    { action: "open_outline_item", docId, outlineId: "pdf-outline-1" },
    { action: "zoom", docId, mode: "fit_page" },
    { action: "set_panel", docId, panel: "outline", collapsed: true },
    { action: "goto_page", docId, pageIndex: 99 },
  ]);
  // a negative page index never reaches the Reader: the tool's own parameter schema refuses it
  expect(ops(snapshot).map((o) => o.status)).toEqual([
    "ok",
    "ok",
    "ok",
    "ok",
    "ok",
    "ok",
    "error",
    "not_found",
  ]);
});

test("search runs the Reader's own search and the reply carries the results the Reader shows", async () => {
  const { docId, sha } = await publish();
  const context = page(pdfPage(docId, sha));
  const answer = (a: Record<string, unknown>) => {
    if (a.action !== "search") return { ok: true };
    // the Reader publishes its settled search the way its page does, then reports the action
    void request(
      `/views/${context.viewId}`,
      "PUT",
      page(
        pdfPage(docId, sha, {
          search: {
            query: String(a.query),
            generation: 1,
            status: "done",
            count: 2,
            results: [
              { pageIndex: 3, before: "see ", match: "PAGE 4 UNIQUE", after: " here" },
              { pageIndex: 11, before: "", match: "PAGE 12 UNIQUE", after: "" },
            ],
          },
        }),
        2,
        context.viewId
      )
    );
    return { ok: true };
  };
  script = [
    () => ({ call: { action: "search", docId, query: "UNIQUE" } }),
    () => ({ call: { action: "open_search_result", docId, index: 1 } }),
    () => ({ text: "found" }),
  ];
  const { actions } = await run(context, "Find it", true, answer);
  expect(actions).toEqual([
    { action: "search", docId, query: "UNIQUE" },
    { action: "open_search_result", docId, index: 1 },
  ]);
  const searched = seenAt(1).messages.filter((m) => m.role === "toolResult")[0];
  const first = searched?.role === "toolResult" ? searched.content[0] : undefined;
  const json = JSON.parse(first && first.type === "text" ? first.text : "{}");
  expect(json).toMatchObject({ ok: true, status: "ok", search: { query: "UNIQUE", count: 2 } });
  expect(json.search.results[1]).toMatchObject({ pageIndex: 11, match: "PAGE 12 UNIQUE" });
});

test("copying, the page link and downloading the original are the user's browser gestures, not actions", async () => {
  const { docId, sha } = await publish();
  script = [
    () => ({ call: { action: "download", docId } }),
    () => ({ call: { action: "copy_selection", docId } }),
    () => ({ text: "x" }),
  ];
  const { snapshot, actions } = await run(page(pdfPage(docId, sha)), "Download it", true);
  // not in the closed action list: the tool's schema refuses them, nothing is sent to any view
  expect(ops(snapshot).map((o) => o.status)).toEqual(["error", "error"]);
  expect(actions).toEqual([]);
});

test("a conversation that carried a PDF page loads back after a service restart", async () => {
  const { docId, sha } = await publish();
  script = [() => ({ text: "seen" })];
  const { id } = await run(page(pdfPage(docId, sha)));
  await host.close();
  const again = new CopilotHost(join(root, "data"), settings, () => {});
  try {
    const snapshot = await again.snapshot(id);
    expect(snapshot.messages[0]?.context?.objects).toEqual([{ id: docId, rev: 0 }]);
    expect(snapshot.messages[0]?.context?.pdf).toMatchObject({ docId, material: { status: "ok" } });
  } finally {
    await again.close();
  }
  host = new CopilotHost(join(root, "data"), settings, () => {});
});

test("the message record keeps what the service attached of the PDF", async () => {
  const { docId, sha } = await publish();
  const context = page(pdfPage(docId, sha));
  script = [() => ({ call: { action: "read", docId } }), () => ({ text: "x" })];
  const { snapshot } = await run(context);
  expect(snapshot.messages[0]?.context?.pdf?.material?.pages).toBe(12);
});

// ---- fix round 1 ------------------------------------------------------------------------------------- //
test("H1: an outline nested hundreds of levels deep cannot make a conversation unreadable", async () => {
  const { docId, sha } = await publish(syntheticPdf({ pageCount: 3, deepOutline: 260 }));
  // the route and the model's material both carry the whole outline with short ids
  const pages = PdfPagesResponseSchema.parse(
    await (await get(`/api/paper/${docId}/pdf/pages`)).json()
  );
  expect(pages.outline).toHaveLength(260);
  expect(Math.max(...pages.outline.map((item) => item.id.length))).toBeLessThan(40);
  script = [() => ({ call: { action: "read", docId } }), () => ({ text: "seen" })];
  const { id, snapshot } = await run(page(pdfPage(docId, sha)));
  expect(envelopeOf(seenAt(0)).pdf.status).toBe("ok");
  expect(snapshot.messages[0]?.context?.pdf?.material?.status).toBe("ok");
  // the conversation reads back over HTTP and after a restart
  expect((await request(`/conversations/${id}`)).status).toBe(200);
  await host.close();
  const again = new CopilotHost(join(root, "data"), settings, () => {});
  try {
    expect((await again.snapshot(id)).messages[0]?.context?.pdf).toMatchObject({ docId });
  } finally {
    await again.close();
  }
  host = new CopilotHost(join(root, "data"), settings, () => {});
});

test("H1: an envelope the history could not read back is never appended; the PDF material degrades to an error", async () => {
  const { docId, sha } = await publish();
  const workbench = (
    host as unknown as {
      workbench: { reader: { pdf: { read: (docId: string) => Promise<unknown> } } };
    }
  ).workbench;
  const read = workbench.reader.pdf.read;
  workbench.reader.pdf.read = async (id) => {
    const outcome = (await read(id)) as { kind: string; material: { outline: unknown[] } };
    // a material that breaks the message contract (an id far past the bound)
    outcome.material.outline = [{ id: "x".repeat(900), title: "t", level: 1, pageIndex: 0 }];
    return outcome;
  };
  script = [() => ({ text: "seen" }), () => ({ text: "again" })];
  const { id, snapshot } = await run(page(pdfPage(docId, sha)));
  const sent = envelopeOf(seenAt(0));
  expect(sent.pdf.status).toBe("error");
  expect(sent.pdf.detail).toMatch(/could not be attached/);
  expect(JSON.stringify(sent)).not.toContain("xxxxxxxxxx");
  expect(snapshot.messages[0]?.context?.pdf?.material).toMatchObject({ status: "error", pages: 0 });
  // history stays readable
  expect((await request(`/conversations/${id}`)).status).toBe(200);
  workbench.reader.pdf.read = read;
});

test("L2: steering states image capability from the run's frozen model", async () => {
  const { docId, sha } = await publish();
  const model = (await settings.getRuntime())
    .getModels("openai")
    .find((candidate) => candidate.id === "gpt-4.1");
  if (!model) throw new Error("fixture model");
  const original = [...model.input];
  const context = page(pdfPage(docId, sha));
  let id = "";
  const sendSteer = async () => {
    // the conversation's selected model changes to a text-only one while the run works
    model.input = ["text"];
    const res = await request(`/conversations/${id}/messages`, "POST", {
      clientMessageId: randomUUID(),
      text: "and the scan?",
      viewId: context.viewId,
      contextRevision: context.revision,
    });
    expect(res.status).toBe(202);
    return { text: "working" };
  };
  try {
    script = [
      async () => {
        const { conversations } = (await (await request("/conversations")).json()) as {
          conversations: { id: string }[];
        };
        id = conversations[0]?.id ?? "";
        return sendSteer();
      },
      () => ({ text: "done" }),
    ];
    await run(context);
    const steered = seen
      .flatMap((c) => c.messages)
      .filter((m) => m.role === "user")
      .map((m) =>
        typeof m.content === "string"
          ? m.content
          : m.content.map((b) => (b.type === "text" ? b.text : "")).join("")
      )
      .map((text) => JSON.parse(text))
      .find((envelope) => envelope.text === "and the scan?");
    expect(steered?.pdf?.reading?.images?.modelAcceptsImages).toBe(true);
  } finally {
    model.input = original as typeof model.input;
  }
});

test("M2: default-size page images fit a 200k window one after another; each is counted by its pixels", async () => {
  const { docId, sha } = await publish();
  const model = (await settings.getRuntime())
    .getModels("openai")
    .find((candidate) => candidate.id === "gpt-4.1");
  if (!model) throw new Error("fixture model");
  const original = { contextWindow: model.contextWindow, maxTokens: model.maxTokens };
  model.contextWindow = 200_000;
  model.maxTokens = 4096;
  try {
    script = [
      () => ({ call: { action: "read_page_image", docId, pageIndex: 2, sha256: sha } }),
      () => ({ call: { action: "read_page_image", docId, pageIndex: 0, sha256: sha } }),
      () => ({ call: { action: "read_page_image", docId, pageIndex: 1, sha256: sha } }),
      () => ({ text: "looked" }),
    ];
    const { snapshot } = await run(page(pdfPage(docId, sha, { phase: "loading" })));
    expect(ops(snapshot).map((o) => o.status)).toEqual(["ok", "ok", "ok"]);
    expect(imageBlocks(seenAt(3))).toHaveLength(3);
    // the history budget counts those images by their pixels, not by the length of their base64 text
    const loaded = (
      host as unknown as {
        loaded: Map<string, { manager: { getHeader(): unknown; getEntries(): unknown[] } }>;
      }
    ).loaded.get(snapshot.conversation.id);
    const counted = (host as unknown as { historySize(l: unknown): number }).historySize(loaded);
    const asText = Buffer.byteLength(
      JSON.stringify([loaded?.manager.getHeader(), ...(loaded?.manager.getEntries() ?? [])])
    );
    expect(counted).toBeLessThan(asText);
  } finally {
    Object.assign(model, original);
  }
});

test("Std6: search while one is running is refused; the reply is this search's, not an earlier identical one's", async () => {
  const { docId, sha } = await publish();
  const context = page(
    pdfPage(docId, sha, {
      search: {
        query: "UNIQUE",
        generation: 5,
        status: "done",
        count: 1,
        results: [{ pageIndex: 0, before: "", match: "OLD", after: "" }],
      },
    })
  );
  let revision = 1;
  const answer = (a: Record<string, unknown>) => {
    if (a.action !== "search") return { ok: true };
    revision += 1;
    // the new search settles LATER, with a LARGER generation and new results; until then the page still shows the
    // earlier identical search (same query, done): the reply must not be that one
    setTimeout(
      () =>
        void request(
          `/views/${context.viewId}`,
          "PUT",
          page(
            pdfPage(docId, sha, {
              search: {
                query: String(a.query),
                generation: 6,
                status: "done",
                count: 1,
                results: [{ pageIndex: 7, before: "", match: "NEW", after: "" }],
              },
            }),
            revision,
            context.viewId
          )
        ),
      400
    );
    return { ok: true };
  };
  script = [() => ({ call: { action: "search", docId, query: "UNIQUE" } }), () => ({ text: "x" })];
  await run(context, "Search again", true, answer);
  const result = lastResult(seenAt(1));
  expect(result.search.results[0].match).toBe("NEW");
  expect(result.search.generation).toBe(6);
});

test("Std2: an outline entry the Reader refuses to open (an external link) is disabled with its reason", async () => {
  const { docId, sha } = await publish();
  script = [
    () => ({ call: { action: "open_outline_item", docId, outlineId: "pdf-outline-1" } }),
    () => ({ text: "x" }),
  ];
  const { snapshot } = await run(page(pdfPage(docId, sha)), "Open it", true, () => ({
    ok: false,
    detail: "disabled",
  }));
  const result = lastResult(seenAt(1));
  expect(result).toMatchObject({ ok: false, status: "rejected" });
  expect(result.detail).toMatch(/disabled/);
  expect(result.reason).toMatch(/external link is the user's own click/);
  expect(ops(snapshot)[0]).toMatchObject({ action: "open_outline_item", status: "rejected" });
});

test("B1: the history's image total is enforced: images already there make a further message and a further image refused", async () => {
  const catalog = (await settings.getRuntime())
    .getModels("openai")
    .find((candidate) => candidate.id === "gpt-4.1");
  if (!catalog) throw new Error("fixture model");
  const originalWindow = { contextWindow: catalog.contextWindow, maxTokens: catalog.maxTokens };
  onTestFinished(() => void Object.assign(catalog, originalWindow));
  catalog.contextWindow = 200_000;
  catalog.maxTokens = 4096;
  const { docId, sha } = await publish();
  script = [
    () => ({ call: { action: "read_page_image", docId, pageIndex: 0, sha256: sha } }),
    () => ({ text: "looked" }),
  ];
  const context = page(pdfPage(docId, sha, { phase: "loading" }));
  const { id, snapshot } = await run(context);
  expect(ops(snapshot)[0]).toMatchObject({ status: "ok" });
  const loaded = (
    host as unknown as {
      loaded: Map<string, { manager: { appendMessage(message: unknown): void } }>;
    }
  ).loaded.get(id);
  const stats = () =>
    (host as unknown as { historyStats(l: unknown): { imageBytes: number } }).historyStats(loaded);
  const before = stats().imageBytes;
  expect(before).toBeGreaterThan(0);
  // images already in the history (a valid PNG header of 10 x 10 px: almost no tokens, all bytes) nearly fill the total
  const png = (bytes: number) => {
    const header = Buffer.alloc(bytes);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header, 0);
    header.writeUInt32BE(13, 8);
    header.write("IHDR", 12);
    header.writeUInt32BE(10, 16);
    header.writeUInt32BE(10, 20);
    return header.toString("base64");
  };
  const append = (bytes: number) =>
    loaded?.manager.appendMessage({
      role: "toolResult",
      toolCallId: `x${bytes}`,
      toolName: "reader",
      isError: false,
      timestamp: Date.now(),
      content: [{ type: "image", data: png(bytes), mimeType: "image/png" }],
    });
  append(PDF_IMAGE_HISTORY_MAX_BYTES - before - 20_000);
  const send = async (text: string) =>
    request(`/conversations/${id}/messages`, "POST", {
      clientMessageId: randomUUID(),
      text,
      viewId: context.viewId,
      contextRevision: 1,
    });
  // a further page image no longer fits the total: refused whole, through the host's own wiring
  script = [
    () => ({
      call: { action: "read_page_image", docId, pageIndex: 1, sha256: sha, longEdge: 2048 },
    }),
    () => ({ text: "refused" }),
  ];
  seen = [];
  const first = await send("one more page");
  if (first.status !== 202) throw new Error(await first.clone().text());
  expect(first.status).toBe(202);
  await vi.waitFor(async () => {
    expect((await host.snapshot(id)).conversation.run?.status).not.toBe("running");
  });
  const refused = lastResult(seenAt(1));
  expect(refused).toMatchObject({ ok: false, status: "rejected" });
  expect(refused.detail).toMatch(/together/);
  // the two images the history already held (the real page and the stand-in); no new one was appended
  expect(imageBlocks(seenAt(1)).length).toBe(2);
  // and a history whose images are over the total can never be extended at all
  append(40_000);
  expect(stats().imageBytes).toBeGreaterThan(PDF_IMAGE_HISTORY_MAX_BYTES);
  const res = await send("more");
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ code: "capacity" });
});
