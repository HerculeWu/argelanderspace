import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CopilotProvider,
  ProviderLogin,
  ProvidersResponse,
  ProviderTestResult,
} from "@argelanderspace/contracts";
import { libraryPaths } from "@argelanderspace/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import { JobRunner } from "../src/jobs.js";
import { ProviderSettings } from "../src/providers.js";
import { stubPipelines, stubSources } from "./helpers.js";

// Offline OAuth: the real Pi openai-codex adapter runs; only its HTTPS endpoints are stubbed.
let root: string;
let settings: ProviderSettings;
let originalEnv: NodeJS.ProcessEnv;
let app: ReturnType<typeof createApp>;
const prefix = "/api/copilot/providers";
const jwt = (account: string) =>
  `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64")}.s`;
const ACCESS = jwt("acct_SYNTHETIC");
const REFRESH = "SYNTHETIC_REFRESH_TOKEN";
const AUTH_BASE = "https://auth.openai.com";
interface Stub {
  device: "pending" | "complete" | "hang";
  token: (body: URLSearchParams) => Response | Promise<Response>;
  calls: string[];
  signals: AbortSignal[];
}
let stub: Stub;
const tokenOk = () =>
  new Response(JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 }));
function build(options: ConstructorParameters<typeof ProviderSettings>[0] = {}) {
  settings = new ProviderSettings(options);
  app = createApp({
    paths: libraryPaths(join(root, "data")),
    statusDir: join(root, "status"),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(root, "jobs") }),
    providerSettings: settings,
  });
}
beforeEach(() => {
  originalEnv = process.env;
  root = mkdtempSync(join(tmpdir(), "provider-login-"));
  process.env = {
    PATH: originalEnv.PATH,
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    // Never bind the real Codex CLI callback port in tests: manual paste is used instead.
    PI_OAUTH_CALLBACK_HOST: "203.0.113.1",
  };
  stub = { device: "complete", token: tokenOk, calls: [], signals: [] };
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    stub.calls.push(url);
    if (init?.signal) stub.signals.push(init.signal);
    if (url === `${AUTH_BASE}/api/accounts/deviceauth/usercode`)
      return new Response(
        JSON.stringify({ device_auth_id: "dev1", user_code: "ABCD-1234", interval: 0 })
      );
    if (url === `${AUTH_BASE}/api/accounts/deviceauth/token`) {
      if (stub.device === "hang")
        return new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
        );
      return stub.device === "complete"
        ? new Response(
            JSON.stringify({ authorization_code: "AUTHCODE", code_verifier: "VERIFIER" })
          )
        : new Response("", { status: 403 });
    }
    if (url === `${AUTH_BASE}/oauth/token`)
      return stub.token(new URLSearchParams(String(init?.body)));
    throw new Error(`Unexpected external request ${url}`);
  });
  build({ testTimeoutMs: 500 });
});
afterEach(() => {
  settings.close();
  process.env = originalEnv;
  vi.unstubAllGlobals();
});
const request = (path: string, method = "GET", body?: unknown, origin?: string) =>
  app.request(`${prefix}${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
  });
const login = async (response: Response, status = 200): Promise<ProviderLogin> => {
  expect(response.status).toBe(status);
  return ((await response.json()) as { login: ProviderLogin }).login;
};
const start = async () => login(await request("/openai-codex/login", "POST"), 201);
const answer = (current: ProviderLogin, value: string, challengeId = current.challenge?.id) =>
  request(`/openai-codex/login/${current.id}/response`, "POST", { challengeId, value });
async function until(read: () => Promise<ProviderLogin>, done: (value: ProviderLogin) => boolean) {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("login did not reach expected state");
}
const poll = (current: ProviderLogin, done: (value: ProviderLogin) => boolean) =>
  until(async () => login(await request(`/openai-codex/login/${current.id}`)), done);
async function codex(): Promise<CopilotProvider> {
  const response = await request("");
  const item = ((await response.json()) as ProvidersResponse).providers.find(
    (entry) => entry.id === "openai-codex"
  );
  if (!item) throw new Error("expected codex");
  return item;
}
function firstModel(provider: CopilotProvider) {
  const model = provider.models[0];
  if (!model) throw new Error("expected a codex model");
  return model;
}
const authFile = () => join(settings.configDir, "auth.json");
const stored = () => JSON.parse(readFileSync(authFile(), "utf8"));
const device = async () => {
  const first = await start();
  expect(first.status).toBe("awaiting_user");
  await answer(first, "device_code");
  return first;
};

test("device-code login uses the real SDK adapter, persists privately and never exposes tokens", async () => {
  const first = await start();
  expect(first).toMatchObject({
    providerId: "openai-codex",
    status: "awaiting_user",
    challenge: { kind: "select", options: [{ id: "browser" }, { id: "device_code" }] },
  });
  const accepted = await login(await answer(first, "device_code"));
  expect(accepted.challenge).toBeNull();
  const done = await poll(first, (value) => value.status === "succeeded");
  // Finished logins keep only masked state; the device code was visible while running (see cancel test).
  expect(done.notices).toEqual([]);
  const listing = await (await request("")).text();
  for (const secret of [ACCESS, REFRESH, "AUTHCODE", "VERIFIER"]) {
    expect(listing).not.toContain(secret);
    expect(JSON.stringify(done)).not.toContain(secret);
  }
  const provider = await codex();
  expect(provider).toMatchObject({
    method: "oauth",
    credential: { configured: true, stored: true, source: "stored" },
    catalogStatus: "ready",
    login: { id: first.id, status: "succeeded" },
  });
  expect(provider.models.length).toBeGreaterThan(0);
  expect(stored()["openai-codex"]).toMatchObject({
    type: "oauth",
    access: ACCESS,
    refresh: REFRESH,
  });
  expect(readFileSync(authFile()).length).toBeGreaterThan(0);
  expect((await import("node:fs")).statSync(authFile()).mode & 0o777).toBe(0o600);
  // Reconnect: a fresh page load recovers the result from the server, not from client state.
  expect((await codex()).login?.status).toBe("succeeded");
});

test("browser login: auth URL, manual paste bound to state; wrong state fails without storing", async () => {
  const first = await start();
  const waiting = await login(await answer(first, "browser"));
  const current =
    waiting.status === "awaiting_user"
      ? waiting
      : await poll(first, (v) => v.challenge?.kind === "manual_code");
  expect(current.challenge?.kind).toBe("manual_code");
  const url = current.notices.find((notice) => notice.type === "auth_url");
  expect(url).toBeDefined();
  const state = new URL((url as { url: string }).url).searchParams.get("state");
  expect(state).toMatch(/^[0-9a-f]{32}$/);
  // Wrong state: rejected by the SDK adapter; the pasted code never appears in any response.
  const bad = await login(
    await answer(current, "http://localhost:1455/auth/callback?code=LEAKCODE&state=wrong")
  );
  const failed = await poll(bad, (value) => value.status === "failed");
  expect(failed.failure).toBe("invalid_response");
  expect(JSON.stringify(failed)).not.toContain("LEAKCODE");
  expect(existsSync(authFile())).toBe(false);
  // New login, correct state: succeeds.
  const second = await start();
  await answer(second, "browser");
  const manual = await poll(second, (v) => v.challenge?.kind === "manual_code");
  const goodState = new URL(
    (manual.notices.find((n) => n.type === "auth_url") as { url: string }).url
  ).searchParams.get("state");
  await answer(manual, `http://localhost:1455/auth/callback?code=GOODCODE&state=${goodState}`);
  expect((await poll(second, (v) => v.status === "succeeded")).status).toBe("succeeded");
  expect(stored()["openai-codex"].type).toBe("oauth");
});

test("response is bound to login instance and challengeId; invalid answers never reach the SDK", async () => {
  const first = await start();
  const wrongChallenge = await answer(first, "device_code", "00000000-0000-4000-8000-000000000000");
  expect(wrongChallenge.status).toBe(409);
  expect((await answer(first, "not-an-option")).status).toBe(400);
  expect(
    (
      await request(`/openai-codex/login/${first.id}/response`, "POST", {
        challengeId: "x",
        value: "y",
      })
    ).status
  ).toBe(400);
  // Cross-instance: old challenge cannot answer a new login.
  await request(`/openai-codex/login/${first.id}`, "DELETE");
  const second = await start();
  expect(second.id).not.toBe(first.id);
  expect((await answer(first, "device_code")).status).toBe(404);
  const crossed = await request(`/openai-codex/login/${second.id}/response`, "POST", {
    challengeId: first.challenge?.id,
    value: "device_code",
  });
  expect(crossed.status).toBe(409);
  expect((await login(await request(`/openai-codex/login/${second.id}`))).status).toBe(
    "awaiting_user"
  );
  expect((await request("/openai-codex/login/unknown")).status).toBe(404);
  expect(stub.calls).toEqual([]);
  // One active login per provider.
  expect((await request("/openai-codex/login", "POST")).status).toBe(409);
});

test("cancel aborts the SDK flow; a late result neither stores credentials nor touches the next login", async () => {
  stub.device = "hang";
  const first = await device();
  await poll(first, (v) => v.notices.some((n) => n.type === "device_code"));
  await until(
    async () => first,
    () => stub.calls.some((u) => u.endsWith("/deviceauth/token"))
  );
  const cancelled = await login(await request(`/openai-codex/login/${first.id}`, "DELETE"));
  expect(cancelled.status).toBe("cancelled");
  expect(stub.signals.some((signal) => signal.aborted)).toBe(true);
  // Aborted before any token exchange: nothing was ever stored.
  expect(existsSync(authFile())).toBe(false);
  stub.device = "complete";
  const second = await start();
  await answer(second, "device_code");
  await poll(second, (v) => v.status === "succeeded");
  // Old id is gone; nothing it does later can overwrite the newer instance.
  expect((await request(`/openai-codex/login/${first.id}`)).status).toBe(404);
  expect((await codex()).login).toMatchObject({ id: second.id, status: "succeeded" });
  // Cancel is idempotent for a finished login.
  expect((await login(await request(`/openai-codex/login/${second.id}`, "DELETE"))).status).toBe(
    "succeeded"
  );
});

test("cancelled login while awaiting the user leaves no credential", async () => {
  const first = await start();
  await request(`/openai-codex/login/${first.id}`, "DELETE");
  expect((await poll(first, (v) => v.status === "cancelled")).challenge).toBeNull();
  expect(existsSync(authFile())).toBe(false);
});

test("an unanswered login expires without credentials and can be restarted", async () => {
  settings.close();
  build({ loginTtlMs: 80 });
  const first = await start();
  const expired = await poll(first, (v) => v.status === "expired");
  expect(expired.failure).toBeNull();
  expect(existsSync(authFile())).toBe(false);
  expect((await answer(first, "device_code")).status).toBe(409);
  expect((await start()).status).toBe("awaiting_user");
});

test("token exchange failure is a fixed category, never echoes the provider body, keeps old auth bytes", async () => {
  mkdirSync(settings.configDir, { recursive: true, mode: 0o700 });
  chmodSync(settings.configDir, 0o700);
  const before = JSON.stringify({ openai: { type: "api_key", key: "SYNTHETIC_KEEP" } });
  writeFileSync(authFile(), before, { mode: 0o600 });
  stub.token = () => new Response("invalid_grant SECRET_BODY_TEXT", { status: 400 });
  const first = await device();
  const failed = await poll(first, (v) => v.status === "failed");
  expect(failed.failure).toBe("unavailable");
  expect(JSON.stringify(failed)).not.toContain("SECRET_BODY_TEXT");
  expect(readFileSync(authFile(), "utf8")).toBe(before);
  stub.calls.length = 0;
  stub.token = () => {
    throw new Error("fetch failed ECONNREFUSED");
  };
  const second = await device();
  expect((await poll(second, (v) => v.status === "failed")).failure).toBe("network");
  expect(readFileSync(authFile(), "utf8")).toBe(before);
});

test("logout removes only the stored login, cancels any active flow and reports environment-free state", async () => {
  await request("/openai/credential", "PUT", { key: "SYNTHETIC_OTHER_KEY" });
  const first = await device();
  await poll(first, (v) => v.status === "succeeded");
  const response = await request("/openai-codex/logout", "POST");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { saved: boolean; provider: CopilotProvider };
  expect(body.provider.credential).toMatchObject({
    stored: false,
    configured: false,
    source: "none",
  });
  expect(body.provider.login).toBeUndefined();
  expect(stored()["openai-codex"]).toBeUndefined();
  expect(stored().openai.key).toBe("SYNTHETIC_OTHER_KEY");
  expect((await request(`/openai-codex/login/${first.id}`)).status).toBe(404);
  // Logout while a flow is still waiting cancels it too.
  const waiting = await start();
  await request("/openai-codex/logout", "POST");
  expect((await request(`/openai-codex/login/${waiting.id}`)).status).toBe(404);
  // API-key providers use credential removal, not login/logout.
  expect((await request("/openai/logout", "POST")).status).toBe(400);
  expect((await request("/openai/login", "POST")).status).toBe(400);
});

test("logout invalidates an in-flight connection check; after logout checks report credentials", async () => {
  const first = await device();
  await poll(first, (v) => v.status === "succeeded");
  const model = firstModel(await codex());
  const draft = {
    baseUrl: model.baseUrl,
    modelId: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    image: model.image,
    tools: true,
    defaultThinking: null,
  };
  const runtime = await settings.getRuntime();
  const ai = await import("@earendil-works/pi-ai");
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  runtime.registerProvider("openai-codex", {
    api: "openai-codex-responses",
    streamSimple() {
      started();
      return ai.createAssistantMessageEventStream(); // never completes: only abort can end it
    },
  });
  const pending = request("/openai-codex/test", "POST", draft);
  await running;
  await request("/openai-codex/logout", "POST");
  const result = (await (await pending).json()) as ProviderTestResult;
  expect(result.code).toBe("cancelled");
  const after = (await (
    await request("/openai-codex/test", "POST", draft)
  ).json()) as ProviderTestResult;
  expect(after).toEqual({ code: "credentials", retryable: true });
});

test("token refresh failure is distinct from never signed in, preserves bytes and recovers", async () => {
  const first = await device();
  await poll(first, (v) => v.status === "succeeded");
  const data = stored();
  data["openai-codex"].expires = Date.now() - 1000;
  writeFileSync(authFile(), JSON.stringify(data, null, 2), { mode: 0o600 });
  settings.close();
  build({ testTimeoutMs: 500 });
  const model = firstModel(await codex());
  const draft = {
    baseUrl: model.baseUrl,
    modelId: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    image: model.image,
    tools: true,
    defaultThinking: null,
  };
  const before = readFileSync(authFile(), "utf8");
  stub.token = () => new Response("SECRET_REFRESH_BODY", { status: 400 });
  const failed = (await (
    await request("/openai-codex/test", "POST", draft)
  ).json()) as ProviderTestResult;
  expect(failed).toEqual({ code: "refresh_failed", retryable: true });
  expect(readFileSync(authFile(), "utf8")).toBe(before);
  const provider = await codex();
  expect(provider.credential).toMatchObject({
    stored: true,
    source: "stored",
    refreshFailed: true,
  });
  expect(JSON.stringify(provider)).not.toContain("SECRET_REFRESH_BODY");
  // Signing in again clears the refresh-failure state.
  stub.token = tokenOk;
  const again = await device();
  await poll(again, (v) => v.status === "succeeded");
  expect((await codex()).credential.refreshFailed).toBeUndefined();
});

test("sign-in persisted but catalog refresh failing is reported separately from login success", async () => {
  const runtime = await settings.getRuntime();
  runtime.registerProvider("openai-codex", {
    api: "openai-codex-responses",
    refreshModels: async () => {
      throw new Error("SYNTHETIC catalog failure");
    },
  });
  const first = await device();
  const done = await poll(first, (v) => v.status === "succeeded");
  expect(done.failure).toBeNull();
  expect(stored()["openai-codex"].type).toBe("oauth");
  const provider = await codex();
  expect(provider.credential.stored).toBe(true);
  expect(provider.catalogStatus).toBe("error");
});

test("login routes keep the same-origin guard and cross-site requests cannot start, answer or cancel", async () => {
  const first = await start();
  const evil = "https://evil.example";
  expect((await request("/openai-codex/login", "POST", undefined, evil)).status).toBe(403);
  expect(
    (
      await request(
        `/openai-codex/login/${first.id}/response`,
        "POST",
        { challengeId: first.challenge?.id, value: "device_code" },
        evil
      )
    ).status
  ).toBe(403);
  expect((await request(`/openai-codex/login/${first.id}`, "DELETE", undefined, evil)).status).toBe(
    403
  );
  expect((await request("/openai-codex/logout", "POST", undefined, evil)).status).toBe(403);
  expect((await login(await request(`/openai-codex/login/${first.id}`))).status).toBe(
    "awaiting_user"
  );
});

test("default thinking for a codex model uses the SDK-supported levels after sign-in", async () => {
  const first = await device();
  await poll(first, (v) => v.status === "succeeded");
  const model = (await codex()).models.find((item) => item.thinkingLevels.length > 1);
  if (!model) throw new Error("expected a reasoning codex model");
  const config = {
    baseUrl: model.baseUrl,
    modelId: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    image: model.image,
    tools: true,
  };
  const level = model.thinkingLevels.at(-1);
  expect(
    (await request("/openai-codex/config", "PUT", { ...config, defaultThinking: level })).status
  ).toBe(200);
  const unsupported = (["minimal", "low", "medium", "high", "xhigh", "max"] as const).find(
    (item) => !model.thinkingLevels.includes(item)
  );
  if (unsupported)
    expect(
      (await request("/openai-codex/config", "PUT", { ...config, defaultThinking: unsupported }))
        .status
    ).toBe(400);
  expect((await codex()).models.find((item) => item.id === model.id)?.defaultThinking).toBe(level);
});

test("logout whose catalog synchronization fails still reports signed out, with the catalog error separate", async () => {
  const first = await device();
  await poll(first, (v) => v.status === "succeeded");
  const runtime = await settings.getRuntime();
  runtime.registerProvider("openai-codex", {
    api: "openai-codex-responses",
    refreshModels: async () => {
      throw new Error("SYNTHETIC catalog failure");
    },
  });
  const response = await request("/openai-codex/logout", "POST");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { provider: CopilotProvider };
  expect(body.provider.credential).toMatchObject({ stored: false, source: "none" });
  expect(body.provider.catalogStatus).toBe("error");
  expect(stored()["openai-codex"]).toBeUndefined();
});

test("a cancel racing the credential write is reported as the signed-in state the disk shows", async () => {
  // Hold the settings lock so the login finishes in the SDK but cannot yet be recorded.
  const lock = (settings as unknown as { lock: { run<T>(fn: () => Promise<T>): Promise<T> } }).lock;
  let release!: () => void;
  const held = lock.run(() => new Promise<void>((resolve) => (release = resolve)));
  const first = await device();
  await until(
    async () => first,
    () => existsSync(authFile())
  );
  const cancelled = await login(await request(`/openai-codex/login/${first.id}`, "DELETE"));
  expect(cancelled.status).toBe("cancelled");
  release();
  await held;
  const done = await poll(first, (v) => v.status === "succeeded");
  expect(done.notices).toEqual([]);
  expect(stored()["openai-codex"].type).toBe("oauth");
  expect((await codex()).credential).toMatchObject({ stored: true, source: "stored" });
});

test("terminal login results carry no challenge text, notices or SDK labels", async () => {
  const first = await start();
  expect(JSON.stringify(first.challenge)).not.toContain("Select OpenAI");
  expect(JSON.stringify(first.challenge)).not.toContain("Browser login");
  await answer(first, "device_code");
  const done = await poll(first, (v) => v.status === "succeeded");
  expect(done.notices).toEqual([]);
  expect(done.challenge).toBeNull();
});

test("a credential-store failure is storage, not a token refresh failure", async () => {
  const first = await device();
  await poll(first, (v) => v.status === "succeeded");
  const data = stored();
  data["openai-codex"].expires = Date.now() - 1000;
  writeFileSync(authFile(), JSON.stringify(data, null, 2), { mode: 0o600 });
  settings.close();
  build({ testTimeoutMs: 500 });
  const model = firstModel(await codex());
  const draft = {
    baseUrl: model.baseUrl,
    modelId: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    image: model.image,
    tools: true,
    defaultThinking: null,
  };
  chmodSync(authFile(), 0o644); // the store refuses unsafe modes: a storage fault
  const result = (await (
    await request("/openai-codex/test", "POST", draft)
  ).json()) as ProviderTestResult;
  expect(result.code).not.toBe("refresh_failed");
  chmodSync(authFile(), 0o600);
  expect((await codex()).credential.refreshFailed).toBeUndefined();
});
