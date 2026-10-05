/**
 * Copilot run lifecycle (ticket 10), end to end on the real seam: real Pi session, real HTTP routes, real
 * native JSONL history, real Plan lock/store/disk and (where noted) a real WS server. Only the model
 * provider is scripted; failures are injected into the real file rename.
 */
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ConversationSnapshot,
  PageContext,
  PlansFile,
  WsServerMessage,
} from "@argelanderspace/contracts";
import { libraryPaths, plansPath } from "@argelanderspace/core";
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import { CopilotHost } from "../src/copilot.js";
import { JobRunner } from "../src/jobs.js";
import { AsyncLock } from "../src/lock.js";
import { ProviderSettings } from "../src/providers.js";
import { stubPipelines, stubSources } from "./helpers.js";

const failure = vi.hoisted(() => ({ target: "", once: false, after: -1 }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      if (to === failure.target) {
        // `once` fails exactly one rename; `after` lets that many succeed first.
        if (failure.once) {
          failure.once = false;
          failure.target = "";
          throw new Error("injected rename failure");
        }
        if (failure.after > 0) failure.after--;
        else throw new Error("injected rename failure");
      }
      return fs.renameSync(from, to);
    },
  };
});

type Out = { text?: string; call?: Record<string, unknown>; hang?: boolean };
type Step = (context: TranscriptContext, signal?: AbortSignal) => Out | Promise<Out>;
let root: string;
let dataDir: string;
let statusDir: string;
let host: CopilotHost;
let hosts: CopilotHost[];
let app: ReturnType<typeof createApp>;
let settings: ProviderSettings;
let originalEnv: NodeJS.ProcessEnv;
let script: Step[];
let seen: TranscriptContext[];
let broadcasts: WsServerMessage[];
let planLock: AsyncLock;
let deliveries: string[];
const choice = { provider: "openai", model: "gpt-4.1", thinking: null };
const A = "p_0000000a";
const B = "p_0000000b";
const task = (n: number, extra: object = {}) => ({
  id: `t_${n.toString(16).padStart(8, "0")}`,
  title: `Task ${n}`,
  status: "todo",
  due: "2026-12-01",
  links: [],
  focused: false,
  created_at: "2026-10-02T00:00:00.000Z",
  ...extra,
});
const seed = () => ({
  version: 1,
  rev: 7,
  plans: [
    {
      id: A,
      name: "Alpha",
      due: "2026-12-31",
      icon: "target",
      created_at: "2026-10-02T00:00:00.000Z",
      tasks: [task(1), task(2)],
    },
    {
      id: B,
      name: "Beta",
      due: "2026-12-31",
      icon: "target",
      created_at: "2026-10-02T00:00:00.000Z",
      tasks: [task(9)],
    },
  ],
});
const diskBytes = () => readFileSync(plansPath(statusDir), "utf8");
const disk = () => JSON.parse(diskBytes());
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
const gate = () => {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait };
};
const hangUntilAborted = (signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) resolve();
    else signal?.addEventListener("abort", () => resolve(), { once: true });
  });

function newHost() {
  const created = new CopilotHost(dataDir, settings, (event) => broadcasts.push(event));
  hosts.push(created);
  created.useViewDelivery((viewId) => {
    deliveries.push(viewId);
    return false;
  });
  const created2 = createApp({
    paths: libraryPaths(dataDir),
    statusDir,
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(root, "jobs") }),
    providerSettings: settings,
    copilot: created,
    broadcast: (message) => broadcasts.push(message),
  });
  // The tool shares this lock, which lets a test hold a submitted write "in flight".
  created.useWorkbench({
    plans: { statusDir, planLock, onChanged: () => {}, docExists: () => true },
    // delivery returns false here: "no browser connected", so the reconnect wait stays short
    viewReconnectWaitMs: 50,
  });
  host = created;
  app = created2;
}

beforeEach(async () => {
  originalEnv = process.env;
  root = mkdtempSync(join(tmpdir(), "copilot-lifecycle-"));
  dataDir = join(root, "data");
  process.env = { PATH: originalEnv.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "config") };
  vi.stubGlobal("fetch", () => {
    throw new Error("unexpected external fetch");
  });
  statusDir = join(root, "status");
  mkdirSync(statusDir, { recursive: true });
  writeFileSync(plansPath(statusDir), JSON.stringify(seed(), null, 2));
  failure.target = "";
  failure.once = false;
  failure.after = -1;
  script = [];
  seen = [];
  broadcasts = [];
  hosts = [];
  deliveries = [];
  planLock = new AsyncLock();
  settings = new ProviderSettings();
  await settings.credential("openai", "SYNTHETIC_COPILOT_KEY");
  (await settings.getRuntime()).registerProvider("openai", {
    api: "openai-responses",
    streamSimple(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
      seen.push(structuredClone(context));
      const index = seen.length;
      const step = script[index - 1];
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const out = step ? await step(context, options?.signal) : { text: "done" };
        const message: AssistantMessage = {
          role: "assistant",
          content: out.call
            ? [
                {
                  type: "toolCall",
                  id: `call_${index}`,
                  name: "plan",
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
        if (out.hang) return;
        stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      })();
      return stream;
    },
  });
  newHost();
});
afterEach(async () => {
  failure.target = "";
  for (const created of hosts) await created.close().catch(() => {});
  process.env = originalEnv;
  vi.unstubAllGlobals();
});

function page(selected = A, revision = 1, viewId: string = randomUUID()): PageContext {
  const file = seed() as unknown as PlansFile;
  const shown = file.plans.find((p) => p.id === selected) ?? file.plans[0];
  return {
    version: 1,
    viewId,
    revision,
    paneId: 1,
    view: "plan",
    status: "complete",
    otherPanes: [],
    plan: {
      rev: 7,
      mode: "list",
      selectedPlanId: selected,
      saveState: "saved",
      groups: [],
      detail: null,
      plans: shown ? [shown] : [],
    },
  };
}
async function create(): Promise<ConversationSnapshot> {
  const response = await request("/conversations", "POST", { model: choice });
  expect(response.status).toBe(201);
  return (await response.json()) as ConversationSnapshot;
}
async function publish(context: PageContext) {
  expect((await request(`/views/${context.viewId}`, "PUT", context)).status).toBe(200);
}
async function post(
  id: string,
  context: PageContext,
  text = "Do the plan work",
  clientMessageId: string = randomUUID()
) {
  await publish(context);
  return request(`/conversations/${id}/messages`, "POST", {
    clientMessageId,
    text,
    viewId: context.viewId,
    contextRevision: context.revision,
  });
}
const status = async (id: string) => (await host.snapshot(id)).conversation.run?.status;
async function until(id: string, wanted: string[], target: CopilotHost = host) {
  await vi.waitFor(
    async () => {
      expect(wanted).toContain((await target.snapshot(id)).conversation.run?.status);
    },
    { timeout: 8000 }
  );
}
const userEnvelopes = (context: TranscriptContext) =>
  context.messages
    .filter((m) => m.role === "user")
    .map((m) => {
      const part = typeof m.content === "string" ? m.content : m.content[0];
      return JSON.parse(
        typeof part === "string" ? part : part && "text" in part ? part.text : "{}"
      );
    });
const historyPath = (snapshot: ConversationSnapshot) =>
  join(dataDir, "copilot/sessions", `${snapshot.conversation.sessionId}.jsonl`);

test("a message sent while the run works steers it with its own context, and the original operations still target A", async () => {
  const { id } = (await create()).conversation;
  const first = gate();
  const viewA = page(A, 1);
  const viewB = page(B, 1);
  script = [
    () => ({ call: { action: "read" } }),
    async () => {
      await first.wait;
      return { call: { action: "show", view: "board", planId: A } };
    },
    () => ({
      call: {
        action: "update_task",
        expectedRev: 7,
        planId: A,
        taskId: "t_00000001",
        status: "done",
      },
    }),
    (ctx) => ({ text: `edited rev ${lastResult(ctx).rev}` }),
  ];
  expect((await post(id, viewA, "Mark task 1 done in Alpha")).status).toBe(202);
  await vi.waitFor(() => expect(seen.length).toBe(2));
  // The user opens B in another tab and adds an instruction while the model is still working.
  const steerId = randomUUID();
  const steered = await post(id, viewB, "Also keep it short", steerId);
  expect(steered.status).toBe(202);
  const ids = (await steered.json()) as { messageId: string; runId: string };
  const queued = await host.snapshot(id);
  expect(queued.conversation.run?.status).toBe("running");
  expect(queued.messages.at(-1)).toMatchObject({
    id: ids.messageId,
    role: "user",
    text: "Also keep it short",
    pending: true,
  });
  // A network retry of the same clientMessageId is the same message, never a second steering.
  const retry = await post(id, viewB, "Also keep it short", steerId);
  expect(await retry.json()).toEqual(ids);
  first.open();
  await until(id, ["completed"]);
  const done = await host.snapshot(id);
  expect(done.messages.filter((m) => m.role === "user").map((m) => m.text)).toEqual([
    "Mark task 1 done in Alpha",
    "Also keep it short",
  ]);
  expect(done.messages.some((m) => m.pending)).toBe(false);
  // Each user message keeps its own context: the second one was written from view B.
  const [one, two] = done.messages.filter((m) => m.role === "user");
  expect(one?.context?.objects.map((o) => o.id)).toEqual([A]);
  expect(two?.context?.objects.map((o) => o.id)).toEqual([B]);
  expect(one?.context?.contextId).not.toBe(two?.context?.contextId);
  const envelopes = seen.flatMap(userEnvelopes).filter((e) => e.text === "Also keep it short");
  expect(envelopes.length).toBeGreaterThan(0);
  expect(new Set(envelopes.map((e) => e.messageId)).size).toBe(1);
  // The write after the steering still went to the plan the operation named (A), not the shown page (B).
  expect(disk().plans[0].tasks[0].status).toBe("done");
  expect(disk().plans[1]).toEqual(seed().plans[1]);
  // Navigation follows the tab the user last spoke from, as soon as the steering is accepted.
  expect(deliveries).toEqual([viewB.viewId]);
  expect(seen).toHaveLength(4);
  expect(done.conversation.run?.status).toBe("completed");
});

test("a steering message moves the run's navigation to the view that sent it", async () => {
  const { id } = (await create()).conversation;
  const first = gate();
  const viewA = page(A, 1);
  const viewB = page(B, 1);
  script = [
    async () => {
      await first.wait;
      return { text: "first turn" };
    },
    () => ({ call: { action: "show", view: "board", planId: A } }),
    () => ({ text: "shown" }),
  ];
  await post(id, viewA);
  await vi.waitFor(() => expect(seen.length).toBe(1));
  await post(id, viewB, "Show the board");
  first.open();
  await until(id, ["completed"]);
  // The scripted view action asked the bound view: it was B's view, not the starting view A.
  expect(deliveries).toEqual([viewB.viewId]);
});

test("steering larger than the model's window is refused up front and the run is untouched", async () => {
  // A synthetic window defined here, so the assertion does not drift as tool schemas grow.
  const catalogModel = (await settings.getRuntime())
    .getModels("openai")
    .find((m) => m.id === "gpt-4.1");
  if (!catalogModel) throw new Error("fixture model");
  // The catalogue entry is shared by every later test of this file: put it back whatever happens.
  const originalWindow = {
    contextWindow: catalogModel.contextWindow,
    maxTokens: catalogModel.maxTokens,
  };
  onTestFinished(() => {
    Object.assign(catalogModel, originalWindow);
  });
  catalogModel.contextWindow = 30_000;
  catalogModel.maxTokens = 1024;
  const small = await request("/conversations", "POST", {
    model: { provider: "openai", model: "gpt-4.1", thinking: null },
  });
  const { id } = ((await small.json()) as ConversationSnapshot).conversation;
  const first = gate();
  script = [
    async () => {
      await first.wait;
      return { text: "ok" };
    },
  ];
  const context = page(A, 1);
  await post(id, context);
  await vi.waitFor(() => expect(seen.length).toBe(1));
  const huge = await post(id, context, "x".repeat(99_000));
  expect(huge.status).toBe(400);
  expect(await status(id)).toBe("running");
  first.open();
  await until(id, ["completed"]);
});

test("Stop closes admission first; a submitted write commits, the terminal state waits for it, and nothing new starts", async () => {
  const { id } = (await create()).conversation;
  const context = page(A, 1);
  const hold = gate();
  const heldLock = planLock.run(() => hold.wait);
  script = [
    () => ({
      call: {
        action: "update_task",
        expectedRev: 7,
        planId: A,
        taskId: "t_00000001",
        status: "done",
        operationId: "stop-test-1",
      },
    }),
    () => ({ call: { action: "read" } }),
    () => ({ text: "should never be asked" }),
  ];
  const before = diskBytes();
  await post(id, context, "Edit then read");
  // The write was submitted (journaled) but is waiting on the plan lock: in flight, not committed.
  await vi.waitFor(() => {
    const files = readdirSync(join(dataDir, "copilot/sessions"));
    expect(readFileSync(join(dataDir, "copilot/sessions", files[0] as string), "utf8")).toContain(
      '"phase":"begin"'
    );
  });
  const stopped = await request(`/conversations/${id}/stop`, "POST");
  expect(stopped.status).toBe(200);
  expect(((await stopped.json()) as ConversationSnapshot).conversation.run?.status).toBe(
    "stopping"
  );
  // Idempotent while stopping.
  expect(
    ((await (await request(`/conversations/${id}/stop`, "POST")).json()) as ConversationSnapshot)
      .conversation.run?.status
  ).toBe("stopping");
  // Not terminal while the submitted write is still in flight; a new message is refused.
  await new Promise((r) => setTimeout(r, 150));
  expect(await status(id)).toBe("stopping");
  expect(diskBytes()).toBe(before);
  expect((await post(id, context, "late", randomUUID())).status).toBe(409);
  hold.open();
  await heldLock;
  await until(id, ["stopped"]);
  // The write that was already submitted finished safely and is reported as a real result.
  expect(disk().plans[0].tasks[0].status).toBe("done");
  expect(disk().rev).toBe(8);
  const final = await host.snapshot(id);
  expect(final.conversation.run).toMatchObject({ status: "stopped", error: null });
  expect(
    final.messages.flatMap((m) => m.operations ?? []).map((o) => `${o.action}:${o.status}`)
  ).toEqual(["update_task:ok"]);
  // No further model step or tool was admitted after Stop.
  expect(seen).toHaveLength(1);
  // Stop on a settled run is a no-op returning the terminal state.
  expect(
    ((await (await request(`/conversations/${id}/stop`, "POST")).json()) as ConversationSnapshot)
      .conversation.run?.status
  ).toBe("stopped");
  expect(broadcasts.filter((m) => m.type === "copilot.event").length).toBeGreaterThan(2);
});

test("Stop aborts a model that is still thinking, even when the provider ignores the abort signal", async () => {
  const { id } = (await create()).conversation;
  script = [() => new Promise<Out>(() => {})];
  await post(id, page(A, 1));
  await vi.waitFor(() => expect(seen.length).toBe(1));
  await request(`/conversations/${id}/stop`, "POST");
  await until(id, ["stopped"]);
  const snapshot = await host.snapshot(id);
  expect(snapshot.conversation.run?.error).toBeNull();
  // The empty aborted tail is not shown as a reply.
  expect(snapshot.messages.map((m) => m.role)).toEqual(["user"]);
  // After Stop the conversation takes a new message normally.
  script[1] = () => ({ text: "fresh run" });
  expect((await post(id, page(A, 1), "again")).status).toBe(202);
  await until(id, ["completed"]);
});

test("a repeated operationId returns the first result without writing again; a different request with it is rejected", async () => {
  const { id } = (await create()).conversation;
  const edit = {
    action: "update_task",
    expectedRev: 7,
    planId: A,
    taskId: "t_00000001",
    status: "done",
    operationId: "idem-1",
  };
  script = [
    () => ({ call: edit }),
    () => ({ call: edit }),
    () => ({ call: { ...edit, status: "blocked" } }),
    () => ({ text: "finished" }),
  ];
  await post(id, page(A, 1));
  await until(id, ["completed"]);
  const operations = (await host.snapshot(id)).messages.flatMap((m) => m.operations ?? []);
  expect(operations.map((o) => o.status)).toEqual(["ok", "ok", "rejected"]);
  expect(disk().rev).toBe(8);
  expect(disk().plans[0].tasks[0].status).toBe("done");
  // The repeat carries the stored result, flagged as a duplicate for the model.
  const second = JSON.parse(
    (
      (seen[2]?.messages.filter((m) => m.role === "toolResult").at(-1)?.content[0] ?? {}) as {
        text: string;
      }
    ).text
  );
  expect(second).toMatchObject({ ok: true, duplicate: true, rev: 8 });
});

test("a write is never run when the conversation cannot be saved; the next model step is refused and bytes are kept", async () => {
  const snapshot = await create();
  const id = snapshot.conversation.id;
  script = [
    () => {
      // The disk breaks after the model asked for a write, before the host can journal it.
      failure.target = historyPath(snapshot);
      return {
        call: {
          action: "update_task",
          expectedRev: 7,
          planId: A,
          taskId: "t_00000001",
          status: "done",
        },
      };
    },
    () => ({ text: "must not be reached" }),
  ];
  const planBefore = diskBytes();
  await post(id, page(A, 1));
  await until(id, ["failed"]);
  expect(diskBytes()).toBe(planBefore);
  expect((await host.snapshot(id)).conversation.run).toMatchObject({
    status: "failed",
    error: "storage",
  });
  expect(seen).toHaveLength(1);
  const history = readFileSync(historyPath(snapshot), "utf8");
  failure.target = "";
  // A fresh process reads the untouched history; the failed write is not in it.
  host.close();
  newHost();
  expect(readFileSync(historyPath(snapshot), "utf8")).toBe(history);
  expect((await host.snapshot(id)).conversation.run?.status).toBe("failed");
});

test("a message the host refuses to admit leaves no failed run and no title", async () => {
  const snapshot = await create();
  const id = snapshot.conversation.id;
  const bytes = readFileSync(historyPath(snapshot));
  const recordBefore = readFileSync(join(dataDir, "copilot/conversations", `${id}.json`), "utf8");
  failure.target = historyPath(snapshot);
  const context = page(A, 1);
  const clientMessageId = randomUUID();
  const refused = await post(id, context, "Will not be admitted", clientMessageId);
  expect(refused.status).toBe(503);
  failure.target = "";
  expect(seen).toHaveLength(0);
  expect(readFileSync(historyPath(snapshot))).toEqual(bytes);
  expect(readFileSync(join(dataDir, "copilot/conversations", `${id}.json`), "utf8")).toBe(
    recordBefore
  );
  const shown = await host.snapshot(id);
  expect(shown.conversation).toMatchObject({ title: "", run: null });
  expect(shown.messages).toEqual([]);
  // The very same retry now goes through.
  const retried = await post(id, context, "Will not be admitted", clientMessageId);
  expect(retried.status).toBe(202);
  await until(id, ["completed"]);
});

test("restart records an unfinished run as interrupted, never replays, and resume rereads while unknown writes are not retried", async () => {
  const snapshot = await create();
  const id = snapshot.conversation.id;
  const hold = gate();
  const heldLock = planLock.run(() => hold.wait);
  const edit = {
    action: "update_task",
    expectedRev: 7,
    planId: A,
    taskId: "t_00000001",
    status: "done",
    operationId: "crashy-1",
  };
  script = [
    () => ({ call: edit }),
    // After the restart (resume): the model repeats the same write blindly, then reads, then finishes.
    () => ({ call: edit }),
    () => ({ call: { action: "read" } }),
    (ctx) => ({ text: `rev ${lastResult(ctx).rev}` }),
  ];
  const planBefore = diskBytes();
  await post(id, page(A, 1), "Edit task 1");
  await vi.waitFor(() =>
    expect(readFileSync(historyPath(snapshot), "utf8")).toContain('"phase":"begin"')
  );
  // "Crash": a new host instance (new instanceId) on the same dataDir; the old one is abandoned mid-write.
  const old = host;
  const cursor = (await old.snapshot(id)).eventCursor;
  newHost();
  const restarted = await host.snapshot(id);
  expect(restarted.eventCursor.instanceId).not.toBe(cursor.instanceId);
  expect(restarted.conversation.run?.status).toBe("interrupted");
  expect(seen).toHaveLength(1);
  expect(diskBytes()).toBe(planBefore);
  // The interrupted write is shown honestly as unknown, not as done and not as failed.
  expect(restarted.messages.flatMap((m) => m.operations ?? []).map((o) => o.status)).toEqual([
    "unknown",
  ]);
  // Nothing happens on its own.
  await new Promise((r) => setTimeout(r, 200));
  expect(seen).toHaveLength(1);
  // Resume only on the user's request: stale view context is refused like a normal send.
  const context = page(A, 1);
  await publish(context);
  const bad = await request(`/conversations/${id}/resume`, "POST", {
    clientMessageId: randomUUID(),
    viewId: context.viewId,
    contextRevision: 99,
  });
  expect(bad.status).toBe(409);
  expect(seen).toHaveLength(1);
  const resumeId = randomUUID();
  const resumed = await request(`/conversations/${id}/resume`, "POST", {
    clientMessageId: resumeId,
    viewId: context.viewId,
    contextRevision: context.revision,
  });
  expect(resumed.status).toBe(202);
  const sameAgain = await request(`/conversations/${id}/resume`, "POST", {
    clientMessageId: resumeId,
    viewId: context.viewId,
    contextRevision: context.revision,
  });
  expect(await sameAgain.json()).toEqual(await resumed.json());
  await until(id, ["completed"]);
  // The resume request told the model which write is unknown, and the model's blind repeat was refused.
  const resumeText = JSON.stringify(seen[1]?.messages);
  expect(resumeText).toContain("started without a recorded result");
  expect(resumeText).toContain("crashy-1");
  expect(resumeText).toContain("interrupted before a result was recorded");
  const final = await host.snapshot(id);
  expect(final.messages.filter((m) => m.kind === "resume")).toHaveLength(1);
  const operations = final.messages
    .flatMap((m) => m.operations ?? [])
    .map((o) => `${o.action}:${o.status}`);
  expect(operations).toEqual(["update_task:unknown", "update_task:unknown", "read:ok"]);
  // No evidence that it was applied, so it was not retried: plans are byte-identical to before.
  expect(diskBytes()).toBe(planBefore);
  hold.open();
  await heldLock;
});

test("resume is only for stopped, failed or interrupted runs", async () => {
  const { id } = (await create()).conversation;
  const context = page(A, 1);
  await publish(context);
  const body = () => ({
    clientMessageId: randomUUID(),
    viewId: context.viewId,
    contextRevision: context.revision,
  });
  // A fresh conversation has no run to resume.
  expect((await request(`/conversations/${id}/resume`, "POST", body())).status).toBe(409);
  await post(id, context);
  await until(id, ["completed"]);
  expect((await request(`/conversations/${id}/resume`, "POST", body())).status).toBe(409);
  expect((await request(`/conversations/${id}/stop`, "POST")).status).toBe(200);
  expect(await status(id)).toBe("completed");
});

test("conversations never share run state: one is stopped, one steered, one finishes on its own", async () => {
  const one = (await create()).conversation.id;
  const two = (await create()).conversation.id;
  const g1 = gate();
  const g2 = gate();
  // The provider is shared; route by the first user text.
  const byText: Record<string, Step> = {
    "work one": async (_c, signal) => {
      await hangUntilAborted(signal);
      return { hang: true };
    },
    "work two": async () => {
      await g2.wait;
      return { text: "two done" };
    },
  };
  script = Array.from({ length: 12 }, () => (ctx: TranscriptContext, signal?: AbortSignal) => {
    const texts = userEnvelopes(ctx).map((e) => e.text);
    const step = byText[texts[0]];
    return step ? step(ctx, signal) : { text: `${texts.at(-1)} handled` };
  });
  const view1 = page(A, 1);
  const view2 = page(B, 1);
  await post(one, view1, "work one");
  await post(two, view2, "work two");
  await vi.waitFor(() => expect(seen.length).toBe(2));
  expect(await status(one)).toBe("running");
  expect(await status(two)).toBe("running");
  await request(`/conversations/${one}/stop`, "POST");
  await until(one, ["stopped"]);
  // Stopping one did not touch the other; steering reaches only its own conversation.
  expect(await status(two)).toBe("running");
  expect((await post(two, view2, "extra for two")).status).toBe(202);
  g2.open();
  await until(two, ["completed"]);
  const first = await host.snapshot(one);
  const second = await host.snapshot(two);
  expect(first.messages.map((m) => m.text)).toEqual(["work one"]);
  expect(second.messages.filter((m) => m.role === "user").map((m) => m.text)).toEqual([
    "work two",
    "extra for two",
  ]);
  g1.open();
});

test("one unreadable record is reported by itself and does not hide the others", async () => {
  const good = (await create()).conversation.id;
  const dir = join(dataDir, "copilot/conversations");
  writeFileSync(join(dir, `${randomUUID()}.json`), "{ not json");
  writeFileSync(join(dir, "stray-notes.json"), "{}");
  const listed = await request("/conversations");
  expect(listed.status).toBe(200);
  const body = (await listed.json()) as {
    conversations: { id: string }[];
    unreadable: { id: string; code: string }[];
  };
  expect(body.conversations.map((c) => c.id)).toEqual([good]);
  expect(body.unreadable).toHaveLength(2);
  expect(body.unreadable.every((entry) => entry.code === "storage")).toBe(true);
  expect(body.unreadable.map((entry) => entry.id)).toContain("stray-notes");
  // The bad record keeps its original bytes.
  expect(readFileSync(join(dir, "stray-notes.json"), "utf8")).toBe("{}");
});

test("a journal entry that contradicts its own record makes the history unreadable instead of replayable", async () => {
  const snapshot = await create();
  const id = snapshot.conversation.id;
  await post(id, page(A, 1));
  await until(id, ["completed"]);
  await host.close();
  const path = historyPath(snapshot);
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  const last = JSON.parse(lines.at(-1) as string);
  appendFileSync(
    path,
    `${JSON.stringify({
      type: "custom",
      id: "deadbeef",
      parentId: last.id,
      timestamp: new Date().toISOString(),
      customType: "argelander.operation.v1",
      data: {
        version: 1,
        phase: "done",
        operationId: "x",
        toolCallId: "c",
        runId: randomUUID(),
        action: "read",
        hash: "h",
      },
    })}\n`
  );
  const bytes = readFileSync(path);
  newHost();
  expect((await request(`/conversations/${id}`)).status).toBe(503);
  expect(readFileSync(path)).toEqual(bytes);
});

test("real WS: a dropped page, a repeated send and a Stop all agree with the saved record", async () => {
  const { createServer } = await import("../src/server.js");
  const { WebSocket } = await import("ws");
  const server = createServer({
    dataDir,
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    providerSettings: settings,
    deps: { makeSources: () => stubSources() },
  });
  const port = await server.ready();
  app = server.app;
  const httpStatus = async (id: string) =>
    ((await (await request(`/conversations/${id}`)).json()) as ConversationSnapshot).conversation
      .run?.status;
  const open = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      origin: `http://127.0.0.1:${port}`,
    });
    const events: Record<string, unknown>[] = [];
    socket.on("message", (data) => events.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return { socket, events };
  };
  try {
    const snapshot = await create();
    const id = snapshot.conversation.id;
    const context = page(A, 1);
    script = [() => new Promise<Out>(() => {})];
    const first = await open();
    first.socket.send(
      JSON.stringify({ type: "copilot.subscribe", conversationId: id, viewId: context.viewId })
    );
    await vi.waitFor(() =>
      expect(first.events.some((e) => e.type === "copilot.subscribed")).toBe(true)
    );
    const clientMessageId = randomUUID();
    const accepted = await post(id, context, "Think for a long time", clientMessageId);
    expect(accepted.status).toBe(202);
    const ids = await accepted.json();
    // The page is closed mid-run: the run does not belong to it.
    first.socket.terminate();
    await new Promise((r) => setTimeout(r, 100));
    expect(await httpStatus(id)).toBe("running");
    // The reopened page retries the same send: same ids, still one run, no second model request.
    const second = await open();
    second.socket.send(
      JSON.stringify({ type: "copilot.subscribe", conversationId: id, viewId: context.viewId })
    );
    await vi.waitFor(() =>
      expect(second.events.some((e) => e.type === "copilot.subscribed")).toBe(true)
    );
    const retry = await post(id, context, "Think for a long time", clientMessageId);
    expect(await retry.json()).toEqual(ids);
    expect(seen).toHaveLength(1);
    const before = ((await (await request(`/conversations/${id}`)).json()) as ConversationSnapshot)
      .eventCursor;
    const stop = await request(`/conversations/${id}/stop`, "POST");
    expect(stop.status).toBe(200);
    await vi.waitFor(async () => expect(await httpStatus(id)).toBe("stopped"), { timeout: 8000 });
    // The reconnected socket saw ordered change events of this instance; the snapshot agrees with the disk.
    await vi.waitFor(() => {
      const changes = second.events.filter((e) => e.type === "copilot.event");
      expect(changes.length).toBeGreaterThan(0);
    });
    const cursors = second.events
      .filter((e) => e.type === "copilot.event")
      .map((e) => e.eventCursor as { instanceId: string; seq: number });
    expect(cursors.every((c) => c.instanceId === before.instanceId)).toBe(true);
    expect(cursors.map((c) => c.seq)).toEqual([...cursors.map((c) => c.seq)].sort((a, b) => a - b));
    const record = JSON.parse(
      readFileSync(join(dataDir, "copilot/conversations", `${id}.json`), "utf8")
    );
    expect(record.run.status).toBe("stopped");
    second.socket.terminate();
  } finally {
    await server.close();
  }
});

const queuedLines = (snapshot: ConversationSnapshot) =>
  readFileSync(historyPath(snapshot), "utf8")
    .trimEnd()
    .split("\n")
    .filter((line) => line.includes("argelander.steer.v1"));

test("accepted steering is saved before the 202: a rebuilt host still shows it, and a resume hands it to the model", async () => {
  const snapshot = await create();
  const id = snapshot.conversation.id;
  const first = gate();
  script = [
    async () => {
      await first.wait;
      return { text: "first turn" };
    },
    () => ({ text: "resumed and read the steering" }),
  ];
  const view = page(A, 1);
  await post(id, view, "Long task");
  await vi.waitFor(() => expect(seen.length).toBe(1));
  const steered = await post(id, view, "Remember the Beta deadline");
  expect(steered.status).toBe(202);
  expect(queuedLines(snapshot)).toHaveLength(1);
  // The service dies here. A new host (new instanceId) reads the same files.
  newHost();
  const after = await host.snapshot(id);
  expect(after.conversation.run?.status).toBe("interrupted");
  expect(after.messages.at(-1)).toMatchObject({
    role: "user",
    text: "Remember the Beta deadline",
    pending: true,
  });
  expect(after.messages.filter((m) => m.text === "Remember the Beta deadline")).toHaveLength(1);
  // The same clientMessageId retried after the restart is the same accepted message.
  const retry = await request(`/conversations/${id}/messages`, "POST", {
    clientMessageId: (
      (await (await request(`/conversations/${id}`)).json()) as ConversationSnapshot
    ).messages.at(-1)?.id,
  });
  expect(retry.status).toBe(400);
  const context = page(A, 1);
  await publish(context);
  const resumed = await request(`/conversations/${id}/resume`, "POST", {
    clientMessageId: randomUUID(),
    viewId: context.viewId,
    contextRevision: context.revision,
  });
  expect(resumed.status).toBe(202);
  await until(id, ["completed"]);
  const sent = JSON.stringify(seen.at(-1)?.messages);
  expect(sent).toContain("Remember the Beta deadline");
  const done = await host.snapshot(id);
  expect(done.messages.some((m) => m.pending)).toBe(false);
  expect(done.messages.filter((m) => m.text === "Remember the Beta deadline")).toHaveLength(1);
  first.open();
});

test("a failure after the steering was accepted does not lose it", async () => {
  const snapshot = await create();
  const id = snapshot.conversation.id;
  const first = gate();
  script = [
    async () => {
      await first.wait;
      return { call: { action: "read" } };
    },
    () => ({ text: "never asked" }),
  ];
  const view = page(A, 1);
  await post(id, view, "Task");
  await vi.waitFor(() => expect(seen.length).toBe(1));
  expect((await post(id, view, "Keep this instruction")).status).toBe(202);
  // The next model request cannot be saved, so the run fails and the host reloads from disk.
  failure.target = historyPath(snapshot);
  first.open();
  await until(id, ["failed"]);
  failure.target = "";
  const after = await host.snapshot(id);
  expect(after.conversation.run).toMatchObject({ status: "failed", error: "storage" });
  expect(after.messages.filter((m) => m.text === "Keep this instruction")).toHaveLength(1);
  expect(after.messages.find((m) => m.text === "Keep this instruction")?.pending).toBe(true);
});

test("if the steering cannot be saved the HTTP request fails and nothing is accepted", async () => {
  const snapshot = await create();
  const id = snapshot.conversation.id;
  const first = gate();
  script = [
    async () => {
      await first.wait;
      return { text: "ok" };
    },
  ];
  const view = page(A, 1);
  await post(id, view, "Task");
  await vi.waitFor(() => expect(seen.length).toBe(1));
  const bytes = readFileSync(historyPath(snapshot));
  failure.target = historyPath(snapshot);
  const clientMessageId = randomUUID();
  expect((await post(id, view, "Not saved", clientMessageId)).status).toBe(503);
  failure.target = "";
  expect(readFileSync(historyPath(snapshot)).length).toBeGreaterThanOrEqual(bytes.length - 1);
  expect(queuedLines(snapshot)).toHaveLength(0);
  expect((await host.snapshot(id)).messages.some((m) => m.text === "Not saved")).toBe(false);
  // Retrying the same message after the disk recovers is accepted normally.
  expect((await post(id, view, "Not saved", clientMessageId)).status).toBe(202);
  first.open();
  await until(id, ["completed"]);
  expect((await host.snapshot(id)).messages.filter((m) => m.text === "Not saved")).toHaveLength(1);
});

test("steering accepted before Stop stays visible as queued, the run is stopped, and the next request delivers it", async () => {
  const { id } = (await create()).conversation;
  script = [() => new Promise<Out>(() => {}), () => ({ text: "now reading it" })];
  const view = page(A, 1);
  await post(id, view, "Task");
  await vi.waitFor(() => expect(seen.length).toBe(1));
  expect((await post(id, view, "Also this")).status).toBe(202);
  await request(`/conversations/${id}/stop`, "POST");
  await until(id, ["stopped"]);
  const stopped = await host.snapshot(id);
  expect(stopped.messages.filter((m) => m.text === "Also this")).toEqual([
    expect.objectContaining({ pending: true }),
  ]);
  expect((await post(id, view, "Go on")).status).toBe(202);
  await until(id, ["completed"]);
  expect(JSON.stringify(seen.at(-1)?.messages)).toContain("Also this");
  const done = await host.snapshot(id);
  expect(
    done.messages.map((m) => m.text).filter((t) => t === "Also this" || t === "Go on")
  ).toEqual(["Also this", "Go on"]);
  expect(done.messages.some((m) => m.pending)).toBe(false);
});

test("a result journaled but not yet saved as a tool result is shown as done after a reload", async () => {
  const snapshot = await create();
  const id = snapshot.conversation.id;
  script = [
    () => {
      // begin and done reach disk; the request after the tool result cannot be saved.
      failure.target = historyPath(snapshot);
      failure.after = 2;
      return {
        call: {
          action: "update_task",
          expectedRev: 7,
          planId: A,
          taskId: "t_00000001",
          status: "done",
        },
      };
    },
  ];
  await post(id, page(A, 1));
  await until(id, ["failed"]);
  failure.target = "";
  failure.after = -1;
  const text = readFileSync(historyPath(snapshot), "utf8");
  expect(text).toContain('"phase":"done"');
  expect(text).not.toContain('"role":"toolResult"');
  newHost();
  const reloaded = await host.snapshot(id);
  expect(
    reloaded.messages.flatMap((m) => m.operations ?? []).map((o) => `${o.action}:${o.status}`)
  ).toEqual(["update_task:ok"]);
  expect(disk().plans[0].tasks[0].status).toBe("done");
});

test("a refused journal begin leaves no begin behind, so the same operationId can run once the disk recovers", async () => {
  const snapshot = await create();
  const id = snapshot.conversation.id;
  const edit = {
    action: "update_task",
    expectedRev: 7,
    planId: A,
    taskId: "t_00000001",
    status: "done",
    operationId: "retry-after-refusal",
  };
  script = [
    () => {
      failure.target = historyPath(snapshot);
      failure.once = true;
      return { call: edit };
    },
    () => ({ call: edit }),
    () => ({ text: "finished" }),
  ];
  await post(id, page(A, 1));
  await until(id, ["completed"]);
  const operations = (await host.snapshot(id)).messages.flatMap((m) => m.operations ?? []);
  expect(operations.map((o) => o.status)).toEqual(["error", "ok"]);
  expect(disk().plans[0].tasks[0].status).toBe("done");
});

test("a conflict tells the model to use a new operationId, and the tool says so up front", async () => {
  const { id } = (await create()).conversation;
  script = [
    () => ({
      call: {
        action: "update_task",
        expectedRev: 1,
        planId: A,
        taskId: "t_00000001",
        status: "done",
        operationId: "first-try",
      },
    }),
    () => ({ text: "ok" }),
  ];
  await post(id, page(A, 1));
  await until(id, ["completed"]);
  expect(JSON.stringify(seen[1]?.messages)).toContain("new operationId");
  expect(JSON.stringify(seen[0]?.messages)).toContain("use a new operationId");
});

test("an operation journal that contradicts itself makes the history unreadable and keeps its bytes", async () => {
  for (const mutate of ["duplicate-begin", "hash-mismatch"] as const) {
    const snapshot = await create();
    const id = snapshot.conversation.id;
    script = [
      () => ({
        call: {
          action: "update_task",
          expectedRev: disk().rev,
          planId: A,
          taskId: "t_00000002",
          status: "doing",
          note: mutate,
        },
      }),
      () => ({ text: "done" }),
    ];
    seen = [];
    await post(id, page(A, 1));
    await until(id, ["completed"]);
    await host.close();
    const path = historyPath(snapshot);
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    const begin = lines
      .map((l) => JSON.parse(l))
      .find((e) => e.customType === "argelander.operation.v1" && e.data.phase === "begin");
    const last = JSON.parse(lines.at(-1) as string);
    const extra =
      mutate === "duplicate-begin"
        ? { ...begin, id: "dup00001", parentId: last.id }
        : {
            ...lines.map((l) => JSON.parse(l)).find((e) => e.data?.phase === "done"),
            id: "dup00002",
            parentId: last.id,
          };
    if (mutate === "hash-mismatch") extra.data = { ...extra.data, hash: "tampered" };
    // The duplicate/tampered record must not pair with the legitimate one.
    if (mutate === "hash-mismatch") extra.data.operationId = begin.data.operationId;
    appendFileSync(path, `${JSON.stringify(extra)}\n`);
    const bytes = readFileSync(path);
    newHost();
    expect((await request(`/conversations/${id}`)).status).toBe(503);
    expect(readFileSync(path)).toEqual(bytes);
  }
});

test("after a restart a plain message (not Resume) also shows the interrupted call as unknown, not as an SDK error", async () => {
  const snapshot = await create();
  const id = snapshot.conversation.id;
  const hold = gate();
  const heldLock = planLock.run(() => hold.wait);
  script = [
    () => ({
      call: {
        action: "update_task",
        expectedRev: 7,
        planId: A,
        taskId: "t_00000001",
        status: "done",
        operationId: "plain-after-crash",
      },
    }),
    () => ({ text: "carrying on" }),
  ];
  await post(id, page(A, 1), "Edit");
  await vi.waitFor(() =>
    expect(readFileSync(historyPath(snapshot), "utf8")).toContain('"phase":"begin"')
  );
  newHost();
  expect((await host.snapshot(id)).conversation.run?.status).toBe("interrupted");
  expect((await post(id, page(A, 1), "Just continue")).status).toBe(202);
  await until(id, ["completed"]);
  expect(JSON.stringify(seen.at(-1)?.messages)).toContain(
    "interrupted before a result was recorded"
  );
  const operations = (await host.snapshot(id)).messages.flatMap((m) => m.operations ?? []);
  expect(operations.map((o) => o.status)).toEqual(["unknown"]);
  hold.open();
  await heldLock;
});

test("Stop that lands right after the message was saved admits it (202) and ends stopped, never half-refused", async () => {
  const { id } = (await create()).conversation;
  script = [() => ({ text: "never reached" })];
  const original = (
    host as unknown as { save: (record: { run?: { status: string } | null }) => void }
  ).save.bind(host);
  let triggered = false;
  (host as unknown as { save: typeof original }).save = (record) => {
    original(record);
    if (!triggered && record.run?.status === "running") {
      triggered = true;
      void host.stop(id);
    }
  };
  const response = await post(id, page(A, 1), "Stop me immediately");
  expect(response.status).toBe(202);
  await until(id, ["stopped"]);
  const snapshot = await host.snapshot(id);
  expect(snapshot.messages.map((m) => m.text)).toEqual(["Stop me immediately"]);
  expect(seen).toHaveLength(0);
});
