import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConversationSnapshot, CopilotProvider, PageContext, WsCopilotEvent } from "@argelanderspace/contracts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Copilot } from "../src/copilot/Copilot";
import i18n from "../src/i18n";

const callbacks = vi.hoisted(() => ({ subscription: null as null | { conversationId: string; event: (event: WsCopilotEvent) => void; ready: () => void; connection: (value: boolean) => void } }));
vi.mock("../src/api/ws", () => ({ subscribeCopilot: (subscription: NonNullable<typeof callbacks.subscription>) => { callbacks.subscription = subscription; queueMicrotask(subscription.ready); return () => { callbacks.subscription = null; }; } }));
const ID1 = "00000000-0000-4000-8000-000000000002", ID2 = "00000000-0000-4000-8000-000000000012";
const context: PageContext = { version: 1, viewId: "00000000-0000-4000-8000-000000000001", paneId: 1, revision: 1, view: "doc", status: "unavailable", otherPanes: [], plan: null };
const conversation = (id: string, run: ConversationSnapshot["conversation"]["run"], title = "Test conversation") => ({ version: 1 as const, id, sessionId: "00000000-0000-4000-8000-000000000003", title, createdAt: "2026-10-02", updatedAt: "2026-10-02", model: { provider: "openai", model: "test", thinking: null }, run });
const snap = (id: string, run: ConversationSnapshot["conversation"]["run"], extra: Partial<ConversationSnapshot> = {}): ConversationSnapshot => ({ version: 1, conversation: conversation(id, run), messages: [], confirmations: [], stream: "", eventCursor: { instanceId: "00000000-0000-4000-8000-000000000004", seq: 1 }, ...extra });
const running = { id: "00000000-0000-4000-8000-0000000000aa", status: "running" as const, error: null };
const provider: CopilotProvider = { id: "openai", name: "OpenAI", method: "api_key", credential: { configured: true, stored: true, source: "stored" }, catalogStatus: "ready", models: [{ id: "test", name: "Test", baseUrl: "https://example.invalid", contextWindow: 10000, maxTokens: 1000, tools: true, image: false, thinkingLevels: ["off", "low", "high"], capabilitiesKnown: true, defaultThinking: "high", defaultThinkingValid: true }] };
let fetchMock: ReturnType<typeof vi.fn>;
let current: ConversationSnapshot;
let listed: { conversations: ConversationSnapshot["conversation"][]; unreadable?: { id: string; code: string }[] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const memory = new Map<string, string>();
beforeEach(async () => {
  await i18n.changeLanguage("en"); callbacks.subscription = null; memory.clear();
  vi.stubGlobal("localStorage", { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); }, removeItem: (key: string) => { memory.delete(key); } });
  current = snap(ID1, running); listed = { conversations: [current.conversation] };
  fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/providers")) return json({ version: 1, providers: [provider] });
    if (url.endsWith("/conversations")) return options?.method === "POST" ? json(current, 201) : json({ version: 1, ...listed });
    if (url.endsWith("/messages")) return json({ messageId: "message", runId: "run" }, 202);
    if (url.endsWith("/resume")) return json({ messageId: "message", runId: "run" }, 202);
    if (url.endsWith("/stop")) { current = { ...current, conversation: { ...current.conversation, run: { ...running, status: "stopping" } } }; return json(current); }
    if (url.includes("/views/")) return json({ saved: true });
    const id = url.split("/conversations/")[1];
    return json(id === ID2 ? snap(ID2, null) : current);
  }); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const open = async (ctx: PageContext = context) => { const view = render(<Copilot open context={ctx} onClose={vi.fn()} />); await screen.findByText("Copilot"); await waitFor(() => expect((document.querySelector('[data-ui="copilot-thinking"]') as HTMLSelectElement).disabled).toBe(false)); return view; };

// Live run status, reasoning summary and elapsed time (ticket 33 follow-up): per event, incremental, honest without thinking.
const live = (extra: Partial<NonNullable<ConversationSnapshot["live"]>> = {}) => ({ phase: "working" as const, thinking: "", elapsedMs: 0, ...extra });
const streamEvent = (seq: number, extra: Partial<WsCopilotEvent>): WsCopilotEvent => ({ type: "copilot.event", conversationId: ID1, runId: running.id, eventCursor: { instanceId: "00000000-0000-4000-8000-000000000004", seq }, kind: "stream", text: "", ...extra });
const deliver = (event: WsCopilotEvent) => act(() => { callbacks.subscription!.event(event); });
const status = () => document.querySelector('[data-ui="copilot-live-status"]');
const thinkingBlock = () => document.querySelector('[data-ui="copilot-reasoning"]') as HTMLDetailsElement | null;

test("the status follows each event: thinking, an operation (with its page), writing, working", async () => {
  current = snap(ID1, running, { live: live() });
  await open();
  await waitFor(() => expect(status()?.textContent).toBe("Working…"));
  deliver(streamEvent(2, { live: live({ phase: "thinking", thinking: "Weigh" }) }));
  await waitFor(() => expect(status()?.textContent).toBe("Thinking…"));
  deliver(streamEvent(3, { live: live({ phase: "operation", operation: { tool: "reader", action: "read_page_image", page: 4 } }) }));
  await waitFor(() => expect(status()?.textContent).toMatch(/^Running: .+ \(page 4\)$/));
  deliver(streamEvent(4, { live: live({ phase: "operation", operation: { tool: "text", action: "save_source" } }) }));
  await waitFor(() => expect(status()?.textContent).toMatch(/^Running: Save text source$/));
  deliver(streamEvent(5, { text: "Hel", live: live({ phase: "writing" }) }));
  await waitFor(() => expect(status()?.textContent).toBe("Writing the reply…"));
  expect(status()?.getAttribute("data-phase")).toBe("writing");
});

test("thinking renders incrementally, collapsible, apart from the answer, and collapses once the answer is written", async () => {
  current = snap(ID1, running, { live: live({ phase: "thinking", thinking: "Weigh" }) });
  await open();
  await waitFor(() => expect(thinkingBlock()?.querySelector('[data-ui="copilot-reasoning-body"]')?.textContent).toBe("Weigh"));
  expect(thinkingBlock()!.open).toBe(true);
  deliver(streamEvent(2, { live: live({ phase: "thinking", thinking: "Weigh options" }) }));
  await waitFor(() => expect(thinkingBlock()!.querySelector('[data-ui="copilot-reasoning-body"]')!.textContent).toBe("Weigh options"));
  // Plain text, never markup, and not part of the answer's markdown.
  deliver(streamEvent(3, { text: "Answer", live: live({ phase: "writing", thinking: "<b>Weigh</b> options" }) }));
  await waitFor(() => expect(document.querySelector('[data-ui="copilot-stream"] .copilot-markdown')!.textContent!.trim()).toBe("Answer"));
  expect(thinkingBlock()!.open).toBe(false);
  expect(thinkingBlock()!.querySelector("b")).toBeNull();
  expect(thinkingBlock()!.querySelector('[data-ui="copilot-reasoning-body"]')!.textContent).toBe("<b>Weigh</b> options");
  expect(document.querySelector('[data-ui="copilot-stream"] .copilot-markdown')!.textContent).not.toContain("Weigh");
});

test("a provider with no thinking text shows the status only, no thinking block", async () => {
  current = snap(ID1, running, { live: live({ phase: "writing" }), stream: "Plain" });
  await open();
  await waitFor(() => expect(status()?.textContent).toBe("Writing the reply…"));
  deliver(streamEvent(2, { text: "Plain answer", live: live({ phase: "writing" }) }));
  await screen.findByText("Plain answer");
  expect(thinkingBlock()).toBeNull();
});

test("a reconnecting client gets the current status from the snapshot; the saved reply shows its summary collapsed", async () => {
  current = snap(ID1, running, { live: live({ phase: "operation", operation: { tool: "reader", action: "read_page_image", page: 9 }, elapsedMs: 75_000 }), messages: [{ id: "a1", role: "assistant", text: "Earlier", thinking: "Earlier reasoning" }] });
  await open();
  await waitFor(() => expect(status()?.textContent).toMatch(/page 9/));
  expect(document.querySelector('[data-ui="copilot-elapsed"]')!.textContent).toBe("Elapsed 1:15");
  const saved = thinkingBlock()!;
  expect(saved.open).toBe(false);
  expect(saved.textContent).toContain("Earlier reasoning");
  // The refresh after a reconnect replaces the status; without a live state it falls back to the plain label.
  current = snap(ID1, running);
  act(() => { callbacks.subscription!.ready(); });
  await waitFor(() => expect(status()?.textContent).toBe("Replying…"));
});

test("elapsed time shows for a long run and keeps counting between events", async () => {
  current = snap(ID1, running, { live: live({ elapsedMs: 3_000 }) });
  await open();
  expect(document.querySelector('[data-ui="copilot-elapsed"]')).toBeNull();
  current = snap(ID1, running, { live: live({ elapsedMs: 9_900 }) });
  act(() => { callbacks.subscription!.ready(); });
  // 9.9 s plus the real second that passes crosses the 10 s mark without another event.
  await waitFor(() => expect(document.querySelector('[data-ui="copilot-elapsed"]')!.textContent).toMatch(/^Elapsed 0:1\d$/), { timeout: 3000 });
});

test("streaming keeps the scroll position when the user scrolled up and follows at the bottom", async () => {
  current = snap(ID1, running, { live: live({ phase: "thinking", thinking: "a" }) });
  await open();
  const box = document.querySelector('[data-ui="copilot-messages"]') as HTMLDivElement;
  Object.defineProperty(box, "scrollHeight", { configurable: true, value: 1000 });
  Object.defineProperty(box, "clientHeight", { configurable: true, value: 200 });
  // Scrolled up: a new thinking delta must not move the position.
  box.scrollTop = 100; fireEvent.scroll(box);
  deliver(streamEvent(2, { live: live({ phase: "thinking", thinking: "a b" }) }));
  await waitFor(() => expect(thinkingBlock()!.textContent).toContain("a b"));
  expect(box.scrollTop).toBe(100);
  // At the bottom: it follows.
  box.scrollTop = 800; fireEvent.scroll(box);
  deliver(streamEvent(3, { live: live({ phase: "thinking", thinking: "a b c" }) }));
  await waitFor(() => expect(thinkingBlock()!.textContent).toContain("a b c"));
  expect(box.scrollTop).toBe(1000);
});

test("a call whose action is not parsed yet never shows a raw tool id; one persistent status region announces the text", async () => {
  current = snap(ID1, running, { live: live({ phase: "operation", operation: { tool: "reader" } }) });
  await open();
  const region = document.querySelector('[data-ui="copilot-run-live"]') as HTMLElement;
  expect(region.getAttribute("role")).toBe("status");
  await waitFor(() => expect(status()?.textContent).toBe("Working…"));
  expect(region.textContent).not.toContain("reader");
  deliver(streamEvent(2, { live: live({ phase: "operation", operation: { tool: "reader", action: "read_page_image", page: 2 } }) }));
  await waitFor(() => expect(status()?.textContent).toMatch(/page 2/));
  // The same element stays mounted across the changes (so a screen reader hears the text change).
  expect(document.querySelector('[data-ui="copilot-run-live"]')).toBe(region);
  expect(region.contains(status())).toBe(true);
});

test("the newest reply's call without a result is shown as pending while the run works, finished steps keep their reasoning", async () => {
  current = snap(ID1, running, { live: live(), messages: [{ id: "a1", role: "assistant", text: "", thinking: "Step one reasoning", operations: [{ id: "c1", tool: "plan", action: "read", status: "unknown" }] }] });
  await open();
  await waitFor(() => expect(document.querySelector('[data-ui="copilot-operation-item"]')?.getAttribute("data-status")).toBe("pending"));
  expect(document.querySelector('[data-ui="copilot-reasoning"]')!.textContent).toContain("Step one reasoning");
  expect(document.querySelector('[data-ui="copilot-reasoning"] summary')!.textContent).toBe("Reasoning");
});
