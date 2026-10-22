/**
 * The argument graph view (ticket 04) at the component seam in happy-dom: the pure outline and finding list, the
 * reading panel's display rules, the three load/fail states, the live refresh that keeps the selection, the audit
 * list, source opening, the entries and the deep link. The server is a stubbed global fetch (the real `api/` module
 * runs); the WebSocket is a listener set the test fires. Layout, fit and pixels are checked in a real browser.
 */
import { type Argument, type ArgumentGraph, ArgumentPageSchema, auditArgumentGraph } from "@argelanderspace/contracts";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/i18n";
import i18n from "../src/i18n";
import { buildOutline, type OutlineRow } from "../src/argument/outline";
import { listFindings } from "../src/argument/findings";
import { ArgumentGraphMode } from "../src/argument/ArgumentGraphMode";
import { ArgumentPanel, sourceAnchor } from "../src/argument/ArgumentPanel";
import { captureArgumentPage } from "../src/argument/page";
import { argumentBus, argumentUrl, parseArgumentHash } from "../src/lib/argument-route";
import type { LibraryRef } from "../src/library/types";
import { ARGUMENT_FIXTURES } from "./fixtures/argument-graphs";
import { fakeBus, graphChanged } from "./fake-ws";

vi.mock("../src/api/ws", async () => (await import("./fake-ws")).wsModule());

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const WORK_ID = "arxiv:0000.00001";
const WORK: LibraryRef = { id: WORK_ID, title: "合成星团论文", authors: "Zhang, Li & Wang", year: 2024, venue: "ApJ", type: "article", cite: "zhang2024", tags: [], pdf: false, read: false, star: false, doc_ids: ["arxiv-0000.00001", "pdf-7c1e-synthetic"] };

/** What the stubbed server answers for `GET /api/works/:id/argument-graph`. */
let reply: () => { status: number; body: unknown } = () => ({ status: 200, body: ARGUMENT_FIXTURES.clean() });
const requested: string[] = [];
beforeEach(() => {
  void i18n.changeLanguage("zh-CN");
  vi.stubGlobal("ResizeObserver", RO);
  requested.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      requested.push(String(input));
      const { status, body } = reply();
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  reply = () => ({ status: 200, body: ARGUMENT_FIXTURES.clean() });
});

const clean = ARGUMENT_FIXTURES.clean;
const ui = (root: ParentNode, id: string) => [...root.querySelectorAll(`[data-ui="${id}"]`)];
const byKey = (root: ParentNode, id: string, key: string) => ui(root, id).find((e) => e.getAttribute("data-ui-key") === key) as HTMLElement | undefined;

function openAll(graph: ArgumentGraph): OutlineRow[] {
  const audit = auditArgumentGraph(graph);
  const open = new Map<string, boolean>();
  for (let round = 0; round < 40; round++) {
    const o = buildOutline(graph, audit, open);
    const closed = [...o.ends, ...o.orphans].filter((r) => r.expandable && !r.open);
    if (closed.length === 0) return [...o.ends, ...o.orphans];
    for (const r of closed) open.set(r.key, true);
  }
  throw new Error("outline did not settle");
}

describe("outline", () => {
  it("roots at the End arguments, opens two levels by default, and tags each row with the role it plays", () => {
    const g = clean();
    const o = buildOutline(g, auditArgumentGraph(g), new Map());
    expect(o.noEnd).toBe(false);
    const roots = o.ends.filter((r) => r.depth === 0).map((r) => r.id);
    expect(roots).toEqual(["e1", "e2"]); // graph order
    // default: two levels are open, so the End, what supports it, and what supports that are in view; no deeper
    expect(Math.max(...o.ends.map((r) => r.depth))).toBe(2);
    expect(o.ends.filter((r) => r.depth === 0).every((r) => r.open)).toBe(true);
    expect(o.ends.filter((r) => r.depth === 1).slice(0, 2).map((r) => [r.id, r.role])).toEqual([["m4", "grounds"], ["m5", "grounds"]]);
    expect(o.ends.find((r) => r.depth === 2 && r.id === "m2")).toMatchObject({ role: "grounds", expandable: true, open: false });
    expect(o.orphans).toEqual([]);
  });

  it("expands a row on demand and shows the same argument in several places", () => {
    const g = clean();
    const audit = auditArgumentGraph(g);
    const first = buildOutline(g, audit, new Map());
    expect(first.ends.some((r) => r.id === "m1" && r.depth === 3)).toBe(false);
    const m2 = first.ends.find((r) => r.id === "m2")!; // e1 > m4 > m2
    const opened = buildOutline(g, audit, new Map([[m2.key, true]]));
    expect(opened.ends.filter((r) => r.depth === 3).map((r) => [r.id, r.role])).toEqual([["m1", "grounds"]]);
    // m4 supports both End arguments: it appears under e1 and under e2, with different keys
    expect(opened.ends.filter((r) => r.id === "m4").length).toBe(2);
    expect(new Set(opened.ends.map((r) => r.key)).size).toBe(opened.ends.length);
  });

  it("marks an argument already on the path as a cycle and does not expand it", () => {
    const rows = openAll(ARGUMENT_FIXTURES.flawed());
    const loops = rows.filter((r) => r.cycle);
    expect(loops.length).toBeGreaterThan(0);
    expect(loops.every((r) => !r.expandable && !r.open)).toBe(true);
    // the cycle m1 -> m2 -> m4 -> m1 closes at m1 under e1/m4/m2/m1/m4 (m4 repeats)
    expect(loops.some((r) => r.id === "m4")).toBe(true);
  });

  it("groups the arguments with no path to an End on their own", () => {
    const g = ARGUMENT_FIXTURES.flawed();
    const o = buildOutline(g, auditArgumentGraph(g), new Map());
    expect(o.orphans.filter((r) => r.depth === 0).map((r) => r.id)).toEqual(["m6"]);
    expect(o.noEnd).toBe(false);
  });

  it("with no End argument says so and lists every argument", () => {
    const g = clean();
    g.arguments = g.arguments.map((a): Argument => (a.kind === "end" ? { ...a, kind: "normal" } : a));
    const o = buildOutline(g, auditArgumentGraph(g), new Map());
    expect(o.noEnd).toBe(true);
    expect(o.ends).toEqual([]);
    expect(o.orphans.filter((r) => r.depth === 0).map((r) => r.id)).toEqual(g.arguments.map((a) => a.id));
  });

  it("an empty graph has nothing to say", () => {
    const g = ARGUMENT_FIXTURES.empty();
    expect(buildOutline(g, auditArgumentGraph(g), new Map())).toEqual({ ends: [], orphans: [], noEnd: false });
  });
});

describe("findings list", () => {
  it("lists what the contracts audit reports, with the arguments each names", () => {
    const g = ARGUMENT_FIXTURES.flawed();
    const f = listFindings(auditArgumentGraph(g));
    expect(f.map((x) => x.kind)).toEqual(expect.arrayContaining(["cycle", "noPathToEnd", "endWithOutEdge", "nativeWithInEdge", "incomplete"]));
    expect(f.find((x) => x.kind === "cycle")!.ids).toEqual(expect.arrayContaining(["m1", "m2", "m4"]));
    expect(f.find((x) => x.kind === "incomplete" && x.ids[0] === "x1")).toMatchObject({ missing: ["claim", "grounds", "warrant"] });
  });
  it("a clean graph has none; a graph with no End has the one graph-level finding", () => {
    expect(listFindings(auditArgumentGraph(clean()))).toEqual([]);
    const g = clean();
    g.arguments = g.arguments.map((a): Argument => (a.kind === "end" ? { ...a, kind: "normal" } : a));
    expect(listFindings(auditArgumentGraph(g)).filter((x) => x.kind === "noEnd")).toEqual([{ kind: "noEnd", ids: [] }]);
  });
});

describe("page for the Copilot", () => {
  it("carries the work, the whole graph and the selected argument; a selection that is gone is dropped", () => {
    const g = clean();
    expect(captureArgumentPage({ workId: WORK_ID, title: "T", graph: g, phase: "ready", selectedId: "m1" })).toMatchObject({ work: { id: WORK_ID, title: "T" }, phase: "ready", selectedId: "m1" });
    expect(captureArgumentPage({ workId: WORK_ID, title: "T", graph: g, phase: "ready", selectedId: "nope" }).selectedId).toBeNull();
    expect(captureArgumentPage({ workId: WORK_ID, title: "T", graph: null, phase: "corrupt", selectedId: "m1" })).toMatchObject({ graph: null, selectedId: null });
  });
});

const panel = (id: string, graph = clean(), extra: Partial<Parameters<typeof ArgumentPanel>[0]> = {}) => {
  const argument = graph.arguments.find((a) => a.id === id)!;
  const findings = listFindings(auditArgumentGraph(graph)).filter((f) => f.ids.some((x) => x === id));
  return render(
    <ArgumentPanel graph={graph} argument={argument} findings={findings} describe={(f) => `finding:${f.kind}`} workDocIds={["arxiv-0000.00001"]} onSelect={() => {}} onClose={() => {}} onOpenSource={() => {}} onSave={async () => ({ kind: "ok" })} onDiscardNew={() => {}} onDelete={() => {}} onAddEdge={() => {}} onRemoveEdge={() => {}} onReload={async () => null} onDirtyChange={() => {}} {...extra} />
  );
};

describe("reading panel", () => {
  it("shows the kind badge, the short title and the six elements that have content, Markdown and math rendered", () => {
    const { container } = panel("m3");
    expect(container.querySelector('[data-ui="argument-kind-badge"]')!.textContent).toBe("普通");
    expect(container.querySelector('[data-ui="argument-detail-title"]')!.textContent).toBe("尾部样本的污染率");
    const keys = ui(container, "argument-field").map((e) => e.getAttribute("data-ui-key"));
    // m3 has claim, qualifier and warrant text and Grounds in-edges; backing and rebuttal are empty and hidden
    expect(keys).toEqual(["claim", "grounds", "warrant", "qualifier"]);
    expect(container.querySelector(".katex")).not.toBeNull();
  });

  it("an empty required element says it is not filled in, an empty optional one is hidden, and an in-edge fills the element", () => {
    const { container } = panel("m2");
    // m2: claim + warrant text, Grounds comes from the in-edge m1 -> m2 only
    const grounds = byKey(container, "argument-field", "grounds")!;
    expect(grounds.querySelector('[data-ui="argument-field-empty"]')).toBeNull();
    expect(within(grounds).getByText("候选成员样本")).toBeTruthy();
    expect(ui(container, "argument-field").map((e) => e.getAttribute("data-ui-key"))).toEqual(["claim", "grounds", "warrant"]);
    cleanup();
    const bare = ARGUMENT_FIXTURES.flawed();
    const { container: c2 } = panel("x1", bare);
    for (const k of ["claim", "grounds", "warrant"]) expect(byKey(c2, "argument-field", k)!.querySelector('[data-ui="argument-field-empty"]')!.textContent).toBe("未填写");
    expect(ui(c2, "argument-field").length).toBe(3);
  });

  it("marks an implicit Warrant, and only then", () => {
    const { container } = panel("n1");
    expect(container.querySelector('[data-ui="argument-warrant-implicit"]')!.textContent).toBe("（隐含）");
    cleanup();
    const { container: c2 } = panel("n2");
    expect(c2.querySelector('[data-ui="argument-warrant-implicit"]')).toBeNull();
  });

  it("arguments feeding an element sit inside it and select the other argument; 'used by' lists the uses with their role", () => {
    const onSelect = vi.fn();
    const { container } = panel("m4", clean(), { onSelect });
    const rebuttal = byKey(container, "argument-field", "rebuttal")!;
    fireEvent.click(within(rebuttal).getByText("尾部样本的污染率"));
    expect(onSelect).toHaveBeenCalledWith("m3");
    const usedBy = container.querySelector('[data-ui="argument-used-by"]')!;
    expect([...usedBy.querySelectorAll(".ag-role-chip")].map((c) => c.textContent)).toEqual(["作为 Grounds", "作为 Grounds"]);
    fireEvent.click(within(usedBy as HTMLElement).getByText("星团正在瓦解"));
    expect(onSelect).toHaveBeenLastCalledWith("e1");
  });

  it("says when nothing uses the argument, and when it has no sources", () => {
    const { container } = panel("e1");
    expect(container.querySelector('[data-ui="argument-used-by"]')!.textContent).toContain("还没有论证使用它的 Claim。");
    cleanup();
    const { container: c2 } = panel("x1", ARGUMENT_FIXTURES.flawed());
    expect(c2.querySelector('[data-ui="argument-sources"]')!.textContent).toContain("没有出处。");
  });

  it("lists the audit findings that name the argument", () => {
    const { container } = panel("m1", ARGUMENT_FIXTURES.flawed());
    expect(ui(container, "argument-finding").map((e) => e.textContent)).toContain("finding:cycle");
    cleanup();
    const { container: c2 } = panel("m1");
    expect(c2.querySelector('[data-ui="argument-findings"]')).toBeNull();
  });

  it("a source opens only when it has a target whose Doc still belongs to the Work; anything else is plain text", () => {
    const onOpenSource = vi.fn();
    // the clean fixture's m4 has sources with a LaTeX Doc target; m6 (flawed) has one with a deleted Doc
    const { container } = panel("m4", clean(), { onOpenSource });
    const links = ui(container, "open-argument-source");
    expect(links.map((e) => e.textContent)).toEqual(["Figure 3", "Section 5"]);
    fireEvent.click(links[0]!);
    expect(onOpenSource).toHaveBeenCalledWith({ doc_id: "arxiv-0000.00001", anchor: "fig-3" });
    cleanup();
    const flawed = ARGUMENT_FIXTURES.flawed();
    const { container: c2 } = panel("m6", flawed, { workDocIds: ["arxiv-0000.00001"] });
    expect(ui(c2, "open-argument-source").map((e) => e.textContent)).toEqual(["Section 5"]);
    expect(ui(c2, "argument-source-text").map((e) => e.textContent)).toEqual(["Appendix B（正文已删除）"]);
    cleanup();
    const { container: c3 } = panel("m4", clean(), { workDocIds: [] }); // the Work lost every Doc
    expect(ui(c3, "open-argument-source")).toEqual([]);
    expect(ui(c3, "argument-source-text").length).toBe(2);
  });

  it("a PDF target goes to the page anchor, a shared-IR target to its structural anchor", () => {
    expect(sourceAnchor({ doc_id: "d", anchor: "sec-3" })).toBe("sec-3");
    expect(sourceAnchor({ doc_id: "d", page: 9 })).toBe("page-9");
  });

  it("renders unsafe Markdown safely", () => {
    const g = clean();
    g.arguments = g.arguments.map((a) => (a.id === "m3" ? { ...a, claim: '<img src=x onerror="alert(1)"> [x](javascript:alert(1))' } : a));
    const { container } = panel("m3", g);
    const claim = byKey(container, "argument-field", "claim")!;
    expect(claim.querySelector("img")).toBeNull();
    expect([...claim.querySelectorAll("a")].every((a) => !(a.getAttribute("href") ?? "").startsWith("javascript:"))).toBe(true);
  });
});

const mount = (props: Partial<Parameters<typeof ArgumentGraphMode>[0]> = {}) =>
  render(<ArgumentGraphMode workId={WORK_ID} work={WORK} onExit={() => {}} onOpenDoc={() => {}} {...props} />);
const ready = async (container: HTMLElement) => {
  await waitFor(() => expect(container.querySelector('[data-ui="argument-graph-view"]')!.getAttribute("data-phase")).toBe("ready"));
};
const fire = (workId: string) => act(() => graphChanged(workId));

describe("view states", () => {
  it("reads the graph of the work by its encoded id and shows the header, outline, canvas", async () => {
    const { container } = mount();
    expect(container.querySelector('[data-ui="argument-graph-loading"]')).not.toBeNull();
    await ready(container);
    expect(requested).toEqual([`/api/works/${encodeURIComponent(WORK_ID)}/argument-graph`]);
    expect(container.querySelector('[data-ui="argument-graph-title"]')!.textContent).toBe("Zhang · 2024 — 合成星团论文");
    expect(container.querySelector('[data-ui="argument-graph-counts"]')!.textContent).toBe("11 个论证 · 13 条边");
    expect(container.querySelector('[data-ui="argument-outline"]')).not.toBeNull();
    expect(container.querySelector('[data-ui="argument-canvas"]')).not.toBeNull();
    expect(container.querySelector('[data-ui="argument-detail"]')).toBeNull();
    expect(container.querySelector('[data-ui="argument-audit-summary"]')!.textContent).toBe("审计通过");
  });

  it("the new-argument and clear controls are present and live (ticket 05)", async () => {
    const { container } = mount();
    await ready(container);
    for (const id of ["create-argument", "clear-argument-graph"]) {
      const b = container.querySelector<HTMLButtonElement>(`[data-ui="${id}"]`)!;
      expect(b.disabled).toBe(false);
    }
  });

  it("an empty graph shows the explanation and the new-argument entry, no outline or canvas, no Copilot button", async () => {
    reply = () => ({ status: 200, body: ARGUMENT_FIXTURES.empty() });
    const { container } = mount();
    await ready(container);
    expect(container.querySelector('[data-ui="argument-graph-empty"]')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-ui="create-first-argument"]')!.disabled).toBe(false);
    expect(container.querySelector('[data-ui="argument-outline"]')).toBeNull();
    expect(container.querySelector('[data-ui="argument-canvas"]')).toBeNull();
    expect(container.querySelector('[data-ui="argument-audit-summary"]')).toBeNull();
    expect(container.querySelector('[data-ui="argument-graph-empty"]')!.textContent).not.toMatch(/Copilot.*(按钮|button)/);
  });

  it("an unknown Work (404) is a state of its own, with a way back", async () => {
    reply = () => ({ status: 404, body: { detail: "work 'x' not found" } });
    const onExit = vi.fn();
    const { container } = mount({ work: null, onExit });
    await waitFor(() => expect(container.querySelector('[data-ui="argument-graph-not-found"]')).not.toBeNull());
    expect(container.querySelector('[data-ui="argument-graph-title"]')!.textContent).toBe(WORK_ID);
    expect(container.querySelector('[data-ui="argument-graph-empty"]')).toBeNull();
    fireEvent.click(container.querySelector('[data-ui="argument-graph-not-found"] [data-ui="argument-not-found-return"]')!);
    expect(onExit).toHaveBeenCalled();
  });

  it("an unreadable graph file is an error state, never an empty graph, and can be retried", async () => {
    reply = () => ({ status: 500, body: { detail: "argument graph file is unreadable (corrupt)" } });
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('[data-ui="argument-graph-corrupt"]')).not.toBeNull());
    expect(container.querySelector('[data-ui="argument-graph-empty"]')).toBeNull();
    expect(container.querySelector('[data-ui="create-argument"]')).toBeNull();
    reply = () => ({ status: 200, body: clean() });
    fireEvent.click(container.querySelector('[data-ui="retry-argument-graph"]')!);
    await ready(container);
    expect(container.querySelector('[data-ui="argument-graph-corrupt"]')).toBeNull();
  });

  it("another failure (server error, no answer) is a retryable error, told apart from a corrupt file", async () => {
    reply = () => ({ status: 500, body: { detail: "library could not be read" } });
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('[data-ui="argument-graph-error"]')).not.toBeNull());
    expect(container.querySelector('[data-ui="argument-graph-corrupt"]')).toBeNull();
  });
});

describe("selection, audit and refresh", () => {
  it("selecting from the outline opens the panel and the canvas lights the chain; closing clears it", async () => {
    const { container } = mount();
    await ready(container);
    fireEvent.click(byKey(container, "argument-outline-row", "m4")!);
    const p = container.querySelector('[data-ui="argument-detail"]')!;
    expect(p.getAttribute("data-ui-key")).toBe("m4");
    expect(byKey(container, "argument-outline-item", "m4")!.className).toContain("sel");
    fireEvent.click(p.querySelector('[data-ui="close-argument-detail"]')!);
    expect(container.querySelector('[data-ui="argument-detail"]')).toBeNull();
  });

  it("the outline folds and unfolds, and flags rows with findings", async () => {
    reply = () => ({ status: 200, body: ARGUMENT_FIXTURES.flawed() });
    const { container } = mount();
    await ready(container);
    const rowsOf = (id: string) => ui(container, "argument-outline-row").filter((e) => e.getAttribute("data-ui-key") === id).length;
    const before = rowsOf("m1");
    const m2Row = ui(container, "argument-outline-item").find((e) => e.getAttribute("data-ui-key") === "m2")!;
    fireEvent.click(m2Row.querySelector('[data-ui="toggle-argument-outline-node"]')!);
    expect(rowsOf("m1")).toBe(before + 1); // m2 is supported by m1
    expect(container.querySelector('[data-ui="argument-outline-flag"]')).not.toBeNull();
    expect(container.querySelector('[data-ui="argument-outline-orphans"]')!.textContent).toBe("未通往 End 的论证");
    fireEvent.click(ui(container, "argument-outline-item").find((e) => e.getAttribute("data-ui-key") === "m2")!.querySelector('[data-ui="toggle-argument-outline-node"]')!);
    expect(rowsOf("m1")).toBe(before);
  });

  it("with no End the outline says it cannot expand from a conclusion and lists all arguments", async () => {
    const g = clean();
    g.arguments = g.arguments.map((a): Argument => (a.kind === "end" ? { ...a, kind: "normal" } : a));
    reply = () => ({ status: 200, body: g });
    const { container } = mount();
    await ready(container);
    expect(container.querySelector('[data-ui="argument-outline-no-end"]')!.textContent).toContain("没有 End 论证");
    expect(ui(container, "argument-outline-item").filter((e) => e.getAttribute("style")?.includes("padding-left: 8px")).length).toBe(g.arguments.length);
  });

  it("the audit badge shows the count; its list names each finding and a click selects the argument", async () => {
    reply = () => ({ status: 200, body: ARGUMENT_FIXTURES.flawed() });
    const { container } = mount();
    await ready(container);
    const badge = container.querySelector<HTMLElement>('[data-ui="argument-audit-summary"]')!;
    const n = listFindings(auditArgumentGraph(ARGUMENT_FIXTURES.flawed())).length;
    expect(badge.textContent).toBe(`${n} 项审计发现`);
    expect(container.querySelector('[data-ui="argument-audit-popover"]')).toBeNull();
    fireEvent.click(badge);
    const rows = ui(container, "argument-audit-finding") as HTMLButtonElement[];
    expect(rows.length).toBe(n);
    const incomplete = rows.find((r) => r.textContent!.includes("「光度函数的转折」不完整：缺 Claim、Grounds、Warrant"))!;
    expect(incomplete).toBeDefined();
    fireEvent.click(incomplete);
    expect(container.querySelector('[data-ui="argument-detail"]')!.getAttribute("data-ui-key")).toBe("x1");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(container.querySelector('[data-ui="argument-audit-popover"]')).toBeNull();
  });

  it("a change event for this Work reads the graph again and keeps the selection while the argument exists", async () => {
    const { container } = mount();
    await ready(container);
    fireEvent.click(byKey(container, "argument-outline-row", "m4")!);
    const changed = clean();
    changed.rev = 8;
    changed.arguments = changed.arguments.map((a) => (a.id === "m4" ? { ...a, title: "尾部形态已更名" } : a));
    reply = () => ({ status: 200, body: changed });
    fire("some-other-work");
    expect(requested.length).toBe(1); // another Work's event is not ours
    fire(WORK_ID);
    await waitFor(() => expect(container.querySelector('[data-ui="argument-detail-title"]')!.textContent).toBe("尾部形态已更名"));
    expect(container.querySelector('[data-ui="argument-detail"]')!.getAttribute("data-ui-key")).toBe("m4");
  });

  it("drops the selection when the argument is gone after a refresh, and shows a graph that became corrupt", async () => {
    const { container } = mount();
    await ready(container);
    fireEvent.click(byKey(container, "argument-outline-row", "m3")!);
    expect(container.querySelector('[data-ui="argument-detail"]')).not.toBeNull();
    const smaller = clean();
    smaller.arguments = smaller.arguments.filter((a) => a.id !== "m3");
    smaller.edges = smaller.edges.filter((e) => e.from !== "m3" && e.to !== "m3");
    reply = () => ({ status: 200, body: smaller });
    fire(WORK_ID);
    await waitFor(() => expect(container.querySelector('[data-ui="argument-detail"]')).toBeNull());
    reply = () => ({ status: 500, body: { detail: "argument graph file is unreadable (corrupt)" } });
    fire(WORK_ID);
    await waitFor(() => expect(container.querySelector('[data-ui="argument-graph-corrupt"]')).not.toBeNull());
  });

  it("an identical re-read does not disturb the view (the server's own write fires twice)", async () => {
    const { container } = mount();
    await ready(container);
    fireEvent.click(byKey(container, "argument-outline-row", "m4")!);
    const panelEl = container.querySelector('[data-ui="argument-detail"]');
    fire(WORK_ID);
    await waitFor(() => expect(requested.length).toBe(2));
    expect(container.querySelector('[data-ui="argument-detail"]')).toBe(panelEl);
  });

  it("opening a source hands the Doc and its anchor to the reading pane", async () => {
    const onOpenDoc = vi.fn();
    const { container } = mount({ onOpenDoc });
    await ready(container);
    fireEvent.click(byKey(container, "argument-outline-row", "m4")!);
    fireEvent.click(ui(container, "open-argument-source")[0]!);
    expect(onOpenDoc).toHaveBeenCalledWith("arxiv-0000.00001", "fig-3");
    cleanup();
    reply = () => ({ status: 200, body: clean() });
    const { container: c2 } = mount({ onOpenDoc });
    await ready(c2);
    fireEvent.click(byKey(c2, "argument-outline-row", "m3")!); // m3 > n4 (Page 9 source) ; select n4 through the panel link
    fireEvent.click(within(byKey(c2, "argument-field", "grounds")!).getByText("银河系模型给出场星密度"));
    fireEvent.click(ui(c2, "open-argument-source").find((e) => e.textContent === "Page 9")!);
    expect(onOpenDoc).toHaveBeenLastCalledWith("pdf-7c1e-synthetic", "page-9");
  });

  it("publishes the page (work, graph, selection) and withdraws it when it goes away", async () => {
    const onPage = vi.fn();
    const { container, unmount } = mount({ onPage });
    await ready(container);
    fireEvent.click(byKey(container, "argument-outline-row", "m4")!);
    const last = onPage.mock.calls.slice(-1)[0]![0];
    expect(last).toMatchObject({ phase: "ready", work: { id: WORK_ID, title: "合成星团论文" }, selectedId: "m4" });
    expect(last.graph.arguments.length).toBe(11);
    unmount();
    expect(onPage.mock.calls.slice(-1)[0]![0]).toBeNull();
  });

  it("speaks English with the English catalog", async () => {
    await i18n.changeLanguage("en");
    const { container } = mount();
    await ready(container);
    expect(container.querySelector('[data-ui="argument-graph-counts"]')!.textContent).toBe("11 arguments · 13 edges");
    expect(container.querySelector('[data-ui="argument-audit-summary"]')!.textContent).toBe("Audit passed");
  });
});

describe("review fixes (round A)", () => {
  const tooltipOf = (el: HTMLElement) => document.getElementById(el.getAttribute("aria-describedby")!.split(" ").pop()!)!.textContent;

  it("the new-argument and clear controls are live and carry their names (ticket 05 connected them)", async () => {
    const { container } = mount();
    await ready(container);
    for (const [id, name] of [["create-argument", "argument.edit.newArgTooltip"], ["clear-argument-graph", "argument.edit.clearTooltip"]] as const) {
      const b = container.querySelector<HTMLButtonElement>(`[data-ui="${id}"]`)!;
      expect(b.disabled).toBe(false);
      expect(tooltipOf(b)).toBe(i18n.t(name));
    }
    cleanup();
    reply = () => ({ status: 200, body: ARGUMENT_FIXTURES.empty() });
    const { container: empty } = mount();
    await ready(empty);
    const first = empty.querySelector<HTMLButtonElement>('[data-ui="create-first-argument"]')!;
    expect(first.disabled).toBe(false);
    expect(tooltipOf(first)).toBe(i18n.t("argument.edit.newArgTooltip"));
  });

  it("a passed audit is a plain badge, not a button; the list closes after a pick and Escape returns the focus to the badge", async () => {
    const { container } = mount();
    await ready(container);
    const passed = container.querySelector<HTMLElement>('[data-ui="argument-audit-summary"]')!;
    expect(passed.tagName).not.toBe("BUTTON");
    expect(passed.querySelector("button")).toBeNull();
    expect(passed.getAttribute("data-state")).toBe("passed");
    cleanup();
    reply = () => ({ status: 200, body: ARGUMENT_FIXTURES.flawed() });
    const { container: c2 } = mount();
    await ready(c2);
    const badge = c2.querySelector<HTMLButtonElement>('[data-ui="argument-audit-summary"]')!;
    expect(badge.tagName).toBe("BUTTON");
    fireEvent.click(badge);
    // a pick selects the argument and closes the list that would cover the panel
    fireEvent.click(ui(c2, "argument-audit-finding").find((r) => r.textContent!.includes("不完整"))! as HTMLElement);
    expect(c2.querySelector('[data-ui="argument-detail"]')).not.toBeNull();
    expect(c2.querySelector('[data-ui="argument-audit-popover"]')).toBeNull();
    // Escape closes an open list and puts the focus back on the badge
    fireEvent.click(badge);
    expect(c2.querySelector('[data-ui="argument-audit-popover"]')).not.toBeNull();
    (ui(c2, "argument-audit-finding")[0] as HTMLElement).focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(c2.querySelector('[data-ui="argument-audit-popover"]')).toBeNull();
    expect(document.activeElement).toBe(badge);
  });

  it("findings of one kind have different keys", async () => {
    reply = () => ({ status: 200, body: ARGUMENT_FIXTURES.flawed() });
    const { container } = mount();
    await ready(container);
    fireEvent.click(container.querySelector('[data-ui="argument-audit-summary"]')!);
    const keys = ui(container, "argument-audit-finding").map((r) => r.getAttribute("data-ui-key"));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((k) => k!.startsWith("incomplete:")).length).toBeGreaterThan(1);
  });

  it("several sources of one Doc, and text-only sources, each have their own key", async () => {
    const g = clean();
    const m4 = g.arguments.find((a) => a.id === "m4")!;
    m4.sources = [
      { text: "Figure 3", target: { doc_id: "arxiv-0000.00001", anchor: "fig-3" } },
      { text: "Section 2", target: { doc_id: "arxiv-0000.00001", anchor: "sec-2" } },
      { text: "Appendix" },
      { text: "Appendix B" },
    ];
    reply = () => ({ status: 200, body: g });
    const { container } = mount();
    await ready(container);
    fireEvent.click(byKey(container, "argument-outline-row", "m4")!);
    const open = ui(container, "open-argument-source").map((e) => e.getAttribute("data-ui-key"));
    const text = ui(container, "argument-source-text").map((e) => e.getAttribute("data-ui-key"));
    expect(open).toEqual(["0", "1"]);
    expect(text).toEqual(["2", "3"]);
  });

  it("the not-found button and the header's back button are not the exploration's data-ui", async () => {
    reply = () => ({ status: 404, body: { detail: "work not found" } });
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('[data-ui="argument-graph-not-found"]')).not.toBeNull());
    expect(container.querySelector('[data-ui="return-to-library"]')).toBeNull();
    expect(container.querySelector('[data-ui="argument-graph-not-found"] [data-ui="argument-not-found-return"]')).not.toBeNull();
    expect(container.querySelector('[data-ui="argument-graph-header"] [data-ui="argument-return-to-library"]')).not.toBeNull();
    expect(container.querySelector('[data-ui="return-to-work"]')).toBeNull();
    // icons are configured per data-ui (ui/icons.json): the renamed back button still draws its arrow, not its label
    expect(container.querySelector('[data-ui="argument-return-to-library"] svg')).not.toBeNull();
  });

  it("an outline row's title carries a tooltip with the whole title (the row truncates it)", async () => {
    const { container } = mount();
    await ready(container);
    const row = byKey(container, "argument-outline-row", "m4")!;
    const text = row.querySelector<HTMLElement>(".ag-out-text")!;
    expect(text.getAttribute("title")).toBe(text.textContent);
    expect(row.querySelector(".ag-sr-only")).toBeNull();
    expect(row.querySelector(".visually-hidden")).not.toBeNull();
  });

  it("a refresh that fails for a transient reason keeps the graph on screen with a notice; Retry clears it", async () => {
    const { container } = mount();
    await ready(container);
    fireEvent.click(byKey(container, "argument-outline-row", "m4")!);
    reply = () => ({ status: 503, body: { detail: "busy" } });
    fire(WORK_ID);
    await waitFor(() => expect(container.querySelector('[data-ui="argument-graph-refresh-failed"]')).not.toBeNull());
    expect(container.querySelector('[data-ui="argument-graph-error"]')).toBeNull();
    expect(container.querySelector('[data-ui="argument-canvas"]')).not.toBeNull();
    expect(container.querySelector('[data-ui="argument-detail"]')!.getAttribute("data-ui-key")).toBe("m4");
    reply = () => ({ status: 200, body: clean() });
    fireEvent.click(container.querySelector('[data-ui="retry-argument-graph-refresh"]')!);
    await waitFor(() => expect(container.querySelector('[data-ui="argument-graph-refresh-failed"]')).toBeNull());
    expect(container.querySelector('[data-ui="argument-detail"]')).not.toBeNull();
  });

  it("Retry shows it is working while the read is in flight, cannot be pressed twice, and goes away on success", async () => {
    const { container } = mount();
    await ready(container);
    reply = () => ({ status: 503, body: { detail: "busy" } });
    fire(WORK_ID);
    await waitFor(() => expect(container.querySelector('[data-ui="retry-argument-graph-refresh"]')).not.toBeNull());
    const button = () => container.querySelector<HTMLButtonElement>('[data-ui="retry-argument-graph-refresh"]')!;
    expect(button().disabled).toBe(false);
    expect(button().textContent).toBe("重试");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchMock = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify(clean()), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    fireEvent.click(button());
    await waitFor(() => expect(button().disabled).toBe(true));
    expect(button().getAttribute("aria-busy")).toBe("true");
    expect(button().textContent).toBe("重试中…");
    fireEvent.click(button());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(container.querySelector('[data-ui="argument-graph-refresh-failed"]')).toBeNull());
  });

  it("a missing Work (404) and an unreadable file still replace the graph; the first read has no graph to keep", async () => {
    const { container } = mount();
    await ready(container);
    reply = () => ({ status: 404, body: { detail: "gone" } });
    fire(WORK_ID);
    await waitFor(() => expect(container.querySelector('[data-ui="argument-graph-not-found"]')).not.toBeNull());
    cleanup();
    reply = () => ({ status: 503, body: { detail: "busy" } });
    const { container: first } = mount();
    await waitFor(() => expect(first.querySelector('[data-ui="argument-graph-error"]')).not.toBeNull());
    expect(first.querySelector('[data-ui="argument-graph-refresh-failed"]')).toBeNull();
  });

  it("a reconnect of the socket reads the graph once more", async () => {
    const { container } = mount();
    await ready(container);
    expect(requested.length).toBe(1);
    const changed = clean();
    changed.rev = 9;
    changed.arguments = changed.arguments.map((a) => (a.id === "m4" ? { ...a, title: "重连后的标题" } : a));
    reply = () => ({ status: 200, body: changed });
    act(() => fakeBus.emit("hello", { jobs: [] }));
    await waitFor(() => expect(requested.length).toBe(2));
    fireEvent.click(await waitFor(() => byKey(container, "argument-outline-row", "m4")!));
    expect(container.querySelector('[data-ui="argument-detail-title"]')!.textContent).toBe("重连后的标题");
  });

  it("publishes the contract's page: whole graph, rev, audit, selection; a graph with no arguments is empty", async () => {
    const onPage = vi.fn();
    const { container } = mount({ onPage });
    await ready(container);
    fireEvent.click(byKey(container, "argument-outline-row", "m4")!);
    const page = onPage.mock.calls.slice(-1)[0]![0];
    expect(page).toMatchObject({ phase: "ready", partial: false, selectedId: "m4", counts: { arguments: 11, edges: 13 }, audit: { total: 0 } });
    expect(ArgumentPageSchema.safeParse(page).success).toBe(true);
    cleanup();
    reply = () => ({ status: 200, body: ARGUMENT_FIXTURES.empty() });
    const onEmpty = vi.fn();
    const { container: empty } = mount({ onPage: onEmpty });
    await ready(empty);
    expect(onEmpty.mock.calls.slice(-1)[0]![0]).toMatchObject({ phase: "empty", counts: { arguments: 0, edges: 0 } });
    for (const [status, body, phase] of [[404, { detail: "x" }, "not-found"], [500, { detail: "argument graph file is unreadable (corrupt)" }, "corrupt"], [503, {}, "error"]] as const) {
      cleanup();
      reply = () => ({ status, body });
      const spy = vi.fn();
      mount({ onPage: spy });
      await waitFor(() => expect(spy.mock.calls.slice(-1)[0]![0]).toMatchObject({ phase }));
    }
  });
});

describe("deep link", () => {
  it("encodes and decodes the work id, and rejects what is not a graph link", () => {
    expect(argumentUrl(WORK_ID)).toBe("/#argument/arxiv%3A0000.00001");
    expect(parseArgumentHash("#argument/arxiv%3A0000.00001")).toBe(WORK_ID);
    expect(parseArgumentHash("#argument/a%2Fb")).toBe("a/b");
    expect(parseArgumentHash("#explore/x")).toBeNull();
    expect(parseArgumentHash("#argument/")).toBeNull();
    expect(parseArgumentHash("#argument/%E0%A4%A")).toBeNull(); // malformed percent-encoding
  });

  it("a request waits for a Library page to register, and goes to the one that is open", () => {
    const open = vi.fn();
    argumentBus.request("w-late", { push: false });
    const off = argumentBus.register({ isOpen: () => false, workId: () => null, open, exit: vi.fn() });
    return Promise.resolve().then(() => {
      expect(open).toHaveBeenCalledWith("w-late", { push: false });
      const exit = vi.fn();
      const off2 = argumentBus.register({ isOpen: () => true, workId: () => null, open: vi.fn(), exit });
      argumentBus.exit();
      expect(exit).toHaveBeenCalled();
      off2();
      off();
    });
  });
});
