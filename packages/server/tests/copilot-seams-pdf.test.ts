/**
 * Ticket 32, lane B: concurrency, A->B and damaged-file seams on the PDF Doc surface. Real Pi session, the real
 * `reader` tool, the real annotations lock and sidecar files, real PDFium, the page's own PUT as the user's side.
 * Only the model provider is scripted; no network. Cases are recorded in
 * `.scratch/copilot/evidence/32/seams/README.md`.
 */
import { randomUUID } from "node:crypto";
import {
  lstatSync,
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
import type {
  ConversationSnapshot,
  PageContext,
  PdfPage,
  WsServerMessage,
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
const sidecar = (docId: string) =>
  JSON.parse(readFileSync(join(pdfDir(docId), "annotations.json"), "utf8"));
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

const putSidecar = (docId: string, file: unknown) =>
  app.request(`/api/paper/${docId}/pdf/annotations`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(file),
  });
/** Every byte under a path (a file, or a directory's sorted names with their bytes), for exact comparison. */
function treeBytes(path: string): string {
  const stat = lstatSync(path);
  if (stat.isDirectory())
    return readdirSync(path)
      .sort()
      .map((name) => `${name}=${treeBytes(join(path, name))}`)
      .join("|");
  return readFileSync(path).toString("base64");
}
const docBytes = (docId: string) => treeBytes(pdfDir(docId));
const isError = (status: number) => status >= 400 && status < 600;

// ---- (a) the user's save and the agent's edit of the same annotation, truly concurrent ---------------------- //
test("(a) the user's PUT and the agent's update of the same annotation race at several offsets, the user's first and the agent's first: exactly one wins every round, the loser is told, nothing is applied twice or lost", async () => {
  const { docId, sha } = await publish();
  chain([
    () => ({
      action: "create_pdf_annotation",
      ...base(docId, sha, 0),
      kind: "page_comment",
      pageIndex: 1,
      body: "seed",
    }),
  ]);
  await run(page(pdfPage(docId, sha)));
  const outcomes: string[] = [];
  for (const [round, delay] of [null, 0, 1, 3, 8, 15, 30].entries()) {
    const file = sidecar(docId);
    const target = file.annotations[0];
    const edited = structuredClone(file);
    edited.annotations[0].body = `user ${round}`;
    edited.annotations[0].updated_at = `2031-01-0${round + 1}T00:00:00.000Z`;
    const events = putEvents(docId).length;
    let userPut: Promise<Response> | Response | undefined;
    chain([
      () => {
        // null: on the wire in the same turn as the tool call (the user's save is queued first)
        userPut =
          delay === null
            ? putSidecar(docId, edited)
            : new Promise<void>((resolve) => setTimeout(resolve, delay)).then(() =>
                putSidecar(docId, edited)
              );
        return {
          action: "update_pdf_annotation",
          ...base(docId, sha, file.rev),
          annotationId: target.id,
          expectedUpdatedAt: target.updated_at,
          body: `agent ${round}`,
        };
      },
    ]);
    await run(page(pdfPage(docId, sha)), "edit it", false, undefined, true);
    const put = await userPut;
    const agent = results()[0];
    const final = sidecar(docId);
    if (put?.status === 200) {
      expect(agent, `round ${round}`).toMatchObject({ ok: false, status: "conflict" });
      expect(final.annotations[0].body).toBe(`user ${round}`);
      outcomes.push("user");
    } else {
      expect(put?.status, `round ${round}`).toBe(409);
      expect(agent.status, `round ${round}`).toBe("ok");
      expect(final.annotations[0].body).toBe(`agent ${round}`);
      outcomes.push("agent");
    }
    // one bump, one announcement, one annotation: never both applied, never an overwrite of the other
    expect(final.rev).toBe(file.rev + 1);
    expect(final.annotations).toHaveLength(1);
    expect(putEvents(docId).length).toBe(events + 1);
  }
  // the sweep is only meaningful if the lock really decided; record which side won (both are legal orders)
  expect(outcomes).toHaveLength(7);
  expect(outcomes[0]).toBe("user");
  expect(outcomes).toContain("agent");
});

// ---- (b) the user opens Doc B while the agent works on Doc A ------------------------------------------------ //
test("(b) the user opens another PDF mid-run: the write still lands on A, B's bytes are untouched, and the model is told the page moved", async () => {
  const a = await publish();
  const b = await publish(syntheticPdf({ pageCount: 5 }));
  expect(b.docId).not.toBe(a.docId);
  const bBefore = docBytes(b.docId);
  const view = page(pdfPage(a.docId, a.sha));
  const movedToB = { ...page(pdfPage(b.docId, b.sha), 2), viewId: view.viewId };
  script = [
    () => ({ call: { action: "read", docId: a.docId } }),
    async () => {
      expect((await request(`/views/${view.viewId}`, "PUT", movedToB)).status).toBe(200);
      return {
        call: {
          action: "create_pdf_annotation",
          ...base(a.docId, a.sha, 0),
          kind: "document_comment",
          body: "about A",
        },
      };
    },
    () => ({ text: "done" }),
  ];
  const { snapshot } = await run(view);
  expect(ops(snapshot).map((o) => `${o.action}:${o.status}`)).toEqual([
    "read:ok",
    "create_pdf_annotation:ok",
  ]);
  expect(sidecar(a.docId).annotations.map((x: { body: string }) => x.body)).toEqual(["about A"]);
  expect(docBytes(b.docId)).toBe(bBefore);
  expect(putEvents(b.docId)).toHaveLength(0);
  expect(JSON.stringify(seen[2]?.messages)).toContain(b.docId);
  // the message that started the task keeps pointing at A
  expect(snapshot.messages.find((m) => m.role === "user")?.context?.objects?.[0]).toMatchObject({
    id: a.docId,
  });
});

// ---- (g) damaged sidecars and a PDF changed or lost underneath ---------------------------------------------- //
test.each(["empty", "future-version", "bound-to-another-original", "directory", "truncated"])(
  "(g) a damaged annotations sidecar (%s) is an error to read, write and the page: never an empty list, never reset, bytes kept",
  async (kind) => {
    const { docId, sha } = await publish();
    const path = join(pdfDir(docId), "annotations.json");
    const original = readFileSync(path, "utf8");
    if (kind === "empty") writeFileSync(path, "");
    if (kind === "truncated") writeFileSync(path, original.slice(0, original.length >> 1));
    if (kind === "future-version")
      writeFileSync(path, original.replace(/"version":\s*1/, '"version": 99'));
    if (kind === "bound-to-another-original") {
      expect(original).toContain(sha);
      writeFileSync(path, original.replace(sha, "c".repeat(64)));
    }
    if (kind === "directory") {
      rmSync(path);
      mkdirSync(path);
    }
    if (kind === "future-version" || kind === "bound-to-another-original")
      expect(readFileSync(path, "utf8")).not.toBe(original);
    const before = docBytes(docId);
    chain([
      () => ({ action: "read", docId }),
      () => ({
        action: "create_pdf_annotation",
        ...base(docId, sha, 0),
        kind: "document_comment",
        body: "x",
      }),
    ]);
    const { snapshot } = await run(page(pdfPage(docId, sha)));
    const [read, write] = results();
    expect(write, JSON.stringify(write)).toMatchObject({ ok: false, status: "error" });
    expect(["error", "conflict"]).toContain(read.status);
    expect(read.status).not.toBe("ok");
    expect(ops(snapshot).map((o) => o.status)).not.toContain("ok");
    expect(isError((await app.request(`/api/paper/${docId}/pdf/annotations`)).status)).toBe(true);
    expect(isError((await putSidecar(docId, { version: 1, rev: 0, annotations: [] })).status)).toBe(
      true
    );
    expect(docBytes(docId)).toBe(before);
    expect(putEvents(docId)).toHaveLength(0);
  }
);

test.each(["replaced", "missing", "directory"])(
  "(g) the original PDF %s underneath: read and write are honest refusals (a changed file is a conflict, a lost one an error), nothing is written or healed",
  async (kind) => {
    const { docId, sha } = await publish();
    const original = join(pdfDir(docId), "original.pdf");
    if (kind === "replaced") writeFileSync(original, syntheticPdf({ pageCount: 2 }));
    if (kind === "missing") rmSync(original);
    if (kind === "directory") {
      rmSync(original);
      mkdirSync(original);
    }
    const before = docBytes(docId);
    chain([
      () => ({ action: "read", docId }),
      () => ({
        action: "create_pdf_annotation",
        ...base(docId, sha, 0),
        kind: "document_comment",
        body: "x",
      }),
      () => ({ action: "read_page_image", docId, pageIndex: 0, sha256: sha }),
    ]);
    const { snapshot } = await run(page(pdfPage(docId, sha)));
    const [read, write, image] = results();
    const expected = kind === "replaced" ? "conflict" : "error";
    expect(write, JSON.stringify(write)).toMatchObject({ ok: false, status: expected });
    expect(read.status, JSON.stringify(read)).toBe(expected);
    expect(image.status ?? image.state ?? "").not.toBe("ok");
    expect(ops(snapshot).map((o) => o.status)).not.toContain("ok");
    expect(docBytes(docId)).toBe(before);
    expect(putEvents(docId)).toHaveLength(0);
  }
);
