/**
 * Copilot `plan` tool, end to end on the real seam (copilot ticket 09): real Pi session, real HTTP routes,
 * real Plan lock/store/disk and plan.changed notification. Only the model provider is scripted.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  getCurrentTools,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import { CopilotHost } from "../src/copilot.js";
import { JobRunner } from "../src/jobs.js";
import { ProviderSettings } from "../src/providers.js";
import { makeDataDir, stubPipelines, stubSources } from "./helpers.js";

type Out = { text?: string; call?: Record<string, unknown> };
type Step = (context: TranscriptContext) => Out | Promise<Out>;
let root: string;
let statusDir: string;
let host: CopilotHost;
let app: ReturnType<typeof createApp>;
let settings: ProviderSettings;
let originalEnv: NodeJS.ProcessEnv;
let script: Step[];
let seen: TranscriptContext[];
let broadcasts: WsServerMessage[];
const choice = { provider: "openai", model: "gpt-4.1", thinking: null };

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
const plan = (id: string, name: string, tasks: object[], extra: object = {}) => ({
  id,
  name,
  due: "2026-12-31",
  icon: "target",
  created_at: "2026-10-02T00:00:00.000Z",
  tasks,
  ...extra,
});
const A = "p_0000000a";
const B = "p_0000000b";
const seed = () => ({
  version: 1,
  rev: 7,
  x_external: "keep-me",
  plans: [
    plan(A, "Alpha", [task(1, { x_task: "keep-task" }), task(2, { status: "doing" })], {
      x_plan: 1,
    }),
    plan(B, "Beta", [task(9)]),
  ],
});
const disk = () => JSON.parse(readFileSync(plansPath(statusDir), "utf8"));
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
  root = mkdtempSync(join(tmpdir(), "copilot-plan-"));
  process.env = { PATH: originalEnv.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "config") };
  vi.stubGlobal("fetch", () => {
    throw new Error("unexpected external fetch");
  });
  statusDir = join(root, "status");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(statusDir, { recursive: true });
  writeFileSync(plansPath(statusDir), JSON.stringify(seed(), null, 2));
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
  host = new CopilotHost(join(root, "data"), settings, () => {});
  app = createApp({
    paths: libraryPaths(join(root, "data")),
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

function page(selected: string, revision = 1, viewId: string = randomUUID()): PageContext {
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
async function run(context: PageContext, text = "Do the plan work") {
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
  await vi.waitFor(
    async () => {
      expect((await host.snapshot(id)).conversation.run?.status).not.toBe("running");
    },
    { timeout: 8000 }
  );
  return { id, snapshot: await host.snapshot(id) };
}

test("the plan tool is the only active tool and an agent edit goes to the named plan while the user moves to another page", async () => {
  const context = page(A);
  script = [
    () => ({ call: { action: "read" } }),
    (ctx) => {
      // The user switched to plan B after the task started.
      void request(`/views/${context.viewId}`, "PUT", { ...page(B, 2, context.viewId) });
      return {
        call: {
          action: "update_task",
          expectedRev: lastResult(ctx).rev,
          planId: A,
          taskId: "t_00000001",
          status: "done",
          note: "Agent note $x_1$",
        },
      };
    },
    () => ({
      call: {
        action: "update_task",
        expectedRev: 8,
        planId: A,
        taskId: "t_00000002",
        title: "Second renamed",
      },
    }),
    (ctx) => ({ text: `Edited, rev ${lastResult(ctx).rev}` }),
  ];
  const { snapshot } = await run(context);
  expect(snapshot.conversation.run?.status).toBe("completed");
  expect(getCurrentTools(seen[0]?.messages ?? []).map((tool) => tool.name)).toEqual([
    "plan",
    "workspace",
    "library",
    "reader",
    "writer",
  ]);
  // The model was told about the page change but its edits kept the original target.
  expect(JSON.stringify(seen[2]?.messages)).toMatch(
    /taskContextId.*"selectedPlanId\\":\\"p_0000000b/
  );
  const file = disk();
  expect(file.rev).toBe(9);
  expect(file.plans[0].tasks[0]).toMatchObject({
    status: "done",
    note: "Agent note $x_1$",
    x_task: "keep-task",
  });
  expect(file.plans[0].tasks[1].title).toBe("Second renamed");
  expect(file.plans[0].x_plan).toBe(1);
  expect(file.x_external).toBe("keep-me");
  expect(file.plans[1]).toEqual(seed().plans[1]);
  // Same notification as the UI PUT; a background edit sends no navigation.
  expect(broadcasts.filter((m) => m.type === "plan.changed")).toHaveLength(2);
  expect(broadcasts.some((m) => m.type === "copilot.view-action")).toBe(false);
  // The old message still points at plan A.
  const user = snapshot.messages[0];
  expect(user?.context?.objects.map((o) => o.id)).toEqual([A]);
  const operations = snapshot.messages.flatMap((m) => m.operations ?? []);
  expect(operations.map((o) => `${o.action}:${o.status}`)).toEqual([
    "read:ok",
    "update_task:ok",
    "update_task:ok",
  ]);
  expect(operations[1]).toMatchObject({
    object: { kind: "task", id: "t_00000001", planId: A },
    rev: 8,
  });
});

test("a user save between read and write makes the agent write stale: rejected in the lock, reread, then merged without losing the user's field", async () => {
  const context = page(A);
  const userEdit = async () => {
    const current = disk() as PlansFile;
    const edited = structuredClone(current) as PlansFile;
    const target = edited.plans[0]?.tasks[1];
    if (target) target.title = "User retitled";
    const res = await app.request("/api/plans", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(edited),
    });
    expect(res.status).toBe(200);
  };
  script = [
    () => ({ call: { action: "read" } }),
    async (ctx) => {
      const rev = lastResult(ctx).rev;
      await userEdit();
      return {
        call: {
          action: "update_task",
          expectedRev: rev,
          planId: A,
          taskId: "t_00000001",
          status: "blocked",
        },
      };
    },
    (ctx) => {
      expect(lastResult(ctx)).toMatchObject({ ok: false, status: "conflict", currentRev: 8 });
      return { call: { action: "read", planId: A } };
    },
    (ctx) => ({
      call: {
        action: "update_task",
        expectedRev: lastResult(ctx).rev,
        planId: A,
        taskId: "t_00000001",
        status: "blocked",
      },
    }),
    () => ({ text: "Applied after rereading" }),
  ] as Step[];
  const { snapshot } = await run(context);
  expect(snapshot.conversation.run?.status).toBe("completed");
  const file = disk();
  expect(file.rev).toBe(9);
  expect(file.plans[0].tasks[1].title).toBe("User retitled");
  expect(file.plans[0].tasks[0]).toMatchObject({ status: "blocked" }); // the UI whole-document PUT itself strips unknown keys (accepted I010)
  expect(
    snapshot.messages.flatMap((m) => m.operations ?? []).map((o) => `${o.action}:${o.status}`)
  ).toEqual(["read:ok", "update_task:conflict", "read:ok", "update_task:ok"]);
});

test("unknown actions, extra fields, cross-plan moves and delete write nothing and never fall back to file tools", async () => {
  const before = readFileSync(plansPath(statusDir), "utf8");
  script = [
    () => ({ call: { action: "delete_task", planId: A, taskId: "t_00000001" } }),
    () => ({
      call: {
        action: "move_task",
        expectedRev: 7,
        planId: A,
        taskId: "t_00000001",
        layout: "board",
        status: "done",
        toPlanId: B,
      },
    }),
    () => ({
      call: {
        action: "update_task",
        expectedRev: 7,
        planId: A,
        taskId: "t_00000001",
        due: "next week",
      },
    }),
    () => ({
      call: {
        action: "move_task",
        expectedRev: 7,
        planId: A,
        taskId: "t_00000001",
        layout: "list",
        overTaskId: "t_00000002",
      },
    }),
    () => ({ text: "Could not do those" }),
  ];
  const { snapshot } = await run(page(A));
  expect(readFileSync(plansPath(statusDir), "utf8")).toBe(before);
  expect(broadcasts.some((m) => m.type === "plan.changed")).toBe(false);
  const statuses = snapshot.messages
    .flatMap((m) => m.operations ?? [])
    .map((o) => `${o.action}:${o.status}`);
  expect(statuses).toHaveLength(4);
  expect(statuses[3]).toBe("move_task:rejected");
  expect(statuses.slice(0, 3).every((s) => /:(error|unsupported)$/.test(s))).toBe(true);
  expect(getCurrentTools(seen[0]?.messages ?? []).map((tool) => tool.name)).toEqual([
    "plan",
    "workspace",
    "library",
    "reader",
    "writer",
  ]);
});

test("view actions go only to the run's bound view and report what the browser really did", async () => {
  const context = page(A);
  const other = page(A, 1, randomUUID());
  const delivered: { viewId: string; actionId: string; action: unknown }[] = [];
  host.useViewDelivery((viewId, message) => {
    if (viewId !== context.viewId) return false;
    delivered.push({ viewId, actionId: message.actionId, action: message.action });
    setTimeout(async () => {
      // a different view cannot answer on this view's behalf
      const stolen = await request(`/views/${other.viewId}/action-results`, "POST", {
        actionId: message.actionId,
        ok: true,
      });
      expect(stolen.status).toBe(404);
      const answered = await request(`/views/${viewId}/action-results`, "POST", {
        actionId: message.actionId,
        ok: (message.action as { action: string }).action !== "open_task",
        ...((message.action as { action: string }).action === "open_task"
          ? { detail: "not_found" }
          : {}),
      });
      expect(answered.status).toBe(200);
    }, 5);
    return true;
  });
  script = [
    () => ({ call: { action: "show", view: "board", planId: B } }),
    () => ({ call: { action: "open_task", taskId: "t_ffffffff" } }),
    () => ({ call: { action: "show", view: "timeline", planId: "p_00000000" } }),
    () => ({ text: "navigated" }),
  ];
  await request(`/views/${other.viewId}`, "PUT", other);
  const { snapshot } = await run(context);
  expect(delivered.map((d) => d.action)).toEqual([
    { action: "show", view: "board", planId: B },
    { action: "open_task", taskId: "t_ffffffff" },
  ]);
  expect(
    snapshot.messages.flatMap((m) => m.operations ?? []).map((o) => `${o.action}:${o.status}`)
  ).toEqual(["show:ok", "open_task:not_found", "show:not_found"]);
});

test("without a connected browser a view action is reported as not displayed, never as done", async () => {
  script = [() => ({ call: { action: "show", view: "focus" } }), () => ({ text: "tried" })];
  const { snapshot } = await run(page(A));
  expect(
    snapshot.messages.flatMap((m) => m.operations ?? []).map((o) => `${o.action}:${o.status}`)
  ).toEqual(["show:not_displayed"]);
});

test("a view that never answers times out as not displayed", async () => {
  host.useWorkbench({
    plans: (host as unknown as { workbench: { plans: never } }).workbench.plans,
    viewActionTimeoutMs: 50,
  });
  host.useViewDelivery(() => true);
  script = [
    () => ({ call: { action: "open_task", taskId: "t_00000001" } }),
    () => ({ text: "tried" }),
  ];
  const { snapshot } = await run(page(A));
  expect(
    snapshot.messages.flatMap((m) => m.operations ?? []).map((o) => `${o.action}:${o.status}`)
  ).toEqual(["open_task:not_displayed"]);
});

test("task links accept only the main Doc the UI offers, through the real app wiring", async () => {
  // aa53302-24 is the main Doc of its Work; arxiv-2501.17225 is a secondary Doc of the same Work.
  app = createApp({
    paths: libraryPaths(makeDataDir()),
    statusDir,
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(root, "jobs2") }),
    providerSettings: settings,
    copilot: host,
    broadcast: (message) => broadcasts.push(message),
  });
  const link = (docId: string, rev: number) => ({
    call: { action: "add_task_link", expectedRev: rev, planId: A, taskId: "t_00000001", docId },
  });
  script = [
    () => link("arxiv-2501.17225", 7),
    () => link("no-such-doc", 7),
    () => link("aa53302-24", 7),
    () => ({ text: "done" }),
  ];
  const { snapshot } = await run(page(A));
  expect(snapshot.messages.flatMap((m) => m.operations ?? []).map((o) => o.status)).toEqual([
    "rejected",
    "rejected",
    "ok",
  ]);
  expect(disk().plans[0].tasks[0].links).toEqual([{ doc_id: "aa53302-24" }]);
});
