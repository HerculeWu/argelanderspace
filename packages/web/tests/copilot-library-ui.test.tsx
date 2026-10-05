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

test("an import record names the action in both languages, shows the first work and says when entries failed", async () => {
  const withImport: ConversationSnapshot = { ...snapshot, messages: [
    { id: "a1", role: "assistant", text: "", operations: [
      { id: "i1", tool: "library", action: "import_works", status: "ok", object: { kind: "work", id: "doi:10.1/new" }, label: "A fresh paper", warnings: ["import_partial"] },
      { id: "i2", tool: "library", action: "import_works", status: "error" } ] },
  ] };
  fetchMock.mockImplementation(async (url: string) => url.endsWith("/providers") ? json({ providers: [provider] }) : url.endsWith("/conversations") ? json({ conversations: [snapshot.conversation] }) : url.includes("/views/") ? json({ saved: true }) : json(withImport));
  const view = render(<Copilot open context={context} onClose={vi.fn()} />);
  await waitFor(() => expect(document.querySelector('[data-ui="copilot-operation"]')).not.toBeNull());
  const items = () => [...document.querySelectorAll('[data-ui="copilot-operation-item"]')];
  const text = () => items().map((el) => el.textContent ?? "");
  expect(text()[0]).toContain("Import works");
  expect(text()[0]).toContain("A fresh paper");
  expect(text()[0]).toContain("Some entries were not imported");
  expect(text()[1]).toContain("Import works");
  expect(items()[1]?.getAttribute("data-status")).toBe("error");
  expect(text()[1]).not.toContain("Some entries were not imported");
  await i18n.changeLanguage("zh-CN");
  view.rerender(<Copilot open context={context} onClose={vi.fn()} />);
  await waitFor(() => expect(text()[0]).toContain("导入文献"));
  expect(text()[0]).toContain("部分条目未导入");
});

test("an acquisition record shows the real job id and Doc, a pending job is in progress rather than failed, and a failed job is", async () => {
  const withJobs: ConversationSnapshot = { ...snapshot, messages: [
    { id: "a1", role: "assistant", text: "", operations: [
      { id: "j1", tool: "library", action: "acquire_arxiv_pdf", status: "ok", object: { kind: "work", id: "arxiv:2603.1" }, label: "Paper A", job: { id: "upload-aaa", status: "done" }, docId: "pdf-1111" } ] },
    { id: "a2", role: "assistant", text: "", operations: [
      { id: "j2", tool: "library", action: "attach_arxiv", status: "pending", object: { kind: "work", id: "arxiv:2603.2" }, job: { id: "ingest-bbb", status: "running" } } ] },
    { id: "a3", role: "assistant", text: "", operations: [
      { id: "j3", tool: "library", action: "attach_arxiv", status: "error", object: { kind: "work", id: "arxiv:2603.3" }, job: { id: "ingest-ccc", status: "failed" } },
      { id: "j4", tool: "library", action: "read_jobs", status: "ok" } ] },
  ] };
  fetchMock.mockImplementation(async (url: string) => url.endsWith("/providers") ? json({ providers: [provider] }) : url.endsWith("/conversations") ? json({ conversations: [snapshot.conversation] }) : url.includes("/views/") ? json({ saved: true }) : json(withJobs));
  render(<Copilot open context={context} onClose={vi.fn()} />);
  await waitFor(() => expect(document.querySelectorAll('[data-ui="copilot-operation"]')).toHaveLength(3));
  const records = [...document.querySelectorAll('[data-ui="copilot-operation"]')];
  const first = records[0] as HTMLElement;
  expect(first.querySelector('[data-ui="copilot-operation-job"]')?.textContent).toBe("upload-aaa");
  expect(first.querySelector('[data-ui="copilot-operation-doc"]')?.textContent).toBe("pdf-1111");
  expect(first.textContent).toContain("Fetch PDF from arXiv");
  // A job that is still running is neither applied nor failed.
  const second = records[1] as HTMLElement;
  expect(second.textContent).toContain("In progress");
  // Not a checkmark (that would read as done): a neutral clock, and the summary says so in words.
  expect(second.querySelector(".copilot-operation-mark")?.className).toContain("pending");
  expect(second.querySelector(".copilot-operation-mark")?.className).not.toContain("ok");
  expect(second.querySelector(".copilot-operation-mark svg")?.getAttribute("class") ?? "").toContain("ico");
  expect(second.querySelector("summary")?.textContent).toContain("In progress");
  expect(second.textContent).not.toContain("not applied");
  expect(second.querySelector('[data-ui="copilot-operation-doc"]')).toBeNull();
  // A failed job counts as not applied.
  const third = records[2] as HTMLElement;
  expect(third.querySelector(".copilot-operation-mark")?.className).toContain("warn");
  expect(third.textContent).toContain("Read acquisition jobs");
});

test("an exploration's summary names its state, origin, counts and the filter in the interface language, and an error over a graph says so", async () => {
  const withMessage: ConversationSnapshot = { ...snapshot, messages: [
    { id: "u1", role: "user", text: "Look", context: { contextId: "c", view: "library", status: "complete", revision: 1, discovery: { state: "error", seed: "2018ApJ...800..100S", filter: "related", shown: 3, total: 7, selectedBibcode: null }, objects: [] } },
  ] };
  fetchMock.mockImplementation(async (url: string) => url.endsWith("/providers") ? json({ providers: [provider] }) : url.endsWith("/conversations") ? json({ conversations: [snapshot.conversation] }) : url.includes("/views/") ? json({ saved: true }) : json(withMessage));
  for (const [language, state, filter] of [["zh-CN", "文献探索（失败）", "相关研究"], ["en", "Literature exploration (failed)", "Related"]] as const) {
    await i18n.changeLanguage(language);
    const view = render(<Copilot open context={{ ...context, view: "library", status: "complete" } as PageContext} onClose={vi.fn()} />);
    const summary = await waitFor(() => { const found = document.querySelector('[data-ui="copilot-discovery-summary"]'); expect(found).not.toBeNull(); return found!; });
    expect(summary.textContent).toContain(state);
    expect(summary.textContent).toContain(filter);
    expect(summary.textContent).not.toContain("related");
    view.unmount();
  }
});

test("a transcription's validate/generate rows list the PDF pages not looked at, or say the source cannot be checked, in both languages; the SVG step has its own name", async () => {
  const withCoverage: ConversationSnapshot = { ...snapshot, messages: [
    { id: "a1", role: "assistant", text: "", operations: [
      { id: "v1", tool: "text", action: "validate", status: "ok", rev: 3, warnings: ["source_unviewed:1-2, 5"] },
      { id: "g1", tool: "text", action: "generate", status: "ok", rev: 3, label: "text-1", warnings: ["source_coverage_unverifiable"] },
      { id: "g2", tool: "text", action: "generate", status: "ok", rev: 3, label: "text-2" },
      { id: "s1", tool: "reader", action: "read_svg_image", status: "ok" },
      { id: "s2", tool: "text", action: "load_instruction", status: "ok", label: "pdf-transcription v1" } ] },
  ] };
  fetchMock.mockImplementation(async (url: string) => url.endsWith("/providers") ? json({ providers: [provider] }) : url.endsWith("/conversations") ? json({ conversations: [snapshot.conversation] }) : url.includes("/views/") ? json({ saved: true }) : json(withCoverage));
  const view = render(<Copilot open context={context} onClose={vi.fn()} />);
  await waitFor(() => expect(document.querySelector('[data-ui="copilot-operation"]')).not.toBeNull());
  const rows = () => [...document.querySelectorAll('[data-ui="copilot-operation-item"]')].map((el) => el.textContent ?? "");
  expect(rows()[0]).toContain("Not looked at as an image: PDF pages 1-2, 5");
  expect(rows()[1]).toContain("Source PDF pages cannot be checked");
  expect(rows()[2]).not.toContain("Not looked at");
  expect(rows()[2]).not.toContain("cannot be checked");
  expect(rows()[3]).toContain("Read figure as image");
  expect(rows()[4]).toContain("Load task instruction");
  expect(document.querySelectorAll(".copilot-operation-warn")).toHaveLength(2);
  await i18n.changeLanguage("zh-CN");
  view.rerender(<Copilot open context={context} onClose={vi.fn()} />);
  await waitFor(() => expect(rows()[0]).toContain("未以图像查看：PDF 第 1-2, 5 页"));
  expect(rows()[1]).toContain("无法核对来源 PDF 的页");
  expect(rows()[3]).toContain("将图形渲染为图片读取");
});
