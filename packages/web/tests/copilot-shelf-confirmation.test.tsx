/**
 * The Shelf cards (shelf ticket 07) at the component seam: the real Copilot component against a scripted HTTP API. Each
 * card shows what the approval does (the Docs and annotation counts of an add, every entry a replacement removes, the
 * plan of a take, the entry a delete removes), the decision posts only what identifies the card (never a request of
 * its own), and a stale or unreadable answer is worded for the Shelf. Layout is not proven here (happy-dom).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConversationSnapshot, CopilotConfirmation, CopilotProvider, PageContext, WsCopilotEvent } from "@argelanderspace/contracts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Copilot, operationActionLabel } from "../src/copilot/Copilot";
import i18n from "../src/i18n";

const callbacks = vi.hoisted(() => ({ subscription: null as null | { event: (event: WsCopilotEvent) => void; ready: () => void; connection: (value: boolean) => void }, planChanged: new Set<() => void>() }));
vi.mock("../src/api/ws", () => ({ onPlanChanged: (cb: () => void) => { callbacks.planChanged.add(cb); return () => callbacks.planChanged.delete(cb); }, subscribeCopilot: (subscription: NonNullable<typeof callbacks.subscription>) => { callbacks.subscription = subscription; queueMicrotask(subscription.ready); return () => { callbacks.subscription = null; }; } }));
const ID = "00000000-0000-4000-8000-000000000002";
const RUN = "00000000-0000-4000-8000-0000000000aa";
const CARD = "00000000-0000-4000-8000-0000000000cc";
const ENTRY = "0123456789abcdef0123456789abcdef";
const WORK = "doi:10.1234/shelf-a";
const context: PageContext = { version: 1, viewId: "00000000-0000-4000-8000-000000000001", paneId: 1, revision: 1, view: "doc", status: "unavailable", otherPanes: [], plan: null };
const conversation = (status: "waiting-for-user" | "completed") => ({ version: 1 as const, id: ID, sessionId: "00000000-0000-4000-8000-000000000003", title: "Test conversation", createdAt: "2026-10-02", updatedAt: "2026-10-02", model: { provider: "openai", model: "test", thinking: null }, run: { id: RUN, status, error: null } });
const snap = (status: "waiting-for-user" | "completed", extra: Partial<ConversationSnapshot> = {}): ConversationSnapshot => ({ version: 1, conversation: conversation(status), messages: [], confirmations: [], stream: "", eventCursor: { instanceId: "00000000-0000-4000-8000-000000000004", seq: 1 }, ...extra });
const provider: CopilotProvider = { id: "openai", name: "OpenAI", method: "api_key", credential: { configured: true, stored: true, source: "stored" }, catalogStatus: "ready", models: [{ id: "test", name: "Test", baseUrl: "https://example.invalid", contextWindow: 10000, maxTokens: 1000, tools: true, image: false, thinkingLevels: ["off", "low", "high"], capabilitiesKnown: true, defaultThinking: "high", defaultThinkingValid: true }] };
let fetchMock: ReturnType<typeof vi.fn>;
let current: ConversationSnapshot;
let decisionStatus = 200;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const calls = (part: string) => fetchMock.mock.calls.filter(([url]) => String(url).includes(part));
const memory = new Map<string, string>();

type AddCard = Extract<CopilotConfirmation, { action: "shelf_add" }>;
type TakeCard = Extract<CopilotConfirmation, { action: "shelf_take" }>;
type DeleteCard = Extract<CopilotConfirmation, { action: "shelf_delete" }>;
const replaced = { entryId: ENTRY, rev: 3, title: "Old copy of <i>A</i>", addedAt: "2026-10-01T08:00:00.000Z", sourceProject: "/home/me/old-project", docs: [{ docId: "paper-a", kind: "latex" as const, bytes: 10 }], annotations: 4, argumentGraph: true, note: false };
const addCard = (over: Partial<AddCard> = {}): CopilotConfirmation => ({
  id: CARD, runId: RUN, toolCallId: "call_1", action: "shelf_add", object: { kind: "work", id: WORK, workId: WORK }, label: "Shelf Paper <b>A</b>",
  request: { workId: WORK, docs: [{ docId: "paper-a", annotationIds: ["a_00000001", "a_00000002"] }, { docId: "pdf-1", annotationIds: [] }], argumentGraph: false, note: true },
  carried: { docs: [{ docId: "paper-a", kind: "latex", annotations: 1 }, { docId: "pdf-1", kind: "pdf", annotations: 0 }], argumentGraph: false, note: true },
  notCarried: [{ docId: "paper-a", annotationIds: ["a_00000002"] }], wouldArchive: [], impact: null, baseRev: 0, objectDigest: "d".repeat(64), ...over,
});
const takeCard = (over: Partial<TakeCard> = {}): CopilotConfirmation => ({
  id: CARD, runId: RUN, toolCallId: "call_1", action: "shelf_take", object: { kind: "shelf_entry", id: ENTRY }, label: "Shelf Paper B",
  request: { rev: 2, excludeAnnotations: { "paper-b": ["a_00000003"] }, argumentGraph: true, note: true },
  plan: { work: { id: "doi:10.1234/shelf-b", title: "Shelf Paper B", created: false, citeKey: "roe2022", filled: ["abstract", "venue"] }, mainDoc: { before: null, after: "paper-b", changed: true }, docs: { taken: [{ docId: "paper-b", kind: "latex", annotations: 1, stamped: true }], skipped: [{ docId: "pdf-2", kind: "pdf", reason: "exists" }] }, argumentGraph: "kept_local", note: "existing_work" },
  planDigest: "c".repeat(64), baseRev: 2, objectDigest: "c".repeat(64), ...over,
});
const deleteCard = (over: Partial<DeleteCard> = {}): CopilotConfirmation => ({
  id: CARD, runId: RUN, toolCallId: "call_1", action: "shelf_delete", object: { kind: "shelf_entry", id: ENTRY }, label: "Old copy of <i>A</i>", status: "ok", entry: replaced, baseRev: 3, objectDigest: "e".repeat(64), ...over,
});

beforeEach(async () => {
  await i18n.changeLanguage("en"); callbacks.subscription = null; callbacks.planChanged.clear(); memory.clear(); decisionStatus = 200;
  vi.stubGlobal("localStorage", { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); }, removeItem: (key: string) => { memory.delete(key); } });
  current = snap("waiting-for-user", { confirmations: [addCard()] });
  fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/providers")) return json({ version: 1, providers: [provider] });
    if (url.endsWith("/conversations")) return options?.method === "POST" ? json(current, 201) : json({ version: 1, conversations: [current.conversation], unreadable: [] });
    if (url.includes("/confirmations/")) return decisionStatus === 200 ? json({ status: JSON.parse(String(options?.body)).decision === "approve" ? "approved" : "declined" }) : json({ code: decisionStatus === 409 ? "stale" : "unreadable" }, decisionStatus);
    if (url.includes("/views/")) return json({ saved: true });
    return json(current);
  }); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const open = async () => { const view = render(<Copilot open context={context} onClose={vi.fn()} />); await screen.findByText("Copilot"); return view; };
const ui = (name: string) => document.querySelector(`[data-ui="${name}"]`) as HTMLElement | null;
const all = (name: string) => [...document.querySelectorAll(`[data-ui="${name}"]`)].map((el) => el.textContent);

test("an add shows the work, every Doc that goes in with its annotation count, the switches and the chosen annotations left out", async () => {
  await open();
  await waitFor(() => expect(ui("copilot-confirmation")).not.toBeNull());
  expect(ui("copilot-confirmation")?.getAttribute("data-action")).toBe("shelf_add");
  expect(ui("copilot-confirmation-title")?.textContent).toBe("Add to the Shelf");
  // user data verbatim, never markup
  expect(ui("copilot-confirmation-work")?.textContent).toBe("Shelf Paper <b>A</b>");
  expect(ui("copilot-confirmation")?.querySelector("b")).toBeNull();
  expect(all("copilot-confirmation-doc")).toEqual(["paper-a · LaTeX · 1 annotation", "pdf-1 · PDF · 0 annotations"]);
  expect(ui("copilot-confirmation-graph")?.textContent).toBe("Not included");
  expect(ui("copilot-confirmation-note")?.textContent).toBe("Included");
  expect(ui("copilot-confirmation-not-carried")?.textContent).toBe("1 of the chosen annotations is no longer current and will not be included.");
  expect(ui("copilot-confirmation-replaced")).toBeNull();
  expect(ui("copilot-confirmation-confirm")?.textContent).toBe("Add");
  expect(ui("copilot-confirmation-confirm")?.className).not.toContain("danger");
  // nothing to archive: only then does the card say the project is not changed
  expect(ui("copilot-confirmation-archive")).toBeNull();
  expect(ui("copilot-confirmation-project-note")?.textContent).toBe("The bibliography is always included. Only the Shelf is written; this project is not changed.");
  // the card's own neutral classes, not the Mail card's
  expect(ui("copilot-confirmation")?.querySelector('[class*="copilot-mail"]')).toBeNull();
  expect(ui("copilot-confirmation-shelf")?.className).toBe("copilot-confirmation-fields");
});

test("an add whose chosen annotations are of older content says, Doc by Doc, how many old annotations go to the project's archive, and never that the project is unchanged", async () => {
  current = snap("waiting-for-user", { confirmations: [addCard({ wouldArchive: [{ docId: "paper-a", count: 3 }, { docId: "text-1", count: 0 }] })] });
  await open();
  await waitFor(() => expect(ui("copilot-confirmation")).not.toBeNull());
  expect(ui("copilot-confirmation-archive")?.textContent).toBe("Adding moves the old annotations of these Docs into this project's annotation archive (their text changed; they are not current any more):");
  expect(all("copilot-confirmation-archive-doc")).toEqual(["paper-a · 3 old annotations", "text-1 · 0 old annotations"]);
  expect(ui("copilot-confirmation-project-note")?.textContent).toBe("The bibliography is always included. Besides that archive, this project is not changed.");
  expect(ui("copilot-confirmation")?.textContent).not.toContain("this project is not changed.The");
});

test("a replacement names every entry it removes and confirms with the danger action Replace", async () => {
  current = snap("waiting-for-user", { confirmations: [addCard({ impact: { entries: [replaced, { ...replaced, entryId: "f".repeat(32), title: "Another", sourceProject: "/p/two" }] } })] });
  await open();
  await waitFor(() => expect(ui("copilot-confirmation")).not.toBeNull());
  expect(ui("copilot-confirmation-title")?.textContent).toBe("Replace the Shelf entry of this paper");
  expect(ui("copilot-confirmation-scope")?.textContent).toContain("These 2 entries will be replaced as a whole (not merged) and cannot be recovered");
  expect(all("copilot-confirmation-replaced-entry")).toEqual([
    "“Old copy of <i>A</i>”, added 2026-10-01 from /home/me/old-project · Docs: 1 · annotations: 4 · argument graph",
    "“Another”, added 2026-10-01 from /p/two · Docs: 1 · annotations: 4 · argument graph",
  ]);
  expect(ui("copilot-confirmation")?.querySelector("i")).toBeNull();
  expect(ui("copilot-confirmation-confirm")?.textContent).toBe("Replace");
  expect(ui("copilot-confirmation-confirm")?.className).toContain("danger");
});

test("a take shows the plan: the work merged into and the fields filled, the main Doc, the Docs taken and skipped, the graph and the note", async () => {
  current = snap("waiting-for-user", { confirmations: [takeCard()] });
  await open();
  await waitFor(() => expect(ui("copilot-confirmation")).not.toBeNull());
  expect(ui("copilot-confirmation-title")?.textContent).toBe("Take from the Shelf into this project");
  expect(ui("copilot-confirmation-target")?.textContent).toBe("The project's work of the same paper (doi:10.1234/shelf-b); only blank fields are filled");
  // field names are the user's words for them, not the stored keys
  expect(ui("copilot-confirmation-filled")?.textContent).toBe("Abstract, Venue");
  expect(ui("copilot-confirmation-main-doc")?.textContent).toBe("Becomes paper-b");
  // a stamped Doc says its metadata gets the work's identity
  expect(all("copilot-confirmation-doc")).toEqual(["paper-b · LaTeX · 1 annotation · its metadata gets the work's identifier, so the next library build keeps it with this work (the text does not change)"]);
  expect(all("copilot-confirmation-skipped-doc")).toEqual(["pdf-2 · PDF · a Doc of this id is already in the project (kept as it is)"]);
  expect(ui("copilot-confirmation-graph")?.textContent).toBe("Not taken: the work already has a non-empty graph, kept");
  expect(ui("copilot-confirmation-note")?.textContent).toBe("Not taken: the project's work keeps its note");
  expect(ui("copilot-confirmation-confirm")?.textContent).toBe("Take");
  expect(ui("copilot-confirmation-cite-key")).toBeNull();
});

test("a take into a new work names its cite key, and a Doc the build would put elsewhere names that work (or a new one)", async () => {
  current = snap("waiting-for-user", { confirmations: [takeCard({ plan: { work: { id: "doi:10.1234/shelf-b", title: "Shelf Paper B", created: true, citeKey: "roe2022", filled: [] }, mainDoc: { before: null, after: "paper-b", changed: true }, docs: { taken: [{ docId: "paper-b", kind: "latex", annotations: 0, stamped: false }], skipped: [{ docId: "paper-c", kind: "latex", reason: "seed_conflict", wouldJoin: "doi:10.1/other" }, { docId: "paper-d", kind: "latex", reason: "seed_conflict", wouldJoin: null }] }, argumentGraph: "written", note: "written" } })] });
  await open();
  await waitFor(() => expect(ui("copilot-confirmation")).not.toBeNull());
  expect(ui("copilot-confirmation-target")?.textContent).toBe("A new work (doi:10.1234/shelf-b)");
  expect(ui("copilot-confirmation-cite-key")?.textContent).toBe("roe2022");
  expect(ui("copilot-confirmation-filled")).toBeNull();
  expect(all("copilot-confirmation-doc")).toEqual(["paper-b · LaTeX · 0 annotations"]);
  expect(all("copilot-confirmation-skipped-doc")).toEqual([
    "paper-c · LaTeX · the next library build would put it in another work (doi:10.1/other)",
    "paper-d · LaTeX · the next library build would put it in another work (a new work)",
  ]);
});

test("a delete says only the Shelf's copy goes, names the entry, and is the danger action; an entry of a newer format says so", async () => {
  current = snap("waiting-for-user", { confirmations: [deleteCard()] });
  await open();
  await waitFor(() => expect(ui("copilot-confirmation")).not.toBeNull());
  expect(ui("copilot-confirmation-title")?.textContent).toBe("Delete a Shelf entry");
  expect(ui("copilot-confirmation-risk")?.textContent).toBe("Only the Shelf's copy is deleted; no project is changed. There is no recycle bin.");
  expect(ui("copilot-confirmation-entry")?.textContent).toContain("added 2026-10-01 from /home/me/old-project · Docs: 1 · annotations: 4");
  expect(ui("copilot-confirmation-confirm")?.textContent).toBe("Delete");
  expect(ui("copilot-confirmation-confirm")?.className).toContain("danger");
  cleanup();
  current = snap("waiting-for-user", { confirmations: [deleteCard({ status: "incompatible", entry: null, label: "" })] });
  await open();
  await waitFor(() => expect(ui("copilot-confirmation")).not.toBeNull());
  expect(ui("copilot-confirmation-work")?.textContent).toBe(ENTRY);
  expect(ui("copilot-confirmation-entry")?.textContent).toBe("This entry was written by a newer version of the workbench.");
});

test("a decision posts only what identifies the card (never a request or an impact of its own)", async () => {
  for (const [made, objectId, baseRev] of [[addCard(), WORK, 0], [takeCard(), ENTRY, 2], [deleteCard(), ENTRY, 3]] as const) {
    cleanup();
    fetchMock.mockClear();
    current = snap("waiting-for-user", { confirmations: [made] });
    await open();
    await waitFor(() => expect(ui("copilot-confirmation-confirm")).not.toBeNull());
    fireEvent.click(ui("copilot-confirmation-confirm")!);
    await waitFor(() => expect(calls("/confirmations/")).toHaveLength(1));
    const [url, options] = calls("/confirmations/")[0] as [string, RequestInit];
    expect(url).toContain(CARD);
    expect(JSON.parse(String(options.body))).toEqual({ decision: "approve", viewId: context.viewId, action: made.action, objectId, baseRev });
  }
});

test("a stale answer says something changed and nothing was written; an unreadable check is not a change", async () => {
  decisionStatus = 409;
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-confirm")).not.toBeNull());
  fireEvent.click(ui("copilot-confirmation-confirm")!);
  await waitFor(() => expect(ui("copilot-confirmation-problem")?.textContent).toContain("The work, the project or the Shelf changed before your decision. Nothing was written."));
  cleanup();
  decisionStatus = 500;
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-confirm")).not.toBeNull());
  fireEvent.click(ui("copilot-confirmation-confirm")!);
  await waitFor(() => expect(ui("copilot-confirmation-problem")?.textContent).toContain("This is not a change you made, and nothing was written."));
});

test("a problem notice under the card is scrolled into view without taking the focus; smooth only when motion is not reduced (ticket shelf-followups 09)", async () => {
  const proto = Element.prototype as unknown as { scrollIntoView?: (options?: ScrollIntoViewOptions) => void };
  const original = proto.scrollIntoView;
  const seen: { el: Element; options: ScrollIntoViewOptions | undefined }[] = [];
  proto.scrollIntoView = function (this: Element, options?: ScrollIntoViewOptions) { seen.push({ el: this, options }); };
  try {
    for (const reduce of [false, true]) {
      cleanup(); seen.length = 0;
      vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduce && query.includes("prefers-reduced-motion: reduce"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
      decisionStatus = 409;
      await open();
      await waitFor(() => expect(ui("copilot-confirmation-confirm")).not.toBeNull());
      fireEvent.click(ui("copilot-confirmation-confirm")!);
      await waitFor(() => expect(ui("copilot-confirmation-problem")).not.toBeNull());
      await waitFor(() => expect(seen.some((call) => call.el === ui("copilot-confirmation-problem"))).toBe(true));
      const call = seen.find((entry) => entry.el === ui("copilot-confirmation-problem"));
      expect(call?.options).toEqual({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
      expect(document.activeElement).not.toBe(ui("copilot-confirmation-problem"));
    }
  } finally { if (original) proto.scrollIntoView = original; else delete proto.scrollIntoView; }
});

test("the cards and the operation names are worded in Chinese too", async () => {
  await i18n.changeLanguage("zh-CN");
  current = snap("waiting-for-user", { confirmations: [addCard({ impact: { entries: [replaced] } })] });
  await open();
  await waitFor(() => expect(ui("copilot-confirmation")).not.toBeNull());
  expect(ui("copilot-confirmation-title")?.textContent).toBe("替换文献仓中这篇文献的条目");
  expect(all("copilot-confirmation-doc")[0]).toBe("paper-a · LaTeX · 1 条标注");
  expect(ui("copilot-confirmation-project-note")?.textContent).toBe("书目总会带上。只写入文献仓，不改动当前项目。");
  expect(ui("copilot-confirmation-confirm")?.textContent).toBe("替换");
  const t = i18n.t.bind(i18n);
  expect(operationActionLabel(t, "shelf", "take")).toBe("从文献仓取入");
  expect(operationActionLabel(t, "shelf", "list")).toBe("读取文献仓");
  await i18n.changeLanguage("en");
  expect(operationActionLabel(t, "shelf", "add")).toBe("Add to the Shelf");
  expect(operationActionLabel(t, "shelf", "delete")).toBe("Delete a Shelf entry");
});
