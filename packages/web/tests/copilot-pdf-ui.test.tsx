/**
 * What the Copilot panel says about a PDF page (copilot ticket 20): the approved composer warning for a text-only
 * model, and a message's context status that follows what the model was actually given, never the page's own status.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ConversationSnapshot, CopilotProvider, PageContext, PdfContextSummary, PdfPage } from "@argelanderspace/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Copilot, messageContextStatus } from "../src/copilot/Copilot";
import i18n from "../src/i18n";

vi.mock("../src/api/ws", () => ({ subscribeCopilot: (s: { ready: () => void }) => { queueMicrotask(s.ready); return () => {}; } }));
const SHA = "a".repeat(64);
const pdf: PdfPage = { docId: "pdf-1", format: "pdf", phase: "ready", sha256: SHA, pageCount: 4, currentPage: 0, zoom: null, outline: [], outlineTruncated: false, search: null, selection: null, panels: { outlineCollapsed: false, annotationsCollapsed: false } };
const context: PageContext = { version: 1, viewId: "00000000-0000-4000-8000-000000000001", paneId: 1, revision: 1, view: "doc", status: "complete", otherPanes: [], plan: null, pdf };
const conversation = { version: 1 as const, id: "00000000-0000-4000-8000-000000000002", sessionId: "00000000-0000-4000-8000-000000000003", title: "T", createdAt: "2026-10-02", updatedAt: "2026-10-02", model: { provider: "openai", model: "test", thinking: null }, run: null };
const summary = (material: PdfContextSummary["material"]): PdfContextSummary => ({ docId: "pdf-1", phase: "ready", sha256: SHA, pageCount: 4, currentPage: 0, selection: false, material });
const withMessage = (material: PdfContextSummary["material"]): ConversationSnapshot => ({ version: 1, conversation, messages: [{ id: "m1", role: "user", text: "Read it", context: { contextId: "00000000-0000-4000-8000-000000000009", view: "doc", status: "complete", revision: 1, objects: [{ id: "pdf-1", rev: 0 }], pdf: summary(material) } }], confirmations: [], stream: "", eventCursor: { instanceId: "00000000-0000-4000-8000-000000000004", seq: 1 } });
const providerWith = (image: boolean): CopilotProvider => ({ id: "openai", name: "OpenAI", method: "api_key", credential: { configured: true, stored: true, source: "stored" }, catalogStatus: "ready", models: [{ id: "test", name: "Test", baseUrl: "https://example.invalid", contextWindow: 10000, maxTokens: 1000, tools: true, image, thinkingLevels: ["off", "low", "high"], capabilitiesKnown: true, defaultThinking: "high", defaultThinkingValid: true }] });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
function serve(image: boolean, snapshot: ConversationSnapshot) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/providers") ? json({ version: 1, providers: [providerWith(image)] }) : url.endsWith("/conversations") ? json({ version: 1, conversations: [snapshot.conversation] }) : url.includes("/views/") ? json({ saved: true }) : json(snapshot)));
}
beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const ready = async () => { await screen.findByText("Copilot"); await waitFor(() => expect((document.querySelector('[data-ui="copilot-thinking"]') as HTMLSelectElement).disabled).toBe(false)); };

describe("the composer warning for a text-only model (approved prototype A)", () => {
  it("shows on a PDF page when the selected model cannot take images, in both languages", async () => {
    serve(false, withMessage(undefined));
    render(<Copilot open context={context} onClose={vi.fn()} />);
    await ready();
    const notice = await waitFor(() => { const found = document.querySelector('[data-ui="copilot-pdf-no-image"]'); expect(found).not.toBeNull(); return found as HTMLElement; });
    expect(notice.textContent).toBe("This model cannot read images. Select another model for PDF pages.");
    expect(notice.getAttribute("role")).toBe("status");
    await i18n.changeLanguage("zh-CN");
    await waitFor(() => expect(document.querySelector('[data-ui="copilot-pdf-no-image"]')?.textContent).toBe("当前模型不支持图像，请更换模型后读取 PDF 页图。"));
  });
  it("is absent for an image-capable model and for a page that is not a PDF", async () => {
    serve(true, withMessage(undefined));
    const view = render(<Copilot open context={context} onClose={vi.fn()} />);
    await ready();
    expect(document.querySelector('[data-ui="copilot-pdf-no-image"]')).toBeNull();
    cleanup();
    serve(false, withMessage(undefined));
    view.unmount();
    render(<Copilot open context={{ ...context, pdf: undefined, view: "plan", plan: null }} onClose={vi.fn()} />);
    await ready();
    expect(document.querySelector('[data-ui="copilot-pdf-no-image"]')).toBeNull();
  });
});

describe("a message's context status follows the material the model got", () => {
  const ok = { status: "ok" as const, modelAcceptsImages: true, pages: 4, pagesWithText: 4, pagesWithoutText: 0, characters: 100 };
  it("derives complete / partial / unavailable from the material and the model's image capability", () => {
    const base = { status: "complete" as const };
    expect(messageContextStatus({ ...base, pdf: summary(ok) })).toBe("complete");
    expect(messageContextStatus({ ...base, pdf: summary({ ...ok, pagesWithText: 3, pagesWithoutText: 1 }) })).toBe("complete");
    expect(messageContextStatus({ ...base, pdf: summary({ ...ok, modelAcceptsImages: false, pagesWithText: 3, pagesWithoutText: 1 }) })).toBe("partial");
    expect(messageContextStatus({ ...base, pdf: summary({ ...ok, modelAcceptsImages: false }) })).toBe("complete");
    for (const status of ["busy", "changed", "error", "not_found"] as const)
      expect(messageContextStatus({ ...base, pdf: summary({ ...ok, status, pages: 0, pagesWithText: 0 }) })).toBe("unavailable");
    expect(messageContextStatus({ status: "unavailable" })).toBe("unavailable");
    expect(messageContextStatus({ status: "complete" })).toBe("complete");
  });
  const detailOf = async (material: PdfContextSummary["material"]) => {
    serve(true, withMessage(material));
    render(<Copilot open context={context} onClose={vi.fn()} />);
    await ready();
    return await waitFor(() => { const found = document.querySelector('[data-ui="copilot-message-context"]'); expect(found).not.toBeNull(); return found as HTMLElement; });
  };
  it("shows Unavailable, not Complete, beside 'pages not sent'", async () => {
    const detail = await detailOf({ status: "busy", modelAcceptsImages: true, pages: 0, pagesWithText: 0, pagesWithoutText: 0, characters: 0 });
    expect(detail.textContent).toContain("Unavailable");
    expect(detail.textContent).not.toContain("Complete");
    expect(detail.textContent).toContain("Pages not sent");
  });
  it("shows Partial and says the scans were not read when a text-only model got a PDF with scans; no word of images being sent", async () => {
    const detail = await detailOf({ status: "ok", modelAcceptsImages: false, pages: 4, pagesWithText: 3, pagesWithoutText: 1, characters: 100 });
    expect(detail.textContent).toContain("Partial");
    expect(detail.textContent).toContain("3 of 4 pages sent as text; 1 without a text layer are unread: this model cannot read images");
  });
  it("an image-capable model: the scans are read on request, not sent", async () => {
    const detail = await detailOf({ status: "ok", modelAcceptsImages: true, pages: 4, pagesWithText: 3, pagesWithoutText: 1, characters: 100 });
    expect(detail.textContent).toContain("Complete");
    expect(detail.textContent).toContain("3 as text, 1 without a text layer (read as page images on request)");
    expect(detail.textContent).not.toMatch(/images? sent|page images only/);
  });
});
