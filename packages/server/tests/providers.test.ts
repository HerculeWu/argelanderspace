import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CopilotProvider,
  ProviderModelConfig,
  ProviderMutationResult,
  ProvidersResponse,
  ProviderTestResult,
} from "@argelanderspace/contracts";
import { libraryPaths } from "@argelanderspace/core";
import type { Api, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import { JobRunner } from "../src/jobs.js";
import { ProviderSettings } from "../src/providers.js";
import { stubPipelines, stubSources } from "./helpers.js";

let root: string;
let settings: ProviderSettings;
let originalEnv: NodeJS.ProcessEnv;
let app: ReturnType<typeof createApp>;
const prefix = "/api/copilot/providers";
const key = "SYNTHETIC_KEY_ONLY_FOR_PROVIDER_TEST";
beforeEach(() => {
  originalEnv = process.env;
  root = mkdtempSync(join(tmpdir(), "provider-settings-"));
  process.env = { PATH: originalEnv.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "config") };
  settings = new ProviderSettings({ testTimeoutMs: 50 });
  app = createApp({
    paths: libraryPaths(join(root, "data")),
    statusDir: join(root, "status"),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(root, "jobs") }),
    providerSettings: settings,
  });
  vi.stubGlobal("fetch", () => {
    throw new Error("Unexpected external request");
  });
});
afterEach(() => {
  process.env = originalEnv;
  vi.unstubAllGlobals();
});
const request = (
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
  origin?: string
) =>
  app.request(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
  });
async function provider(): Promise<CopilotProvider> {
  const response = await request(prefix);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const item = ((await response.json()) as ProvidersResponse).providers.find(
    (item: CopilotProvider) => item.id === "openai"
  );
  if (!item) throw new Error("Expected OpenAI catalog");
  return item;
}
async function config(): Promise<ProviderModelConfig> {
  const selected = (await provider()).models.find((item) => item.id === "gpt-4.1");
  if (!selected) throw new Error("Expected catalog model");
  return {
    baseUrl: "https://offline.invalid/v1",
    modelId: selected.id,
    name: "Test model",
    contextWindow: 8000,
    maxTokens: 128,
    image: true,
    tools: true,
    defaultThinking: null,
  };
}
async function script(
  callback: (
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions
  ) => Promise<{ error?: string }> | { error?: string }
) {
  const ai = await import("@earendil-works/pi-ai");
  const runtime = await settings.getRuntime();
  runtime.registerProvider("openai", {
    api: "openai-responses",
    streamSimple(model, context, options) {
      const stream = ai.createAssistantMessageEventStream();
      Promise.resolve(callback(model, context, options)).then(({ error }) => {
        const result = {
          role: "assistant" as const,
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [{ type: "text" as const, text: "OK" }],
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: error ? ("error" as const) : ("stop" as const),
          errorMessage: error,
          timestamp: Date.now(),
        };
        if (error) stream.push({ type: "error", reason: "error", error: result });
        else stream.push({ type: "done", reason: "stop", message: result });
        stream.end();
      });
      return stream;
    },
  });
}

test("real Pi credential save/replace/reopen/remove and environment fallback are redacted", async () => {
  process.env.OPENAI_API_KEY = "SYNTHETIC_ENVIRONMENT_KEY";
  expect((await provider()).credential).toEqual({
    configured: true,
    stored: false,
    source: "environment",
  });
  const saved = await request(`${prefix}/openai/credential`, "PUT", { key });
  expect(saved.status).toBe(200);
  expect(await saved.text()).not.toContain(key);
  const authPath = join(settings.configDir, "auth.json");
  expect(lstatSync(settings.configDir).mode & 0o777).toBe(0o700);
  expect(lstatSync(authPath).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(authPath, "utf8")).openai.key).toBe(key);
  const reopened = new ProviderSettings({ configDir: settings.configDir });
  expect((await (await reopened.getRuntime()).getAuth("openai"))?.auth.apiKey).toBe(key);
  expect((await reopened.list()).find((item) => item.id === "openai")?.credential.source).toBe(
    "stored"
  );
  expect(
    (await request(`${prefix}/openai/credential`, "PUT", { key: "SYNTHETIC_REPLACEMENT_KEY" }))
      .status
  ).toBe(200);
  const removed = await request(`${prefix}/openai/credential`, "DELETE");
  expect(((await removed.json()) as ProviderMutationResult).provider.credential).toEqual({
    configured: true,
    stored: false,
    source: "environment",
  });
  expect(JSON.parse(readFileSync(authPath, "utf8")).openai).toBeUndefined();
});

test("unsafe existing directory/file modes, symlinks, corrupt auth, and future preferences preserve original bytes", async () => {
  await request(`${prefix}/openai/credential`, "PUT", { key });
  const authPath = join(settings.configDir, "auth.json");
  const before = readFileSync(authPath);
  chmodSync(authPath, 0o644);
  expect(
    (await request(`${prefix}/openai/credential`, "PUT", { key: "SYNTHETIC_BAD" })).status
  ).toBe(503);
  expect(readFileSync(authPath)).toEqual(before);
  chmodSync(authPath, 0o600);
  chmodSync(settings.configDir, 0o755);
  expect((await request(prefix)).status).toBe(503);
  expect(readFileSync(authPath)).toEqual(before);
  chmodSync(settings.configDir, 0o700);
  writeFileSync(authPath, "{broken");
  expect((await request(prefix)).status).toBe(503);
  expect(readFileSync(authPath, "utf8")).toBe("{broken");
  writeFileSync(authPath, before);
  writeFileSync(join(settings.configDir, "preferences.json"), '{"version":99,"models":{}}', {
    mode: 0o600,
  });
  expect((await request(prefix)).status).toBe(503);
  expect(readFileSync(join(settings.configDir, "preferences.json"), "utf8")).toContain("99");
  const outside = join(root, "outside");
  mkdirSync(outside);
  const linked = join(root, "linked");
  symlinkSync(outside, linked);
  await expect(new ProviderSettings({ configDir: linked }).getRuntime()).rejects.toMatchObject({
    code: "storage",
  });
});

test("strict config saves Pi fields separately from preferences and validates default before clamp", async () => {
  const draft = await config();
  expect((await request(`${prefix}/openai/config`, "PUT", draft)).status).toBe(200);
  const modelBytes = readFileSync(join(settings.configDir, "models.json"));
  const prefsBytes = readFileSync(join(settings.configDir, "preferences.json"));
  expect(modelBytes.toString()).not.toContain("defaultThinking");
  expect(prefsBytes.toString()).toContain('"defaultThinking": null');
  for (const patch of [
    { key },
    { headers: { authorization: key } },
    { command: "!echo secret" },
    { unknown: true },
    { contextWindow: 0 },
    { maxTokens: 8001 },
    { defaultThinking: "high" },
    { baseUrl: `https://user:${key}@example.invalid` },
  ]) {
    const rejected = await request(`${prefix}/openai/config`, "PUT", { ...draft, ...patch });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).not.toContain(key);
    expect(readFileSync(join(settings.configDir, "models.json"))).toEqual(modelBytes);
    expect(readFileSync(join(settings.configDir, "preferences.json"))).toEqual(prefsBytes);
  }
  const preferences = JSON.parse(prefsBytes.toString());
  preferences.models.openai["gpt-4.1"].defaultThinking = "high";
  writeFileSync(join(settings.configDir, "preferences.json"), JSON.stringify(preferences));
  expect(
    (await provider()).models.find((model) => model.id === "gpt-4.1")?.defaultThinkingValid
  ).toBe(false);
  await expect(settings.resolveThinking("openai", "gpt-4.1", null)).rejects.toMatchObject({
    code: "capabilities",
  });
});

test("unknown custom model has no invented thinking options and Pi validates the persisted schema", async () => {
  const draft = { ...(await config()), modelId: "my-custom-model", defaultThinking: null };
  expect((await request(`${prefix}/openai/config`, "PUT", draft)).status).toBe(200);
  const custom = (await provider()).models.find((model) => model.id === draft.modelId);
  expect(custom).toMatchObject({
    capabilitiesKnown: false,
    thinkingLevels: [],
    defaultThinking: null,
  });
  expect(
    (await request(`${prefix}/openai/config`, "PUT", { ...draft, defaultThinking: "high" })).status
  ).toBe(400);
});

test("minimal real SDK connection request uses captured current key and draft without saving or user context", async () => {
  await request(`${prefix}/openai/credential`, "PUT", { key });
  const draft = await config();
  let calls = 0;
  await script((model, context, options) => {
    calls++;
    expect(model.baseUrl).toBe(draft.baseUrl);
    expect(model.contextWindow).toBe(draft.contextWindow);
    expect(options?.apiKey).toBe(key);
    expect(options?.maxTokens).toBe(32);
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]).toMatchObject({ role: "user", content: "Reply OK." });
    return {};
  });
  const response = await request(`${prefix}/openai/test`, "POST", draft);
  expect(await response.json()).toEqual({ code: "success", retryable: false });
  expect(calls).toBe(1);
  expect(existsSync(join(settings.configDir, "models.json"))).toBe(false);
  expect(existsSync(join(settings.configDir, "preferences.json"))).toBe(false);
});

for (const [message, expected] of [
  [`401 API key ${key}`, "credentials"],
  ["429 rate limit", "rate_limited"],
  ["404 model not found", "model"],
  ["404 Route not found", "endpoint"],
  ["fetch ECONNREFUSED", "endpoint"],
]) {
  test(`connection failure ${expected} is classified and never echoes upstream secret`, async () => {
    await request(`${prefix}/openai/credential`, "PUT", { key });
    const draft = await config();
    await script(() => ({ error: message }));
    const result = await request(`${prefix}/openai/test`, "POST", draft);
    const text = await result.text();
    expect(text).not.toContain(key);
    expect(JSON.parse(text)).toEqual({ code: expected, retryable: true });
  });
}

test("missing credentials, timeout and cancellation are distinct; late SDK completion cannot change result", async () => {
  const draft = await config();
  expect(
    ((await (await request(`${prefix}/openai/test`, "POST", draft)).json()) as ProviderTestResult)
      .code
  ).toBe("credentials");
  await request(`${prefix}/openai/credential`, "PUT", { key });
  let complete: (() => void) | undefined;
  await script(
    () =>
      new Promise((resolve) => {
        complete = () => resolve({});
      })
  );
  expect(
    ((await (await request(`${prefix}/openai/test`, "POST", draft)).json()) as ProviderTestResult)
      .code
  ).toBe("timeout");
  complete?.();
  const controller = new AbortController();
  const pending = request(`${prefix}/openai/test`, "POST", draft, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  expect(((await (await pending).json()) as ProviderTestResult).code).toBe("cancelled");
  complete?.();
});

test("credentials/config/test writes retain same-origin guard", async () => {
  await request(`${prefix}/openai/credential`, "PUT", { key });
  const draft = await config();
  const original = readFileSync(join(settings.configDir, "auth.json"));
  for (const [path, method, body] of [
    ["credential", "PUT", { key }],
    ["credential", "DELETE", undefined],
    ["config", "PUT", draft],
    ["test", "POST", draft],
  ] as const) {
    expect(
      (await request(`${prefix}/openai/${path}`, method, body, undefined, "https://evil.invalid"))
        .status
    ).toBe(403);
  }
  expect(readFileSync(join(settings.configDir, "auth.json"))).toEqual(original);
});

test("dollar signs are literal secrets after persistent Pi login and reopen", async () => {
  const literal = "SYNTHETIC_$MISSING_" + "$" + "{MISSING}_$$token$!literal";
  expect((await request(`${prefix}/openai/credential`, "PUT", { key: literal })).status).toBe(200);
  const reopened = new ProviderSettings({ configDir: settings.configDir });
  expect((await (await reopened.getRuntime()).getAuth("openai"))?.auth.apiKey).toBe(literal);
  expect(await (await request(prefix)).text()).not.toContain("SYNTHETIC_");
});

test("disk models and API failures are guarded before SDK, with sanitized route errors and no logs", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const draft = await config();
    const path = join(settings.configDir, "models.json");
    const malicious = JSON.stringify({
      providers: { openai: { apiKey: `!echo ${key}`, headers: { Authorization: key } } },
    });
    writeFileSync(path, malicious, { mode: 0o600 });
    const response = await request(prefix);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(key);
    expect(readFileSync(path, "utf8")).toBe(malicious);
    expect(logged).not.toHaveBeenCalled();
    expect((await request(`${prefix}/unknown-provider/config`, "PUT", draft)).status).toBe(503);
  } finally {
    logged.mockRestore();
  }
});

test("catalog synchronization failure distinguishes a successfully saved credential and can recover", async () => {
  const runtime = await settings.getRuntime();
  let fail = true;
  runtime.registerProvider("openai", {
    api: "openai-responses",
    refreshModels: async () => {
      if (fail) throw new Error(`SYNTHETIC catalog failure ${key}`);
      return [];
    },
  });
  const saved = await request(`${prefix}/openai/credential`, "PUT", { key });
  expect(saved.status).toBe(200);
  const text = await saved.text();
  expect(text).not.toContain(key);
  expect(JSON.parse(text)).toMatchObject({
    saved: true,
    provider: { catalogStatus: "error", credential: { stored: true } },
  });
  expect(JSON.parse(readFileSync(join(settings.configDir, "auth.json"), "utf8")).openai.key).toBe(
    key
  );
  fail = false;
  expect((await provider()).catalogStatus).toBe("ready");
});

test("single-key providers exclude SDK account/profile flows; unknown models may omit thinking but cannot invent it", async () => {
  const response = await request(prefix);
  const ids = ((await response.json()) as ProvidersResponse).providers.map((item) => item.id);
  for (const id of [
    "amazon-bedrock",
    "google-vertex",
    "cloudflare-workers-ai",
    "cloudflare-ai-gateway",
  ])
    expect(ids).not.toContain(id);
  expect((await request(`${prefix}/google-vertex/credential`, "PUT", { key })).status).toBe(404);
  const draft = { ...(await config()), modelId: "unknown-local-model", defaultThinking: null };
  await request(`${prefix}/openai/config`, "PUT", draft);
  expect(await settings.resolveThinking("openai", draft.modelId, null)).toBeUndefined();
  await expect(settings.resolveThinking("openai", draft.modelId, "high")).rejects.toMatchObject({
    code: "capabilities",
  });
});

test("client socket cancellation propagates through the real HTTP server to Pi provider AbortSignal", async () => {
  const { request: httpRequest } = await import("node:http");
  const { createServer } = await import("../src/server.js");
  settings = new ProviderSettings({ configDir: settings.configDir, testTimeoutMs: 5000 });
  const server = createServer({
    dataDir: join(root, "http-data"),
    port: 0,
    webDist: null,
    providerSettings: settings,
    heartbeatMs: 0,
  });
  try {
    const port = await server.ready();
    // Keep SDK and storage real; only its external provider stream is scripted.
    await settings.credential("openai", key);
    const draft = { ...(await config()) };
    let startedResolve: (() => void) | undefined;
    let abortedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      abortedResolve = resolve;
    });
    await script(
      (_model, _context, options) =>
        new Promise((resolve) => {
          startedResolve?.();
          options?.signal?.addEventListener(
            "abort",
            () => {
              abortedResolve?.();
              resolve({ error: "request cancelled" });
            },
            { once: true }
          );
        })
    );
    const controller = new AbortController();
    const client = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: `${prefix}/openai/test`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    });
    client.on("error", () => {});
    client.end(JSON.stringify(draft));
    await started;
    controller.abort();
    await Promise.race([
      aborted,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("abort did not reach provider")), 1000)
      ),
    ]);
  } finally {
    await server.close().catch(() => {});
  }
});

test("dangling symlinks never become SDK-created files outside the credential directory", async () => {
  for (const file of ["auth.json", "models.json", "preferences.json", "models-store.json"]) {
    const directory = join(root, `${file}-dir`);
    const target = join(root, `${file}-outside`);
    mkdirSync(directory, { mode: 0o700 });
    symlinkSync(target, join(directory, file));
    await expect(new ProviderSettings({ configDir: directory }).getRuntime()).rejects.toMatchObject(
      { code: "storage" }
    );
    expect(existsSync(target)).toBe(false);
  }
});

test("catalog thinking trust is tied to its endpoint across draft, persistence and reopen", async () => {
  const catalog = (await provider()).models.find((item) => item.id === "gpt-5.4");
  if (!catalog) throw new Error("Expected reasoning catalog model");
  const draft = {
    ...(await config()),
    modelId: catalog.id,
    baseUrl: catalog.baseUrl,
    defaultThinking: "high" as const,
  };
  expect((await request(`${prefix}/openai/config`, "PUT", draft)).status).toBe(200);
  const before = readFileSync(join(settings.configDir, "models.json"));
  const unknown = { ...draft, baseUrl: "https://custom.invalid/v1" };
  expect((await request(`${prefix}/openai/config`, "PUT", unknown)).status).toBe(400);
  expect(readFileSync(join(settings.configDir, "models.json"))).toEqual(before);
  expect((await request(`${prefix}/openai/test`, "POST", unknown)).status).toBe(200);
  expect(await (await request(`${prefix}/openai/test`, "POST", unknown)).json()).toMatchObject({
    code: "capabilities",
  });
  expect(
    (await request(`${prefix}/openai/config`, "PUT", { ...unknown, defaultThinking: null })).status
  ).toBe(200);
  const dto = (await provider()).models.find((item) => item.id === catalog.id);
  expect(dto).toMatchObject({
    capabilitiesKnown: false,
    thinkingLevels: [],
    defaultThinking: null,
  });
  const reopened = new ProviderSettings({ configDir: settings.configDir });
  expect(
    (await reopened.list())
      .find((item) => item.id === "openai")
      ?.models.find((item) => item.id === catalog.id)
  ).toMatchObject({ capabilitiesKnown: false, thinkingLevels: [] });
  expect(await reopened.resolveThinking("openai", catalog.id, null)).toBeUndefined();
  await expect(reopened.resolveThinking("openai", catalog.id, "high")).rejects.toMatchObject({
    code: "capabilities",
  });
  expect((await request(`${prefix}/openai/config`, "PUT", draft)).status).toBe(200);
  expect((await provider()).models.find((item) => item.id === catalog.id)).toMatchObject({
    capabilitiesKnown: true,
    defaultThinking: "high",
  });
});

test("real Anthropic adapter keeps captured header-only auth through concurrent credential save", async () => {
  process.env.ANTHROPIC_AUTH_TOKEN = "SYNTHETIC_HEADER_TOKEN";
  settings = new ProviderSettings({ configDir: settings.configDir, testTimeoutMs: 5000 });
  const runtime = await settings.getRuntime();
  const model = runtime.getModels("anthropic")[0];
  if (!model) throw new Error("Expected Anthropic catalog model");
  let captured!: () => void;
  let release!: () => void;
  const capturedSignal = new Promise<void>((resolve) => {
    captured = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const realAuth = runtime.getAuth.bind(runtime);
  const authCalls = vi.spyOn(runtime, "getAuth").mockImplementation(async (...args) => {
    const result = await realAuth(...args);
    captured();
    await gate;
    return result;
  });
  let changed: Promise<CopilotProvider> | undefined;
  let preservedAuth = false;
  let mixedKey = false;
  vi.stubGlobal("fetch", async (input: string | Request | URL, init?: RequestInit) => {
    await changed;
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    preservedAuth = headers.get("authorization") === "Bearer SYNTHETIC_HEADER_TOKEN";
    mixedKey = headers.get("x-api-key") === "SYNTHETIC_CONCURRENT_KEY";
    return new Response(
      JSON.stringify({
        type: "error",
        error: { type: "not_found_error", message: "model not found" },
      }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  });
  const pending = settings.test(
    "anthropic",
    {
      baseUrl: model.baseUrl,
      modelId: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      image: true,
      tools: true,
      defaultThinking: null,
    },
    new AbortController().signal
  );
  await capturedSignal;
  changed = settings.credential("anthropic", "SYNTHETIC_CONCURRENT_KEY");
  release();
  await pending;
  expect(preservedAuth).toBe(true);
  expect(mixedKey).toBe(false);
  expect(authCalls).toHaveBeenCalledTimes(1);
});

test("OS file-size write failure preserves credential bytes, restart and other providers", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { readdirSync } = await import("node:fs");
  const directory = join(root, "atomic");
  mkdirSync(directory, { mode: 0o700 });
  const file = join(directory, "auth.json");
  const before = JSON.stringify({
    openai: { type: "api_key", key: "SYNTHETIC_OLD" },
    anthropic: { type: "api_key", key: "SYNTHETIC_OTHER" },
  });
  writeFileSync(file, before, { mode: 0o600 });
  const modulePath = fileURLToPath(new URL("../dist/providers.js", import.meta.url));
  const scriptPath = join(root, "atomic-check.mjs");
  writeFileSync(
    scriptPath,
    `
    import { readFileSync, readdirSync } from 'node:fs';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    process.on('SIGXFSZ', () => {});
    globalThis.fetch = async () => { throw new Error('External network forbidden'); };
    const { ProviderSettings } = await import(pathToFileURL(${JSON.stringify(modulePath)}));
    const directory = ${JSON.stringify(directory)};
    const file = join(directory, 'auth.json');
    const before = readFileSync(file);
    const settings = new ProviderSettings({ configDir: directory });
    let failed = false;
    try { await settings.credential('openai', 'SYNTHETIC_LONG_' + 'x'.repeat(2000)); }
    catch(error) { failed = error.code === 'storage'; }
    const preserved = before.equals(readFileSync(file));
    const reopened = new ProviderSettings({ configDir: directory });
    const runtime = await reopened.getRuntime();
    const model = runtime.getModels('openai')[0];
    const restart = (await runtime.getAuth(model))?.auth.apiKey === 'SYNTHETIC_OLD';
    await reopened.credential('openai', 'SYNTHETIC_SHORT');
    const replaced = JSON.parse(readFileSync(file));
    const otherPreserved = replaced.anthropic.key === 'SYNTHETIC_OTHER';
    await reopened.credential('openai', null);
    const removed = JSON.parse(readFileSync(file));
    console.log(JSON.stringify({ failed, preserved, restart, otherPreserved, removed: !removed.openai && removed.anthropic.key === 'SYNTHETIC_OTHER', clean: readdirSync(directory).every(name => !name.includes('.tmp-') && !name.endsWith('.lock')) }));
  `
  );
  const child = spawnSync(
    "python3",
    [
      "-c",
      "import os,resource,sys; resource.setrlimit(resource.RLIMIT_FSIZE,(1024,1024)); os.execv(sys.argv[1],sys.argv[1:])",
      process.execPath,
      scriptPath,
    ],
    { env: process.env, cwd: root, timeout: 20_000, encoding: "utf8" }
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual({
    failed: true,
    preserved: true,
    restart: true,
    otherPreserved: true,
    removed: true,
    clean: true,
  });
  expect(readdirSync(directory)).toContain("auth.json");
  expect(
    readdirSync(directory).some((name) => name.includes(".tmp-") || name.endsWith(".lock"))
  ).toBe(false);
});

test("independent Pi runtimes serialize credential mutations without losing another provider", async () => {
  const first = new ProviderSettings({ configDir: settings.configDir });
  const second = new ProviderSettings({ configDir: settings.configDir });
  await Promise.all([
    first.credential("openai", "SYNTHETIC_FIRST"),
    second.credential("anthropic", "SYNTHETIC_SECOND"),
  ]);
  const auth = JSON.parse(readFileSync(join(settings.configDir, "auth.json"), "utf8"));
  expect(auth.openai.key === "SYNTHETIC_FIRST").toBe(true);
  expect(auth.anthropic.key === "SYNTHETIC_SECOND").toBe(true);
  const before = readFileSync(join(settings.configDir, "auth.json"));
  const outside = join(root, "dangling-lock");
  symlinkSync(outside, join(settings.configDir, "auth.json.lock"));
  await expect(first.credential("openai", "SYNTHETIC_THIRD")).rejects.toMatchObject({
    code: "storage",
  });
  expect(readFileSync(join(settings.configDir, "auth.json"))).toEqual(before);
  expect(existsSync(outside)).toBe(false);
});

test("public Pi login cancels a file-lock waiter without late credential writes", async () => {
  const { default: lockfile } = await import("proper-lockfile");
  await settings.credential("openai", "SYNTHETIC_BEFORE_CANCEL");
  const file = join(settings.configDir, "auth.json");
  const before = readFileSync(file);
  const release = await lockfile.lock(file, { realpath: false, stale: 30_000 });
  const runtime = await settings.getRuntime();
  const controller = new AbortController();
  let prompted!: () => void;
  const promptSignal = new Promise<void>((resolve) => {
    prompted = resolve;
  });
  const pending = runtime.login("openai", "api_key", {
    signal: controller.signal,
    prompt: async () => {
      prompted();
      return "SYNTHETIC_CANCELLED";
    },
    notify: () => {},
  });
  const rejection = expect(pending).rejects.toThrow();
  await promptSignal;
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  try {
    await rejection;
  } finally {
    await release();
  }
  await settings.credential("openai", "SYNTHETIC_AFTER_CANCEL");
  const reopened = new ProviderSettings({ configDir: settings.configDir });
  expect(
    (await (await reopened.getRuntime()).getAuth("openai"))?.auth.apiKey ===
      "SYNTHETIC_AFTER_CANCEL"
  ).toBe(true);
  expect(readFileSync(file).equals(before)).toBe(false);
  expect(readFileSync(file, "utf8").includes("SYNTHETIC_CANCELLED")).toBe(false);
});
