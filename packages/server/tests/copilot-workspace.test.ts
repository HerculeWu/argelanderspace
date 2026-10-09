/**
 * Workspace navigation and bound-view control (copilot ticket 12), end to end: real Pi session, real HTTP
 * routes, real `/ws` sockets standing in for browser tabs (they answer through the real action-results
 * route). Only the model provider is scripted.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "../src/app.js";
import { CopilotHost } from "../src/copilot.js";
import { viewOutcomeResult } from "../src/copilot-workspace-tool.js";
import { JobRunner } from "../src/jobs.js";
import { ProviderSettings } from "../src/providers.js";
import { WsHub } from "../src/ws.js";
import { stubPipelines, stubSources } from "./helpers.js";

type Out = { text?: string; call?: Record<string, unknown>; tool?: string };
type Step = (context: TranscriptContext) => Out | Promise<Out>;
let root: string;
let statusDir: string;
let host: CopilotHost;
let app: ReturnType<typeof createApp>;
let settings: ProviderSettings;
let originalEnv: NodeJS.ProcessEnv;
let script: Step[];
let seen: TranscriptContext[];
let modelsSeen: string[];
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
  modelsSeen = [];
  broadcasts = [];
  settings = new ProviderSettings();
  await settings.credential("openai", "SYNTHETIC_COPILOT_KEY");
  (await settings.getRuntime()).registerProvider("openai", {
    api: "openai-responses",
    streamSimple(model: Model<Api>, context: TranscriptContext) {
      seen.push(structuredClone(context));
      modelsSeen.push(model.id);
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
                  name: out.tool ?? "plan",
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

// ---- fake browser tabs over the real /ws hub ----------------------------------------------------- //

let server: Server | undefined;
let hub: WsHub | undefined;
const tabs: Tab[] = [];

interface Tab {
  viewId: string;
  ws: WebSocket;
  actions: { actionId: string; action: Record<string, unknown> }[];
  answer: (action: Record<string, unknown>) => { ok: boolean; detail?: string } | null;
  close: () => void;
}

async function startHub(options: { reconnectWaitMs?: number; actionTimeoutMs?: number } = {}) {
  server = createServer();
  hub = new WsHub(server, {
    heartbeatMs: 0,
    onViewSubscribed: (viewId) => host.viewConnected(viewId),
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  host.useViewDelivery((viewId, message) => hub?.sendToView(viewId, message) ?? false);
  host.useWorkbench({
    plans: (host as unknown as { workbench: { plans: never } }).workbench.plans,
    viewActionTimeoutMs: options.actionTimeoutMs ?? 2000,
    viewReconnectWaitMs: options.reconnectWaitMs ?? 3000,
  });
  return (server.address() as AddressInfo).port;
}

/** A browser tab: registers its view id for the conversation and reports each action through the real route. */
async function openTab(
  port: number,
  viewId: string,
  conversationId: string,
  answer: Tab["answer"] = () => ({ ok: true })
): Promise<Tab> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const tab: Tab = { viewId, ws, actions: [], answer, close: () => ws.close() };
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.type !== "copilot.view-action") return;
    tab.actions.push({ actionId: message.actionId, action: message.action });
    const result = tab.answer(message.action);
    if (!result) return;
    void request(`/views/${viewId}/action-results`, "POST", {
      actionId: message.actionId,
      ...result,
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
  tabs.push(tab);
  return tab;
}

afterEach(async () => {
  for (const tab of tabs.splice(0)) tab.ws.terminate();
  hub?.close();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  hub = undefined;
  server = undefined;
});

const withWorkspace = (context: PageContext, panes = 2): PageContext => ({
  ...context,
  workspace: {
    maxPanes: 3,
    activePaneId: 1,
    panes: Array.from({ length: panes }, (_, i) => ({
      paneId: i + 1,
      view: i ? "library" : "plan",
      share: 1 / panes,
    })),
    appearance: { theme: "dark", accent: "azure", density: "regular", language: "zh-CN" },
    copilotOpen: true,
  },
});
async function create() {
  const created = (await (
    await request("/conversations", "POST", { model: choice })
  ).json()) as ConversationSnapshot;
  return created.conversation.id;
}
async function send(
  id: string,
  context: PageContext,
  text = "Arrange my workspace",
  clientMessageId: string = randomUUID()
) {
  return request(`/conversations/${id}/messages`, "POST", {
    clientMessageId,
    text,
    viewId: context.viewId,
    contextRevision: context.revision,
  });
}
const settled = (id: string) =>
  vi.waitFor(
    async () => {
      expect((await host.snapshot(id)).conversation.run?.status).not.toBe("running");
    },
    { timeout: 8000 }
  );
const operations = (snapshot: ConversationSnapshot) =>
  snapshot.messages.flatMap((m) => m.operations ?? []);
const gateOf = () => {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait };
};

test("explicit shell actions reach only the tab the run is bound to, as that tab's own report, and background reads and writes never move any tab", async () => {
  const port = await startHub();
  const id = await create();
  const a = withWorkspace(page(A));
  const b = withWorkspace(page(B, 1));
  const tabA = await openTab(port, a.viewId, id, (action) =>
    action.action === "resize_pane" ? { ok: false, detail: "disabled" } : { ok: true }
  );
  const tabB = await openTab(port, b.viewId, id);
  expect((await request(`/views/${a.viewId}`, "PUT", a)).status).toBe(200);
  expect((await request(`/views/${b.viewId}`, "PUT", b)).status).toBe(200);
  script = [
    () => ({ call: { action: "read" } }),
    (ctx) => ({
      call: {
        action: "update_task",
        expectedRev: lastResult(ctx).rev,
        planId: A,
        taskId: "t_00000001",
        status: "doing",
      },
    }),
    () => ({ tool: "workspace", call: { action: "switch_view", view: "library" } }),
    () => ({ tool: "workspace", call: { action: "split_pane" } }),
    () => ({ tool: "workspace", call: { action: "resize_pane", paneId: 1, share: 0.5 } }),
    () => ({
      tool: "workspace",
      call: { action: "set_appearance", theme: "light", density: "compact" },
    }),
    () => ({ text: "arranged" }),
  ];
  expect((await send(id, a)).status).toBe(202);
  await settled(id);
  const snapshot = await host.snapshot(id);
  expect(tabA.actions.map((entry) => entry.action)).toEqual([
    { action: "switch_view", view: "library" },
    { action: "split_pane" },
    { action: "resize_pane", paneId: 1, share: 0.5 },
    { action: "set_appearance", theme: "light", density: "compact" },
  ]);
  // The other tab gets nothing: not a navigation, not an appearance change.
  expect(tabB.actions).toEqual([]);
  expect(operations(snapshot).map((o) => `${o.tool}.${o.action}:${o.status}`)).toEqual([
    "plan.read:ok",
    "plan.update_task:ok",
    "workspace.switch_view:ok",
    "workspace.split_pane:ok",
    "workspace.resize_pane:rejected",
    "workspace.set_appearance:ok",
  ]);
  // The refused control is explained to the model, not reported as done.
  expect(JSON.stringify(seen.at(-1)?.messages)).toContain("disabled");
  expect(disk().plans[0].tasks[0].status).toBe("doing");
  // A secret never travels: the synthetic key is nowhere in what the model saw.
  expect(JSON.stringify(seen)).not.toContain("SYNTHETIC_COPILOT_KEY");
});

test("an action's result is accepted only from the view it was addressed to", async () => {
  const port = await startHub();
  const id = await create();
  const a = withWorkspace(page(A));
  const b = withWorkspace(page(B, 1));
  const tabA = await openTab(port, a.viewId, id, null as never);
  tabA.answer = () => null; // answers by hand below
  await openTab(port, b.viewId, id);
  await request(`/views/${a.viewId}`, "PUT", a);
  await request(`/views/${b.viewId}`, "PUT", b);
  script = [
    () => ({ tool: "workspace", call: { action: "select_pane", paneId: 2 } }),
    () => ({ text: "done" }),
  ];
  expect((await send(id, a)).status).toBe(202);
  await vi.waitFor(() => expect(tabA.actions).toHaveLength(1));
  const actionId = tabA.actions[0]?.actionId ?? "";
  const stolen = (
    await request(`/views/${b.viewId}/action-results`, "POST", { actionId, ok: true })
  ).status;
  expect(stolen).toBe(404);
  expect((await host.snapshot(id)).conversation.run?.status).toBe("running"); // still waiting for the real tab
  expect(
    (await request(`/views/${a.viewId}/action-results`, "POST", { actionId, ok: true })).status
  ).toBe(200);
  await settled(id);
  expect(operations(await host.snapshot(id)).map((o) => `${o.action}:${o.status}`)).toEqual([
    "select_pane:ok",
  ]);
  // A repeated report for the same action has nothing left to settle.
  expect(
    (await request(`/views/${a.viewId}/action-results`, "POST", { actionId, ok: true })).status
  ).toBe(404);
});

test("a message from the second tab becomes the run's navigation target; only that tab is then navigated", async () => {
  const port = await startHub();
  const id = await create();
  const a = withWorkspace(page(A));
  const b = withWorkspace(page(B, 1));
  const tabA = await openTab(port, a.viewId, id);
  const tabB = await openTab(port, b.viewId, id);
  await request(`/views/${a.viewId}`, "PUT", a);
  await request(`/views/${b.viewId}`, "PUT", b);
  const hold = gateOf();
  script = [
    () => ({ tool: "workspace", call: { action: "switch_view", view: "library" } }),
    async () => {
      await hold.wait;
      return { tool: "workspace", call: { action: "switch_view", view: "write" } };
    },
    () => ({ text: "done" }),
  ];
  expect((await send(id, a)).status).toBe(202);
  await vi.waitFor(() => expect(seen.length).toBe(2));
  expect((await send(id, b, "Also from the other tab")).status).toBe(202); // steering from tab B
  hold.open();
  await settled(id);
  expect(tabA.actions.map((e) => e.action)).toEqual([{ action: "switch_view", view: "library" }]);
  expect(tabB.actions.map((e) => e.action)).toEqual([{ action: "switch_view", view: "write" }]);
});

test("an offline view waits for its tab to come back and is shown then; the answer comes only from the tab's own report", async () => {
  const port = await startHub({ reconnectWaitMs: 4000 });
  const id = await create();
  const a = withWorkspace(page(A));
  const first = await openTab(port, a.viewId, id);
  await request(`/views/${a.viewId}`, "PUT", a);
  const hold = gateOf();
  script = [
    async () => {
      await hold.wait;
      return { tool: "workspace", call: { action: "switch_view", view: "doc" } };
    },
    (ctx) => ({ text: `result ${JSON.stringify(lastResult(ctx))}` }),
  ];
  expect((await send(id, a)).status).toBe(202);
  await vi.waitFor(() => expect(seen.length).toBe(1));
  first.ws.terminate(); // F5 / a dropped connection
  await vi.waitFor(() => expect(hub?.clientCount).toBe(0));
  hold.open();
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect((await host.snapshot(id)).conversation.run?.status).toBe("running"); // waiting, not failed, not "done"
  // Nothing is claimed while it waits: a call still in flight in this run shows as pending, never as applied.
  expect(operations(await host.snapshot(id)).map((o) => o.status)).toEqual(["pending"]);
  const again = await openTab(port, a.viewId, id); // same stable view id, new socket
  await settled(id);
  expect(again.actions.map((e) => e.action)).toEqual([{ action: "switch_view", view: "doc" }]);
  expect(operations(await host.snapshot(id)).map((o) => `${o.action}:${o.status}`)).toEqual([
    "switch_view:ok",
  ]);
});

test("a view that never comes back is reported as not displayed with the reason, never as done", async () => {
  const port = await startHub({ reconnectWaitMs: 150 });
  const id = await create();
  const a = withWorkspace(page(A));
  const tab = await openTab(port, a.viewId, id);
  await request(`/views/${a.viewId}`, "PUT", a);
  tab.ws.terminate();
  await vi.waitFor(() => expect(hub?.clientCount).toBe(0));
  script = [
    () => ({ tool: "workspace", call: { action: "split_pane" } }),
    (ctx) => ({ text: `saw ${JSON.stringify(lastResult(ctx))}` }),
  ];
  expect((await send(id, a)).status).toBe(202);
  await settled(id);
  const snapshot = await host.snapshot(id);
  expect(operations(snapshot).map((o) => `${o.action}:${o.status}`)).toEqual([
    "split_pane:not_displayed",
  ]);
  expect(JSON.stringify(seen.at(-1)?.messages)).toContain("was not connected in time");
  expect(snapshot.messages.at(-1)?.text).not.toMatch(/"ok":true/);
});

test("a tab that is connected but never reports leaves the action not displayed", async () => {
  const port = await startHub({ actionTimeoutMs: 150 });
  const id = await create();
  const a = withWorkspace(page(A));
  const tab = await openTab(port, a.viewId, id, () => null);
  await request(`/views/${a.viewId}`, "PUT", a);
  script = [
    () => ({ tool: "workspace", call: { action: "select_pane", paneId: 1 } }),
    () => ({ text: "tried" }),
  ];
  expect((await send(id, a)).status).toBe(202);
  await settled(id);
  expect(tab.actions).toHaveLength(1);
  expect(operations(await host.snapshot(id)).map((o) => `${o.action}:${o.status}`)).toEqual([
    "select_pane:not_displayed",
  ]);
  expect(JSON.stringify(seen.at(-1)?.messages)).toContain("did not confirm");
});

test("Stop ends the wait for an offline view and nothing is shown afterwards", async () => {
  const port = await startHub({ reconnectWaitMs: 10_000 });
  const id = await create();
  const a = withWorkspace(page(A));
  const tab = await openTab(port, a.viewId, id);
  await request(`/views/${a.viewId}`, "PUT", a);
  tab.ws.terminate();
  await vi.waitFor(() => expect(hub?.clientCount).toBe(0));
  script = [
    () => ({ tool: "workspace", call: { action: "close_pane", paneId: 2 } }),
    () => ({ text: "should not be asked" }),
  ];
  expect((await send(id, a)).status).toBe(202);
  await vi.waitFor(() => expect(seen.length).toBe(1));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const stopped = await request(`/conversations/${id}/stop`, "POST");
  expect(stopped.status).toBe(200);
  await vi.waitFor(
    async () => {
      expect((await host.snapshot(id)).conversation.run?.status).toBe("stopped");
    },
    { timeout: 5000 }
  );
  const late = await openTab(port, a.viewId, id); // the tab comes back after Stop
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(late.actions).toEqual([]);
});

test("the reasons a tab gives are kept apart: blocked by unsaved work, missing, disabled", async () => {
  const port = await startHub();
  const id = await create();
  const a = withWorkspace(page(A));
  const reasons: Record<string, { ok: boolean; detail?: string }> = {
    switch_view: { ok: false, detail: "leave_blocked" },
    select_pane: { ok: false, detail: "not_found" },
    close_pane: { ok: false, detail: "disabled" },
  };
  await openTab(port, a.viewId, id, (action) => reasons[String(action.action)] ?? { ok: true });
  await request(`/views/${a.viewId}`, "PUT", a);
  script = [
    () => ({ tool: "workspace", call: { action: "switch_view", view: "plan" } }),
    () => ({ tool: "workspace", call: { action: "select_pane", paneId: 9 } }),
    () => ({ tool: "workspace", call: { action: "close_pane", paneId: 1 } }),
    () => ({ text: "none of that worked" }),
  ];
  expect((await send(id, a)).status).toBe(202);
  await settled(id);
  expect(operations(await host.snapshot(id)).map((o) => `${o.action}:${o.status}`)).toEqual([
    "switch_view:not_displayed",
    "select_pane:not_found",
    "close_pane:rejected",
  ]);
  const transcript = JSON.stringify(seen.at(-1)?.messages);
  expect(transcript).toContain("unsaved work");
});

test("capabilities tell the model the bound view's layout, why a control is disabled, and what the platform withholds", async () => {
  const port = await startHub();
  const id = await create();
  const full = withWorkspace(page(A), 3);
  await openTab(port, full.viewId, id);
  await request(`/views/${full.viewId}`, "PUT", full);
  let payload = {} as {
    ok?: boolean;
    workspace: { panes: unknown[] };
    actions: { action: string; available: boolean; reason?: string }[];
    views: { available: string[]; unavailable: unknown[] };
    platform: { capability: string; agent: string }[];
  };
  script = [
    () => ({ tool: "workspace", call: { action: "capabilities" } }),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "read" };
    },
  ];
  expect((await send(id, full)).status).toBe(202);
  await settled(id);
  expect(payload.ok).toBe(true);
  expect(payload.workspace.panes).toHaveLength(3);
  const split = payload.actions.find((entry: { action: string }) => entry.action === "split_pane");
  expect(split).toMatchObject({ available: false, reason: "pane_limit" });
  expect(
    payload.actions.find((entry: { action: string }) => entry.action === "close_pane")
  ).toMatchObject({ available: true });
  expect(payload.views.available).toEqual(["plan", "library", "doc", "write", "mail"]);
  expect(Object.keys(payload.views)).toEqual(["available"]);
  expect(
    payload.platform.map(
      (entry: { capability: string; agent: string }) => `${entry.capability}:${entry.agent}`
    )
  ).toEqual([
    "clipboard:user_only",
    "download:limited",
    "file_picker:user_only",
    "external_link:user_only",
    "local_path:never",
  ]);
  // No credential field of any kind is part of the capability description.
  expect(JSON.stringify(payload)).not.toMatch(/key|token|secret|password/i);
  expect(operations(await host.snapshot(id)).map((o) => `${o.action}:${o.status}`)).toEqual([
    "capabilities:ok",
  ]);
});

test("unknown views, local paths, urls, selectors and other platform operations are refused before any tab hears of them", async () => {
  const port = await startHub();
  const id = await create();
  const a = withWorkspace(page(A));
  const tab = await openTab(port, a.viewId, id);
  await request(`/views/${a.viewId}`, "PUT", a);
  script = [
    () => ({ tool: "workspace", call: { action: "switch_view", view: "ext" } }),
    () => ({ tool: "workspace", call: { action: "download", path: "/etc/passwd" } }),
    () => ({ tool: "workspace", call: { action: "switch_view", view: "plan", selector: "#nav" } }),
    () => ({ tool: "workspace", call: { action: "open_link", url: "https://example.org" } }),
    () => ({ tool: "workspace", call: { action: "set_appearance" } }),
    () => ({ tool: "workspace", call: { action: "resize_pane", paneId: 1, share: 0.99 } }),
    () => ({ text: "refused" }),
  ];
  expect((await send(id, a)).status).toBe(202);
  await settled(id);
  expect(tab.actions).toEqual([]);
  const statuses = operations(await host.snapshot(id)).map((o) => o.status);
  // The provider schema already refuses what it cannot express (error); the shared zod union refuses the rest.
  expect(statuses).toEqual(["error", "error", "error", "error", "unsupported", "unsupported"]);
});

test("task documents and the completed-group fold are agent actions on the Plan page, checked against the task's real links", async () => {
  const withLink = seed();
  const alpha = withLink.plans[0];
  if (!alpha) throw new Error("fixture");
  alpha.tasks[1] = task(2, { status: "doing", links: [{ doc_id: "aa53302-24" }] });
  writeFileSync(plansPath(statusDir), JSON.stringify(withLink, null, 2));
  const port = await startHub();
  const id = await create();
  const a = withWorkspace(page(A));
  const tab = await openTab(port, a.viewId, id);
  await request(`/views/${a.viewId}`, "PUT", a);
  script = [
    () => ({ call: { action: "open_task_doc", taskId: "t_00000001", docId: "aa53302-24" } }), // not linked to this task
    () => ({ call: { action: "open_task_doc", taskId: "t_00000002", docId: "aa53302-24" } }),
    () => ({ call: { action: "set_completed", expanded: true } }),
    () => ({ text: "ok" }),
  ];
  expect((await send(id, a)).status).toBe(202);
  await settled(id);
  expect(tab.actions.map((e) => e.action)).toEqual([
    { action: "open_task_doc", taskId: "t_00000002", docId: "aa53302-24" },
    { action: "set_completed", expanded: true },
  ]);
  expect(operations(await host.snapshot(id)).map((o) => `${o.action}:${o.status}`)).toEqual([
    "open_task_doc:not_found",
    "open_task_doc:ok",
    "set_completed:ok",
  ]);
});

test("the Plan page's load-failure Retry (retry_plans, ticket 32) is delivered to the bound view and reported as the page answered", async () => {
  const port = await startHub();
  const id = await create();
  const a = withWorkspace(page(A));
  const tab = await openTab(port, a.viewId, id);
  await request(`/views/${a.viewId}`, "PUT", a);
  script = [
    () => ({ call: { action: "retry_plans" } }),
    () => ({ call: { action: "retry_plans", planId: "p_0000000a" } }), // the control has no argument
    () => ({ text: "ok" }),
  ];
  expect((await send(id, a)).status).toBe(202);
  await settled(id);
  expect(tab.actions.map((e) => e.action)).toEqual([{ action: "retry_plans" }]);
  expect(operations(await host.snapshot(id)).map((o) => `${o.action}:${o.status}`)).toEqual([
    "retry_plans:ok",
    "retry_plans:unsupported",
  ]);
});

test("a failed or disabled Plan retry is told honestly, never as an exploration or a capabilities lookup (ticket 32 S2/N1)", async () => {
  const port = await startHub();
  const id = await create();
  const a = withWorkspace(page(A));
  const answers = [
    { ok: false, detail: "failed" },
    { ok: false, detail: "disabled" },
  ];
  await openTab(port, a.viewId, id, () => answers.shift() ?? { ok: true });
  await request(`/views/${a.viewId}`, "PUT", a);
  const seenResults: string[] = [];
  script = [
    () => ({ call: { action: "retry_plans" } }),
    (ctx) => {
      seenResults.push(JSON.stringify(lastResult(ctx)));
      return { call: { action: "retry_plans" } };
    },
    (ctx) => {
      seenResults.push(JSON.stringify(lastResult(ctx)));
      return { text: "done" };
    },
  ];
  expect((await send(id, a)).status).toBe(202);
  await settled(id);
  const [failed, disabled] = seenResults;
  expect(failed).toContain('"status":"error"');
  expect(failed).toContain("the user's page still shows its error");
  expect(failed).not.toMatch(/exploration|read_discovery|retry_exploration/);
  expect(disabled).toContain("rejected");
  expect(disabled).toContain("no enabled control");
  expect(disabled).not.toContain("capabilities");
});

test("the failure text depends on the action: Writer's retry_manuscript_list is not told as an exploration, Discovery's keeps its own", () => {
  const failed = { status: "failed", http: 500 } as const;
  const writer = JSON.stringify(viewOutcomeResult(failed, "retry_manuscript_list").payload);
  expect(writer).toContain("HTTP 500");
  expect(writer).not.toMatch(/exploration|read_discovery/);
  expect(JSON.stringify(viewOutcomeResult(failed, "retry_exploration").payload)).toContain(
    "the exploration request failed"
  );
});

test("provider status is read-only and redacted: usable providers and model capabilities, never a key, endpoint or sign-in code", async () => {
  const port = await startHub();
  const id = await create();
  const a = withWorkspace(page(A));
  await openTab(port, a.viewId, id);
  await request(`/views/${a.viewId}`, "PUT", a);
  let payload = {} as {
    ok?: boolean;
    current?: unknown;
    providers: {
      id: string;
      configured: boolean;
      source: string;
      models: { id: string; thinkingLevels: string[]; contextWindow: number }[];
      login?: unknown;
    }[];
  };
  script = [
    () => ({ tool: "workspace", call: { action: "provider_status" } }),
    (ctx) => {
      payload = lastResult(ctx);
      return { text: "read" };
    },
  ];
  expect((await send(id, a)).status).toBe(202);
  await settled(id);
  const openai = payload.providers.find((provider) => provider.id === "openai");
  expect(openai).toMatchObject({ configured: true, source: "stored" });
  expect(openai?.models.find((model) => model.id === "gpt-4.1")?.contextWindow).toBeGreaterThan(0);
  // A provider without credentials is listed by name only.
  expect(payload.providers.find((provider) => !provider.configured)?.models).toEqual([]);
  const text = JSON.stringify(payload);
  expect(text).not.toContain("SYNTHETIC_COPILOT_KEY");
  const leak =
    /baseUrl|https?:\/\/|notices|userCode|verificationUri|"key"|"token"|apiKey|secret|password/i.exec(
      text
    );
  expect(leak?.[0]).toBeUndefined();
  expect(operations(await host.snapshot(id)).map((o) => `${o.action}:${o.status}`)).toEqual([
    "provider_status:ok",
  ]);
});

test("select_model goes through the conversation model rules: valid choices apply from the next request, invalid ones change nothing", async () => {
  const port = await startHub();
  const id = await create();
  const a = withWorkspace(page(A));
  await openTab(port, a.viewId, id);
  await request(`/views/${a.viewId}`, "PUT", a);
  const before = (await host.snapshot(id)).conversation.model;
  script = [
    () => ({
      tool: "workspace",
      call: { action: "select_model", provider: "openai", model: "no-such-model" },
    }),
    () => ({
      tool: "workspace",
      call: { action: "select_model", provider: "openai", model: "gpt-4.1", thinking: "xhigh" },
    }),
    () => ({
      tool: "workspace",
      call: { action: "select_model", provider: "openai", model: "gpt-4o", thinking: "default" },
    }),
    () => ({ text: "switched" }),
  ];
  expect((await send(id, a)).status).toBe(202);
  await settled(id);
  const snapshot = await host.snapshot(id);
  expect(operations(snapshot).map((o) => `${o.action}:${o.status}`)).toEqual([
    "select_model:rejected",
    "select_model:rejected",
    "select_model:ok",
  ]);
  expect(before).toEqual(choice);
  expect(snapshot.conversation.model).toEqual({
    provider: "openai",
    model: "gpt-4o",
    thinking: null,
  });
  // The request in flight kept its model; the next one uses the new choice.
  expect(modelsSeen).toEqual(["gpt-4.1", "gpt-4.1", "gpt-4.1", "gpt-4o"]);
});

test("a thinking level is applied only if the model offers it", async () => {
  const port = await startHub();
  const id = await create();
  const a = withWorkspace(page(A));
  await openTab(port, a.viewId, id);
  await request(`/views/${a.viewId}`, "PUT", a);
  const models = (await (await app.request("/api/copilot/providers")).json()) as {
    providers: { id: string; models: { id: string; thinkingLevels: string[] }[] }[];
  };
  const reasoning = models.providers
    .find((p) => p.id === "openai")
    ?.models.find((m) => m.thinkingLevels.includes("high"));
  expect(reasoning).toBeDefined();
  script = [
    () => ({
      tool: "workspace",
      call: { action: "select_model", provider: "openai", model: reasoning?.id, thinking: "high" },
    }),
    () => ({ text: "ok" }),
  ];
  expect((await send(id, a)).status).toBe(202);
  await settled(id);
  expect((await host.snapshot(id)).conversation.model).toEqual({
    provider: "openai",
    model: reasoning?.id,
    thinking: "high",
  });
});

test("the Copilot panel, a library Doc and the settings dialog are opened on the bound tab only", async () => {
  const port = await startHub();
  const id = await create();
  const a = withWorkspace(page(A));
  const b = withWorkspace(page(B, 1));
  const tabA = await openTab(port, a.viewId, id);
  const tabB = await openTab(port, b.viewId, id);
  await request(`/views/${a.viewId}`, "PUT", a);
  await request(`/views/${b.viewId}`, "PUT", b);
  script = [
    () => ({ tool: "workspace", call: { action: "close_copilot" } }),
    () => ({ tool: "workspace", call: { action: "open_copilot" } }),
    () => ({ tool: "workspace", call: { action: "open_doc", docId: "demo" } }),
    () => ({ text: "done" }),
  ];
  expect((await send(id, a)).status).toBe(202);
  await settled(id);
  expect(tabA.actions.map((e) => e.action)).toEqual([
    { action: "close_copilot" },
    { action: "open_copilot" },
    { action: "open_doc", docId: "demo" },
  ]);
  expect(tabB.actions).toEqual([]);
});

test("a withdrawn action says it was stopped, not that the browser was offline", async () => {
  await startHub();
  const a = withWorkspace(page(A));
  await request(`/views/${a.viewId}`, "PUT", a); // published, but no socket is connected for it
  const pending = host.dispatchViewAction(a.viewId, { action: "split_pane" }, "run-1");
  await new Promise((resolve) => setTimeout(resolve, 50));
  (host as unknown as { cancelViewActions: (runId: string) => void }).cancelViewActions("run-1");
  expect(await pending).toEqual({ status: "not_displayed", detail: "stopped" });
  const later = host.dispatchViewAction(a.viewId, { action: "split_pane" }, "run-2");
  await new Promise((resolve) => setTimeout(resolve, 50));
  await host.close();
  expect(await later).toEqual({ status: "not_displayed", detail: "stopped" });
});
