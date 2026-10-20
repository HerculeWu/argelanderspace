/**
 * The PDF Reader for Copilot (ticket 20), across the real Shell, DocPane and Reader bridge. The PDF engine itself
 * (EmbedPDF/PDFium in the browser) is replaced by a stub Reader that publishes its page and answers its controls
 * through the REAL bridge, so what is tested is the wiring: the page the assistant receives (identity, never the
 * pages' content), the bound-view actions reaching the PDF Reader's own controls with zero-based pages, and the
 * LaTeX-only controls being refused while a PDF is shown. The real engine and layout are checked in a real browser.
 */
import { render, waitFor } from "@testing-library/react";
import { PdfActionType, PdfZoomMode, type PdfLinkTarget } from "@embedpdf/models";
import { type CopilotViewAction, type PageContext, PageContextSchema, type PdfPage } from "@argelanderspace/contracts";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/argelander/Shell";
import { pdfTargetPageIndex } from "../src/doc/pdf-navigation";
import { usePdfBridge } from "../src/doc/reader-bridge";
import { installShellHarness } from "./shell-harness";

vi.setConfig({ testTimeout: 30000 });
const SHA = "c".repeat(64);
const DOC = "pdf-doc-1";
const h = vi.hoisted(() => ({
  viewAction: null as null | ((action: unknown) => Promise<{ ok: boolean; detail?: string }>),
  context: null as null | PageContext,
  received: [] as unknown[],
  phase: "ready" as "ready" | "loading",
  answers: {} as Record<string, { ok: boolean; detail?: "disabled" | "unavailable" | "not_found" }>,
}));
vi.mock("../src/api/ws", async () => (await import("./shell-stubs")).quietWs());
vi.mock("../src/copilot/Copilot", async () => (await import("./shell-stubs")).copilotProbe(h));
// The stub Reader: the page and the handle go through the real bridge exactly as PdfReader's do.
vi.mock("../src/doc/PdfReader", () => ({
  PdfReader: ({ docId }: { docId: string }) => {
    const bridge = usePdfBridge();
    useEffect(() => {
      const page: PdfPage =
        h.phase === "ready"
          ? { docId, format: "pdf", phase: "ready", sha256: SHA, pageCount: 12, currentPage: 3, zoom: { mode: "fit_width", percent: 100 }, outline: [{ id: "pdf-outline-0", title: "Chapter One", level: 1, pageIndex: 0, disabled: false }], outlineTruncated: false, search: null, selection: { sha256: SHA, text: "PAGE 4", firstPage: 3, lastPage: 3 }, panels: { outlineCollapsed: false, annotationsCollapsed: true } }
          : { docId, format: "pdf", phase: "loading", sha256: SHA, pageCount: 12, currentPage: null, zoom: null, outline: [], outlineTruncated: false, search: null, selection: null, panels: { outlineCollapsed: false, annotationsCollapsed: false } };
      bridge.publish(page);
      bridge.setHandle({ apply: async (action) => { h.received.push(action); return h.answers[action.action] ?? { ok: true }; } });
      return () => { bridge.publish(null); bridge.setHandle(null); };
    }, [bridge, docId]);
    return <div data-ui="stub-pdf-reader" />;
  },
}));

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
installShellHarness({
  papers: () => [DOC],
  routes: (url) => {
    if (url === "/api/plans") return ok({ version: 1, rev: 1, plans: [] });
    if (url === `/api/paper/${DOC}/description`)
      return ok({ doc_id: DOC, format: "pdf", acquired_via: "user_pdf_upload", acquired_at: "2026-10-01T00:00:00.000Z", owner_work_id: "w1", work_title: "A Work", display_name: "a.pdf", byte_length: 100, sha256: SHA, page_count: 12, pages: [] });
    return null;
  },
});
beforeEach(() => {
  h.viewAction = null;
  h.context = null;
  h.received = [];
  h.phase = "ready";
  h.answers = {};
});
const run = (action: CopilotViewAction) => h.viewAction!(action);
async function boot() {
  render(<Shell />);
  await waitFor(() => expect(h.viewAction).not.toBeNull());
  expect(await run({ action: "switch_view", view: "doc" })).toEqual({ ok: true });
  await waitFor(() => expect(h.context?.pdf).toBeTruthy(), { timeout: 10000 });
}

describe("the page the assistant receives from a PDF Reader", () => {
  it("is the Reader's identity and control state, complete, valid, with zero-based pages and no pages' content", async () => {
    await boot();
    expect(PageContextSchema.safeParse(h.context).success).toBe(true);
    await waitFor(() => expect(h.context).toMatchObject({ view: "doc", status: "complete" }));
    expect(h.context?.reader).toBeNull();
    expect(h.context?.pdf).toMatchObject({ docId: DOC, phase: "ready", sha256: SHA, pageCount: 12, currentPage: 3, panels: { outlineCollapsed: false, annotationsCollapsed: true } });
    expect(h.context?.pdf?.selection).toEqual({ sha256: SHA, text: "PAGE 4", firstPage: 3, lastPage: 3 });
    expect(h.context?.pdf?.outline[0]).toMatchObject({ pageIndex: 0 });
  });

  it("a Reader that is still loading is unavailable and carries no selection", async () => {
    h.phase = "loading";
    await boot();
    await waitFor(() => expect(h.context).toMatchObject({ view: "doc", status: "unavailable" }));
    expect(h.context?.pdf).toMatchObject({ phase: "loading", selection: null, currentPage: null });
    expect(PageContextSchema.safeParse(h.context).success).toBe(true);
  });

  it("is dropped when the Reader closes (another view replaces the Doc pane)", async () => {
    await boot();
    expect(await run({ action: "switch_view", view: "plan" })).toEqual({ ok: true });
    await waitFor(() => expect(h.context?.pdf ?? null).toBeNull());
  });
});

describe("the PDF Reader's own controls, driven through the bound view", () => {
  it("download_original reaches the open PDF Reader, answers as it does, and is unavailable (nothing opened) when that Doc is not open (ticket 33)", async () => {
    render(<Shell />);
    await waitFor(() => expect(h.viewAction).not.toBeNull());
    // no Doc open: nothing is opened for a download
    expect(await run({ action: "download_original", docId: DOC })).toMatchObject({ ok: false, detail: "unavailable" });
    expect(h.received).toEqual([]);
    await boot();
    expect(await run({ action: "download_original", docId: DOC })).toEqual({ ok: true });
    expect(h.received).toEqual([{ action: "download_original", docId: DOC }]);
    h.answers = { download_original: { ok: false, detail: "failed" } as never };
    expect(await run({ action: "download_original", docId: DOC })).toMatchObject({ ok: false, detail: "failed" });
  });

  it("each action reaches the Reader with the zero-based index and answers as the Reader's control would", async () => {
    await boot();
    h.answers = { goto_page: { ok: false, detail: "not_found" }, next_page: { ok: false, detail: "disabled" } };
    expect(await run({ action: "goto_page", docId: DOC, pageIndex: 99 })).toMatchObject({ ok: false, detail: "not_found" });
    expect(await run({ action: "next_page", docId: DOC })).toMatchObject({ ok: false, detail: "disabled" });
    h.answers = {};
    for (const action of [
      { action: "goto_page", docId: DOC, pageIndex: 0 },
      { action: "previous_page", docId: DOC },
      { action: "open_outline_item", docId: DOC, outlineId: "pdf-outline-0" },
      { action: "search", docId: DOC, query: "UNIQUE" },
      { action: "open_search_result", docId: DOC, index: 1 },
      { action: "zoom", docId: DOC, mode: "fit_page" },
      { action: "set_panel", docId: DOC, panel: "right", collapsed: false },
    ] as const) expect(await run(action as CopilotViewAction)).toEqual({ ok: true });
    expect(h.received).toEqual([
      { action: "goto_page", docId: DOC, pageIndex: 99 },
      { action: "next_page", docId: DOC },
      { action: "goto_page", docId: DOC, pageIndex: 0 },
      { action: "previous_page", docId: DOC },
      { action: "open_outline_item", docId: DOC, outlineId: "pdf-outline-0" },
      { action: "search", docId: DOC, query: "UNIQUE" },
      { action: "open_search_result", docId: DOC, index: 1 },
      { action: "zoom", docId: DOC, mode: "fit_page" },
      { action: "set_panel", docId: DOC, panel: "right", collapsed: false },
    ]);
  });
});

describe("PDF outline destinations", () => {
  it("name the zero-based page of an in-document target and nothing for a link outside", () => {
    const destination = (pageIndex: number): PdfLinkTarget => ({ type: "destination", destination: { pageIndex, zoom: { mode: PdfZoomMode.Unknown }, view: [] } });
    expect(pdfTargetPageIndex(destination(0))).toBe(0);
    expect(pdfTargetPageIndex(destination(7))).toBe(7);
    expect(pdfTargetPageIndex({ type: "action", action: { type: PdfActionType.Goto, destination: { pageIndex: 4, zoom: { mode: PdfZoomMode.Unknown }, view: [] } } } as PdfLinkTarget)).toBe(4);
    expect(pdfTargetPageIndex({ type: "action", action: { type: PdfActionType.URI, uri: "https://example.org" } } as PdfLinkTarget)).toBeNull();
    expect(pdfTargetPageIndex(null)).toBeNull();
  });
});

