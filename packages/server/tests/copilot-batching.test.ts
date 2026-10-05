/**
 * Context batching (copilot ticket 24, spec §7.2), end to end on the real seam: real Pi session, real HTTP routes,
 * real Doc files on disk, the real PDFium engine. Only the model provider is scripted; no network. Windows are set
 * on the catalog model so that the synthetic documents are several times larger than the room left.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReaderReading,
  type ConversationSnapshot,
  type PageContext,
  type PdfPage,
  type ReaderPage,
  type TexDocIr,
  type WsServerMessage,
} from "@argelanderspace/contracts";
import {
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
import { createApp } from "../src/app.js";
import { CopilotHost } from "../src/copilot.js";
import { DocMutationRegistry } from "../src/doc-mutations.js";
import { JobRunner } from "../src/jobs.js";
import { readPdfTextMaterialCached } from "../src/pdf-material.js";
import { probePdf } from "../src/pdfium-probe.js";
import { ProviderSettings } from "../src/providers.js";
import { stubPipelines, stubSources } from "./helpers.js";
import { syntheticPdf } from "./pdf-fixture.js";

type Out = { text?: string; call?: Record<string, unknown>; tool?: string; error?: string };
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
const _lastResult = (context: TranscriptContext) => {
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
        if (out.error) {
          const failed: AssistantMessage = {
            ...message,
            content: [],
            stopReason: "error",
            errorMessage: out.error,
          };
          stream.push({ type: "error", reason: "error", error: failed });
          return;
        }
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

afterEach(async () => {
  await host.close();
  process.env = originalEnv;
  vi.unstubAllGlobals();
});

// ---- a synthetic Doc on disk ------------------------------------------------------------------------ //
const DOC = "read-doc";
const LAST = "UNIQUE-LAST-PARAGRAPH-MARKER-7f3a";
const TABLE_CELL = "TABLE-LAST-CELL-91bc";
const REF_RAW = "REFERENCE-LAST-RAW-TEXT-4d2e";
const docDir = () => join(root, "data", "output", DOC);
const irFile = () => join(docDir(), `${DOC}.json`);
const _currentFile = () => join(root, "data", "annotations", DOC, "current.json");
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
async function run(context: PageContext, text = "Look at this paper") {
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
  if (sent.status !== 202) throw new Error(`send ${sent.status} ${await sent.text()}`);
  await vi.waitFor(
    async () => {
      expect((await host.snapshot(id)).conversation.run?.status).not.toBe("running");
    },
    { timeout: 20000 }
  );
  return { id, snapshot: await host.snapshot(id) };
}
const ops = (snapshot: ConversationSnapshot) =>
  snapshot.messages.flatMap((m) => m.operations ?? []);

// ---- helpers of this suite ----------------------------------------------------------------------------- //
/** Runs `fn` with the catalog model's window set to `tokens` (the synthetic documents are then several windows long). */
async function withWindow<T>(tokens: number, fn: () => Promise<T>): Promise<T> {
  const model = (await settings.getRuntime())
    .getModels("openai")
    .find((candidate) => candidate.id === "gpt-4.1");
  if (!model) throw new Error("fixture model");
  const original = { contextWindow: model.contextWindow, maxTokens: model.maxTokens };
  model.contextWindow = tokens;
  model.maxTokens = 1024;
  try {
    return await fn();
  } finally {
    Object.assign(model, original);
  }
}
const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((block) => (block?.type === "text" ? block.text : "")).join("")
      : "";
/** Every user message the model was sent in this request, parsed (the host's envelopes). */
const envelopes = (context: TranscriptContext) =>
  context.messages.filter((m) => m.role === "user").map((m) => JSON.parse(textOf(m.content)));
const toolResults = (context: TranscriptContext) =>
  context.messages
    .filter((m) => m.role === "toolResult")
    .map((m) => JSON.parse(textOf((m as { content: unknown }).content)));
/** What the model knows of its reading progress: the newest read result, else the first message's coverage. */
function progress(context: TranscriptContext) {
  const results = toolResults(context);
  const last = results.at(-1);
  return last ? last : { batch: envelopes(context)[0]?.coverage, ok: true };
}
/** A scripted model that keeps reading with `from = batch.to` until the batch says complete. */
const keepReading: Step = (context) => {
  const state = progress(context);
  const batch = state.batch;
  if (!batch || batch.status === "complete" || batch.to >= batch.total)
    return { text: "FINISHED-ALL-PARTS" };
  if (batch.status === "omitted" && !state.ok) return { text: "stuck" };
  return { call: { action: "read", docId: DOC, from: batch.to } };
};
async function send(id: string, context: PageContext, text: string) {
  const sent = await request(`/conversations/${id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text,
    viewId: context.viewId,
    contextRevision: context.revision,
  });
  if (sent.status !== 202) return { status: sent.status, body: await sent.json() };
  await vi.waitFor(
    async () => {
      expect((await host.snapshot(id)).conversation.run?.status).not.toBe("running");
    },
    { timeout: 20000 }
  );
  return { status: 202, body: null };
}
const WINDOW_BIG_DOC = 56_000;

// ---- Reader: a document many windows long -------------------------------------------------------------- //
test("a Reader document several windows long is delivered in parts with its range; reading on reaches the last unique marker, earlier parts leave the conversation and the record stays", async () => {
  writeDoc(docIr(900));
  await withWindow(WINDOW_BIG_DOC, async () => {
    script = Array.from({ length: 20 }, () => keepReading);
    const { id, snapshot } = await run(page());
    // the first message says exactly what it holds and what it does not
    const first = envelopes(seenAt(0))[0];
    expect(first.coverage).toMatchObject({
      kind: "reader",
      unit: "entries",
      status: "partial",
      from: 0,
      head: true,
    });
    expect(first.coverage.to).toBeLessThan(first.coverage.total);
    expect(first.coverage.note).toMatch(/NOT read/);
    expect(first.context.reader.reading.entries).toHaveLength(first.coverage.to);
    expect(JSON.stringify(seenAt(0).messages)).not.toContain(LAST);
    // every later part comes with batch and the last one says complete
    const results = seen.flatMap((context) => toolResults(context));
    expect(results.length).toBeGreaterThan(1);
    const batches = ops(snapshot).map((operation) => operation.batch);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.at(-1)?.status).toBe("complete");
    // the parts follow each other without a gap and cover [0, total)
    let to = first.coverage.to;
    for (const batch of batches) {
      expect(batch?.from).toBe(to);
      to = batch?.to ?? to;
    }
    expect(to).toBe(first.coverage.total);
    // the last unique paragraph really was in a model request
    expect(seen.some((context) => JSON.stringify(context.messages).includes(LAST))).toBe(true);
    // a part that was read and replaced is no longer sent: the last request holds the last part, not the first
    const lastRequest = JSON.stringify(seen.at(-1)?.messages);
    expect(lastRequest).toContain(LAST);
    expect(lastRequest).not.toContain("Paragraph 2 of the synthetic paper");
    expect(lastRequest).toMatch(/taken out of the conversation/);
    // the message detail keeps the range and says it was taken out
    const message = snapshot.messages.find((m) => m.role === "user");
    expect(message?.context?.coverage).toMatchObject({ status: "partial", evicted: true });
    // the operation records carry the ranges
    expect(ops(snapshot).every((operation) => operation.status === "ok")).toBe(true);
    // a restarted host loads the very same history (the envelopes still satisfy the contract)
    const again = new CopilotHost(join(root, "data"), settings, () => {});
    try {
      const reloaded = await again.snapshot(id);
      expect(reloaded.messages.find((m) => m.role === "user")?.context?.coverage).toMatchObject({
        status: "partial",
        evicted: true,
      });
    } finally {
      await again.close();
    }
  });
});

test("after a huge document the conversation still takes a message: nothing is repeated and the answer to what is unread is explicit", async () => {
  writeDoc(docIr(900));
  await withWindow(WINDOW_BIG_DOC, async () => {
    script = [() => ({ text: "first" }), () => ({ text: "second" })];
    const context = page();
    const { id } = await run(context, "Summarise it");
    const sent = await send(id, context, "thanks, and what is the weather");
    expect(sent.status).toBe(202);
    const second = envelopes(seenAt(1)).at(-1);
    // the first part is still in the conversation: it is not delivered again, and what is unread is said so
    expect(second.coverage).toMatchObject({ status: "omitted", kind: "reader" });
    expect(second.coverage.note).toMatch(/already in the conversation/);
    expect(second.coverage.note).toMatch(/NOT in the conversation|NOT in this message/);
    expect(second.context.reader.reading).toBeNull();
    expect(second.context.reader.readingOmitted.coverage.blocks).toBe(903);
    const snapshot = await host.snapshot(id);
    const lastUser = snapshot.messages.filter((m) => m.role === "user").at(-1);
    expect(lastUser?.context?.status).toBe("complete");
    expect(lastUser?.context?.coverage?.status).toBe("omitted");
  });
});

test("a message whose reading did not fit the window is never refused for it: a document larger than the whole window still gets its message through", async () => {
  writeDoc(docIr(2500));
  await withWindow(WINDOW_BIG_DOC, async () => {
    script = [() => ({ text: "ok" })];
    const { snapshot } = await run(page(), "just hello");
    expect(snapshot.conversation.run?.status).toBe("completed");
    expect(envelopes(seenAt(0))[0].coverage.status).toBe("partial");
  });
});

test("a whole reading that fits is delivered whole once; the same version is not repeated, a changed one is", async () => {
  script = [() => ({ text: "one" }), () => ({ text: "two" }), () => ({ text: "three" })];
  const context = page();
  const { id } = await run(context, "first");
  expect(envelopes(seenAt(0))[0].coverage).toMatchObject({ status: "complete", from: 0 });
  expect(JSON.stringify(seenAt(0).messages)).toContain(LAST);
  expect((await send(id, context, "second")).status).toBe(202);
  const held = envelopes(seenAt(1)).at(-1);
  expect(held.coverage).toMatchObject({ status: "held" });
  expect(held.coverage.note).toMatch(/already delivered whole/);
  // the whole reading is in the conversation exactly once
  expect(JSON.stringify(seenAt(1).messages).split(LAST).length - 1).toBe(1);
  // the Doc changes (new fingerprint): the new reading is delivered whole again
  writeDoc(docIr(3, "A-DIFFERENT-LAST-PARAGRAPH-0001"));
  const next = page(readerPage(), 2, context.viewId);
  expect((await request(`/views/${next.viewId}`, "PUT", next)).status).toBe(200);
  expect((await send(id, next, "third")).status).toBe(202);
  const changed = envelopes(seenAt(2)).at(-1);
  expect(changed.coverage).toMatchObject({ status: "complete" });
  expect(JSON.stringify(seenAt(2).messages)).toContain("A-DIFFERENT-LAST-PARAGRAPH-0001");
});

test("a single entry larger than any room is reported as the actual gap, with nothing returned and nothing claimed read", async () => {
  const ir = docIr(3);
  const section = ir.sections[0];
  if (!section) throw new Error("fixture");
  section.blocks.splice(1, 0, {
    id: "p-huge",
    type: "paragraph",
    segments: [{ type: "text", text: "HUGE-PARAGRAPH ".repeat(30_000) }],
  });
  writeDoc(ir);
  await withWindow(WINDOW_BIG_DOC, async () => {
    script = [keepReading, keepReading, () => ({ text: "gap reported" })];
    const { snapshot } = await run(page());
    const first = envelopes(seenAt(0))[0].coverage;
    expect(first.status).toBe("partial");
    const result = toolResults(seenAt(1)).at(-1);
    expect(result).toMatchObject({ ok: false, status: "rejected" });
    expect(result.detail).toMatch(/entry p-huge/);
    expect(result.detail).toMatch(/smallest part/);
    expect(result.detail).toMatch(/NOT read/);
    expect(result.batch).toMatchObject({ status: "omitted", from: first.to, to: first.to });
    expect(ops(snapshot).at(-1)).toMatchObject({ status: "rejected" });
    // the model was never told the rest was read
    expect(JSON.stringify(seen.at(-1)?.messages)).not.toContain("FINISHED-ALL-PARTS");
  });
});

test("read refuses a from beyond the document, and an in-range from continues exactly there", async () => {
  script = [
    () => ({ call: { action: "read", docId: DOC, from: 500 } }),
    () => ({ call: { action: "read", docId: DOC, from: 2 } }),
    () => ({ text: "done" }),
  ];
  const { snapshot } = await run(page());
  const beyond = toolResults(seenAt(1)).at(-1);
  expect(beyond).toMatchObject({ ok: false, status: "invalid" });
  const part = toolResults(seenAt(2)).at(-1);
  expect(part).toMatchObject({ ok: true, batch: { from: 2, status: "complete" } });
  expect(part.entries[0].id).toBeDefined();
  expect(part.reading).toBeUndefined();
  expect(ops(snapshot).map((operation) => operation.status)).toEqual(["invalid", "ok"]);
});

// ---- provider rejection ------------------------------------------------------------------------------- //
test("a provider that rejects a request as too large keeps the input and progress, withdraws the part it rejected and reads smaller parts on retry", async () => {
  writeDoc(docIr(900));
  await withWindow(WINDOW_BIG_DOC, async () => {
    let firstPart = 0;
    script = [
      keepReading,
      (context) => {
        firstPart =
          (toolResults(context).at(-1)?.batch?.to ?? 0) -
          (toolResults(context).at(-1)?.batch?.from ?? 0);
        return { error: "400 maximum context length exceeded for this model" };
      },
    ];
    const context = page();
    const { id, snapshot } = await run(context, "read all of it");
    expect(snapshot.conversation.run).toMatchObject({
      status: "failed",
      error: "provider_capacity",
    });
    expect(firstPart).toBeGreaterThan(0);
    // the user's words are there and the rejected part is withdrawn: not counted as read
    expect(snapshot.messages.some((m) => m.role === "user" && m.text === "read all of it")).toBe(
      true
    );
    const read = ops(snapshot).at(-1);
    expect(read).toMatchObject({ status: "rejected" });
    expect(read?.batch).toBeUndefined();
    // retry (resume): the next part it reads is smaller than the one that was rejected
    // (the stub counts requests across runs)
    const before = seen.length;
    script = [
      ...Array.from({ length: before }, () => () => ({ text: "earlier" })),
      () => ({ call: { action: "read", docId: DOC, from: envelopes(seenAt(0))[0].coverage.to } }),
      () => ({ text: "continuing" }),
    ];
    const resumed = await request(`/conversations/${id}/resume`, "POST", {
      clientMessageId: randomUUID(),
      viewId: context.viewId,
      contextRevision: context.revision,
    });
    expect(resumed.status).toBe(202);
    await vi.waitFor(
      async () => {
        expect((await host.snapshot(id)).conversation.run?.status).toBe("completed");
      },
      { timeout: 20000 }
    );
    const retried = seen
      .slice(before)
      .flatMap((c) => toolResults(c))
      .find((r) => r.batch?.status === "partial" || r.batch?.status === "complete");
    expect(retried).toBeDefined();
    expect(retried.batch.to - retried.batch.from).toBeLessThan(firstPart);
  });
});

// ---- PDF: many pages -------------------------------------------------------------------------------- //
test("a PDF several windows long is delivered in page parts, reading on reaches the last page's unique marker and never claims the whole before", async () => {
  const bytes = syntheticPdf({ pageCount: 100, outline: true });
  const probed = await probePdf(bytes);
  const metadata = publishPdfDoc(paths, {
    workId: W1,
    filename: "long.pdf",
    bytes,
    pages: probed.pages,
  });
  const docId = metadata.doc_id;
  const pdf: PdfPage = {
    docId,
    format: "pdf",
    phase: "ready",
    sha256: metadata.sha256,
    pageCount: 100,
    currentPage: 0,
    zoom: { mode: "fit_width", percent: 100 },
    outline: [],
    outlineTruncated: false,
    search: null,
    selection: null,
    panels: { outlineCollapsed: false, annotationsCollapsed: false },
  };
  const context: PageContext = {
    version: 1,
    viewId: randomUUID(),
    revision: 1,
    paneId: 1,
    view: "doc",
    status: "complete",
    otherPanes: [],
    plan: null,
    pdf,
  };
  await withWindow(48_000, async () => {
    const reader: Step = (c) => {
      const state = progress(c);
      const batch = state.batch;
      if (!batch || batch.status === "complete" || batch.to >= batch.total)
        return { text: "FINISHED-ALL-PARTS" };
      return { call: { action: "read", docId, from: batch.to } };
    };
    script = Array.from({ length: 30 }, () => reader);
    const { snapshot } = await run(context, "read the PDF");
    const first = envelopes(seenAt(0))[0];
    expect(first.coverage).toMatchObject({
      kind: "pdf",
      unit: "pages",
      status: "partial",
      from: 0,
    });
    expect(first.pdf.reading.pages).toHaveLength(first.coverage.to);
    expect(first.pdf.reading.pages.at(-1).pageIndex).toBe(first.coverage.to - 1);
    expect(JSON.stringify(seenAt(0).messages)).not.toContain("PAGE 100 UNIQUE");
    expect(seen.some((c) => JSON.stringify(c.messages).includes("PAGE 100 UNIQUE"))).toBe(true);
    const batches = ops(snapshot).map((operation) => operation.batch);
    expect(batches.at(-1)?.to).toBe(100);
    expect(batches.at(-1)?.status).toBe("complete");
    expect(snapshot.messages.find((m) => m.role === "user")?.context?.coverage?.status).toBe(
      "partial"
    );
  });
});

test("the whole text of one original is read once, not on every message", async () => {
  const bytes = syntheticPdf({ pageCount: 4 });
  const probed = await probePdf(bytes);
  const metadata = publishPdfDoc(paths, {
    workId: W1,
    filename: "c.pdf",
    bytes,
    pages: probed.pages,
  });
  const one = await readPdfTextMaterialCached(bytes, metadata.sha256);
  const two = await readPdfTextMaterialCached(bytes, metadata.sha256);
  expect(two).toBe(one);
  // another file with a hash it does not have is never served the cached text
  await expect(
    readPdfTextMaterialCached(syntheticPdf({ pageCount: 5 }), metadata.sha256)
  ).rejects.toThrow();
});
