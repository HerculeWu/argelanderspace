/**
 * The panel's side of "show this saved conversation" (project-intake ticket 07; the tutorial replay's "take me there").
 * It is picking the conversation in the list: nothing is created, sent or changed on the server, and an id the list
 * does not hold leaves the shown conversation as it was. A temporary fixture stands in for the preset intake session
 * the sample does not hold yet (ticket 10 records it).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConversationSnapshot, PageContext } from "@argelanderspace/contracts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Copilot } from "../src/copilot/Copilot";
import type { ConversationRequest } from "../src/copilot/intake";
import i18n from "../src/i18n";

vi.mock("../src/api/ws", () => ({ subscribeCopilot: (subscription: { ready: () => void }) => { queueMicrotask(subscription.ready); return () => {}; } }));
const context: PageContext = { version: 1, viewId: "00000000-0000-4000-8000-000000000001", paneId: 1, revision: 1, view: "doc", status: "unavailable", otherPanes: [], plan: null };
const snapshot = (id: string, question: string): ConversationSnapshot => ({
  version: 1,
  conversation: { version: 1, id, sessionId: "00000000-0000-4000-8000-000000000003", title: question, createdAt: "2026-10-27", updatedAt: id.endsWith("a1") ? "2026-10-27T10:00:00Z" : "2026-10-26T10:00:00Z", model: null, run: null },
  messages: [{ id: `m-${id}`, role: "user", text: question } as never],
  confirmations: [], stream: "", eventCursor: { instanceId: "00000000-0000-4000-8000-000000000004", seq: 1 },
});
const FIRST = "00000000-0000-4000-8000-0000000000a1"; // newest: what the panel shows by itself
const REPLAY = "00000000-0000-4000-8000-0000000000b2";
const all = { [FIRST]: snapshot(FIRST, "an ordinary conversation"), [REPLAY]: snapshot(REPLAY, "the preset replay question") } as Record<string, ConversationSnapshot>;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  await i18n.changeLanguage("en");
  window.localStorage.clear();
  fetchMock = vi.fn(async (url: string) => {
    const where = String(url);
    if (where.endsWith("/providers")) return json({ version: 1, providers: [] });
    if (where.includes("/views/")) return json({ saved: true });
    if (where.endsWith("/conversations")) return json({ version: 1, conversations: Object.values(all).map((s) => s.conversation) });
    const id = where.split("/conversations/")[1];
    return id && all[id] ? json(all[id]) : json({ error: "gone" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const panel = (conversationAsked?: ConversationRequest) => <Copilot open context={context} onClose={vi.fn()} {...(conversationAsked ? { conversationAsked } : {})} />;
/** Anything that writes: a created conversation, a sent message, a model choice, a decision. Page publication (PUT /views) is not a send. */
const writes = () => fetchMock.mock.calls.filter(([url, init]) => (init?.method ?? "GET") !== "GET" && !String(url).includes("/views/"));

test("a request shows the asked conversation, and sends and creates nothing", async () => {
  const view = render(panel({ seq: 0, id: "" }));
  await screen.findByText("an ordinary conversation");
  view.rerender(panel({ seq: 1, id: REPLAY }));
  await screen.findByText("the preset replay question");
  expect(screen.queryByText("an ordinary conversation")).toBeNull();
  expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(`/conversations/${REPLAY}`))).toBe(true);
  expect(writes()).toEqual([]);
});

test("a later request for another conversation switches again; the same id asked twice stays put", async () => {
  const view = render(panel({ seq: 0, id: "" }));
  await screen.findByText("an ordinary conversation");
  view.rerender(panel({ seq: 1, id: REPLAY }));
  await screen.findByText("the preset replay question");
  view.rerender(panel({ seq: 2, id: FIRST }));
  await screen.findByText("an ordinary conversation");
  view.rerender(panel({ seq: 3, id: FIRST }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.getByText("an ordinary conversation")).toBeTruthy();
  expect(writes()).toEqual([]);
});

test("an id the list does not hold (the sample has no replay yet) changes nothing and raises no error", async () => {
  const view = render(panel({ seq: 0, id: "" }));
  await screen.findByText("an ordinary conversation");
  view.rerender(panel({ seq: 1, id: "00000000-0000-4000-8000-0000000000ff" }));
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/conversations")).length).toBeGreaterThanOrEqual(2));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.getByText("an ordinary conversation")).toBeTruthy();
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(writes()).toEqual([]);
});

test("asking for the conversation already shown leaves the draft in the box; switching to another one clears it, as picking in the list does", async () => {
  const view = render(panel({ seq: 0, id: "" }));
  await screen.findByText("an ordinary conversation");
  const box = () => document.querySelector("textarea") as HTMLTextAreaElement;
  fireEvent.change(box(), { target: { value: "half-written thought" } });
  expect(box().value).toBe("half-written thought");
  const lists = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/conversations")).length;
  const before = lists();
  view.rerender(panel({ seq: 1, id: FIRST }));
  await waitFor(() => expect(lists()).toBeGreaterThan(before));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(box().value).toBe("half-written thought");
  expect(screen.getByText("an ordinary conversation")).toBeTruthy();
  view.rerender(panel({ seq: 2, id: REPLAY }));
  await screen.findByText("the preset replay question");
  expect(box().value).toBe("");
  expect(writes()).toEqual([]);
});
