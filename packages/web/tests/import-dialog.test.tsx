/**
 * Stage 13 — the import menu + ImportDialog. Dialog behavior against a mocked
 * `api/library` (createWorks); menu wiring through the real LibraryView with a
 * stubbed global fetch. happy-dom: no layout assertions.
 */

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceProvider, type Workspace } from "../src/argelander/workspace";
import { ImportDialog } from "../src/library/ImportDialog";
import { LibraryView } from "../src/library/LibraryView";
import type { LibraryRef, ManualWorkResponse } from "../src/library/types";

// ---------------------------------------------------------------- mocks ----

const h = vi.hoisted(() => ({
  createWorks: vi.fn<() => Promise<ManualWorkResponse | null>>(),
  libChanged: undefined as undefined | (() => void),
}));

vi.mock("../src/api/library", async (orig) => ({
  ...(await orig<typeof import("../src/api/library")>()),
  createWorks: h.createWorks,
}));

vi.mock("../src/api/ws", () => ({
  onLibraryChanged: (cb: () => void) => {
    h.libChanged = cb;
    return () => {};
  },
  onJobEvent: () => () => {},
}));

const REF: LibraryRef = {
  id: "doi:10.1234/x",
  title: "Fresh Paper",
  authors: "Doe",
  year: 2024,
  venue: "ApJ",
  type: "article",
  cite: "doe2024",
  tags: [],
  pdf: false,
  read: false,
  star: false,
};

// ---------------------------------------------------------- dialog alone ----

describe("ImportDialog", () => {
  beforeEach(() => h.createWorks.mockReset());
  afterEach(cleanup);

  it("identifier: a created result resolves + closes", async () => {
    h.createWorks.mockResolvedValue({ results: [{ status: "created", ref: REF, key: "doe2024" }] });
    const onResolved = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <ImportDialog mode="identifier" onClose={onClose} onResolved={onResolved} />
    );
    const input = container.querySelector("input")!;
    fireEvent.change(input, { target: { value: "10.1234/x" } });
    fireEvent.keyDown(input, { key: "Enter" }); // Enter submits (non-composing)
    await waitFor(() => expect(onResolved).toHaveBeenCalledWith(REF));
    expect(onClose).toHaveBeenCalled();
    expect(h.createWorks).toHaveBeenCalledWith({ mode: "identifier", value: "10.1234/x" });
  });

  it("identifier: an IME-composing Enter does not submit", () => {
    const { container } = render(
      <ImportDialog mode="identifier" onClose={() => {}} onResolved={() => {}} />
    );
    const input = container.querySelector("input")!;
    fireEvent.change(input, { target: { value: "2603.05265" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(h.createWorks).not.toHaveBeenCalled();
  });

  it("bibcode: an error outcome stays open and shows the raw server detail", async () => {
    h.createWorks.mockResolvedValue({
      results: [{ status: "error", key: "nope", error: "bibcode nope not found on ADS" }],
    });
    const onClose = vi.fn();
    const { container } = render(
      <ImportDialog mode="bibcode" onClose={onClose} onResolved={() => {}} />
    );
    fireEvent.change(container.querySelector("input")!, { target: { value: "nope" } });
    fireEvent.click(container.querySelector(".btn.primary")!);
    await waitFor(() =>
      expect(container.querySelector(".import-result.error")?.textContent).toContain(
        "not found on ADS"
      )
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("null response (server unreachable) shows the fatal hint", async () => {
    h.createWorks.mockResolvedValue(null);
    const { container } = render(
      <ImportDialog mode="identifier" onClose={() => {}} onResolved={() => {}} />
    );
    fireEvent.change(container.querySelector("input")!, { target: { value: "10.1/a" } });
    fireEvent.click(container.querySelector(".btn.primary")!);
    await waitFor(() =>
      expect(container.querySelector(".plan-modal-warning")?.textContent).toContain("无法连接")
    );
  });

  it("bib batch: per-entry results; closing selects the first created", async () => {
    h.createWorks.mockResolvedValue({
      results: [
        { status: "error", key: "bad", error: "cite key 'bad' is already used" },
        { status: "created", ref: REF, key: "doe2024" },
      ],
    });
    const onResolved = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <ImportDialog mode="bib" onClose={onClose} onResolved={onResolved} />
    );
    fireEvent.change(container.querySelector("textarea")!, {
      target: { value: "@article{bad,}\n@article{doe2024,}" },
    });
    fireEvent.click(container.querySelector(".btn.primary")!);
    await waitFor(() => expect(container.querySelectorAll(".import-result").length).toBe(2));
    expect(container.querySelector(".import-result.error")?.textContent).toContain("already used");
    expect(container.querySelector(".import-result.created")?.textContent).toContain("Fresh Paper");
    // still open; the close button resolves the first created entry
    fireEvent.click(container.querySelector(".plan-modal-foot .btn")!);
    expect(onResolved).toHaveBeenCalledWith(REF);
    expect(onClose).toHaveBeenCalled();
  });
});

// ------------------------------------------------------- menu wiring --------

const PAYLOAD = {
  project: { name: "Lib" },
  refs: [REF],
  tags: [],
  graph: {
    nodes: [{ id: REF.id, ref: REF.id, y: 2024, c: 0, a: "Doe", v: "ApJ", t: REF.title }],
    links: [],
  },
};

const WORKSPACE = {
  openDoc: () => {},
  docDeleted: () => {},
  tweaks: { theme: "dark", accent: "azure", density: "regular", labels: true },
} as unknown as Workspace;

describe("LibraryView import menu (Stage 13)", () => {
  beforeEach(() => {
    h.createWorks.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/library") {
          return { ok: true, json: async () => PAYLOAD } as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      })
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("offers the three real entries (no browser-capture placeholder) and opens the dialog", async () => {
    const { container } = render(
      <WorkspaceProvider value={WORKSPACE}>
        <LibraryView />
      </WorkspaceProvider>
    );
    await waitFor(() => expect(container.querySelectorAll(".side-ref").length).toBe(1));

    fireEvent.click(container.querySelector(".lib-import .btn")!);
    const opts = [...container.querySelectorAll(".import-opt")].map((b) => b.textContent);
    expect(opts).toHaveLength(3);
    expect(opts.join()).toContain("从 DOI / arXiv ID");
    expect(opts.join()).toContain("从 ADS bibcode");
    expect(opts.join()).toContain("导入 BibTeX");
    expect(opts.join()).not.toContain("浏览器");

    fireEvent.click(container.querySelectorAll(".import-opt")[0]!);
    await waitFor(() => expect(container.querySelector(".plan-modal")).toBeTruthy());
    expect(container.querySelector(".plan-modal-title")?.textContent).toBe("从标识符新建条目");
  });

  it("a refreshed payload carrying a NEW node id does not crash the citation graph", async () => {
    // Stage 13 regression: CitationGraph initialized its position map once at
    // mount; a node arriving later (manual creation, rebuild) crashed the
    // render (P.current![id].x of undefined) and unmounted the whole view.
    const REF2 = { ...REF, id: "work:new-one-2024", title: "Brand New Paper", cite: "new2024" };
    const payloadB = {
      ...PAYLOAD,
      refs: [REF, REF2],
      graph: {
        nodes: [
          ...PAYLOAD.graph.nodes,
          { id: REF2.id, ref: REF2.id, y: 2024, c: 0, a: "Doe", v: "ApJ", t: REF2.title },
        ],
        links: [[REF.id, REF2.id]],
      },
    };
    let current: unknown = PAYLOAD;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/library") return { ok: true, json: async () => current } as Response;
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      })
    );
    const { container, rerender } = render(
      <WorkspaceProvider value={WORKSPACE}>
        <LibraryView />
      </WorkspaceProvider>
    );
    await waitFor(() => expect(container.querySelectorAll(".side-ref").length).toBe(1));

    current = payloadB;
    fireEvent(window, new Event("noop")); // no-op; the reload is driven below
    h.libChanged?.();
    await waitFor(() => expect(container.querySelectorAll(".side-ref").length).toBe(2));
    // the view survived: toolbar + graph canvas still mounted, new row present
    expect(container.querySelector(".lib-toolbar")).toBeTruthy();
    expect(container.textContent).toContain("Brand New Paper");
    void rerender;
  });
});
