/**
 * The Copilot card for the manuscript list's delete dialog (ticket 22, carded at ticket 36) at the component seam: the
 * real Copilot component against a scripted HTTP API. The card names the manuscript and what goes with it; approving it
 * first asks the workspace's unsaved-edits guard (`guards.leaveManuscript`), and a refusal keeps the card and sends
 * nothing. Layout is proven in the real browser, not here (happy-dom).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConversationSnapshot, CopilotConfirmation, CopilotManuscriptDeleteConfirmation, CopilotProvider, PageContext, WsCopilotEvent } from "@argelanderspace/contracts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Copilot } from "../src/copilot/Copilot";
import i18n from "../src/i18n";

const callbacks = vi.hoisted(() => ({ subscription: null as null | { event: (event: WsCopilotEvent) => void; ready: () => void; connection: (value: boolean) => void } }));
vi.mock("../src/api/ws", () => ({ subscribeCopilot: (subscription: NonNullable<typeof callbacks.subscription>) => { callbacks.subscription = subscription; queueMicrotask(subscription.ready); return () => { callbacks.subscription = null; }; } }));
const ID = "00000000-0000-4000-8000-000000000002";
const RUN = "00000000-0000-4000-8000-0000000000aa";
const CARD = "00000000-0000-4000-8000-0000000000cc";
const MS = "m_0000000a";
const context: PageContext = { version: 1, viewId: "00000000-0000-4000-8000-000000000001", paneId: 1, revision: 1, view: "write", status: "unavailable", otherPanes: [], plan: null };
const conversation = { version: 1 as const, id: ID, sessionId: "00000000-0000-4000-8000-000000000003", title: "Test conversation", createdAt: "2026-10-11", updatedAt: "2026-10-11", model: { provider: "openai", model: "test", thinking: null }, run: { id: RUN, status: "waiting-for-user" as const, error: null } };
const card = (over: Partial<CopilotManuscriptDeleteConfirmation> = {}): CopilotConfirmation => ({ id: CARD, runId: RUN, toolCallId: "call_1", action: "delete_manuscript", object: { kind: "manuscript", id: MS }, label: "Draft <b>one</b>", impact: { cells: 12, comments: 3, assets: 2 }, baseRev: 5, objectDigest: "d".repeat(64), ...over });
const snap = (extra: Partial<ConversationSnapshot> = {}): ConversationSnapshot => ({ version: 1, conversation, messages: [], confirmations: [card()], stream: "", eventCursor: { instanceId: "00000000-0000-4000-8000-000000000004", seq: 1 }, ...extra });
const provider: CopilotProvider = { id: "openai", name: "OpenAI", method: "api_key", credential: { configured: true, stored: true, source: "stored" }, catalogStatus: "ready", models: [{ id: "test", name: "Test", baseUrl: "https://example.invalid", contextWindow: 10000, maxTokens: 1000, tools: true, image: false, thinkingLevels: ["off", "low", "high"], capabilitiesKnown: true, defaultThinking: "high", defaultThinkingValid: true }] };
let fetchMock: ReturnType<typeof vi.fn>;
let current: ConversationSnapshot;
let decisionStatus = 200;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const calls = (part: string) => fetchMock.mock.calls.filter(([url]) => String(url).includes(part));
const memory = new Map<string, string>();
beforeEach(async () => {
  await i18n.changeLanguage("en"); callbacks.subscription = null; memory.clear(); decisionStatus = 200;
  vi.stubGlobal("localStorage", { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); }, removeItem: (key: string) => { memory.delete(key); } });
  current = snap();
  fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/providers")) return json({ version: 1, providers: [provider] });
    if (url.endsWith("/conversations")) return options?.method === "POST" ? json(current, 201) : json({ version: 1, conversations: [current.conversation], unreadable: [] });
    if (url.includes("/confirmations/")) return decisionStatus === 200 ? json({ status: "approved" }) : json({ code: decisionStatus === 409 ? "stale" : "storage" }, decisionStatus);
    if (url.includes("/views/")) return json({ saved: true });
    return json(current);
  }); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const open = async (leaveManuscript?: (id: string) => boolean) => { const view = render(<Copilot open context={context} onClose={vi.fn()} guards={{ leaveManuscript }} />); await screen.findByText("Copilot"); return view; };
const ui = (name: string) => document.querySelector(`[data-ui="${name}"]`) as HTMLElement | null;
const decisionBody = () => JSON.parse(String((calls("/confirmations/")[0] as [string, RequestInit])[1].body));

test("the card names the manuscript verbatim, what is deleted with it, and its id and version", async () => {
  await open();
  await waitFor(() => expect(ui("copilot-confirmation")).not.toBeNull());
  const shown = ui("copilot-confirmation") as HTMLElement;
  expect(shown.getAttribute("data-action")).toBe("delete_manuscript");
  expect(shown.querySelector("h3")?.textContent).toBe("Permanently delete the manuscript “Draft <b>one</b>”");
  expect(shown.querySelector("b")).toBeNull(); // user data is text, never markup
  expect(ui("copilot-confirmation-scope")?.textContent).toBe("12 cells, 3 comments and 2 uploaded figure files are deleted with it. This cannot be undone.");
  expect(shown.querySelector(".copilot-confirmation-meta")?.textContent).toBe(`${MS} · manuscript v5`);
  expect(ui("copilot-confirmation-confirm")?.textContent).toBe("Delete");
  expect(ui("copilot-confirmation-confirm")?.className).toContain("danger");
  expect(ui("copilot-confirmation-cancel")?.textContent).toBe("Cancel");
});

test("Delete posts exactly the card's action, manuscript id and version from this view; Cancel declines", async () => {
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-confirm")).not.toBeNull());
  fireEvent.click(ui("copilot-confirmation-confirm")!);
  await waitFor(() => expect(calls("/confirmations/")).toHaveLength(1));
  expect((calls("/confirmations/")[0] as [string])[0]).toBe(`/api/copilot/confirmations/${CARD}`);
  expect(decisionBody()).toEqual({ decision: "approve", viewId: context.viewId, action: "delete_manuscript", objectId: MS, baseRev: 5 });
  cleanup(); fetchMock.mockClear();
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-cancel")).not.toBeNull());
  fireEvent.click(ui("copilot-confirmation-cancel")!);
  await waitFor(() => expect(calls("/confirmations/")).toHaveLength(1));
  expect(decisionBody()).toEqual({ decision: "decline", viewId: context.viewId, action: "delete_manuscript", objectId: MS, baseRev: 5 });
});

test("approving first asks the workspace's unsaved-edits guard; a refusal sends nothing and keeps the card; Cancel never asks", async () => {
  const guard = vi.fn(() => false);
  await open(guard);
  await waitFor(() => expect(ui("copilot-confirmation-confirm")).not.toBeNull());
  fireEvent.click(ui("copilot-confirmation-confirm")!);
  expect(guard).toHaveBeenCalledWith(MS);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(calls("/confirmations/")).toHaveLength(0);
  expect(ui("copilot-confirmation")).not.toBeNull();
  expect((ui("copilot-confirmation-confirm") as HTMLButtonElement).disabled).toBe(false);
  guard.mockReturnValue(true);
  fireEvent.click(ui("copilot-confirmation-confirm")!);
  await waitFor(() => expect(calls("/confirmations/")).toHaveLength(1));
  expect(decisionBody()).toMatchObject({ decision: "approve", action: "delete_manuscript", objectId: MS });
  guard.mockClear();
  cleanup(); fetchMock.mockClear();
  await open(guard);
  await waitFor(() => expect(ui("copilot-confirmation-cancel")).not.toBeNull());
  fireEvent.click(ui("copilot-confirmation-cancel")!);
  await waitFor(() => expect(calls("/confirmations/")).toHaveLength(1));
  expect(guard).not.toHaveBeenCalled();
});

test("a stale decision says nothing was deleted; a failed one says the outcome is unknown", async () => {
  decisionStatus = 409;
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-confirm")).not.toBeNull());
  fireEvent.click(ui("copilot-confirmation-confirm")!);
  await waitFor(() => expect(ui("copilot-confirmation-problem")?.textContent).toContain(i18n.t("copilot.confirmation.expiredManuscript")));
  cleanup(); fetchMock.mockClear(); decisionStatus = 500;
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-confirm")).not.toBeNull());
  fireEvent.click(ui("copilot-confirmation-confirm")!);
  await waitFor(() => expect(ui("copilot-confirmation-problem")?.textContent).toContain(i18n.t("copilot.confirmation.failedManuscript")));
});
