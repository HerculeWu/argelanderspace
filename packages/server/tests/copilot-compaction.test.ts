/**
 * Copilot context compaction (release-0.2 ticket 11), end to end on the real seam: real Pi session, real HTTP routes,
 * real history files. Only the model provider is scripted: it answers a chat request with a short reply and a summary
 * request (recognised by pi's summarization system prompt) with whatever the test sets; no network.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReaderReading,
  type ConversationSnapshot,
  DELIVERY_LEDGER_TYPE,
  type PageContext,
  type ReaderPage,
  type TexDocIr,
} from "@argelanderspace/contracts";
import { libraryPaths, plansPath, readDocumentForReading } from "@argelanderspace/core";
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import { CopilotHost } from "../src/copilot.js";
import { JobRunner } from "../src/jobs.js";
import { ProviderSettings } from "../src/providers.js";
import { stubPipelines, stubSources } from "./helpers.js";

type Answer = { text: string } | { error: string } | { hang: true };
let root: string;
let host: CopilotHost;
let app: ReturnType<typeof createApp>;
let settings: ProviderSettings;
let originalEnv: NodeJS.ProcessEnv;
let chats: TranscriptContext[];
let summaries: TranscriptContext[];
/** What the next summary request is answered with. */
let summaryAnswer: (request: string) => Answer;
let language: "zh-CN" | "en";
const choice = { provider: "openai", model: "gpt-4.1", thinking: null };
const SUMMARY = "SUMMARY-OF-THE-EARLIER-CONVERSATION";
const DOC = "read-doc";
const READING_MARK = "UNIQUE-READING-PARAGRAPH-MARKER-5c1e";
const PLAN = "p_00000001";

const request = (path: string, method = "GET", body?: unknown) =>
  app.request(`/api/copilot${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const textOf = (context: TranscriptContext) => JSON.stringify(context.messages);
const isSummary = (context: TranscriptContext) =>
  JSON.stringify(context.messages[0]).includes("context summarization assistant") ||
  JSON.stringify(context).includes("context summarization assistant");

function reply(model: Model<Api>, text: string, signal?: AbortSignal) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    stopReason: "stop",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  void (async () => {
    stream.push({ type: "start", partial: message });
    if (signal)
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    stream.push(
      signal
        ? {
            type: "error",
            reason: "aborted",
            error: { ...message, stopReason: "aborted", errorMessage: "aborted" },
          }
        : { type: "done", reason: "stop", message }
    );
  })();
  return stream;
}

beforeEach(async () => {
  originalEnv = process.env;
  root = mkdtempSync(join(tmpdir(), "copilot-compaction-"));
  process.env = { PATH: originalEnv.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "config") };
  vi.stubGlobal("fetch", () => {
    throw new Error("unexpected external fetch");
  });
  const statusDir = join(root, "status");
  mkdirSync(statusDir, { recursive: true });
  writeFileSync(plansPath(statusDir), JSON.stringify({ version: 1, rev: 1, plans: [] }, null, 2));
  chats = [];
  summaries = [];
  language = "zh-CN";
  summaryAnswer = () => ({ text: SUMMARY });
  settings = new ProviderSettings();
  await settings.credential("openai", "SYNTHETIC_COPILOT_KEY");
  const runtime = await settings.getRuntime();
  const model = runtime.getModels("openai").find((candidate) => candidate.id === "gpt-4.1");
  if (!model) throw new Error("fixture model");
  model.contextWindow = 200_000;
  model.maxTokens = 1024;
  runtime.registerProvider("openai", {
    api: "openai-responses",
    streamSimple(candidate: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
      if (isSummary(context)) {
        summaries.push(structuredClone(context));
        const answer = summaryAnswer(textOf(context));
        if ("hang" in answer) return reply(candidate, "", options?.signal);
        if ("error" in answer) {
          const stream = createAssistantMessageEventStream();
          const failed: AssistantMessage = {
            role: "assistant",
            content: [],
            api: candidate.api,
            provider: candidate.provider,
            model: candidate.id,
            timestamp: Date.now(),
            stopReason: "error",
            errorMessage: answer.error,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          };
          queueMicrotask(() => stream.push({ type: "error", reason: "error", error: failed }));
          return stream;
        }
        return reply(candidate, answer.text);
      }
      chats.push(structuredClone(context));
      return reply(candidate, "Noted.");
    },
  });
  build();
});
afterEach(async () => {
  await host.close();
  process.env = originalEnv;
  vi.unstubAllGlobals();
});
const paths = () => libraryPaths(join(root, "data"));
function build() {
  host = new CopilotHost(join(root, "data"), settings, () => {});
  host.useLanguage(() => language);
  app = createApp({
    paths: paths(),
    statusDir: join(root, "status"),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(root, "jobs") }),
    providerSettings: settings,
    copilot: host,
  });
}
async function create() {
  const response = await request("/conversations", "POST", { model: choice });
  expect(response.status).toBe(201);
  return ((await response.json()) as ConversationSnapshot).conversation.id;
}
/** A Plan page that names one plan: the object the messages are about. */
function plan(): PageContext {
  return {
    version: 1,
    viewId: randomUUID(),
    paneId: 1,
    view: "plan",
    revision: 1,
    status: "complete",
    otherPanes: [],
    plan: {
      rev: 9,
      mode: "list",
      selectedPlanId: PLAN,
      saveState: "saved",
      groups: [],
      detail: null,
      plans: [
        {
          id: PLAN,
          name: "Plan A",
          due: "2026-12-01",
          icon: "target",
          created_at: "2026-10-02T00:00:00Z",
          tasks: [],
        },
      ],
    },
  };
}
const filler = (tag: string, bytes: number) =>
  `${tag} ${"lorem ipsum dolor sit amet ".repeat(Math.ceil(bytes / 27))}`;
async function send(id: string, text: string, context: PageContext = plan()) {
  expect((await request(`/views/${context.viewId}`, "PUT", context)).status).toBe(200);
  return request(`/conversations/${id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text,
    viewId: context.viewId,
    contextRevision: context.revision,
  });
}
async function settled(id: string) {
  await vi.waitFor(async () => {
    expect(["running", "stopping"]).not.toContain(
      (await host.snapshot(id)).conversation.run?.status
    );
  });
  return host.snapshot(id);
}
/** A completed turn of about `kb` kilobytes. */
async function turn(id: string, tag: string, kb = 40, context?: PageContext) {
  const response = await send(id, filler(tag, kb * 1000), context);
  if (response.status !== 202) throw new Error(`send ${response.status} ${await response.text()}`);
  const done = await settled(id);
  expect(done.conversation.run?.status).toBe("completed");
  return done;
}
const historyFile = (snapshot: ConversationSnapshot) =>
  join(root, "data/copilot/sessions", `${snapshot.conversation.sessionId}.jsonl`);
const entriesOf = (snapshot: ConversationSnapshot) =>
  readFileSync(historyFile(snapshot), "utf8")
    .split("\n")
    .filter(Boolean)
    .map(
      (line) => JSON.parse(line) as { type: string; customType?: string; [key: string]: unknown }
    );

// ---- a Doc whose reading is a delivery the ledger can take out ---------------------------------- //
const docDir = () => join(root, "data", "output", DOC);
function writeDoc(paragraphs: number) {
  const ir: TexDocIr = {
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
          ...Array.from({ length: paragraphs }, (_, n) => ({
            id: `p-${n + 1}`,
            type: "paragraph" as const,
            segments: [
              {
                type: "text" as const,
                text: `Paragraph ${n + 1} of the synthetic paper. ${"x".repeat(180)}`,
              },
            ],
          })),
          { id: "p-last", type: "paragraph", segments: [{ type: "text", text: READING_MARK }] },
        ],
        children: [],
      },
    ],
    refsManifest: [],
    bib: [],
    citationsByBlock: {},
    source: { type: "latex", origin: "x", main_tex: "main.tex" },
    meta: { title: "A Synthetic Reader Paper" },
  };
  mkdirSync(join(docDir(), "assets"), { recursive: true });
  writeFileSync(join(docDir(), `${DOC}.json`), JSON.stringify(ir));
}
function reader(): PageContext {
  const { ir, file, assets } = readDocumentForReading(join(root, "data"), DOC);
  const page: ReaderPage = {
    docId: DOC,
    format: "latex",
    sync: { phase: "ready" },
    reading: buildReaderReading({ ir, file, assets }),
    position: { activeSectionId: "sec-1", visibleBlockIds: ["p-1"] },
    selection: null,
    panels: { outlineCollapsed: false, rightCollapsed: false, rightTab: "references" },
    canGoBack: false,
  };
  return {
    version: 1,
    viewId: randomUUID(),
    revision: 1,
    paneId: 1,
    view: "doc",
    status: "complete",
    otherPanes: [],
    plan: null,
    reader: page,
  };
}

test("a pure conversation that outgrows the window is compacted automatically, and the run goes on from the summary", async () => {
  const id = await create();
  let done = await turn(id, "TURN-1");
  for (let n = 2; n <= 16 && !summaries.length; n++) done = await turn(id, `TURN-${n}`);
  expect(summaries).toHaveLength(1);
  expect(done.compactions).toHaveLength(1);
  expect(done.compactions?.[0]).toMatchObject({
    origin: "auto",
    model: "gpt-4.1",
    includesPrevious: false,
    summary: expect.stringContaining(SUMMARY),
  });
  // the shown history is complete: every message is still there, the marker stands inside it
  expect(done.messages.filter((m) => m.role === "user").length).toBeGreaterThan(3);
  const marker = done.compactions?.[0];
  expect(marker?.count).toBeGreaterThan(0);
  expect(done.messages.some((m) => m.id === marker?.beforeMessageId)).toBe(true);
  // the request that followed the compaction was made from the summary and what the cut kept
  const after = textOf(chats.at(-1) as TranscriptContext);
  expect(after).toContain(SUMMARY);
  expect(after).not.toContain("TURN-1 ");
  // the same history file carries the entry
  const entry = entriesOf(done).find((item) => item.type === "compaction");
  expect(entry).toMatchObject({
    type: "compaction",
    details: { version: 1, origin: "auto", provider: "openai", model: "gpt-4.1" },
  });
  // the summary was made by the conversation's own model, in the interface language, told to keep references
  const prompt = textOf(summaries[0] as TranscriptContext);
  expect(prompt).toContain("Simplified Chinese");
  expect(prompt).toContain("VERBATIM");
  expect(prompt).toContain("does not replace reading material");
  // the conversation goes on
  const next = await turn(id, "TURN-AFTER", 4);
  expect(next.conversation.run?.status).toBe("completed");
});

test("the summary is written in the interface language", async () => {
  language = "en";
  const id = await create();
  for (let n = 1; n <= 16 && !summaries.length; n++) await turn(id, `TURN-${n}`);
  expect(textOf(summaries[0] as TranscriptContext)).toContain("English, the language of the user");
});

test("a manual compaction summarizes the older part, keeps the recent part, and the model then sees both", async () => {
  const id = await create();
  await turn(id, "FIRST", 40);
  await turn(id, "SECOND", 40);
  const before = await turn(id, "THIRD", 40);
  expect(summaries).toHaveLength(0);
  expect(before.canCompact).toBe(true);
  const response = await request(`/conversations/${id}/compact`, "POST");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { status: string; snapshot: ConversationSnapshot };
  expect(body.status).toBe("compacted");
  expect(summaries).toHaveLength(1);
  expect(body.snapshot.compactions).toHaveLength(1);
  expect(body.snapshot.compactions?.[0]).toMatchObject({
    origin: "manual",
    includesPrevious: false,
  });
  expect(body.snapshot.canCompact).toBe(false);
  expect(body.snapshot.compaction).toBeNull();
  // everything is still shown
  expect(body.snapshot.messages.map((m) => m.role)).toEqual(before.messages.map((m) => m.role));
  await turn(id, "FOURTH", 2);
  const after = textOf(chats.at(-1) as TranscriptContext);
  expect(after).toContain(SUMMARY);
  expect(after).toContain("THIRD ");
  expect(after).toContain("FOURTH ");
  expect(after).not.toContain("FIRST ");
});

test("the object references of the compacted part reach the summary verbatim, even when the model drops them", async () => {
  const id = await create();
  await turn(id, "FIRST", 40);
  await turn(id, "SECOND", 40);
  await turn(id, "THIRD", 40);
  summaryAnswer = () => ({ text: "A summary that names nothing." });
  const body = (await (await request(`/conversations/${id}/compact`, "POST")).json()) as {
    snapshot: ConversationSnapshot;
  };
  // the summary request was given the objects of the pages the messages were sent from
  expect(textOf(summaries[0] as TranscriptContext)).toContain(`[objects: ${PLAN}]`);
  const summary = body.snapshot.compactions?.[0]?.summary ?? "";
  expect(summary).toContain("A summary that names nothing.");
  expect(summary).toContain("## Object references (kept verbatim by the application)");
  expect(summary).toContain(`- ${PLAN}`);
  // a summary that kept them is not given a second list
  const again = await create();
  await turn(again, "A", 40);
  await turn(again, "B", 40);
  await turn(again, "C", 40);
  summaryAnswer = () => ({ text: `kept ${PLAN}` });
  const kept = (await (await request(`/conversations/${again}/compact`, "POST")).json()) as {
    snapshot: ConversationSnapshot;
  };
  expect(kept.snapshot.compactions?.[0]?.summary).toBe(`kept ${PLAN}`);
});

test("a reloaded conversation shows the full history with the marker, and the model sees only the summary and the kept part", async () => {
  const id = await create();
  await turn(id, "FIRST", 40);
  await turn(id, "SECOND", 40);
  await turn(id, "THIRD", 40);
  const compacted = (await (await request(`/conversations/${id}/compact`, "POST")).json()) as {
    snapshot: ConversationSnapshot;
  };
  const bytes = readFileSync(historyFile(compacted.snapshot));
  await host.close();
  build();
  const reloaded = await host.snapshot(id);
  expect(reloaded.messages).toEqual(compacted.snapshot.messages);
  expect(reloaded.compactions).toEqual(compacted.snapshot.compactions);
  expect(readFileSync(historyFile(reloaded))).toEqual(bytes);
  chats.length = 0;
  await turn(id, "FIFTH", 2);
  const sent = textOf(chats[0] as TranscriptContext);
  expect(sent).toContain(SUMMARY);
  expect(sent).toContain("THIRD ");
  expect(sent).toContain("FIFTH ");
  expect(sent).not.toContain("FIRST ");
});

test("a compaction that fails leaves the conversation as it was: manual says so, automatic is the capacity refusal", async () => {
  const id = await create();
  await turn(id, "FIRST", 40);
  await turn(id, "SECOND", 40);
  const third = await turn(id, "THIRD", 40);
  const before = readFileSync(historyFile(third));
  summaryAnswer = () => ({ error: "SYNTHETIC_COPILOT_KEY at https://key:secret@example.invalid" });
  const manual = await request(`/conversations/${id}/compact`, "POST");
  expect(manual.status).toBe(503);
  const manualBody = await manual.json();
  expect(manualBody).toMatchObject({ code: "compaction_failed" });
  expect(JSON.stringify(manualBody)).not.toContain("SYNTHETIC_COPILOT_KEY");
  expect(readFileSync(historyFile(third))).toEqual(before);
  expect((await host.snapshot(id)).compaction).toBeNull();
  // the automatic one: the message that needs room is refused as capacity, marked as the compaction's failure
  let refused: Response | undefined;
  for (let n = 4; n <= 16 && !refused; n++) {
    const bytes = readFileSync(historyFile(third));
    const response = await send(id, filler(`TURN-${n}`, 40_000));
    if (response.status === 202) await settled(id);
    else {
      refused = response;
      expect(readFileSync(historyFile(third)).length).toBeGreaterThanOrEqual(bytes.length);
    }
  }
  expect(refused?.status).toBe(400);
  expect(await refused?.json()).toMatchObject({ code: "capacity", compaction: "failed" });
  const stuck = readFileSync(historyFile(third));
  expect(entriesOf(third).some((item) => item.type === "compaction")).toBe(false);
  // and it is not wedged: once the model can summarize, the same conversation compacts and goes on
  summaryAnswer = () => ({ text: SUMMARY });
  const retried = await send(id, filler("RETRY", 40_000));
  expect(retried.status).toBe(202);
  const done = await settled(id);
  expect(done.conversation.run?.status).toBe("completed");
  expect(done.compactions).toHaveLength(1);
  expect(readFileSync(historyFile(done)).length).toBeGreaterThan(stuck.length);
});

test("an automatic compaction that fails in the middle of a run ends it as capacity with the compaction marked as the reason", async () => {
  const id = await create();
  await turn(id, "FIRST", 40);
  await turn(id, "SECOND", 40);
  await turn(id, "THIRD", 40);
  summaryAnswer = () => ({ error: "boom" });
  let failed: ConversationSnapshot | undefined;
  for (let n = 4; n <= 16 && !failed; n++) {
    const response = await send(id, filler(`TURN-${n}`, 40_000));
    if (response.status !== 202) break;
    const done = await settled(id);
    if (done.conversation.run?.status === "failed") failed = done;
  }
  // (a request refused before it was accepted is the other shape of the same failure; either way nothing is lost)
  const snapshot = failed ?? (await host.snapshot(id));
  expect((await host.snapshot(id)).compactions).toEqual([]);
  expect(summaries.length).toBeGreaterThan(0);
  if (failed)
    expect(failed.conversation.run).toMatchObject({ error: "capacity", compactionFailed: true });
  expect(snapshot.messages.length).toBeGreaterThan(0);
});

test("the ledger comes first: a reading is taken out of the conversation before anything is summarized, and what is summarized never carries it", async () => {
  writeDoc(60);
  const id = await create();
  // a message that carries the whole reading, then plain talk: with the reading out, the window holds
  const first = await turn(id, "READ-1", 2, reader());
  expect(textOf(chats[0] as TranscriptContext)).toContain(READING_MARK);
  await turn(id, "TALK-1", 40);
  await turn(id, "TALK-2", 40);
  expect(summaries).toHaveLength(0);
  let done = first;
  for (let n = 3; n <= 16 && !summaries.length; n++) done = await turn(id, `TALK-${n}`, 40);
  expect(summaries).toHaveLength(1);
  const entries = entriesOf(done);
  const ledger = entries.findIndex((item) => item.customType === DELIVERY_LEDGER_TYPE);
  const compaction = entries.findIndex((item) => item.type === "compaction");
  expect(ledger).toBeGreaterThan(-1);
  expect(compaction).toBeGreaterThan(ledger);
  // the reading material is not in what the summary was made from
  expect(textOf(summaries[0] as TranscriptContext)).not.toContain(READING_MARK);
  expect(textOf(summaries[0] as TranscriptContext)).toContain("READ-1");
});

test("while a context is being compacted nothing is sent; Stop gives the compaction up and the history stays", async () => {
  const id = await create();
  await turn(id, "FIRST", 40);
  await turn(id, "SECOND", 40);
  const third = await turn(id, "THIRD", 40);
  const before = readFileSync(historyFile(third));
  summaryAnswer = () => ({ hang: true });
  const pending = request(`/conversations/${id}/compact`, "POST");
  await vi.waitFor(async () =>
    expect((await host.snapshot(id)).compaction).toMatchObject({ origin: "manual" })
  );
  expect((await host.snapshot(id)).canCompact).toBe(false);
  const refused = await send(id, "while compacting");
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ code: "busy" });
  expect((await request(`/conversations/${id}/compact`, "POST")).status).toBe(409);
  expect((await request(`/conversations/${id}/stop`, "POST")).status).toBe(200);
  const stopped = await pending;
  expect(stopped.status).toBe(200);
  expect(await stopped.json()).toMatchObject({ status: "stopped" });
  expect((await host.snapshot(id)).compaction).toBeNull();
  expect(readFileSync(historyFile(third))).toEqual(before);
  expect((await host.snapshot(id)).compactions).toEqual([]);
  // nothing is left half-done: sending works again
  summaryAnswer = () => ({ text: SUMMARY });
  expect((await send(id, "after the stop")).status).toBe(202);
  await settled(id);
});

test("Stop during an automatic compaction ends the run as stopped, with the history unchanged", async () => {
  const id = await create();
  await turn(id, "FIRST", 40);
  await turn(id, "SECOND", 40);
  const third = await turn(id, "THIRD", 40);
  summaryAnswer = () => ({ hang: true });
  let sent: Promise<Response> | undefined;
  for (let n = 4; n <= 16; n++) {
    sent = send(id, filler(`TURN-${n}`, 40_000));
    let over = false;
    void sent.then(() => {
      over = true;
    });
    while (!over && !(await host.snapshot(id)).compaction)
      await new Promise((r) => setTimeout(r, 10));
    if ((await host.snapshot(id)).compaction) break;
    await settled(id);
  }
  expect((await host.snapshot(id)).compaction).toMatchObject({ origin: "auto" });
  await request(`/conversations/${id}/stop`, "POST");
  await sent;
  const done = await settled(id);
  expect(done.conversation.run?.status).toBe("stopped");
  expect(done.compaction).toBeNull();
  expect(done.compactions).toEqual([]);
  expect(entriesOf(third).some((item) => item.type === "compaction")).toBe(false);
});

test("a conversation that is still short has nothing to compact", async () => {
  const id = await create();
  const done = await turn(id, "SHORT", 1);
  expect(done.canCompact).toBe(false);
  const response = await request(`/conversations/${id}/compact`, "POST");
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "too_short" });
  expect(summaries).toHaveLength(0);
});

test("compacting twice keeps both markers; the second summary folds in the first", async () => {
  const id = await create();
  for (const tag of ["A1", "A2", "A3"]) await turn(id, tag, 40);
  await request(`/conversations/${id}/compact`, "POST");
  for (const tag of ["B1", "B2", "B3"]) await turn(id, tag, 40);
  summaryAnswer = () => ({ text: "SECOND-SUMMARY" });
  const second = await request(`/conversations/${id}/compact`, "POST");
  expect(await second.clone().text()).toContain("compacted");
  const body = (await second.json()) as {
    snapshot: ConversationSnapshot;
  };
  expect(body.snapshot.compactions).toHaveLength(2);
  expect(body.snapshot.compactions?.map((marker) => marker.includesPrevious)).toEqual([
    false,
    true,
  ]);
  // the second request was an update of the first summary
  expect(textOf(summaries[1] as TranscriptContext)).toContain(SUMMARY);
});
