/**
 * The argument graph replace/clear card (argument graph ticket 09) at the component seam: the real Copilot component
 * against a scripted HTTP API. It shows the work and both sizes, the two decisions post what the card showed, and a stale
 * or unreadable answer is worded for the argument graph. Layout is not proven here (happy-dom): the real browser is.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConversationSnapshot, CopilotConfirmation, CopilotProvider, PageContext, WsCopilotEvent } from "@argelanderspace/contracts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Copilot, operationActionLabel } from "../src/copilot/Copilot";
import i18n from "../src/i18n";

const callbacks = vi.hoisted(() => ({ subscription: null as null | { event: (event: WsCopilotEvent) => void; ready: () => void; connection: (value: boolean) => void }, planChanged: new Set<() => void>() }));
vi.mock("../src/api/ws", () => ({ onPlanChanged: (cb: () => void) => { callbacks.planChanged.add(cb); return () => callbacks.planChanged.delete(cb); }, subscribeCopilot: (subscription: NonNullable<typeof callbacks.subscription>) => { callbacks.subscription = subscription; queueMicrotask(subscription.ready); return () => { callbacks.subscription = null; }; } }));
const ID = "00000000-0000-4000-8000-000000000002";
const RUN = "00000000-0000-4000-8000-0000000000aa";
const CARD = "00000000-0000-4000-8000-0000000000cc";
const context: PageContext = { version: 1, viewId: "00000000-0000-4000-8000-000000000001", paneId: 1, revision: 1, view: "doc", status: "unavailable", otherPanes: [], plan: null };
const conversation = (status: "waiting-for-user" | "completed") => ({ version: 1 as const, id: ID, sessionId: "00000000-0000-4000-8000-000000000003", title: "Test conversation", createdAt: "2026-10-02", updatedAt: "2026-10-02", model: { provider: "openai", model: "test", thinking: null }, run: { id: RUN, status, error: null } });
const snap = (status: "waiting-for-user" | "completed", extra: Partial<ConversationSnapshot> = {}): ConversationSnapshot => ({ version: 1, conversation: conversation(status), messages: [], confirmations: [], stream: "", eventCursor: { instanceId: "00000000-0000-4000-8000-000000000004", seq: 1 }, ...extra });
const provider: CopilotProvider = { id: "openai", name: "OpenAI", method: "api_key", credential: { configured: true, stored: true, source: "stored" }, catalogStatus: "ready", models: [{ id: "test", name: "Test", baseUrl: "https://example.invalid", contextWindow: 10000, maxTokens: 1000, tools: true, image: false, thinkingLevels: ["off", "low", "high"], capabilitiesKnown: true, defaultThinking: "high", defaultThinkingValid: true }] };
let fetchMock: ReturnType<typeof vi.fn>;
let current: ConversationSnapshot;
let decisionStatus = 200;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const calls = (part: string) => fetchMock.mock.calls.filter(([url]) => String(url).includes(part));
const memory = new Map<string, string>();
let plansUndo: object | null = null;
beforeEach(async () => {
  await i18n.changeLanguage("en"); callbacks.subscription = null; callbacks.planChanged.clear(); plansUndo = null; memory.clear(); decisionStatus = 200;
  vi.stubGlobal("localStorage", { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); }, removeItem: (key: string) => { memory.delete(key); } });
  current = snap("waiting-for-user", { confirmations: [argCard()] });
  fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/providers")) return json({ version: 1, providers: [provider] });
    if (url.endsWith("/conversations")) return options?.method === "POST" ? json(current, 201) : json({ version: 1, conversations: [current.conversation], unreadable: [] });
    if (url.includes("/confirmations/")) return decisionStatus === 200 ? json({ status: JSON.parse(String(options?.body)).decision === "approve" ? "approved" : "declined" }) : json({ code: decisionStatus === 409 ? "stale" : "storage" }, decisionStatus);
    if (url === "/api/plans/undo") return plansUndo ? json(plansUndo) : json({ status: "ok", rev: 9 });
    if (url.includes("/undo")) return json({ status: "ok", rev: 9 });
    if (url.includes("/views/")) return json({ saved: true });
    return json(current);
  }); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const open = async () => { const view = render(<Copilot open context={context} onClose={vi.fn()} />); await screen.findByText("Copilot"); return view; };

const ui = (name: string) => document.querySelector(`[data-ui="${name}"]`) as HTMLElement | null;
const WORK = "doi:10.1000/tails";
const argCard = (over: Partial<Extract<CopilotConfirmation, { action: "replace_argument_graph" }>> = {}): CopilotConfirmation => ({ id: CARD, runId: RUN, toolCallId: "call_1", action: "replace_argument_graph", object: { kind: "work", id: WORK, workId: WORK }, label: "Tidal tails of <b>open</b> clusters", mode: "replace", current: { arguments: 11, edges: 13 }, next: { arguments: 9, edges: 11 }, baseRev: 7, objectDigest: "d".repeat(64), ...over });

test("a waiting replacement shows the work, what the graph holds now and what it will hold; confirm is the danger action", async () => {
  await open();
  await waitFor(() => expect(ui("copilot-confirmation")).not.toBeNull());
  const shown = ui("copilot-confirmation") as HTMLElement;
  expect(shown.getAttribute("data-action")).toBe("replace_argument_graph");
  expect(shown.querySelector("h3")?.textContent).toBe("Replace the argument graph");
  // The work's title is user data: verbatim text, never markup.
  expect(ui("copilot-confirmation-work")?.textContent).toBe("Tidal tails of <b>open</b> clusters");
  expect(shown.querySelector("b")).toBeNull();
  expect(ui("copilot-confirmation-scope")?.textContent).toBe("The existing 11 arguments and 13 edges will be replaced by 9 arguments and 11 edges.");
  expect(ui("copilot-confirmation-confirm")?.textContent).toBe("Replace");
  expect(ui("copilot-confirmation-confirm")?.className).toContain("danger");
  expect(ui("copilot-confirmation-cancel")).not.toBeNull();
  expect(ui("copilot-running")).toBeNull(); // waiting for the user, not "Replying…"
});

test("a clear says what is deleted and that it cannot be undone, and confirms with the page's own Clear label", async () => {
  current = snap("waiting-for-user", { confirmations: [argCard({ mode: "clear", next: { arguments: 0, edges: 0 } })] });
  await open();
  await waitFor(() => expect(ui("copilot-confirmation")).not.toBeNull());
  expect(ui("copilot-confirmation")?.querySelector("h3")?.textContent).toBe("Clear the argument graph");
  expect(ui("copilot-confirmation-scope")?.textContent).toBe("All 11 arguments and 13 edges of this work will be deleted. This cannot be undone.");
  expect(ui("copilot-confirmation-confirm")?.textContent).toBe("Clear");
});

test("Confirm posts the work id and the graph version the card showed; Cancel posts the decline", async () => {
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-confirm")).not.toBeNull());
  fireEvent.click(ui("copilot-confirmation-confirm")!);
  await waitFor(() => expect(calls("/confirmations/")).toHaveLength(1));
  const [url, options] = calls("/confirmations/")[0] as [string, RequestInit];
  expect(url).toContain(CARD);
  expect(JSON.parse(String(options.body))).toEqual({ decision: "approve", viewId: context.viewId, action: "replace_argument_graph", objectId: WORK, baseRev: 7 });
  cleanup();
  current = snap("waiting-for-user", { confirmations: [argCard()] });
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-cancel")).not.toBeNull());
  fireEvent.click(ui("copilot-confirmation-cancel")!);
  await waitFor(() => expect(calls("/confirmations/")).toHaveLength(2));
  expect(JSON.parse(String((calls("/confirmations/")[1] as [string, RequestInit])[1].body))).toMatchObject({ decision: "decline", action: "replace_argument_graph", objectId: WORK });
});

test("a stale answer says the graph changed and nothing was replaced; a failed one says nothing changed; an unreadable check is not a change", async () => {
  decisionStatus = 409;
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-confirm")).not.toBeNull());
  fireEvent.click(ui("copilot-confirmation-confirm")!);
  await waitFor(() => expect(ui("copilot-confirmation-problem")?.textContent).toContain("The argument graph changed before your decision. Nothing was replaced."));
  const base = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => url.includes("/confirmations/") ? json({ code: "unreadable" }, 500) : base(url, options));
  cleanup();
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-confirm")).not.toBeNull());
  fireEvent.click(ui("copilot-confirmation-confirm")!);
  await waitFor(() => expect(ui("copilot-confirmation-problem")?.textContent).toContain("could not read this argument graph. This is not a change you made, and nothing was changed."));
});

test("the card and the operation names are worded in Chinese too", async () => {
  await i18n.changeLanguage("zh-CN");
  await open();
  await waitFor(() => expect(ui("copilot-confirmation")).not.toBeNull());
  expect(ui("copilot-confirmation")?.querySelector("h3")?.textContent).toBe("替换论证图");
  expect(ui("copilot-confirmation-scope")?.textContent).toBe("现有的 11 个论证和 13 条边将被 9 个论证、11 条边替换。");
  expect(ui("copilot-confirmation-confirm")?.textContent).toBe("替换");
  expect(operationActionLabel(i18n.t.bind(i18n), "argument", "replace")).toBe("替换论证图");
  await i18n.changeLanguage("en");
  expect(operationActionLabel(i18n.t.bind(i18n), "argument", "add_edge")).toBe("Add an argument edge");
});
