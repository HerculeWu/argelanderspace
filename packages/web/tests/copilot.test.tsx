import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConversationSnapshot, CopilotProvider, PageContext, WsCopilotEvent } from "@argelanderspace/contracts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Copilot } from "../src/copilot/Copilot";
import i18n from "../src/i18n";

const callbacks = vi.hoisted(() => ({ subscription: null as null | { event: (event: WsCopilotEvent) => void; ready: () => void; connection: (value: boolean) => void } }));
vi.mock("../src/api/ws", () => ({ subscribeCopilot: (subscription: NonNullable<typeof callbacks.subscription>) => { callbacks.subscription = subscription; queueMicrotask(subscription.ready); return () => { callbacks.subscription = null; }; } }));
const context: PageContext = { version: 1, viewId: "00000000-0000-4000-8000-000000000001", paneId: 1, revision: 1, view: "doc", status: "unavailable", otherPanes: [], plan: null };
const snapshot: ConversationSnapshot = { version: 1, conversation: { version: 1, id: "00000000-0000-4000-8000-000000000002", sessionId: "00000000-0000-4000-8000-000000000003", title: "Test conversation", createdAt: "2026-10-02", updatedAt: "2026-10-02", model: { provider: "openai", model: "test", thinking: null }, run: null }, messages: [], stream: "", eventCursor: { instanceId: "00000000-0000-4000-8000-000000000004", seq: 1 } };
const provider: CopilotProvider = { id: "openai", name: "OpenAI", method: "api_key", credential: { configured: true, stored: true, source: "stored" }, catalogStatus: "ready", models: [{ id: "test", name: "Test", baseUrl: "https://example.invalid", contextWindow: 10000, maxTokens: 1000, tools: true, image: false, thinkingLevels: ["off", "low", "high"], capabilitiesKnown: true, defaultThinking: "high", defaultThinkingValid: true }] };
let fetchMock: ReturnType<typeof vi.fn>;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
beforeEach(async () => {
  await i18n.changeLanguage("en"); callbacks.subscription = null;
  fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/providers")) return json({ version: 1, providers: [provider] });
    if (url.endsWith("/conversations")) return options?.method === "POST" ? json(snapshot, 201) : json({ version: 1, conversations: [snapshot.conversation] });
    if (url.endsWith("/messages")) return json({ messageId: "message", runId: "run" }, 202);
    if (url.includes("/views/")) return json({ saved: true });
    return json(snapshot);
  }); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const open = async () => { render(<Copilot open context={context} onClose={vi.fn()} />); await screen.findByText("Copilot"); await waitFor(() => expect((document.querySelector('[data-ui="copilot-thinking"]') as HTMLSelectElement).disabled).toBe(false)); };

test("Enter respects IME and Shift, sends complete publication once, and retains input on failure", async () => {
  await open(); const input = document.querySelector('[data-ui="copilot-input"]') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "A task" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true }); fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/messages"))).toHaveLength(0);
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(input.value).toBe(""));
  const calls = fetchMock.mock.calls; const publish = calls.findIndex(([url]) => url.includes("/views/")), send = calls.findIndex(([url]) => url.endsWith("/messages"));
  expect(publish).toBeLessThan(send); expect(JSON.parse(calls[publish]![1]!.body as string)).toEqual(context);
  fetchMock.mockImplementation(async (url: string) => url.endsWith("/messages") ? json({ code: "storage" }, 503) : url.includes("/views/") ? json({ saved: true }) : url.endsWith("/providers") ? json({ providers: [provider] }) : url.endsWith("/conversations") ? json({ conversations: [snapshot.conversation] }) : json(snapshot));
  fireEvent.change(input, { target: { value: "Preserve this input" } }); fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByText(/Conversation storage failed/); expect(input.value).toBe("Preserve this input");
});

test("stream events older than snapshot are discarded and manual upscroll is not moved", async () => {
  await open(); const pane = document.querySelector('[data-ui="copilot-messages"]') as HTMLDivElement;
  Object.defineProperties(pane, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 300 } });
  pane.scrollTop = 100; fireEvent.scroll(pane);
  act(() => callbacks.subscription!.event({ type: "copilot.event", conversationId: snapshot.conversation.id, runId: null, eventCursor: { ...snapshot.eventCursor, seq: 0 }, kind: "stream", text: "Old duplicate" }));
  expect(screen.queryByText("Old duplicate")).toBeNull();
  act(() => callbacks.subscription!.event({ type: "copilot.event", conversationId: snapshot.conversation.id, runId: null, eventCursor: { ...snapshot.eventCursor, seq: 2 }, kind: "stream", text: "New reply" }));
  await screen.findByText("New reply"); expect(pane.scrollTop).toBe(100); expect(screen.getByRole("button", { name: "View new content" })).toBeTruthy();
});

test("Retry restores the subscribed authority snapshot, buffered events, connection and input", async () => {
  let snapshotGets = 0;
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith("/providers")) return json({ providers: [provider] });
    if (url.endsWith("/conversations")) return json({ conversations: [snapshot.conversation] });
    if (url.includes("/views/")) return json({ saved: true });
    return ++snapshotGets === 1 ? json({ code: "storage" },503) : json(snapshot);
  });
  render(<Copilot open context={context} onClose={vi.fn()} />);
  await screen.findByText(/Conversation storage failed/);
  act(() => callbacks.subscription!.event({ type: "copilot.event", conversationId: snapshot.conversation.id, runId: null, eventCursor: { ...snapshot.eventCursor, seq: 2 }, kind: "stream", text: "Buffered after failure" }));
  fireEvent.click(screen.getByRole("button",{ name: "Retry" }));
  await screen.findByText("Buffered after failure");expect(snapshotGets).toBe(2);
  expect(document.querySelector('[data-ui="copilot-error"]')).toBeNull();expect(document.querySelector('[data-ui="copilot-disconnected"]')).toBeNull();
  fireEvent.change(document.querySelector('[data-ui="copilot-input"]')!,{ target: { value: "Retry recovered" } });
  expect((document.querySelector('[data-ui="copilot-send"]') as HTMLButtonElement).disabled).toBe(false);
});

test("Plan detail translates view, saving and task enums at rendering time", async () => {
  const planContext: PageContext = { ...context, view: "plan", status: "complete", plan: { rev: 1, mode: "board", selectedPlanId: "p_00000001", groups: [], detail: null, saveState: "pending", plans: [{ id: "p_00000001", name: "Task scope", icon: "target", due: "2026-12-01", created_at: "2026-10-02T00:00:00Z", tasks: [{ id: "t_00000001", title: "Task title", status: "todo", focused: false, due: "2026-12-01", links: [], created_at: "2026-10-02T00:00:00Z" }] }] } };
  render(<Copilot open context={planContext} onClose={vi.fn()} />);
  fireEvent.click(document.querySelector('[data-ui="copilot-context"]')!);
  const detail = document.querySelector('.copilot-context-detail')!;
  expect(detail.textContent).toContain(i18n.t("plan.modes.board"));expect(detail.textContent).toContain(i18n.t("copilot.saving"));
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(detail.textContent).toContain(i18n.t("plan.modes.board"));expect(detail.textContent).toContain(i18n.t("copilot.saving"));expect(detail.textContent).toContain(i18n.t("plan.status.todo"));
  expect(detail.textContent).not.toContain("board");expect(detail.textContent).not.toContain("pending");expect(detail.textContent).not.toContain("todo");
});

test("bound page revisions publish while running and with the sidebar collapsed", async () => {
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => url.endsWith("/providers") ? json({ providers: [provider] }) : url.endsWith("/conversations") ? json({ conversations: [snapshot.conversation] }) : url.includes("/views/") ? json({ saved: true }) : json({ ...snapshot, conversation: { ...snapshot.conversation, run: { id: "run", status: "running", error: null } } }));
  const component = render(<Copilot open context={context} onClose={vi.fn()} />);
  await screen.findByText("Replying…");
  component.rerender(<Copilot open context={{ ...context, revision: 2, view: "library" }} onClose={vi.fn()} />);
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url,options]) => url.includes("/views/") && JSON.parse(options!.body as string).revision === 2)).toHaveLength(1));
  component.rerender(<Copilot open={false} context={{ ...context, revision: 3, view: "write" }} onClose={vi.fn()} />);
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url,options]) => url.includes("/views/") && JSON.parse(options!.body as string).revision === 3)).toHaveLength(1));
  expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/messages"))).toHaveLength(0);
});
