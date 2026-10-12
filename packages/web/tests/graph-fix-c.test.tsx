/**
 * Ticket 03, fix round C: stale-closure and estimate fixes in the shared viewport and the layered canvas, at the
 * component seam in happy-dom (layout, pixels and real wheel behaviour are checked in a real browser).
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CanvasNode, GraphCanvas, type GraphCanvasController } from "../src/graph/GraphCanvas";
import { type LayeredEdgeSpec, type LayeredNodeSpec, LayeredGraphCanvas } from "../src/graph/LayeredGraphCanvas";
import { boxesHit, placeEdgeLabels } from "../src/graph/layered/placement";
import { LABEL_FONT_MAX, displayLabel, labelWidth, monoUnits, textUnits, wrapLabel } from "../src/graph/layered/text";

let W = 600;
const H = 500;
class SizedRO {
  constructor(private cb: ResizeObserverCallback) {}
  observe() {
    this.cb([{ contentRect: { width: W, height: H } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}
beforeEach(() => {
  W = 600;
  vi.stubGlobal("ResizeObserver", SizedRO);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const nums = (s: string) => s.match(/-?[\d.]+/g)!.map(Number);
const worldView = (c: ParentNode) => nums(c.querySelector("svg.cg-svg > g")!.getAttribute("transform")!);
const nodePos = (c: ParentNode, id: string) => nums([...c.querySelectorAll("[data-node-id]")].find((e) => e.getAttribute("data-node-id") === id)!.getAttribute("transform")!);
const byKey = (root: ParentNode, key: string) => [...root.querySelectorAll("[data-ui-key]")].find((e) => e.getAttribute("data-ui-key") === key) as HTMLElement;

describe("GraphCanvas.focusSeed reads the live view", () => {
  it("keeps a zoom made in the same tick and centres the seed", () => {
    const nodes: CanvasNode[] = ["A", "B", "C"].map((id, i) => ({ id, title: `Paper ${id}`, label: `Doe ’2${i}`, year: 2020 + i, citations: 3, filled: true, diamond: false, seed: id === "A", venue: "ApJ", roleTag: null }));
    let ctl: GraphCanvasController | null = null;
    const { container } = render(
      <GraphCanvas nodes={nodes} edges={[["A", "B"], ["B", "C"]]} selectedId={null} onSelect={() => {}} seedId="A" stash={{}} layoutKey="k" heading="h" note="n" onController={(c) => { ctl = c; }} />
    );
    const k0 = worldView(container)[2]!;
    act(() => {
      ctl!.zoomIn();
      ctl!.focusSeed();
    });
    const [tx, ty, k] = worldView(container) as [number, number, number];
    expect(k).toBeCloseTo(k0 * 1.25, 5);
    const [x, y] = nodePos(container, "A") as [number, number];
    expect(x * k + tx).toBeCloseTo(W / 2, 3);
    expect(y * k + ty).toBeCloseTo(H / 2, 3);
  });
});

const node = (id: string, label = id, extra: Partial<LayeredNodeSpec> = {}): LayeredNodeSpec => ({ id, label, name: id, color: "red", ...extra });
const edge = (from: string, to: string): LayeredEdgeSpec => ({ id: `${from}>${to}`, from, to, color: "blue" });
type Props = Partial<React.ComponentProps<typeof LayeredGraphCanvas>>;
const ui = (props: Props = {}) => (
  <LayeredGraphCanvas
    nodes={[node("a"), node("b"), node("c")]}
    edges={[edge("a", "b"), edge("b", "c")]}
    selectedId="b"
    onSelect={() => {}}
    stash={{}}
    sceneKey="s"
    ui="t"
    heading="h"
    note="n"
    legend={null}
    renderTooltip={() => null}
    {...props}
  />
);

describe("connect gesture uses the latest props at release", () => {
  const press = (c: ParentNode) => fireEvent.pointerDown(c.querySelector('[data-connect-from]')!, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
  it("calls the onConnect of the render that is current when the pointer lifts", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { container, rerender } = render(ui({ onConnect: first }));
    vi.spyOn(document, "elementFromPoint").mockReturnValue(byKey(container, "c").querySelector("circle"));
    press(container);
    fireEvent.pointerMove(container.querySelector("svg.cg-svg")!, { pointerId: 1, clientX: 60, clientY: 40 });
    rerender(ui({ onConnect: second }));
    fireEvent.pointerUp(container.querySelector("svg.cg-svg")!, { button: 0, pointerId: 1, clientX: 70, clientY: 50 });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith("b", "c", { x: 70, y: 50 });
  });

  it("counts a node added during the drag as a drop target", () => {
    const onConnect = vi.fn();
    const { container, rerender } = render(ui({ onConnect }));
    press(container);
    rerender(ui({ onConnect, nodes: [node("a"), node("b"), node("c"), node("d")], edges: [edge("a", "b"), edge("b", "c")] }));
    vi.spyOn(document, "elementFromPoint").mockReturnValue(byKey(container, "d").querySelector("circle"));
    fireEvent.pointerUp(container.querySelector("svg.cg-svg")!, { button: 0, pointerId: 1, clientX: 70, clientY: 50 });
    expect(onConnect).toHaveBeenCalledWith("b", "d", { x: 70, y: 50 });
  });
});

describe("a new press ends the gesture under way", () => {
  it("removes the rubber band when a press follows a lost release, and the handle comes back", () => {
    const { container } = render(ui({ onConnect: () => {} }));
    const svg = container.querySelector("svg.cg-svg")!;
    fireEvent.pointerDown(container.querySelector("[data-connect-from]")!, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    expect(container.querySelector("line.lg-rubber")).toBeTruthy();
    fireEvent.pointerDown(svg, { button: 0, pointerId: 1, clientX: 200, clientY: 200 });
    expect(container.querySelector("line.lg-rubber")).toBeNull();
    fireEvent.pointerUp(svg, { button: 0, pointerId: 1, clientX: 200, clientY: 200 });
    expect(container.querySelector("[data-connect-from]")).toBeTruthy();
  });

  it("removes the rubber band on pointercancel and when a second finger starts a pinch", () => {
    const { container } = render(ui({ onConnect: () => {} }));
    const svg = container.querySelector("svg.cg-svg")!;
    fireEvent.pointerDown(container.querySelector("[data-connect-from]")!, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerCancel(svg, { pointerId: 1 });
    expect(container.querySelector("line.lg-rubber")).toBeNull();
    fireEvent.pointerDown(container.querySelector("[data-connect-from]")!, { button: 0, pointerId: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerDown(svg, { button: 0, pointerId: 3, clientX: 100, clientY: 100 });
    expect(container.querySelector("line.lg-rubber")).toBeNull();
  });
});

describe("fit uses the widest label line", () => {
  it("reserves room for a title whose second line is the wider one", () => {
    const label = "To characterization";
    const first = textUnits(wrapLabel(label)[0]!) * LABEL_FONT_MAX;
    expect(labelWidth(label)).toBeGreaterThan(first + 10);
    W = 260;
    const { container } = render(ui({ nodes: [node("a", label)], edges: [], selectedId: null }));
    const k = worldView(container)[2]!;
    // one node: the picture is 68 wide plus the label; the free width is the canvas less the left and right clearance (24 + 64)
    const free = W - 24 - 64;
    expect(Math.round(k * 100)).toBe(Math.round(Math.min(1.4, free / (68 + labelWidth(label))) * 100));
    expect(Math.round(k * 100)).not.toBe(Math.round(Math.min(1.4, free / (68 + first)) * 100));
  });
});

describe("keyboard selection keeps the whole chain lit", () => {
  const chainNodes = ["a", "b", "c", "d", "e"].map((id) => node(id));
  const chainEdges = [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "e")];
  const dim = (c: ParentNode, id: string) => byKey(c, id).classList.contains("dim");

  it("Enter selects, focus stays on the node, and nodes two hops away are not dimmed", () => {
    const sel = { id: null as string | null };
    const props = (selectedId: string | null) => ui({ nodes: chainNodes, edges: chainEdges, selectedId, onSelect: (id) => { sel.id = id; } });
    const { container, rerender } = render(props(null));
    const c = byKey(container, "c");
    fireEvent.focus(c);
    // nothing selected: the focus lights the neighbourhood, as a pointer hover does
    expect(dim(container, "a")).toBe(true);
    expect(dim(container, "b")).toBe(false);
    fireEvent.keyDown(c, { key: "Enter" });
    expect(sel.id).toBe("c");
    rerender(props("c"));
    for (const id of ["a", "b", "c", "d", "e"]) expect(dim(container, id)).toBe(false);
  });

  it("a pointer hover with a selection still shows the one-hop neighbourhood", () => {
    const { container } = render(ui({ nodes: chainNodes, edges: chainEdges, selectedId: "c" }));
    fireEvent.pointerMove(container.querySelector("svg.cg-svg")!, { pointerId: 1, clientX: 5, clientY: 5 });
    const circle = byKey(container, "a").querySelector("circle")!;
    fireEvent.pointerMove(circle, { pointerId: 1, clientX: 5, clientY: 5 });
    expect(dim(container, "e")).toBe(true);
    expect(dim(container, "b")).toBe(false);
  });
});

describe("blank labels", () => {
  it("shows a dash for a label of only white space", () => {
    expect(displayLabel("  \t")).toBe("—");
    expect(labelWidth("   ")).toBe(labelWidth(""));
    const { container } = render(ui({ nodes: [node("a", "   ")], edges: [], selectedId: null }));
    expect(byKey(container, "a").querySelector("text.lg-label")!.textContent).toBe("—");
  });
});

describe("edge label width", () => {
  it("counts monospace characters: Latin about 0.62em, full-width 1em", () => {
    expect(monoUnits("Grounds")).toBeCloseTo(7 * 0.62, 10);
    expect(monoUnits("支撑")).toBe(2);
    expect(monoUnits("")).toBe(0);
  });

  it("clears an obstacle exactly at the estimated width", () => {
    const samples = Array.from({ length: 19 }, (_, i) => ({ x: i * 10, y: 0 }));
    const mid = samples[Math.floor(0.5 * samples.length)]!;
    const fs = 9.5;
    const w = 2 * 0.62 * fs + 4;
    // an obstacle just outside the label's right edge does not push it off the middle
    const blocker = { l: mid.x + w / 2 + 0.2, r: mid.x + w / 2 + 30, t: -10, b: 10 };
    expect(placeEdgeLabels([{ id: "e", text: "ab", samples }], [blocker], fs).get("e")).toEqual(mid);
    // a full-width label is wider than the same number of Latin characters
    const wide = 2 * fs + 4;
    const near = { l: mid.x + w / 2 + 0.2, r: mid.x + wide, t: -10, b: 10 };
    const p = placeEdgeLabels([{ id: "e", text: "支撑", samples }], [near], fs).get("e")!;
    expect(boxesHit({ l: p.x - wide / 2, r: p.x + wide / 2, t: -6, b: 6 }, near)).toBe(false);
  });
});
