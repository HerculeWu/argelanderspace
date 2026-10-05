/**
 * Ticket 32, lane B: concurrency, failure and restart seams on the Plan surface (the smallest real business
 * store). Real Pi session, real HTTP routes, real native JSONL history, real Plan lock/store/disk and a real
 * WS server; only the model provider is scripted. Cases are recorded in
 * `.scratch/copilot/evidence/32/seams/README.md` as case -> seam -> test -> result -> bytes compared.
 */
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
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
import { afterEach, beforeEach, expect, test, vi } from "vitest";
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
const historyPath = (snapshot: ConversationSnapshot) =>
  join(dataDir, "copilot/sessions", `${snapshot.conversation.sessionId}.jsonl`);

const recordPath = (id: string) => join(dataDir, "copilot/conversations", `${id}.json`);
const putPlans = (file: unknown) =>
  app.request("/api/plans", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(file),
  });
const userRetitle = () => {
  const edited = structuredClone(disk()) as PlansFile;
  const target = edited.plans[0]?.tasks[1];
  if (target) target.title = "User retitled";
  return edited;
};
const agentBlocksTask1 = {
  action: "update_task",
  expectedRev: 7,
  planId: A,
  taskId: "t_00000001",
  status: "blocked",
};
const operationsOf = async (id: string) =>
  (await host.snapshot(id)).messages.flatMap((m) => m.operations ?? []);

// ---- (a) a user save and the agent's write on the same Plan revision, truly concurrent --------------------- //
test("(a) user PUT and agent write issued together on rev 7: the user's lands first, the agent gets a conflict, nothing is overwritten", async () => {
  const { id } = (await create()).conversation;
  let userPut: Promise<Response> | Response | undefined;
  script = [
    () => {
      // The user's save is on the wire in the same turn of the event loop as the agent's tool call.
      userPut = putPlans(userRetitle());
      return { call: agentBlocksTask1 };
    },
    (ctx) => ({ text: `agent saw ${lastResult(ctx).status}` }),
  ];
  await post(id, page(A, 1), "Block task 1");
  await until(id, ["completed"]);
  expect((await userPut)?.status).toBe(200);
  const final = disk() as PlansFile;
  expect(final.rev).toBe(8);
  expect(final.plans[0]?.tasks[1]?.title).toBe("User retitled");
  expect(final.plans[0]?.tasks[0]?.status).toBe("todo");
  expect((await operationsOf(id)).map((o) => `${o.action}:${o.status}`)).toEqual([
    "update_task:conflict",
  ]);
  expect(JSON.stringify(seen[1]?.messages)).toContain("conflict");
});

test("(a) the agent's write holds the lock first: the user's PUT queued behind it is refused 409, and the agent's edit is the only change", async () => {
  const snapshot = await create();
  const id = snapshot.conversation.id;
  const hold = gate();
  const heldLock = planLock.run(() => hold.wait);
  script = [() => ({ call: agentBlocksTask1 }), (ctx) => ({ text: `${lastResult(ctx).status}` })];
  const edited = userRetitle();
  await post(id, page(A, 1), "Block task 1");
  await vi.waitFor(() =>
    expect(readFileSync(historyPath(snapshot), "utf8")).toContain('"phase":"begin"')
  );
  const queuedUser = putPlans(edited);
  hold.open();
  await heldLock;
  await until(id, ["completed"]);
  expect((await queuedUser).status).toBe(409);
  const final = disk() as PlansFile;
  expect(final.rev).toBe(8);
  expect(final.plans[0]?.tasks[0]?.status).toBe("blocked");
  expect(final.plans[0]?.tasks[1]?.title).toBe("Task 2");
  expect((await operationsOf(id)).map((o) => o.status)).toEqual(["ok"]);
});

// ---- (d) F5 / closed page with a write in flight ----------------------------------------------------------- //
test("(d) a page reloaded while the agent's write is in flight sees the run still going; its retried send is the same message; the write lands exactly once", async () => {
  const snapshot = await create();
  const id = snapshot.conversation.id;
  const hold = gate();
  const heldLock = planLock.run(() => hold.wait);
  script = [() => ({ call: agentBlocksTask1 }), (ctx) => ({ text: `${lastResult(ctx).status}` })];
  const before = diskBytes();
  const tabBefore = page(A, 1);
  const clientMessageId = randomUUID();
  const accepted = await post(id, tabBefore, "Block task 1", clientMessageId);
  const ids = await accepted.json();
  await vi.waitFor(() =>
    expect(readFileSync(historyPath(snapshot), "utf8")).toContain('"phase":"begin"')
  );
  // F5: the old page is gone, a new page (new view id, revision 1 again) loads the conversation afresh.
  const reloaded = page(A, 1);
  expect(reloaded.viewId).not.toBe(tabBefore.viewId);
  const shown = (await (await request(`/conversations/${id}`)).json()) as ConversationSnapshot;
  expect(shown.conversation.run?.status).toBe("running");
  expect(shown.messages.filter((m) => m.role === "user")).toHaveLength(1);
  expect(shown.messages.flatMap((m) => m.operations ?? []).map((o) => o.status)).not.toContain(
    "ok"
  );
  expect(diskBytes()).toBe(before);
  // The page's own retry of the send (it never saw the 202) is the same message, not a second run.
  const retry = await post(id, reloaded, "Block task 1", clientMessageId);
  expect(await retry.json()).toEqual(ids);
  expect(seen).toHaveLength(1);
  hold.open();
  await heldLock;
  await until(id, ["completed"]);
  expect((disk() as PlansFile).rev).toBe(8);
  expect((await operationsOf(id)).map((o) => `${o.action}:${o.status}`)).toEqual([
    "update_task:ok",
  ]);
  const final = (await (await request(`/conversations/${id}`)).json()) as ConversationSnapshot;
  expect(final.messages.filter((m) => m.role === "user")).toHaveLength(1);
});

// ---- (c) two browser tabs on the same conversation ---------------------------------------------------------- //
test("(c) two tabs on one conversation over a real WS: the same send from both is one run; both tabs see the same ordered events and end state", async () => {
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
  const open = async (viewId: string, conversationId: string) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      origin: `http://127.0.0.1:${port}`,
    });
    const events: Record<string, unknown>[] = [];
    socket.on("message", (data) => events.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ type: "copilot.subscribe", conversationId, viewId }));
    await vi.waitFor(() => expect(events.some((e) => e.type === "copilot.subscribed")).toBe(true));
    return { socket, events };
  };
  try {
    const { id } = (await create()).conversation;
    const one = page(A, 1);
    const two = page(A, 1);
    const tabOne = await open(one.viewId, id);
    const tabTwo = await open(two.viewId, id);
    await publish(one);
    await publish(two);
    const clientMessageId = randomUUID();
    const send = (context: PageContext) =>
      request(`/conversations/${id}/messages`, "POST", {
        clientMessageId,
        text: "Say hello once",
        viewId: context.viewId,
        contextRevision: context.revision,
      });
    script = [() => ({ text: "hello once" })];
    const [a, b] = await Promise.all([send(one), send(two)]);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(await a.json()).toEqual(await b.json());
    await vi.waitFor(
      async () => {
        const state = (await (
          await request(`/conversations/${id}`)
        ).json()) as ConversationSnapshot;
        expect(state.conversation.run?.status).toBe("completed");
      },
      { timeout: 8000 }
    );
    expect(seen).toHaveLength(1);
    const state = (await (await request(`/conversations/${id}`)).json()) as ConversationSnapshot;
    expect(state.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(state.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    const cursors = (events: Record<string, unknown>[]) =>
      events
        .filter((e) => e.type === "copilot.event" && e.conversationId === id)
        .map((e) => (e.eventCursor as { seq: number }).seq);
    await vi.waitFor(() => expect(cursors(tabTwo.events).length).toBeGreaterThan(0));
    const seqOne = cursors(tabOne.events);
    const seqTwo = cursors(tabTwo.events);
    expect(seqOne).toEqual([...seqOne].sort((x, y) => x - y));
    expect(seqTwo).toEqual(seqOne);
    // The record on disk agrees with what both tabs were told.
    expect(JSON.parse(readFileSync(recordPath(id), "utf8")).run.status).toBe("completed");
    tabOne.socket.terminate();
    tabTwo.socket.terminate();
  } finally {
    await server.close();
  }
});

// ---- (e) Stop with a write in flight, then a restart, then Resume ------------------------------------------- //
test("(e) Stop while a write is in flight: the write commits and shows ok; a restart reads the saved record without rewriting a byte and Resume continues from the real state", async () => {
  const snapshot = await create();
  const id = snapshot.conversation.id;
  const hold = gate();
  const heldLock = planLock.run(() => hold.wait);
  script = [
    () => ({ call: agentBlocksTask1 }),
    () => ({ text: "never reached: stopped first" }),
    // after Resume
    () => ({ call: { action: "read" } }),
    (ctx) => ({ text: `rev ${lastResult(ctx).rev}` }),
  ];
  await post(id, page(A, 1), "Block task 1");
  await vi.waitFor(() =>
    expect(readFileSync(historyPath(snapshot), "utf8")).toContain('"phase":"begin"')
  );
  const stopped = await request(`/conversations/${id}/stop`, "POST");
  expect(stopped.status).toBe(200);
  hold.open();
  await heldLock;
  await until(id, ["stopped"]);
  expect((disk() as PlansFile).rev).toBe(8);
  expect((await operationsOf(id)).map((o) => `${o.action}:${o.status}`)).toEqual([
    "update_task:ok",
  ]);
  expect(seen).toHaveLength(1);
  const historyBefore = readFileSync(historyPath(snapshot));
  const recordBefore = readFileSync(recordPath(id));
  const planBefore = diskBytes();
  await host.close();
  newHost();
  const restarted = await host.snapshot(id);
  // A terminal state stays what it was; a restart does not reinterpret it as interrupted.
  expect(restarted.conversation.run?.status).toBe("stopped");
  expect(restarted.messages.flatMap((m) => m.operations ?? []).map((o) => o.status)).toEqual([
    "ok",
  ]);
  expect(readFileSync(historyPath(snapshot))).toEqual(historyBefore);
  expect(readFileSync(recordPath(id))).toEqual(recordBefore);
  expect(diskBytes()).toBe(planBefore);
  expect(seen).toHaveLength(1);
  const context = page(A, 1);
  await publish(context);
  const resumed = await request(`/conversations/${id}/resume`, "POST", {
    clientMessageId: randomUUID(),
    viewId: context.viewId,
    contextRevision: context.revision,
  });
  expect(resumed.status).toBe(202);
  await until(id, ["completed"]);
  // The resumed model reread the real state (rev 8, the write applied once) and nothing was replayed.
  expect(JSON.stringify(seen.at(-1)?.messages)).toContain('"rev":8');
  expect((disk() as PlansFile).rev).toBe(8);
  expect(diskBytes()).toBe(planBefore);
});

test("(e) a restart while Stop is still waiting for a write: the run is interrupted, the write is unknown (never ok, never retried), and the plan bytes are exactly as the disk had them", async () => {
  const snapshot = await create();
  const id = snapshot.conversation.id;
  const hold = gate();
  const heldLock = planLock.run(() => hold.wait);
  script = [() => ({ call: agentBlocksTask1 }), () => ({ call: agentBlocksTask1 })];
  const planBefore = diskBytes();
  await post(id, page(A, 1), "Block task 1");
  await vi.waitFor(() =>
    expect(readFileSync(historyPath(snapshot), "utf8")).toContain('"phase":"begin"')
  );
  expect((await request(`/conversations/${id}/stop`, "POST")).status).toBe(200);
  expect(await status(id)).toBe("stopping");
  newHost();
  const restarted = await host.snapshot(id);
  expect(restarted.conversation.run?.status).toBe("interrupted");
  expect(restarted.messages.flatMap((m) => m.operations ?? []).map((o) => o.status)).toEqual([
    "unknown",
  ]);
  expect(diskBytes()).toBe(planBefore);
  await new Promise((r) => setTimeout(r, 150));
  expect(seen).toHaveLength(1);
  hold.open();
  await heldLock;
});

// ---- (g) damaged files and directories ---------------------------------------------------------------------- //
/** Every byte under a path (a file's bytes, or a directory's sorted names with their bytes), for exact comparison. */
function treeBytes(path: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return `link:${readlinkSync(path)}`;
  if (stat.isDirectory())
    return readdirSync(path)
      .sort()
      .map((name) => `${name}=${treeBytes(join(path, name))}`)
      .join("|");
  return readFileSync(path).toString("base64");
}
const storeBytes = () => treeBytes(join(dataDir, "copilot"));
async function everyEntrance(id: string) {
  const context = page(A, 1);
  await publish(context);
  const body = () => ({
    clientMessageId: randomUUID(),
    viewId: context.viewId,
    contextRevision: context.revision,
  });
  return {
    snapshot: (await request(`/conversations/${id}`)).status,
    send: (await request(`/conversations/${id}/messages`, "POST", { ...body(), text: "hi" }))
      .status,
    resume: (await request(`/conversations/${id}/resume`, "POST", body())).status,
    model: (await request(`/conversations/${id}/model`, "PUT", choice)).status,
  };
}
const isError = (status: number) => status >= 400 && status < 600;

test.each([
  "empty",
  "directory",
  "other-conversations-header",
  "invalid-utf8",
  "symlink",
  "no-final-newline-cut-mid-line",
])(
  "(g) a damaged session JSONL (%s) is an honest error on every entrance and no byte of the store moves",
  async (kind) => {
    const first = await create();
    const other = await create();
    const id = first.conversation.id;
    await host.close();
    const path = historyPath(first);
    const original = readFileSync(path);
    const elsewhere = join(root, "elsewhere.jsonl");
    if (kind === "empty") writeFileSync(path, "");
    if (kind === "invalid-utf8")
      writeFileSync(
        path,
        Buffer.concat([original.subarray(0, 20), Buffer.from([0xff, 0xfe, 0xfd])])
      );
    if (kind === "no-final-newline-cut-mid-line")
      writeFileSync(path, original.subarray(0, Math.floor(original.length / 2)));
    if (kind === "other-conversations-header") copyFileSync(historyPath(other), path);
    if (kind === "directory") {
      rmSync(path);
      mkdirSync(path);
      writeFileSync(join(path, "inner.txt"), "keep");
    }
    if (kind === "symlink") {
      writeFileSync(elsewhere, original);
      rmSync(path);
      symlinkSync(elsewhere, path);
    }
    const damaged = storeBytes();
    const elsewhereBefore = kind === "symlink" ? readFileSync(elsewhere) : null;
    newHost();
    const outcome = await everyEntrance(id);
    expect(isError(outcome.snapshot), JSON.stringify(outcome)).toBe(true);
    expect(isError(outcome.send), JSON.stringify(outcome)).toBe(true);
    expect(isError(outcome.resume), JSON.stringify(outcome)).toBe(true);
    expect(isError(outcome.model), JSON.stringify(outcome)).toBe(true);
    expect(seen).toHaveLength(0);
    // Not a byte of the store was rewritten, recreated or "healed", and the other conversation still works.
    expect(storeBytes()).toBe(damaged);
    if (elsewhereBefore) expect(readFileSync(elsewhere)).toEqual(elsewhereBefore);
    const listed = (await (await request("/conversations")).json()) as {
      conversations: { id: string }[];
    };
    expect(listed.conversations.map((c) => c.id)).toContain(other.conversation.id);
    expect((await request(`/conversations/${other.conversation.id}`)).status).toBe(200);
  }
);

test.each(["empty", "malformed", "future-version", "directory", "other-conversations-record"])(
  "(g) a damaged conversation record (%s) is reported by itself, every entrance refuses, and the bytes stay",
  async (kind) => {
    const first = await create();
    const other = await create();
    const id = first.conversation.id;
    await host.close();
    const path = recordPath(id);
    const original = readFileSync(path, "utf8");
    if (kind === "empty") writeFileSync(path, "");
    if (kind === "malformed") writeFileSync(path, original.slice(0, original.length >> 1));
    if (kind === "future-version")
      writeFileSync(path, original.replace(/"version":\s*1/, '"version":99'));
    if (kind === "other-conversations-record")
      copyFileSync(recordPath(other.conversation.id), path);
    if (kind === "directory") {
      rmSync(path);
      mkdirSync(path);
    }
    if (kind === "future-version") expect(readFileSync(path, "utf8")).not.toBe(original);
    const damaged = storeBytes();
    newHost();
    const outcome = await everyEntrance(id);
    expect(isError(outcome.snapshot), JSON.stringify(outcome)).toBe(true);
    expect(isError(outcome.send), JSON.stringify(outcome)).toBe(true);
    expect(isError(outcome.resume), JSON.stringify(outcome)).toBe(true);
    expect(isError(outcome.model), JSON.stringify(outcome)).toBe(true);
    expect(isError((await request(`/conversations/${id}/stop`, "POST")).status)).toBe(true);
    expect(seen).toHaveLength(0);
    expect(storeBytes()).toBe(damaged);
    const listed = (await (await request("/conversations")).json()) as {
      conversations: { id: string }[];
      unreadable: { id: string; code: string }[];
    };
    expect(listed.conversations.map((c) => c.id)).toContain(other.conversation.id);
    expect(listed.conversations.map((c) => c.id)).not.toContain(id);
    expect(listed.unreadable.map((u) => u.id)).toContain(id);
    expect((await request(`/conversations/${other.conversation.id}`)).status).toBe(200);
  }
);

test("(g) a copilot directory that is a file, or a conversations/sessions directory that is a file: creating fails honestly and the blocking file keeps its bytes", async () => {
  for (const blocked of ["copilot", "copilot/conversations", "copilot/sessions"]) {
    rmSync(join(dataDir, "copilot"), { recursive: true, force: true });
    const target = join(dataDir, blocked);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "not a directory: user's bytes");
    newHost();
    const res = await request("/conversations", "POST", { model: choice });
    expect(isError(res.status), blocked).toBe(true);
    const text = await res.text();
    expect(text).not.toContain(dataDir);
    expect(readFileSync(target, "utf8")).toBe("not a directory: user's bytes");
    expect(seen).toHaveLength(0);
  }
});

test("(g) a damaged delivery-ledger entry in the history: tolerated by design, kept byte for byte through the next saved turn; one that breaks the history schema blocks the conversation", async () => {
  const snapshot = await create();
  const id = snapshot.conversation.id;
  script = [() => ({ text: "one" }), () => ({ text: "two" })];
  await post(id, page(A, 1), "first");
  await until(id, ["completed"]);
  await host.close();
  const path = historyPath(snapshot);
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  const last = JSON.parse(lines.at(-1) as string);
  const ledger = JSON.stringify({
    type: "custom",
    id: "ledger-garbage",
    parentId: last.id,
    timestamp: new Date().toISOString(),
    customType: "argelander.delivery.v1",
    data: { records: "not a list", ceiling: -5, version: 7 },
  });
  const damagedBytes = `${lines.join("\n")}\n${ledger}\n`;
  writeFileSync(path, damagedBytes);
  newHost();
  // The conversation opens (the ledger is bookkeeping about what to shed, and a record it cannot read counts for nothing) ...
  expect((await request(`/conversations/${id}`)).status).toBe(200);
  expect(readFileSync(path, "utf8")).toBe(damagedBytes);
  // ... and the next saved turn keeps that line exactly where it was.
  await post(id, page(A, 1), "second");
  await until(id, ["completed"]);
  const after = readFileSync(path, "utf8");
  expect(after.startsWith(damagedBytes)).toBe(true);
  expect(after.split("\n").filter((line) => line === ledger)).toHaveLength(1);
  // A custom entry that is not even a history entry (no id) makes the history unreadable, bytes kept.
  await host.close();
  const broken = `${after}${JSON.stringify({ type: "custom", customType: "argelander.delivery.v1", data: {} })}\n`;
  writeFileSync(path, broken);
  newHost();
  const before = seen.length;
  expect(isError((await everyEntrance(id)).send)).toBe(true);
  expect(seen).toHaveLength(before);
  expect(readFileSync(path, "utf8")).toBe(broken);
});

// ---- (g) the business store under the agent's tools ---------------------------------------------------------- //
test.each(["malformed", "empty", "directory"])(
  "(g) a damaged plans store (%s) is an error to the agent and to the page, never an empty plan; the user's bytes stay",
  async (kind) => {
    const { id } = (await create()).conversation;
    const path = plansPath(statusDir);
    if (kind === "malformed") writeFileSync(path, '{"version":1,"rev":7,"plans":[');
    if (kind === "empty") writeFileSync(path, "");
    if (kind === "directory") {
      rmSync(path);
      mkdirSync(path);
    }
    const damaged = treeBytes(path);
    script = [
      () => ({ call: { action: "read" } }),
      () => ({ call: agentBlocksTask1 }),
      (ctx) => ({ text: `${lastResult(ctx).status}` }),
    ];
    await post(id, page(A, 1), "Read then edit");
    await until(id, ["completed"]);
    const statuses = (await operationsOf(id)).map((o) => `${o.action}:${o.status}`);
    expect(statuses).toEqual(["read:error", "update_task:error"]);
    expect(treeBytes(path)).toBe(damaged);
    expect(isError((await putPlans(seed())).status)).toBe(true);
    expect(treeBytes(path)).toBe(damaged);
  }
);

// ---- (g) the store is damaged from outside while a run is in flight ------------------------------------------ //
test.each([
  "history-appended-junk",
  "history-replaced-by-directory",
  "record-malformed",
  "sessions-dir-removed",
])(
  "(g) %s while a run is in flight: the run ends honestly (never a silent rewrite of what the outside left), and no later model step uses the unsaved history",
  async (kind) => {
    const snapshot = await create();
    const id = snapshot.conversation.id;
    const hold = gate();
    script = [
      async () => {
        await hold.wait;
        return { text: "answer after the damage" };
      },
      () => ({ text: "must never be requested after a failed save" }),
    ];
    await post(id, page(A, 1), "Think while the disk is damaged");
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    const path = historyPath(snapshot);
    if (kind === "history-appended-junk") appendFileSync(path, "{junk\n");
    if (kind === "history-replaced-by-directory") {
      rmSync(path);
      mkdirSync(path);
      writeFileSync(join(path, "keep.txt"), "keep");
    }
    if (kind === "record-malformed") writeFileSync(recordPath(id), "{ not json");
    if (kind === "sessions-dir-removed")
      rmSync(join(dataDir, "copilot/sessions"), { recursive: true });
    const outside = kind === "history-replaced-by-directory" ? treeBytes(path) : "";
    hold.open();
    // The run's last save finds that what is on disk is no longer what it wrote. It must not write over it.
    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 400));
    expect(seen).toHaveLength(1);
    expect(diskBytes()).toBe(JSON.stringify(seed(), null, 2));
    if (kind === "record-malformed") {
      // the conversation refuses to be read at all, and the bytes the outside left are untouched
      expect(isError((await request(`/conversations/${id}`)).status)).toBe(true);
      expect(readFileSync(recordPath(id), "utf8")).toBe("{ not json");
      return;
    }
    // the saved record says what happened; the unreadable history refuses to be shown as if it were fine
    expect(isError((await request(`/conversations/${id}`)).status)).toBe(true);
    expect(JSON.parse(readFileSync(recordPath(id), "utf8")).run).toMatchObject({
      status: "failed",
      error: "storage",
    });
    if (kind === "history-appended-junk")
      expect(readFileSync(path, "utf8").endsWith("{junk\n")).toBe(true);
    if (kind === "history-replaced-by-directory") expect(treeBytes(path)).toBe(outside);
    // a deleted history is not resurrected from memory (the empty application directory may be recreated)
    if (kind === "sessions-dir-removed") expect(() => lstatSync(path)).toThrow();
  }
);

// ---- (e) a whole server closed and started again on the same dataDir, mid-run ------------------------------- //
test("(e) the real server is closed mid-run and started again on the same dataDir: the run is interrupted, nothing is replayed at boot, the record and history keep their bytes, and Resume then runs once", async () => {
  const { createServer } = await import("../src/server.js");
  const boot = async () => {
    const created = createServer({
      dataDir,
      port: 0,
      heartbeatMs: 0,
      webDist: null,
      providerSettings: settings,
      deps: { makeSources: () => stubSources() },
    });
    await created.ready();
    app = created.app;
    return created;
  };
  const first = await boot();
  const snapshot = await create();
  const id = snapshot.conversation.id;
  script = [() => new Promise<Out>(() => {}), () => ({ text: "resumed answer" })];
  await post(id, page(A, 1), "Think for a long time");
  await vi.waitFor(() => expect(seen).toHaveLength(1));
  await first.close();
  const historyAfterClose = readFileSync(historyPath(snapshot));
  const second = await boot();
  try {
    const shown = (await (await request(`/conversations/${id}`)).json()) as ConversationSnapshot;
    expect(["interrupted", "stopped"]).toContain(shown.conversation.run?.status);
    // booting is reading: no model request, no write over what the first process left
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).toHaveLength(1);
    expect(readFileSync(historyPath(snapshot))).toEqual(historyAfterClose);
    const context = page(A, 1);
    await publish(context);
    const resume = await request(`/conversations/${id}/resume`, "POST", {
      clientMessageId: randomUUID(),
      viewId: context.viewId,
      contextRevision: context.revision,
    });
    expect(resume.status).toBe(202);
    await vi.waitFor(
      async () => {
        const state = (await (
          await request(`/conversations/${id}`)
        ).json()) as ConversationSnapshot;
        expect(state.conversation.run?.status).toBe("completed");
      },
      { timeout: 8000 }
    );
    expect(seen).toHaveLength(2);
  } finally {
    await second.close();
  }
});
