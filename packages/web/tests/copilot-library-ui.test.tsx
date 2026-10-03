import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ConversationSnapshot, CopilotProvider, PageContext, WsCopilotEvent } from "@argelanderspace/contracts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Copilot } from "../src/copilot/Copilot";
import i18n from "../src/i18n";

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

const libraryPage = (over: object = {}) => ({ source: "live", query: "galaxy", total: 4000, matched: 12, refs: [], links: [], selectedRefId: "doi:10.1/x", detail: null, temporaryLabels: {}, sidebarCollapsed: false, graph: { labelsOn: false }, ...over });

test("Library context: the dialog says what was sent and from where, objects show no invented version, mixed actions are not 'plan' actions", async () => {
  const libraryContext = { ...context, view: "library", status: "complete", library: libraryPage({ detail: { ref: { id: "doi:10.1/x", title: "Open paper", authors: "A", year: 2000, venue: "V", type: "article", cite: "a", tags: [], pdf: false, read: false, star: false }, bibtex: "", tab: "meta" } }) } as unknown as PageContext;
  const withMessage: ConversationSnapshot = { ...snapshot, messages: [
    { id: "u1", role: "user", text: "Look", context: { contextId: "c", view: "library", status: "complete", revision: 1, library: { source: "error", error: "HTTP 500", query: "", total: 3, matched: 3, selectedRefId: null }, objects: [{ id: "doi:10.1/x", rev: 0, name: "Open paper" }] } },
    { id: "a1", role: "assistant", text: "", operations: [
      { id: "o1", tool: "plan", action: "read", status: "ok" }, { id: "o2", tool: "library", action: "read", status: "ok" } ] },
    { id: "a2", role: "assistant", text: "", operations: [
      { id: "o3", tool: "library", action: "set_main_doc", status: "conflict" }, { id: "o4", tool: "library", action: "read", status: "ok" } ] },
  ] };
  fetchMock.mockImplementation(async (url: string) => url.endsWith("/providers") ? json({ providers: [provider] }) : url.endsWith("/conversations") ? json({ conversations: [snapshot.conversation] }) : url.includes("/views/") ? json({ saved: true }) : json(withMessage));
  render(<Copilot open context={libraryContext} onClose={vi.fn()} />);
  const details = await waitFor(() => { const found = document.querySelector('[data-ui="copilot-message-context"]'); expect(found).not.toBeNull(); return found!; });
  expect(details.textContent).toContain("could not be read: HTTP 500");
  expect(details.textContent).toContain("Open paper");
  expect(details.textContent).not.toMatch(/v0|· v/); // the Library has no versions to show
  const summaries = [...document.querySelectorAll('[data-ui="copilot-operation"] summary')].map((el) => el.textContent);
  expect(summaries[0]).toContain("2 actions");
  expect(summaries[0]).not.toContain("Plan actions");
  expect(summaries[1]).toContain("2 library actions");
  fireEvent.click(document.querySelector('[data-ui="copilot-context"]')!);
  const dialog = document.querySelector('[data-ui="copilot-context-detail"]')!;
  expect(dialog.textContent).toContain("Saved library");
  expect(dialog.textContent).toContain("12 of 4000 works sent");
  expect(dialog.textContent).toContain("filter “galaxy”");
  expect(dialog.textContent).toContain("Open work: Open paper");
});
