/**
 * Copilot text Docs (copilot ticket 29): reader read and annotations of a text Doc, and the text tool with the real
 * confirmation card, end to end on the real seam: real Pi
 * session, real HTTP routes, real Doc/annotation files on disk, real /ws sockets as browser tabs. Only the model
 * provider is scripted; no network.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReaderReading,
  type ConversationSnapshot,
  type CopilotConfirmation,
  type PageContext,
  PageContextSchema,
  type ReaderPage,
  type WsServerMessage,
} from "@argelanderspace/contracts";
import { libraryPaths, plansPath, readDocumentForReading } from "@argelanderspace/core";
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
async function _openTab(
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

const textReq = (path: string, method = "GET", body?: unknown) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
async function makeTextDoc(): Promise<string> {
  const res = await textReq("/api/library/text-docs", "POST", {
    workId: W1,
    operationId: `op-${randomUUID()}`,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { description: { doc_id: string } }).description.doc_id;
}
const SRC =
  "# Weak lensing\n\nFirst paragraph here. The UNIQUE-TEXT-LAST marker ends it.\n\n- alpha\n- beta\n";
async function generatedTextDoc(): Promise<string> {
  const docId = await makeTextDoc();
  expect(
    (await textReq(`/api/paper/${docId}/source`, "PUT", { expectedRev: 0, markdown: SRC })).status
  ).toBe(200);
  expect(
    (
      await textReq(`/api/paper/${docId}/source/generate`, "POST", {
        sourceRev: 1,
        operationId: "gen-seed-0001",
      })
    ).status
  ).toBe(200);
  return docId;
}
function textReaderPage(docId: string): ReaderPage {
  const { ir, file, assets } = readDocumentForReading(join(root, "data"), docId);
  return {
    docId,
    format: "text",
    sync: { phase: "ready" },
    reading: buildReaderReading({ ir, file, assets }),
    position: null,
    selection: null,
    panels: { outlineCollapsed: false, rightCollapsed: false, rightTab: "references" },
    canGoBack: false,
  };
}
function textPage(docId: string, rev = 1): PageContext {
  return {
    version: 1,
    viewId: randomUUID(),
    revision: rev,
    paneId: 1,
    view: "doc",
    status: "complete",
    otherPanes: [],
    plan: null,
    reader: textReaderPage(docId),
  };
}
async function runScript(context: PageContext, text = "Work on this text") {
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
const settledRun = (id: string) =>
  vi.waitFor(
    async () =>
      expect(["completed", "stopped", "failed"]).toContain(
        (await host.snapshot(id)).conversation.run?.status
      ),
    { timeout: 10000 }
  );
const opsOf = (snapshot: ConversationSnapshot) =>
  snapshot.messages.flatMap((m) => m.operations ?? []);

test("reader read returns a text Doc's whole reading (format text) and the page context carries it complete", async () => {
  const docId = await generatedTextDoc();
  script = [() => ({ call: { action: "read", docId } }), () => ({ text: "read" })];
  const context = textPage(docId);
  expect(PageContextSchema.safeParse(context).success).toBe(true);
  const id = await runScript(context);
  await settledRun(id);
  const reading = lastResult(seenAt(1)).reading;
  expect(reading.format).toBe("text");
  expect(reading.text.publishedSourceRev).toBe(1);
  expect(JSON.stringify(reading)).toContain("UNIQUE-TEXT-LAST");
  expect(JSON.stringify(reading)).not.toContain("main_tex");
  // the message itself carried the whole text reading, tracked like any reading
  expect(JSON.stringify(seenAt(0))).toContain("UNIQUE-TEXT-LAST");
  expect(opsOf(await host.snapshot(id))[0]).toMatchObject({
    tool: "reader",
    action: "read",
    status: "ok",
  });
});

test("create_annotation on a text Doc goes through the page's own commit: epoch and quote are checked, bytes saved", async () => {
  const docId = await generatedTextDoc();
  const created = (
    annotationsEpoch: { fingerprint: string; annotationsRev: number },
    quote: string
  ) => ({
    call: {
      action: "create_annotation",
      docId,
      fingerprint: annotationsEpoch.fingerprint,
      rev: annotationsEpoch.annotationsRev,
      target: {
        type: "text",
        block: "p-1",
        container: { type: "content" },
        start: 0,
        end: 5,
        quote,
      },
      body: "agent note",
    },
  });
  script = [
    () => ({ call: { action: "read", docId } }),
    (context) => created(lastResult(context).reading.epoch, "WRONG"),
    (_context) => created(lastResult(seenAt(1)).reading.epoch, "First"),
    () => ({ text: "done" }),
  ];
  const id = await runScript(textPage(docId));
  await settledRun(id);
  const statuses = opsOf(await host.snapshot(id)).map((o) => o.status);
  expect(statuses).toEqual(["ok", "invalid", "ok"]);
  const file = JSON.parse(
    readFileSync(join(root, "data", "annotations", docId, "current.json"), "utf8")
  );
  expect(file.annotations).toHaveLength(1);
  expect(file.annotations[0]).toMatchObject({ body: "agent note", target: { quote: "First" } });
});

test("the text tool: a replacement of annotated text waits for the real user's card; the model cannot approve; click publishes", async () => {
  const docId = await generatedTextDoc();
  expect(
    (
      await textReq(`/api/paper/${docId}/annotations`, "PUT", {
        ...((await (await textReq(`/api/paper/${docId}/annotations`)).json()) as object),
        annotations: [
          {
            id: "a_0123abc0",
            target: { type: "document" },
            body: "keep",
            created_at: "2026-09-10T10:00:00.000Z",
            updated_at: "2026-09-10T10:00:00.000Z",
          },
        ],
      })
    ).status
  ).toBe(200);
  const irBefore = readFileSync(join(root, "data", "output", docId, `${docId}.json`));
  script = [
    () => ({ tool: "text", call: { action: "read_source", docId } }),
    (context) => ({
      tool: "text",
      call: {
        action: "save_source",
        docId,
        expectedRev: lastResult(context).rev,
        markdown: "# New\n\nAll rewritten.\n",
      },
    }),
    () => ({ tool: "text", call: { action: "generate", docId, sourceRev: 2 } }),
    () => ({ text: "finished" }),
  ];
  const context = textPage(docId);
  const id = await runScript(context);
  let card: CopilotConfirmation | undefined;
  await vi.waitFor(
    async () => {
      card = (await host.snapshot(id)).confirmations[0];
      expect(card).toBeDefined();
    },
    { timeout: 8000 }
  );
  const c = card as CopilotConfirmation;
  expect(c.action).toBe("replace_text_reading");
  expect(c).toMatchObject({
    object: { id: docId },
    impact: { annotations: 1, sourceRev: 2, publishedSourceRev: 1 },
  });
  // waiting: nothing published, the run waits for the user
  expect(readFileSync(join(root, "data", "output", docId, `${docId}.json`)).equals(irBefore)).toBe(
    true
  );
  expect((await host.snapshot(id)).conversation.run?.status).toBe("waiting-for-user");
  // a click for another object or version is stale and does not publish
  const wrong = await request(`/confirmations/${c.id}`, "POST", {
    decision: "approve",
    viewId: context.viewId,
    action: c.action,
    objectId: c.object.id,
    baseRev: c.baseRev + 1,
  });
  expect(wrong.status).toBe(409);
  // the real click publishes exactly what the card showed
  const ok = await request(`/confirmations/${c.id}`, "POST", {
    decision: "approve",
    viewId: context.viewId,
    action: c.action,
    objectId: c.object.id,
    baseRev: c.baseRev,
  });
  expect(ok.status).toBe(200);
  await settledRun(id);
  const generate = opsOf(await host.snapshot(id)).find((o) => o.action === "generate");
  expect(generate?.status).toBe("ok");
  expect(readFileSync(join(root, "data", "output", docId, `${docId}.json`)).equals(irBefore)).toBe(
    false
  );
  expect(JSON.stringify(lastResult(seenAt(3)))).toContain("replacedAnnotations");
});

test("a pending card expires when the source is saved meanwhile; the click is refused and nothing is published", async () => {
  const docId = await generatedTextDoc();
  expect(
    (
      await textReq(`/api/paper/${docId}/annotations`, "PUT", {
        ...((await (await textReq(`/api/paper/${docId}/annotations`)).json()) as object),
        annotations: [
          {
            id: "a_0123abc0",
            target: { type: "document" },
            body: "keep",
            created_at: "2026-09-10T10:00:00.000Z",
            updated_at: "2026-09-10T10:00:00.000Z",
          },
        ],
      })
    ).status
  ).toBe(200);
  const irBefore = readFileSync(join(root, "data", "output", docId, `${docId}.json`));
  script = [
    () => ({ tool: "text", call: { action: "read_source", docId } }),
    (context) => ({
      tool: "text",
      call: {
        action: "save_source",
        docId,
        expectedRev: lastResult(context).rev,
        markdown: "# New\n\nRewritten.\n",
      },
    }),
    () => ({ tool: "text", call: { action: "generate", docId, sourceRev: 2 } }),
    () => ({ text: "finished" }),
  ];
  const context = textPage(docId);
  const id = await runScript(context);
  let card: CopilotConfirmation | undefined;
  await vi.waitFor(
    async () => {
      card = (await host.snapshot(id)).confirmations[0];
      expect(card).toBeDefined();
    },
    { timeout: 8000 }
  );
  const c = card as CopilotConfirmation;
  // the user types in another tab: the source moves to rev 3
  expect(
    (
      await textReq(`/api/paper/${docId}/source`, "PUT", {
        expectedRev: 2,
        markdown: "# User\n\ntyping\n",
      })
    ).status
  ).toBe(200);
  await settledRun(id);
  expect((await host.snapshot(id)).confirmations).toHaveLength(0);
  const late = await request(`/confirmations/${c.id}`, "POST", {
    decision: "approve",
    viewId: context.viewId,
    action: c.action,
    objectId: c.object.id,
    baseRev: c.baseRev,
  });
  expect([404, 409]).toContain(late.status);
  expect(readFileSync(join(root, "data", "output", docId, `${docId}.json`)).equals(irBefore)).toBe(
    true
  );
  expect(opsOf(await host.snapshot(id)).find((o) => o.action === "generate")?.status).toBe(
    "expired"
  );
});

test("N2: an unreadable annotations file at the click is an error with its reason: the card is not expired as stale, the model hears error, nothing changes", async () => {
  const docId = await generatedTextDoc();
  expect(
    (
      await textReq(`/api/paper/${docId}/annotations`, "PUT", {
        ...((await (await textReq(`/api/paper/${docId}/annotations`)).json()) as object),
        annotations: [
          {
            id: "a_0123abc0",
            target: { type: "document" },
            body: "keep",
            created_at: "2026-09-10T10:00:00.000Z",
            updated_at: "2026-09-10T10:00:00.000Z",
          },
        ],
      })
    ).status
  ).toBe(200);
  const irBefore = readFileSync(join(root, "data", "output", docId, `${docId}.json`));
  script = [
    () => ({ tool: "text", call: { action: "read_source", docId } }),
    (context) => ({
      tool: "text",
      call: {
        action: "save_source",
        docId,
        expectedRev: lastResult(context).rev,
        markdown: "# New\n\nRewritten.\n",
      },
    }),
    () => ({ tool: "text", call: { action: "generate", docId, sourceRev: 2 } }),
    () => ({ text: "finished" }),
  ];
  const context = textPage(docId);
  const id = await runScript(context);
  let card: CopilotConfirmation | undefined;
  await vi.waitFor(
    async () => {
      card = (await host.snapshot(id)).confirmations[0];
      expect(card).toBeDefined();
    },
    { timeout: 8000 }
  );
  const c = card as CopilotConfirmation;
  const current = join(root, "data", "annotations", docId, "current.json");
  writeFileSync(current, "{ damaged");
  // a background recheck meets the error and leaves the card alone: only a changed value ends a card
  await host.revalidate("doc");
  expect((await host.snapshot(id)).confirmations).toHaveLength(1);
  const click = await request(`/confirmations/${c.id}`, "POST", {
    decision: "approve",
    viewId: context.viewId,
    action: c.action,
    objectId: c.object.id,
    baseRev: c.baseRev,
  });
  expect(click.status).toBe(500);
  expect(((await click.json()) as { code: string }).code).toBe("unreadable");
  await settledRun(id);
  const generate = opsOf(await host.snapshot(id)).find((o) => o.action === "generate");
  expect(generate?.status).toBe("error");
  const payload = lastResult(seenAt(3));
  expect(payload).toMatchObject({ ok: false, status: "error" });
  expect(payload.detail).toContain("annotations_unreadable");
  expect(payload.detail).toContain("not a change");
  expect(readFileSync(current, "utf8")).toBe("{ damaged");
  expect(readFileSync(join(root, "data", "output", docId, `${docId}.json`)).equals(irBefore)).toBe(
    true
  );
});

test("29b: an evicted text source part is replaced by a stand-in naming text read_source; following its own instruction reads that part again", async () => {
  const docId = await generatedTextDoc();
  const lines = Array.from({ length: 1800 }, (_, i) => `line ${i} ${"y".repeat(60)}`).join("\n");
  expect(
    (await textReq(`/api/paper/${docId}/source`, "PUT", { expectedRev: 1, markdown: lines })).status
  ).toBe(200);
  const model = (await settings.getRuntime())
    .getModels("openai")
    .find((candidate) => candidate.id === "gpt-4.1");
  if (!model) throw new Error("fixture model");
  const original = { contextWindow: model.contextWindow, maxTokens: model.maxTokens };
  // 64_000 + 1_710: the same room after the shelf tool (shelf ticket 07, footprint +2991 B; see WINDOW_BIG_DOC in copilot-batching.test.ts)
  // + 1_631: attach_local_pdf (+556, project intake ticket 01), list_ads_libraries / read_ads_library (+839, ticket 02) and its repair round (+236); footprint +973/+1469/+412 B x 4/7
  model.contextWindow = 68_769; // + 512: release-0.2 ticket 09 search_ads (footprint +896 B); + 120: ticket 04 repair round 2 (footprint +210 B); + 44: ticket 04 repair round (footprint +77 B); - 3: ticket 03 closing touch-up (footprint -6 B); + 317: ticket 03 fix round (footprint +555 B); + 63: ticket 02 second repair round (footprint +110 B); + 375: project intake ticket 03 (footprint +657 B)
  model.maxTokens = 1024;
  try {
    type Batch = { from: number; to: number; total: number; status: string; version: string };
    type Result = { markdown?: string; batch?: Batch };
    const stand = (context: TranscriptContext): string | null => {
      for (const m of context.messages) {
        if (m.role !== "toolResult") continue;
        const part = m.content[0];
        try {
          const json = JSON.parse(part && part.type === "text" ? part.text : "{}");
          if (json.status === "evicted") return json.detail as string;
        } catch {
          // not a record
        }
      }
      return null;
    };
    let standIn: string | null = null;
    let rereadFrom = -1;
    let reread: Result | null = null;
    script = Array.from({ length: 60 }, () => (context: TranscriptContext) => {
      let last: Result = {};
      try {
        last = lastResult(context) as Result;
      } catch {
        // the first request: nothing was read yet
      }
      if (!last.batch) return { tool: "text", call: { action: "read_source", docId } };
      if (rereadFrom >= 0 && !reread) reread = last;
      if (last.batch.status !== "complete" && rereadFrom < 0)
        return {
          tool: "text",
          call: { action: "read_source", docId, from: last.batch.to, version: last.batch.version },
        };
      standIn ??= stand(context);
      if (rereadFrom < 0 && standIn) {
        const way =
          /(text read_source|reader read) \{docId, from: (\d+), version: "([^"]+)"\}/.exec(standIn);
        if (way?.[1] === "text read_source") {
          rereadFrom = Number(way[2]);
          return {
            tool: "text",
            call: { action: "read_source", docId, from: rereadFrom, version: way[3] },
          };
        }
      }
      return { text: "done" };
    });
    const id = await runScript(textPage(docId), "read the whole source");
    await settledRun(id);
    const done = opsOf(await host.snapshot(id)).filter((o) => o.action === "read_source");
    expect(done.some((o) => o.batch?.status === "complete")).toBe(true);
    expect(standIn).not.toBeNull();
    expect(standIn).toContain("text read_source");
    expect(standIn).not.toContain("reader read");
    expect(rereadFrom).toBeGreaterThanOrEqual(0);
    const again = reread as Result | null;
    expect(again?.batch?.from).toBe(rereadFrom);
    expect(
      lines.startsWith(again?.markdown ?? "\u0000", rereadFrom) ||
        lines.slice(rereadFrom).startsWith(again?.markdown ?? "\u0000")
    ).toBe(true);
  } finally {
    Object.assign(model, original);
  }
}, 30000);

test("after a restart an expired text-replacement card reads as a replacement: nothing was published, not deleted", async () => {
  const docId = await generatedTextDoc();
  expect(
    (
      await textReq(`/api/paper/${docId}/annotations`, "PUT", {
        ...((await (await textReq(`/api/paper/${docId}/annotations`)).json()) as object),
        annotations: [
          {
            id: "a_0123abc0",
            target: { type: "document" },
            body: "keep",
            created_at: "2026-09-10T10:00:00.000Z",
            updated_at: "2026-09-10T10:00:00.000Z",
          },
        ],
      })
    ).status
  ).toBe(200);
  script = [
    () => ({ tool: "text", call: { action: "read_source", docId } }),
    (context) => ({
      tool: "text",
      call: {
        action: "save_source",
        docId,
        expectedRev: lastResult(context).rev,
        markdown: "# New\n\nRewritten.\n",
      },
    }),
    () => ({ tool: "text", call: { action: "generate", docId, sourceRev: 2 } }),
    () => ({ text: "after restart" }),
  ];
  const context = textPage(docId);
  const id = await runScript(context);
  await vi.waitFor(async () => expect((await host.snapshot(id)).confirmations).toHaveLength(1), {
    timeout: 8000,
  });
  const crashed = host;
  host = new CopilotHost(join(root, "data"), settings, () => {});
  app = createApp({
    docMutations,
    paths,
    statusDir: join(root, "status"),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(root, "jobs") }),
    providerSettings: settings,
    copilot: host,
    broadcast: (message) => broadcasts.push(message),
  });
  expect((await host.snapshot(id)).conversation.run?.status).toBe("interrupted");
  expect((await request(`/views/${context.viewId}`, "PUT", context)).status).toBe(200);
  const resumed = await request(`/conversations/${id}/resume`, "POST", {
    clientMessageId: randomUUID(),
    viewId: context.viewId,
    contextRevision: context.revision,
  });
  expect(resumed.status).toBe(202);
  await settledRun(id);
  const transcript = JSON.stringify(seen.at(-1)?.messages);
  expect(transcript).toContain("nothing was published and the request is no longer valid");
  expect(transcript).not.toContain("nothing was deleted and the request is no longer valid");
  await crashed.close();
});
