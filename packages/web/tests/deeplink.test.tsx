import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { TexDocIr } from "@argelanderspace/contracts";
import { docRouteUrl, parseDocRoute } from "../src/lib/deeplink";
import { DocPane } from "../src/doc/DocPane";
import { WorkspaceProvider, type Workspace } from "../src/argelander/workspace";

// Golden stored IR (Stage 5 tex pipeline, arxiv-2501.17225): sections sec-1..38,
// floats fig-1..25 / tab-1..4 / eq-1..12, refs ref-1..76; ref-6 (Bok 1934) is
// first cited in block p-7. The stored file IS the render IR the server
// passes through (GET /api/paper/<id>/ir), so the mock below serves it
// verbatim. (node:url's URL, not happy-dom's, so fs accepts it.)
const goldenIr = JSON.parse(
  readFileSync(
    fileURLToPath(new NodeURL("../../../tests/golden/tex/arxiv-2501.17225.json", import.meta.url)),
    "utf8"
  )
) as TexDocIr;

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

describe("parseDocRoute", () => {
  it("parses doc id and anchor", () => {
    expect(parseDocRoute("/doc/arxiv-2501.17225", "#fig-1")).toEqual({
      docId: "arxiv-2501.17225",
      anchor: "fig-1",
    });
  });
  it("parses a bare doc route", () => {
    expect(parseDocRoute("/doc/x", "")).toEqual({ docId: "x", anchor: null });
  });
  it("treats an empty hash as no anchor", () => {
    expect(parseDocRoute("/doc/x", "#")).toEqual({ docId: "x", anchor: null });
  });
  it("accepts a trailing slash", () => {
    expect(parseDocRoute("/doc/x/", "")).toEqual({ docId: "x", anchor: null });
  });
  it("decodes percent-encoded ids and anchors", () => {
    expect(parseDocRoute("/doc/doi%3A10.1%2Fabc", "#ref-3")).toEqual({
      docId: "doi:10.1/abc",
      anchor: "ref-3",
    });
  });
  it("rejects non-doc paths", () => {
    expect(parseDocRoute("/", "")).toBeNull();
    expect(parseDocRoute("/library", "")).toBeNull();
    expect(parseDocRoute("/doc/", "")).toBeNull();
    expect(parseDocRoute("/doc/x/extra", "")).toBeNull();
  });
});

describe("docRouteUrl", () => {
  it("builds deep links", () => {
    expect(docRouteUrl("arxiv-2501.17225", "fig-1")).toBe("/doc/arxiv-2501.17225#fig-1");
    expect(docRouteUrl("arxiv-2501.17225")).toBe("/doc/arxiv-2501.17225");
    expect(docRouteUrl("doi:10.1/abc")).toBe("/doc/doi%3A10.1%2Fabc");
  });
});

// ---------------------------------------------------------------------------
// Component-level: a doc opened with a URL anchor scrolls to it
// ---------------------------------------------------------------------------

// jumpTo()/focusReference() scroll via scrollIntoView; capture every target.
const scrolled: Element[] = [];
const realScrollIntoView = Element.prototype.scrollIntoView;

// The store observes blocks with IntersectionObserver (absent in happy-dom);
// report everything as intersecting so the right rail renders all cards.
class IOStub {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.cb(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver
    );
  }
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

function renderDocPane(pendingAnchor: string | null) {
  const clearPendingAnchor = vi.fn();
  const ws: Workspace = {
    papers: ["arxiv-2501.17225"],
    currentDoc: "arxiv-2501.17225",
    setCurrentDoc: vi.fn(),
    openDoc: vi.fn(),
    pendingAnchor,
    clearPendingAnchor,
    tweaks: { theme: "dark", accent: "azure", density: "regular", labels: true },
  };
  const utils = render(
    <WorkspaceProvider value={ws}>
      <DocPane />
    </WorkspaceProvider>
  );
  return { ...utils, clearPendingAnchor };
}

describe("DocPane deep-link anchors", () => {
  beforeEach(() => {
    scrolled.length = 0;
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      scrolled.push(this);
    });
    vi.stubGlobal("IntersectionObserver", IOStub);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/paper/") && url.endsWith("/ir")) {
          return { ok: true, json: async () => goldenIr } as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      })
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    Element.prototype.scrollIntoView = realScrollIntoView;
  });

  it("opens the doc and scrolls to a float anchor", async () => {
    const { container, clearPendingAnchor } = renderDocPane("fig-1");
    const el = await waitFor(() => {
      const e = container.querySelector("#fig-1");
      expect(e).toBeTruthy();
      return e!;
    });
    await waitFor(() => expect(scrolled).toContain(el));
    expect(el.classList.contains("flash")).toBe(true);
    expect(clearPendingAnchor).toHaveBeenCalled();
  });

  it("opens the doc and scrolls to a section anchor", async () => {
    const { container } = renderDocPane("sec-2");
    const el = await waitFor(() => {
      const e = container.querySelector("#sec-2");
      expect(e).toBeTruthy();
      return e!;
    });
    await waitFor(() => expect(scrolled).toContain(el));
  });

  it("lands a ref anchor on the citing block, then focuses the rail card", async () => {
    const { container } = renderDocPane("ref-6");
    // the reader jumps to the first block citing ref-6 (p-6 in the tex IR —
    // the old pandoc pipeline split this paragraph as p-7), so its card
    // enters the rail, then the card itself is focused (after the jump settles)
    await waitFor(() => expect(scrolled.some((el) => el.id === "p-6")).toBe(true));
    const card = await waitFor(
      () => {
        const c = container.querySelector("#ref-6");
        expect(c).toBeTruthy();
        expect(c!.className).toContain("focused");
        return c!;
      },
      { timeout: 3000 }
    );
    expect(scrolled.some((el) => el === card || el.contains(card))).toBe(true);
  });

  it("the topbar shows the ref/fig counts (no nPages for latex docs)", async () => {
    const { container } = renderDocPane(null);
    await waitFor(() => expect(container.querySelector(".doc-meta")).toBeTruthy());
    expect(container.querySelector(".doc-meta")?.textContent).toBe("76 refs · 25 figs");
  });

  it("unknown anchor still opens the doc without scrolling", async () => {
    const { container, clearPendingAnchor } = renderDocPane("fig-999");
    await waitFor(() => expect(container.querySelector("#fig-1")).toBeTruthy());
    await waitFor(() => expect(clearPendingAnchor).toHaveBeenCalled());
    expect(scrolled.length).toBe(0);
  });
});
