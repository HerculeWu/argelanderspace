/**
 * What a message's context details say about a document delivered in parts (copilot ticket 24): the range, the total
 * and what is not read yet, in both languages, and a status that is never "Complete" for a part.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ContextCoverage, ConversationSnapshot, CopilotProvider, PageContext } from "@argelanderspace/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Copilot, messageContextStatus } from "../src/copilot/Copilot";
import i18n from "../src/i18n";

vi.mock("../src/api/ws", () => ({ subscribeCopilot: (s: { ready: () => void }) => { queueMicrotask(s.ready); return () => {}; } }));
const context: PageContext = { version: 1, viewId: "00000000-0000-4000-8000-000000000001", paneId: 1, revision: 1, view: "plan", status: "unavailable", otherPanes: [], plan: null };
const conversation = { version: 1 as const, id: "00000000-0000-4000-8000-000000000002", sessionId: "00000000-0000-4000-8000-000000000003", title: "T", createdAt: "2026-10-02", updatedAt: "2026-10-02", model: { provider: "openai", model: "test", thinking: null }, run: null };
const cov = (over: Partial<ContextCoverage> = {}): ContextCoverage => ({ kind: "reader", docId: "d1", version: "fp#0", unit: "entries", total: 980, from: 0, to: 412, head: true, status: "partial", note: "n", ...over });
const snapshotWith = (coverage: ContextCoverage, operations: object[] = []): ConversationSnapshot => ({ version: 1, conversation, messages: [{ id: "m1", role: "user", text: "Read it", context: { contextId: "00000000-0000-4000-8000-000000000009", view: "doc", status: "complete", revision: 1, objects: [{ id: "d1", rev: 0 }], coverage } }, ...(operations.length ? [{ id: "m2", role: "assistant" as const, text: "", operations: operations as never }] : [])], confirmations: [], stream: "", eventCursor: { instanceId: "00000000-0000-4000-8000-000000000004", seq: 1 } });
const provider: CopilotProvider = { id: "openai", name: "OpenAI", method: "api_key", credential: { configured: true, stored: true, source: "stored" }, catalogStatus: "ready", models: [{ id: "test", name: "Test", baseUrl: "https://example.invalid", contextWindow: 10000, maxTokens: 1000, tools: true, image: true, thinkingLevels: ["off", "low", "high"], capabilitiesKnown: true, defaultThinking: "high", defaultThinkingValid: true }] };
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
function serve(snapshot: ConversationSnapshot) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/providers") ? json({ version: 1, providers: [provider] }) : url.endsWith("/conversations") ? json({ version: 1, conversations: [snapshot.conversation] }) : url.includes("/views/") ? json({ saved: true }) : json(snapshot)));
}
beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const detail = async (snapshot: ConversationSnapshot) => {
  serve(snapshot);
  render(<Copilot open context={context} onClose={vi.fn()} />);
  await screen.findByText("Copilot");
  return await waitFor(() => { const found = document.querySelector('[data-ui="copilot-message-context"]'); expect(found).not.toBeNull(); return found as HTMLElement; });
};

describe("a message's context status never calls a part complete", () => {
  it("partial and omitted coverage make it Partial; whole and held keep the page's own status", () => {
    const base = { status: "complete" as const };
    expect(messageContextStatus({ ...base, coverage: cov() })).toBe("partial");
    expect(messageContextStatus({ ...base, coverage: cov({ status: "omitted", to: 0 }) })).toBe("partial");
    expect(messageContextStatus({ ...base, coverage: cov({ status: "complete", to: 980 }) })).toBe("complete");
    expect(messageContextStatus({ ...base, coverage: cov({ status: "held", to: 980 }) })).toBe("complete");
    const held = { status: "held" as const, modelAcceptsImages: true, pages: 3, pagesWithText: 3, pagesWithoutText: 0, characters: 1 };
    expect(messageContextStatus({ ...base, pdf: { docId: "p", phase: "ready", sha256: "a".repeat(64), pageCount: 3, currentPage: 0, selection: false, material: held } })).toBe("complete");
    expect(messageContextStatus({ ...base, pdf: { docId: "p", phase: "ready", sha256: "a".repeat(64), pageCount: 3, currentPage: 0, selection: false, material: { ...held, status: "omitted" as const } } })).toBe("partial");
  });
});

describe("the message context details state the range", () => {
  it("a part: one-based range, total and what is not read yet, with the Partial badge", async () => {
    const found = await detail(snapshotWith(cov()));
    expect(found.textContent).toContain("Partial");
    const line = found.querySelector('[data-ui="copilot-coverage"]');
    expect(line?.getAttribute("data-status")).toBe("partial");
    expect(line?.textContent).toBe("Part sent: blocks 1–412 of 980; 568 not read yet.");
  });
  it("says a part was later taken out of the conversation, in both languages", async () => {
    const found = await detail(snapshotWith(cov({ evicted: true })));
    expect(found.querySelector('[data-ui="copilot-coverage"]')?.textContent).toBe("Part sent: blocks 1–412 of 980; 568 not read yet. Later taken out of the conversation to make room.");
    cleanup();
    await i18n.changeLanguage("zh-CN");
    const zh = await detail(snapshotWith(cov({ evicted: true })));
    expect(zh.querySelector('[data-ui="copilot-coverage"]')?.textContent).toBe("已发送一部分：第 1–412 个块，共 980；还有 568 未读。 之后已移出会话以腾出空间。");
  });
  it("pages, left out, held and whole each say what they are, in both languages", async () => {
    const found = await detail(snapshotWith(cov({ kind: "pdf", unit: "pages", total: 100, to: 0, status: "omitted", head: false })));
    expect(found.querySelector('[data-ui="copilot-coverage"]')?.textContent).toBe("Not sent with this message: the 100 pages were left out (too large for the window, or already in the conversation); the assistant reads them from the document on demand.");
    cleanup();
    const held = await detail(snapshotWith(cov({ status: "held", to: 980 })));
    expect(held.querySelector('[data-ui="copilot-coverage"]')?.textContent).toBe("Not repeated: this version was already sent in full earlier in this conversation.");
    cleanup();
    await i18n.changeLanguage("zh-CN");
    const zh = await detail(snapshotWith(cov()));
    expect(zh.querySelector('[data-ui="copilot-coverage"]')?.textContent).toBe("已发送一部分：第 1–412 个块，共 980；还有 568 未读。");
  });
  it("a read that delivered a part shows its range on the operation, and says nothing remains at the end", async () => {
    serve(snapshotWith(cov(), [
      { id: "o1", tool: "reader", action: "read", status: "ok", batch: cov({ from: 412, to: 800 }) },
      { id: "o2", tool: "reader", action: "read", status: "ok", batch: cov({ from: 800, to: 980, status: "complete", head: false }) },
    ]));
    render(<Copilot open context={context} onClose={vi.fn()} />);
    await screen.findByText("Copilot");
    const items = await waitFor(() => { const found = document.querySelectorAll('[data-ui="copilot-operation-batch"]'); expect(found.length).toBe(2); return [...found]; });
    expect(items[0]?.textContent).toBe("blocks 413–800 of 980 read; 180 not read yet");
    expect(items[1]?.textContent).toBe("blocks 801–980 of 980 read; nothing remains");
    expect(items[0]?.getAttribute("title")).toBe("Part of a document");
  });
});
