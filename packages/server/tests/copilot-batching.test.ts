/**
 * Context batching (copilot ticket 24, spec §7.2), end to end on the real seam: real Pi session, real HTTP routes,
 * real Doc files on disk, the real PDFium engine. Only the model provider is scripted; no network. Windows are set
 * on the catalog model so that the synthetic documents are several times larger than the room left.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

type Out = {
  text?: string;
  call?: Record<string, unknown>;
  tool?: string;
  error?: string;
  id?: string;
};
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
                  id: out.id ?? `call_${index}`,
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
  return { call: { action: "read", docId: DOC, from: batch.to, version: batch.version } };
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
// ticket 32 lane D: the reader tool text gained one sentence about the set_panel floor fold (~0.1 KB), window 40100 -> 40200.
// tickets 29 and 30 (read_svg_image added ~0.4 KB): the text tool and its prompt add about 4.2 KB (about 2.1k tokens) to the instruction, so the calibrated windows moved up by that
// ticket 32 merge (lanes A + D together): retry_plans and the set_panel floor sentence, 61700 -> 61800.
// ticket 33 follow-up: undo_delete_task (action + about 0.4 KB of plan tool text, about 200 tokens): 61800 -> 62000; fix round 1 re-measured, unchanged.
const WINDOW_BIG_DOC = 62_000;

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
    // the gap travels in the operation record itself (real data: the UI shows it from here)
    expect(ops(snapshot).at(-1)?.batch).toMatchObject({
      status: "omitted",
      gap: { id: "p-huge", bytes: expect.any(Number) },
    });
    // the model was never told the rest was read
    expect(JSON.stringify(seen.at(-1)?.messages)).not.toContain("FINISHED-ALL-PARTS");
  });
});

test("a continuation names its version: beyond the document is invalid, no version is invalid, another version is a conflict, the right one continues exactly there", async () => {
  let version = "";
  script = [
    () => ({ call: { action: "read", docId: DOC } }),
    (context) => {
      version = toolResults(context).at(-1)?.batch?.version;
      return { call: { action: "read", docId: DOC, from: 500, version } };
    },
    () => ({ call: { action: "read", docId: DOC, from: 2 } }),
    () => ({ call: { action: "read", docId: DOC, from: 2, version: "someone-else#9" } }),
    () => ({ call: { action: "read", docId: DOC, from: 2, version } }),
    () => ({ text: "done" }),
  ];
  const { snapshot } = await run(page());
  expect(version).toMatch(/#0$/);
  expect(toolResults(seenAt(2)).at(-1)).toMatchObject({ ok: false, status: "invalid" });
  expect(toolResults(seenAt(3)).at(-1)).toMatchObject({ ok: false, status: "invalid" });
  const conflict = toolResults(seenAt(4)).at(-1);
  expect(conflict).toMatchObject({
    ok: false,
    status: "conflict",
    reason: "version_changed",
    version,
  });
  expect(conflict.total).toBeGreaterThan(2);
  const part = toolResults(seenAt(5)).at(-1);
  expect(part).toMatchObject({ ok: true, batch: { from: 2, status: "complete", version } });
  expect(part.entries[0].id).toBeDefined();
  expect(part.reading).toBeUndefined();
  expect(ops(snapshot).map((operation) => operation.status)).toEqual([
    "ok",
    "invalid",
    "invalid",
    "conflict",
    "ok",
  ]);
});

test("a document that changed between two parts is never stitched: the continuation is refused with the new version", async () => {
  writeDoc(docIr(900));
  await withWindow(WINDOW_BIG_DOC, async () => {
    let changed = false;
    script = [
      keepReading,
      (context) => {
        if (!changed) {
          changed = true;
          writeDoc(docIr(900, "CHANGED-LAST-PARAGRAPH-0002"));
        }
        return keepReading(context);
      },
      keepReading,
      () => ({ text: "end" }),
    ];
    await run(page());
    const results = seen.flatMap((context) => toolResults(context));
    const refused = results.find((r) => r.reason === "version_changed");
    expect(refused).toBeDefined();
    expect(refused.version).not.toBe(envelopes(seenAt(0))[0].coverage.version);
    // nothing of the new version was returned, so no result claims complete across versions
    expect(results.some((r) => r.batch?.status === "complete")).toBe(false);
  });
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
    // the history keeps the read as it was (ok); the ledger says it was withdrawn
    const read = ops(snapshot).at(-1);
    expect(read).toMatchObject({ status: "ok", batch: { withdrawn: true } });
    // the durable history still holds the part itself, and what the next request shows is the stand-in
    const stored = readFileSync(
      join(
        root,
        "data",
        "copilot",
        "sessions",
        readdirSync(join(root, "data", "copilot", "sessions"))[0] ?? ""
      ),
      "utf8"
    );
    expect(stored).toContain("Paragraph 150 of the synthetic paper");
    // retry (resume): the next part it reads is smaller than the one that was rejected
    // (the stub counts requests across runs)
    const before = seen.length;
    script = [
      ...Array.from({ length: before }, () => () => ({ text: "earlier" })),
      () => ({
        call: {
          action: "read",
          docId: DOC,
          from: envelopes(seenAt(0))[0].coverage.to,
          version: envelopes(seenAt(0))[0].coverage.version,
        },
      }),
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
  // ticket 33 follow-up: undo_delete_task moved this calibration 49700 -> 49900 (about 200 tokens); fix round 1 (longer undo_delete_task text) 49900 -> 50000.
  await withWindow(50_000, async () => {
    const reader: Step = (c) => {
      const state = progress(c);
      const batch = state.batch;
      if (!batch || batch.status === "complete" || batch.to >= batch.total)
        return { text: "FINISHED-ALL-PARTS" };
      return { call: { action: "read", docId, from: batch.to, version: batch.version } };
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

// ---- fix round 1: the durable ledger, no wedge, versions, totals ------------------------------------------- //
const historyText = async (id: string) =>
  readFileSync(
    join(
      root,
      "data",
      "copilot",
      "sessions",
      `${(await host.snapshot(id)).conversation.sessionId}.jsonl`
    ),
    "utf8"
  );
const ledgerLines = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.includes('"customType":"argelander.delivery.v1"'))
    .map((line) => JSON.parse(line).data);
const hostInternals = () =>
  host as unknown as {
    loaded: Map<string, { run?: { readings: Set<string> } }>;
    shedAll(loaded: unknown): number;
    view(loaded: unknown): { ceiling?: number };
  };

test("the durable history keeps every message and part as sent; evictions are a separate ledger entry the requests project (spec 8.2)", async () => {
  writeDoc(docIr(900));
  await withWindow(WINDOW_BIG_DOC, async () => {
    script = Array.from({ length: 20 }, () => keepReading);
    const { id, snapshot } = await run(page());
    const stored = await historyText(id);
    // the first part is still on disk in full, byte for byte what the model was first sent
    expect(stored).toContain("Paragraph 100 of the synthetic paper");
    expect(stored).not.toContain("were read, then taken out of the conversation");
    const ledger = ledgerLines(stored);
    expect(ledger.length).toBeGreaterThan(0);
    expect(
      ledger
        .flatMap((entry) => entry.records)
        .every((r: { action: string }) => r.action === "evict")
    ).toBe(true);
    // what the last request showed in its place keeps the document's own total (never the slice's length)
    const first = envelopes(seenAt(0))[0].coverage;
    const standIn = envelopes(seen.at(-1) as TranscriptContext)[0];
    expect(standIn.coverage).toMatchObject({ status: "omitted", total: first.total });
    expect(standIn.context.reader.readingOmitted.note).toMatch(/taken out of the conversation/);
    // the user's own view keeps the Doc title on the chip, the range and the original status of every read
    const message = snapshot.messages.find((m) => m.role === "user");
    expect(message?.context?.objects[0]?.name).toBe("A Synthetic Reader Paper");
    expect(message?.context?.coverage).toMatchObject({
      evicted: true,
      total: first.total,
      to: first.to,
    });
    expect(ops(snapshot).every((operation) => operation.status === "ok")).toBe(true);
    expect(
      ops(snapshot).every(
        (operation) => operation.batch?.evicted === true || operation.batch?.status === "complete"
      )
    ).toBe(true);
  });
});

test("a conversation is never wedged by what it read: a message that fits only after shedding sheds, oldest first, and is accepted", async () => {
  writeDoc(docIr(900));
  await withWindow(WINDOW_BIG_DOC, async () => {
    script = [() => ({ text: "first" }), () => ({ text: "second" })];
    const context = page();
    const { id } = await run(context, "Summarise it");
    const before = ledgerLines(await historyText(id)).length;
    // a message so long that only a conversation without the first delivery has room for it
    await host.snapshot(id);
    const dbg = (
      host as unknown as {
        ledgerState(l: unknown): { deliveries: { key: string; coverage: unknown }[] };
      }
    ).ledgerState((host as unknown as { loaded: Map<string, unknown> }).loaded.get(id));
    const sent = await send(id, context, "x".repeat(40_000));
    if (sent.status !== 202)
      throw new Error(
        `DBGD ${JSON.stringify(dbg.deliveries.map((d) => [d.key.slice(0, 20), !!d.coverage]))}`
      );
    const records = ledgerLines(await historyText(id)).flatMap((entry) => entry.records);
    expect(ledgerLines(await historyText(id)).length).toBe(before + 1);
    expect(records[0]).toMatchObject({ action: "evict", target: { kind: "message" } });
    // the first delivery is no longer in the request, the second message is
    expect(JSON.stringify(seenAt(1).messages)).not.toContain(
      "Paragraph 100 of the synthetic paper"
    );
    expect((await host.snapshot(id)).conversation.run?.status).toBe("completed");
  });
});

test("a message that cannot be accepted leaves no ledger record behind", async () => {
  writeDoc(docIr(900));
  const context = page();
  let id = "";
  await withWindow(WINDOW_BIG_DOC, async () => {
    script = [() => ({ text: "first" })];
    id = (await run(context, "Summarise it")).id;
  });
  const before = await historyText(id);
  // a window nothing fits: refused, and nothing was shed on the way
  await withWindow(8_000, async () => {
    const sent = await send(id, context, "again");
    expect(sent.status).toBe(400);
  });
  expect(await historyText(id)).toBe(before);
});

test("a provider rejection with no delivery of the run's own sheds the older ones, so the retry is a different request", async () => {
  writeDoc(docIr(900));
  await withWindow(WINDOW_BIG_DOC, async () => {
    script = [() => ({ text: "first" })];
    const context = page();
    const { id } = await run(context, "Summarise it");
    const requestsBefore = seen.length;
    script = [
      ...Array.from({ length: requestsBefore }, () => () => ({ text: "earlier" })),
      () => ({ error: "400 maximum context length exceeded" }),
      () => ({ text: "retried" }),
    ];
    // (this message carries no reading of its own: the page has none)
    const plain = page(null, 2, context.viewId);
    expect((await request(`/views/${plain.viewId}`, "PUT", plain)).status).toBe(200);
    expect((await send(id, plain, "hello")).status).toBe(202);
    expect((await host.snapshot(id)).conversation.run).toMatchObject({
      status: "failed",
      error: "provider_capacity",
    });
    const failedRequest = JSON.stringify(seenAt(requestsBefore).messages);
    expect(ledgerLines(await historyText(id)).flatMap((entry) => entry.records)).toContainEqual({
      action: "evict",
      target: { kind: "message", id: expect.any(String) },
    });
    const resumed = await request(`/conversations/${id}/resume`, "POST", {
      clientMessageId: randomUUID(),
      viewId: plain.viewId,
      contextRevision: plain.revision,
    });
    expect(resumed.status).toBe(202);
    await vi.waitFor(async () => {
      expect((await host.snapshot(id)).conversation.run?.status).toBe("completed");
    });
    expect(JSON.stringify(seenAt(requestsBefore + 1).messages)).not.toBe(failedRequest);
    expect(JSON.stringify(seenAt(requestsBefore + 1).messages)).not.toContain(
      "Paragraph 100 of the synthetic paper"
    );
  });
});

test("the ceiling a provider rejection teaches is the rejected part's size, halved, persisted and kept after a restart", async () => {
  writeDoc(docIr(900));
  await withWindow(WINDOW_BIG_DOC, async () => {
    script = [
      keepReading,
      (context) => {
        const part = toolResults(context).at(-1)?.batch;
        expect(part).toBeDefined();
        return { error: "400 maximum context length exceeded" };
      },
    ];
    const { id } = await run(page(), "read it all");
    const [entry] = ledgerLines(await historyText(id)).filter((data) => data.ceiling !== undefined);
    expect(entry.records).toContainEqual({
      action: "withdraw",
      target: { kind: "tool", id: expect.any(String) },
    });
    // the rejected part itself, as it sits in the history
    const rejected = toolResults(seenAt(1)).at(-1);
    const size = JSON.stringify(JSON.stringify(rejected)).length;
    expect(entry.ceiling).toBeLessThan(size);
    expect(entry.ceiling).toBeGreaterThanOrEqual(Math.floor(size / 3));
    const again = new CopilotHost(join(root, "data"), settings, () => {});
    try {
      await again.snapshot(id);
      const internals = again as unknown as {
        loaded: Map<string, unknown>;
        view(loaded: unknown): { ceiling?: number };
      };
      expect(internals.view(internals.loaded.get(id)).ceiling).toBe(entry.ceiling);
    } finally {
      await again.close();
    }
  });
});

test("an evicted reading is no longer 'in the task's context', and a held message never points at a delivery that left", async () => {
  script = [() => ({ text: "one" }), () => ({ text: "two" }), () => ({ text: "three" })];
  const context = page();
  const { id } = await run(context, "first");
  expect((await send(id, context, "second")).status).toBe(202);
  expect(envelopes(seenAt(1)).at(-1).coverage.status).toBe("held");
  const internals = hostInternals();
  const loaded = internals.loaded.get(id);
  expect(internals.shedAll(loaded)).toBeGreaterThan(0);
  // the held message of the history, restated for the next request, no longer says the reading is there
  expect((await send(id, context, "third")).status).toBe(202);
  const sentMessages = envelopes(seenAt(2));
  const restated = sentMessages.find((e) => e.text === "second");

  expect(restated.coverage.status).toBe("omitted");
  expect(restated.coverage.note).toMatch(/taken out of the conversation/);
  // and the third message delivers the reading again (nothing is present to be held)
  expect(sentMessages.at(-1).coverage.status).toBe("complete");
  // the user's view says the same
  const snapshot = await host.snapshot(id);
  const held = snapshot.messages.filter((m) => m.role === "user")[1];
  expect(held?.context?.coverage).toMatchObject({ status: "held", evicted: true });
});

test("a run's held-reading keys follow the ledger when its reading is shed", async () => {
  let keysBefore = -1;
  let keysAfter = -1;
  const keys = () => {
    const internals = hostInternals();
    const [conversationId] = [...internals.loaded.keys()];
    return internals.loaded.get(conversationId ?? "");
  };
  script = [
    () => {
      // the whole reading came with the message: it is "in the task's context"
      keysBefore = keys()?.run?.readings.size ?? -1;
      hostInternals().shedAll(keys());
      return { call: { action: "read", docId: DOC } };
    },
    () => {
      // shed: a later observation must not claim the full reading is in the task's context
      keysAfter = keys()?.run?.readings.size ?? -1;
      return { text: "ok" };
    },
  ];
  await run(page());
  expect(keysBefore).toBe(1);
  expect(keysAfter).toBe(0);
});

test("a held PDF still states that the model cannot read the scanned pages", async () => {
  const bytes = syntheticPdf({ pageCount: 6, outline: true });
  const probed = await probePdf(bytes);
  const metadata = publishPdfDoc(paths, {
    workId: W1,
    filename: "scan.pdf",
    bytes,
    pages: probed.pages,
  });
  const pdf: PdfPage = {
    docId: metadata.doc_id,
    format: "pdf",
    phase: "ready",
    sha256: metadata.sha256,
    pageCount: 6,
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
  const model = (await settings.getRuntime()).getModels("openai").find((m) => m.id === "gpt-4.1");
  if (!model) throw new Error("fixture model");
  const original = [...model.input];
  model.input = ["text"];
  try {
    script = [() => ({ text: "one" }), () => ({ text: "two" })];
    const { id } = await run(context, "first");
    expect((await send(id, context, "second")).status).toBe(202);
    const held = envelopes(seenAt(1)).at(-1);
    expect(held.pdf).toMatchObject({ status: "held", modelAcceptsImages: false });
    expect(held.pdf.detail).toMatch(/cannot take images/);
    const snapshot = await host.snapshot(id);
    const summary = snapshot.messages.filter((m) => m.role === "user")[1]?.context?.pdf?.material;
    expect(summary).toMatchObject({ status: "held", modelAcceptsImages: false, pages: 0 });
    expect(summary?.totals?.pagesWithoutText).toBeGreaterThan(0);
  } finally {
    model.input = original as typeof model.input;
  }
});

test("a message carrying no reading is not refused for the room a huge one took, and a Plan page is never wedged either", async () => {
  writeDoc(docIr(900));
  await withWindow(WINDOW_BIG_DOC, async () => {
    script = [() => ({ text: "first" }), () => ({ text: "second" })];
    const context = page();
    const { id } = await run(context, "Summarise it");
    const plan: PageContext = {
      ...page(null, 2, context.viewId),
      view: "plan",
      status: "unavailable",
    };
    expect((await request(`/views/${plan.viewId}`, "PUT", plan)).status).toBe(200);
    expect((await send(id, plan, "and what now?")).status).toBe(202);
    expect((await host.snapshot(id)).conversation.run?.status).toBe("completed");
  });
});

// ---- fix round 2 ---------------------------------------------------------------------------------------- //
const sessionPath = async (id: string) =>
  join(
    root,
    "data",
    "copilot",
    "sessions",
    `${(await host.snapshot(id)).conversation.sessionId}.jsonl`
  );

test("a history from before coverage was recorded (reads without batch, envelopes without coverage) is never wedged after a restart", async () => {
  writeDoc(docIr(900));
  let id = "";
  const context = page();
  // written the way tickets 18-23 did (whole reads, in a window that held them) ...
  await withWindow(400_000, async () => {
    script = [
      () => ({ call: { action: "read", docId: DOC } }),
      () => ({ call: { action: "read", docId: DOC } }),
      () => ({ text: "read twice" }),
    ];
    id = (await run(context, "read all")).id;
  });
  // ... and continued in a window that cannot hold them
  await withWindow(WINDOW_BIG_DOC, async () => {
    // make it look like tickets 18-23 wrote it: no batch on the reads, no coverage in the envelopes, no ledger
    const path = await sessionPath(id);
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.customType !== "argelander.delivery.v1");
    for (const entry of lines) {
      if (entry.type !== "message") continue;
      if (entry.message.role === "toolResult" && entry.message.details) {
        delete entry.message.details.batch;
        // the old whole reading: put the first part's reading back as it was (a whole reading of a small document)
        const payload = JSON.parse(entry.message.content[0].text);
        if (payload.entries) continue;
        delete payload.batch;
        entry.message.content[0].text = JSON.stringify(payload);
      }
      if (entry.message.role === "user") {
        const text =
          typeof entry.message.content === "string"
            ? entry.message.content
            : entry.message.content[0].text;
        const parsed = JSON.parse(text);
        delete parsed.coverage;
        const next = JSON.stringify(parsed);
        entry.message.content =
          typeof entry.message.content === "string" ? next : [{ type: "text", text: next }];
      }
    }
    // (dropping the ledger entries must keep the chain of parents intact)
    let previous: string | null = null;
    for (const entry of lines) {
      if (entry.type === "session") continue;
      entry.parentId = previous;
      previous = entry.id;
    }
    writeFileSync(path, `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    // a restart: the host reloads the stripped history
    (host as unknown as { loaded: Map<string, unknown> }).loaded.delete(id);
    const sent = await send(id, context, "x".repeat(30_000));
    expect(sent.status).toBe(202);
    const records = ledgerLines(await historyText(id)).flatMap((entry) => entry.records);
    expect(records.length).toBeGreaterThan(0);
    // the old envelope (now without coverage) was shed through a synthesized one
    expect(records.some((r: { target: { kind: string } }) => r.target.kind === "message")).toBe(
      true
    );
  });
});

test("an old whole `reader read` result with no batch is recognised by its tool and action and can be shed", async () => {
  script = [
    () => ({ call: { action: "read", docId: DOC } }),
    () => ({ text: "done" }),
    () => ({ text: "again" }),
  ];
  const context = page();
  const { id } = await run(context, "read it");
  const path = await sessionPath(id);
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  for (const entry of lines)
    if (entry.type === "message" && entry.message.role === "toolResult") {
      delete entry.message.details.batch;
      const payload = JSON.parse(entry.message.content[0].text);
      delete payload.batch;
      entry.message.content[0].text = JSON.stringify(payload);
    }
  writeFileSync(path, `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  (host as unknown as { loaded: Map<string, unknown> }).loaded.delete(id);
  const internals = hostInternals();
  await host.snapshot(id);
  expect(internals.shedAll(internals.loaded.get(id))).toBeGreaterThanOrEqual(2);
  expect(ledgerLines(await historyText(id)).flatMap((entry) => entry.records)).toContainEqual({
    action: "evict",
    target: { kind: "tool", id: expect.any(String) },
  });
});

test("a tool-call id of 225 characters is mapped to a bounded key: the ledger is written, read back and projected", async () => {
  const long = `call_${"x".repeat(220)}`;
  expect(long.length).toBe(225);
  script = [
    () => ({ call: { action: "read", docId: DOC }, id: long }),
    () => ({ text: "done" }),
    () => ({ text: "again" }),
  ];
  const context = page();
  const { id } = await run(context, "read it");
  const internals = hostInternals();
  expect(internals.shedAll(internals.loaded.get(id))).toBeGreaterThanOrEqual(1);
  const records = ledgerLines(await historyText(id)).flatMap((entry) => entry.records);
  const tool = records.find((r: { target: { kind: string } }) => r.target.kind === "tool");
  expect(tool.target.id.length).toBeLessThanOrEqual(200);
  expect(tool.target.id).not.toContain("xxxxxxxx");
  // read back after a restart and projected into the next request
  (host as unknown as { loaded: Map<string, unknown> }).loaded.delete(id);
  expect((await send(id, context, "once more")).status).toBe(202);
  // the shed copies are gone from the request: the reading is there once (the new message's own)
  expect(
    JSON.stringify(seen.at(-1)?.messages).split("Paragraph 2 of the synthetic paper").length - 1
  ).toBe(1);
  const reloaded = await host.snapshot(id);
  expect(reloaded.messages.flatMap((m) => m.operations ?? [])[0]?.status).toBe("ok");
});

test("a window barely above the instruction (40500 tokens): a read that finds no room is an honest gap, not a failed run", async () => {
  writeDoc(docIr(900));
  await withWindow(
    40_500, // ticket 33 follow-up: undo_delete_task added about 200 tokens (40200 -> 40400); fix round 2 (scoped-lookup sentence in the tool text) 40400 -> 40500. Ticket 32: retry_plans (about 70 bytes of tool text) moved the calibration up by 100 tokens
    async () => {
      script = [() => ({ call: { action: "read", docId: DOC } }), () => ({ text: "gap noted" })];
      const { snapshot } = await run(page(), "read it");
      expect(snapshot.conversation.run).toMatchObject({ status: "completed", error: null });
      const result = toolResults(seenAt(1)).at(-1);
      expect(result).toMatchObject({ ok: false, status: "rejected" });
      expect(result.detail).toMatch(/capacity/);
      expect(result.detail).toMatch(/none of it is read|NOT read/);
    }
  );
});

// ---- ticket 32: the history-growth carry-over of tickets 24 and 29 ---------------------------------------- //
test("ticket 32 measurement: after eviction every read step leaves a small constant residue in the request and in the stored history, never a growing one", async () => {
  writeDoc(docIr(4500));
  const samples: {
    request: number;
    residue: number;
    delivered: number;
    stored: number;
    evicted: boolean;
  }[] = [];
  const storedBytes = () => {
    try {
      const dir = join(root, "data", "copilot", "sessions");
      return readdirSync(dir)
        .map((name) => readFileSync(join(dir, name), "utf8").length)
        .reduce((a, b) => a + b, 0);
    } catch {
      return 0;
    }
  };
  const measure: Step = (context) => {
    const request = JSON.stringify(context.messages).length;
    // what the request holds besides the part the last read just delivered = the residue the steps leave behind
    const lastResult = context.messages.filter((m) => m.role === "toolResult").at(-1) as
      | { content?: unknown }
      | undefined;
    samples.push({
      request,
      residue: request - textOf(lastResult?.content).length,
      delivered: textOf(lastResult?.content).length,
      stored: storedBytes(),
      evicted: JSON.stringify(context.messages).includes("taken out of the conversation"),
    });
    return keepReading(context);
  };
  let finalRun: unknown;
  await withWindow(WINDOW_BIG_DOC, async () => {
    script = Array.from({ length: 60 }, () => measure);
    const { snapshot } = await run(page());
    finalRun = snapshot.conversation.run;
  });
  const after = samples.filter((sample) => sample.evicted);
  expect(after.length).toBeGreaterThanOrEqual(8); // enough read steps after the first eviction to see a slope
  // The first step after the eviction is the shedding step itself (the request shrinks): the slope starts after it.
  const residueSteps = after
    .slice(2)
    .map((sample, i) => sample.residue - (after[i + 1]?.residue ?? 0));
  // what the durable file gained at each step besides the part just delivered = the stored overhead of the step
  const storedOverhead = after
    .slice(1)
    .map((sample, i) => sample.stored - (after[i]?.stored ?? 0) - sample.delivered);
  // MEASURED (61.7k-token window, 4500-entry Reader document, 13 steps after the first eviction): the request keeps
  // 1315..1445 bytes of residue per read step (assistant call, its record and the stand-in) and the stored history
  // gains about 2.3 KB per step besides the part itself (the "about 2 KB per step" of tickets 24 and 29).
  // Bounded per step on both sides (a real cost exists, and it is small) and flat: no step costs more because the
  // history is longer.
  expect(Math.min(...residueSteps)).toBeGreaterThan(800);
  expect(Math.max(...residueSteps)).toBeLessThan(2048);
  expect(Math.max(...residueSteps) - Math.min(...residueSteps)).toBeLessThan(512);
  // stored overhead per step: 5079 .. 2031 bytes, falling as the parts shrink (JSON escaping of the part is in it);
  // the smallest step, with a 5-entry part, is the pure cost of the step
  expect(Math.min(...storedOverhead)).toBeGreaterThan(1500);
  expect(Math.min(...storedOverhead)).toBeLessThan(3000);
  expect(Math.max(...storedOverhead)).toBeLessThan(6000);
  // never rising with the length of the history
  storedOverhead.slice(1).forEach((cost, i) => {
    expect(cost).toBeLessThanOrEqual((storedOverhead[i] ?? 0) + 64);
  });
  // What it adds up to: linear in the number of steps, so the room (not the history) ends a read of a document that is
  // too long for the window with the honest gap of ticket 24, never a failed run.
  expect(finalRun).toMatchObject({ status: "completed", error: null });
}, 120_000);
