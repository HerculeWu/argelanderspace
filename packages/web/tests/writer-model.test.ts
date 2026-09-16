/** Writer model tests. Rendering/IME now have dedicated IR/CodeMirror tests,
 * not tests of the retired regex renderer and textarea overlay. */
import { describe, expect, it } from "vitest";
import { CellSchema, type WriterCell, type WriterNumberingFacts } from "@argelanderspace/contracts";
import { applyNumbering, convertCellData, deriveCrossrefs, fileSlug, floatNumber, newCellId, newCommentId, newManuscriptId, randomLabel, slug, withEnsuredLabel } from "../src/writer/model";
const cell = (id: string, type: string, data: Record<string, unknown>): WriterCell => CellSchema.parse({ id, type, data });

it("generates stable-shape ids and filenames", () => {
  expect(newManuscriptId()).toMatch(/^m_[0-9a-f]{8}$/);
  expect(newCellId()).toMatch(/^c_[0-9a-f]{8}$/);
  expect(newCommentId()).toMatch(/^cm_[0-9a-f]{8}$/);
  expect(randomLabel()).toMatch(/^ref:[a-z0-9]{6}$/);
  expect(slug("Additional validation")).toBe("additional-validation");
  expect(slug("  3D–Plots! ")).toBe("3d-plots");
  expect(slug("---")).toBe("section");
  expect(fileSlug("")).toBe("manuscript");
});

describe("crossref source targets (not printed numbers)", () => {
  const cells = [
    cell("c_00000001", "latex", { source: "\\chapter{First}\\label{ch:first}\n\\section{Intro}\\label{sec:intro}\n\\subsection{Method}\nText." }),
    cell("c_00000002", "figure", { caption: "Rotation curve", label: "fig:rc" }),
    cell("c_00000003", "table", { caption: "Constraints", label: "" }),
    cell("c_00000004", "code", { caption: "Likelihood", label: "lst:l" }),
  ];
  it("keeps all heading targets in a cell and distinguishes their insertion positions", () => {
    const xs = deriveCrossrefs(cells);
    expect(xs.map((x) => x.kind)).toEqual(["section", "section", "section", "figure", "table", "code"]);
    expect(xs[0]).toMatchObject({ label: "ch:first", generated: false, sectionIndex: 0 });
    expect(xs[1]).toMatchObject({ label: "sec:intro", generated: false, sectionIndex: 1 });
    expect(xs[2]).toMatchObject({ label: "sec:method", generated: true, sectionIndex: 2 });
  });
  it("does not display locally counted placeholder numbers as compile truth", () => {
    expect(applyNumbering(deriveCrossrefs(cells), null).every((x) => x.number === "?")).toBe(true);
  });
  it("uses compiled sections and floats rather than same-kind cell order", () => {
    const facts: WriterNumberingFacts = { sections: [
      { number: "2", title: "First", label: "ch:first", cell: cells[0]!.id },
      { number: "2.3", title: "Intro", label: "sec:intro", cell: cells[0]!.id },
      { number: "2.3.1", title: "Method", label: null, cell: cells[0]!.id },
    ], equations: [], floats: [{ cell: cells[1]!.id, kind: "figure", number: "2.7" }], labels: {} };
    expect(applyNumbering(deriveCrossrefs(cells), facts).map((x) => x.number)).toEqual(["2", "2.3", "2.3.1", "2.7", "?", "?"]);
    expect(floatNumber(cells, cells[1]!.id)).toBe(1); // helper is an ordinal, not display truth
  });
  it("inserts a missing label on the selected heading, not at the cell end", () => {
    const updated = withEnsuredLabel(cells[0]!, "sec:method", undefined, 2);
    expect(updated.data.source).toContain("\\subsection{Method}\\label{sec:method}\nText.");
    expect(withEnsuredLabel(cells[0]!, "wrong", undefined, 0)).toBe(cells[0]);
  });
});

describe("equation targets", () => {
  const one = cell("c_00000030", "latex", { source: "\\begin{equation}v=1\\label{eq:v}\\end{equation}\n\\begin{equation*}x=0\\end{equation*}" });
  const two = cell("c_00000031", "latex", { source: "\\begin{align}\n a &= b \\\\\n c &= d\n\\end{align}" });
  it("indexes numbered environments and does not invent starred targets", () => {
    const xs = deriveCrossrefs([one, two]);
    expect(xs).toHaveLength(2);
    expect(xs[0]).toMatchObject({ label: "eq:v", generated: false, envIndex: 0 });
    expect(xs[1]).toMatchObject({ generated: true, envIndex: 0 });
  });
  it("inserts into the requested environment and keeps existing labels", () => {
    expect(withEnsuredLabel(two, "eq:new", 0).data.source).toContain("\\begin{align}\n  \\label{eq:new}");
    expect(withEnsuredLabel(one, "wrong", 0)).toBe(one);
  });
  it("uses aux truth for a labeled row and ignores unnumbered environments in ordinal matching", () => {
    const facts: WriterNumberingFacts = { sections: [], equations: [
      { cell: one.id, number: "", label: null, env: "equation*" },
      { cell: one.id, number: "9", label: "eq:v", env: "equation" },
    ], labels: { "eq:v": "3.7" } };
    expect(applyNumbering(deriveCrossrefs([one]), facts)[0]?.number).toBe("3.7");
  });
});

it("preserves the approved lossy conversion and structured label behavior", () => {
  const figure = cell("c_00000010", "figure", { caption: "Cap", label: "", image: null, width: 80 });
  expect(convertCellData(figure, "latex").source).toContain("\\caption{Cap}");
  expect(withEnsuredLabel(figure, "fig:new").data.label).toBe("fig:new");
  const tex = cell("c_00000011", "latex", { source: "\\section{X}" });
  expect(convertCellData(tex, "figure")).toMatchObject({ caption: "", label: "", width: 80, image: null });
  expect(convertCellData(tex, "latex")).toEqual({ source: "\\section{X}" });
  expect(withEnsuredLabel(tex, "sec:x").data.source).toBe("\\section{X}\n\\label{sec:x}");
  const appendix = cell("c_00000012", "appendix", {});
  expect(withEnsuredLabel(appendix, "ignored")).toBe(appendix);
});
