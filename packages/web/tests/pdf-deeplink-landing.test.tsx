import { useMemo, useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DocDescription } from "@argelanderspace/contracts";
import { PdfReader } from "../src/doc/PdfReader";
import { WorkspaceProvider } from "../src/argelander/workspace";

// `#page-N` has to put the Reader on page N, not merely tell the scroll plugin to (arch-19). The plugin's scrollToPage
// flips its own current page at once, but the DOM move is a request that the Viewport element honours only once it has
// subscribed: one sent before that is dropped, and the page stays at the top. The Reader must therefore check that the
// page is in view and ask again. The scroll seam here is a fake that drops its first request (the viewport not yet
// listening), then moves a simulated scroller; the DOM rects follow that scroller. The saved reading position (page 7)
// must never be what the Reader scrolls to when the link names page 3.

const PAGES = 10;
const SHA = "a".repeat(64);
const PAGE_H = 500;
const VIEW_TOP = 100;
const VIEW_H = 600;

const sim = vi.hoisted(() => ({ epoch: 0, scrollTop: 0, requests: [] as { pageNumber: number }[], dropFirst: 0 }));

vi.mock("../src/doc/PdfAnnotationsPanel", () => ({
  PdfAnnotationToolButtons: () => null,
  PdfAnnotationsPanel: ({ onNavigatePage }: { onNavigatePage: (pageIndex: number) => void }) => <button type="button" data-ui="panel-go-to" onClick={() => onNavigatePage(4)}>go</button>,
}));
vi.mock("@embedpdf/core", () => ({ createPluginRegistration: () => ({}) }));
vi.mock("@embedpdf/core/react", () => ({ EmbedPDF: ({ children }: { children: (s: unknown) => unknown }) => children({ pluginsReady: true, activeDocumentId: "d1" }) }));
vi.mock("@embedpdf/engines/react", () => ({ usePdfiumEngine: () => ({ engine: {}, isLoading: false, error: null }) }));
vi.mock("@embedpdf/pdfium/pdfium.wasm?url", () => ({ default: "/pdfium.wasm" }));
vi.mock("@embedpdf/plugin-bookmark/react", () => ({ BookmarkPluginPackage: {}, useBookmarkCapability: () => ({ provides: null }) }));
vi.mock("@embedpdf/plugin-annotation/react", () => ({ AnnotationLayer: () => null, AnnotationPluginPackage: {}, LockModeType: { All: 1 }, useAnnotationCapability: () => ({ provides: null }) }));
vi.mock("@embedpdf/plugin-document-manager/react", () => ({
  DocumentManagerPluginPackage: {},
  useDocumentManagerCapability: () => ({ provides: null }),
  DocumentContent: ({ children }: { children: (s: unknown) => unknown }) => children({ documentState: { document: { pageCount: PAGES } }, isLoaded: true, isLoading: false, isError: false }),
}));
vi.mock("@embedpdf/plugin-interaction-manager/react", () => ({ GlobalPointerProvider: ({ children }: { children: unknown }) => children, InteractionManagerPluginPackage: {}, PagePointerProvider: ({ children }: { children: unknown }) => children }));
vi.mock("@embedpdf/plugin-render/react", () => ({ RenderLayer: () => null, RenderPluginPackage: {} }));
vi.mock("@embedpdf/plugin-rotate/react", () => ({ Rotate: ({ children }: { children: unknown }) => children, RotatePluginPackage: {} }));
vi.mock("@embedpdf/plugin-search/react", () => ({ SearchLayer: () => null, SearchPluginPackage: {}, useSearchCapability: () => ({ provides: null }) }));
vi.mock("@embedpdf/plugin-selection/react", () => ({ SelectionLayer: () => null, SelectionPluginPackage: {}, useSelectionCapability: () => ({ provides: null }) }));
vi.mock("@embedpdf/plugin-zoom/react", () => ({ ZoomMode: { FitWidth: "fw", FitPage: "fp" }, ZoomPluginPackage: {}, useZoomCapability: () => ({ provides: null }) }));
vi.mock("@embedpdf/plugin-viewport/react", () => ({
  ViewportPluginPackage: {},
  useViewportCapability: () => ({ provides: null }),
  Viewport: ({ children, className }: { children: unknown; className: string }) => <div className={className}>{children as never}</div>,
}));
vi.mock("@embedpdf/plugin-scroll/react", async () => {
  const scope = {
    getCurrentPage: () => 1,
    getTotalPages: () => PAGES,
    getLayout: () => ({ totalContentSize: { width: 340, height: PAGES * PAGE_H } }),
    onPageChange: () => () => undefined,
    onLayoutChange: () => () => undefined,
    scrollToPage: (options: { pageNumber: number }) => {
      sim.requests.push({ pageNumber: options.pageNumber });
      if (sim.requests.length <= sim.dropFirst) return; // the viewport was not listening yet: the request is lost
      const epoch = sim.epoch; // a move still pending when its test ends must not leak into the next one
      requestAnimationFrame(() => { if (epoch === sim.epoch) sim.scrollTop = (options.pageNumber - 1) * PAGE_H; });
    },
    scrollToNextPage: () => undefined,
    scrollToPreviousPage: () => undefined,
  };
  const provides = { forDocument: () => scope };
  return {
    ScrollStrategy: { Vertical: "vertical" },
    ScrollPluginPackage: {},
    useScrollCapability: () => ({ provides }),
    Scroller: ({ renderPage, className }: { renderPage: (p: { pageIndex: number }) => unknown; className: string }) => (
      <div className={className}>{Array.from({ length: PAGES }, (_, pageIndex) => <div key={pageIndex} className="pdf-area-layer" data-pdf-page-index={pageIndex}>{renderPage({ pageIndex }) as never}</div>)}</div>
    ),
  };
});
vi.mock("../src/api/pdf", () => ({
  fetchPdfDoc: async () => ({
    ok: true,
    bytes: new ArrayBuffer(8),
    snapshot: {
      metadata: { sha256: SHA, pages: Array.from({ length: PAGES }, () => ({ width: 340, height: 450, rotation: 0 })) },
      annotations: { version: 1, doc_id: "d1", content_sha256: SHA, rev: 0, annotations: [] },
      // saved at page 7: the link to page 3 must not be overridden by it
      reading_position: { status: "ready", file: { version: 1, doc_id: "d1", content_sha256: SHA, rev: 1, position: { page_index: 6, x: 0.5, y: 0.5 } } },
    },
  }),
}));

const rectOf = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 340, width: 340, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
const realRect = HTMLElement.prototype.getBoundingClientRect;

beforeEach(() => {
  // frames at a real 60 Hz pace: happy-dom's own rAF runs thousands per second and would use up the landing budget at once
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle));
  sim.epoch++; sim.scrollTop = 0; sim.requests = []; sim.dropFirst = 0;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains("pdf-viewport")) return rectOf(VIEW_TOP, VIEW_H);
    if (this.classList.contains("pdf-area-layer")) return rectOf(VIEW_TOP + Number(this.dataset.pdfPageIndex) * PAGE_H - sim.scrollTop, PAGE_H - 50);
    return realRect.call(this);
  };
});
afterEach(() => { vi.unstubAllGlobals(); HTMLElement.prototype.getBoundingClientRect = realRect; window.location.hash = ""; cleanup(); });

const description = { format: "pdf", sha256: SHA, page_count: PAGES, display_name: "ten.pdf", work_title: "Ten" } as Extract<DocDescription, { format: "pdf" }>;

// The workspace store's pendingAnchor really clears once the Reader has taken it (clearPendingAnchor), which re-renders the
// Reader and re-wires its position writer mid-landing; the location hash stays, as in the app.
function Harness({ anchor }: { anchor: string | null }) {
  const [pendingAnchor, setPendingAnchor] = useState(anchor);
  const workspace = useMemo(() => ({ pendingAnchor, clearPendingAnchor: () => setPendingAnchor(null) }) as unknown as Parameters<typeof WorkspaceProvider>[0]["value"], [pendingAnchor]);
  return <WorkspaceProvider value={workspace}><PdfReader docId="d1" description={description} /></WorkspaceProvider>;
}
function openAt(hash: string) {
  window.location.hash = hash;
  render(<Harness anchor={hash ? hash.slice(1) : null} />);
}
const landedOn = (pageNumber: number) => sim.scrollTop === (pageNumber - 1) * PAGE_H;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const openAndWaitForRetries = async (hash: string) => {
  sim.dropFirst = 1000; // the viewport never subscribes: the landing loop keeps asking
  openAt(hash);
  await waitFor(() => expect(sim.requests.length).toBeGreaterThan(2), { timeout: 3000 });
  const before = sim.requests.length;
  await sleep(150); // the loop is alive (it keeps asking), and the Reader's input listeners have attached
  expect(sim.requests.length).toBeGreaterThan(before);
};

describe("a PDF page deep link lands on its page (arch-19)", () => {
  test("#page-3 asks for page 3 and never for the saved page 7", async () => {
    openAt("#page-3");
    await waitFor(() => expect(landedOn(3)).toBe(true));
    expect(sim.requests.every((request) => request.pageNumber === 3)).toBe(true);
  });

  // The old effect asked once more after clearing pendingAnchor and then gave up, so dropping two requests (the viewport
  // not yet subscribed) left the Reader on page 1.
  test("requests the viewport dropped before it subscribed are asked again until the page is reached", async () => {
    sim.dropFirst = 2;
    openAt("#page-3");
    await waitFor(() => expect(landedOn(3)).toBe(true), { timeout: 3000 });
    expect(sim.requests.length).toBeGreaterThan(2);
    expect(sim.requests.every((request) => request.pageNumber === 3)).toBe(true);
  });

  // At scroll 0 page 2 already peeks into the viewport: "some of it shows" is not landing on it.
  test("#page-2 is not taken as landed while it only peeks in below page 1", async () => {
    sim.dropFirst = 2;
    openAt("#page-2");
    await waitFor(() => expect(landedOn(2)).toBe(true), { timeout: 3000 });
    expect(sim.requests.length).toBeGreaterThan(2);
  });

  test("a wheel during landing stops the requests: no pull-back", async () => {
    await openAndWaitForRetries("#page-3");
    window.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    await sleep(60);
    const after = sim.requests.length;
    await sleep(250);
    expect(sim.requests.length).toBe(after);
  });

  test("a key press during landing stops the requests", async () => {
    await openAndWaitForRetries("#page-3");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
    await sleep(60);
    const after = sim.requests.length;
    await sleep(250);
    expect(sim.requests.length).toBe(after);
  });

  test("the annotation panel's go-to during landing wins: the link stops asking for its page", async () => {
    await openAndWaitForRetries("#page-3");
    screen.getByText("go").click();
    await sleep(60);
    const after = sim.requests.length;
    expect(sim.requests[after - 1]).toEqual({ pageNumber: 5 });
    await sleep(250);
    expect(sim.requests.length).toBe(after);
  });

  test("without a link the saved position is what the Reader restores (the link is the only thing that overrides it)", async () => {
    openAt("");
    await waitFor(() => expect(sim.requests.some((request) => request.pageNumber === 7)).toBe(true));
    expect(sim.requests.some((request) => request.pageNumber === 3)).toBe(false);
  });
});
