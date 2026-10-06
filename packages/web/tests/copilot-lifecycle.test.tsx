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
const calls = (suffix: string) => fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix));
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
const input = () => document.querySelector('[data-ui="copilot-input"]') as HTMLTextAreaElement;

test("while the run works, Enter steers (no second run), Stop is separate and closes sending", async () => {
  await open();
  await screen.findByText("Replying…");
  expect(document.querySelector('[data-ui="copilot-stop"]')).not.toBeNull();
  // Prototype A: while running the slot is Stop and Enter sends the steering; there is no second send button.
  expect(document.querySelector('[data-ui="copilot-send"]')).toBeNull();
  fireEvent.change(input(), { target: { value: "Also check the due dates" } });
  expect(document.querySelector('[data-ui="copilot-send"]')).toBeNull();
  fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
  fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });
  expect(calls("/messages")).toHaveLength(0);
  fireEvent.keyDown(input(), { key: "Enter" });
  await waitFor(() => expect(calls("/messages")).toHaveLength(1));
  expect(JSON.parse((calls("/messages")[0]![1] as RequestInit).body as string)).toMatchObject({ text: "Also check the due dates", viewId: context.viewId });
  expect(calls("/stop")).toHaveLength(0);
  await waitFor(() => expect(input().value).toBe(""));
  fireEvent.click(document.querySelector('[data-ui="copilot-stop"]')!);
  await waitFor(() => expect(calls("/stop")).toHaveLength(1));
  await waitFor(() => expect(document.querySelector('[data-ui="copilot-running"]')!.textContent).toContain("Stopping"));
  const stop = document.querySelector('[data-ui="copilot-stop"]') as HTMLButtonElement;
  expect(stop.disabled).toBe(true);
  // While stopping, no further message is sent.
  fireEvent.change(input(), { target: { value: "too late" } });
  fireEvent.keyDown(input(), { key: "Enter" });
  await new Promise((r) => setTimeout(r, 30));
  expect(calls("/messages")).toHaveLength(1);
});

test("a queued steering message is marked until the model reads it", async () => {
  current = snap(ID1, running, { messages: [{ id: "m1", role: "user", text: "First task", context: { contextId: "c1", view: "doc", status: "unavailable", revision: 1, objects: [] } }, { id: "m2", role: "user", text: "Steer me", pending: true, context: { contextId: "c2", view: "doc", status: "unavailable", revision: 2, objects: [] } }] });
  await open();
  await screen.findByText("Steer me");
  const queued = document.querySelectorAll('[data-ui="copilot-queued"]');
  expect(queued).toHaveLength(1);
});

test("an interrupted or stopped run waits for an explicit Resume; resume retries reuse one clientMessageId", async () => {
  current = snap(ID1, { id: running.id, status: "interrupted", error: "interrupted" });
  await open();
  await screen.findByText(/restarted during this run/);
  await new Promise((r) => setTimeout(r, 50));
  expect(calls("/resume")).toHaveLength(0);
  expect(calls("/messages")).toHaveLength(0);
  let fail = true;
  const base = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => (String(url).endsWith("/resume") && fail ? json({ code: "unavailable" }, 503) : base(url, options)));
  fireEvent.click(document.querySelector('[data-ui="copilot-resume"]')!);
  await screen.findByText(/Model request or connection failed/);
  fail = false;
  fireEvent.click(document.querySelector('[data-ui="copilot-resume"]')!);
  await waitFor(() => expect(calls("/resume")).toHaveLength(2));
  const bodies = calls("/resume").map(([, options]) => JSON.parse((options as RequestInit).body as string));
  expect(bodies[0].clientMessageId).toBe(bodies[1].clientMessageId);
  expect(bodies[1]).toMatchObject({ viewId: context.viewId, contextRevision: context.revision });
});

const action = () => document.querySelector('.copilot-composer-actions [data-ui="copilot-send"], .copilot-composer-actions [data-ui="copilot-stop"], .copilot-composer-actions [data-ui="copilot-resume"]') as HTMLButtonElement;
// The three states draw three different catalog icons: arrow-up (send), square (stop), play triangle (resume).
const glyph = (button: Element) => button.querySelector("polygon") ? "play" : button.querySelector("rect") ? "square" : button.querySelector("path") ? "arrow" : "none";

test("a stopped run shows no note and no pop-up; the composer's one button becomes Resume and goes through the same resume handler", async () => {
  current = snap(ID1, { id: running.id, status: "stopped", error: null }, { messages: [{ id: "r1", role: "user", kind: "resume", text: "HOST WRITTEN INSTRUCTION", context: { contextId: "c1", view: "doc", status: "unavailable", revision: 1, objects: [] } }] });
  await open();
  expect(await screen.findByText("Resumed after an interruption")).toBeTruthy();
  expect(screen.queryByText("HOST WRITTEN INSTRUCTION")).toBeNull();
  expect(screen.queryByText(/Stopped\. Operations that already ran/)).toBeNull();
  expect(document.querySelector('[data-ui="copilot-stopped"]')).toBeNull();
  expect(document.querySelector('[data-ui="copilot-run-result"]')).toBeNull();
  expect(document.querySelectorAll('[data-ui="copilot-resume"]')).toHaveLength(1);
  const button = action();
  expect(button.dataset.ui).toBe("copilot-resume");
  expect(button.getAttribute("aria-label")).toBe("Resume");
  expect(glyph(button)).toBe("play");
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  await waitFor(() => expect(calls("/resume")).toHaveLength(1));
  expect(JSON.parse((calls("/resume")[0]![1] as RequestInit).body as string)).toMatchObject({ viewId: context.viewId, contextRevision: context.revision });
  expect(calls("/messages")).toHaveLength(0);
});

test("typed text in a stopped state still goes out with Enter, as a message", async () => {
  current = snap(ID1, { id: running.id, status: "stopped", error: null });
  await open();
  await waitFor(() => expect(action().dataset.ui).toBe("copilot-resume"));
  fireEvent.change(input(), { target: { value: "Carry on with the second plan" } });
  fireEvent.keyDown(input(), { key: "Enter" });
  await waitFor(() => expect(calls("/messages")).toHaveLength(1));
  expect(JSON.parse((calls("/messages")[0]![1] as RequestInit).body as string)).toMatchObject({ text: "Carry on with the second plan" });
  expect(calls("/resume")).toHaveLength(0);
});

test("the one composer button is send when idle, stop while running, resume after an interruption, with a label and tooltip name per state", async () => {
  current = snap(ID1, null);
  const idle = await open();
  let button = action();
  expect(button.dataset.ui).toBe("copilot-send");
  expect(button.getAttribute("aria-label")).toBe("Send");
  expect(glyph(button)).toBe("arrow");
  expect(button.disabled).toBe(true); // nothing typed
  fireEvent.change(input(), { target: { value: "hello" } });
  expect(action().disabled).toBe(false);
  idle.unmount(); cleanup();
  current = snap(ID1, running);
  const live = await open();
  await waitFor(() => expect(action().dataset.ui).toBe("copilot-stop"));
  button = action();
  expect(button.getAttribute("aria-label")).toBe("Stop");
  expect(glyph(button)).toBe("square");
  live.unmount(); cleanup();
  current = snap(ID1, { id: running.id, status: "interrupted", error: "interrupted" });
  await open();
  await waitFor(() => expect(action().dataset.ui).toBe("copilot-resume"));
  button = action();
  expect(glyph(button)).toBe("play");
  // The interrupted note stays (the service, not the user, ended the run) but carries no second Resume button.
  expect(document.querySelector('[data-ui="copilot-interrupted"]')).not.toBeNull();
  expect(document.querySelectorAll('[data-ui="copilot-resume"]')).toHaveLength(1);
  await i18n.changeLanguage("zh-CN");
  await waitFor(() => expect(action().getAttribute("aria-label")).toBe("继续"));
});

test("a failed run keeps its notice with Retry; the composer button stays Send", async () => {
  current = snap(ID1, { id: running.id, status: "failed", error: "transient" });
  await open();
  await waitFor(() => expect(document.querySelector('[data-ui="copilot-run-error"]')).not.toBeNull());
  const retry = document.querySelector('[data-ui="copilot-run-result"] [data-ui="copilot-resume"]') as HTMLButtonElement;
  expect(retry.textContent).toBe("Retry");
  expect(action().dataset.ui).toBe("copilot-send");
  fireEvent.click(retry);
  await waitFor(() => expect(calls("/resume")).toHaveLength(1));
});

test("the composer has no attach button, no file input, no scope hint and no empty footer spacer", async () => {
  current = snap(ID1, null);
  await open();
  expect(document.querySelector('[data-ui="copilot-attach"]')).toBeNull();
  expect(document.querySelector('[data-ui="copilot-attach-input"]')).toBeNull();
  expect(document.querySelector('input[type="file"]')).toBeNull();
  expect(screen.queryByText("Actions available in this view")).toBeNull();
  const foot = document.querySelector(".copilot-composer-foot")!;
  expect(foot.children).toHaveLength(1);
  expect(foot.querySelector('[data-ui="copilot-thinking"]')).not.toBeNull();
  expect(foot.querySelector("span")).toBeNull();
  // The model name's arrow sits before the select (on its left).
  const pick = document.querySelector(".copilot-model-pick")!;
  expect(pick.firstElementChild!.tagName.toLowerCase()).toBe("svg");
  expect(pick.lastElementChild!.getAttribute("data-ui")).toBe("copilot-model");
  const en = (await import("../src/locales/en.json")).default as unknown as { copilot: Record<string, unknown> };
  const zh = (await import("../src/locales/zh-CN.json")).default as unknown as { copilot: Record<string, unknown> };
  for (const key of ["scope", "stoppedNote", "attach", "attachUploading", "attachRetry", "attachRemove", "attachFailed", "attachTooLarge", "attachRetryNamed"]) { expect(key in en.copilot).toBe(false); expect(key in zh.copilot).toBe(false); }
});

test("a burst of page revisions is published as the newest one, and a send waits behind it and names the published revision", async () => {
  current = snap(ID1, null);
  const gateOpen: (() => void)[] = [];
  const base = fetchMock.getMockImplementation()!;
  const puts: number[] = [];
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (String(url).includes("/views/")) { const revision = JSON.parse((options as RequestInit).body as string).revision; puts.push(revision); if (revision === 1) await new Promise<void>((resolve) => gateOpen.push(resolve)); return json({ saved: true }); }
    return base(url, options);
  });
  const view = await open();
  await waitFor(() => expect(puts).toEqual([1]));
  for (const revision of [2, 3, 4, 5]) view.rerender(<Copilot open context={{ ...context, revision }} onClose={vi.fn()} />);
  fireEvent.change(input(), { target: { value: "Send now" } });
  view.rerender(<Copilot open context={{ ...context, revision: 6 }} onClose={vi.fn()} />);
  fireEvent.keyDown(input(), { key: "Enter" });
  await new Promise((r) => setTimeout(r, 20));
  // Nothing overtakes the first publication, and no stale revision is sent afterwards.
  expect(puts).toEqual([1]);
  gateOpen[0]!();
  await waitFor(() => expect(calls("/messages")).toHaveLength(1));
  expect(puts).toEqual([1, 6]);
  expect(JSON.parse((calls("/messages")[0]![1] as RequestInit).body as string).contextRevision).toBe(6);
  expect(puts.every((revision, index) => index === 0 || revision > puts[index - 1]!)).toBe(true);
});

test("after F5 the conversation this browser was showing is restored, falling back to the latest", async () => {
  listed = { conversations: [conversation(ID1, null, "Latest"), conversation(ID2, null, "Earlier")] };
  memory.set("argelander.copilot.conversation", ID2);
  const view = await open();
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(`/conversations/${ID2}`))).toBe(true));
  expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(`/conversations/${ID1}`))).toBe(false);
  view.unmount(); cleanup(); fetchMock.mockClear();
  memory.set("argelander.copilot.conversation", "00000000-0000-4000-8000-0000000000ff");
  await open();
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(`/conversations/${ID1}`))).toBe(true));
});

test("the conversation list shows each real status and one unreadable record never hides the others", async () => {
  listed = { conversations: [conversation(ID1, running, "Busy one"), conversation(ID2, { id: running.id, status: "interrupted", error: "interrupted" }, "Cut off")], unreadable: [{ id: "broken", code: "storage" }] };
  await open();
  fireEvent.click(document.querySelector('[data-ui="copilot-conversations"]')!);
  const rows = await waitFor(() => { const found = document.querySelectorAll('[data-ui="copilot-conversation"]'); expect(found).toHaveLength(2); return found; });
  expect(rows[0]!.getAttribute("data-status")).toBe("running");
  expect(rows[0]!.textContent).toContain("Working");
  expect(rows[1]!.textContent).toContain("Interrupted");
  expect(document.querySelectorAll('[data-ui="copilot-conversation-unreadable"]')).toHaveLength(1);
});

test("thinking levels, versions and due dates are translated at render time, not shown as raw codes", async () => {
  current = snap(ID1, null, { messages: [{ id: "m1", role: "user", text: "Hi", context: { contextId: "c1", view: "plan", status: "complete", revision: 1, objects: [{ id: "p_00000001", rev: 3, name: "Plan A" }] } }] });
  const planContext: PageContext = { ...context, view: "plan", status: "complete", plan: { rev: 3, mode: "list", selectedPlanId: "p_00000001", groups: [], detail: null, saveState: "saved", plans: [{ id: "p_00000001", name: "Plan A", icon: "target", due: "2026-12-01", created_at: "2026-10-02T00:00:00Z", tasks: [{ id: "t_00000001", title: "Task title", status: "todo", focused: false, due: "2026-12-01", links: [], created_at: "2026-10-02T00:00:00Z" }] }] } };
  await open(planContext);
  const thinking = document.querySelector('[data-ui="copilot-thinking"]') as HTMLSelectElement;
  expect([...thinking.options].map((option) => option.textContent)).toEqual(["Use default · High", "Off", "Low", "High"]);
  await screen.findByText("Hi");
  fireEvent.click(document.querySelector('[data-ui="copilot-message-context"] summary')!);
  expect(document.querySelector('[data-ui="copilot-message-context"]')!.textContent).toContain("Plan A · v3");
  fireEvent.click(document.querySelector('[data-ui="copilot-context"]')!);
  const detailEn = document.querySelector(".copilot-context-detail")!;
  expect(detailEn.textContent).toContain("v3");
  expect(detailEn.textContent).not.toContain("2026-12-01");
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect([...thinking.options].map((option) => option.textContent)).toEqual(["沿用默认 · 高", "关闭", "低", "高"]);
  expect(document.querySelector('[data-ui="copilot-message-context"]')!.textContent).toContain("Plan A · 版本 3");
  expect(detailEn.textContent).toContain("版本 3");
  expect(detailEn.textContent).not.toMatch(/\bv3\b/);
  expect(detailEn.textContent).toContain("12月1日");
});

test("after the service restarts the page is published again, so Resume is not refused as stale", async () => {
  current = snap(ID1, { id: running.id, status: "interrupted", error: "interrupted" });
  await open();
  await screen.findByText(/restarted during this run/);
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/views/"))).toHaveLength(1));
  // The service restarted: the WebSocket resubscribes and the same revision must be sent again.
  act(() => callbacks.subscription!.ready());
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/views/"))).toHaveLength(2));
  // And a refused-as-stale send forgets what it believed was published.
  const base = fetchMock.getMockImplementation()!;
  let refuse = true;
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => (String(url).endsWith("/resume") && refuse ? json({ code: "stale" }, 409) : base(url, options)));
  fireEvent.click(document.querySelector('[data-ui="copilot-resume"]')!);
  await screen.findByText(/Page context changed/);
  refuse = false;
  const before = fetchMock.mock.calls.filter(([url]) => String(url).includes("/views/")).length;
  fireEvent.click(document.querySelector('[data-ui="copilot-resume"]')!);
  await waitFor(() => expect(calls("/resume").length).toBeGreaterThanOrEqual(2));
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/views/")).length).toBe(before + 1);
});

test("the work-continues note names the original object only when it is unambiguous", async () => {
  const objects = (list: { id: string; rev: number; name?: string }[]) => snap(ID1, running, { messages: [{ id: "m1", role: "user", text: "Task", context: { contextId: "c1", view: "plan", status: "complete", revision: 1, objects: list } }] });
  const planContext = (selected: string): PageContext => ({ ...context, view: "plan", status: "complete", plan: { rev: 3, mode: "list", selectedPlanId: selected, groups: [], detail: null, saveState: "saved", plans: [] } });
  current = objects([{ id: "p_00000001", rev: 3, name: "Alpha" }]);
  let view = await open(planContext("p_00000002"));
  await waitFor(() => expect(document.querySelector('[data-ui="copilot-work-continues"]')?.textContent).toContain("Alpha"));
  view.unmount(); cleanup();
  current = objects([{ id: "p_00000001", rev: 3, name: "Alpha" }, { id: "p_00000003", rev: 3, name: "Gamma" }]);
  view = await open(planContext("p_00000002"));
  await waitFor(() => expect(document.querySelector('[data-ui="copilot-work-continues"]')?.textContent).toContain("original page"));
  expect(document.querySelector('[data-ui="copilot-work-continues"]')?.textContent).not.toContain("Alpha");
  view.unmount(); cleanup();
  // Viewing one of the task's own objects shows no note.
  view = await open(planContext("p_00000003"));
  await sleep(50);
  expect(document.querySelector('[data-ui="copilot-work-continues"]')).toBeNull();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
