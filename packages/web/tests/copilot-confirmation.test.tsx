/**
 * Copilot human confirmation card and task-delete undo (ticket 11) at the component seam: the real Copilot
 * component against a scripted HTTP API. Layout is not proven here (happy-dom): the real browser is.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConversationSnapshot, CopilotConfirmation, CopilotDocConfirmation, CopilotPlanConfirmation, CopilotProvider, PageContext, WsCopilotEvent } from "@argelanderspace/contracts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Copilot } from "../src/copilot/Copilot";
import i18n from "../src/i18n";

const callbacks = vi.hoisted(() => ({ subscription: null as null | { event: (event: WsCopilotEvent) => void; ready: () => void; connection: (value: boolean) => void } }));
vi.mock("../src/api/ws", () => ({ subscribeCopilot: (subscription: NonNullable<typeof callbacks.subscription>) => { callbacks.subscription = subscription; queueMicrotask(subscription.ready); return () => { callbacks.subscription = null; }; } }));
const ID = "00000000-0000-4000-8000-000000000002";
const RUN = "00000000-0000-4000-8000-0000000000aa";
const CARD = "00000000-0000-4000-8000-0000000000cc";
const context: PageContext = { version: 1, viewId: "00000000-0000-4000-8000-000000000001", paneId: 1, revision: 1, view: "doc", status: "unavailable", otherPanes: [], plan: null };
const conversation = (status: "waiting-for-user" | "completed") => ({ version: 1 as const, id: ID, sessionId: "00000000-0000-4000-8000-000000000003", title: "Test conversation", createdAt: "2026-10-02", updatedAt: "2026-10-02", model: { provider: "openai", model: "test", thinking: null }, run: { id: RUN, status, error: null } });
const card = (over: Partial<CopilotPlanConfirmation> = {}): CopilotConfirmation => ({ id: CARD, runId: RUN, toolCallId: "call_1", action: "delete_plan", object: { kind: "plan", id: "p_0000000a", planId: "p_0000000a" }, label: "Alpha <b>plan</b>", planName: "Alpha <b>plan</b>", impact: { tasks: 3, openTasks: 2 }, baseRev: 7, objectDigest: "d".repeat(64), ...over });
const snap = (status: "waiting-for-user" | "completed", extra: Partial<ConversationSnapshot> = {}): ConversationSnapshot => ({ version: 1, conversation: conversation(status), messages: [], confirmations: [], stream: "", eventCursor: { instanceId: "00000000-0000-4000-8000-000000000004", seq: 1 }, ...extra });
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
  current = snap("waiting-for-user", { confirmations: [card()] });
  fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/providers")) return json({ version: 1, providers: [provider] });
    if (url.endsWith("/conversations")) return options?.method === "POST" ? json(current, 201) : json({ version: 1, conversations: [current.conversation], unreadable: [] });
    if (url.includes("/confirmations/")) return decisionStatus === 200 ? json({ status: JSON.parse(String(options?.body)).decision === "approve" ? "approved" : "declined" }) : json({ code: decisionStatus === 409 ? "stale" : "storage" }, decisionStatus);
    if (url.includes("/undo")) return json({ status: "ok", rev: 9 });
    if (url.includes("/views/")) return json({ saved: true });
    return json(current);
  }); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const open = async () => { const view = render(<Copilot open context={context} onClose={vi.fn()} />); await screen.findByText("Copilot"); return view; };
const ui = (name: string) => document.querySelector(`[data-ui="${name}"]`) as HTMLElement | null;

test("a waiting delete shows the object, its impact and the version, and the run is waiting for the user", async () => {
  await open();
  await waitFor(() => expect(ui("copilot-confirmation")).not.toBeNull());
  const shown = ui("copilot-confirmation") as HTMLElement;
  // User data is verbatim text, never markup.
  expect(shown.querySelector("h3")?.textContent).toBe("Delete the plan “Alpha <b>plan</b>”");
  expect(shown.querySelector("b")).toBeNull();
  expect(shown.textContent).toContain("3 tasks (2 unfinished) will be permanently deleted. This cannot be undone.");
  expect(shown.textContent).toContain("p_0000000a · plans v7");
  // One primary, danger action; the cancel is the neutral one. The run is waiting, not "Replying…".
  expect(ui("copilot-confirmation-confirm")?.className).toContain("danger");
  expect(ui("copilot-running")).toBeNull();
  expect(ui("copilot-stop")).not.toBeNull(); // Stop and steering still work while waiting
});

test("Confirm posts exactly the card's own action, object and version from this view; nothing else is sent", async () => {
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-confirm")).not.toBeNull());
  fireEvent.click(ui("copilot-confirmation-confirm")!);
  await waitFor(() => expect(calls("/confirmations/")).toHaveLength(1));
  const [url, options] = calls("/confirmations/")[0] as [string, RequestInit];
  expect(url).toBe(`/api/copilot/confirmations/${CARD}`);
  expect(JSON.parse(String(options.body))).toEqual({ decision: "approve", viewId: context.viewId, action: "delete_plan", objectId: "p_0000000a", baseRev: 7 });
});

test("Cancel declines; a second click while the request is in flight is ignored", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const base = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => { if (url.includes("/confirmations/")) { await gate; } return base(url, options); });
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-cancel")).not.toBeNull());
  fireEvent.click(ui("copilot-confirmation-cancel")!);
  fireEvent.click(ui("copilot-confirmation-cancel")!);
  fireEvent.click(ui("copilot-confirmation-confirm")!);
  await waitFor(() => expect((ui("copilot-confirmation-confirm") as HTMLButtonElement).disabled).toBe(true));
  release();
  await waitFor(() => expect(calls("/confirmations/")).toHaveLength(1));
  expect(JSON.parse(String((calls("/confirmations/")[0] as [string, RequestInit])[1].body)).decision).toBe("decline");
});

test("a rejected (stale) decision stays explained after the reread removes the card (the server's real state is returned)", async () => {
  decisionStatus = 409;
  const base = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    const response = await base(url, options);
    // The service expired the request: the next read has no card, like the real host.
    if (url.includes("/confirmations/")) current = snap("completed", { messages: [{ id: "m1", role: "assistant", text: "", operations: [{ id: "call_1", tool: "plan", action: "delete_plan", status: "expired", label: "Alpha" }] }] });
    return response;
  });
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-confirm")).not.toBeNull());
  fireEvent.click(ui("copilot-confirmation-confirm")!);
  await waitFor(() => expect(ui("copilot-confirmation")).toBeNull());
  expect(ui("copilot-confirmation-problem")?.textContent).toContain("The plans changed before your decision. Nothing was deleted.");
  expect(ui("copilot-confirmation-problem")?.getAttribute("role")).toBe("alert");
  // The record keeps saying so too.
  expect(document.querySelector('[data-ui="copilot-operation-item"]')?.getAttribute("data-status")).toBe("expired");
  fireEvent.click(ui("copilot-confirmation-problem-dismiss")!);
  expect(ui("copilot-confirmation-problem")).toBeNull();
});

test("a decision that could not be saved keeps the card and says so", async () => {
  decisionStatus = 503;
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-confirm")).not.toBeNull());
  fireEvent.click(ui("copilot-confirmation-confirm")!);
  await waitFor(() => expect(ui("copilot-confirmation-problem")?.textContent).toContain("could not be saved"));
  expect(ui("copilot-confirmation")).not.toBeNull();
});

test("the buttons are disabled while the connection is lost (the request itself is kept)", async () => {
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-confirm")).not.toBeNull());
  callbacks.subscription?.connection(false);
  await waitFor(() => expect((ui("copilot-confirmation-confirm") as HTMLButtonElement).disabled).toBe(true));
  expect((ui("copilot-confirmation-cancel") as HTMLButtonElement).disabled).toBe(true);
  expect(ui("copilot-confirmation")).not.toBeNull();
});

test("zh-CN copy is complete and only a whole Plan has a card", async () => {
  await i18n.changeLanguage("zh-CN");
  await open();
  await waitFor(() => expect(ui("copilot-confirmation")?.textContent).toContain("删除计划「Alpha <b>plan</b>」"));
  expect(ui("copilot-confirmation")?.textContent).toContain("该计划及其 3 项任务（2 项未完成）将被永久删除。此操作不可撤销。");
  expect(ui("copilot-confirmation-confirm")?.textContent).toBe("确认删除");
  expect(ui("copilot-confirmation")?.getAttribute("data-action")).toBe("delete_plan");
});

test("operation records show waiting, declined and expired deletes as not applied", async () => {
  current = snap("completed", { messages: [{ id: "m1", role: "assistant", text: "", operations: [
    { id: "c1", tool: "plan", action: "delete_plan", status: "declined", label: "Alpha" },
    { id: "c2", tool: "plan", action: "delete_task", status: "expired", label: "Task 1" },
    { id: "c3", tool: "plan", action: "delete_task", status: "confirmation_required", label: "Task 2" },
  ] }] });
  await open();
  await waitFor(() => expect(document.querySelectorAll('[data-ui="copilot-operation-item"]')).toHaveLength(3));
  const items = [...document.querySelectorAll('[data-ui="copilot-operation-item"]')].map((node) => node.textContent);
  expect(items[0]).toContain("Declined");
  expect(items[1]).toContain("Expired");
  expect(items[2]).toContain("Waiting for you");
  expect(ui("copilot-operation")?.textContent).toContain("3 not applied");
});

test("after a confirmed task delete the existing undo wording is offered for six seconds and posts the undo once", async () => {
  const until = new Date(Date.now() + 4000).toISOString();
  current = snap("completed", { messages: [{ id: "m1", role: "assistant", text: "", operations: [{ id: "call_1", tool: "plan", action: "delete_task", status: "ok", label: "Task 1", rev: 8, undo: { until } }] }] });
  await open();
  await waitFor(() => expect(ui("copilot-undo")).not.toBeNull());
  expect(ui("copilot-undo")?.textContent).toContain("Deleted \"Task 1\"");
  fireEvent.click(ui("copilot-undo-delete")!);
  await waitFor(() => expect(calls("/undo")).toHaveLength(1));
  expect(String(calls("/undo")[0]![0])).toBe(`/api/copilot/conversations/${ID}/operations/call_1/undo`);
  expect(JSON.parse(String((calls("/undo")[0] as [string, RequestInit])[1].body))).toEqual({ viewId: context.viewId });
  await waitFor(() => expect(ui("copilot-undo")).toBeNull());
});

test("an expired undo window offers nothing, and a Plan delete never offers one", async () => {
  current = snap("completed", { messages: [{ id: "m1", role: "assistant", text: "", operations: [
    { id: "old", tool: "plan", action: "delete_task", status: "ok", label: "Task 1", undo: { until: new Date(Date.now() - 1000).toISOString() } },
    { id: "plan", tool: "plan", action: "delete_plan", status: "ok", label: "Alpha" },
  ] }] });
  await open();
  await waitFor(() => expect(document.querySelectorAll('[data-ui="copilot-operation-item"]')).toHaveLength(2));
  expect(ui("copilot-undo")).toBeNull();
});

test("the undo notice can be dismissed like the Plan page's, and a failed undo says why instead of vanishing", async () => {
  const until = new Date(Date.now() + 4000).toISOString();
  current = snap("completed", { messages: [{ id: "m1", role: "assistant", text: "", operations: [{ id: "call_1", tool: "plan", action: "delete_task", status: "ok", label: "Task 1", rev: 8, undo: { until } }] }] });
  await open();
  await waitFor(() => expect(ui("copilot-undo")).not.toBeNull());
  fireEvent.click(ui("copilot-undo-dismiss")!);
  expect(ui("copilot-undo")).toBeNull();
  expect(calls("/undo")).toHaveLength(0);
  cleanup();
  const base = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => url.includes("/undo") ? json({ code: "stale" }, 409) : base(url, options));
  await open();
  await waitFor(() => expect(ui("copilot-undo")).not.toBeNull());
  fireEvent.click(ui("copilot-undo-delete")!);
  await waitFor(() => expect(ui("copilot-undo-result")?.getAttribute("data-status")).toBe("failed"));
  expect(ui("copilot-undo-result")?.textContent).toContain("could not be restored");
  fireEvent.click(ui("copilot-undo-result-dismiss")!);
  expect(ui("copilot-undo-result")).toBeNull();
});

test("a successful undo says the task was restored", async () => {
  const until = new Date(Date.now() + 4000).toISOString();
  current = snap("completed", { messages: [{ id: "m1", role: "assistant", text: "", operations: [{ id: "call_1", tool: "plan", action: "delete_task", status: "ok", label: "Task 1", rev: 8, undo: { until } }] }] });
  await open();
  await waitFor(() => expect(ui("copilot-undo")).not.toBeNull());
  fireEvent.click(ui("copilot-undo-delete")!);
  await waitFor(() => expect(ui("copilot-undo-result")?.querySelector("span")?.textContent).toBe("Restored “Task 1”"));
  expect(ui("copilot-undo-result-dismiss")?.querySelector("svg")).not.toBeNull();
});

test("a waiting confirmation is signalled to the shell (collapsed panel), and a waiting conversation is badged like a running one", async () => {
  const attention = vi.fn();
  render(<Copilot open={false} context={context} onClose={vi.fn()} onAttention={attention} />);
  // Nothing remembered and the panel never opened: no traffic yet.
  expect(calls("/conversations")).toHaveLength(0);
  cleanup();
  memory.set("argelander.copilot.conversation", ID);
  render(<Copilot open={false} context={context} onClose={vi.fn()} onAttention={attention} />);
  await waitFor(() => expect(attention).toHaveBeenCalledWith(true));
  cleanup();
  render(<Copilot open context={context} onClose={vi.fn()} />);
  await waitFor(() => expect(ui("copilot-conversations")).not.toBeNull());
  fireEvent.click(ui("copilot-conversations")!);
  await waitFor(() => expect(ui("copilot-conversation")).not.toBeNull());
  expect(ui("copilot-conversation")?.querySelector(".badge, [class*=badge]")?.className).toMatch(/accent/);
});

const docCard = (over: Partial<CopilotDocConfirmation> = {}): CopilotConfirmation => ({ id: CARD, runId: RUN, toolCallId: "call_1", action: "refresh_arxiv_source", object: { kind: "doc", id: "arxiv-2603.03522", workId: "arxiv:2603.03522" }, label: "Synthetic <i>paper</i>", impact: { annotations: "known", count: 4 }, baseRev: 3, objectDigest: "e".repeat(64), ...over });

test("a waiting arXiv source refresh shows the dialog's annotation risk, the Doc and the annotations version", async () => {
  current = snap("waiting-for-user", { confirmations: [docCard()] });
  await open();
  await waitFor(() => expect(ui("copilot-confirmation")).not.toBeNull());
  const shown = ui("copilot-confirmation") as HTMLElement;
  expect(shown.getAttribute("data-action")).toBe("refresh_arxiv_source");
  expect(shown.querySelector("h3")?.textContent).toBe("Replace the arXiv source of “Synthetic <i>paper</i>”");
  expect(shown.querySelector("i")).toBeNull();
  expect(shown.textContent).toContain("This document has 4 annotations. If its content changes, the old annotations are archived as a batch");
  expect(shown.textContent).toContain("arxiv-2603.03522 · annotations v3");
  expect(ui("copilot-confirmation-confirm")?.textContent).toBe("Confirm update");
});

test("an unknown annotation count and a zero count are worded as the dialog words them", async () => {
  current = snap("waiting-for-user", { confirmations: [docCard({ impact: { annotations: "unknown" } })] });
  const view = await open();
  await waitFor(() => expect(ui("copilot-confirmation")).not.toBeNull());
  expect(ui("copilot-confirmation")?.textContent).toContain("The annotation count could not be confirmed.");
  // No invented annotations version when the count could not be read.
  expect(ui("copilot-confirmation")?.textContent).not.toContain("annotations v");
  expect(ui("copilot-confirmation")?.querySelector(".copilot-confirmation-meta")?.textContent).toBe("arxiv-2603.03522");
  view.unmount();
  current = snap("waiting-for-user", { confirmations: [docCard({ impact: { annotations: "known", count: 0 } })] });
  await open();
  await waitFor(() => expect(ui("copilot-confirmation")?.textContent).toContain("No annotations were found. Updating will replace this document."));
});

test("Confirm on a refresh posts the refresh action, the Doc id and the annotations version; a stale answer says nothing was replaced", async () => {
  decisionStatus = 409;
  current = snap("waiting-for-user", { confirmations: [docCard()] });
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-confirm")).not.toBeNull());
  fireEvent.click(ui("copilot-confirmation-confirm")!);
  await waitFor(() => expect(calls("/confirmations/")).toHaveLength(1));
  expect(JSON.parse(String((calls("/confirmations/")[0] as [string, RequestInit])[1].body))).toEqual({ decision: "approve", viewId: context.viewId, action: "refresh_arxiv_source", objectId: "arxiv-2603.03522", baseRev: 3 });
  await waitFor(() => expect(ui("copilot-confirmation-problem")?.textContent).toContain("Nothing was replaced."));
  expect(ui("copilot-confirmation-problem")?.textContent).not.toContain("deleted");
});

test("a waiting replacement of an uploaded source names the file and posts its own action", async () => {
  current = snap("waiting-for-user", { confirmations: [docCard({ action: "replace_upload_source", object: { kind: "doc", id: "upload-synthetic-abc123", workId: "arxiv:2603.03522" }, attachment: { id: "00000000-0000-4000-8000-000000000101", filename: "new <b>source</b>.zip", size: 10, sha256: "c".repeat(64) } })] });
  await open();
  await waitFor(() => expect(ui("copilot-confirmation")).not.toBeNull());
  const shown = ui("copilot-confirmation") as HTMLElement;
  expect(shown.getAttribute("data-action")).toBe("replace_upload_source");
  expect(shown.querySelector("h3")?.textContent).toBe("Replace the uploaded source of “Synthetic <i>paper</i>” with “new <b>source</b>.zip”");
  expect(shown.querySelector("b")).toBeNull();
  fireEvent.click(ui("copilot-confirmation-confirm")!);
  await waitFor(() => expect(calls("/confirmations/")).toHaveLength(1));
  expect(JSON.parse(String((calls("/confirmations/")[0] as [string, RequestInit])[1].body))).toMatchObject({ action: "replace_upload_source", objectId: "upload-synthetic-abc123" });
});

test("W1: a refused replacement of an uploaded source says nothing was replaced, not the arXiv wording", async () => {
  decisionStatus = 409;
  current = snap("waiting-for-user", { confirmations: [docCard({ action: "replace_upload_source", attachment: { id: "00000000-0000-4000-8000-000000000101", filename: "s.zip", size: 10, sha256: "c".repeat(64) } })] });
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-confirm")).not.toBeNull());
  fireEvent.click(ui("copilot-confirmation-confirm")!);
  await waitFor(() => expect(ui("copilot-confirmation-problem")?.textContent).toContain("Nothing was replaced."));
});

test("W5: a large-PDF acceptance card shows the resource warning with the file, posts its own action, and a refusal says nothing was uploaded", async () => {
  decisionStatus = 409;
  current = snap("waiting-for-user", { confirmations: [{ id: CARD, runId: RUN, toolCallId: "call_1", action: "accept_pdf_resource_warning", object: { kind: "attachment", id: "00000000-0000-4000-8000-000000000101", workId: "arxiv:2603.03522" }, label: "Synthetic <i>paper</i>", attachment: { id: "00000000-0000-4000-8000-000000000101", filename: "big <b>one</b>.pdf", size: 30 * 1024 * 1024, sha256: "d".repeat(64) }, baseRev: 0, objectDigest: "e".repeat(64) }] });
  await open();
  await waitFor(() => expect(ui("copilot-confirmation")).not.toBeNull());
  const shown = ui("copilot-confirmation") as HTMLElement;
  expect(shown.querySelector("h3")?.textContent).toBe("Upload “big <b>one</b>.pdf” to “Synthetic <i>paper</i>”");
  expect(shown.querySelector("b")).toBeNull();
  expect(shown.textContent).toContain("30.0 MiB");
  expect(ui("copilot-confirmation-confirm")?.textContent).toBe("Continue upload");
  fireEvent.click(ui("copilot-confirmation-confirm")!);
  await waitFor(() => expect(calls("/confirmations/")).toHaveLength(1));
  expect(JSON.parse(String((calls("/confirmations/")[0] as [string, RequestInit])[1].body))).toMatchObject({ action: "accept_pdf_resource_warning", objectId: "00000000-0000-4000-8000-000000000101", baseRev: 0 });
  await waitFor(() => expect(ui("copilot-confirmation-problem")?.textContent).toContain("Nothing was uploaded."));
});

test("a text reading replacement (ticket 29) shows the annotation impact and the values it is bound to; the click posts the card's own version", async () => {
  const impact = { docId: "text-11111111-1111-4111-8111-111111111111", sourceRev: 5, publishedSourceRev: 4, annotations: 3, annotationsRev: 9, oldFingerprint: "a".repeat(64), newFingerprint: "b".repeat(64) };
  current = snap("waiting-for-user", { confirmations: [{ id: CARD, runId: RUN, toolCallId: "call_1", action: "replace_text_reading", object: { kind: "doc", id: impact.docId }, label: impact.docId, impact, baseRev: 9, objectDigest: "d".repeat(64) }] });
  await open();
  await waitFor(() => expect(ui("copilot-confirmation")).not.toBeNull());
  const shown = ui("copilot-confirmation") as HTMLElement;
  expect(shown.getAttribute("data-action")).toBe("replace_text_reading");
  expect(shown.querySelector("h3")?.textContent).toContain(impact.docId);
  expect(ui("copilot-confirmation-risk")?.textContent).toContain("3");
  expect(ui("copilot-confirmation-basis")?.textContent).toContain("9");
  fireEvent.click(ui("copilot-confirmation-confirm")!);
  await waitFor(() => expect(calls("/confirmations/")).toHaveLength(1));
  const [, options] = calls("/confirmations/")[0] as [string, RequestInit];
  expect(JSON.parse(String(options.body))).toEqual({ decision: "approve", viewId: context.viewId, action: "replace_text_reading", objectId: impact.docId, baseRev: 9 });
});
