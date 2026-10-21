import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL as NodeURL } from "node:url";
import type { AnnotationsFile, PageContext } from "@argelanderspace/contracts";
import { describe, expect, it, vi } from "vitest";
import { createFakeBus } from "../src/api/ws-bus";
import { activeRungs, resolveLadder } from "../src/tutorial/anchors";
import { CHAPTERS } from "../src/tutorial/chapters";
import { annotationCountSource } from "../src/tutorial/chapters/reading";
import { watchSources } from "../src/tutorial/l2";
import { SAMPLE_ANNOTATION_IDS, SAMPLE_DOC_ID, SAMPLE_SEED_BIBCODE, SAMPLE_TEXT_ANNOTATION_BLOCK, SAMPLE_WORK_IDS } from "../src/tutorial/sample-ids";
import type { GateRun, StepDefinition, WorkbenchSnapshot } from "../src/tutorial/types";
import { fakePage, fakeSnapshot } from "./tutorial-fixtures";

// in-app-tutorial ticket 21: chapters 3 (reading and annotating) and 4 (exploring literature) against fake snapshots,
// the L2 source of step 3.5 against a fake ws bus, and the sample bibcode the chapter-4 gate names. Chapter 4 runs on
// live ADS results (user ruling 2026-10-21: the sample ships no ADS cache): no gate names a node or a count.

const step = (id: string): StepDefinition => {
  for (const c of CHAPTERS) for (const s of c.steps) if (s.id === id) return s;
  throw new Error(id);
};
const runOf = (baseline: WorkbenchSnapshot): GateRun => ({ baseline, memo: {} });
const holds = (id: string, s: WorkbenchSnapshot, run = runOf(s)) => step(id).gate!(s, run);

/** A snapshot whose page has the given view and page fields (reader, library, discovery...). */
const at = (view: string, fields: Partial<PageContext> = {}, over: Partial<WorkbenchSnapshot> = {}): WorkbenchSnapshot => ({
  ...fakeSnapshot({ view }),
  page: { ...fakePage(view), ...fields } as PageContext,
  ...over,
});

/** The reader page of a Doc, as the reader publishes it (only what the tutorial looks at is meaningful). */
const reader = (docId: string, o: { section?: string | null; open?: string | null; position?: boolean; measured?: boolean } = {}) =>
  ({
    docId,
    format: "latex",
    sync: { phase: "ready" },
    reading: null,
    position: o.position === false ? null : { activeSectionId: o.section ?? null, visibleBlockIds: o.measured === false ? [] : ["p-1"] },
    selection: null,
    openAnnotationId: o.open ?? null,
    panels: { outlineCollapsed: false, rightCollapsed: false, rightTab: "references" },
    canGoBack: false,
  }) as unknown as PageContext["reader"];
const inReader = (o: Parameters<typeof reader>[1] = {}, docId = SAMPLE_DOC_ID) => at("doc", { reader: reader(docId, o) });

/** The exploration page: a loaded graph for a seed, or a failed request (no graph). */
const discovery = (o: { seed?: string; failed?: number; display?: "graph" | "list"; selected?: string | null } = {}) =>
  ({
    history: { index: 0, seeds: [o.seed ?? SAMPLE_SEED_BIBCODE] },
    graph:
      o.failed !== undefined
        ? null
        : { provider: "ads", seed: o.seed ?? SAMPLE_SEED_BIBCODE, filter: "all", query: "", nodes: [], edges: [], totals: { nodes: 25, related: 18, useful: 6, saved: 2 }, warnings: [], empty: false },
    display: o.display ?? "graph",
    selectedBibcode: o.selected ?? null,
    detail: null,
    loading: null,
    error: o.failed !== undefined ? { seed: o.seed ?? SAMPLE_SEED_BIBCODE, status: o.failed } : null,
    saving: { adding: null, failed: null },
    graphView: { labelsOn: false },
  }) as unknown as PageContext["discovery"];
const exploring = (o: Parameters<typeof discovery>[0] = {}) => at("library", { library: null, discovery: discovery(o) });

describe("chapters 3 and 4 are registered in order, with stable ids", () => {
  it("chapter 3 `reading` and chapter 4 `discovery` follow appendix A step for step", () => {
    const ids = (id: string) => CHAPTERS.find((c) => c.id === id)!.steps.map((s) => s.id);
    expect(CHAPTERS.find((c) => c.id === "reading")!.n).toBe(3);
    expect(CHAPTERS.find((c) => c.id === "discovery")!.n).toBe(4);
    expect(ids("reading")).toEqual(["reading.open", "reading.outline", "reading.annotations", "reading.open-annotation", "reading.annotate", "reading.manage", "reading.switch-doc", "reading.agent"]);
    expect(ids("discovery")).toEqual(["discovery.library-graph", "discovery.start", "discovery.roles", "discovery.graph", "discovery.detail", "discovery.back", "discovery.agent"]);
    const order = CHAPTERS.map((c) => c.id);
    expect(order.indexOf("reading")).toBeLessThan(order.indexOf("discovery"));
  });
  it("look steps and agent cards have no gate; each chapter ends with its agent card; nothing needs TeX", () => {
    for (const id of ["reading.annotations", "reading.manage", "reading.switch-doc", "discovery.library-graph", "discovery.roles", "discovery.back"]) {
      expect(step(id).kind).toBe("look");
      expect(step(id).gate).toBeUndefined();
    }
    for (const id of ["reading.agent", "discovery.agent"]) {
      expect(step(id).kind).toBe("agent");
      expect(step(id).gate).toBeUndefined();
      expect(step(id).anchors).toEqual([]);
    }
    for (const c of ["reading", "discovery"]) for (const s of CHAPTERS.find((x) => x.id === c)!.steps) expect(s.needsTex).toBeFalsy();
  });
});

describe("chapter 3 gates and requirements (fake snapshots)", () => {
  it("3.1 passes when the active pane's reader shows Jerabkova's main Doc (L1), not another Doc nor the library", () => {
    expect(holds("reading.open", inReader())).toBe(true);
    expect(holds("reading.open", inReader({}, "arxiv-2202.06973"))).toBe(false);
    expect(holds("reading.open", at("library"))).toBe(false);
    // The view says doc but no reader is published (a PDF, a text Doc): not passed.
    expect(holds("reading.open", at("doc"))).toBe(false);
    expect(step("reading.open").requires).toBeUndefined();
  });
  it("3.1's ladder: the Jerabkova row, its detail's open button (inside its own detail), the reader of its Doc", () => {
    expect(step("reading.open").anchors.map((a) => [a.ui, a.key ?? null, a.within?.ui ?? null, a.within?.key ?? null])).toEqual([
      ["work-item", SAMPLE_WORK_IDS.jerabkova2021, null, null],
      ["open-main-doc-or-acquisition", null, "work-detail", SAMPLE_WORK_IDS.jerabkova2021],
      ["latex-reader", SAMPLE_DOC_ID, null, null],
    ]);
  });
  it("3.2 is a process gate: the reading section differs from the one first seen in Jerabkova's reader", () => {
    const start = inReader({ section: "sec-1" });
    const run = runOf(start);
    expect(holds("reading.outline", start, run)).toBe(false);
    expect(holds("reading.outline", inReader({ section: "sec-1" }), run)).toBe(false);
    expect(holds("reading.outline", inReader({ section: "sec-7" }), run)).toBe(true);
  });
  it("3.2 from the top of the document (no section yet) passes once a section is reached", () => {
    const start = inReader({ section: null });
    const run = runOf(start);
    expect(holds("reading.outline", start, run)).toBe(false);
    expect(holds("reading.outline", inReader({ section: "sec-3" }), run)).toBe(true);
  });
  it("3.2 started away from the reader takes its baseline when Jerabkova's reader is first seen (opening it is not a jump)", () => {
    const start = at("library");
    const run = runOf(start);
    expect(holds("reading.outline", start, run)).toBe(false);
    expect(holds("reading.outline", inReader({ position: false }), run)).toBe(false);
    expect(holds("reading.outline", inReader({ section: "sec-1" }), run)).toBe(false);
    expect(holds("reading.outline", inReader({ section: "sec-2" }), run)).toBe(true);
    // Right after opening, the reader reports no section before it has measured its visible blocks: not the baseline.
    const opening = runOf(at("library"));
    expect(holds("reading.outline", inReader({ section: null, measured: false }), opening)).toBe(false);
    expect(holds("reading.outline", inReader({ section: "sec-1" }), opening)).toBe(false);
    expect(holds("reading.outline", inReader({ section: "sec-4" }), opening)).toBe(true);
    // Another Doc's sections never count.
    const other = runOf(inReader({ section: "sec-1" }));
    expect(holds("reading.outline", inReader({ section: "sec-9" }, "arxiv-2202.06973"), other)).toBe(false);
  });
  it("3.2's ladder: the toolbar, the outline toggle, and the open outline panel only while it is open", () => {
    const ladder = step("reading.outline").anchors;
    expect(ladder.map((a) => a.ui)).toEqual(["latex-toolbar", "toggle-latex-outline", "latex-outline-panel"]);
    const panels = (outlineCollapsed: boolean) => at("doc", { reader: { ...(reader(SAMPLE_DOC_ID) as object), panels: { outlineCollapsed, rightCollapsed: false, rightTab: "references" } } as PageContext["reader"] });
    expect(activeRungs(ladder, panels(false)).map((a) => a.ui)).toContain("latex-outline-panel");
    expect(activeRungs(ladder, panels(true)).map((a) => a.ui)).not.toContain("latex-outline-panel");
    expect(activeRungs(ladder, at("library")).map((a) => a.ui)).not.toContain("latex-outline-panel");
  });
  it("3.2-3.7 require Jerabkova's reader; take-me-there opens its Doc through the registered open_doc action", () => {
    for (const id of ["reading.outline", "reading.annotations", "reading.open-annotation", "reading.annotate", "reading.manage", "reading.switch-doc"]) {
      const r = step(id).requires!;
      expect(r.test(inReader())).toBe(true);
      expect(r.test(inReader({}, "arxiv-2202.06973"))).toBe(false);
      expect(r.test(at("library"))).toBe(false);
      expect(r.where).toBe("reader");
      expect(r.whereValues).toEqual({ work: "Jerabkova 2021" });
      expect(r.takeMeThere).toEqual({ action: "open_doc", docId: SAMPLE_DOC_ID });
    }
    expect(step("reading.agent").requires).toBeUndefined();
  });
  it("3.4 passes while an annotation's popover is open (L1 openAnnotationId), and its anchor is the preset text annotation", () => {
    expect(holds("reading.open-annotation", inReader({ open: SAMPLE_ANNOTATION_IDS.figure }))).toBe(true);
    expect(holds("reading.open-annotation", inReader({ open: null }))).toBe(false);
    expect(holds("reading.open-annotation", at("library"))).toBe(false);
    const ladder = step("reading.open-annotation").anchors;
    expect(ladder.find((a) => a.ui === "latex-annotation")?.key).toBe(SAMPLE_ANNOTATION_IDS.text);
    expect(ladder[ladder.length - 1]!.ui).toBe("latex-annotation-popover");
  });
  it("3.4's ladder climbs from the panel toggle and the annotations tab to the annotation and its popover (happy-dom)", () => {
    const ladder = step("reading.open-annotation").anchors;
    const top = () => resolveLadder(document, ladder, 1)?.anchor.ui ?? null;
    document.body.innerHTML = `<button data-ui="toggle-latex-right-panel"></button>`;
    expect(top()).toBe("toggle-latex-right-panel");
    document.body.insertAdjacentHTML("beforeend", `<button data-ui="show-annotations"></button>`);
    expect(top()).toBe("show-annotations");
    document.body.insertAdjacentHTML("beforeend", `<div data-ui="latex-annotation" data-ui-key="${SAMPLE_ANNOTATION_IDS.text}"></div>`);
    expect(top()).toBe("latex-annotation");
    document.body.insertAdjacentHTML("beforeend", `<div data-ui="latex-annotation-popover"></div>`);
    expect(top()).toBe("latex-annotation-popover");
    document.body.innerHTML = "";
  });
  it("3.4 (user ruling F1): once the annotated block is in view, the text-annotation count in its gutter is the rung above the list entry", () => {
    const ladder = step("reading.open-annotation").anchors;
    const count = ladder.find((a) => a.ui === "latex-text-annotation-count");
    expect(count?.within).toEqual({ ui: "latex-annotation-gutter", key: SAMPLE_TEXT_ANNOTATION_BLOCK });
    const uis = ladder.map((a) => a.ui);
    expect(uis.indexOf("latex-text-annotation-count")).toBeGreaterThan(uis.indexOf("latex-annotation"));
    expect(uis.indexOf("latex-text-annotation-count")).toBeLessThan(uis.indexOf("latex-annotation-popover"));
    const shown = (blocks: string[]) =>
      at("doc", { reader: { ...reader(SAMPLE_DOC_ID), position: { activeSectionId: "s-3", visibleBlockIds: blocks } } as PageContext["reader"] });
    expect(activeRungs(ladder, shown(["p-1", SAMPLE_TEXT_ANNOTATION_BLOCK])).map((a) => a.ui)).toContain("latex-text-annotation-count");
    expect(activeRungs(ladder, shown(["p-1"])).map((a) => a.ui)).not.toContain("latex-text-annotation-count");
    const rungs = activeRungs(ladder, shown([SAMPLE_TEXT_ANNOTATION_BLOCK]));
    document.body.innerHTML = `<button data-ui="toggle-latex-right-panel"></button><button data-ui="show-annotations"></button>
      <div data-ui="latex-annotation" data-ui-key="${SAMPLE_ANNOTATION_IDS.text}"></div>
      <span data-ui="latex-annotation-gutter" data-ui-key="p-9"><button data-ui="latex-text-annotation-count"></button></span>
      <span data-ui="latex-annotation-gutter" data-ui-key="${SAMPLE_TEXT_ANNOTATION_BLOCK}"><button data-ui="latex-text-annotation-count" id="mine"></button></span>`;
    expect(resolveLadder(document, rungs, 1)?.element.id).toBe("mine");
    document.body.innerHTML = "";
  });
  it("3.5 passes once the annotation count read back is at least the step's own first read + 1 (L2)", () => {
    const s = step("reading.annotate");
    expect(s.sources?.map((x) => x.id)).toEqual(["annotations"]);
    const base = inReader({}, SAMPLE_DOC_ID);
    const start = { ...base, data: { annotations: 3 } };
    const run = runOf(start);
    expect(holds("reading.annotate", start, run)).toBe(false);
    expect(holds("reading.annotate", { ...base, data: { annotations: 3 } }, run)).toBe(false);
    expect(holds("reading.annotate", { ...base, data: { annotations: 4 } }, run)).toBe(true);
    expect(holds("reading.annotate", { ...base, data: { annotations: 6 } }, run)).toBe(true);
    // No read yet (or a failed one): never passes.
    expect(holds("reading.annotate", { ...base, data: {} }, runOf({ ...base, data: {} }))).toBe(false);
    expect(s.preparedCopy).toBe(true);
    expect(s.anchors.map((a) => a.ui)).toEqual(["latex-reader", "latex-selection-tools", "annotate-selected-text", "latex-annotation-editor"]);
    expect(s.anchors[0]!.key).toBe(SAMPLE_DOC_ID);
  });
  it("3.7's ladder: the reader toolbar, then the Doc switcher once the Work has several Docs", () => {
    expect(step("reading.switch-doc").anchors.map((a) => a.ui)).toEqual(["latex-toolbar", "switch-doc"]);
  });
});

describe("chapter 3's L2 source: annotation.changed of Jerabkova's Doc → GET the annotation list (fake ws bus)", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const file = (n: number) => ({ ok: true as const, file: { annotations: Array.from({ length: n }, (_, i) => ({ id: `a${i}` })) } as unknown as AnnotationsFile });

  it("reads once at the start, again on the Doc's own event only, and stops when the step is left", async () => {
    const bus = createFakeBus();
    let n = 3;
    const fetch = vi.fn(async (docId: string) => {
      expect(docId).toBe(SAMPLE_DOC_ID);
      return file(n);
    });
    const source = annotationCountSource({ onChanged: (cb) => bus.on("annotation.changed", (m) => cb(m.doc_id)), fetch });
    const seen: unknown[] = [];
    const stop = watchSources([source], (id, v) => seen.push([id, v]));
    await flush();
    expect(seen).toEqual([["annotations", 3]]);
    n = 4;
    bus.emit("annotation.changed", { type: "annotation.changed", doc_id: "arxiv-2202.06973", cause: "put" } as never);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    bus.emit("annotation.changed", { type: "annotation.changed", doc_id: SAMPLE_DOC_ID, cause: "put" } as never);
    await flush();
    expect(seen).toEqual([["annotations", 3], ["annotations", 4]]);
    stop();
    bus.emit("annotation.changed", { type: "annotation.changed", doc_id: SAMPLE_DOC_ID, cause: "put" } as never);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("a failed read gives no count (the gate keeps waiting) and is not retried until the next event", async () => {
    const bus = createFakeBus();
    const fetch = vi.fn().mockResolvedValueOnce({ ok: false, missing: false, status: 500 }).mockResolvedValue(file(5));
    const source = annotationCountSource({ onChanged: (cb) => bus.on("annotation.changed", (m) => cb(m.doc_id)), fetch });
    const seen: unknown[] = [];
    const stop = watchSources([source], (_id, v) => seen.push(v));
    await flush();
    expect(seen).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    bus.emit("annotation.changed", { type: "annotation.changed", doc_id: SAMPLE_DOC_ID, cause: "external" } as never);
    await flush();
    expect(seen).toEqual([5]);
    stop();
  });
});

describe("chapter 4 gates and requirements (fake snapshots)", () => {
  it("4.1 and 4.2 require the library; take-me-there switches the active pane to it", () => {
    for (const id of ["discovery.library-graph", "discovery.start", "discovery.roles", "discovery.graph", "discovery.detail", "discovery.back"]) {
      const r = step(id).requires!;
      expect(r.test(at("library"))).toBe(true);
      expect(r.test(exploring())).toBe(true);
      expect(r.test(at("plan"))).toBe(false);
      expect(r.where).toBe("library");
      expect(r.takeMeThere).toEqual({ action: "switch_view", view: "library" });
    }
    expect(step("discovery.agent").requires).toBeUndefined();
  });
  it("4.2 passes when the exploration from Röser 2019 has its graph (L1), not before, not for another seed", () => {
    expect(holds("discovery.start", exploring())).toBe(true);
    expect(holds("discovery.start", at("library"))).toBe(false);
    expect(holds("discovery.start", exploring({ seed: "2021A&A...647A.137J" }))).toBe(false);
  });
  it("without results (no ADS token: the explore GET fails, the page shows its error, no graph) 4.2, 4.4 and 4.5 never pass", () => {
    for (const failed of [503, 401, 0]) {
      expect(holds("discovery.start", exploring({ failed }))).toBe(false);
      // a failed exploration still reports the default graph display, and nothing can be selected
      expect(holds("discovery.graph", exploring({ failed, display: "graph" }))).toBe(false);
      expect(holds("discovery.detail", exploring({ failed, selected: SAMPLE_SEED_BIBCODE }))).toBe(false);
    }
  });
  it("4.2's ladder: the Röser row, its detail's explore button (inside its own detail), the exploration page", () => {
    expect(step("discovery.start").anchors.map((a) => [a.ui, a.key ?? null, a.within?.ui ?? null, a.within?.key ?? null])).toEqual([
      ["work-item", SAMPLE_WORK_IDS.roser2019, null, null],
      ["explore-from-work", null, "work-detail", SAMPLE_WORK_IDS.roser2019],
      ["discovery-view", null, null, null],
    ]);
  });
  it("4.4 passes on the graph display (L1 discovery.display)", () => {
    expect(holds("discovery.graph", exploring({ display: "graph" }))).toBe(true);
    expect(holds("discovery.graph", exploring({ display: "list" }))).toBe(false);
    expect(holds("discovery.graph", at("library"))).toBe(false);
  });
  it("4.5 passes once a candidate is open (L1 discovery.selectedBibcode), not the seed the exploration opens with", () => {
    expect(holds("discovery.detail", exploring({ selected: "2019A&A...621L...3M" }))).toBe(true);
    expect(holds("discovery.detail", exploring({ selected: null }))).toBe(false);
    expect(holds("discovery.detail", exploring({ selected: SAMPLE_SEED_BIBCODE }))).toBe(false);
    expect(holds("discovery.detail", at("library"))).toBe(false);
  });
  it("the graph rungs are the canvas inside their own page (the library's, the exploration's), never the other one", () => {
    expect(step("discovery.library-graph").anchors.map((a) => [a.ui, a.within?.ui ?? null])).toEqual([["library-graph-area", null], ["graph-canvas", "library-graph-area"]]);
    expect(step("discovery.graph").anchors.map((a) => [a.ui, a.within?.ui ?? null])).toEqual([["resume-exploration", null], ["show-discovery-graph", null], ["graph-canvas", "discovery-main"]]);
  });
  it("4.3-4.5 start from \"Resume exploration\" when the exploration was left; 4.6 points there after \"Back to library\"", () => {
    for (const id of ["discovery.roles", "discovery.graph", "discovery.detail"]) expect(step(id).anchors[0]!.ui).toBe("resume-exploration");
    expect(step("discovery.back").anchors.map((a) => a.ui)).toEqual(["return-to-library", "resume-exploration"]);
  });
});

describe("the sample bibcode chapter 4 names is Röser 2019's in tutorial-sample/", () => {
  it("SAMPLE_SEED_BIBCODE is the bibcode of the Röser 2019 Work of the sample library", () => {
    const lib = join(fileURLToPath(new NodeURL("../../../tutorial-sample", import.meta.url)), "literatures", "library", "library.json");
    const works: { id: string; bibcode?: string }[] = JSON.parse(readFileSync(lib, "utf8")).works;
    expect(works.find((w) => w.id === SAMPLE_WORK_IDS.roser2019)?.bibcode).toBe(SAMPLE_SEED_BIBCODE);
  });
});
