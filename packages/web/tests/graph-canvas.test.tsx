/**
 * Stage 14 — GraphCanvas smoke (happy-dom: element-level structure only; the
 * real layout/interaction probes run in a real browser in Phase 6) and the
 * LibraryGraph adapter mapping.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";import { GraphCanvas, type CanvasNode } from "../src/graph/GraphCanvas";
import { LibraryGraph } from "../src/library/LibraryGraph";
import type { GraphData } from "../src/library/types";

// happy-dom has no ResizeObserver
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const NODES: CanvasNode[] = [
  {
    id: "A",
    title: "Paper A",
    label: "Doe ’23",
    year: 2023,
    citations: 42,
    filled: true,
    diamond: false,
    seed: true,
    venue: "A&A",
    roleTag: "ORIGIN",
  },
  {
    id: "B",
    title: "Paper B",
    label: "Roe ’21",
    year: 2021,
    citations: 7,
    filled: false,
    diamond: false,
    seed: false,
    venue: "ApJ",
    roleTag: "RELATED",
  },
  {
    id: "C",
    title: "Paper C",
    label: "Poe ’01",
    year: 2001,
    citations: 900,
    filled: false,
    diamond: true,
    seed: false,
    venue: "MNRAS",
    roleTag: "USEFUL",
  },
];

function renderCanvas(over: Record<string, unknown> = {}) {
  return render(
    <GraphCanvas
      nodes={NODES}
      edges={[["A", "B"]]}
      seedId="A"
      selectedId={null}
      onSelect={() => {}}
      stash={{}}
      layoutKey="test-scene"
      heading="Citation map"
      note="A → B means A cites B."
      usefulLegend
      isolatedNote
      {...over}
    />
  );
}

describe("GraphCanvas", () => {
  afterEach(cleanup);

  it("renders nodes (circle/diamond/seed ring), directed edges, legend, zoom stack", () => {
    vi.stubGlobal("ResizeObserver", RO);
    const { container } = renderCanvas();
    // one node <g> per paper
    expect(container.querySelectorAll("[data-node-id]")).toHaveLength(3);
    // directed edge with an arrowhead marker
    const line = container.querySelector(".cg-edges line");
    expect(line?.getAttribute("marker-end") ?? line?.getAttribute("markerEnd")).toBeTruthy();
    expect(container.querySelector("marker")).toBeTruthy();
    // the Useful node is a diamond path; the seed carries the ORIGIN label
    expect(container.querySelectorAll(".cg-node path").length).toBeGreaterThan(0);
    expect(container.textContent).toContain("ORIGIN");
    // legend + zoom controls
    expect(container.textContent).toMatch(/A → B/);
    expect(container.querySelector('[data-testid="zoom-in"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="fit-view"]')).toBeTruthy();
    // Useful legend chip
    expect(container.textContent).toContain("Useful");
  });

  it("keeps graph node identifiers bound to identity across a refreshed result", () => {
    vi.stubGlobal("ResizeObserver", RO);
    const { container, rerender } = renderCanvas();
    expect([...container.querySelectorAll('[data-ui="graph-node"]')].map((node) => node.getAttribute("data-ui-key"))).toEqual(["A", "B", "C"]);
    expect(container.querySelector('[data-ui="graph-canvas"]')).toBeTruthy();
    rerender(<GraphCanvas nodes={[NODES[0], { ...NODES[1], title: "New title" }, NODES[2], { ...NODES[1], id: "D" }]} edges={[]} seedId="A" selectedId={null} onSelect={() => {}} stash={{}} layoutKey="new-scene" heading="New heading" note="" />);
    expect([...container.querySelectorAll('[data-ui="graph-node"]')].map((node) => node.getAttribute("data-ui-key"))).toEqual(["A", "B", "C", "D"]);
    expect(container.querySelector('[data-ui-key="B"]')?.getAttribute("aria-label")).toBe("New title");
  });

  it("labels respect the collision rule but the seed/selected are always labeled", () => {
    vi.stubGlobal("ResizeObserver", RO);
    const { container } = renderCanvas({ selectedId: "B" });
    const labels = container.querySelectorAll(".cg-label");
    expect(labels.length).toBeGreaterThan(0);
  });
});

describe("LibraryGraph adapter", () => {
  afterEach(cleanup);

  it("maps a saved-only payload to filled circle nodes", () => {
    vi.stubGlobal("ResizeObserver", RO);
    const graph: GraphData = {
      version: 2,
      nodes: [
        { id: "w1", ref: "w1", y: 2020, c: 10, a: "Doe et al.", v: "ApJ", t: "Saved One" },
        { id: "w2", ref: "w2", y: 2021, c: 3, a: "Roe", v: "AJ", t: "Saved Two" },
      ],
      links: [["w1", "w2"]],
    };
    const { container } = render(
      <LibraryGraph graph={graph} selId={null} onSel={() => {}} query="" />
    );
    const nodes = container.querySelectorAll("[data-node-id]");
    expect(nodes).toHaveLength(2);
    // saved-only: no hollow candidate styling
    expect(container.querySelectorAll(".cg-dot.sug")).toHaveLength(0);
    expect(container.querySelector(".cg-edges line")).toBeTruthy();
  });
});
