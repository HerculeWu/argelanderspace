import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CopilotProvider, ProviderTestResult } from "@argelanderspace/contracts";
import { ProviderSettingsDialog } from "../src/copilot/ProviderSettings";
import i18n from "../src/i18n";

const catalog = (id = "openai"): CopilotProvider => ({ id, name: id === "openai" ? "OpenAI" : "Anthropic", method: "api_key", credential: { configured: false, stored: false, source: "none" }, catalogStatus: "ready", models: [
  { id: "reasoning", name: "Reasoning", baseUrl: "https://offline.invalid", contextWindow: 1000, maxTokens: 128, image: true, tools: true, thinkingLevels: ["off", "low", "high"], capabilitiesKnown: true, defaultThinking: "high", defaultThinkingValid: true },
  { id: "plain", name: "Plain", baseUrl: "https://offline.invalid", contextWindow: 1000, maxTokens: 128, image: false, tools: true, thinkingLevels: ["off"], capabilitiesKnown: true, defaultThinking: "high", defaultThinkingValid: false },
] });
let testResolve: ((value: Response) => void) | undefined;
let saveResolve: ((value: Response) => void) | undefined;
let testSignal: AbortSignal | undefined;
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
beforeEach(async () => {
  await i18n.changeLanguage("en");
  localStorage.clear();
  testResolve = undefined; saveResolve = undefined; testSignal = undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/test")) {
      testSignal = options?.signal ?? undefined;
      return new Promise<Response>((resolve) => { testResolve = resolve; });
    }
    if (url.endsWith("/credential")) return new Promise<Response>((resolve) => { saveResolve = resolve; });
    return json({ version: 1, providers: [catalog(), catalog("anthropic")] });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const open = async () => {
  render(<ProviderSettingsDialog onClose={vi.fn()} />);
  await screen.findByText("OpenAI");
  const card = document.querySelector('[data-ui="provider-card"][data-ui-key="openai"]') as HTMLElement;
  fireEvent.click(card.querySelector('[data-ui="provider-advanced-openai"] > summary')!);
  return card;
};

test("uses current capability options, lets an invalid old default be cleared, and disables invented custom levels", async () => {
  const card = await open();
  const thinking = card.querySelector('[data-ui="provider-default-thinking-openai"]') as HTMLSelectElement;
  expect([...thinking.options].map((option) => option.value)).toEqual(["", "off", "low", "high"]);
  fireEvent.change(card.querySelector('[data-ui="provider-model"]')!, { target: { value: "plain" } });
  expect(thinking.disabled).toBe(false);
  expect(within(card).getAllByText(/saved thinking level is unsupported/).length).toBeGreaterThan(0);
  fireEvent.change(thinking, { target: { value: "" } });
  expect((card.querySelector('[data-ui="provider-save-config-openai"]') as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(card.querySelector('[data-ui="provider-model-id"]')!, { target: { value: "custom" } });
  expect(thinking.disabled).toBe(true);
  expect([...thinking.options].map((option) => option.value)).toEqual([""]);
});

test("editing and credential changes invalidate connection results; cancellation ignores a late reply", async () => {
  const card = await open();
  const check = () => card.querySelector('[data-ui="provider-test-result-openai"]')!;
  const start = () => fireEvent.click(card.querySelector('[data-ui="provider-test-openai"]')!);
  start();
  await waitFor(() => expect(testResolve).toBeDefined());
  const first = testResolve!;
  fireEvent.change(card.querySelector('[data-ui="provider-base-url"]')!, { target: { value: "https://changed.invalid" } });
  expect(testSignal?.aborted).toBe(true);
  first(json({ code: "success", retryable: false } satisfies ProviderTestResult));
  await waitFor(() => expect(check().textContent).toBe("Not tested"));
  fireEvent.change(card.querySelector('[data-ui="provider-default-thinking-openai"]')!, { target: { value: "" } });
  start(); await waitFor(() => expect(check().textContent).toContain("Testing"));
  const second = testResolve!;
  fireEvent.click(within(card).getByRole("button", { name: "Cancel" }));
  second(json({ code: "success", retryable: false } satisfies ProviderTestResult));
  await waitFor(() => expect(check().textContent).toContain("cancelled"));
  fireEvent.change(card.querySelector('[data-ui="provider-api-key"]')!, { target: { value: "SYNTHETIC_UI_KEY" } });
  expect(check().textContent).toBe("Not tested");
  expect(localStorage.length).toBe(0);
});

test("all cards and dismissal are protected during credential save; secret is cleared on success", async () => {
  const card = await open();
  const secret = card.querySelector('[data-ui="provider-api-key"]') as HTMLInputElement;
  fireEvent.change(secret, { target: { value: "SYNTHETIC_UI_KEY" } });
  fireEvent.click(card.querySelector('[data-ui="provider-save-key"]')!);
  await waitFor(() => expect(saveResolve).toBeDefined());
  expect([...document.querySelectorAll("fieldset")].every((fieldset) => fieldset.disabled)).toBe(true);
  expect(document.querySelector('[data-ui="provider-settings"]')?.getAttribute("aria-busy")).toBe("true");
  saveResolve!(json({ saved: true, provider: { ...catalog(), credential: { configured: true, stored: true, source: "stored" } } }));
  await waitFor(() => expect(secret.value).toBe(""));
  expect(screen.getByText("Saved. Connection testing is a separate action.")).toBeTruthy();
  expect(localStorage.length).toBe(0);
});


test("custom endpoint invalidates known-model thinking until its saved default is cleared", async () => {
  const card = await open();
  const thinking = card.querySelector('[data-ui="provider-default-thinking-openai"]') as HTMLSelectElement;
  fireEvent.change(card.querySelector('[data-ui="provider-base-url"]')!, { target: { value: "https://custom.invalid" } });
  expect([...thinking.options].map((option) => option.value)).toEqual(["", "high"]);
  expect((card.querySelector('[data-ui="provider-save-config-openai"]') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(thinking, { target: { value: "" } });
  expect(thinking.disabled).toBe(true);
  expect([...thinking.options].map((option) => option.value)).toEqual([""]);
  expect((card.querySelector('[data-ui="provider-save-config-openai"]') as HTMLButtonElement).disabled).toBe(false);
});
