/**
 * The Copilot card for the Files tab's "delete document" dialog (ticket 16) at the component seam: the real Copilot
 * component against a scripted HTTP API. The card carries the dialog's own strings and facts; layout is proven in the
 * real browser, not here (happy-dom).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConversationSnapshot, CopilotConfirmation, CopilotDocDeleteConfirmation, CopilotProvider, PageContext, WsCopilotEvent } from "@argelanderspace/contracts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Copilot } from "../src/copilot/Copilot";
import i18n from "../src/i18n";

const callbacks = vi.hoisted(() => ({ subscription: null as null | { event: (event: WsCopilotEvent) => void; ready: () => void; connection: (value: boolean) => void } }));
vi.mock("../src/api/ws", () => ({ subscribeCopilot: (subscription: NonNullable<typeof callbacks.subscription>) => { callbacks.subscription = subscription; queueMicrotask(subscription.ready); return () => { callbacks.subscription = null; }; } }));
const ID = "00000000-0000-4000-8000-000000000002";
const RUN = "00000000-0000-4000-8000-0000000000aa";
const CARD = "00000000-0000-4000-8000-0000000000cc";
const context: PageContext = { version: 1, viewId: "00000000-0000-4000-8000-000000000001", paneId: 1, revision: 1, view: "doc", status: "unavailable", otherPanes: [], plan: null };
const conversation = { version: 1 as const, id: ID, sessionId: "00000000-0000-4000-8000-000000000003", title: "Test conversation", createdAt: "2026-10-04", updatedAt: "2026-10-04", model: { provider: "openai", model: "test", thinking: null }, run: { id: RUN, status: "waiting-for-user" as const, error: null } };
const card = (over: Partial<CopilotDocDeleteConfirmation> = {}): CopilotConfirmation => ({ id: CARD, runId: RUN, toolCallId: "call_1", action: "delete_doc", object: { kind: "doc", id: "arxiv-2603.03522" }, format: "latex", works: [{ id: "w1", title: "First <b>work</b>", main: true, remaining: 1 }, { id: "w2", title: "Second work", main: false, remaining: 0 }], impact: { annotations: "known", count: 4 }, baseRev: 3, objectDigest: "d".repeat(64), ...over });
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
const open = async (guard?: (docId: string) => boolean) => { const view = render(<Copilot open context={context} onClose={vi.fn()} guards={{ leaveDoc: guard }} />); await screen.findByText("Copilot"); return view; };
const ui = (name: string) => document.querySelector(`[data-ui="${name}"]`) as HTMLElement | null;
const decisionBody = () => JSON.parse(String((calls("/confirmations/")[0] as [string, RequestInit])[1].body));

test("the card carries the dialog's facts: the Doc, its global scope, EVERY work with its role, the annotation count and version", async () => {
  await open();
  await waitFor(() => expect(ui("copilot-confirmation")).not.toBeNull());
  const shown = ui("copilot-confirmation") as HTMLElement;
  expect(shown.getAttribute("data-action")).toBe("delete_doc");
  expect(shown.querySelector("h3")?.textContent).toBe("Permanently delete the document “arxiv-2603.03522”");
  // the scope sentence is the dialog's own: global, original/body, current and archived annotations
  expect(shown.textContent).toContain(i18n.t("library.detail.deleteDoc.scope"));
  // the dialog's risk line and scope title are on the card too
  expect(ui("copilot-confirmation-risk")?.textContent).toBe("This cannot be undone");
  expect(ui("copilot-confirmation-scope")?.querySelector("strong")?.textContent).toBe("Global deletion");
  const works = [...shown.querySelectorAll('[data-ui="copilot-confirmation-work"]')].map((node) => node.textContent);
  expect(works).toEqual(["“First <b>work</b>” · Main document · other documents kept: 1", "“Second work” · Additional document · other documents kept: 0"]);
  expect(shown.querySelector("b")).toBeNull(); // user data is text, never markup
  expect(ui("copilot-confirmation-count")?.textContent).toBe("Includes 4 current annotations.");
  expect(shown.textContent).toContain("arxiv-2603.03522 · annotations v3");
  expect(ui("copilot-confirmation-confirm")?.textContent).toBe("Delete permanently");
  expect(ui("copilot-confirmation-confirm")?.className).toContain("danger");
});

test("a PDF card uses the dialog's PDF scope sentence; an unreadable count is shown as unavailable, never as zero", async () => {
  current = snap({ confirmations: [card({ format: "pdf", impact: { annotations: "unknown" }, baseRev: 0 })] });
  await open();
  await waitFor(() => expect(ui("copilot-confirmation")).not.toBeNull());
  const shown = ui("copilot-confirmation") as HTMLElement;
  expect(shown.textContent).toContain(i18n.t("library.detail.deleteDoc.pdfScope"));
  expect(ui("copilot-confirmation-count")?.textContent).toBe(i18n.t("library.detail.deleteDoc.countUnknown"));
  expect(shown.textContent).not.toContain("Includes 0");
  expect(shown.querySelector(".copilot-confirmation-meta")?.textContent).toBe("arxiv-2603.03522"); // no invented version
});

test("a zero count is a known zero, and no empty work list is drawn", async () => {
  current = snap({ confirmations: [card({ works: [], impact: { annotations: "known", count: 0 } })] });
  await open();
  await waitFor(() => expect(ui("copilot-confirmation")).not.toBeNull());
  expect(ui("copilot-confirmation-count")?.textContent).toBe("Includes 0 current annotations.");
  expect(ui("copilot-confirmation-works")).toBeNull();
});

test("Delete posts exactly the card's action, Doc id and version from this view; Cancel declines", async () => {
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-confirm")).not.toBeNull());
  fireEvent.click(ui("copilot-confirmation-confirm")!);
  await waitFor(() => expect(calls("/confirmations/")).toHaveLength(1));
  expect((calls("/confirmations/")[0] as [string])[0]).toBe(`/api/copilot/confirmations/${CARD}`);
  expect(decisionBody()).toEqual({ decision: "approve", viewId: context.viewId, action: "delete_doc", objectId: "arxiv-2603.03522", baseRev: 3 });
  cleanup(); fetchMock.mockClear();
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-cancel")).not.toBeNull());
  fireEvent.click(ui("copilot-confirmation-cancel")!);
  await waitFor(() => expect(calls("/confirmations/")).toHaveLength(1));
  expect(decisionBody()).toMatchObject({ decision: "decline", action: "delete_doc" });
});

test("deleting the open Doc asks the workspace's leave guard first, as the dialog does; a refusal sends nothing and keeps the card", async () => {
  const guard = vi.fn(() => false);
  await open(guard);
  await waitFor(() => expect(ui("copilot-confirmation-confirm")).not.toBeNull());
  fireEvent.click(ui("copilot-confirmation-confirm")!);
  expect(guard).toHaveBeenCalledWith("arxiv-2603.03522");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(calls("/confirmations/")).toHaveLength(0);
  expect(ui("copilot-confirmation")).not.toBeNull();
  expect((ui("copilot-confirmation-confirm") as HTMLButtonElement).disabled).toBe(false);
  guard.mockReturnValue(true);
  fireEvent.click(ui("copilot-confirmation-confirm")!);
  await waitFor(() => expect(calls("/confirmations/")).toHaveLength(1));
  // Cancel never asks the guard.
  guard.mockClear();
  cleanup(); fetchMock.mockClear();
  await open(guard);
  await waitFor(() => expect(ui("copilot-confirmation-cancel")).not.toBeNull());
  fireEvent.click(ui("copilot-confirmation-cancel")!);
  await waitFor(() => expect(calls("/confirmations/")).toHaveLength(1));
  expect(guard).not.toHaveBeenCalled();
});

test("a stale decision says nothing was deleted; a failed one says the outcome is unknown (never claims nothing was deleted), in English and Chinese", async () => {
  decisionStatus = 409;
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-confirm")).not.toBeNull());
  fireEvent.click(ui("copilot-confirmation-confirm")!);
  await waitFor(() => expect(ui("copilot-confirmation-problem")?.textContent).toContain("Nothing was deleted."));
  expect(ui("copilot-confirmation-problem")?.textContent).not.toContain("replaced");
  cleanup(); fetchMock.mockClear(); decisionStatus = 500;
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-confirm")).not.toBeNull());
  fireEvent.click(ui("copilot-confirmation-confirm")!);
  await waitFor(() => expect(ui("copilot-confirmation-problem")?.textContent).toContain("outcome is not known"));
  expect(ui("copilot-confirmation-problem")?.textContent).not.toContain("Nothing was deleted");
  cleanup(); fetchMock.mockClear(); decisionStatus = 409;
  await i18n.changeLanguage("zh-CN");
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-confirm")).not.toBeNull());
  expect(ui("copilot-confirmation-confirm")?.textContent).toBe("永久删除");
  expect(ui("copilot-confirmation")?.querySelector("h3")?.textContent).toBe("永久删除文档「arxiv-2603.03522」");
  fireEvent.click(ui("copilot-confirmation-confirm")!);
  await waitFor(() => expect(ui("copilot-confirmation-problem")?.textContent).toContain("未删除任何内容"));
});
