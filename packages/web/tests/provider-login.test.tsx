import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CopilotProvider, ProviderLogin } from "@argelanderspace/contracts";
import { ProviderSettingsDialog } from "../src/copilot/ProviderSettings";
import i18n from "../src/i18n";

const model = { id: "gpt-5.5", name: "GPT-5.5", baseUrl: "https://offline.invalid", contextWindow: 1000, maxTokens: 128, image: true, tools: true, thinkingLevels: ["off", "low", "high"] as const, capabilitiesKnown: true, defaultThinking: null, defaultThinkingValid: true };
let provider: CopilotProvider;
let calls: { url: string; method: string; body?: unknown }[];
let handlers: Record<string, (body?: unknown) => Response | Promise<Response>>;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const login = (patch: Partial<ProviderLogin> = {}): ProviderLogin => ({ id: "11111111-1111-4111-8111-111111111111", providerId: "openai-codex", status: "awaiting_user", challenge: { id: "22222222-2222-4222-8222-222222222222", kind: "select", options: [{ id: "browser" }, { id: "device_code" }] }, notices: [], failure: null, startedAt: 1, expiresAt: 2, ...patch });
const device = { type: "device_code" as const, userCode: "ABCD-1234", verificationUri: "https://auth.openai.com/codex/device", intervalSeconds: 5, expiresInSeconds: 900 };
beforeEach(async () => {
  await i18n.changeLanguage("en");
  localStorage.clear();
  provider = { id: "openai-codex", name: "OpenAI Codex", method: "oauth", credential: { configured: false, stored: false, source: "none" }, catalogStatus: "ready", models: [{ ...model, thinkingLevels: [...model.thinkingLevels] }] };
  calls = []; handlers = {};
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    const method = options?.method ?? "GET"; const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    calls.push({ url, method, body });
    const route = Object.keys(handlers).find((key) => key === `${method} ${url.replace("/api/copilot/providers", "")}`);
    if (route) return handlers[route](body);
    if (method === "GET" && url === "/api/copilot/providers") return json({ version: 1, providers: [provider] });
    return json({ code: "not_found" }, 404);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const open = async () => {
  render(<ProviderSettingsDialog onClose={vi.fn()} />);
  await screen.findByText("OpenAI Codex");
  return document.querySelector('[data-ui="provider-card"][data-ui-key="openai-codex"]') as HTMLElement;
};
const ui = (card: HTMLElement, key: string) => card.querySelector(`[data-ui="${key}"]`) as HTMLElement;
const base = "/openai-codex/login";

test("sign-in: choose device code, show the code, follow polling to success and refresh the model catalog", async () => {
  const first = login();
  handlers[`POST ${base}`] = () => json({ login: first }, 201);
  handlers[`POST ${base}/${first.id}/response`] = () => json({ login: login({ status: "running", challenge: null, notices: [device] }) });
  handlers[`GET ${base}/${first.id}`] = () => json({ login: login({ status: "succeeded", challenge: null, notices: [device] }) });
  const card = await open();
  expect(ui(card, "provider-logout")).toHaveProperty("disabled", true);
  fireEvent.click(ui(card, "provider-login-start"));
  await waitFor(() => expect(ui(card, "provider-login-method-device_code")).toBeTruthy());
  expect(ui(card, "provider-login-method-browser").textContent).toBe("Browser sign-in");
  expect(ui(card, "provider-login-start")).toHaveProperty("disabled", true);
  fireEvent.click(ui(card, "provider-login-method-device_code"));
  await waitFor(() => expect(ui(card, "provider-login-code").textContent).toBe("ABCD-1234"));
  expect(calls.find((call) => call.url.endsWith("/response"))?.body).toEqual({ challengeId: first.challenge?.id, value: "device_code" });
  expect(ui(card, "provider-login-link").getAttribute("rel")).toContain("noopener");
  // The stored login arrives from the authoritative provider listing, not from the poll reply.
  provider = { ...provider, credential: { configured: true, stored: true, source: "stored" } };
  await waitFor(() => expect(ui(card, "provider-login-state").textContent).toMatch(/^Signed in/), { timeout: 3000 });
  expect(ui(card, "provider-logout")).toHaveProperty("disabled", false);
  expect(ui(card, "provider-login-start").textContent).toBe("Sign in again");
  expect(localStorage.length).toBe(0);
});

test("manual code is masked, submitted once with the challenge id and then cleared", async () => {
  const waiting = login({ challenge: { id: "33333333-3333-4333-8333-333333333333", kind: "manual_code", options: [] }, notices: [{ type: "auth_url", url: "https://auth.openai.com/oauth/authorize?state=abc" }] });
  provider = { ...provider, login: waiting };
  handlers[`GET ${base}/${waiting.id}`] = () => json({ login: waiting });
  handlers[`POST ${base}/${waiting.id}/response`] = () => json({ login: login({ status: "running", challenge: null }) });
  const card = await open();
  expect(ui(card, "provider-login-link").getAttribute("href")).toContain("auth.openai.com");
  const input = ui(card, "provider-login-code-input") as HTMLInputElement;
  expect(input.type).toBe("password");
  fireEvent.change(input, { target: { value: "http://localhost:1455/auth/callback?code=SYNTHETIC&state=abc" } });
  fireEvent.click(ui(card, "provider-login-submit"));
  await waitFor(() => expect(card.querySelector('[data-ui="provider-login-code-input"]')).toBeNull());
  expect(calls.filter((call) => call.url.endsWith("/response"))).toHaveLength(1);
  expect(JSON.stringify(document.body.innerHTML)).not.toContain("SYNTHETIC");
});

test("a reloaded dialog resumes the server login and cancelling ignores a late reply from the cancelled instance", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const running = login({ status: "running", challenge: null, notices: [device] });
  provider = { ...provider, login: running };
  let release: (() => void) | undefined;
  handlers[`GET ${base}/${running.id}`] = () => new Promise<Response>((resolve) => { release = () => resolve(json({ login: { ...running, status: "succeeded" } })); });
  handlers[`DELETE ${base}/${running.id}`] = () => json({ login: { ...running, status: "cancelled" } });
  const second = login({ id: "44444444-4444-4444-8444-444444444444" });
  handlers[`POST ${base}`] = () => json({ login: second }, 201);
  const card = await open();
  expect(ui(card, "provider-login-code").textContent).toBe("ABCD-1234");
  await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
  expect(release).toBeDefined();
  fireEvent.click(ui(card, "provider-login-cancel"));
  await waitFor(() => expect(ui(card, "provider-login-panel").getAttribute("data-status")).toBe("cancelled"));
  expect(ui(card, "provider-login-status").textContent).toBe("Sign-in cancelled.");
  fireEvent.click(ui(card, "provider-login-start"));
  await waitFor(() => expect(ui(card, "provider-login-panel").getAttribute("data-status")).toBe("awaiting_user"));
  await act(async () => { release?.(); });
  // The old instance's late "succeeded" cannot replace the new login.
  expect(ui(card, "provider-login-panel").getAttribute("data-status")).toBe("awaiting_user");
  expect(ui(card, "provider-login-state").textContent).toMatch(/^Not signed in/);
});

test.each([
  ["expired", null, "Sign-in expired. Start again."],
  ["failed", "invalid_response", "The sign-in response was not accepted. Start again."],
  ["failed", "network", "Cannot reach the sign-in service. Check the network, then start again."],
  ["cancelled", null, "Sign-in cancelled."],
] as const)("terminal %s/%s result is shown in English and Chinese and a new sign-in can start", async (status, failure, text) => {
  provider = { ...provider, login: login({ status, failure, challenge: null }) };
  const card = await open();
  expect(ui(card, "provider-login-status").textContent).toBe(text);
  expect(ui(card, "provider-login-start")).toHaveProperty("disabled", false);
  expect(ui(card, "provider-login-cancel")).toBeNull();
  cleanup();
  await i18n.changeLanguage("zh-CN");
  const zh = await open();
  expect(ui(zh, "provider-login-status").textContent).not.toBe(text);
  expect(ui(zh, "provider-login-status").textContent).toMatch(/[一-鿿]/);
});

test("sign-out removes the stored login, invalidates the connection result and a refresh failure is distinct", async () => {
  provider = { ...provider, credential: { configured: true, stored: true, source: "stored", refreshFailed: true } };
  handlers["POST /openai-codex/logout"] = () => json({ saved: true, provider: { ...provider, credential: { configured: false, stored: false, source: "none" } } });
  handlers["POST /openai-codex/test"] = () => json({ code: "refresh_failed", retryable: true });
  const card = await open();
  expect(within(card).getByRole("alert").textContent).toContain("Refreshing the saved sign-in failed");
  fireEvent.click(card.querySelector('[data-ui="provider-advanced-openai-codex"] > summary')!);
  fireEvent.click(ui(card, "provider-test-openai-codex"));
  await waitFor(() => expect(ui(card, "provider-test-result-openai-codex").textContent).toContain("Refreshing the saved sign-in failed"));
  fireEvent.click(ui(card, "provider-logout"));
  await waitFor(() => expect(ui(card, "provider-login-state").textContent).toMatch(/^Not signed in/));
  expect(ui(card, "provider-test-result-openai-codex").textContent).toBe("Not tested");
  expect(ui(card, "provider-save-result").textContent).toContain("Signed out");
  expect(ui(card, "provider-logout")).toHaveProperty("disabled", true);
});

test("a busy sign-in start and a stale answer are reported without losing the login view", async () => {
  handlers[`POST ${base}`] = () => json({ code: "busy" }, 409);
  const card = await open();
  fireEvent.click(ui(card, "provider-login-start"));
  await waitFor(() => expect(ui(card, "provider-login-problem").textContent).toBe("A sign-in is already in progress."));
  const current = login();
  handlers[`POST ${base}`] = () => json({ login: current }, 201);
  handlers[`POST ${base}/${current.id}/response`] = () => json({ code: "stale" }, 409);
  handlers[`GET ${base}/${current.id}`] = () => json({ login: { ...current, challenge: { ...current.challenge!, id: "55555555-5555-4555-8555-555555555555" } } });
  fireEvent.click(ui(card, "provider-login-start"));
  await waitFor(() => expect(ui(card, "provider-login-method-browser")).toBeTruthy());
  fireEvent.click(ui(card, "provider-login-method-browser"));
  await waitFor(() => expect(ui(card, "provider-login-problem")).toBeTruthy());
  expect(ui(card, "provider-login-method-browser")).toBeTruthy();
});

test("a succeeded login never claims a model refresh the catalog status contradicts, even after reopening", async () => {
  provider = { ...provider, catalogStatus: "error", credential: { configured: true, stored: true, source: "stored" }, login: login({ status: "succeeded", challenge: null }) };
  const card = await open();
  expect(ui(card, "provider-catalog-error").textContent).toContain("model catalog could not refresh");
  expect(ui(card, "provider-login-status").textContent).toBe("Signed in.");
  expect(card.textContent).not.toContain("model list was refreshed");
  cleanup();
  provider = { ...provider, catalogStatus: "ready" };
  const healthy = await open();
  expect(healthy.querySelector('[data-ui="provider-catalog-error"]')).toBeNull();
  expect(ui(healthy, "provider-login-status").textContent).toBe("Signed in.");
});

test("an unknown sign-in method id uses a localized generic label, never SDK prose", async () => {
  provider = { ...provider, login: login({ challenge: { id: "66666666-6666-4666-8666-666666666666", kind: "select", options: [{ id: "sso_new" }] } }) };
  const card = await open();
  expect(ui(card, "provider-login-method-sso_new").textContent).toBe("Other sign-in method");
  cleanup();
  await i18n.changeLanguage("zh-CN");
  const zh = await open();
  expect(ui(zh, "provider-login-method-sso_new").textContent).toMatch(/[\u4e00-\u9fff]/);
});

test("cancelling a sign-in invalidates an in-flight connection check; its late result is ignored", async () => {
  const running = login({ status: "running", challenge: null, notices: [device] });
  provider = { ...provider, login: running };
  let finish: ((value: Response) => void) | undefined;
  let signal: AbortSignal | undefined;
  handlers[`GET ${base}/${running.id}`] = () => json({ login: running });
  handlers[`DELETE ${base}/${running.id}`] = () => json({ login: { ...running, status: "cancelled", notices: [] } });
  handlers["POST /openai-codex/test"] = () => new Promise<Response>((resolve) => { finish = resolve; });
  const card = await open();
  fireEvent.click(card.querySelector('[data-ui="provider-advanced-openai-codex"] > summary')!);
  fireEvent.click(ui(card, "provider-test-openai-codex"));
  await waitFor(() => expect(ui(card, "provider-test-result-openai-codex").textContent).toContain("Testing"));
  const sent = vi.mocked(fetch).mock.calls.find((call) => String(call[0]).endsWith("/test"));
  signal = (sent?.[1] as RequestInit | undefined)?.signal ?? undefined;
  fireEvent.click(ui(card, "provider-login-cancel"));
  await waitFor(() => expect(ui(card, "provider-test-result-openai-codex").textContent).toBe("Not tested"));
  expect(signal?.aborted).toBe(true);
  await act(async () => { finish?.(json({ code: "success", retryable: false })); });
  expect(ui(card, "provider-test-result-openai-codex").textContent).toBe("Not tested");
});
