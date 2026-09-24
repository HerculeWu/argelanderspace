/**
 * Stage 14 — DiscoveryDetail (candidate inspector) and the RefDetail explore
 * entry. happy-dom: structure/behavior only, no layout assertions.
 */

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscoveryGraph, DiscoveryPaper } from "@argelanderspace/contracts";
import { DiscoveryDetail } from "../src/library/DiscoveryDetail";
import { RefDetail } from "../src/library/RefDetail";
import type { LibraryRef } from "../src/library/types";

vi.mock("../src/api/ws", () => ({
  onLibraryChanged: () => () => {},
  onJobEvent: () => () => {},
}));

const GRAPH: DiscoveryGraph = {
  version: 1,
  provider: "ads",
  seed: "SEED",
  nodes: [
    {
      bibcode: "SEED",
      title: "The Seed Paper",
      authors: ["Doe, J.", "Roe, K.", "Poe, L.", "Moe, M."],
      year: 2023,
      venue: "A&A",
      abstract: "Seed abstract text.",
      citationCount: 42,
      doi: "10.1051/x",
      arxivId: "2306.12345",
      roles: ["seed"],
      libraryId: null,
    },
    {
      bibcode: "REL1",
      title: "A Related Work",
      authors: ["Smith, A."],
      year: 2021,
      venue: "ApJ",
      abstract: null,
      citationCount: null,
      doi: null,
      arxivId: null,
      roles: ["related", "useful"],
      relatedRank: 2,
      usefulRank: 1,
      libraryId: null,
    },
  ],
  edges: [{ from: "SEED", to: "REL1", kind: "citation" }],
  warnings: [],
};

function detailProps(p: DiscoveryPaper, over: Record<string, unknown> = {}) {
  return {
    paper: p,
    graph: GRAPH,
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onAdd: vi.fn(),
    onExploreHere: vi.fn(),
    onViewInLibrary: vi.fn(),
    adding: false,
    addFailed: false,
    ...over,
  };
}

describe("DiscoveryDetail", () => {
  afterEach(cleanup);

  it("renders abstract + metadata + identifiers; NO BibTeX tab (D3)", () => {
    const seed = GRAPH.nodes[0]!;
    const { container, queryByText, getByText } = render(
      <DiscoveryDetail {...detailProps(seed)} />
    );
    expect(container.textContent).toContain("The Seed Paper");
    expect(container.textContent).toContain("Seed abstract text.");
    expect(container.textContent).toContain("SEED");
    expect(container.querySelector('[data-ui="discovery-detail"]')?.getAttribute("data-ui-key")).toBe("SEED");
    expect(container.textContent).toContain("10.1051/x");
    expect(container.textContent).toContain("2306.12345");
    // the fabricated-BibTeX surface must not exist for candidates
    expect(queryByText("BibTeX")).toBeNull();
    // the seed shows the origin note instead of "explore from here"
    expect(container.querySelector('[data-testid="explore-from-here"]')).toBeNull();
    expect(getByText(/当前探索起点|Current origin/)).toBeTruthy();
  });

  it("candidate: add + explore-from-here callbacks; dual role/rank source line", () => {
    const rel = GRAPH.nodes[1]!;
    const props = detailProps(rel);
    const { container } = render(<DiscoveryDetail {...props} />);
    expect(container.textContent).toContain("similar()"); // source line
    expect(container.textContent).toContain("useful()");
    expect(container.querySelector('[data-ui="discovery-detail"]')?.getAttribute("data-ui-key")).toBe("REL1");
    expect(container.querySelector('[data-ui="save-discovery-paper"]')).toBeTruthy();
    fireEvent.click(container.querySelector('[data-testid="add-to-library"]')!);
    expect(props.onAdd).toHaveBeenCalledWith("REL1");
    fireEvent.click(container.querySelector('[data-testid="explore-from-here"]')!);
    expect(props.onExploreHere).toHaveBeenCalledWith("REL1");
  });

  it("saved candidate: view-in-library instead of add", () => {
    const rel = { ...GRAPH.nodes[1]!, libraryId: "doi:10.1/x" };
    const props = detailProps(rel);
    const { container } = render(<DiscoveryDetail {...props} />);
    expect(container.querySelector('[data-testid="add-to-library"]')).toBeNull();
    fireEvent.click(container.querySelector('[data-testid="view-in-library"]')!);
    expect(props.onViewInLibrary).toHaveBeenCalledWith("doi:10.1/x");
  });

  it("citations tab preserves the legacy active-tab presentation and lists in-graph citations", () => {
    const seed = GRAPH.nodes[0]!;
    const { container } = render(<DiscoveryDetail {...detailProps(seed)} />);
    const tabs = container.querySelectorAll<HTMLButtonElement>(".ref-detail-tabs .rdt");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.classList.contains("on")).toBe(true);

    const citations = container.querySelector<HTMLButtonElement>('[data-testid="discovery-citations-tab"]')!;
    fireEvent.click(citations);
    expect(citations.classList.contains("on")).toBe(true);
    expect(tabs[0]?.classList.contains("on")).toBe(false);
    expect(container.textContent).toContain("A Related Work"); // outgoing SEED→REL1
    const conns = container.querySelectorAll(".cg-conn");
    expect(conns).toHaveLength(1);
  });

  it("missing abstract shows the honest empty note", () => {
    const rel = GRAPH.nodes[1]!;
    const { container } = render(<DiscoveryDetail {...detailProps(rel)} />);
    expect(container.textContent).toMatch(/暂时没有摘要|No abstract is available/);
  });

  it("add failure shows an inline retryable error", () => {
    const rel = GRAPH.nodes[1]!;
    const { container } = render(<DiscoveryDetail {...detailProps(rel, { addFailed: true })} />);
    expect(container.querySelector(".inline-error")).toBeTruthy();
    expect(container.querySelector('[data-testid="add-to-library"]')).toBeTruthy(); // retryable
  });
});

// ---------------------------------------------------------------- RefDetail --

describe("RefDetail explore entry (D1/D9)", () => {
  afterEach(cleanup);

  const REF: LibraryRef = {
    id: "w1",
    title: "A Saved Work",
    authors: "Doe",
    year: 2020,
    venue: "ApJ",
    type: "article",
    cite: "doe2020",
    tags: [],
    pdf: false,
    read: false,
    star: false,
    bibcode: "2020ApJ...900..100D",
  };

  const minimal = (explore: { bibcode: string | null; live: boolean; onExplore: (b: string) => void }) =>
    render(
      <RefDetail
        r={REF}
        node={null}
        onClose={() => {}}
        onOpenDoc={() => {}}
        explore={explore}
      />
    );

  it("enabled with a bibcode on a live backend; fires onExplore", () => {
    const onExplore = vi.fn();
    const { container } = minimal({ bibcode: REF.bibcode!, live: true, onExplore });
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="explore-paper"]')!;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onExplore).toHaveBeenCalledWith(REF.bibcode);
  });

  it("disabled with the no-bibcode explanation", () => {
    const { container } = minimal({ bibcode: null, live: true, onExplore: vi.fn() });
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="explore-paper"]')!;
    expect(btn.disabled).toBe(true);
    expect(container.textContent).toMatch(/暂无 ADS bibcode|no ADS bibcode/);
  });

  it("disabled in demo mode with the backend/ADS explanation (D9)", () => {
    const { container } = minimal({ bibcode: REF.bibcode!, live: false, onExplore: vi.fn() });
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="explore-paper"]')!;
    expect(btn.disabled).toBe(true);
    expect(container.textContent).toMatch(/后端和 ADS|backend and ADS/);
  });
});
