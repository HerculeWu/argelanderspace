/**
 * Human confirmation of Plan/Task deletes (copilot ticket 11), end to end on the real seam: real Pi session,
 * real HTTP routes (the confirmation and undo endpoints), real Plan lock/store/disk and plan.changed
 * notification, real native JSONL history and a restart. Only the model provider is scripted: the model
 * can ask for a delete but has no way to answer its own request.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ConversationSnapshot,
  CopilotConfirmation,
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
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import { CopilotHost } from "../src/copilot.js";
import { JobRunner } from "../src/jobs.js";
import { ProviderSettings } from "../src/providers.js";
import { stubPipelines, stubSources } from "./helpers.js";

const failure = vi.hoisted(() => ({ target: "", once: false }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      if (failure.once && to === failure.target) {
        failure.once = false;
        throw new Error("injected rename failure");
      }
      return fs.renameSync(from, to);
    },
  };
});

type Out = { text?: string; call?: Record<string, unknown> };
type Step = (context: TranscriptContext) => Out | Promise<Out>;
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
const choice = { provider: "openai", model: "gpt-4.1", thinking: null };
const A = "p_0000000a";
const B = "p_0000000b";
const T1 = "t_00000001";
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
  x_external: "keep-me",
  plans: [
    {
      id: A,
      name: "Alpha <b>plan</b>",
      due: "2026-12-31",
      icon: "target",
      created_at: "2026-10-02T00:00:00.000Z",
      x_plan: 1,
      tasks: [
        task(1, { x_task: "keep-task" }),
        task(2, { status: "doing" }),
        task(3, { status: "done" }),
      ],
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
  const last = context.messages.filter((m) => m.role === "toolResult").at(-1);
  if (last?.role !== "toolResult") throw new Error("no tool result yet");
  const part = last.content[0];
  return JSON.parse(part && part.type === "text" ? part.text : "{}");
};

function boot() {
  const created = new CopilotHost(dataDir, settings, (event) => broadcasts.push(event));
  hosts.push(created);
  host = created;
  app = createApp({
    paths: libraryPaths(dataDir),
    statusDir,
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(root, "jobs") }),
    providerSettings: settings,
    copilot: created,
    broadcast: (message) => broadcasts.push(message),
  });
}

beforeEach(async () => {
  originalEnv = process.env;
  root = mkdtempSync(join(tmpdir(), "copilot-confirm-"));
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
  script = [];
  seen = [];
  broadcasts = [];
  hosts = [];
  settings = new ProviderSettings();
  await settings.credential("openai", "SYNTHETIC_COPILOT_KEY");
  (await settings.getRuntime()).registerProvider("openai", {
    api: "openai-responses",
    streamSimple(model: Model<Api>, context: TranscriptContext) {
      seen.push(structuredClone(context));
      const index = seen.length;
      const step = script[index - 1];
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
        stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      })();
      return stream;
    },
  });
  boot();
});
afterEach(async () => {
  failure.target = "";
  for (const created of hosts) await created.close().catch(() => {});
  process.env = originalEnv;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
async function start(context: PageContext, text = "Clean up the plans") {
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
const runStatus = async (id: string, target: CopilotHost = host) =>
  (await target.snapshot(id)).conversation.run?.status;
async function until(id: string, wanted: string[], target: CopilotHost = host) {
  await vi.waitFor(async () => expect(wanted).toContain(await runStatus(id, target)), {
    timeout: 8000,
  });
}
async function card(id: string, target: CopilotHost = host): Promise<CopilotConfirmation> {
  let found: CopilotConfirmation | undefined;
  await vi.waitFor(
    async () => {
      found = (await target.snapshot(id)).confirmations[0];
      expect(found).toBeDefined();
    },
    { timeout: 8000 }
  );
  return found as CopilotConfirmation;
}
const answer = (
  confirmation: CopilotConfirmation,
  view: PageContext,
  decision: "approve" | "decline",
  over: Record<string, unknown> = {}
) =>
  request(`/confirmations/${confirmation.id}`, "POST", {
    decision,
    viewId: view.viewId,
    action: confirmation.action,
    objectId: confirmation.object.id,
    baseRev: confirmation.baseRev,
    ...over,
  });
const operations = async (id: string) =>
  (await host.snapshot(id)).messages.flatMap((m) => m.operations ?? []);
const userSavesAnotherTask = async (title: string) => {
  const current = disk() as PlansFile;
  const edited = structuredClone(current);
  const target = edited.plans[1]?.tasks[0];
  if (target) target.title = title;
  const res = await app.request("/api/plans", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(edited),
  });
  expect(res.status).toBe(200);
};
// Only a whole Plan waits for the user.
const askDelete = (extra: Record<string, unknown> = {}) => ({
  call: { action: "delete_plan", expectedRev: 7, planId: A, ...extra },
});
const dropTask = (extra: Record<string, unknown> = {}) => ({
  call: { action: "delete_task", expectedRev: 7, planId: A, taskId: T1, ...extra },
});
const planIds = () => disk().plans.map((p: { id: string }) => p.id);

test("the delete waits for the real user: the card names the object and impact, the run is waiting-for-user and nothing is written", async () => {
  const view = page(A);
  script = [
    () => ({ call: { action: "delete_plan", expectedRev: 7, planId: A } }),
    () => ({ text: "waiting" }),
  ];
  const before = diskBytes();
  const id = await start(view);
  const shown = await card(id);
  expect(shown).toMatchObject({
    action: "delete_plan",
    object: { kind: "plan", id: A, planId: A },
    label: "Alpha <b>plan</b>",
    impact: { tasks: 3, openTasks: 2 },
    baseRev: 7,
  });
  const snapshot = await host.snapshot(id);
  expect(snapshot.conversation.run?.status).toBe("waiting-for-user");
  expect((await operations(id)).map((o) => `${o.action}:${o.status}`)).toEqual([
    "delete_plan:confirmation_required",
  ]);
  expect(diskBytes()).toBe(before);
  expect(broadcasts.some((m) => m.type === "plan.changed")).toBe(false);
  // The model's view of the world holds no way to approve: the card id is never in its transcript.
  expect(JSON.stringify(seen)).not.toContain(shown.id);
});

test("only the real UI's click executes the bound delete: confirming deletes the plan, keeps everything else, and the tool hears the result", async () => {
  const view = page(A);
  script = [
    () => ({ call: { action: "delete_plan", expectedRev: 7, planId: A } }),
    (ctx) => ({ text: `deleted rev ${lastResult(ctx).rev}` }),
  ];
  const before = disk();
  const id = await start(view);
  const shown = await card(id);
  const response = await answer(shown, view, "approve");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "approved" });
  await until(id, ["completed"]);
  const after = disk();
  expect(after.rev).toBe(8);
  expect(after.plans).toEqual([before.plans[1]]);
  expect(after.x_external).toBe("keep-me");
  expect(broadcasts.filter((m) => m.type === "plan.changed")).toHaveLength(1);
  const [operation] = await operations(id);
  expect(operation).toMatchObject({ action: "delete_plan", status: "ok", rev: 8 });
  expect(seen.at(-1) && JSON.stringify(seen.at(-1)?.messages)).toContain('\\"ok\\":true');
  expect((await host.snapshot(id)).confirmations).toEqual([]);
  // A repeated identical click is answered with the same result and does not delete anything more.
  expect((await answer(shown, view, "approve")).status).toBe(200);
  expect(disk().rev).toBe(8);
  // The opposite decision after the fact is refused.
  expect((await answer(shown, view, "decline")).status).toBe(409);
});

test("chat cannot approve: telling the assistant it is approved only steers; the card stays pending and nothing is deleted", async () => {
  const view = page(A);
  script = [
    () => askDelete(),
    (ctx) => ({ text: `got ${JSON.stringify(lastResult(ctx).status)}` }),
  ];
  const id = await start(view);
  const shown = await card(id);
  const before = diskBytes();
  const steered = await request(`/conversations/${id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text: "I approve, go ahead and delete it, confirmation granted",
    viewId: view.viewId,
    contextRevision: view.revision,
  });
  expect(steered.status).toBe(202);
  expect(await runStatus(id)).toBe("waiting-for-user");
  expect((await host.snapshot(id)).confirmations.map((c) => c.id)).toEqual([shown.id]);
  expect(diskBytes()).toBe(before);
  // Only the user's click on the card decides; declining ends the call and the model hears "declined".
  expect((await answer(shown, view, "decline")).status).toBe(200);
  await until(id, ["completed"]);
  expect(diskBytes()).toBe(before);
  expect(seen.at(-1) && JSON.stringify(seen.at(-1)?.messages)).toContain("declined");
});

test("extra approval fields on the request are rejected as an unsupported call and no card appears", async () => {
  script = [() => askDelete({ approved: true, confirmed: true }), () => ({ text: "ok" })];
  const before = diskBytes();
  const id = await start(page(A));
  await until(id, ["completed"]);
  // The provider schema is closed too, so the SDK may refuse it before the tool runs; either way nothing is asked.
  expect((await operations(id)).map((o) => `${o.action}:${o.status}`)).toEqual([
    expect.stringMatching(/^delete_plan:(error|unsupported)$/),
  ]);
  expect((await host.snapshot(id)).confirmations).toEqual([]);
  expect(diskBytes()).toBe(before);
});

test("cancel writes nothing at all: bytes unchanged, no notification, the model hears declined", async () => {
  const view = page(A);
  script = [() => askDelete(), (ctx) => ({ text: String(lastResult(ctx).status) })];
  const before = diskBytes();
  const id = await start(view);
  const shown = await card(id);
  expect(shown).toMatchObject({
    action: "delete_plan",
    impact: { tasks: 3, openTasks: 2 },
    planName: "Alpha <b>plan</b>",
  });
  expect((await answer(shown, view, "decline")).status).toBe(200);
  await until(id, ["completed"]);
  expect(diskBytes()).toBe(before);
  expect(broadcasts.some((m) => m.type === "plan.changed")).toBe(false);
  expect((await operations(id)).map((o) => o.status)).toEqual(["declined"]);
  expect((await host.snapshot(id)).messages.at(-1)?.text).toBe("declined");
});

test("a click is bound to the object and version the card showed; a mismatch, an unknown view or a bad body changes nothing", async () => {
  const view = page(A);
  script = [() => askDelete(), () => ({ text: "x" })];
  const id = await start(view);
  const shown = await card(id);
  const before = diskBytes();
  expect((await answer(shown, view, "approve", { baseRev: 6 })).status).toBe(409);
  expect((await answer(shown, view, "approve", { objectId: B })).status).toBe(409);
  expect((await answer(shown, view, "approve", { action: "delete_task" })).status).toBe(400);
  expect((await answer(shown, page(A), "approve")).status).toBe(409); // a view the service never saw
  expect((await answer(shown, view, "approve", { decision: "yes" })).status).toBe(400);
  expect(
    (await request(`/confirmations/${shown.id}`, "POST", { decision: "approve" })).status
  ).toBe(400);
  expect(
    (
      await request(`/confirmations/${randomUUID()}`, "POST", {
        decision: "approve",
        viewId: view.viewId,
        action: "delete_plan",
        objectId: A,
        baseRev: 7,
      })
    ).status
  ).toBe(404);
  expect(diskBytes()).toBe(before);
  expect((await host.snapshot(id)).confirmations).toHaveLength(1);
  expect((await answer(shown, view, "decline")).status).toBe(200);
  await until(id, ["completed"]);
});

test("waiting holds no business lock; a user save while waiting expires the old confirmation, which can no longer be used", async () => {
  const view = page(A);
  script = [
    () => askDelete(),
    (ctx) => {
      expect(lastResult(ctx)).toMatchObject({ ok: false, status: "expired" });
      return { text: "expired" };
    },
  ];
  const id = await start(view);
  const shown = await card(id);
  // The Plan lock is free: the user's own save goes through at once.
  await userSavesAnotherTask("User edit while waiting");
  await until(id, ["completed"]);
  expect((await host.snapshot(id)).confirmations).toEqual([]);
  expect((await answer(shown, view, "approve")).status).toBe(409);
  const file = disk();
  expect(file.rev).toBe(8);
  expect(file.plans[0].tasks.map((t: { id: string }) => t.id)).toContain(T1);
  expect(file.plans[1].tasks[0].title).toBe("User edit while waiting");
  expect((await operations(id)).map((o) => o.status)).toEqual(["expired"]);
});

test("after an expiry the model must ask again with the new version and the user must confirm again", async () => {
  const view = page(A);
  let firstCard = "";
  script = [
    () => askDelete(),
    () => askDelete({ expectedRev: 8 }),
    (ctx) => ({ text: `deleted rev ${lastResult(ctx).rev}` }),
  ];
  const id = await start(view);
  const first = await card(id);
  firstCard = first.id;
  await userSavesAnotherTask("Changed");
  // The re-issued request is a NEW card bound to rev 8; the old click still fails.
  let second: CopilotConfirmation | undefined;
  await vi.waitFor(async () => {
    second = (await host.snapshot(id)).confirmations[0];
    expect(second).toBeDefined();
  });
  expect(second?.id).not.toBe(firstCard);
  expect(second?.baseRev).toBe(8);
  expect((await answer(first, view, "approve")).status).toBe(409);
  expect(planIds()).toContain(A);
  expect((await answer(second as CopilotConfirmation, view, "approve")).status).toBe(200);
  await until(id, ["completed"]);
  expect(planIds()).not.toContain(A);
  expect(disk().rev).toBe(9);
});

test("a stale request (older rev than the plans) is refused up front with no card", async () => {
  script = [() => askDelete({ expectedRev: 3 }), () => ({ text: "stale" })];
  const before = diskBytes();
  const id = await start(page(A));
  await until(id, ["completed"]);
  expect((await operations(id)).map((o) => o.status)).toEqual(["conflict"]);
  expect(diskBytes()).toBe(before);
});

test("an object that is gone is not_found, with no card", async () => {
  script = [() => askDelete({ planId: "p_0000dead" }), () => ({ text: "gone" })];
  const id = await start(page(A));
  await until(id, ["completed"]);
  expect((await operations(id)).map((o) => o.status)).toEqual(["not_found"]);
});

test("Stop while waiting withdraws the request without executing it, and no later step starts", async () => {
  const view = page(A);
  script = [() => askDelete(), () => ({ text: "must not run" })];
  const id = await start(view);
  const shown = await card(id);
  const before = diskBytes();
  expect((await request(`/conversations/${id}/stop`, "POST")).status).toBe(200);
  await until(id, ["stopped"]);
  expect(diskBytes()).toBe(before);
  expect(seen).toHaveLength(1); // no model step after Stop
  expect((await host.snapshot(id)).confirmations).toEqual([]);
  expect((await answer(shown, view, "approve")).status).toBe(409);
  expect(diskBytes()).toBe(before);
  expect((await operations(id)).map((o) => o.status)).toEqual(["expired"]);
});

test("an approved delete is a submitted write: Stop right after the click still lets it finish and report", async () => {
  const view = page(A);
  script = [() => askDelete(), () => ({ text: "must not run" })];
  const id = await start(view);
  const shown = await card(id);
  expect((await answer(shown, view, "approve")).status).toBe(200);
  expect((await request(`/conversations/${id}/stop`, "POST")).status).toBe(200);
  await until(id, ["stopped", "completed"]);
  expect(planIds()).not.toContain(A);
  expect((await operations(id)).map((o) => o.status)).toEqual(["ok"]);
  expect(seen).toHaveLength(1);
});

test("the pending request survives a lost connection (a fresh read still shows it) and a restart revives no authorization", async () => {
  const view = page(A);
  script = [() => askDelete(), () => ({ text: "after restart" })];
  const id = await start(view);
  const shown = await card(id);
  // "Reconnect": any new reader gets the same card from the saved/in-memory state.
  expect((await request(`/conversations/${id}`)).status).toBe(200);
  expect((await host.snapshot(id)).confirmations.map((c) => c.id)).toEqual([shown.id]);
  const before = diskBytes();
  // The service dies without a clean shutdown: a new process loads the same files.
  boot(); // the old instance is abandoned mid-wait and only closed in afterEach
  const restarted = await host.snapshot(id);
  expect(restarted.conversation.run?.status).toBe("interrupted");
  expect(restarted.confirmations).toEqual([]);
  expect((await operations(id)).map((o) => `${o.action}:${o.status}`)).toEqual([
    "delete_plan:expired",
  ]);
  // The restarted service has not seen this browser view yet: refused, no effect.
  expect((await answer(shown, view, "approve")).status).toBe(409);
  expect((await request(`/views/${view.viewId}`, "PUT", view)).status).toBe(200);
  // Even from a known view the old card id is unknown to the new process: nothing to approve.
  expect((await answer(shown, view, "approve")).status).toBe(404);
  expect(diskBytes()).toBe(before);
  // Resume tells the model what happened (nothing deleted); it needs a brand-new request to delete.
  expect(
    (
      await request(`/conversations/${id}/resume`, "POST", {
        clientMessageId: randomUUID(),
        viewId: view.viewId,
        contextRevision: view.revision,
      })
    ).status
  ).toBe(202);
  await until(id, ["completed"]);
  expect(diskBytes()).toBe(before);
  const transcript = JSON.stringify(seen.at(-1)?.messages);
  expect(transcript).toContain("nothing was deleted");
  expect(transcript).toContain("new confirmation");
});

test("an operationId that already ran returns the first result and neither asks again nor deletes again", async () => {
  const view = page(A);
  script = [
    () => askDelete({ operationId: "del-1" }),
    () => askDelete({ operationId: "del-1" }),
    (ctx) => ({ text: JSON.stringify(lastResult(ctx)) }),
  ];
  const id = await start(view);
  const shown = await card(id);
  expect((await answer(shown, view, "approve")).status).toBe(200);
  await until(id, ["completed"]);
  expect((await host.snapshot(id)).messages.at(-1)?.text).toContain('"duplicate":true');
  expect(disk().rev).toBe(8);
  expect((await host.snapshot(id)).confirmations).toEqual([]);
});

test("a confirmation that cannot be saved is never shown and writes nothing; a decision that cannot be saved leaves it pending", async () => {
  const view = page(A);
  script = [() => askDelete(), (ctx) => ({ text: String(lastResult(ctx).status) })];
  const created = (await (
    await request("/conversations", "POST", { model: choice })
  ).json()) as ConversationSnapshot;
  const id = created.conversation.id;
  const history = join(dataDir, "copilot/sessions", `${created.conversation.sessionId}.jsonl`);
  expect((await request(`/views/${view.viewId}`, "PUT", view)).status).toBe(200);
  await request(`/conversations/${id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text: "delete it",
    viewId: view.viewId,
    contextRevision: view.revision,
  });
  const shown = await card(id);
  const before = diskBytes();
  const sessionBytes = readFileSync(history, "utf8");
  // The decision cannot be recorded: 503, the request stays pending and nothing is deleted.
  failure.target = history;
  failure.once = true;
  expect((await answer(shown, view, "approve")).status).toBe(503);
  expect((await host.snapshot(id)).confirmations.map((c) => c.id)).toEqual([shown.id]);
  expect(diskBytes()).toBe(before);
  expect(readFileSync(history, "utf8")).toBe(sessionBytes);
  expect((await answer(shown, view, "decline")).status).toBe(200);
  await until(id, ["completed"]);
  expect(diskBytes()).toBe(before);
});

test("deleting one Task is immediate like the Plan page (no card), with an eight-second undo that works once; later edits are kept", async () => {
  const view = page(A);
  script = [() => dropTask(), () => ({ text: "deleted" })];
  const before = disk();
  const id = await start(view);
  await until(id, ["completed"]);
  expect((await host.snapshot(id)).confirmations).toEqual([]);
  expect(broadcasts.some((m) => m.type === "plan.changed")).toBe(true);
  const [deleted] = await operations(id);
  expect(deleted?.status).toBe("ok");
  expect(Date.parse(deleted?.undo?.until ?? "") - Date.now()).toBeLessThanOrEqual(8000);
  expect(disk().plans[0].tasks.map((t: { id: string }) => t.id)).toEqual([
    "t_00000002",
    "t_00000003",
  ]);
  const toolCallId = deleted?.id ?? "";
  // A request from a view the service never saw cannot undo.
  expect(
    (
      await request(`/conversations/${id}/operations/${toolCallId}/undo`, "POST", {
        viewId: randomUUID(),
      })
    ).status
  ).toBe(409);
  const undone = await request(`/conversations/${id}/operations/${toolCallId}/undo`, "POST", {
    viewId: view.viewId,
  });
  expect(undone.status).toBe(200);
  expect(await undone.json()).toMatchObject({ status: "ok", rev: 9 });
  const after = disk();
  expect(after.plans[0].tasks[0]).toEqual(before.plans[0].tasks[0]); // same position, unknown keys intact
  expect(after.rev).toBe(9);
  expect(
    (
      await request(`/conversations/${id}/operations/${toolCallId}/undo`, "POST", {
        viewId: view.viewId,
      })
    ).status
  ).toBe(200); // already back (noop)
});

test("the undo window closes after eight seconds", async () => {
  const view = page(A);
  script = [() => dropTask(), () => ({ text: "deleted" })];
  const id = await start(view);
  await until(id, ["completed"]);
  const [deleted] = await operations(id);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 8500);
  const late = await request(`/conversations/${id}/operations/${deleted?.id}/undo`, "POST", {
    viewId: view.viewId,
  });
  expect(late.status).toBe(409);
  expect(disk().plans[0].tasks.map((t: { id: string }) => t.id)).not.toContain(T1);
});

test("Plan deletion has no undo (the Plan page offers none) and ordinary agent edits never ask for a confirmation", async () => {
  const view = page(A);
  script = [
    () => ({
      call: { action: "update_task", expectedRev: 7, planId: A, taskId: T1, status: "done" },
    }),
    () => ({ call: { action: "delete_plan", expectedRev: 8, planId: B } }),
    () => ({ text: "x" }),
  ];
  const id = await start(view);
  const shown = await card(id);
  expect(shown.action).toBe("delete_plan");
  expect(disk().plans[0].tasks[0].status).toBe("done"); // the edit ran without any approval
  expect((await answer(shown, view, "approve")).status).toBe(200);
  await until(id, ["completed"]);
  const ops = await operations(id);
  expect(ops.map((o) => `${o.action}:${o.status}`)).toEqual(["update_task:ok", "delete_plan:ok"]);
  expect(ops[1]?.undo).toBeUndefined();
});

test("a Task delete is an ordinary write: a stale rev is a conflict with no card, a repeated operationId returns the first result", async () => {
  script = [
    () => dropTask({ expectedRev: 3 }),
    () => dropTask({ operationId: "drop-1" }),
    () => dropTask({ operationId: "drop-1" }),
    (ctx) => ({ text: JSON.stringify(lastResult(ctx)) }),
  ];
  const id = await start(page(A));
  await until(id, ["completed"]);
  expect((await host.snapshot(id)).confirmations).toEqual([]);
  expect((await operations(id)).map((o) => o.status)).toEqual(["conflict", "ok", "ok"]);
  expect((await host.snapshot(id)).messages.at(-1)?.text).toContain('"duplicate":true');
  expect(disk().rev).toBe(8); // deleted once
  expect(disk().plans[0].tasks.map((t: { id: string }) => t.id)).toEqual([
    "t_00000002",
    "t_00000003",
  ]);
});

test("a hand edit of plans.json that leaves the rev alone still ends the confirmation (content digest), on revalidation and on the click", async () => {
  const view = page(A);
  script = [() => askDelete(), () => ({ text: "x" })];
  const id = await start(view);
  const shown = await card(id);
  const edited = disk();
  edited.plans[0].tasks[0].title = "Edited by hand, rev untouched";
  writeFileSync(plansPath(statusDir), JSON.stringify(edited, null, 2));
  expect(disk().rev).toBe(7);
  // The click is refused even before the watcher noticed.
  expect((await answer(shown, view, "approve")).status).toBe(409);
  expect(planIds()).toContain(A);
  await until(id, ["completed"]);
  expect((await operations(id)).map((o) => o.status)).toEqual(["expired"]);
});

test("the watcher path (revalidate) expires a card after a rev-neutral hand edit", async () => {
  const view = page(A);
  script = [() => askDelete(), () => ({ text: "x" })];
  const id = await start(view);
  await card(id);
  const edited = disk();
  edited.x_external = "changed by hand";
  edited.plans[1].name = "Beta renamed by hand"; // another plan: the shown one is untouched
  writeFileSync(plansPath(statusDir), JSON.stringify(edited, null, 2));
  void host.revalidate("plans");
  await vi.waitFor(async () => expect((await host.snapshot(id)).confirmations).toHaveLength(1));
  // Editing the shown plan's own content expires it.
  const again = disk();
  again.plans[0].x_plan = 2;
  writeFileSync(plansPath(statusDir), JSON.stringify(again, null, 2));
  void host.revalidate("plans");
  await until(id, ["completed"]);
  expect((await host.snapshot(id)).confirmations).toEqual([]);
  expect(planIds()).toContain(A);
});

test("unreadable plans are a system error, not a change: a background recheck keeps the card and the click is unreadable, the tool an error (ticket 35)", async () => {
  const view = page(A);
  script = [() => askDelete(), () => ({ text: "x" })];
  const id = await start(view);
  const shown = await card(id);
  const bytes = diskBytes();
  writeFileSync(plansPath(statusDir), "{ damaged");
  await host.revalidate("plans");
  expect((await host.snapshot(id)).confirmations).toHaveLength(1);
  const click = await answer(shown, view, "approve");
  expect(click.status).toBe(500);
  expect(((await click.json()) as { code: string }).code).toBe("unreadable");
  await until(id, ["completed"]);
  expect((await operations(id)).map((o) => o.status)).toEqual(["error"]);
  expect((await host.snapshot(id)).confirmations).toEqual([]);
  // Nothing was written: the damaged bytes are as the user left them.
  expect(diskBytes()).toBe("{ damaged");
  writeFileSync(plansPath(statusDir), bytes);
  expect(planIds()).toContain(A);
});

test("a decline that reached the record before a crash shows as declined, not expired, and the model is told so", async () => {
  const view = page(A);
  script = [() => askDelete(), () => ({ text: "after restart" })];
  const id = await start(view);
  await card(id);
  // The user's decline is saved, then the process dies before the tool result is.
  const pending = [
    ...(host as unknown as { confirmations: Map<string, unknown> }).confirmations.values(),
  ][0];
  (host as unknown as { recordResolution: (p: unknown, o: string) => void }).recordResolution(
    pending,
    "declined"
  );
  boot();
  expect((await operations(id)).map((o) => o.status)).toEqual(["declined"]);
  expect((await request(`/views/${view.viewId}`, "PUT", view)).status).toBe(200);
  expect(
    (
      await request(`/conversations/${id}/resume`, "POST", {
        clientMessageId: randomUUID(),
        viewId: view.viewId,
        contextRevision: view.revision,
      })
    ).status
  ).toBe(202);
  await until(id, ["completed"]);
  expect(JSON.stringify(seen.at(-1)?.messages)).toContain("the user declined");
  expect(planIds()).toContain(A);
});

test("the user's undo (and a failed one) is written into the conversation so the model's next step knows", async () => {
  const view = page(A);
  script = [() => dropTask(), () => ({ text: "deleted" }), () => ({ text: "noted" })];
  const id = await start(view);
  await until(id, ["completed"]);
  const [deleted] = await operations(id);
  const undone = await request(`/conversations/${id}/operations/${deleted?.id}/undo`, "POST", {
    viewId: view.viewId,
  });
  expect(undone.status).toBe(200);
  // A second undo finds the task already back: noop, and no false "failed" note is written for it.
  expect(
    (
      await request(`/conversations/${id}/operations/${deleted?.id}/undo`, "POST", {
        viewId: view.viewId,
      })
    ).status
  ).toBe(200);
  // A handle the service never held is refused, and that is recorded.
  expect(
    (
      await request(`/conversations/${id}/operations/call_unknown/undo`, "POST", {
        viewId: view.viewId,
      })
    ).status
  ).toBe(404);
  const history = readFileSync(
    join(dataDir, "copilot/sessions", `${(await host.snapshot(id)).conversation.sessionId}.jsonl`),
    "utf8"
  );
  expect(history).toContain('\\"undo\\":\\"restored\\"');
  expect(history).toContain('\\"undo\\":\\"failed\\"');
  const send = await request(`/conversations/${id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text: "What happened to the task?",
    viewId: view.viewId,
    contextRevision: view.revision,
  });
  expect(send.status).toBe(202);
  await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(3));
  expect(JSON.stringify(seen.at(-1)?.messages)).toContain("The user undid this task delete");
});

// ---- ticket 32 lane B: the card clicked while something else is happening at the same instant -------------------- //
test("(f/c) Approve and Decline clicked at the same instant (two clicks, one card): exactly one decision stands, the other is refused, and the plan is deleted at most once", async () => {
  const view = page(A);
  script = [() => askDelete(), (ctx) => ({ text: `got ${lastResult(ctx).status}` })];
  const before = disk();
  const id = await start(view);
  const shown = await card(id);
  const [approve, decline] = await Promise.all([
    answer(shown, view, "approve"),
    answer(shown, view, "decline"),
  ]);
  await until(id, ["completed"]);
  const statuses = [approve.status, decline.status];
  const after = disk();
  if (approve.status === 200) {
    expect(statuses).toEqual([200, 409]);
    expect(after.rev).toBe(8);
    expect(after.plans).toEqual([before.plans[1]]);
    expect((await operations(id)).map((o) => o.status)).toEqual(["ok"]);
  } else {
    expect(statuses).toEqual([409, 200]);
    expect(after.rev).toBe(7);
    expect(after.plans).toEqual(before.plans);
    expect((await operations(id)).map((o) => o.status)).toEqual(["declined"]);
  }
  expect(broadcasts.filter((m) => m.type === "plan.changed").length).toBeLessThanOrEqual(1);
  expect((await host.snapshot(id)).confirmations).toEqual([]);
});

test("(f/a) the user's save and the Approve click at the same instant: either the delete is expired and nothing is deleted, or it runs once and the user's stale save is refused 409 - never both", async () => {
  const view = page(A);
  script = [() => askDelete(), (ctx) => ({ text: `got ${lastResult(ctx).status}` })];
  const id = await start(view);
  const shown = await card(id);
  const current = disk() as PlansFile;
  const edited = structuredClone(current);
  const target = edited.plans[1]?.tasks[0];
  if (target) target.title = "User edit at the click";
  const [click, put] = await Promise.all([
    answer(shown, view, "approve"),
    app.request("/api/plans", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(edited),
    }),
  ]);
  await until(id, ["completed"]);
  const after = disk();
  const [operation] = await operations(id);
  expect(after.rev).toBe(8);
  if (put.status === 200) {
    // the user's save was first: the card was bound to rev 7, so the delete never ran
    expect(operation?.status).toBe("expired");
    expect(after.plans.map((p: { id: string }) => p.id)).toEqual([A, B]);
    expect(after.plans[1].tasks[0].title).toBe("User edit at the click");
    expect(click.status).toBeGreaterThanOrEqual(200);
  } else {
    // the click was first: the plan is gone once, and the user's stale document did not bring it back
    expect(put.status).toBe(409);
    expect(click.status).toBe(200);
    expect(operation?.status).toBe("ok");
    expect(after.plans.map((p: { id: string }) => p.id)).toEqual([B]);
    expect(after.plans[0].tasks[0].title).not.toBe("User edit at the click");
  }
  expect((await host.snapshot(id)).confirmations).toEqual([]);
});

// ---- The one undo: Copilot tool, Copilot panel and the Plan page (ticket 33 follow-up) ----------------- //

const undoCall = (extra: Record<string, unknown> = {}) => ({
  call: { action: "undo_delete_task", planId: A, taskId: T1, ...extra },
});

test("the Copilot can undo its own task delete: an operation row, the task back at its place, once", async () => {
  const view = page(A);
  const before = disk();
  script = [() => dropTask(), () => undoCall(), () => ({ text: "restored" })];
  const id = await start(view);
  await until(id, ["completed"]);
  const [deleted, undone] = await operations(id);
  expect(deleted).toMatchObject({ action: "delete_task", status: "ok" });
  expect(undone).toMatchObject({
    action: "undo_delete_task",
    status: "ok",
    object: { kind: "task", id: T1, planId: A },
  });
  const after = disk();
  expect(after.plans[0].tasks[0]).toEqual(before.plans[0].tasks[0]);
  expect(after.rev).toBe(9);
  // The handle is used up for the panel and the page too.
  expect(
    (
      await request(`/conversations/${id}/operations/${deleted?.id}/undo`, "POST", {
        viewId: view.viewId,
      })
    ).status
  ).toBe(200);
  expect(
    ((await (await app.request("/api/plans/undo")).json()) as { undoable: unknown[] }).undoable
  ).toEqual([]);
});

test("the Copilot's undo after eight seconds is refused as expired and the task stays deleted", async () => {
  const view = page(A);
  script = [
    () => dropTask(),
    () => {
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 8500);
      return undoCall();
    },
    () => ({ text: "too late" }),
  ];
  const id = await start(view);
  await until(id, ["completed"]);
  const [, undone] = await operations(id);
  expect(undone).toMatchObject({ action: "undo_delete_task", status: "expired" });
  expect(disk().plans[0].tasks.map((t: { id: string }) => t.id)).not.toContain(T1);
  expect(JSON.stringify(seen.at(-1)?.messages)).toContain("undo window is over");
});

test("the Copilot's undo after its plan was deleted is a conflict and writes nothing", async () => {
  const view = page(A);
  script = [
    () => dropTask(),
    () => ({ call: { action: "delete_plan", expectedRev: 8, planId: A } }),
    () => undoCall(),
    () => ({ text: "gone" }),
  ];
  const id = await start(view);
  const shown = await card(id);
  expect((await answer(shown, view, "approve")).status).toBe(200);
  await until(id, ["completed"]);
  const ops = await operations(id);
  expect(ops.at(-1)).toMatchObject({ action: "undo_delete_task", status: "conflict" });
  expect(planIds()).not.toContain(A);
});

test("a task the Copilot deleted is offered on the Plan page and its undo restores it, telling the model", async () => {
  const view = page(A);
  const before = disk();
  script = [() => dropTask(), () => ({ text: "deleted" }), () => ({ text: "noted" })];
  const id = await start(view);
  await until(id, ["completed"]);
  const listed = (await (await app.request("/api/plans/undo")).json()) as {
    undoable: { id: string; planId: string; taskId: string; title: string; until: string }[];
  };
  expect(listed.undoable).toHaveLength(1);
  expect(listed.undoable[0]).toMatchObject({ planId: A, taskId: T1, title: "Task 1" });
  expect(Date.parse(listed.undoable[0]?.until ?? "") - Date.now()).toBeLessThanOrEqual(8000);
  const post = (body: unknown) =>
    app.request("/api/plans/undo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await post({})).status).toBe(400);
  const restored = await post({ id: listed.undoable[0]?.id });
  expect(restored.status).toBe(200);
  expect(await restored.json()).toMatchObject({ status: "ok", rev: 9 });
  expect(disk().plans[0].tasks[0]).toEqual(before.plans[0].tasks[0]);
  expect((await post({ id: listed.undoable[0]?.id })).status).toBe(200); // the tombstone answers noop
  const history = readFileSync(
    join(dataDir, "copilot/sessions", `${(await host.snapshot(id)).conversation.sessionId}.jsonl`),
    "utf8"
  );
  expect(history).toContain('\\"undo\\":\\"restored\\"');
});

test("the Plan page's undo after eight seconds answers 409 expired and writes nothing", async () => {
  const view = page(A);
  script = [() => dropTask(), () => ({ text: "deleted" })];
  const id = await start(view);
  await until(id, ["completed"]);
  const [entry] = (
    (await (await app.request("/api/plans/undo")).json()) as { undoable: { id: string }[] }
  ).undoable;
  const bytes = diskBytes();
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 8500);
  const late = await app.request("/api/plans/undo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: entry?.id }),
  });
  expect(late.status).toBe(409);
  expect(await late.json()).toMatchObject({ status: "expired" });
  expect(diskBytes()).toBe(bytes);
});

// ---- Two surfaces, one undo (fix round 1): the second one is told "already back", never a false failure -------- //

const pageUndo = (undoId: string | undefined) =>
  app.request("/api/plans/undo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: undoId }),
  });
const heldUndoId = async () =>
  ((await (await app.request("/api/plans/undo")).json()) as { undoable: { id: string }[] })
    .undoable[0]?.id;
const historyOf = async (id: string) =>
  readFileSync(
    join(dataDir, "copilot/sessions", `${(await host.snapshot(id)).conversation.sessionId}.jsonl`),
    "utf8"
  );

test("the page restores first, then the Copilot's own undo answers noop (already back) and writes nothing", async () => {
  const view = page(A);
  let pageStatus = 0;
  script = [
    () => dropTask(),
    async () => {
      pageStatus = (await pageUndo(await heldUndoId())).status; // the user clicks the snackbar meanwhile
      return undoCall();
    },
    () => ({ text: "done" }),
  ];
  const id = await start(view);
  await until(id, ["completed"]);
  expect(pageStatus).toBe(200);
  const [, undone] = await operations(id);
  expect(undone).toMatchObject({ action: "undo_delete_task", status: "noop" });
  expect(disk().rev).toBe(9); // one restore, one rev bump
  expect(disk().plans[0].tasks.map((t: { id: string }) => t.id)).toEqual([
    T1,
    "t_00000002",
    "t_00000003",
  ]);
  expect(await historyOf(id)).not.toContain('\\"undo\\":\\"failed\\"');
});

test("the Copilot restores first, then the panel click answers 200 noop with no failure note, and the page is offered nothing", async () => {
  const view = page(A);
  script = [() => dropTask(), () => undoCall(), () => ({ text: "restored" })];
  const id = await start(view);
  await until(id, ["completed"]);
  const [deleted] = await operations(id);
  const held = ((await (await app.request("/api/plans/undo")).json()) as { undoable: unknown[] })
    .undoable;
  expect(held).toEqual([]); // no longer offered anywhere
  const bytes = diskBytes();
  const panel = await request(`/conversations/${id}/operations/${deleted?.id}/undo`, "POST", {
    viewId: view.viewId,
  });
  expect(panel.status).toBe(200);
  expect(await panel.json()).toMatchObject({ status: "noop" });
  expect(diskBytes()).toBe(bytes);
  expect(await historyOf(id)).not.toContain('\\"undo\\":\\"failed\\"');
});

test("the page and the panel undo at the same instant: one restore, one noop, a single rev bump", async () => {
  const view = page(A);
  script = [() => dropTask(), () => ({ text: "deleted" })];
  const id = await start(view);
  await until(id, ["completed"]);
  const [deleted] = await operations(id);
  const undoId = await heldUndoId();
  const [fromPage, fromPanel] = await Promise.all([
    pageUndo(undoId),
    request(`/conversations/${id}/operations/${deleted?.id}/undo`, "POST", {
      viewId: view.viewId,
    }),
  ]);
  expect([fromPage.status, fromPanel.status]).toEqual([200, 200]);
  const statuses = [
    ((await fromPage.json()) as { status: string }).status,
    ((await fromPanel.json()) as { status: string }).status,
  ].sort();
  expect(statuses).toEqual(["noop", "ok"]);
  expect(disk().rev).toBe(9);
  expect(disk().plans[0].tasks.map((t: { id: string }) => t.id)).toEqual([
    T1,
    "t_00000002",
    "t_00000003",
  ]);
});
