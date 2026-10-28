/**
 * The Copilot side of the intake entries (project-intake ticket 06; approved prototype, ticket 05 review): a request
 * from the Library opens a NEW conversation and sends one fixed, visible message in the user's name (no hidden
 * trigger). Without a usable model the panel says so in a card with "Open model settings"; after the model is saved the
 * user starts it from a second card — nothing is sent on its own.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConversationSnapshot, CopilotFileToolsSetting, CopilotProvider, PageContext } from "@argelanderspace/contracts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Copilot } from "../src/copilot/Copilot";
import type { IntakeRequest } from "../src/copilot/intake";
import i18n from "../src/i18n";
import { chooseOption, selectShown } from "./select-helpers";

vi.mock("../src/api/ws", () => ({ subscribeCopilot: (subscription: { ready: () => void }) => { queueMicrotask(subscription.ready); return () => {}; } }));
const context: PageContext = { version: 1, viewId: "00000000-0000-4000-8000-000000000001", paneId: 1, revision: 1, view: "library", status: "unavailable", otherPanes: [], plan: null };
const fresh = (id: string): ConversationSnapshot => ({ version: 1, conversation: { version: 1, id, sessionId: "00000000-0000-4000-8000-000000000003", title: "", createdAt: "2026-10-27", updatedAt: "2026-10-27", model: { provider: "openai", model: "test", thinking: null }, run: null }, messages: [], confirmations: [], stream: "", eventCursor: { instanceId: "00000000-0000-4000-8000-000000000004", seq: 1 } });
const existing = fresh("00000000-0000-4000-8000-0000000000e0");
const ready: CopilotProvider = { id: "openai", name: "OpenAI", method: "api_key", credential: { configured: true, stored: true, source: "stored" }, catalogStatus: "ready", models: [{ id: "test", name: "Test", baseUrl: "https://example.invalid", contextWindow: 10000, maxTokens: 1000, tools: true, image: false, thinkingLevels: ["off", "low", "high"], capabilitiesKnown: true, defaultThinking: "high", defaultThinkingValid: true }] };
const unset: CopilotProvider = { ...ready, credential: { configured: false, stored: false, source: "none" } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

let providers: CopilotProvider[];
let created: string[];
let createdModels: unknown[];
let catalogFails: boolean;
let noConversations: boolean;
let createDelay: Promise<void> | null;
let pending: number;
let fetchMock: ReturnType<typeof vi.fn>;
const calls = (suffix: string, method = "POST") => fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith(suffix) && (init?.method ?? "GET") === method);
const sentTexts = () => calls("/messages").map(([, init]) => JSON.parse(init.body as string).text as string);

beforeEach(async () => {
  await i18n.changeLanguage("en");
  providers = [ready]; created = []; createdModels = []; catalogFails = false; noConversations = false; createDelay = null; pending = 0;
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    pending++;
    try { return await answer(url, init); } finally { pending--; }
  });
  vi.stubGlobal("fetch", fetchMock);
});
const answer = async (url: string, init?: RequestInit) => {
    const where = String(url);
    if (where.endsWith("/providers")) return catalogFails ? json({ error: "down" }, 500) : json({ version: 1, providers });
    if (where.endsWith("/conversations") && init?.method === "POST") { await createDelay; createdModels.push(JSON.parse(init.body as string).model); const id = `00000000-0000-4000-8000-0000000000${created.length + 10}`; created.push(id); return json(fresh(id), 201); }
    if (where.endsWith("/conversations")) return json({ version: 1, conversations: noConversations ? [] : [existing.conversation] });
    if (where.endsWith("/messages")) return json({ messageId: "message", runId: "run" }, 202);
    if (where.includes("/views/")) return json({ saved: true });
    const id = where.split("/conversations/")[1];
    return json(id && created.includes(id) ? fresh(id) : existing);
};
// what the panel still has in flight when a test ends (the reread after a send, the page publication) settles on the stub, not on the network guard: unmount stops the chain, then wait until no request is open
afterEach(async () => { cleanup(); await waitFor(() => expect(pending).toBe(0)); vi.unstubAllGlobals(); });
// Nothing more is coming: neither the number of requests made nor the number open changed for several macrotasks in a row (the chain's steps between two requests are microtasks, so a gap that long is the end of it, not a pause; a request held on purpose stays open and counts as unchanged). Replaces a fixed wait: a late duplicate would have shown as a new request.
const settle = async () => { for (let quiet = 0, last = ""; quiet < 5;) { await new Promise((resolve) => setTimeout(resolve, 0)); const now = `${fetchMock.mock.calls.length}/${pending}`; quiet = now === last ? quiet + 1 : 0; last = now; } };

const panel = (intakeAsked?: IntakeRequest, fileTools?: CopilotFileToolsSetting, openSettings?: () => void) => <Copilot open context={context} onClose={vi.fn()} {...(intakeAsked ? { intakeAsked } : {})} {...(fileTools ? { fileTools } : {})} {...(openSettings ? { onOpenFileToolsSettings: openSettings } : {})} />;

test("a request with a usable model opens a new conversation (not the remembered one) and sends the fixed message once, after publishing the page", async () => {
  const view = render(panel({ seq: 0, kind: "start" }));
  await screen.findByText("Copilot");
  await waitFor(() => expect(document.querySelector('[data-ui="copilot-model"]')).not.toBeNull());
  expect(sentTexts()).toEqual([]); // the initial seq is not a request
  view.rerender(panel({ seq: 1, kind: "start" }));
  await waitFor(() => expect(sentTexts()).toEqual(["Start the intake: import my existing project"]));
  expect(created).toHaveLength(1);
  const sent = calls("/messages")[0]!;
  expect(String(sent[0])).toContain(`/conversations/${created[0]}/messages`);
  const body = JSON.parse(sent[1].body as string);
  expect(body).toMatchObject({ viewId: context.viewId, contextRevision: 1 });
  expect(body.clientMessageId).toMatch(/^[0-9a-f-]{36}$/);
  const order = fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? "GET"} ${String(url).replace(/.*\/api\/copilot/, "")}`);
  expect(order.findIndex((line) => line.startsWith("PUT /views/"))).toBeLessThan(order.findIndex((line) => line.endsWith("/messages")));
  expect(document.querySelector('[data-ui="copilot-no-provider"]')).toBeNull();
});

test("resume sends its own fixed message; the same kind asked twice is two new conversations", async () => {
  const view = render(panel({ seq: 0, kind: "resume" }));
  await screen.findByText("Copilot");
  view.rerender(panel({ seq: 1, kind: "resume" }));
  await waitFor(() => expect(sentTexts()).toEqual(["Continue the intake of my existing project"]));
  view.rerender(panel({ seq: 2, kind: "resume" }));
  await waitFor(() => expect(sentTexts()).toHaveLength(2));
  expect(created).toHaveLength(2);
  expect(new Set(calls("/messages").map(([url]) => String(url).split("/")[String(url).split("/").indexOf("conversations") + 1])).size).toBe(2);
});

test("the message is in the language of the page", async () => {
  await i18n.changeLanguage("zh-CN");
  const view = render(panel({ seq: 0, kind: "start" }));
  await screen.findByText("Copilot");
  view.rerender(panel({ seq: 1, kind: "start" }));
  await waitFor(() => expect(sentTexts()).toEqual(["开始迁入已有项目"]));
});

test("without a usable model: a card with Open model settings, nothing created or sent; after the model is saved a Start card, and only its button starts", async () => {
  providers = [unset];
  const view = render(panel({ seq: 0, kind: "start" }));
  await screen.findByText("Copilot");
  view.rerender(panel({ seq: 1, kind: "start" }));
  const card = await waitFor(() => { const found = document.querySelector<HTMLElement>('[data-ui="copilot-no-provider"]'); expect(found).not.toBeNull(); return found!; });
  expect(card.textContent).toContain("No model is available yet");
  expect(created).toEqual([]); expect(sentTexts()).toEqual([]);
  fireEvent.click(card.querySelector('[data-ui="open-provider-settings"]')!);
  await waitFor(() => expect(document.querySelector('[data-ui="provider-settings"]')).not.toBeNull());
  // the model gets saved in the dialog; closing it reads the catalog again
  providers = [ready];
  await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Close" }).slice(-1)[0]!); });
  const next = await waitFor(() => { const found = document.querySelector<HTMLElement>('[data-ui="copilot-provider-ready"]'); expect(found).not.toBeNull(); return found!; });
  expect(document.querySelector('[data-ui="copilot-no-provider"]')).toBeNull();
  expect(next.textContent).toContain("Ready: a model is set up.");
  await settle();
  expect(created).toEqual([]); expect(sentTexts()).toEqual([]); // not on its own
  fireEvent.click(next.querySelector('[data-ui="start-intake-after-provider"]')!);
  await waitFor(() => expect(sentTexts()).toEqual(["Start the intake: import my existing project"]));
  expect(created).toHaveLength(1);
  expect(document.querySelector('[data-ui="copilot-provider-ready"]')).toBeNull();
});

test("starting a conversation by hand drops the waiting card", async () => {
  providers = [unset];
  const view = render(panel({ seq: 0, kind: "start" }));
  await screen.findByText("Copilot");
  view.rerender(panel({ seq: 1, kind: "start" }));
  await waitFor(() => expect(document.querySelector('[data-ui="copilot-no-provider"]')).not.toBeNull());
  fireEvent.click(document.querySelector('[data-ui="copilot-new-conversation"]')!);
  await waitFor(() => expect(document.querySelector('[data-ui="copilot-no-provider"]')).toBeNull());
  expect(sentTexts()).toEqual([]);
});

const twoModels: CopilotProvider = { ...ready, models: [ready.models[0]!, { ...ready.models[0]!, id: "other", name: "Other" }] };
const noSend = async () => { await settle(); expect(created).toEqual([]); expect(sentTexts()).toEqual([]); };
const failedCard = () => document.querySelector<HTMLElement>('[data-ui="copilot-intake-catalog-failed"]');

test("the catalog cannot be read: a card says so with Retry, nothing is created or sent; closing the settings dialog, the error bar's Retry and changing the model do not send either; once the catalog reads, the Start card shows and only its button sends", async () => {
  providers = [twoModels];
  const view = render(panel({ seq: 0, kind: "start" }));
  await screen.findByText("Copilot");
  await waitFor(() => expect(document.querySelector('[data-ui="copilot-model"]')).not.toBeNull());
  catalogFails = true;
  view.rerender(panel({ seq: 1, kind: "start" }));
  const card = await waitFor(() => { const found = failedCard(); expect(found).not.toBeNull(); return found!; });
  expect(card.textContent).toContain("Cannot read the model settings");
  expect(document.querySelector('[data-ui="copilot-no-provider"]')).toBeNull();
  await noSend();
  // the settings dialog opened and closed: it reads the catalog again (still failing)
  fireEvent.click(document.querySelector('[data-ui="copilot-settings"]')!);
  await waitFor(() => expect(document.querySelector('[data-ui="provider-settings"]')).not.toBeNull());
  await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Close" }).slice(-1)[0]!); });
  await noSend();
  // the error bar's Retry, while the catalog still fails
  fireEvent.click(screen.getAllByRole("button", { name: "Retry" }).slice(-1)[0]!);
  await waitFor(() => expect(failedCard()).not.toBeNull());
  await noSend();
  // another model, with the catalog readable again: the failure card gives way to the Start card, still nothing sent
  catalogFails = false;
  chooseOption(document.querySelector('[data-ui="copilot-model"]')!, "openai\nother");
  const next = await waitFor(() => { const found = document.querySelector<HTMLElement>('[data-ui="copilot-provider-ready"]'); expect(found).not.toBeNull(); return found!; });
  expect(failedCard()).toBeNull();
  await noSend();
  fireEvent.click(next.querySelector('[data-ui="start-intake-after-provider"]')!);
  await waitFor(() => expect(sentTexts()).toEqual(["Start the intake: import my existing project"]));
  await settle();
  expect(created).toHaveLength(1); expect(sentTexts()).toHaveLength(1);
});

test("a double click is one request: one conversation, one message, and no late duplicate", async () => {
  const view = render(panel({ seq: 0, kind: "start" }));
  await screen.findByText("Copilot");
  await waitFor(() => expect(document.querySelector('[data-ui="copilot-model"]')).not.toBeNull());
  view.rerender(panel({ seq: 1, kind: "start" }));
  view.rerender(panel({ seq: 2, kind: "start" }));
  await waitFor(() => expect(sentTexts()).toHaveLength(1));
  await settle();
  expect(created).toHaveLength(1); expect(sentTexts()).toHaveLength(1);
  expect(document.querySelector('[data-ui="copilot-provider-ready"]')).toBeNull();
});

test("a click while the first request is creating its conversation is merged: still one conversation and one message, and no Start card", async () => {
  let release!: () => void;
  createDelay = new Promise<void>((resolve) => { release = resolve; });
  const view = render(panel({ seq: 0, kind: "resume" }));
  await screen.findByText("Copilot");
  await waitFor(() => expect(document.querySelector('[data-ui="copilot-model"]')).not.toBeNull());
  view.rerender(panel({ seq: 1, kind: "resume" }));
  await waitFor(() => expect(calls("/conversations")).toHaveLength(1));
  view.rerender(panel({ seq: 2, kind: "resume" }));
  await settle();
  expect(document.querySelector('[data-ui="copilot-provider-ready"]')).toBeNull();
  expect(document.querySelector('[data-ui="copilot-no-provider"]')).toBeNull();
  release();
  await waitFor(() => expect(sentTexts()).toHaveLength(1));
  await settle();
  expect(created).toHaveLength(1); expect(sentTexts()).toEqual(["Continue the intake of my existing project"]);
});

test("the conversation on screen runs a model that cannot run (no credential) while another provider can: a conversation is created with the usable model", async () => {
  const other: CopilotProvider = { ...ready, id: "anthropic", name: "Anthropic", models: [{ ...ready.models[0]!, id: "claude" }] };
  providers = [unset, other]; // the remembered conversation is on openai/test
  const view = render(panel({ seq: 0, kind: "start" }));
  await screen.findByText("Copilot");
  await waitFor(() => expect(document.querySelector('[data-ui="copilot-model"]')).not.toBeNull());
  view.rerender(panel({ seq: 1, kind: "start" }));
  await waitFor(() => expect(sentTexts()).toHaveLength(1));
  expect(createdModels).toEqual([{ provider: "anthropic", model: "claude", thinking: null }]);
  expect(document.querySelector('[data-ui="copilot-no-provider"]')).toBeNull();
  expect(document.querySelector('[data-ui="copilot-error"]')).toBeNull();
});

test("when no provider can run, the no-provider card shows, even with a catalog that lists models", async () => {
  providers = [unset, { ...ready, id: "b", models: [{ ...ready.models[0]!, tools: false }] }];
  const view = render(panel({ seq: 0, kind: "start" }));
  await screen.findByText("Copilot");
  view.rerender(panel({ seq: 1, kind: "start" }));
  await waitFor(() => expect(document.querySelector('[data-ui="copilot-no-provider"]')).not.toBeNull());
  await noSend();
  expect(document.querySelector('[data-ui="copilot-error"]')).toBeNull();
});

test("the failure card's own Retry reads the catalog again: readable -> the Start card, nothing sent on its own", async () => {
  catalogFails = true;
  const view = render(panel({ seq: 0, kind: "start" }));
  await screen.findByText("Copilot");
  view.rerender(panel({ seq: 1, kind: "start" }));
  const card = await waitFor(() => { const found = failedCard(); expect(found).not.toBeNull(); return found!; });
  catalogFails = false;
  fireEvent.click(card.querySelector('[data-ui="retry-intake-catalog"]')!);
  await waitFor(() => expect(document.querySelector('[data-ui="copilot-provider-ready"]')).not.toBeNull());
  expect(failedCard()).toBeNull();
  await noSend();
});

const fileOffCard = () => document.querySelector<HTMLElement>('[data-ui="copilot-file-tools-off"]');
const readyCard = () => document.querySelector<HTMLElement>('[data-ui="copilot-provider-ready"]');

test("the file permission is off: a card says why with Open settings, nothing is created or sent; closing the model dialog and changing the model do not send either; set to ask, the Start card shows and only its button sends", async () => {
  providers = [twoModels];
  const openSettings = vi.fn();
  const view = render(panel({ seq: 0, kind: "start" }, "off", openSettings));
  await screen.findByText("Copilot");
  await waitFor(() => expect(document.querySelector('[data-ui="copilot-model"]')).not.toBeNull());
  view.rerender(panel({ seq: 1, kind: "start" }, "off", openSettings));
  const card = await waitFor(() => { const found = fileOffCard(); expect(found).not.toBeNull(); return found!; });
  expect(card.textContent).toContain("File and command permission is off");
  expect(card.textContent).toContain("Ask each time or Automatic");
  expect(document.querySelector('[data-ui="copilot-no-provider"]')).toBeNull();
  await noSend();
  fireEvent.click(card.querySelector('[data-ui="open-file-tools-settings"]')!);
  expect(openSettings).toHaveBeenCalledTimes(1);
  // the model dialog opened and closed, another model chosen: the card stays, nothing sent
  fireEvent.click(document.querySelector('[data-ui="copilot-settings"]')!);
  await waitFor(() => expect(document.querySelector('[data-ui="provider-settings"]')).not.toBeNull());
  await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Close" }).slice(-1)[0]!); });
  chooseOption(document.querySelector('[data-ui="copilot-model"]')!, "openai\nother");
  await settle();
  expect(fileOffCard()).not.toBeNull(); expect(readyCard()).toBeNull();
  await noSend();
  // the permission is turned on in the settings: the card becomes the Start card, still nothing sent
  view.rerender(panel({ seq: 1, kind: "start" }, "ask", openSettings));
  const next = await waitFor(() => { const found = readyCard(); expect(found).not.toBeNull(); return found!; });
  expect(fileOffCard()).toBeNull();
  await noSend();
  fireEvent.click(next.querySelector('[data-ui="start-intake-after-provider"]')!);
  await waitFor(() => expect(sentTexts()).toEqual(["Start the intake: import my existing project"]));
  await settle();
  expect(created).toHaveLength(1); expect(sentTexts()).toHaveLength(1);
  expect(readyCard()).toBeNull(); expect(fileOffCard()).toBeNull();
});

test("the file permission turned off again while the Start card waits: the card goes back to the permission card and nothing is sent", async () => {
  providers = [unset];
  const view = render(panel({ seq: 0, kind: "resume" }, "ask"));
  await screen.findByText("Copilot");
  view.rerender(panel({ seq: 1, kind: "resume" }, "ask"));
  await waitFor(() => expect(document.querySelector('[data-ui="copilot-no-provider"]')).not.toBeNull());
  providers = [ready];
  fireEvent.click(document.querySelector('[data-ui="open-provider-settings"]')!);
  await waitFor(() => expect(document.querySelector('[data-ui="provider-settings"]')).not.toBeNull());
  await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Close" }).slice(-1)[0]!); });
  await waitFor(() => expect(readyCard()).not.toBeNull());
  view.rerender(panel({ seq: 1, kind: "resume" }, "off"));
  await waitFor(() => expect(fileOffCard()).not.toBeNull());
  expect(readyCard()).toBeNull();
  await noSend();
});

test("the card order: no usable model comes before the file permission, and the model failure before both", async () => {
  providers = [unset];
  const view = render(panel({ seq: 0, kind: "start" }, "off"));
  await screen.findByText("Copilot");
  view.rerender(panel({ seq: 1, kind: "start" }, "off"));
  await waitFor(() => expect(document.querySelector('[data-ui="copilot-no-provider"]')).not.toBeNull());
  expect(fileOffCard()).toBeNull();
  // a model that can run: the permission card takes over
  providers = [ready];
  fireEvent.click(document.querySelector('[data-ui="open-provider-settings"]')!);
  await waitFor(() => expect(document.querySelector('[data-ui="provider-settings"]')).not.toBeNull());
  await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Close" }).slice(-1)[0]!); });
  await waitFor(() => expect(fileOffCard()).not.toBeNull());
  expect(document.querySelector('[data-ui="copilot-no-provider"]')).toBeNull();
  // the catalog cannot be read: that card comes first again
  catalogFails = true;
  fireEvent.click(document.querySelector('[data-ui="copilot-settings"]')!);
  await waitFor(() => expect(document.querySelector('[data-ui="provider-settings"]')).not.toBeNull());
  await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Close" }).slice(-1)[0]!); });
  await waitFor(() => expect(failedCard()).not.toBeNull());
  expect(fileOffCard()).toBeNull();
  await noSend();
});

test("an unknown permission (not read yet) holds nothing back", async () => {
  const view = render(panel({ seq: 0, kind: "start" }));
  await screen.findByText("Copilot");
  await waitFor(() => expect(document.querySelector('[data-ui="copilot-model"]')).not.toBeNull());
  view.rerender(panel({ seq: 1, kind: "start" }));
  await waitFor(() => expect(sentTexts()).toHaveLength(1));
  expect(fileOffCard()).toBeNull();
});

test("the Start card says only that a model is ready while the file permission has not been read", async () => {
  providers = [unset];
  const view = render(panel({ seq: 0, kind: "start" }));
  await screen.findByText("Copilot");
  view.rerender(panel({ seq: 1, kind: "start" }));
  await waitFor(() => expect(document.querySelector('[data-ui="copilot-no-provider"]')).not.toBeNull());
  providers = [ready];
  fireEvent.click(document.querySelector('[data-ui="open-provider-settings"]')!);
  await waitFor(() => expect(document.querySelector('[data-ui="provider-settings"]')).not.toBeNull());
  await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Close" }).slice(-1)[0]!); });
  const card = await waitFor(() => { const found = readyCard(); expect(found).not.toBeNull(); return found!; });
  expect(card.textContent).toContain("Ready: a model is set up.");
  expect(card.textContent).not.toContain("file permission");
  view.rerender(panel({ seq: 1, kind: "start" }, "ask"));
  await waitFor(() => expect(readyCard()?.textContent).toContain("a model and the file permission are set up"));
  await noSend();
});

// ---- project-intake ticket 11: a model whose window cannot hold the Copilot is never picked for the user ----------------------- //
// The service marks such models `fits: false` in the model list (the measure is the server's: copilot-batching.test.ts); this page holds no byte counts.
const proto = ready.models[0]!;
const small = { ...proto, id: "small", name: "Small", contextWindow: 8192, fits: false };
const big = { ...proto, id: "big", name: "Big", contextWindow: 1_000_000, fits: true };
const only = (...models: (typeof proto)[]): CopilotProvider => ({ ...ready, models });
const windowCard = () => document.querySelector<HTMLElement>('[data-ui="copilot-window-small-card"]');
const chosenCard = () => document.querySelector<HTMLElement>('[data-ui="copilot-chosen-small-card"]');
const modelSelect = () => document.querySelector('[data-ui="copilot-model"]')!;
const ask = async (fileTools?: CopilotFileToolsSetting) => {
  const view = render(panel({ seq: 0, kind: "start" }, fileTools));
  await screen.findByText("Copilot");
  await waitFor(() => expect(modelSelect()).not.toBeNull());
  await settle();
  return () => view.rerender(panel({ seq: 1, kind: "start" }, fileTools));
};

test("only models whose window is too small: the panel picks none and says why; the move-in shows a card that says so, sends nothing, and offers the model settings", async () => {
  noConversations = true; providers = [only(small)];
  const start = await ask();
  expect(selectShown(modelSelect())).toBe("Choose model"); // no default was chosen for the user
  expect(document.querySelector('[data-ui="copilot-window-small"]')?.textContent).toContain("context window too small");
  start();
  const card = await waitFor(() => { expect(windowCard()).not.toBeNull(); return windowCard()!; });
  expect(card.textContent).toContain("No model has a large enough context window");
  expect(document.querySelector('[data-ui="copilot-no-provider"]')).toBeNull();
  expect(card.querySelector('[data-ui="open-provider-settings"]')).not.toBeNull();
  await noSend();
});

test("the window card comes before the file permission card (like \"no model\"); once a model that fits is set up the permission card takes its place, and nothing is sent", async () => {
  noConversations = true; providers = [only(small)];
  const start = await ask("off");
  start();
  await waitFor(() => expect(windowCard()).not.toBeNull());
  expect(fileOffCard()).toBeNull();
  providers = [only(small, big)];
  fireEvent.click(document.querySelector('[data-ui="open-provider-settings"]')!);
  await waitFor(() => expect(document.querySelector('[data-ui="provider-settings"]')).not.toBeNull());
  await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Close" }).slice(-1)[0]!); });
  await waitFor(() => expect(fileOffCard()).not.toBeNull());
  expect(windowCard()).toBeNull();
  await noSend();
});

test("small and large models mixed: the default is the first one that fits, and the move-in starts with it", async () => {
  noConversations = true; providers = [only(small, big)];
  const start = await ask();
  expect(selectShown(modelSelect())).toBe("Big");
  expect(document.querySelector('[data-ui="copilot-window-small"]')).toBeNull();
  start();
  await waitFor(() => expect(sentTexts()).toHaveLength(1));
  expect(createdModels).toEqual([{ provider: "openai", model: "big", thinking: null }]);
});

test("a provider whose models are all too small is passed over for a later provider that fits", async () => {
  noConversations = true;
  providers = [only(small), { ...only(big), id: "anthropic", name: "Anthropic" }];
  const start = await ask();
  expect(selectShown(modelSelect())).toBe("Big");
  start();
  await waitFor(() => expect(sentTexts()).toHaveLength(1));
  expect(createdModels).toEqual([{ provider: "anthropic", model: "big", thinking: null }]);
});

test("all models large enough: the first one is the default, as before", async () => {
  noConversations = true;
  const second = { ...big, id: "second", name: "Second" };
  providers = [only(big, second)];
  const start = await ask();
  expect(selectShown(modelSelect())).toBe("Big");
  start();
  await waitFor(() => expect(sentTexts()).toHaveLength(1));
  expect(createdModels).toEqual([{ provider: "openai", model: "big", thinking: null }]);
});

test("a list without the mark (an older service) is taken as fitting", async () => {
  noConversations = true;
  const { fits: _small, ...unmarked } = small;
  providers = [only(unmarked)];
  const start = await ask();
  expect(selectShown(modelSelect())).toBe("Small");
  start();
  await waitFor(() => expect(sentTexts()).toHaveLength(1));
});

test("a too-small model the user chose themselves is neither replaced nor sent to, even though another model fits: the move-in shows the chosen-model card (switch in the picker, no settings button); the picker keeps and marks the choice; switching to one that fits readies the start", async () => {
  noConversations = true; providers = [only(small, big)];
  const start = await ask();
  expect(selectShown(modelSelect())).toBe("Big");
  chooseOption(modelSelect(), "openai\nsmall");
  await waitFor(() => expect(selectShown(modelSelect())).toContain("Small"));
  expect(selectShown(modelSelect())).toContain("window too small");
  await settle();
  start();
  const card = await waitFor(() => { expect(chosenCard()).not.toBeNull(); return chosenCard()!; });
  expect(card.textContent).toContain("The chosen model’s context window is too small");
  expect(card.querySelector('[data-ui="open-provider-settings"]')).toBeNull();
  expect(windowCard()).toBeNull();
  expect(selectShown(modelSelect())).toContain("Small"); // the choice stays
  await noSend();
  chooseOption(modelSelect(), "openai\nbig");
  await waitFor(() => expect(document.querySelector('[data-ui="copilot-provider-ready"]')).not.toBeNull());
  expect(chosenCard()).toBeNull();
  await noSend();
});

test("the conversation on screen runs a too-small model: it is kept (it was chosen, not picked by default), so nothing is sent and the chosen-model card shows, even though another model fits", async () => {
  providers = [only({ ...proto, fits: false }, big)]; // the remembered conversation is on openai/test
  const view = render(panel({ seq: 0, kind: "start" }));
  await screen.findByText("Copilot");
  await waitFor(() => expect(selectShown(modelSelect())).toContain("Test"));
  view.rerender(panel({ seq: 1, kind: "start" }));
  await waitFor(() => expect(chosenCard()).not.toBeNull());
  expect(windowCard()).toBeNull();
  await noSend();
});

// A default this page picked turns out not to fit between two reads of the catalog (the permission turned on and grew the instruction).
test("the page's own default turns not-fitting between two reads: the panel and the move-in give way to a model that fits", async () => {
  noConversations = true;
  const other = { ...big, id: "other", name: "Other" };
  providers = [only(big, other)];
  const start = await ask();
  expect(selectShown(modelSelect())).toBe("Big");
  providers = [only({ ...big, fits: false }, other)];
  start();
  await waitFor(() => expect(sentTexts()).toHaveLength(1));
  expect(createdModels).toEqual([{ provider: "openai", model: "other", thinking: null }]);
});

test("the page's own default turns not-fitting and no model fits at all: the default is dropped, the panel says why, the move-in shows the window card", async () => {
  noConversations = true;
  providers = [only(big)];
  const start = await ask();
  expect(selectShown(modelSelect())).toBe("Big");
  expect(document.querySelector('[data-ui="copilot-window-small"]')).toBeNull();
  providers = [only({ ...big, fits: false })];
  start();
  await waitFor(() => expect(windowCard()).not.toBeNull());
  await waitFor(() => expect(selectShown(modelSelect())).toBe("Choose model"));
  expect(document.querySelector('[data-ui="copilot-window-small"]')).not.toBeNull();
  await noSend();
});

test("a model the user chose is not dropped when the catalog later says it no longer fits and nothing else does: the card shows, nothing is sent, the picker keeps it", async () => {
  noConversations = true;
  const other = { ...big, id: "other", name: "Other" };
  providers = [only(big, other)];
  const start = await ask();
  chooseOption(modelSelect(), "openai\nother");
  await waitFor(() => expect(selectShown(modelSelect())).toBe("Other"));
  await settle();
  providers = [only({ ...big, fits: false }, { ...other, fits: false })];
  start();
  await waitFor(() => expect(windowCard()).not.toBeNull());
  await waitFor(() => expect(selectShown(modelSelect())).toContain("Other"));
  await noSend();
});

// Changing the thinking level is the user's act too (`choose` forgets that the page picked the model).
test("the page's default whose thinking level the user changed is theirs: when it stops fitting it is kept and the window card shows, not replaced or dropped", async () => {
  noConversations = true;
  providers = [only(big)];
  const start = await ask();
  expect(selectShown(modelSelect())).toBe("Big");
  chooseOption(document.querySelector('[data-ui="copilot-thinking"]')!, "low");
  await settle();
  providers = [only({ ...big, fits: false })];
  start();
  await waitFor(() => expect(windowCard()).not.toBeNull());
  await waitFor(() => expect(selectShown(modelSelect())).toContain("Big")); // not dropped like a page-picked default
  expect(selectShown(modelSelect())).toContain("window too small");
  await noSend();
});

// The window card says the window is the reason: not when a model that fits is held back by something else.
test("a model that fits but whose default thinking level is invalid is not the window's doing: the move-in shows the no-model card, not the window card", async () => {
  noConversations = true;
  providers = [only({ ...big, defaultThinkingValid: false }, small)];
  const start = await ask();
  start();
  await waitFor(() => expect(document.querySelector('[data-ui="copilot-no-provider"]')).not.toBeNull());
  expect(windowCard()).toBeNull();
  await noSend();
});

test("the same flip with the file permission off: nothing is sent, and the panel itself now shows the model that fits", async () => {
  noConversations = true;
  const other = { ...big, id: "other", name: "Other" };
  providers = [only(big, other)];
  const start = await ask("off");
  expect(selectShown(modelSelect())).toBe("Big");
  providers = [only({ ...big, fits: false }, other)];
  start();
  await waitFor(() => expect(fileOffCard()).not.toBeNull());
  await waitFor(() => expect(selectShown(modelSelect())).toBe("Other"));
  await noSend();
});
