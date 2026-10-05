import { describe, expect, test } from "vitest";
import {
  agentTexProblem,
  agentTexViolations,
  collectLabels,
  convertCellData,
  randomLabel,
  validateCellFields,
  type WriterCell,
  WriterCellOperationSchema,
  WriterViewActionSchema,
  withEnsuredLabel,
} from "../src/index.js";

const cell = (type: string, data: Record<string, unknown> = {}, id = "c_00000001") =>
  ({ id, type, data }) as unknown as WriterCell;

describe("cell conversion (lossy by design)", () => {
  test("to latex keeps the serialized source, to another type starts from its defaults", () => {
    const figure = cell("figure", { caption: "A cap", label: "fig:a", image: "a.png" });
    const asLatex = convertCellData(figure, "latex");
    expect(String(asLatex.source)).toContain("\\caption{A cap}");
    expect(String(asLatex.source)).toContain("assets/a.png");
    const asTable = convertCellData(figure, "table");
    expect(asTable.caption).toBe("");
    expect(asTable.csv).toBe("");
    // the same type changes nothing
    expect(convertCellData(figure, "figure")).toEqual(figure.data);
  });
});

describe("label completion and inventory", () => {
  test("a figure without a label gains it, one with a label keeps it, other types are unchanged", () => {
    expect(withEnsuredLabel(cell("figure", { label: "" }), "fig:new").data.label).toBe("fig:new");
    expect(withEnsuredLabel(cell("figure", { label: "fig:old" }), "fig:new").data.label).toBe(
      "fig:old"
    );
    const recipient = cell("recipient", { name: "x" });
    expect(withEnsuredLabel(recipient, "a")).toBe(recipient);
  });
  test("an equation is labelled right after its \\begin line", () => {
    const eq = cell("latex", { source: "Text\n\\begin{equation}\nx=1\n\\end{equation}" });
    const next = withEnsuredLabel(eq, "eq:x", 0);
    expect(String(next.data.source)).toBe(
      "Text\n\\begin{equation}\n  \\label{eq:x}\nx=1\n\\end{equation}"
    );
  });
  test("collectLabels lists labels of sources and of the figure/table/code fields", () => {
    const labels = collectLabels([
      cell("latex", { source: "\\section{A}\\label{sec:a}" }, "c_00000001"),
      cell("figure", { label: "fig:one" }, "c_00000002"),
      cell("table", { label: "" }, "c_00000003"),
    ]);
    expect(labels).toEqual([
      { label: "sec:a", cell: "c_00000001" },
      { label: "fig:one", cell: "c_00000002" },
    ]);
    expect(randomLabel()).toMatch(/^ref:[a-z0-9]+$/);
  });
});

describe("cell fields an agent may set", () => {
  test("only the type's own editable fields, with typed values", () => {
    expect(validateCellFields("latex", { source: "x" })).toEqual({
      ok: true,
      fields: { source: "x" },
    });
    expect(validateCellFields("figure", { width: 60, placement: "left", caption: "c" }).ok).toBe(
      true
    );
    for (const [type, fields] of [
      ["latex", { caption: "no such field" }],
      ["figure", { image: "a.png" }], // the image is set through the chooser (set_figure_image) only
      ["figure", { width: 10 }],
      ["figure", { placement: "up" }],
      ["figure", { label: "bad}label" }],
      ["code", { lineNumbers: "yes" }],
      ["appendix", { source: "x" }],
    ] as const) {
      const result = validateCellFields(type, fields);
      expect(result.ok, `${type} ${JSON.stringify(fields)}`).toBe(false);
    }
  });
});

describe("spec 14.1 safety review of agent-written TeX", () => {
  test.each([
    "\\input{/etc/passwd}",
    "\\include{x}",
    "\\immediate\\write18{touch x}",
    "\\openin5=/etc/hostname",
    "\\@@input /etc/hostname",
    "\\makeatletter\\@input{x}",
    "\\csname inp\\endcsname",
    "\\catcode`\\|=0",
    "^^5cinput{x}",
    "\\usepackage{catchfile}",
    "\\usepackage[draft]{pdfpages, amsmath}",
    "\\RequirePackage{minted}",
    "\\begin{filecontents*}{x.tex}",
    "\\lstinputlisting{x}",
    "\\directlua{os.execute('x')}",
  ])("rejects %s", (text) => {
    expect(agentTexViolations(text).length).toBeGreaterThan(0);
  });
  test.each([
    "\\section{Intro} Normal text with $x^2$ and \\cite{key}.",
    "\\includegraphics[width=0.5\\columnwidth]{assets/fig.png}",
    "\\newcommand{\\kms}{km/s}\\usepackage{amsmath}",
    "caret in code: a ^ b and 100% sure",
  ])("accepts %s", (text) => {
    expect(agentTexViolations(text)).toEqual([]);
  });
  test("a problem names the field", () => {
    expect(agentTexProblem({ title: "ok", userPreamble: "\\input{x}" })).toMatch(
      /^userPreamble contains \\input/
    );
    expect(agentTexProblem({ title: "ok", userPreamble: undefined })).toBeNull();
  });
});

describe("operation schemas", () => {
  test("cell operations are strict and carry the rev", () => {
    const base = { manuscriptId: "m_0000000a", expectedRev: 3, cellId: "c_00000001" };
    expect(WriterCellOperationSchema.safeParse({ action: "delete_cell", ...base }).success).toBe(
      true
    );
    expect(
      WriterCellOperationSchema.safeParse({
        action: "delete_cell",
        manuscriptId: base.manuscriptId,
        cellId: base.cellId,
      }).success
    ).toBe(false);
    expect(
      WriterCellOperationSchema.safeParse({ action: "delete_cell", ...base, extra: 1 }).success
    ).toBe(false);
    expect(
      WriterCellOperationSchema.safeParse({
        action: "insert_cell",
        manuscriptId: base.manuscriptId,
        expectedRev: 3,
        cellType: "poster",
      }).success
    ).toBe(false);
    expect(
      WriterCellOperationSchema.safeParse({ action: "add_comment", ...base, body: "  " }).success
    ).toBe(false);
  });
  test("view actions of the editor", () => {
    expect(
      WriterViewActionSchema.safeParse({
        action: "set_writer_panel",
        panel: "outline",
        collapsed: true,
      }).success
    ).toBe(true);
    expect(
      WriterViewActionSchema.safeParse({ action: "set_writer_tab", tab: "files" }).success
    ).toBe(false);
    expect(
      WriterViewActionSchema.safeParse({
        action: "select_cell",
        manuscriptId: "m_0000000a",
        cellId: "c_00000001",
      }).success
    ).toBe(true);
  });
});
