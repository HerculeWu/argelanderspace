import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationSnapshot, PageContext } from "@argelanderspace/contracts";
import { libraryPaths } from "@argelanderspace/core";
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
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

const failure = vi.hoisted(() => ({ target: "" }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      if (to === failure.target) throw new Error("injected rename failure");
      return fs.renameSync(from, to);
    },
  };
});
let root: string,
  dataDir: string,
  settings: ProviderSettings,
  host: CopilotHost,
  app: ReturnType<typeof createApp>;
let originalEnv: NodeJS.ProcessEnv;
let requests: {
  model: string;
  at: number;
  context: TranscriptContext;
  options?: SimpleStreamOptions;
}[];
let streamOverride:
  | ((
      model: Model<Api>,
      context: TranscriptContext,
      options?: SimpleStreamOptions
    ) => ReturnType<typeof createAssistantMessageEventStream>)
  | undefined;
let release: (() => void) | undefined;
let delay = false;
let providerFailure = false;
const choice = { provider: "openai", model: "gpt-4.1", thinking: null };
const request = (path: string, method = "GET", body?: unknown) =>
  app.request(`/api/copilot${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const buildApp = () => {
  host = new CopilotHost(dataDir, settings, () => {});
  app = createApp({
    paths: libraryPaths(dataDir),
    statusDir: join(root, "status"),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(root, "jobs") }),
    providerSettings: settings,
    copilot: host,
  });
};
beforeEach(async () => {
  originalEnv = process.env;
  root = mkdtempSync(join(tmpdir(), "copilot-conversation-"));
  dataDir = join(root, "data");
  process.env = { PATH: originalEnv.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "config") };
  vi.stubGlobal("fetch", () => {
    throw new Error("unexpected external fetch");
  });
  failure.target = "";
  requests = [];
  delay = false;
  providerFailure = false;
  streamOverride = undefined;
  release = undefined;
  settings = new ProviderSettings();
  await settings.credential("openai", "SYNTHETIC_COPILOT_KEY");
  const runtime = await settings.getRuntime();
  runtime.registerProvider("openai", {
    api: "openai-responses",
    streamSimple(model, context, options) {
      requests.push({
        model: model.id,
        at: Date.now(),
        context: structuredClone(context),
        options,
      });
      if (streamOverride) return streamOverride(model, context, options);
      if (providerFailure)
        throw new Error("SYNTHETIC_COPILOT_KEY at https://key:secret@example.invalid");
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Complete Plan reply." }],
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
        stream.push({ type: "text_delta", contentIndex: 0, delta: "Complete", partial: message });
        if (delay)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        stream.push({ type: "done", reason: "stop", message });
      })();
      return stream;
    },
  });
  buildApp();
});
afterEach(async () => {
  release?.();
  await host.close();
  process.env = originalEnv;
  vi.unstubAllGlobals();
});
async function create() {
  const response = await request("/conversations", "POST", { model: choice });
  expect(response.status).toBe(201);
  return (await response.json()) as ConversationSnapshot;
}
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
      rev: 9,
      mode: "list",
      selectedPlanId: "p_00000001",
      saveState: "saved",
      groups: [],
      detail: null,
      plans: [
        {
          id: "p_00000001",
          name: "Plan A",
          due: "2026-12-01",
          icon: "target",
          created_at: "2026-10-02T00:00:00Z",
          tasks: Array.from({ length: 80 }, (_, index) => ({
            id: `t_${index.toString(16).padStart(8, "0")}`,
            title: index === 79 ? "END_SENTINEL_COMPLETE_CONTEXT" : `Task ${index}`,
            status: "todo",
            due: "2026-12-01",
            focused: false,
            links: [],
            created_at: "2026-10-02T00:00:00Z",
          })),
        },
      ],
    },
  };
}
async function send(id: string, context = page(), clientMessageId = randomUUID()) {
  expect((await request(`/views/${context.viewId}`, "PUT", context)).status).toBe(200);
  return request(`/conversations/${id}/messages`, "POST", {
    clientMessageId,
    text: "Read every task",
    viewId: context.viewId,
    contextRevision: context.revision,
  });
}
async function settled(id: string) {
  await vi.waitFor(async () => {
    const snapshot = await host.snapshot(id);
    expect(snapshot.conversation.run?.status).not.toBe("running");
  });
  return host.snapshot(id);
}
const historyPath = (snapshot: ConversationSnapshot) =>
  join(dataDir, "copilot/sessions", `${snapshot.conversation.sessionId}.jsonl`);

test("actual Pi HTTP loop supplies the final offscreen task, no tools/discovery, and reopens one native history", async () => {
  const snapshot = await create();
  mkdirSync(join(dataDir, "copilot/runtime/.pi/extensions"), { recursive: true });
  writeFileSync(join(dataDir, "copilot/runtime/AGENTS.md"), "HOSTILE_SENTINEL");
  writeFileSync(
    join(dataDir, "copilot/runtime/.pi/extensions/a.js"),
    'throw new Error("HOSTILE_EXTENSION")'
  );
  expect((await send(snapshot.conversation.id)).status).toBe(202);
  const done = await settled(snapshot.conversation.id);
  expect(done.conversation.run?.status).toBe("completed");
  expect(done.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  expect(JSON.stringify(requests[0]?.context)).toContain("END_SENTINEL_COMPLETE_CONTEXT");
  expect(JSON.stringify(requests[0]?.context)).not.toContain("HOSTILE_SENTINEL");
  const firstRequest = requests[0];
  if (!firstRequest) throw new Error("missing provider request");
  expect(getCurrentTools(firstRequest.context.messages)).toEqual([]);
  const bytes = readFileSync(historyPath(snapshot));
  expect(bytes.toString()).toContain("argelander.context.v1");
  const reference = bytes
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((entry) => entry.type === "custom");
  expect(JSON.stringify(reference)).not.toContain("END_SENTINEL_COMPLETE_CONTEXT");
  await host.close();
  buildApp();
  expect((await host.snapshot(snapshot.conversation.id)).messages).toEqual(done.messages);
  expect(readFileSync(historyPath(snapshot))).toEqual(bytes);
  expect(requests).toHaveLength(1);
});

test("cache-empty restart concurrent retry preserves clientMessageId and starts one run", async () => {
  const snapshot = await create();
  await host.close();
  buildApp();
  delay = true;
  const context = page(),
    clientMessageId = randomUUID();
  const [first, second] = await Promise.all([
    send(snapshot.conversation.id, context, clientMessageId),
    send(snapshot.conversation.id, context, clientMessageId),
  ]);
  expect(first.status).toBe(202);
  expect(second.status).toBe(202);
  expect(await first.json()).toEqual(await second.json());
  expect(requests).toHaveLength(1);
  const other = await send(snapshot.conversation.id, context);
  expect(other.status).toBe(409);
  release?.();
  await settled(snapshot.conversation.id);
});

test("history rename failure rejects HTTP before provider and preserves prior bytes", async () => {
  const snapshot = await create();
  const path = historyPath(snapshot);
  const before = readFileSync(path);
  failure.target = path;
  const response = await send(snapshot.conversation.id);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "storage" });
  expect(requests).toHaveLength(0);
  expect(readFileSync(path)).toEqual(before);
  failure.target = "";
});

test("final history persistence failure is a visible failed run preserving accepted user bytes", async () => {
  const snapshot = await create();
  delay = true;
  expect((await send(snapshot.conversation.id)).status).toBe(202);
  const path = historyPath(snapshot),
    accepted = readFileSync(path);
  failure.target = path;
  release?.();
  const done = await settled(snapshot.conversation.id);
  expect(done.conversation.run).toMatchObject({ status: "failed", error: "storage" });
  expect(readFileSync(path)).toEqual(accepted);
  failure.target = "";
});

test.each(["malformed", "future", "truncated", "bad-text", "orphan", "missing"])(
  "strict reopening rejects %s and preserves original history",
  async (kind) => {
    const snapshot = await create();
    const path = historyPath(snapshot);
    await host.close();
    let bytes = readFileSync(path).toString();
    if (kind === "malformed") bytes += "{broken}\n";
    if (kind === "future") bytes = bytes.replace('"version":3', '"version":999');
    if (kind === "truncated") bytes = bytes.trimEnd();
    if (kind === "bad-text" || kind === "orphan")
      bytes += `${JSON.stringify({
        type: "message",
        id: "entry",
        parentId: kind === "orphan" ? "missing" : null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: [{ type: "text", text: 123 }], timestamp: Date.now() },
      })}\n`;
    if (kind === "missing") {
      const fs = await import("node:fs");
      fs.rmSync(path);
    } else writeFileSync(path, bytes);
    buildApp();
    expect((await request(`/conversations/${snapshot.conversation.id}`)).status).toBe(503);
    if (kind !== "missing") expect(readFileSync(path).toString()).toBe(bytes);
    expect(requests).toHaveLength(0);
  }
);

test.each(["missing-context", "bad-objects", "bad-envelope", "wrong-reference"])(
  "host-owned JSONL rejects %s before SDK and preserves bytes",
  async (kind) => {
    const snapshot = await create();
    await send(snapshot.conversation.id);
    await settled(snapshot.conversation.id);
    await host.close();
    const path = historyPath(snapshot),
      entries = readFileSync(path, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
    const reference = entries.find(
      (entry) => entry.type === "custom" && entry.customType === "argelander.context.v1"
    );
    const user = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
    if (kind === "missing-context") delete reference.data.context;
    if (kind === "bad-objects") reference.data.context.objects = {};
    if (kind === "bad-envelope") {
      const input = JSON.parse(user.message.content[0].text);
      input.context.plan.plans = {};
      user.message.content[0].text = JSON.stringify(input);
    }
    if (kind === "wrong-reference") reference.data.context.revision += 1;
    const bytes = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    writeFileSync(path, bytes);
    buildApp();
    expect((await request(`/conversations/${snapshot.conversation.id}`)).status).toBe(503);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(requests).toHaveLength(1);
  }
);

test("closing during auth capture blocks provider admission", async () => {
  const snapshot = await create();
  const original = settings.captureConversation.bind(settings);
  let unblock!: () => void, entered!: () => void;
  const capturing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  vi.spyOn(settings, "captureConversation").mockImplementation(async (...args) => {
    entered();
    await gate;
    return original(...args);
  });
  const pending = send(snapshot.conversation.id);
  await capturing;
  await host.close();
  unblock();
  expect((await pending).status).toBe(409);
  expect(requests).toHaveLength(0);
});

test("external history corruption after loading blocks snapshot and send without overwrite", async () => {
  const snapshot = await create();
  const path = historyPath(snapshot);
  const bytes = `${readFileSync(path).toString()}broken\n`;
  writeFileSync(path, bytes);
  expect((await send(snapshot.conversation.id)).status).toBe(503);
  expect(readFileSync(path).toString()).toBe(bytes);
  expect(requests).toHaveLength(0);
});

test("messages keep original Plan references when another view is published", async () => {
  const snapshot = await create();
  const context = page();
  delay = true;
  expect((await send(snapshot.conversation.id, context)).status).toBe(202);
  host.publish({ ...context, revision: 2, view: "doc", status: "unavailable", plan: null });
  release?.();
  const done = await settled(snapshot.conversation.id);
  expect(done.messages[0]?.context?.objects).toEqual([
    { id: "p_00000001", rev: 9, name: "Plan A" },
  ]);
  expect(done.messages[0]?.context?.view).toBe("plan");
  expect(JSON.stringify(requests[0]?.context)).toContain("Plan A");
});

test("request output reservation permits a real catalog model whose maximum output equals its window", async () => {
  const runtime = await settings.getRuntime();
  const model = runtime
    .getModels("openai")
    .find((model) => model.maxTokens >= model.contextWindow && model.contextWindow > 4096);
  expect(model).toBeDefined();
  if (!model) return;
  const snapshot = await host.create({ provider: "openai", model: model.id, thinking: null });
  const context = page();
  if (!context.plan) throw new Error("fixture");
  context.plan.plans = [];
  expect((await send(snapshot.conversation.id, context)).status).toBe(202);
  await settled(snapshot.conversation.id);
  expect(requests[0]?.options?.maxTokens).toBeLessThan(model.contextWindow);
});

test("request identity is captured under settings lock and stays fixed in flight", async () => {
  const snapshot = await create(),
    runtime = await settings.getRuntime();
  const original = runtime.getAuth.bind(runtime);
  let unblock!: () => void, entered!: () => void;
  const capturing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  vi.spyOn(runtime, "getAuth").mockImplementationOnce(async (...args) => {
    entered();
    await gate;
    return original(...args);
  });
  delay = true;
  const pending = send(snapshot.conversation.id);
  await capturing;
  let changed = false;
  const change = settings.credential("openai", "SECOND_SYNTHETIC_KEY").then(() => {
    changed = true;
  });
  await Promise.resolve();
  expect(changed).toBe(false);
  unblock();
  expect((await pending).status).toBe(202);
  await change;
  expect(requests[0]?.options?.apiKey).toBe("SYNTHETIC_COPILOT_KEY");
  release?.();
  await settled(snapshot.conversation.id);
  delay = false;
  expect((await send(snapshot.conversation.id)).status).toBe(202);
  await settled(snapshot.conversation.id);
  expect(requests[1]?.options?.apiKey).toBe("SECOND_SYNTHETIC_KEY");
});

test("real no-off catalog models create and switch with SDK default, preserving explicit choices", async () => {
  const runtime = await settings.getRuntime(),
    model = runtime.getModel("openai", "gpt-5");
  expect(model).toBeDefined();
  if (!model) throw new Error("catalog fixture");
  const target = { provider: "openai", model: model.id, thinking: null };
  const created = await request("/conversations", "POST", { model: target });
  expect(created.status).toBe(201);
  const snapshot = (await created.json()) as ConversationSnapshot;
  expect(await settings.resolveThinking("openai", model.id, null)).toBe("medium");
  expect((await send(snapshot.conversation.id)).status).toBe(202);
  await settled(snapshot.conversation.id);
  const first = await create();
  expect(
    (await request(`/conversations/${first.conversation.id}/model`, "PUT", target)).status
  ).toBe(200);
  expect(
    (
      await request(`/conversations/${first.conversation.id}/model`, "PUT", {
        ...target,
        thinking: "off",
      })
    ).status
  ).toBe(400);
  expect(
    await (
      await request(`/conversations/${first.conversation.id}/model`, "PUT", {
        ...target,
        thinking: "off",
      })
    ).json()
  ).toMatchObject({ code: "capabilities" });
  expect(
    (
      await request(`/conversations/${first.conversation.id}/model`, "PUT", {
        ...target,
        thinking: "high",
      })
    ).status
  ).toBe(200);
  expect((await host.snapshot(first.conversation.id)).conversation.model?.thinking).toBe("high");
});

test("provider diagnostics never enter native history or DTO", async () => {
  const snapshot = await create();
  providerFailure = true;
  expect((await send(snapshot.conversation.id)).status).toBe(202);
  const done = await settled(snapshot.conversation.id);
  expect(done.conversation.run).toMatchObject({ status: "failed", error: "unavailable" });
  const bytes = readFileSync(historyPath(snapshot), "utf8");
  expect(bytes).not.toContain("SYNTHETIC_COPILOT_KEY");
  expect(bytes).not.toContain("key:secret");
  expect(bytes).toContain("provider unavailable");
  expect(JSON.stringify(done)).not.toContain("key:secret");
});

test("creation never calls provider and unsupported/nonmatching context fails closed", async () => {
  const snapshot = await create();
  expect(requests).toHaveLength(0);
  const context = page();
  expect(
    (await request(`/views/${context.viewId}`, "PUT", { ...context, view: "doc" })).status
  ).toBe(400);
  expect(
    (
      await request(`/conversations/${snapshot.conversation.id}/messages`, "POST", {
        clientMessageId: randomUUID(),
        text: "x",
        viewId: context.viewId,
        contextRevision: 1,
      })
    ).status
  ).toBe(409);
  expect(readdirSync(join(dataDir, "copilot/sessions"))).toHaveLength(1);
});

test("real WS subscribes before snapshot, isolates chat events, and disconnect does not own the run", async () => {
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
  const snapshot = await create();
  delay = true;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` });
  const observer = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: "http://localhost:5173" });
  const events: Record<string, unknown>[] = [],
    unrelated: Record<string, unknown>[] = [];
  socket.on("message", (data) => events.push(JSON.parse(data.toString())));
  observer.on("message", (data) => unrelated.push(JSON.parse(data.toString())));
  try {
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      }),
      new Promise<void>((resolve, reject) => {
        observer.once("open", resolve);
        observer.once("error", reject);
      }),
    ]);
    const context = page();
    socket.send(
      JSON.stringify({
        type: "copilot.subscribe",
        conversationId: snapshot.conversation.id,
        viewId: context.viewId,
      })
    );
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "copilot.subscribed")).toBe(true)
    );
    const before = await request(`/conversations/${snapshot.conversation.id}`);
    const cursor = ((await before.json()) as ConversationSnapshot).eventCursor;
    expect((await send(snapshot.conversation.id, context)).status).toBe(202);
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "copilot.event")).toBe(true)
    );
    expect(server.runner.list()).toEqual([]);
    socket.close();
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    release?.();
    await vi.waitFor(async () =>
      expect(
        (
          (await (
            await request(`/conversations/${snapshot.conversation.id}`)
          ).json()) as ConversationSnapshot
        ).conversation.run?.status
      ).toBe("completed")
    );
    const restored = (await (
      await request(`/conversations/${snapshot.conversation.id}`)
    ).json()) as ConversationSnapshot;
    expect(restored.messages).toHaveLength(2);
    expect(restored.eventCursor.instanceId).toBe(cursor.instanceId);
    expect(restored.eventCursor.seq).toBeGreaterThan(cursor.seq);
    expect(unrelated.some((event) => event.type === "copilot.event")).toBe(false);
    expect(events[0]).toEqual({ type: "hello", jobs: [] });
  } finally {
    socket.terminate();
    observer.terminate();
    await server.close();
  }
});

test("WS Origin refuses cross-site access while actual server and Vite sources work", async () => {
  const { createServer } = await import("../src/server.js");
  const { WebSocket } = await import("ws");
  const server = createServer({
    dataDir,
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    providerSettings: settings,
  });
  const port = await server.ready();
  try {
    const rejected = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      origin: "https://cross-site.invalid",
    });
    await expect(
      new Promise<void>((resolve, reject) => {
        rejected.once("open", resolve);
        rejected.once("error", reject);
      })
    ).rejects.toThrow("403");
    for (const origin of [
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ]) {
      const accepted = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
      await new Promise<void>((resolve, reject) => {
        accepted.once("open", resolve);
        accepted.once("error", reject);
      });
      accepted.terminate();
    }
  } finally {
    await server.close();
  }
});

function reply(model: Model<Api>, error?: string) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "Reply" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    stopReason: error ? "error" : "stop",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  if (error)
    stream.push({ type: "error", reason: "error", error: { ...message, errorMessage: error } });
  else stream.push({ type: "done", reason: "stop", message });
  return stream;
}

test.each(["429 rate limit, retry after 0.8 seconds", "503 server error", "fetch failed"])(
  "safe %s retains actual SDK retry without leaking credentials",
  async (diagnostic) => {
    const snapshot = await create();
    let attempts = 0;
    streamOverride = (model) =>
      reply(
        model,
        attempts++ === 0 ? `${diagnostic}; SYNTHETIC_COPILOT_KEY key:secret` : undefined
      );
    expect((await send(snapshot.conversation.id)).status).toBe(202);
    const done = await settled(snapshot.conversation.id);
    expect(requests).toHaveLength(2);
    expect(done.conversation.run?.status).toBe("completed");
    if (diagnostic.startsWith("429"))
      expect((requests[1]?.at ?? 0) - (requests[0]?.at ?? 0)).toBeGreaterThanOrEqual(750);
    const bytes = readFileSync(historyPath(snapshot), "utf8");
    expect(bytes).not.toContain("SYNTHETIC_COPILOT_KEY");
    expect(bytes).not.toContain("key:secret");
    expect(bytes).toContain(
      diagnostic.startsWith("429")
        ? "provider rate limit 429; retry after 0.8 seconds"
        : "provider overloaded"
    );
  }
);

test("quota and exhausted 429 remain safely classified failures", async () => {
  const snapshot = await create();
  streamOverride = (model) => reply(model, "429 insufficient_quota SYNTHETIC_COPILOT_KEY");
  await send(snapshot.conversation.id);
  expect((await settled(snapshot.conversation.id)).conversation.run?.error).toBe("quota");
  expect(requests).toHaveLength(1);
  streamOverride = (model) => reply(model, "429 rate limit SYNTHETIC_COPILOT_KEY");
  await send(snapshot.conversation.id);
  expect((await settled(snapshot.conversation.id)).conversation.run?.error).toBe("rate_limit");
  expect(requests).toHaveLength(3);
});

test("existing native history records actual model and thinking on every admitted model request", async () => {
  const snapshot = await host.create({ provider: "openai", model: "gpt-5", thinking: "low" });
  await send(snapshot.conversation.id);
  await settled(snapshot.conversation.id);
  await host.selectModel(snapshot.conversation.id, {
    provider: "openai",
    model: "gpt-5",
    thinking: "high",
  });
  await send(snapshot.conversation.id);
  await settled(snapshot.conversation.id);
  expect(requests.map((value) => value.options?.reasoning)).toEqual(["low", "high"]);
  const entries = readFileSync(historyPath(snapshot), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    entries
      .filter((entry) => entry.type === "thinking_level_change")
      .map((entry) => entry.thinkingLevel)
  ).toContain("high");
  await host.close();
  buildApp();
  expect((await host.snapshot(snapshot.conversation.id)).messages).toHaveLength(4);
  expect(readFileSync(historyPath(snapshot), "utf8")).toContain('"thinkingLevel":"high"');
});

test("next actual SDK retry sees bound page B and new choice while original A stays fixed", async () => {
  const snapshot = await create(),
    a = page();
  let attempts = 0;
  streamOverride = (model) =>
    reply(model, attempts++ === 0 ? "429 rate limit; retry after 0.8 seconds" : undefined);
  await send(snapshot.conversation.id, a);
  const originalPlan = a.plan?.plans[0];
  if (!a.plan || !originalPlan) throw new Error("fixture");
  const bPlan = {
    ...a.plan,
    selectedPlanId: "p_00000002",
    plans: [
      { ...originalPlan, id: "p_00000002", name: "Plan B MALICIOUS_PAGE_INSTRUCTION", tasks: [] },
    ],
  };
  const b: PageContext = {
    ...a,
    revision: 2,
    plan: bPlan,
  };
  host.publish(b);
  host.publish({
    ...b,
    viewId: randomUUID(),
    revision: 99,
    plan: { ...bPlan, plans: [{ ...originalPlan, name: "OTHER_TAB" }] },
  });
  await host.selectModel(snapshot.conversation.id, {
    provider: "openai",
    model: "gpt-5",
    thinking: null,
  });
  const done = await settled(snapshot.conversation.id);
  expect(requests.map((value) => value.model)).toEqual(["gpt-4.1", "gpt-5"]);
  expect(requests[1]?.options?.reasoning).toBe("medium");
  expect(JSON.stringify(requests[0]?.context)).not.toContain("Plan B");
  expect(JSON.stringify(requests[1]?.context)).toContain("Plan B");
  expect(JSON.stringify(requests[1]?.context)).not.toContain("OTHER_TAB");
  expect(done.messages[0]?.context?.objects[0]?.name).toBe("Plan A");
  const bytes = readFileSync(historyPath(snapshot), "utf8");
  expect(bytes).toContain("argelander.page-observation.v1");
  expect(getCurrentSystemPrompt(requests[1]?.context.messages ?? [])).not.toContain(
    "MALICIOUS_PAGE_INSTRUCTION"
  );
  expect(JSON.stringify(requests[1]?.context)).toContain("MALICIOUS_PAGE_INSTRUCTION");
  expect(bytes).toContain('"thinkingLevel":"medium"');
  await host.close();
  buildApp();
  expect(
    (await host.snapshot(snapshot.conversation.id)).messages[0]?.context?.objects[0]?.name
  ).toBe("Plan A");
});

test.each(["capacity", "storage"])(
  "next-step page update must pass %s before external provider",
  async (kind) => {
    const snapshot = await create(),
      a = page();
    let attempts = 0;
    streamOverride = (model) =>
      reply(model, attempts++ === 0 ? "429 rate limit; retry after 0.8 seconds" : undefined);
    await send(snapshot.conversation.id, a);
    const bytes = readFileSync(historyPath(snapshot));
    const plan = a.plan?.plans[0],
      task = plan?.tasks[0];
    if (!plan || !task || !a.plan) throw new Error("fixture");
    host.publish({
      ...a,
      revision: 2,
      plan: {
        ...a.plan,
        plans: [
          {
            ...plan,
            name: "NEXT_PAGE_NOT_ADMITTED",
            tasks: [{ ...task, note: kind === "capacity" ? "x".repeat(3_000_000) : "changed" }],
          },
        ],
      },
    });
    if (kind === "storage") failure.target = historyPath(snapshot);
    const done = await settled(snapshot.conversation.id);
    failure.target = "";
    expect(requests).toHaveLength(1);
    expect(done.conversation.run?.error).toBe(kind);
    expect(readFileSync(historyPath(snapshot))).toEqual(bytes);
    expect(done.messages[0]?.context?.objects[0]?.name).toBe("Plan A");
  }
);

test("changed configured default is captured and recorded after native history exists", async () => {
  const snapshot = await host.create({ provider: "openai", model: "gpt-5", thinking: null });
  await send(snapshot.conversation.id);
  await settled(snapshot.conversation.id);
  const model = (await settings.getRuntime()).getModel("openai", "gpt-5");
  if (!model) throw new Error("fixture");
  await settings.configure("openai", {
    baseUrl: model.baseUrl,
    modelId: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    image: model.input.includes("image"),
    tools: true,
    defaultThinking: "low",
  });
  (await settings.getRuntime()).registerProvider("openai", {
    api: "openai-responses",
    streamSimple(selected, context, options) {
      requests.push({ model: selected.id, at: Date.now(), context, options });
      return reply(selected);
    },
  });
  await send(snapshot.conversation.id);
  await settled(snapshot.conversation.id);
  expect(requests.map((value) => value.options?.reasoning)).toEqual(["medium", "low"]);
  const bytes = readFileSync(historyPath(snapshot), "utf8");
  expect(bytes).toContain('"thinkingLevel":"low"');
  expect((await host.snapshot(snapshot.conversation.id)).conversation.model?.thinking).toBeNull();
});
