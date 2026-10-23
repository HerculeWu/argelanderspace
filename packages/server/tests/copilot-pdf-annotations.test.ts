/**
 * The Copilot's PDF workbench annotation writes (copilot ticket 21), end to end on the real seam: real Pi session,
 * the real `reader` tool, the real annotations lock and sidecar files, the real PDFium text layer in Node, the page's
 * own PUT as the user's side. Only the model provider is scripted; no network.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConversationSnapshot,
  type PageContext,
  PdfAnnotationsFileSchema,
  type PdfPage,
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
import { afterEach, beforeEach, expect, test, vi } from "vitest";
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

// Each case runs a real Pi session over the real PDFium text layer: on a loaded machine a case passed 5 s
// (shelf-followups 07). No assertion is timed.
vi.setConfig({ testTimeout: 30_000 });

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
let lastConversation: string | undefined;
async function run(
  context: PageContext,
  text = "Look at this PDF",
  tab = false,
  answer?: (a: Record<string, unknown>) => { ok: boolean; detail?: string },
  /** Continue the conversation of the previous run (what a later message of the same chat does). */
  reuse = false
) {
  const created = reuse
    ? undefined
    : ((await (
        await request("/conversations", "POST", { model: choice })
      ).json()) as ConversationSnapshot);
  const id = created?.conversation.id ?? lastConversation;
  if (!id) throw new Error("no conversation to continue");
  lastConversation = id;
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
const E1 = "E = mc2";
const sidecar = (docId: string) =>
  JSON.parse(readFileSync(join(pdfDir(docId), "annotations.json"), "utf8"));
const sidecarBytes = (docId: string) => readFileSync(join(pdfDir(docId), "annotations.json"));
const sha256Of = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const putEvents = (docId: string) =>
  broadcasts.filter((m) => m.type === "annotation.changed" && m.doc_id === docId);
type Call = Record<string, unknown>;
// biome-ignore lint/suspicious/noExplicitAny: a scripted tool result is free-form JSON the assertions read by path
type Reply = any;
/** The model calls `reader` once per builder; a builder sees the previous tool result (for its epoch). */
function chain(builders: Array<(prev: Reply) => Call>) {
  seen = [];
  script = [
    ...builders.map(
      (build, i): Step =>
        (context) => {
          const prev = i === 0 ? undefined : lastResult(context);
          try {
            return { call: build(prev) };
          } catch (error) {
            console.error("chain step", i, JSON.stringify(prev)?.slice(0, 300), error);
            throw error;
          }
        }
    ),
    () => ({ text: "x" }),
  ];
}
const results = (): Reply[] => seen.slice(1).map((context) => lastResult(context));
const base = (docId: string, sha: string, rev: number) => ({ docId, sha256: sha, rev });
const next = (docId: string, sha: string) => (prev: Reply) =>
  base(docId, sha, prev.epoch.annotationsRev);
function next2(docId: string, sha: string, fields: Call) {
  return (prev: Reply): Call => ({ ...fields, ...base(docId, sha, prev.epoch.annotationsRev) });
}
const RECT = { x: 0.1, y: 0.2, width: 0.3, height: 0.1 };

test("creates every kind through the page's own sidecar: rectangle, page and document comments, a highlight and a cross-page underline of real text", async () => {
  const { docId, sha, bytes } = await publish();
  const positionBefore = readFileSync(join(pdfDir(docId), "reading-position.json"));
  const b = (prev: Reply) => (prev ? next(docId, sha)(prev) : base(docId, sha, 0));
  chain([
    (p) => ({
      action: "create_pdf_annotation",
      ...b(p),
      kind: "rectangle",
      pageIndex: 0,
      rectangle: RECT,
      body: "R",
    }),
    (p) => ({
      action: "create_pdf_annotation",
      ...b(p),
      kind: "page_comment",
      pageIndex: 3,
      body: "P",
    }),
    (p) => ({ action: "create_pdf_annotation", ...b(p), kind: "document_comment", body: "D" }),
    (p) => ({
      action: "create_pdf_annotation",
      ...b(p),
      kind: "highlight",
      color: "#387bd1",
      parts: [{ pageIndex: 0, quote: "PAGE 1 UNIQUE" }],
      body: "H",
    }),
    (p) => ({
      action: "create_pdf_annotation",
      ...b(p),
      kind: "underline",
      parts: [
        { pageIndex: 0, quote: E1 },
        { pageIndex: 1, quote: "PAGE 2 UNIQUE" },
      ],
      body: "U",
    }),
    (p) => ({
      action: "create_pdf_annotation",
      ...b(p),
      kind: "strikeout",
      parts: [{ pageIndex: 0, quote: "UNIQUE" }],
      body: "S",
    }),
    () => ({ action: "read", docId }),
  ]);
  const { snapshot } = await run(page(pdfPage(docId, sha)));
  const written = results();
  expect(written.slice(0, 6).map((r) => r.status)).toEqual(Array(6).fill("ok"));
  expect(written.slice(0, 6).map((r) => r.epoch.annotationsRev)).toEqual([1, 2, 3, 4, 5, 6]);
  const file = sidecar(docId);
  expect(PdfAnnotationsFileSchema.safeParse(file).success).toBe(true);
  expect(file.rev).toBe(6);
  const [rect, comment, doc, highlight, underline, strike] = file.annotations;
  // the area tool's own shape and default style
  expect(rect).toMatchObject({
    kind: "rectangle",
    page_index: 0,
    rectangle: RECT,
    style: { color: "#f4c542", opacity: 0.35, line_width: 2 },
    body: "R",
  });
  expect(comment).toMatchObject({ kind: "page_comment", page_index: 3, body: "P" });
  expect(Object.keys(doc).sort()).toEqual(["body", "created_at", "id", "kind", "updated_at"]);
  expect(rect.id).toMatch(/^pann_[0-9a-f-]{36}$/);
  // a text annotation: the real quote and the rectangles of the real glyphs of the synthetic page (30..186 x 31..54 of 360x480)
  expect(highlight).toMatchObject({ kind: "highlight", color: "#387bd1", body: "H" });
  expect(highlight.target.quote).toBe("PAGE 1 UNIQUE");
  expect(highlight.target.fragments).toHaveLength(1);
  const first = highlight.target.fragments[0];
  expect(first.page_index).toBe(0);
  expect(first.rectangles).toHaveLength(1);
  expect(first.rectangles[0].x).toBeCloseTo(30 / 360, 5);
  expect(first.rectangles[0].y).toBeCloseTo(31 / 480, 5);
  expect(first.rectangles[0].width).toBeCloseTo(156 / 360, 5);
  expect(first.rectangles[0].height).toBeCloseTo(23 / 480, 5);
  // across pages: one logical annotation, quote joined with a line break, fragments grouped by page
  expect(underline.target.quote).toBe(`${E1}\nPAGE 2 UNIQUE`);
  expect(underline.target.fragments.map((f: { page_index: number }) => f.page_index)).toEqual([
    0, 1,
  ]);
  // the stored occurrence of "UNIQUE" on page 0 is unique, so no occurrence was needed
  expect(strike.target.quote).toBe("UNIQUE");
  // the PDF, the other sidecar and the LaTeX store are untouched; every save was announced once
  expect(sha256Of(readFileSync(join(pdfDir(docId), "original.pdf")))).toBe(sha256Of(bytes));
  expect(readFileSync(join(pdfDir(docId), "reading-position.json"))).toEqual(positionBefore);
  expect(existsSync(join(root, "data", "annotations"))).toBe(false);
  expect(putEvents(docId).map((m) => (m.type === "annotation.changed" ? m.cause : null))).toEqual(
    Array(6).fill("put")
  );
  // the read after them shows them with the numbers the next write needs
  expect(written[6].reading.annotationsRev).toBe(6);
  expect(written[6].reading.annotations).toHaveLength(6);
  // the page's own save accepts exactly this file: PUT of it at its revision is a no-op, not a conflict
  const put = await app.request(`/api/paper/${docId}/pdf/annotations`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(file),
  });
  expect(put.status).toBe(200);
  expect(((await put.json()) as { rev: number }).rev).toBe(6);
  expect(
    ops(snapshot)
      .filter((o) => o.action === "create_pdf_annotation")
      .map((o) => o.status)
  ).toEqual(Array(6).fill("ok"));
});

test("a stale revision or original is refused as a conflict and the stored bytes do not move", async () => {
  const { docId, sha } = await publish();
  chain([
    () => ({
      action: "create_pdf_annotation",
      ...base(docId, sha, 0),
      kind: "document_comment",
      body: "one",
    }),
    () => ({
      action: "create_pdf_annotation",
      ...base(docId, sha, 0),
      kind: "document_comment",
      body: "stale",
    }),
    () => ({
      action: "create_pdf_annotation",
      ...base(docId, "b".repeat(64), 1),
      kind: "document_comment",
      body: "other original",
    }),
  ]);
  await run(page(pdfPage(docId, sha)));
  const [first, stale, other] = results();
  expect(first.status).toBe("ok");
  expect(stale).toMatchObject({
    ok: false,
    status: "conflict",
    reason: "rev_mismatch",
    current: { annotationsRev: 1 },
  });
  expect(other).toMatchObject({ ok: false, status: "conflict", reason: "document_changed" });
  expect(sidecar(docId).annotations.map((a: { body: string }) => a.body)).toEqual(["one"]);
  expect(sidecar(docId).rev).toBe(1);
  expect(putEvents(docId)).toHaveLength(1);
});

test("what the user saved in between is never overwritten: a changed annotation or revision refuses the agent's update and delete", async () => {
  const { docId, sha } = await publish();
  // the agent creates, the user then edits that annotation in the panel (the page's PUT), the agent still holds the old reading
  chain([
    () => ({
      action: "create_pdf_annotation",
      ...base(docId, sha, 0),
      kind: "page_comment",
      pageIndex: 1,
      body: "agent text",
    }),
  ]);
  await run(page(pdfPage(docId, sha)));
  const created = sidecar(docId).annotations[0];
  const edited = structuredClone(sidecar(docId));
  edited.annotations[0].body = "the user rewrote this";
  edited.annotations[0].updated_at = "2030-01-01T00:00:00.000Z";
  const put = await app.request(`/api/paper/${docId}/pdf/annotations`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(edited),
  });
  expect(put.status).toBe(200);
  const afterUser = sidecarBytes(docId);
  const userRev = sidecar(docId).rev;
  expect(userRev).toBe(2);
  chain([
    // old revision: refused on the revision
    () => ({
      action: "update_pdf_annotation",
      ...base(docId, sha, 1),
      annotationId: created.id,
      expectedUpdatedAt: created.updated_at,
      body: "agent replaces",
    }),
    // current revision but the old state of the annotation: refused on the annotation
    () => ({
      action: "update_pdf_annotation",
      ...base(docId, sha, userRev),
      annotationId: created.id,
      expectedUpdatedAt: created.updated_at,
      body: "agent replaces",
    }),
    () => ({
      action: "delete_pdf_annotation",
      ...base(docId, sha, userRev),
      annotationId: created.id,
      expectedUpdatedAt: created.updated_at,
    }),
  ]);
  await run(page(pdfPage(docId, sha)));
  const [oldRev, oldState, del] = results();
  expect(oldRev).toMatchObject({ status: "conflict", reason: "rev_mismatch" });
  expect(oldState).toMatchObject({
    status: "conflict",
    reason: "annotation_changed",
    annotation: { body: "the user rewrote this" },
  });
  expect(del).toMatchObject({ status: "conflict", reason: "annotation_changed" });
  expect(sidecarBytes(docId)).toEqual(afterUser);
});

test("unknown keys on an annotation that stays are kept byte for byte through updates, undo and redo", async () => {
  const { docId, sha } = await publish();
  const file = sidecar(docId);
  file.annotations = [
    {
      id: "pann_user",
      kind: "rectangle",
      page_index: 2,
      rectangle: { ...RECT, x_rect: 1 },
      style: { color: "#112233", opacity: 0.5, line_width: 4, x_style: "s" },
      body: "user note",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      x_ann: { deep: true },
    },
  ];
  file.x_top = "t";
  file.rev = 1;
  writeFileSync(join(pdfDir(docId), "annotations.json"), `${JSON.stringify(file, null, 2)}\n`);
  chain([
    () => ({
      action: "update_pdf_annotation",
      ...base(docId, sha, 1),
      annotationId: "pann_user",
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
      body: "edited",
      style: { opacity: 0.9 },
      rectangle: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
    }),
    next2(docId, sha, { action: "undo_pdf_annotation" }),
    next2(docId, sha, { action: "redo_pdf_annotation" }),
  ]);
  await run(page(pdfPage(docId, sha)));
  expect(
    results()
      .slice(0, 3)
      .map((r) => r.status)
  ).toEqual(["ok", "ok", "ok"]);
  const final = sidecar(docId);
  expect(final.x_top).toBe("t");
  const only = final.annotations[0];
  expect(only.x_ann).toEqual({ deep: true });
  expect(only.style.x_style).toBe("s");
  expect(only.style).toMatchObject({ color: "#112233", opacity: 0.9, line_width: 4 });
  expect(only.rectangle).toMatchObject({ x: 0.2, y: 0.2, width: 0.2, height: 0.2, x_rect: 1 });
  expect(only.body).toBe("edited");
  // the immutable parts did not move
  expect(only).toMatchObject({
    kind: "rectangle",
    page_index: 2,
    created_at: "2026-01-01T00:00:00.000Z",
  });
});

test("text needs real text: a page without a text layer, a missing or ambiguous quote and a bad page write nothing", async () => {
  const { docId, sha } = await publish();
  const before = sidecarBytes(docId);
  const text =
    (parts: object[], kind = "highlight") =>
    () => ({
      action: "create_pdf_annotation",
      ...base(docId, sha, 0),
      kind,
      parts,
      body: "x",
    });
  chain([
    text([{ pageIndex: 2, quote: "anything" }]),
    text([{ pageIndex: 0, quote: "not on this page" }]),
    text([{ pageIndex: 0, quote: "E" }]),
    text([{ pageIndex: 0, quote: "E", occurrence: 99 }]),
    text([{ pageIndex: 12, quote: "x" }]),
    text([
      { pageIndex: 0, quote: "PAGE 1 UNIQUE" },
      { pageIndex: 2, quote: "no text there" },
    ]),
    () => ({
      action: "create_pdf_annotation",
      ...base(docId, sha, 0),
      kind: "highlight",
      parts: [{ pageIndex: 0, quote: "UNIQUE" }],
      rectangle: RECT,
      body: "x",
    }),
  ]);
  await run(page(pdfPage(docId, sha)));
  const r = results();
  expect(r[0]).toMatchObject({ ok: false, status: "invalid" });
  expect(r[0].detail).toContain("no text layer");
  expect(r[1].detail).toContain("does not occur");
  expect(r[2].detail).toContain("occurs");
  expect(r[3].detail).toContain("does not exist");
  expect(r[4].detail).toContain("outside");
  expect(r[5].detail).toContain("no text layer");
  expect(r[6]).toMatchObject({ status: "invalid" });
  expect(r.slice(0, 7).every((x) => x.ok === false)).toBe(true);
  expect(sidecarBytes(docId)).toEqual(before);
  expect(putEvents(docId)).toHaveLength(0);
});

test("an ambiguous quote is placed by occurrence, and the rectangles are those of that occurrence", async () => {
  const { docId, sha } = await publish();
  chain([
    () => ({
      action: "create_pdf_annotation",
      ...base(docId, sha, 0),
      kind: "strikeout",
      parts: [{ pageIndex: 0, quote: "E", occurrence: 0 }],
      body: "a",
    }),
    next2(docId, sha, {
      action: "create_pdf_annotation",
      kind: "strikeout",
      parts: [{ pageIndex: 0, quote: "E", occurrence: 1 }],
      body: "b",
    }),
    // the tool's default yellow is stored as no colour at all, exactly as the highlight tool stores it
    next2(docId, sha, {
      action: "create_pdf_annotation",
      kind: "highlight",
      color: "#ffd228",
      parts: [{ pageIndex: 0, quote: "PAGE 1 UNIQUE" }],
      body: "y",
    }),
  ]);
  await run(page(pdfPage(docId, sha)));
  const [a, b, yellow] = sidecar(docId).annotations;
  expect("color" in yellow).toBe(false);
  expect(a.target.fragments[0].rectangles[0].x).not.toBeCloseTo(
    b.target.fragments[0].rectangles[0].x,
    3
  );
});

test("updating changes the body, a rectangle's geometry and style and a highlight's colour; the anchors never change", async () => {
  const { docId, sha } = await publish();
  chain([
    () => ({
      action: "create_pdf_annotation",
      ...base(docId, sha, 0),
      kind: "rectangle",
      pageIndex: 0,
      rectangle: RECT,
      body: "r",
    }),
    () => ({
      action: "create_pdf_annotation",
      ...base(docId, sha, 1),
      kind: "highlight",
      parts: [{ pageIndex: 0, quote: "PAGE 1 UNIQUE" }],
      body: "h",
    }),
    () => ({ action: "read", docId }),
  ]);
  await run(page(pdfPage(docId, sha)));
  const [rect, high] = sidecar(docId).annotations;
  expect("color" in high).toBe(false); // a default-yellow highlight stores no colour, as the tool does
  const rev = (n: number) => base(docId, sha, n);
  chain([
    // same body: noop and no write
    () => ({
      action: "update_pdf_annotation",
      ...rev(2),
      annotationId: rect.id,
      expectedUpdatedAt: rect.updated_at,
      body: "r",
    }),
    // geometry and style change together; the rectangle stays on its page
    () => ({
      action: "update_pdf_annotation",
      ...rev(2),
      annotationId: rect.id,
      expectedUpdatedAt: rect.updated_at,
      rectangle: { x: 0.5, y: 0.5, width: 0.4, height: 0.4 },
      style: { color: "#ff0000", line_width: 8 },
    }),
    // a colour on a rectangle and a rectangle on a highlight are not what those controls do
    () => ({
      action: "update_pdf_annotation",
      ...rev(3),
      annotationId: rect.id,
      expectedUpdatedAt: sidecar(docId).annotations[0].updated_at,
      color: "#40a25b",
    }),
    () => ({
      action: "update_pdf_annotation",
      ...rev(3),
      annotationId: high.id,
      expectedUpdatedAt: high.updated_at,
      rectangle: RECT,
    }),
    () => ({
      action: "update_pdf_annotation",
      ...rev(3),
      annotationId: high.id,
      expectedUpdatedAt: high.updated_at,
      color: "#40a25b",
    }),
    // the colour the highlight already shows changes nothing
    () => ({
      action: "update_pdf_annotation",
      ...rev(4),
      annotationId: high.id,
      expectedUpdatedAt: sidecar(docId).annotations[1].updated_at,
      color: "#40a25b",
    }),
    () => ({
      action: "update_pdf_annotation",
      ...rev(4),
      annotationId: "pann_missing",
      expectedUpdatedAt: high.updated_at,
      body: "x",
    }),
  ]);
  await run(page(pdfPage(docId, sha)));
  const r = results();
  expect(r[0]).toMatchObject({ status: "noop" });
  expect(r[1]).toMatchObject({ status: "ok", epoch: { annotationsRev: 3 } });
  expect(r[2]).toMatchObject({ status: "invalid" });
  expect(r[3]).toMatchObject({ status: "invalid" });
  expect(r[4]).toMatchObject({ status: "ok", epoch: { annotationsRev: 4 } });
  expect(r[5]).toMatchObject({ status: "noop" });
  expect(r[6]).toMatchObject({ status: "not_found" });
  const [rect2, high2] = sidecar(docId).annotations;
  expect(rect2).toMatchObject({
    kind: "rectangle",
    page_index: 0,
    created_at: rect.created_at,
    rectangle: { x: 0.5, y: 0.5, width: 0.4, height: 0.4 },
    style: { color: "#ff0000", opacity: 0.35, line_width: 8 },
    body: "r",
  });
  expect(rect2.updated_at).not.toBe(rect.updated_at);
  expect(high2.color).toBe("#40a25b");
  expect(high2.target).toEqual(high.target);
  expect(sidecar(docId).rev).toBe(4);
});

test("delete is immediate like the trash button; undo and redo follow the panel's rules and a change by the user ends the history", async () => {
  const { docId, sha } = await publish();
  chain([
    () => ({ action: "undo_pdf_annotation", ...base(docId, sha, 0) }), // nothing yet
    () => ({
      action: "create_pdf_annotation",
      ...base(docId, sha, 0),
      kind: "page_comment",
      pageIndex: 1,
      body: "one",
    }),
    next2(docId, sha, { action: "create_pdf_annotation", kind: "document_comment", body: "two" }),
  ]);
  await run(page(pdfPage(docId, sha)));
  expect(results()[0]).toMatchObject({ status: "noop", reason: "nothing" });
  const [one, two] = sidecar(docId).annotations;
  chain([
    // delete one, at once
    () => ({
      action: "delete_pdf_annotation",
      ...base(docId, sha, 2),
      annotationId: one.id,
      expectedUpdatedAt: one.updated_at,
    }),
    // undo brings it back exactly as it was (same id, text, times)
    next2(docId, sha, { action: "undo_pdf_annotation" }),
    // undo again takes the second create back
    next2(docId, sha, { action: "undo_pdf_annotation" }),
    // redo puts it back
    next2(docId, sha, { action: "redo_pdf_annotation" }),
    // a new change clears redo
    next2(docId, sha, {
      action: "update_pdf_annotation",
      annotationId: one.id,
      expectedUpdatedAt: one.updated_at,
      body: "changed",
    }),
    next2(docId, sha, { action: "redo_pdf_annotation" }),
  ]);
  await run(page(pdfPage(docId, sha)), undefined, false, undefined, true);
  const r = results();
  expect(r[0]).toMatchObject({
    status: "ok",
    deleted: one.id,
    history: { canUndo: true, canRedo: false },
  });
  expect(r[1]).toMatchObject({
    status: "ok",
    undone: true,
    history: { canUndo: true, canRedo: true },
  });
  expect(r[2]).toMatchObject({ status: "ok", undone: true });
  expect(r[3]).toMatchObject({ status: "ok", redone: true });
  expect(r[4]).toMatchObject({ status: "ok" });
  expect(r[5]).toMatchObject({ status: "noop", reason: "nothing" });
  const stored = sidecar(docId).annotations;
  expect(stored.map((a: { body: string }) => a.body)).toEqual(["changed", "two"]);
  expect(stored[1]).toEqual(two);
  // each undo/redo was a write of its own: revisions only ever go up
  expect(sidecar(docId).rev).toBe(2 + 5);
  // the user saves something: the agent's history is over, as the panel's is after a foreign revision
  const edited = sidecar(docId);
  edited.annotations[1].body = "user edit";
  edited.annotations[1].updated_at = "2031-01-01T00:00:00.000Z";
  expect(
    (
      await app.request(`/api/paper/${docId}/pdf/annotations`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(edited),
      })
    ).status
  ).toBe(200);
  const afterUser = sidecarBytes(docId);
  chain([() => ({ action: "undo_pdf_annotation", ...base(docId, sha, 8) })]);
  await run(page(pdfPage(docId, sha)), undefined, false, undefined, true);
  expect(results()[0]).toMatchObject({ status: "noop", reason: "history_ended" });
  expect(sidecarBytes(docId)).toEqual(afterUser);
});

test("a Doc being replaced or deleted rejects the write; a damaged sidecar is an error that keeps its bytes", async () => {
  const { docId, sha } = await publish();
  docMutations.pinWriter(docId);
  const before = sidecarBytes(docId);
  chain([
    () => ({
      action: "create_pdf_annotation",
      ...base(docId, sha, 0),
      kind: "document_comment",
      body: "x",
    }),
  ]);
  await run(page(pdfPage(docId, sha)));
  expect(results()[0]).toMatchObject({ ok: false, status: "rejected" });
  expect(sidecarBytes(docId)).toEqual(before);
  docMutations.unpinWriter(docId);
  const damaged = Buffer.from('{"version":1, "this is not valid json');
  writeFileSync(join(pdfDir(docId), "annotations.json"), damaged);
  chain([
    () => ({
      action: "create_pdf_annotation",
      ...base(docId, sha, 0),
      kind: "document_comment",
      body: "x",
    }),
  ]);
  await run(page(pdfPage(docId, sha)));
  expect(results()[0]).toMatchObject({ ok: false, status: "error" });
  expect(sidecarBytes(docId)).toEqual(damaged);
  expect(putEvents(docId)).toHaveLength(0);
});

test("an unknown Doc is not found, and the LaTeX annotation actions on a PDF Doc point to the PDF ones", async () => {
  const { docId, sha } = await publish();
  chain([
    () => ({
      action: "create_pdf_annotation",
      ...base("no-such-doc", sha, 0),
      kind: "document_comment",
      body: "x",
    }),
    () => ({
      action: "create_annotation",
      docId,
      fingerprint: "a".repeat(64),
      rev: 0,
      target: { type: "document" },
      body: "x",
    }),
    () => ({
      action: "create_pdf_annotation",
      docId,
      sha256: sha,
      kind: "document_comment",
      body: "x",
    }),
  ]);
  await run(page(pdfPage(docId, sha)));
  const r = results();
  expect(r[0]).toMatchObject({ status: "not_found" });
  expect(r[1]).toMatchObject({ status: "unsupported" });
  expect(r[1].detail).toContain("create_pdf_annotation");
  expect(r[2]).toMatchObject({ status: "invalid" });
});

test("undo never overwrites a file that was edited by hand without a new revision", async () => {
  const { docId, sha } = await publish();
  chain([
    () => ({
      action: "create_pdf_annotation",
      ...base(docId, sha, 0),
      kind: "document_comment",
      body: "agent",
    }),
  ]);
  await run(page(pdfPage(docId, sha)));
  const handEdit = sidecar(docId);
  handEdit.annotations[0].body = "hand edited, same revision";
  writeFileSync(join(pdfDir(docId), "annotations.json"), `${JSON.stringify(handEdit, null, 2)}\n`);
  const bytes = sidecarBytes(docId);
  chain([() => ({ action: "undo_pdf_annotation", ...base(docId, sha, 1) })]);
  await run(page(pdfPage(docId, sha)), undefined, false, undefined, true);
  expect(results()[0]).toMatchObject({ status: "noop", reason: "changed" });
  expect(sidecarBytes(docId)).toEqual(bytes);
});

test("undo and redo cross an undone update: create, update, undo, undo, redo, redo end at the right states", async () => {
  const { docId, sha } = await publish();
  chain([
    () => ({
      action: "create_pdf_annotation",
      ...base(docId, sha, 0),
      kind: "document_comment",
      body: "v1",
    }),
    (p) => ({
      action: "update_pdf_annotation",
      ...base(docId, sha, p.epoch.annotationsRev),
      annotationId: p.annotation.id,
      expectedUpdatedAt: p.annotation.updated_at,
      body: "v2",
    }),
    next2(docId, sha, { action: "undo_pdf_annotation" }),
    next2(docId, sha, { action: "undo_pdf_annotation" }),
    next2(docId, sha, { action: "redo_pdf_annotation" }),
    next2(docId, sha, { action: "redo_pdf_annotation" }),
    next2(docId, sha, { action: "redo_pdf_annotation" }),
  ]);
  const bodies: string[][] = [];
  const watch = setInterval(
    () => bodies.push(sidecar(docId).annotations.map((a: { body: string }) => a.body)),
    1
  );
  await run(page(pdfPage(docId, sha)));
  clearInterval(watch);
  const r = results();
  expect(r.slice(0, 6).map((x) => x.status)).toEqual(Array(6).fill("ok"));
  expect(r[3]).toMatchObject({ undone: true, history: { canUndo: false, canRedo: true } });
  expect(r[5]).toMatchObject({ redone: true, history: { canUndo: true, canRedo: false } });
  expect(r[6]).toMatchObject({ status: "noop", reason: "nothing" });
  expect(sidecar(docId).annotations.map((a: { body: string }) => a.body)).toEqual(["v2"]);
  expect(sidecar(docId).rev).toBe(6);
});

test("a mixed sequence of changes can be undone to the start and redone to the end", {
  timeout: 30000,
}, async () => {
  const { docId, sha } = await publish();
  const doc = (body: string) => (p: Reply) => ({
    action: "create_pdf_annotation",
    ...base(docId, sha, p?.epoch.annotationsRev ?? 0),
    kind: "document_comment",
    body,
  });
  const upd = (index: number, body: string) => () => {
    const a = sidecar(docId).annotations[index];
    return {
      action: "update_pdf_annotation",
      ...base(docId, sha, sidecar(docId).rev),
      annotationId: a.id,
      expectedUpdatedAt: a.updated_at,
      body,
    };
  };
  const del = (index: number) => () => {
    const a = sidecar(docId).annotations[index];
    return {
      action: "delete_pdf_annotation",
      ...base(docId, sha, sidecar(docId).rev),
      annotationId: a.id,
      expectedUpdatedAt: a.updated_at,
    };
  };
  const undo = next2(docId, sha, { action: "undo_pdf_annotation" });
  const redo = next2(docId, sha, { action: "redo_pdf_annotation" });
  chain([
    doc("A"),
    doc("B"),
    upd(0, "A2"),
    del(1),
    upd(0, "A3"),
    undo,
    undo,
    undo,
    undo,
    undo,
    redo,
    redo,
    redo,
    redo,
    redo,
  ]);
  await run(page(pdfPage(docId, sha)));
  const r = results();
  expect(r.slice(0, 15).map((x) => x.status)).toEqual(Array(15).fill("ok"));
  const bodies = () => sidecar(docId).annotations.map((a: { body: string }) => a.body);
  expect(bodies()).toEqual(["A3"]);
  // the same steps once more, stopping half way, to see the middle states
  chain([
    () => ({ action: "undo_pdf_annotation", ...base(docId, sha, sidecar(docId).rev) }),
    undo,
    undo,
  ]);
  await run(page(pdfPage(docId, sha)), undefined, false, undefined, true);
  expect(bodies()).toEqual(["A", "B"]);
});

test("one conversation cannot undo another conversation's changes", async () => {
  const { docId, sha } = await publish();
  chain([
    () => ({
      action: "create_pdf_annotation",
      ...base(docId, sha, 0),
      kind: "document_comment",
      body: "from A",
    }),
  ]);
  await run(page(pdfPage(docId, sha)));
  const bytes = sidecarBytes(docId);
  // a new run is a new conversation
  chain([() => ({ action: "undo_pdf_annotation", ...base(docId, sha, 1) })]);
  await run(page(pdfPage(docId, sha)));
  expect(results()[0]).toMatchObject({ status: "noop", reason: "nothing" });
  expect(sidecarBytes(docId)).toEqual(bytes);
});

test("a PDF action on a LaTeX Doc is unsupported, not a verification error", async () => {
  const { sha } = await publish();
  // e1 is a Doc the library lists (a work's doc_ids) that has no PDF metadata
  chain([
    () => ({
      action: "create_pdf_annotation",
      docId: "e1",
      sha256: sha,
      rev: 0,
      kind: "document_comment",
      body: "x",
    }),
  ]);
  await run(page(null));
  expect(results()[0]).toMatchObject({ ok: false, status: "unsupported" });
});

test("the page's drafts reach the model as presence only, never the text", async () => {
  const { docId, sha } = await publish();
  chain([() => ({ action: "read", docId })]);
  await run(
    page(
      pdfPage(docId, sha, {
        drafts: { create: true, edit: [{ annotationId: "pann_gone", blocked: false }] },
      })
    )
  );
  const text = JSON.stringify(seen[0]);
  expect(text).toContain("pann_gone");
  expect(text).toContain("blocked");
});
