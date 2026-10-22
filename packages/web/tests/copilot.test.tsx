import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConversationSnapshot, CopilotProvider, PageContext, WsCopilotEvent } from "@argelanderspace/contracts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Copilot } from "../src/copilot/Copilot";
import i18n from "../src/i18n";
import { selectIsDisabled } from "./select-helpers";

const callbacks = vi.hoisted(() => ({ subscription: null as null | { event: (event: WsCopilotEvent) => void; viewAction?: (message: { type: "copilot.view-action"; viewId: string; actionId: string; action: unknown }) => void; ready: () => void; connection: (value: boolean) => void } }));
vi.mock("../src/api/ws", () => ({ subscribeCopilot: (subscription: NonNullable<typeof callbacks.subscription>) => { callbacks.subscription = subscription; queueMicrotask(subscription.ready); return () => { callbacks.subscription = null; }; } }));
const context: PageContext = { version: 1, viewId: "00000000-0000-4000-8000-000000000001", paneId: 1, revision: 1, view: "doc", status: "unavailable", otherPanes: [], plan: null };
const snapshot: ConversationSnapshot = { version: 1, conversation: { version: 1, id: "00000000-0000-4000-8000-000000000002", sessionId: "00000000-0000-4000-8000-000000000003", title: "Test conversation", createdAt: "2026-10-02", updatedAt: "2026-10-02", model: { provider: "openai", model: "test", thinking: null }, run: null }, messages: [], confirmations: [], stream: "", eventCursor: { instanceId: "00000000-0000-4000-8000-000000000004", seq: 1 } };
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
const open = async () => { render(<Copilot open context={context} onClose={vi.fn()} />); await screen.findByText("Copilot"); await waitFor(() => expect(selectIsDisabled(document.querySelector('[data-ui="copilot-thinking"]')!)).toBe(false)); };

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

test("WS reconnect re-subscription clears the disconnected state and re-enables send", async () => {
  await open();
  act(() => callbacks.subscription!.connection(false));
  await waitFor(() => expect(document.querySelector('[data-ui="copilot-disconnected"]')).not.toBeNull());
  act(() => callbacks.subscription!.ready());
  await waitFor(() => expect(document.querySelector('[data-ui="copilot-disconnected"]')).toBeNull());
  fireEvent.change(document.querySelector('[data-ui="copilot-input"]')!, { target: { value: "After reconnect" } });
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

test("assistant operation records show each action with its real outcome and never present a failure as applied", async () => {
  const withOps: ConversationSnapshot = { ...snapshot, messages: [
    { id: "m1", role: "assistant", text: "", operations: [
      { id: "c1", tool: "plan", action: "update_task", status: "ok", rev: 8, label: "Task <b>1</b>", object: { kind: "task", id: "t_00000001", planId: "p_0000000a" }, warnings: ["task_due_after_plan_due"] },
      { id: "c2", tool: "plan", action: "update_task", status: "conflict", rev: 9 },
      { id: "c3", tool: "plan", action: "show", status: "not_displayed" },
      { id: "c4", tool: "plan", action: "move_task", status: "unknown" },
    ] },
    { id: "m2", role: "assistant", text: "Done", operations: [{ id: "c5", tool: "plan", action: "read", status: "ok", rev: 8 }] },
  ] };
  fetchMock.mockImplementation(async (url: string) => url.endsWith("/providers") ? json({ providers: [provider] }) : url.endsWith("/conversations") ? json({ conversations: [snapshot.conversation] }) : url.includes("/views/") ? json({ saved: true }) : json(withOps));
  await open();
  const records = await waitFor(() => { const found = document.querySelectorAll('[data-ui="copilot-operation"]'); expect(found).toHaveLength(2); return found; });
  expect(records[0]!.querySelector("summary")?.textContent).toContain("4 Plan actions");
  expect(records[0]!.querySelector("summary")?.textContent).toContain("3 not applied");
  expect(records[1]!.querySelector("summary")?.textContent).toBe("Read plans");
  const items = [...records[0]!.querySelectorAll<HTMLElement>('[data-ui="copilot-operation-item"]')];
  expect(items.map((item) => item.getAttribute("data-status"))).toEqual(["ok", "conflict", "not_displayed", "unknown"]);
  expect(items[0]!.textContent).toContain("Applied");
  expect(items[0]!.textContent).toContain("Due is after the plan deadline");
  expect(items[0]!.querySelector("b")).toBeNull(); // user data stays text
  expect(items[1]!.textContent).toContain("Plans changed first");
  expect(items[2]!.textContent).toContain("Not shown");
  expect(items[3]!.textContent).toContain("Outcome unknown");
  expect(items.slice(1).some((item) => item.textContent?.includes("Applied"))).toBe(false);
  // a message that only requested actions has no empty reply bubble
  expect(document.querySelectorAll('[data-ui="copilot-message"]')[0]!.querySelector(".copilot-markdown")).toBeNull();
});

test("a view action runs once, reports what the page really did, and a failed report cannot mark it displayed", async () => {
  const handler = vi.fn(async (action: unknown) => (action as { action: string }).action === "open_task" ? ({ ok: false, detail: "not_found" as const }) : ({ ok: true as const }));
  render(<Copilot open context={context} onClose={vi.fn()} onViewAction={handler} />);
  await screen.findByText("Copilot");
  await waitFor(() => expect(callbacks.subscription?.viewAction).toBeTypeOf("function"));
  const message = (actionId: string, action: unknown) => ({ type: "copilot.view-action" as const, viewId: context.viewId, actionId, action });
  const id1 = "00000000-0000-4000-8000-0000000000a1", id2 = "00000000-0000-4000-8000-0000000000a2";
  act(() => { callbacks.subscription!.viewAction!(message(id1, { action: "show", view: "board" })); callbacks.subscription!.viewAction!(message(id1, { action: "show", view: "board" })); });
  act(() => callbacks.subscription!.viewAction!(message(id2, { action: "open_task", taskId: "t_ffffffff" })));
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/action-results"))).toHaveLength(2), { timeout: 3000 });
  expect(handler).toHaveBeenCalledTimes(2);
  const reports = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/action-results")).map(([url, options]) => ({ url: String(url), body: JSON.parse((options as RequestInit).body as string) }));
  // An applied action may wait for its page, a failed one does not: the reports are matched by action, not by arrival order.
  expect(reports.find((report) => report.body.actionId === id1)).toEqual({ url: `/api/copilot/views/${context.viewId}/action-results`, body: { actionId: id1, ok: true } });
  expect(reports.find((report) => report.body.actionId === id2)!.body).toEqual({ actionId: id2, ok: false, detail: "not_found" });
});

test("an explicit request to open the Copilot settings shows the panel and the provider dialog, reports it, and sends no secret anywhere", async () => {
  const handler = vi.fn(async () => ({ ok: true as const }));
  const openPanel = vi.fn();
  render(<Copilot open={false} context={context} onClose={vi.fn()} onViewAction={handler} onOpenPanel={openPanel} />);
  await waitFor(() => expect(callbacks.subscription?.viewAction).toBeTypeOf("function"));
  expect(document.querySelector('[data-ui="provider-settings"]')).toBeNull();
  const actionId = "00000000-0000-4000-8000-0000000000b1";
  act(() => callbacks.subscription!.viewAction!({ type: "copilot.view-action", viewId: context.viewId, actionId, action: { action: "open_copilot_settings" } }));
  await waitFor(() => expect(document.querySelector('[data-ui="provider-settings"]')).not.toBeNull());
  expect(openPanel).toHaveBeenCalledTimes(1);
  expect(handler).not.toHaveBeenCalled(); // the panel's own dialog: the Shell is not asked
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/action-results"))).toBe(true));
  const report = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/action-results"))!;
  expect(JSON.parse((report[1] as RequestInit).body as string)).toEqual({ actionId, ok: true });
  // Opening the dialog sends nothing but that report: no key, no login, no provider mutation.
  expect(fetchMock.mock.calls.filter(([url, options]) => String(url).includes("/providers") && ((options as RequestInit | undefined)?.method ?? "GET") !== "GET")).toEqual([]);
});

test("a view action is reported only after the service holds the page that shows its effect", async () => {
  const order: string[] = [];
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/providers")) return json({ version: 1, providers: [provider] });
    if (url.endsWith("/conversations")) return json({ version: 1, conversations: [snapshot.conversation] });
    if (url.endsWith("/action-results")) { order.push("result"); return json({ saved: true }); }
    if (url.includes("/views/") && options?.method === "PUT") { order.push(`page:${JSON.parse(options.body as string).revision}`); return json({ saved: true }); }
    return json(snapshot);
  });
  function Host() {
    const [current, setCurrent] = useState(context);
    // the page changes a few renders after the action returns, like Shell -> LibraryView -> ExploreMode effects
    const onViewAction = async () => { setTimeout(() => setCurrent((previous) => ({ ...previous, revision: previous.revision + 1 })), 5); return { ok: true }; };
    return <Copilot open context={current} onClose={vi.fn()} onViewAction={onViewAction} />;
  }
  render(<Host />);
  await screen.findByText("Copilot");
  await waitFor(() => expect(callbacks.subscription?.viewAction).toBeTypeOf("function"));
  await waitFor(() => expect(order).toContain("page:1"));
  act(() => callbacks.subscription!.viewAction!({ type: "copilot.view-action", viewId: context.viewId, actionId: "00000000-0000-4000-8000-0000000000aa", action: { action: "show", view: "board" } }));
  await waitFor(() => expect(order).toContain("result"));
  expect(order.indexOf("page:2")).toBeGreaterThan(-1);
  expect(order.indexOf("page:2")).toBeLessThan(order.indexOf("result"));
});

// web-test-flake 03: "settled" used to mean "the revision did not move for 20 ms"; a page that re-renders later than that was reported stale.
test.each([5, 60, 250])("a view action whose page arrives %i ms after the action returns is still reported only after that page is published", async (delay) => {
  const order: string[] = [];
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/providers")) return json({ version: 1, providers: [provider] });
    if (url.endsWith("/conversations")) return json({ version: 1, conversations: [snapshot.conversation] });
    if (url.endsWith("/action-results")) { order.push("result"); return json({ saved: true }); }
    if (url.includes("/views/") && options?.method === "PUT") { order.push(`page:${JSON.parse(options.body as string).revision}`); return json({ saved: true }); }
    return json(snapshot);
  });
  function Host() {
    const [current, setCurrent] = useState(context);
    const onViewAction = async () => { setTimeout(() => setCurrent((previous) => ({ ...previous, revision: previous.revision + 1 })), delay); return { ok: true }; };
    return <Copilot open context={current} onClose={vi.fn()} onViewAction={onViewAction} />;
  }
  render(<Host />);
  await screen.findByText("Copilot");
  await waitFor(() => expect(callbacks.subscription?.viewAction).toBeTypeOf("function"));
  await waitFor(() => expect(order).toContain("page:1"));
  act(() => callbacks.subscription!.viewAction!({ type: "copilot.view-action", viewId: context.viewId, actionId: "00000000-0000-4000-8000-0000000000ab", action: { action: "show", view: "board" } }));
  await waitFor(() => expect(order).toContain("result"), { timeout: 3000 });
  expect(order.indexOf("page:2")).toBeGreaterThan(-1);
  expect(order.indexOf("page:2")).toBeLessThan(order.indexOf("result"));
});

test.each([[false], [true]])("a view action with ok=%s that changes no page: a failed one is reported at once, an applied one only after the fallback wait", async (applied) => {
  const order: string[] = [];
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/providers")) return json({ version: 1, providers: [provider] });
    if (url.endsWith("/conversations")) return json({ version: 1, conversations: [snapshot.conversation] });
    if (url.endsWith("/action-results")) { order.push("result"); return json({ saved: true }); }
    if (url.includes("/views/") && options?.method === "PUT") { order.push(`page:${JSON.parse(options.body as string).revision}`); return json({ saved: true }); }
    return json(snapshot);
  });
  render(<Copilot open context={context} onClose={vi.fn()} onViewAction={async () => (applied ? { ok: true } : { ok: false, detail: "not_found" as const })} />);
  await screen.findByText("Copilot");
  await waitFor(() => expect(callbacks.subscription?.viewAction).toBeTypeOf("function"));
  await waitFor(() => expect(order).toContain("page:1"));
  const started = Date.now();
  act(() => callbacks.subscription!.viewAction!({ type: "copilot.view-action", viewId: context.viewId, actionId: "00000000-0000-4000-8000-0000000000ac", action: { action: "open_task", taskId: "t_ffffffff" } }));
  await waitFor(() => expect(order).toContain("result"), { timeout: 3000 });
  const elapsed = Date.now() - started;
  if (applied) expect(elapsed).toBeGreaterThanOrEqual(380); // SETTLE_WAIT_MS (400) less timer slack
  else expect(elapsed).toBeLessThan(300);
});

test("the panel's own close button returns focus to the toolbar toggle", async () => {
  const onClose = vi.fn();
  render(<><button data-ui="copilot-toggle">toggle</button><Copilot open context={context} onClose={onClose} /></>);
  await screen.findByText("Copilot");
  const close = document.querySelector('[data-ui="copilot-close"]') as HTMLElement;
  close.focus();
  fireEvent.click(close);
  expect(onClose).toHaveBeenCalled();
  expect(document.activeElement).toBe(document.querySelector('[data-ui="copilot-toggle"]'));
});

test("a request from elsewhere (the settings page's entry) opens the provider settings dialog, once per request", async () => {
  const view = render(<Copilot open context={context} onClose={vi.fn()} settingsAsked={0} />);
  await screen.findByText("Copilot");
  expect(document.querySelector('[data-ui="provider-settings"]')).toBeNull();
  view.rerender(<Copilot open context={context} onClose={vi.fn()} settingsAsked={1} />);
  await waitFor(() => expect(document.querySelector('[data-ui="provider-settings"]')).not.toBeNull());
  // Closed by the person; the same count does not open it again, a new one does.
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await waitFor(() => expect(document.querySelector('[data-ui="provider-settings"]')).toBeNull());
  view.rerender(<Copilot open context={{ ...context, revision: 2 }} onClose={vi.fn()} settingsAsked={1} />);
  expect(document.querySelector('[data-ui="provider-settings"]')).toBeNull();
  view.rerender(<Copilot open context={{ ...context, revision: 2 }} onClose={vi.fn()} settingsAsked={2} />);
  await waitFor(() => expect(document.querySelector('[data-ui="provider-settings"]')).not.toBeNull());
});
