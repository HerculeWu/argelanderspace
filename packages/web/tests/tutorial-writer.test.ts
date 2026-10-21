/**
 * Chapter 7 "writer" (in-app-tutorial ticket 23): its gates and requirements against fake snapshots, its anchors'
 * qualification, and the sample data it relies on (the review manuscript, Kroupa 2022's cite key).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { BUILTIN_WRITER_TEMPLATES, type PageContext } from "@argelanderspace/contracts";
import { describe, expect, it } from "vitest";
import { CHAPTERS } from "../src/tutorial/chapters";
import { WRITER } from "../src/tutorial/chapters/writer";
import { SAMPLE_CELL_IDS, SAMPLE_CITE_KEYS, SAMPLE_LAST_CELL_ID, SAMPLE_MANUSCRIPT_ID, SAMPLE_WORK_IDS } from "../src/tutorial/sample-ids";
import type { GateRun, StepDefinition, WorkbenchSnapshot } from "../src/tutorial/types";
import { fakePage, fakeSnapshot } from "./tutorial-fixtures";

const KEY = SAMPLE_CITE_KEYS.kroupa2022;
const step = (id: string): StepDefinition => {
  const found = WRITER.steps.find((s) => s.id === id);
  if (!found) throw new Error(id);
  return found;
};
const runOf = (baseline: WorkbenchSnapshot): GateRun => ({ baseline, memo: {} });

interface Cell {
  id: string;
  type: string;
  data: Record<string, unknown>;
}
const PRESET: Cell[] = SAMPLE_CELL_IDS.map((id, i) => ({ id, type: "latex", data: { source: i === SAMPLE_CELL_IDS.length - 1 ? `\\citet{${KEY}} found…` : "text" } }));
interface EditorOver {
  manuscriptId?: string;
  phase?: "loading" | "ready" | "missing";
  cells?: Cell[];
  editingCellId?: string | null;
  preview?: { status: "never" | "ok" | "stale" | "unknown"; failed: boolean; warnings: number; rendering: boolean };
}
/** A snapshot of the Writer page: the list, or the editor of a manuscript (the sample's by default). */
function writerSnapshot(over: EditorOver | "list" = {}, view = "write"): WorkbenchSnapshot {
  const page = fakePage(view) as unknown as Record<string, unknown>;
  if (over === "list") page.writer = { mode: "list", list: { phase: "ready", manuscripts: [], templates: [] }, editor: null };
  else {
    const id = over.manuscriptId ?? SAMPLE_MANUSCRIPT_ID;
    const phase = over.phase ?? "ready";
    page.writer = {
      mode: "editor",
      list: null,
      editor: {
        manuscriptId: id,
        phase,
        saved: phase === "ready" ? { version: 1, id, rev: 1, template: "report", cells: over.cells ?? PRESET, comments: [] } : null,
        saveState: "saved",
        draft: null,
        template: null,
        unsupportedCellIds: [],
        activeCellId: null,
        editingCellId: over.editingCellId ?? null,
        caret: null,
        modal: null,
        preview: over.preview ?? { status: "never", failed: false, warnings: 0, rendering: false },
      },
    };
  }
  return fakeSnapshot({ page: page as unknown as PageContext });
}
const added = (id: string, source: string): Cell => ({ id, type: "latex", data: { source } });

describe("chapter 7 is registered after the earlier chapters and before the finish page", () => {
  it("its steps, in the order of appendix A", () => {
    expect(WRITER.id).toBe("writer");
    expect(WRITER.n).toBe(7);
    expect(WRITER.steps.map((s) => s.id)).toEqual(["writer.open", "writer.structure", "writer.add-cell", "writer.cite", "writer.render", "writer.export", "writer.agent"]);
    const ids = CHAPTERS.map((c) => c.id);
    expect(ids).toContain("writer");
    expect(ids[ids.length - 1]).toBe("finish");
    expect(ids.indexOf("writer")).toBeLessThan(ids.indexOf("finish"));
  });
  it("7.1 climbs from the navigation to the sample manuscript's row and its editor", () => {
    expect(step("writer.open").anchors.map((a) => [a.ui, a.key])).toEqual([
      ["navigate-view", "write"],
      ["manuscript-item", SAMPLE_MANUSCRIPT_ID],
      ["manuscript-editor", SAMPLE_MANUSCRIPT_ID],
    ]);
  });
  it("7.3 starts at the add button under the last preset cell (the button has no key of its own)", () => {
    const first = step("writer.add-cell").anchors[0]!;
    expect(first).toMatchObject({ ui: "add-cell-after", within: { ui: "manuscript-cell", key: SAMPLE_LAST_CELL_ID } });
    expect(step("writer.add-cell").anchors.map((a) => a.ui)).toEqual(["add-cell-after", "add-cell-menu", "add-cell-type", "cell-field", "commit-cell"]);
    expect(step("writer.add-cell").anchors[2]).toMatchObject({ key: "latex" });
    expect(step("writer.add-cell").preparedCopy).toBe(true);
  });
  it("7.4 ends at Kroupa 2022's insert button (inside its reference card)", () => {
    const ladder = step("writer.cite").anchors;
    expect(ladder.map((a) => a.ui)).toEqual(["toggle-writer-reference-panel", "writer-references", "search-writer-references", "insert-cite-key"]);
    expect(ladder[3]).toMatchObject({ within: { ui: "writer-reference", key: SAMPLE_WORK_IDS.kroupa2022 } });
  });
  it("7.5 needs TeX; 7.6 is a look step; 7.A is the agent card without anchor", () => {
    expect(step("writer.render").needsTex).toBe(true);
    expect(step("writer.render").anchors[0]).toMatchObject({ ui: "render-manuscript" });
    // The preview rung applies only once the render is current (before, an earlier render's previews are stale).
    const preview = step("writer.render").anchors[1]!;
    expect(preview).toMatchObject({ ui: "cell-preview", within: { ui: "manuscript-cell", key: SAMPLE_LAST_CELL_ID } });
    expect(preview.when!(writerSnapshot({ preview: { status: "stale", failed: false, warnings: 0, rendering: false } }))).toBe(false);
    expect(preview.when!(writerSnapshot({ preview: { status: "ok", failed: false, warnings: 0, rendering: false } }))).toBe(true);
    expect(step("writer.export").gate).toBeUndefined();
    expect(step("writer.export").anchors.map((a) => a.ui)).toEqual(["export-manuscript"]);
    expect(step("writer.agent").kind).toBe("agent");
    expect(step("writer.agent").anchors).toEqual([]);
    expect(step("writer.structure").gate).toBeUndefined();
  });
});

describe("chapter 7 gates against fake snapshots", () => {
  it("7.1 passes once the sample manuscript is open and loaded in the editor (L1)", () => {
    const gate = step("writer.open").gate!;
    const ok = writerSnapshot();
    expect(gate(ok, runOf(ok))).toBe(true);
    for (const s of [writerSnapshot("list"), writerSnapshot({ phase: "loading" }), writerSnapshot({ manuscriptId: "m_00000000" }), fakeSnapshot({ view: "write" }), fakeSnapshot({ view: "library" })])
      expect(gate(s, runOf(s))).toBe(false);
  });

  it("7.3 counts from the cells at the step's start: one more saved cell, with text, no longer being edited", () => {
    const gate = step("writer.add-cell").gate!;
    const start = writerSnapshot();
    const run = runOf(start);
    expect(gate(start, run)).toBe(false);
    // The menu's LaTeX choice saves an empty cell at once: not yet.
    expect(gate(writerSnapshot({ cells: [...PRESET, added("c_new00001", "")], editingCellId: "c_new00001" }), run)).toBe(false);
    // Pasted, still in the editing form: not yet.
    expect(gate(writerSnapshot({ cells: [...PRESET, added("c_new00001", "Two tails")], editingCellId: "c_new00001" }), run)).toBe(false);
    // Shift+Enter: the form closes; the saved cell has the paragraph.
    expect(gate(writerSnapshot({ cells: [...PRESET, added("c_new00001", "Two tails")] }), run)).toBe(true);
  });
  it("7.3: a cell that was already there at the start does not count; removing one and adding one is not +1", () => {
    const gate = step("writer.add-cell").gate!;
    const withOld = [...PRESET, added("c_old00001", "an earlier paragraph")];
    const start = writerSnapshot({ cells: withOld });
    const run = runOf(start);
    expect(gate(start, run)).toBe(false);
    expect(gate(writerSnapshot({ cells: [...PRESET, added("c_new00002", "new")] }), run)).toBe(false);
    expect(gate(writerSnapshot({ cells: [...withOld, added("c_new00002", "new")] }), run)).toBe(true);
  });
  it("7.3: arriving away from the editor, the count starts when the editor is first seen in this showing", () => {
    const gate = step("writer.add-cell").gate!;
    const away = fakeSnapshot({ view: "library" });
    const run = runOf(away);
    expect(gate(away, run)).toBe(false);
    expect(gate(writerSnapshot(), run)).toBe(false);
    expect(gate(writerSnapshot({ cells: [...PRESET, added("c_new00003", "x")] }), run)).toBe(true);
  });

  it("7.4 passes when the saved manuscript has Kroupa 2022's key in a cell of the user's (the preset paragraph already cites it)", () => {
    const gate = step("writer.cite").gate!;
    const start = writerSnapshot({ cells: [...PRESET, added("c_new00001", "Kroupa et al. (2022) \\citet{} argue")] });
    const run = runOf(start);
    expect(gate(start, run)).toBe(false);
    expect(gate(writerSnapshot({ cells: [...PRESET, added("c_new00001", `\\citet{${KEY}} argue`)] }), run)).toBe(true);
  });
  it("7.4 also passes when the key is added to a preset cell (one more occurrence than at the start)", () => {
    const gate = step("writer.cite").gate!;
    const start = writerSnapshot();
    const run = runOf(start);
    expect(gate(start, run)).toBe(false);
    const more = PRESET.map((c) => (c.id === SAMPLE_CELL_IDS[1] ? { ...c, data: { source: `see \\cite{${KEY}}` } } : c));
    expect(gate(writerSnapshot({ cells: more }), run)).toBe(true);
  });
  it("7.4 resumed after the key went in: passes at once (the user's cell holds it)", () => {
    const gate = step("writer.cite").gate!;
    const done = writerSnapshot({ cells: [...PRESET, added("c_new00001", `\\citet{${KEY}}`)] });
    expect(gate(done, runOf(done))).toBe(true);
  });

  it("7.5 passes on a finished render that is current (L1 preview state), not while rendering or after a failure", () => {
    const gate = step("writer.render").gate!;
    const at = (preview: NonNullable<EditorOver["preview"]>) => {
      const s = writerSnapshot({ preview });
      return gate(s, runOf(s));
    };
    expect(at({ status: "ok", failed: false, warnings: 0, rendering: false })).toBe(true);
    expect(at({ status: "ok", failed: false, warnings: 3, rendering: false })).toBe(true);
    expect(at({ status: "never", failed: false, warnings: 0, rendering: false })).toBe(false);
    expect(at({ status: "stale", failed: false, warnings: 0, rendering: false })).toBe(false);
    expect(at({ status: "ok", failed: false, warnings: 0, rendering: true })).toBe(false);
    expect(at({ status: "stale", failed: true, warnings: 0, rendering: false })).toBe(false);
    expect(at({ status: "unknown", failed: false, warnings: 0, rendering: false })).toBe(false);
    const list = writerSnapshot("list");
    expect(gate(list, runOf(list))).toBe(false);
  });
});

describe("chapter 7 requirements", () => {
  it("7.2-7.6 need the sample manuscript open; 'take me there' opens it through the Writer's registered action", () => {
    for (const id of ["writer.structure", "writer.add-cell", "writer.cite", "writer.render", "writer.export"]) {
      const r = step(id).requires!;
      expect(r.where).toBe("writer");
      expect(r.takeMeThere).toEqual({ action: "open_manuscript", manuscriptId: SAMPLE_MANUSCRIPT_ID });
      expect(r.test(writerSnapshot())).toBe(true);
      expect(r.test(writerSnapshot("list"))).toBe(false);
      expect(r.test(writerSnapshot({ manuscriptId: "m_00000000" }))).toBe(false);
      expect(r.test(fakeSnapshot({ view: "plan" }))).toBe(false);
    }
  });
  it("7.1 and 7.A have no requirement", () => {
    expect(step("writer.open").requires).toBeUndefined();
    expect(step("writer.agent").requires).toBeUndefined();
  });
});

describe("the sample data chapter 7 relies on", () => {
  const SAMPLE = fileURLToPath(new NodeURL("../../../tutorial-sample", import.meta.url));
  const LIT = join(SAMPLE, "literatures");
  const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
  it("Kroupa 2022's cite key is that Work's cite key in the sample library", () => {
    const works: { id: string; cite_key?: string }[] = json(join(LIT, "library", "library.json")).works;
    expect(works.find((w) => w.id === SAMPLE_WORK_IDS.kroupa2022)?.cite_key).toBe(KEY);
  });
  it("the review manuscript uses the report template, whose cell types are LaTeX, figure, table, code (no abstract type)", () => {
    const m = json(join(LIT, "manuscripts", SAMPLE_MANUSCRIPT_ID, "manuscript.json"));
    expect(m.template).toBe("report");
    expect(m.cells.every((c: { type: string }) => c.type === "latex")).toBe(true);
    expect(String(m.cells[0].data.source)).toContain("\\begin{abstract}");
    expect(BUILTIN_WRITER_TEMPLATES.find((t) => t.id === "report")?.types).toEqual(["latex", "figure", "table", "code"]);
  });
});
