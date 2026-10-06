/**
 * Live public run status and reasoning summary (copilot ticket 33 follow-up): the service derives what the run does
 * right now from the SDK's own events, streams it, and gives a reconnecting client the current status. Only the
 * model provider is scripted; Pi session, routes and the saved history are real.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationSnapshot, PageContext, WsCopilotEvent } from "@argelanderspace/contracts";
import { libraryPaths } from "@argelanderspace/core";
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import { CopilotHost } from "../src/copilot.js";
import { JobRunner } from "../src/jobs.js";
import { ProviderSettings } from "../src/providers.js";
import { stubPipelines, stubSources } from "./helpers.js";

type Part = AssistantMessage["content"][number];
type Step = (
  model: Model<Api>,
  push: (
    event: Parameters<ReturnType<typeof createAssistantMessageEventStream>["push"]>[0]
  ) => void,
  message: (content: Part[], stopReason?: "stop" | "toolUse") => AssistantMessage
) => Promise<void>;

let root: string,
  settings: ProviderSettings,
  host: CopilotHost,
  app: ReturnType<typeof createApp>,
  originalEnv: NodeJS.ProcessEnv;
let events: WsCopilotEvent[];
let script: Step[];
let gate: (() => void) | undefined;
const choice = { provider: "openai", model: "gpt-4.1", thinking: null };
const request = (path: string, method = "GET", body?: unknown) =>
  app.request(`/api/copilot${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const wait = () =>
  new Promise<void>((resolve) => {
    gate = resolve;
  });

beforeEach(async () => {
  originalEnv = process.env;
  root = mkdtempSync(join(tmpdir(), "copilot-live-"));
  process.env = { PATH: originalEnv.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "config") };
  vi.stubGlobal("fetch", () => {
    throw new Error("unexpected external fetch");
  });
  events = [];
  script = [];
  gate = undefined;
  settings = new ProviderSettings();
  await settings.credential("openai", "SYNTHETIC_COPILOT_KEY");
  let calls = 0;
  (await settings.getRuntime()).registerProvider("openai", {
    api: "openai-responses",
    streamSimple(model) {
      const step = script[calls++];
      const stream = createAssistantMessageEventStream();
      const message = (
        content: Part[],
        stopReason: "stop" | "toolUse" = "stop"
      ): AssistantMessage => ({
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      });
      void (
        step ??
        (async (_m, push, make) =>
          push({ type: "done", reason: "stop", message: make([{ type: "text", text: "end" }]) }))
      )(model, (event) => stream.push(event), message);
      return stream;
    },
  });
  host = new CopilotHost(join(root, "data"), settings, (event) => events.push(event));
  app = createApp({
    paths: libraryPaths(join(root, "data")),
    statusDir: join(root, "status"),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(root, "jobs") }),
    providerSettings: settings,
    copilot: host,
  });
});
afterEach(async () => {
  gate?.();
  await host.close();
  process.env = originalEnv;
  vi.unstubAllGlobals();
});

function page(): PageContext {
  return {
    version: 1,
    viewId: randomUUID(),
    paneId: 1,
    view: "plan",
    revision: 1,
    status: "complete",
    otherPanes: [],
    plan: {
      rev: 1,
      mode: "list",
      selectedPlanId: "p_00000001",
      saveState: "saved",
      groups: [],
      detail: null,
      plans: [],
    },
  };
}
async function start() {
  const created = (await (
    await request("/conversations", "POST", { model: choice })
  ).json()) as ConversationSnapshot;
  const context = page();
  expect((await request(`/views/${context.viewId}`, "PUT", context)).status).toBe(200);
  const sent = await request(`/conversations/${created.conversation.id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text: "Think about it",
    viewId: context.viewId,
    contextRevision: context.revision,
  });
  expect(sent.status).toBe(202);
  return created.conversation.id;
}
const settled = async (id: string) => {
  await vi.waitFor(async () =>
    expect((await host.snapshot(id)).conversation.run?.status).not.toBe("running")
  );
  return host.snapshot(id);
};
const streamed = () => events.filter((event) => event.kind === "stream");

test("reasoning summary streams as it arrives, a reconnecting client gets it, and the saved reply keeps it", async () => {
  script = [
    async (_model, push, make) => {
      push({ type: "start", partial: make([]) });
      push({
        type: "thinking_start",
        contentIndex: 0,
        partial: make([{ type: "thinking", thinking: "" }]),
      });
      push({
        type: "thinking_delta",
        contentIndex: 0,
        delta: "Weighing",
        partial: make([{ type: "thinking", thinking: "Weighing" }]),
      });
      push({
        type: "thinking_delta",
        contentIndex: 0,
        delta: " options",
        partial: make([{ type: "thinking", thinking: "Weighing options" }]),
      });
      await wait();
      push({
        type: "text_delta",
        contentIndex: 1,
        delta: "Answer",
        partial: make([
          { type: "thinking", thinking: "Weighing options" },
          { type: "text", text: "Answer" },
        ]),
      });
      push({
        type: "done",
        reason: "stop",
        message: make([
          { type: "thinking", thinking: "Weighing options" },
          { type: "text", text: "Answer" },
        ]),
      });
    },
  ];
  const id = await start();
  await vi.waitFor(() =>
    expect(streamed().at(-1)?.live).toMatchObject({
      phase: "thinking",
      thinking: "Weighing options",
    })
  );
  // Incremental: the earlier event carried the shorter text.
  expect(streamed().map((event) => event.live?.thinking)).toContain("Weighing");
  // Reconnect: the snapshot a new client fetches carries the current status, not an empty run.
  const reconnected = await host.snapshot(id);
  expect(reconnected.live).toMatchObject({ phase: "thinking", thinking: "Weighing options" });
  expect(reconnected.live?.elapsedMs).toBeGreaterThanOrEqual(0);
  gate?.();
  await vi.waitFor(() => expect(streamed().at(-1)?.live?.phase).not.toBe("thinking"));
  const done = await settled(id);
  expect(done.live).toBeNull();
  expect(streamed().some((event) => event.live?.phase === "writing")).toBe(true);
  const reply = done.messages.find((message) => message.role === "assistant");
  expect(reply).toMatchObject({ text: "Answer", thinking: "Weighing options" });
  // Reasoning is display only: no user-role content of the saved history carries it.
  const again = await host.snapshot(id);
  expect(
    again.messages.filter((message) => message.role === "user").every((m) => !("thinking" in m))
  ).toBe(true);
});

test("a provider that gives no reasoning text shows status only, never an invented thinking block", async () => {
  script = [
    async (_model, push, make) => {
      push({ type: "start", partial: make([]) });
      push({
        type: "text_delta",
        contentIndex: 0,
        delta: "Plain",
        partial: make([{ type: "text", text: "Plain" }]),
      });
      await wait();
      push({ type: "done", reason: "stop", message: make([{ type: "text", text: "Plain" }]) });
    },
  ];
  const id = await start();
  await vi.waitFor(() => expect(streamed().at(-1)?.live?.phase).toBe("writing"));
  expect((await host.snapshot(id)).live?.thinking).toBe("");
  gate?.();
  const done = await settled(id);
  expect(streamed().every((event) => !event.live?.thinking)).toBe(true);
  expect(done.messages.at(-1)).not.toHaveProperty("thinking");
});

test("an operation shows as the current status while its call is written and while it runs", async () => {
  const call = (args: Record<string, unknown>): Part => ({
    type: "toolCall",
    id: "call_1",
    name: "plan",
    arguments: args as never,
  });
  script = [
    async (_model, push, make) => {
      push({ type: "start", partial: make([]) });
      push({ type: "toolcall_start", contentIndex: 0, partial: make([call({})]) });
      push({
        type: "toolcall_delta",
        contentIndex: 0,
        delta: "{",
        partial: make([call({ action: "read" })]),
      });
      push({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: call({ action: "read" }) as never,
        partial: make([call({ action: "read" })]),
      });
      push({
        type: "done",
        reason: "toolUse",
        message: make([call({ action: "read" })], "toolUse"),
      });
    },
    async (_model, push, make) => {
      await wait();
      push({ type: "done", reason: "stop", message: make([{ type: "text", text: "ok" }]) });
    },
  ];
  const id = await start();
  await vi.waitFor(() =>
    expect(host.snapshot(id).then((snapshot) => snapshot.live)).resolves.toMatchObject({
      phase: "working",
    })
  );
  const operations = streamed().filter((event) => event.live?.phase === "operation");
  expect(operations.length).toBeGreaterThan(0);
  expect(operations.every((event) => event.live?.operation?.tool === "plan")).toBe(true);
  expect(operations.some((event) => event.live?.operation?.action === "read")).toBe(true);
  gate?.();
  expect((await settled(id)).live).toBeNull();
});
