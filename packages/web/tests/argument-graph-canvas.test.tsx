/**
 * Argument graph adapter + layered canvas (ticket 03), at the component seam in happy-dom: element
 * structure, edge roles and line styles, audit marks, chain focus, labels, the connect gesture and the
 * adapter mapping. happy-dom has no layout, so overlap counts, fit rules and pixels are checked in a
 * real browser (see the ticket's Comments), not here.
 */
import { auditArgumentGraph } from "@argelanderspace/contracts";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Argument, ArgumentGraph } from "@argelanderspace/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArgumentGraphCanvas } from "../src/argument/ArgumentGraphCanvas";
import { argumentEdgeId, auditCounts, buildArgumentCanvas, cycleEdgeIds } from "../src/argument/canvasModel";
import { ARGUMENT_FIXTURES } from "./fixtures/argument-graphs";

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeEach(() => vi.stubGlobal("ResizeObserver", RO));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const eid = (from: string, to: string, role: "grounds" | "warrant" | "backing" | "rebuttal") => argumentEdgeId({ from, to, role });
/** happy-dom cannot match an attribute selector with escaped quotes, so find the element by its key. */
const byKey = (root: ParentNode, key: string) => [...root.querySelectorAll("[data-ui-key]")].find((e) => e.getAttribute("data-ui-key") === key) ?? null;
const text = { roleName: (r: string) => r[0]!.toUpperCase() + r.slice(1), kindName: (k: string) => k, auditMark: "audit" };

describe("buildArgumentCanvas (adapter mapping)", () => {
  it("maps kinds to colour, ring and pin, and edge roles to colour and line style", () => {
    const g = ARGUMENT_FIXTURES.clean();
    const { nodes, edges } = buildArgumentCanvas(g, auditArgumentGraph(g), text);
    const n = (id: string) => nodes.find((x) => x.id === id)!;
    expect(n("n1")).toMatchObject({ pin: "first", ringed: false, color: "var(--ag-native)" });
    expect(n("e1")).toMatchObject({ pin: "last", ringed: true, color: "var(--ag-end)" });
    expect(n("m1")).toMatchObject({ pin: undefined, ringed: false, color: "var(--ag-normal)" });
    const e = (from: string, to: string, role: string) => edges.find((x) => x.id === JSON.stringify([from, to, role]))!;
    expect(e("n2", "e2", "backing")).toMatchObject({ dash: "dashed", color: "var(--ag-backing)", label: "Backing" });
    expect(e("m3", "m4", "rebuttal")).toMatchObject({ dash: "dotted", color: "var(--ag-rebuttal)" });
    expect(e("n1", "m1", "grounds").dash).toBeUndefined();
    // a graph without findings: no node carries a mark, no edge is on a cycle
    expect(nodes.some((x) => x.mark)).toBe(false);
    expect(edges.some((x) => x.restingColor)).toBe(false);
  });

  it("takes audit marks and cycle edges from the contracts audit, not from its own rules", () => {
    const g = ARGUMENT_FIXTURES.flawed();
    const audit = auditArgumentGraph(g);
    const { nodes, edges } = buildArgumentCanvas(g, audit, text);
    expect(new Set(nodes.filter((x) => x.mark).map((x) => x.id))).toEqual(new Set(auditCounts(audit).keys()));
    expect(auditCounts(audit).get("m1")).toBeGreaterThan(0);
    const cyc = cycleEdgeIds(audit);
    expect(cyc).toEqual(new Set(audit.cycles.flatMap((c) => c.edges.map(argumentEdgeId))));
    expect(cyc.has(eid("m4", "m1", "warrant"))).toBe(true);
    for (const e of edges) expect(e.restingColor === "var(--danger)").toBe(cyc.has(e.id));
    // role label shows only for edges the caller turned on
    const on = buildArgumentCanvas(g, audit, text, new Set([eid("m4", "m1", "warrant")])).edges;
    expect(on.filter((e) => e.showLabel).map((e) => e.id)).toEqual([eid("m4", "m1", "warrant")]);
  });

  it("reports no marks for an empty graph and none for the graph-level noEnd finding", () => {
    const empty = ARGUMENT_FIXTURES.empty();
    expect(buildArgumentCanvas(empty, auditArgumentGraph(empty), text)).toEqual({ nodes: [], edges: [] });
  });
});

function renderArgs(key: "clean" | "flawed" | "large" | "empty", over: Partial<Parameters<typeof ArgumentGraphCanvas>[0]> = {}) {
  return render(<ArgumentGraphCanvas graph={ARGUMENT_FIXTURES[key]()} selectedId={null} onSelect={() => {}} stash={{}} sceneKey="w1" {...over} />);
}

describe("ArgumentGraphCanvas", () => {
  it("renders every argument, edge, bilingual legend and the shared zoom stack", () => {
    const { container } = renderArgs("clean");
    expect(container.querySelectorAll('[data-ui="argument-node"]')).toHaveLength(11);
    expect(container.querySelectorAll('[data-ui="argument-edge"]')).toHaveLength(13);
    const legend = container.querySelector('[data-ui="graph-legend"]')!;
    for (const word of ["Native", "End", "Grounds", "Warrant", "Backing", "Rebuttal"]) expect(legend.textContent).toContain(word);
    expect(container.querySelector('[data-ui="zoom-in"]')).toBeTruthy();
    expect(container.querySelector('[data-ui="argument-canvas"]')).toBeTruthy();
    // End arguments carry the double ring: one extra unfilled circle
    expect(container.querySelectorAll('[data-ui-key="e1"] circle[fill="none"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-ui-key="n1"] circle[fill="none"]')).toHaveLength(0);
  });

  it("draws Backing dashed, Rebuttal dotted, the others solid, and every edge neutral at rest", () => {
    const { container } = renderArgs("clean");
    const cls = (id: string) => byKey(container, id)!.querySelector("path.cg-edge")!.getAttribute("class")!;
    expect(cls(eid("n2", "e2", "backing"))).toContain("lg-edge-dashed");
    expect(cls(eid("m3", "m4", "rebuttal"))).toContain("lg-edge-dotted");
    expect(cls(eid("n1", "m1", "grounds"))).not.toMatch(/dashed|dotted/);
    for (const p of container.querySelectorAll<SVGPathElement>("path.cg-edge")) expect(p.getAttribute("style") ?? "").toBe("");
  });

  it("marks flagged arguments and draws the edges of a cycle in the danger colour at rest", () => {
    const { container } = renderArgs("flawed");
    const audit = auditArgumentGraph(ARGUMENT_FIXTURES.flawed());
    expect(container.querySelectorAll('[data-ui="argument-node-mark"]')).toHaveLength(auditCounts(audit).size);
    const cyc = byKey(container, eid("m4", "m1", "warrant"))!.querySelector("path.cg-edge")!;
    expect(cyc.getAttribute("style")).toContain("var(--danger)");
    expect(byKey(container, eid("n1", "m1", "grounds"))!.querySelector("path.cg-edge")!.getAttribute("style") ?? "").toBe("");
  });

  it("shows at most two title lines per argument", () => {
    const { container } = renderArgs("large");
    for (const t of container.querySelectorAll('[data-ui="argument-title"]')) expect(t.querySelectorAll("tspan").length).toBeLessThanOrEqual(2);
    expect(container.querySelectorAll('[data-ui="argument-title"]')).toHaveLength(28);
  });

  it("focuses a chain: members stay lit, the rest dims, chain edges take their role colour and label", () => {
    const { container } = renderArgs("clean", { selectedId: "m4" });
    const dim = (id: string) => container.querySelector(`[data-ui-key="${id}"]`)!.getAttribute("class")!.includes("dim");
    expect(dim("m4")).toBe(false);
    expect(dim("n3")).toBe(false);
    expect(dim("e2")).toBe(false);
    expect(dim("m5")).toBe(true);
    const grounds = byKey(container, eid("m4", "e1", "grounds"))!;
    expect(grounds.querySelector("path")!.getAttribute("style")).toContain("var(--ag-grounds)");
    expect(grounds.querySelector("text")?.textContent).toBe("Grounds");
    const rebuttal = byKey(container, eid("m3", "m4", "rebuttal"))!;
    expect(rebuttal.querySelector("text")?.textContent).toBe("Rebuttal");
    // outside the chain: dimmed, no label, and the title of a dimmed argument is hidden
    const outside = byKey(container, eid("m1", "m5", "grounds"))!;
    expect(outside.getAttribute("class")).toContain("dim");
    expect(outside.querySelector("text")).toBeNull();
    expect(container.querySelector('[data-ui-key="m5"] [data-ui="argument-title"]')).toBeNull();
    expect(container.querySelector('[data-ui-key="m4"] [data-ui="argument-title"]')).toBeTruthy();
  });

  it("keeps an edge's role label on when the caller turned it on for that edge", () => {
    const { container } = renderArgs("clean", { labelledEdges: new Set([eid("n2", "e2", "backing")]) });
    expect(byKey(container, eid("n2", "e2", "backing"))!.querySelector("text")?.textContent).toBe("Backing");
    expect(byKey(container, eid("n1", "m1", "grounds"))!.querySelector("text")).toBeNull();
  });

  it("selects on click and reports a click on empty canvas as deselect", () => {
    const onSelect = vi.fn();
    const { container } = renderArgs("clean", { onSelect });
    const node = container.querySelector('[data-ui-key="m2"]')!;
    fireEvent.pointerDown(node, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(node, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    expect(onSelect).toHaveBeenLastCalledWith("m2");
    const svg = container.querySelector("svg.cg-svg")!;
    fireEvent.pointerDown(svg, { button: 0, pointerId: 1, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(svg, { button: 0, pointerId: 1, clientX: 5, clientY: 5 });
    expect(onSelect).toHaveBeenLastCalledWith(null);
    fireEvent.keyDown(container.querySelector('[data-ui-key="m3"]')!, { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith("m3");
  });

  it("offers the connect handle only on the selected argument and only when a callback is given", () => {
    expect(renderArgs("clean", { selectedId: "m4" }).container.querySelector('[data-ui="argument-connect-handle"]')).toBeNull();
    cleanup();
    const { container } = renderArgs("clean", { selectedId: "m4", onConnect: () => {} });
    const handles = container.querySelectorAll('[data-ui="argument-connect-handle"]');
    expect(handles).toHaveLength(1);
    expect(handles[0]!.getAttribute("data-connect-from")).toBe("m4");
  });

  it("calls back (from, to, screen position) when the handle is dropped on another argument, and moves nothing else", () => {
    const onConnect = vi.fn();
    const onSelect = vi.fn();
    const { container } = renderArgs("clean", { selectedId: "m4", onConnect, onSelect });
    const handle = container.querySelector('[data-ui="argument-connect-handle"]')!;
    const target = container.querySelector('[data-ui-key="e1"] circle')!;
    const spy = vi.spyOn(document, "elementFromPoint").mockReturnValue(target as unknown as Element);
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    expect(container.querySelector("line.lg-rubber")).toBeTruthy();
    fireEvent.pointerMove(container.querySelector("svg.cg-svg")!, { pointerId: 1, clientX: 60, clientY: 40 });
    fireEvent.pointerUp(container.querySelector("svg.cg-svg")!, { button: 0, pointerId: 1, clientX: 321, clientY: 123 });
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onConnect).toHaveBeenCalledWith("m4", "e1", { x: 321, y: 123 });
    expect(onSelect).not.toHaveBeenCalled();
    expect(container.querySelector("line.lg-rubber")).toBeNull();
    // dropped on empty canvas: no callback
    spy.mockReturnValue(container.querySelector("svg.cg-svg") as unknown as Element);
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(container.querySelector("svg.cg-svg")!, { button: 0, pointerId: 1, clientX: 12, clientY: 12 });
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it("recomputes the layout when structure, kind or short title changes, and drops a drag with it", () => {
    const stash = {};
    const g = ARGUMENT_FIXTURES.clean();
    const { container, rerender } = render(<ArgumentGraphCanvas graph={g} selectedId={null} onSelect={() => {}} stash={stash} sceneKey="w1" />);
    const tr = () => container.querySelector('[data-ui-key="m2"]')!.getAttribute("transform");
    const before = tr();
    // drag m2
    const node = container.querySelector('[data-ui-key="m2"]')!;
    fireEvent.pointerDown(node, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(container.querySelector("svg.cg-svg")!, { pointerId: 1, clientX: 160, clientY: 150 });
    fireEvent.pointerUp(container.querySelector("svg.cg-svg")!, { button: 0, pointerId: 1, clientX: 160, clientY: 150 });
    expect(tr()).not.toBe(before);
    // a re-render with an equal graph (new object, same structure) keeps the drag
    const dragged = tr();
    rerender(<ArgumentGraphCanvas graph={structuredClone(g)} selectedId={null} onSelect={() => {}} stash={stash} sceneKey="w1" />);
    expect(tr()).toBe(dragged);
    // changing a short title relayouts and drops it
    const edited = structuredClone(g);
    edited.arguments.find((a) => a.id === "m2")!.title = "新的短标题";
    rerender(<ArgumentGraphCanvas graph={edited} selectedId={null} onSelect={() => {}} stash={stash} sceneKey="w1" />);
    expect(tr()).not.toBe(dragged);
    expect(container.querySelector('[data-ui-key="m2"] [data-ui="argument-title"]')!.textContent).toBe("新的短标题");
  });

  it("renders an empty graph without nodes and without throwing", () => {
    const { container } = renderArgs("empty");
    expect(container.querySelectorAll('[data-ui="argument-node"]')).toHaveLength(0);
    expect(container.querySelector('[data-ui="graph-legend"]')).toBeTruthy();
  });
});

describe("ArgumentGraphCanvas: colours, names, focus", () => {
  it("draws a lit edge's role label in the normal text colour, only Rebuttal and cycle edges in the danger colour", () => {
    const { container } = renderArgs("clean", { selectedId: "m4" });
    const label = (f: string, t: string, r: "grounds" | "warrant" | "backing" | "rebuttal") =>
      byKey(container, eid(f, t, r))!.querySelector<SVGTextElement>("text")!;
    expect(label("m4", "e1", "grounds").style.fill).toBe("");
    expect(label("m3", "m4", "rebuttal").style.fill).toBe("var(--danger)");
    cleanup();
    const flawed = renderArgs("flawed", { labelledEdges: new Set([eid("m4", "m1", "warrant")]) }).container;
    expect(byKey(flawed, eid("m4", "m1", "warrant"))!.querySelector<SVGTextElement>("text")!.style.fill).toBe("var(--danger)");
  });

  it("marks the edges on a cycle as heavy, and no others", () => {
    const { container } = renderArgs("flawed");
    const heavy = [...container.querySelectorAll('[data-ui="argument-edge"]')].filter((g) => g.querySelector("path")!.getAttribute("class")!.includes("lg-edge-heavy"));
    const cyc = cycleEdgeIds(auditArgumentGraph(ARGUMENT_FIXTURES.flawed()));
    expect(heavy.map((g) => g.getAttribute("data-ui-key")).sort()).toEqual([...cyc].sort());
    expect(heavy.length).toBeGreaterThan(0);
  });

  it("names a node by title, kind and, when flagged, the audit finding; no inline width on the tooltip", () => {
    const { container } = renderArgs("flawed");
    const name = (id: string) => container.querySelector(`[data-ui-key="${id}"]`)!.getAttribute("aria-label")!;
    const flawed = ARGUMENT_FIXTURES.flawed();
    const m1 = flawed.arguments.find((a) => a.id === "m1")!;
    expect(name("m1")).toMatch(/^.+, .+, .+$/);
    expect(name("m1")).toContain(m1.title);
    expect(name("m1")).toContain("有审计发现");
    const flagged = auditCounts(auditArgumentGraph(flawed));
    const plain = flawed.arguments.find((a) => a.kind === "native" && !flagged.has(a.id))!;
    expect(name(plain.id)).not.toContain("有审计发现");
    expect(name(plain.id)).toContain("Native");
    // hover tooltip carries no inline width (the width is a CSS rule)
    fireEvent.pointerMove(container.querySelector('[data-ui-key="m1"] circle')!, { pointerId: 1, clientX: 50, clientY: 50 });
    const tip = container.querySelector<HTMLElement>('[data-ui="argument-node-tooltip"]');
    expect(tip).toBeTruthy();
    expect(tip!.style.width).toBe("");
  });

  it("lights a node's neighbourhood on keyboard focus, like hover, and restores on blur", () => {
    const { container } = renderArgs("clean");
    const dim = (id: string) => container.querySelector(`[data-ui-key="${id}"]`)!.getAttribute("class")!.includes("dim");
    expect([dim("m4"), dim("n3")]).toEqual([false, false]);
    fireEvent.focus(container.querySelector('[data-ui-key="m4"]')!);
    expect(dim("m4")).toBe(false);
    expect(dim("m5")).toBe(true);
    fireEvent.blur(container.querySelector('[data-ui-key="m4"]')!);
    expect(dim("m5")).toBe(false);
  });
});

describe("ArgumentGraphCanvas: ids are arbitrary strings", () => {
  const A = (id: string, kind: Argument["kind"] = "normal"): Argument => ({
    id, title: `T ${id}`, kind, claim: "", grounds: "", warrant: "", backing: "", qualifier: "", rebuttal: "", warrant_implicit: false, sources: [],
  });
  it("keeps distinct edge ids and one element per edge for ids containing > : and a leading ~", () => {
    const g: ArgumentGraph = {
      version: 1, rev: 1, work_id: "w",
      arguments: [A("a>b", "native"), A("c"), A("a", "native"), A("b>c"), A("~x"), A("e", "end")],
      edges: [
        { from: "a>b", to: "c", role: "grounds" },
        { from: "a", to: "b>c", role: "grounds" },
        { from: "~x", to: "e", role: "warrant" },
        { from: "c", to: "e", role: "grounds" },
        { from: "b>c", to: "e", role: "grounds" },
      ],
    };
    expect(new Set(g.edges.map(argumentEdgeId)).size).toBe(g.edges.length);
    const { container } = render(<ArgumentGraphCanvas graph={g} selectedId={null} onSelect={() => {}} stash={{}} sceneKey="w1" />);
    expect(container.querySelectorAll('[data-ui="argument-node"]')).toHaveLength(6);
    expect(new Set([...container.querySelectorAll('[data-ui="argument-edge"]')].map((e) => e.getAttribute("data-ui-key"))).size).toBe(5);
  });
});

describe("ArgumentGraphCanvas: connect drop target", () => {
  it("ignores a node element of another canvas and an element whose id is not in this graph", () => {
    const onConnect = vi.fn();
    const { container } = renderArgs("clean", { selectedId: "m4", onConnect });
    const svg = container.querySelector("svg.cg-svg")!;
    const drop = (el: Element | null) => {
      const spy = vi.spyOn(document, "elementFromPoint").mockReturnValue(el);
      fireEvent.pointerDown(container.querySelector('[data-ui="argument-connect-handle"]')!, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
      fireEvent.pointerUp(svg, { button: 0, pointerId: 1, clientX: 30, clientY: 30 });
      spy.mockRestore();
    };
    // a node of some other canvas that happens to carry a valid id
    const foreign = document.createElement("div");
    foreign.setAttribute("data-node-id", "e1");
    document.body.appendChild(foreign);
    drop(foreign);
    expect(onConnect).not.toHaveBeenCalled();
    foreign.remove();
    // inside this canvas, but not one of its nodes
    const stray = document.createElement("div");
    stray.setAttribute("data-node-id", "no-such-argument");
    container.querySelector('[data-ui="argument-canvas"]')!.appendChild(stray);
    drop(stray);
    expect(onConnect).not.toHaveBeenCalled();
    // control: a real node of this canvas
    drop(container.querySelector('[data-ui-key="e1"] circle'));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });
});

describe("ArgumentGraphCanvas: the selected argument stays visible after a relayout", () => {
  it("re-checks visibility when the layout changes, also after a manual zoom", () => {
    const W = 1200;
    const H = 700;
    class SizedRO {
      constructor(private cb: ResizeObserverCallback) {}
      observe() {
        this.cb([{ contentRect: { width: W, height: H } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", SizedRO);
    const g = ARGUMENT_FIXTURES.large();
    const sel = g.arguments.find((a) => a.kind === "native")!.id;
    // a manual view (not the automatic fit): zoomed in, the selected bottom-row argument just inside the left edge
    const stash: Record<string, unknown> = { view: { tx: 90, ty: H - 140, k: 2 }, auto: false };
    const ui = (graph: ArgumentGraph) => <ArgumentGraphCanvas graph={graph} selectedId={sel} onSelect={() => {}} stash={stash} sceneKey="w1" />;
    const { container, rerender } = render(ui(g));
    const screen = () => {
      const k = container.querySelector(`[data-ui-key="${sel}"]`)!;
      const [x, y] = k.getAttribute("transform")!.match(/-?[\d.]+/g)!.map(Number);
      const v = container.querySelector("svg.cg-svg > g")!.getAttribute("transform")!.match(/-?[\d.]+/g)!.map(Number);
      return { x: x! * v[2]! + v[0]!, y: y! * v[2]! + v[1]! };
    };
    const inside = (p: { x: number; y: number }) => p.x >= 64 - 1 && p.x <= W - 176 + 1 && p.y >= 70 && p.y <= H - 96 + 9;
    expect(inside(screen())).toBe(true);
    // widen the short title of every other argument: the columns move apart and the selected one is pushed away
    const wide = structuredClone(g);
    for (const a of wide.arguments) if (a.id !== sel) a.title = "一个相当长的短标题文字用来撑开列宽一个相当长";
    rerender(ui(wide));
    expect(inside(screen())).toBe(true);
  });
});

