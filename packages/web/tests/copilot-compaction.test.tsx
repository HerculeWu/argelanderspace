/**
 * Context compaction in the Copilot panel (release-0.2 ticket 11, approved prototype 10): the marker and its read-only
 * summary, the header's session menu, the running and locked state, Stop, and the failure notices. The real Copilot
 * component against a scripted HTTP API. Layout is not proven here (happy-dom): the real browser is.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConversationSnapshot, CopilotCompaction, CopilotMessage, CopilotProvider, PageContext, WsCopilotEvent } from "@argelanderspace/contracts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Copilot } from "../src/copilot/Copilot";
import i18n from "../src/i18n";

const callbacks = vi.hoisted(() => ({ subscription: null as null | { event: (event: WsCopilotEvent) => void; ready: () => void; connection: (value: boolean) => void } }));
vi.mock("../src/api/ws", () => ({ onPlanChanged: () => () => undefined, subscribeCopilot: (subscription: NonNullable<typeof callbacks.subscription>) => { callbacks.subscription = subscription; queueMicrotask(subscription.ready); return () => { callbacks.subscription = null; }; } }));
const ID = "00000000-0000-4000-8000-000000000002";
const RUN = "00000000-0000-4000-8000-0000000000aa";
const context: PageContext = { version: 1, viewId: "00000000-0000-4000-8000-000000000001", paneId: 1, revision: 1, view: "doc", status: "unavailable", otherPanes: [], plan: null };
const conversation = (status: "completed" | "running" | "failed" = "completed", extra: object = {}) => ({ version: 1 as const, id: ID, sessionId: "00000000-0000-4000-8000-000000000003", title: "Test conversation", createdAt: "2026-10-02", updatedAt: "2026-10-02", model: { provider: "openai", model: "test", thinking: null }, run: { id: RUN, status, error: status === "failed" ? "capacity" : null, ...extra } });
const message = (n: number): CopilotMessage[] => [
  { id: `u${n}`, role: "user", text: `Question ${n}`, context: { contextId: `c${n}`, view: "doc", status: "unavailable", revision: 1, objects: [] } },
  { id: `a${n}`, role: "assistant", text: `Answer ${n}` },
];
const marker = (over: Partial<CopilotCompaction> = {}): CopilotCompaction => ({ id: "m1", beforeMessageId: "u3", count: 4, origin: "manual", model: "test", at: "2026-10-28T14:32:00", includesPrevious: false, summary: "## Goal\nCompare `work_7f3a` and `work_91c2`.\n\n## Critical Context\n- `ann_c01`", ...over });
const snap = (extra: Partial<ConversationSnapshot> = {}): ConversationSnapshot => ({ version: 1, conversation: conversation(), messages: [...message(1), ...message(2), ...message(3)], confirmations: [], stream: "", compactions: [], compaction: null, canCompact: true, eventCursor: { instanceId: "00000000-0000-4000-8000-000000000004", seq: 1 }, ...extra });
const provider: CopilotProvider = { id: "openai", name: "OpenAI", method: "api_key", credential: { configured: true, stored: true, source: "stored" }, catalogStatus: "ready", models: [{ id: "test", name: "Test", baseUrl: "https://example.invalid", contextWindow: 200000, maxTokens: 1000, tools: true, image: false, thinkingLevels: ["off", "low", "high"], capabilitiesKnown: true, defaultThinking: "high", defaultThinkingValid: true, fits: true }] };
let fetchMock: ReturnType<typeof vi.fn>;
let current: ConversationSnapshot;
let compactAnswer: () => Response | Promise<Response>;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const calls = (part: string) => fetchMock.mock.calls.filter(([url]) => String(url).includes(part));
const memory = new Map<string, string>();
beforeEach(async () => {
  await i18n.changeLanguage("en"); callbacks.subscription = null; memory.clear();
  vi.stubGlobal("localStorage", { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); }, removeItem: (key: string) => { memory.delete(key); } });
  current = snap();
  compactAnswer = () => json({ status: "compacted", snapshot: current });
  fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/providers")) return json({ version: 1, providers: [provider] });
    if (url.endsWith("/conversations")) return options?.method === "POST" ? json(current, 201) : json({ version: 1, conversations: [current.conversation], unreadable: [] });
    if (url.endsWith("/compact")) return compactAnswer();
    if (url.endsWith("/stop")) return json(current);
    if (url.includes("/views/")) return json({ saved: true });
    return json(current);
  }); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const open = async () => { const view = render(<Copilot open context={context} onClose={vi.fn()} />); await screen.findByText("Copilot"); await waitFor(() => expect(document.querySelector('[data-ui="copilot-message"]')).not.toBeNull()); return view; };
const ui = (name: string) => document.querySelector(`[data-ui="${name}"]`) as HTMLElement | null;
const menu = () => { fireEvent.click(ui("copilot-session-menu-button")!); return ui("copilot-compact") as HTMLElement; };

test("the marker stands before the first message the model still sees as written; the history above it is all shown and not faded", async () => {
  current = snap({ compactions: [marker()] });
  await open();
  const children = [...ui("copilot-messages")!.children];
  const at = children.findIndex((node) => node.getAttribute("data-ui") === "copilot-compaction-marker");
  expect(children[at + 1]?.getAttribute("data-ui-key")).toBe("u3");
  expect(children.slice(0, at).filter((node) => node.getAttribute("data-ui") === "copilot-message")).toHaveLength(4);
  const chip = ui("copilot-compaction-toggle")!;
  expect(chip.textContent).toContain("Context compacted");
  expect(chip.textContent).toContain("4 earlier message(s) replaced by a summary");
  expect(chip.textContent).toContain("Manual");
  expect(chip.getAttribute("aria-expanded")).toBe("false");
  // collapsed by default: no summary yet
  expect(ui("copilot-compaction-summary")).toBeNull();
});

test("the summary opens read-only with who wrote it and when, and says the history above is unchanged; nothing in it can be copied or edited", async () => {
  current = snap({ compactions: [marker({ includesPrevious: true })] });
  await open();
  fireEvent.click(ui("copilot-compaction-toggle")!);
  const summary = ui("copilot-compaction-summary")!;
  expect(ui("copilot-compaction-toggle")!.getAttribute("aria-expanded")).toBe("true");
  expect(summary.getAttribute("role")).toBe("region");
  expect(summary.textContent).toContain("Context summary (read-only)");
  expect(summary.textContent).toContain("Generated by test");
  expect(summary.textContent).toContain("2026-10-28 14:32");
  expect(summary.textContent).toContain("Includes the previous summary");
  expect(summary.textContent).toContain("The full history above is unchanged.");
  // object references are shown as code, verbatim
  expect([...summary.querySelectorAll("code")].map((node) => node.textContent)).toEqual(["work_7f3a", "work_91c2", "ann_c01"]);
  expect(summary.querySelector("button, textarea, input")).toBeNull();
  fireEvent.click(ui("copilot-compaction-toggle")!);
  expect(ui("copilot-compaction-summary")).toBeNull();
});

test("every compaction keeps its own marker, and one that follows the last message stands at the end", async () => {
  current = snap({ compactions: [marker(), marker({ id: "m2", beforeMessageId: null, origin: "auto", includesPrevious: true })] });
  await open();
  const markers = [...document.querySelectorAll('[data-ui="copilot-compaction-marker"]')];
  expect(markers.map((node) => node.getAttribute("data-ui-key"))).toEqual(["m1", "m2"]);
  expect(markers[1]?.textContent).toContain("Auto");
});

test("the header's menu offers Compact context; it posts to the conversation and shows no running state once it is done", async () => {
  await open();
  const item = menu();
  expect(ui("copilot-session-menu")?.getAttribute("role")).toBe("menu");
  expect(item.getAttribute("role")).toBe("menuitem");
  expect(item.getAttribute("aria-disabled")).toBeNull();
  fireEvent.click(item);
  await waitFor(() => expect(calls("/compact")).toHaveLength(1));
  expect((calls("/compact")[0] as [string, RequestInit])[1].method).toBe("POST");
  expect(String((calls("/compact")[0] as [string])[0])).toBe(`/api/copilot/conversations/${ID}/compact`);
  await waitFor(() => expect(ui("copilot-compaction-running")).toBeNull());
  expect(ui("copilot-session-menu")).toBeNull();
});

test("the menu entry stays visible and says why it cannot be used: a reply is running, or the conversation is still short", async () => {
  current = snap({ conversation: conversation("running"), canCompact: false });
  await open();
  let item = menu();
  expect(item.getAttribute("aria-disabled")).toBe("true");
  expect(item.textContent).toContain("A reply is running; compact after it ends");
  fireEvent.click(item);
  expect(calls("/compact")).toHaveLength(0);
  cleanup();
  current = snap({ canCompact: false });
  await open();
  item = menu();
  expect(item.getAttribute("aria-disabled")).toBe("true");
  expect(item.textContent).toContain("Conversation is short; nothing to compact yet");
  fireEvent.click(item);
  expect(calls("/compact")).toHaveLength(0);
});

test("Escape closes the menu and returns to its button", async () => {
  await open();
  menu();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(ui("copilot-session-menu")).toBeNull();
  expect(document.activeElement).toBe(ui("copilot-session-menu-button"));
});

test("while a context is compacted the composer is locked and Stop is the one action; a manual one says so", async () => {
  let release!: (response: Response) => void;
  compactAnswer = () => new Promise<Response>((resolve) => { release = resolve; });
  await open();
  fireEvent.click(menu());
  await waitFor(() => expect(ui("copilot-compaction-running")).not.toBeNull());
  const running = ui("copilot-compaction-running")!;
  expect(running.getAttribute("role")).toBe("status");
  expect(running.textContent).toContain("Compacting context…");
  expect(running.textContent).toContain("You cannot send until it finishes");
  expect((ui("copilot-input") as HTMLTextAreaElement).disabled).toBe(true);
  expect((ui("copilot-input") as HTMLTextAreaElement).placeholder).toBe("Compacting context; you can send again when it finishes…");
  expect(ui("copilot-stop")).not.toBeNull();
  expect((ui("copilot-stop") as HTMLButtonElement).disabled).toBe(false);
  expect(ui("copilot-send")).toBeNull();
  // the menu cannot start a second one
  expect(menu().getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(ui("copilot-stop")!);
  await waitFor(() => expect(calls("/stop")).toHaveLength(1));
  release(json({ status: "stopped", snapshot: current }));
  await waitFor(() => expect(ui("copilot-compaction-stopped")).not.toBeNull());
  expect(ui("copilot-compaction-stopped")!.textContent).toContain("Compaction stopped. The conversation is unchanged.");
  expect(ui("copilot-compaction-running")).toBeNull();
  fireEvent.click(ui("copilot-compaction-dismiss")!);
  expect(ui("copilot-compaction-stopped")).toBeNull();
  expect((ui("copilot-input") as HTMLTextAreaElement).disabled).toBe(false);
});

test("an automatic compaction in the middle of a reply shows the reply as paused, and locks the composer too", async () => {
  current = snap({ conversation: conversation("running"), compaction: { origin: "auto", startedAt: new Date().toISOString() } });
  await open();
  const running = ui("copilot-compaction-running")!;
  expect(running.getAttribute("data-origin")).toBe("auto");
  expect(running.textContent).toContain("Reply paused, compacting context…");
  expect(ui("copilot-running")).toBeNull();
  expect((ui("copilot-input") as HTMLTextAreaElement).disabled).toBe(true);
  expect(ui("copilot-stop")).not.toBeNull();
});

test("a manual compaction that failed says the conversation is unchanged and can be retried", async () => {
  compactAnswer = () => json({ code: "compaction_failed", detail: "copilot: compaction_failed", retryable: true }, 503);
  await open();
  fireEvent.click(menu());
  await waitFor(() => expect(ui("copilot-compaction-failed")).not.toBeNull());
  const notice = ui("copilot-compaction-failed")!;
  expect(notice.getAttribute("role")).toBe("alert");
  expect(notice.textContent).toContain("Context compaction failed");
  expect(notice.textContent).toContain("The conversation and its history are unchanged.");
  compactAnswer = () => json({ status: "compacted", snapshot: current });
  fireEvent.click(ui("copilot-compaction-retry")!);
  await waitFor(() => expect(calls("/compact")).toHaveLength(2));
  await waitFor(() => expect(ui("copilot-compaction-failed")).toBeNull());
});

test("a send refused as capacity after an automatic compaction failed is titled as that, with the capacity text unchanged", async () => {
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/providers")) return json({ version: 1, providers: [provider] });
    if (url.endsWith("/conversations")) return json({ version: 1, conversations: [current.conversation], unreadable: [] });
    if (url.endsWith("/messages")) return json({ code: "capacity", detail: "copilot: capacity", retryable: false, compaction: "failed" }, 400);
    if (url.includes("/views/")) return json({ saved: true });
    return options?.method === "POST" ? json({}) : json(current);
  });
  await open();
  fireEvent.change(ui("copilot-input")!, { target: { value: "go on" } });
  fireEvent.click(ui("copilot-send")!);
  await waitFor(() => expect(ui("copilot-compaction-auto-failed")).not.toBeNull());
  const notice = ui("copilot-compaction-auto-failed")!;
  expect(notice.textContent).toContain("Automatic compaction did not finish");
  expect(notice.textContent).toContain(i18n.t("copilot.errors.capacity"));
  // the same words are not repeated in the composer's own error line
  expect(ui("copilot-error")).toBeNull();
});

test("a run that ended as capacity because the automatic compaction failed carries the title; one that did not carries none", async () => {
  current = snap({ conversation: conversation("failed", { compactionFailed: true }) });
  await open();
  expect(ui("copilot-run-error")!.textContent).toContain("Automatic compaction did not finish");
  cleanup();
  current = snap({ conversation: conversation("failed") });
  await open();
  expect(ui("copilot-run-error")!.textContent).not.toContain("Automatic compaction did not finish");
});
