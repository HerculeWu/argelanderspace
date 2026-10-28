/**
 * Chapters 8 and 9 replay different preset conversations in the same panel (project-intake ticket 07): after chapter 9's
 * "take me there" selected the move-in conversation, chapter 8's requirement is not met (its messages are not in the
 * page) and its own "take me there" brings the panel back to the chapter 8 conversation. Real panel and real DOM
 * lookups; the two conversations are temporary fixtures with the sample's chapter 8 ids.
 */
import { cleanup, render, screen } from "@testing-library/react";
import type { ConversationSnapshot, PageContext } from "@argelanderspace/contracts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Copilot } from "../src/copilot/Copilot";
import type { ConversationRequest } from "../src/copilot/intake";
import i18n from "../src/i18n";
import { COPILOT_CHAPTER } from "../src/tutorial/chapters/copilot";
import { intakeChapter } from "../src/tutorial/chapters/intake";
import { domQuery } from "../src/tutorial/anchors";
import { SAMPLE_CONVERSATION } from "../src/tutorial/sample-ids";
import type { Requirement } from "../src/tutorial/types";
import { fakePage, fakeSnapshot } from "./tutorial-fixtures";

vi.mock("../src/api/ws", () => ({ subscribeCopilot: (subscription: { ready: () => void }) => { queueMicrotask(subscription.ready); return () => {}; } }));
const context: PageContext = { version: 1, viewId: "00000000-0000-4000-8000-000000000001", paneId: 1, revision: 1, view: "doc", status: "unavailable", otherPanes: [], plan: null };
const INTAKE = { id: "11111111-2222-4333-8444-555555555555", replies: { interview: "aa11bb22", summary: "cc33dd44" } } as const;
const [Q1] = SAMPLE_CONVERSATION.questions;
const snapshot = (id: string, messageId: string, text: string, updatedAt: string): ConversationSnapshot => ({
  version: 1,
  conversation: { version: 1, id, sessionId: "00000000-0000-4000-8000-000000000003", title: text, createdAt: "2026-10-27", updatedAt, model: null, run: null },
  messages: [{ id: messageId, role: "user", text } as never],
  confirmations: [], stream: "", eventCursor: { instanceId: "00000000-0000-4000-8000-000000000004", seq: 1 },
});
const all = {
  [SAMPLE_CONVERSATION.id]: snapshot(SAMPLE_CONVERSATION.id, Q1, "chapter eight question", "2026-10-27T10:00:00Z"),
  [INTAKE.id]: snapshot(INTAKE.id, INTAKE.replies.interview, "move-in conversation", "2026-10-26T10:00:00Z"),
} as Record<string, ConversationSnapshot>;
let hold: Promise<void> | null = null; // while set, reading the move-in conversation waits for it
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });

beforeEach(async () => {
  await i18n.changeLanguage("en");
  window.localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const where = String(url);
    if (where.endsWith("/providers")) return json({ version: 1, providers: [] });
    if (where.includes("/views/")) return json({ saved: true });
    if (where.endsWith("/conversations")) return json({ version: 1, conversations: Object.values(all).map((s) => s.conversation) });
    const wanted = where.split("/conversations/")[1] ?? "";
    if (wanted === INTAKE.id && hold) await hold;
    return json(all[wanted]);
  }));
});
afterEach(() => { hold = null; cleanup(); vi.unstubAllGlobals(); });

/** The requirement against the page as it is now: the panel open (L1) and the real DOM. */
const met = (requirement: Requirement) => {
  const page = fakePage("doc") as unknown as { workspace: Record<string, unknown> };
  page.workspace = { ...page.workspace, copilotOpen: true };
  return requirement.test(fakeSnapshot({ page: page as unknown as PageContext, dom: domQuery(document, null) }));
};
const panel = (conversationAsked: ConversationRequest) => <Copilot open context={context} onClose={vi.fn()} conversationAsked={conversationAsked} />;

test("chapter 9's 'take me there' and then chapter 8's: each brings back its own conversation, and each requirement follows the page", async () => {
  const chapter8 = COPILOT_CHAPTER.steps.find((s) => s.id === "copilot.context")!.requires!;
  const chapter9 = intakeChapter(INTAKE).steps[0]!.requires!;
  const view = render(panel({ seq: 0, id: "" }));
  await screen.findByText("chapter eight question");
  expect(met(chapter8)).toBe(true);
  expect(met(chapter9)).toBe(false);

  // Chapter 9: "take me there" names the move-in conversation, which the panel then shows.
  expect(chapter9.takeMeThere).toEqual({ action: "open_copilot", conversationId: INTAKE.id });
  view.rerender(panel({ seq: 1, id: INTAKE.id }));
  await screen.findByText("move-in conversation");
  expect(met(chapter9)).toBe(true);
  expect(met(chapter8)).toBe(false); // going back to chapter 8 (or a refresh) finds the panel on the other conversation

  // Chapter 8: its "take me there" names its own conversation, anchors are in the page again.
  const back = chapter8.takeMeThere;
  expect(back).toEqual({ action: "open_copilot", conversationId: SAMPLE_CONVERSATION.id });
  view.rerender(panel({ seq: 2, id: (back as { conversationId: string }).conversationId }));
  await screen.findByText("chapter eight question");
  expect(met(chapter8)).toBe(true);
  expect(met(chapter9)).toBe(false);
});

test("8.4 and 8.5 only need the open panel: they stay met on any conversation, in the page or not", async () => {
  const byId = (id: string) => COPILOT_CHAPTER.steps.find((s) => s.id === id)!.requires!;
  const conversations = byId("copilot.conversations");
  const provider = byId("copilot.provider");
  expect(conversations.takeMeThere).toEqual({ action: "open_copilot" });
  expect(provider.takeMeThere).toEqual({ action: "open_copilot" });
  const view = render(panel({ seq: 0, id: "" }));
  await screen.findByText("chapter eight question");
  expect(met(conversations)).toBe(true);
  expect(met(provider)).toBe(true);
  // Switching to another conversation (new or picked from the list) takes 8.2/8.3's messages away, not these two.
  view.rerender(panel({ seq: 1, id: INTAKE.id }));
  await screen.findByText("move-in conversation");
  expect(met(byId("copilot.context"))).toBe(false);
  expect(met(conversations)).toBe(true);
  expect(met(provider)).toBe(true);
});

test("while the panel reads the conversation, 8.2/8.3 are undecided, not 'go back to the panel'", async () => {
  const chapter8 = COPILOT_CHAPTER.steps.find((s) => s.id === "copilot.operations")!.requires!;
  let release = () => {};
  const view = render(panel({ seq: 0, id: "" }));
  await screen.findByText("chapter eight question");
  hold = new Promise<void>((resolve) => { release = resolve; });
  view.rerender(panel({ seq: 1, id: INTAKE.id }));
  // The old messages are gone, the new ones are not in yet: the messages area says it is loading.
  await vi.waitFor(() => expect(document.querySelector('[data-ui="copilot-messages"]')?.hasAttribute("data-loading")).toBe(true));
  expect(met(chapter8)).toBe(true);
  release();
  await screen.findByText("move-in conversation");
  expect(document.querySelector('[data-ui="copilot-messages"]')?.hasAttribute("data-loading")).toBe(false);
  expect(met(chapter8)).toBe(false);
});
