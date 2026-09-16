import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ManuscriptSchema, BUILTIN_WRITER_TEMPLATES, serializeCell, writerDraftKey, writerTemplateKey, writerNumberingForDraft, type WriterNumberingResponse, type WriterPreview } from "@argelanderspace/contracts";
import { WriterCellPreview } from "../src/writer/preview";
import { OutlinePanel } from "../src/writer/outline";
import { writerCrossrefs } from "../src/writer/model";

afterEach(cleanup);
const template = BUILTIN_WRITER_TEMPLATES.find((t) => t.id === "report")!;
const doc = ManuscriptSchema.parse({ version: 1, id: "m_00000001", rev: 0, template: "report", created_at: "2026-09-15T00:00:00Z", updated_at: "2026-09-15T00:00:00Z", cells: [
  { id: "c_00000001", type: "latex", data: { source: "See \\citep{s} and \\eqref{eq:a}." } },
  { id: "c_00000002", type: "latex", data: { source: "\\begin{align}a&=b\\label{eq:a}\\\\c&=d\\end{align}" } },
] });
const preview: WriterPreview = {
  draftKey: writerDraftKey(doc), templateKey: writerTemplateKey(template), references: [], warnings: [],
  targetCells: { "eq-1": "c_00000002" }, labelCells: { "eq:a": "c_00000002" }, targetLabels: { "eq-1": "eq:a" },
  cells: {
    c_00000001: { source: serializeCell(doc.cells[0]!), items: [{ kind: "block", block: { id: "p-1", type: "paragraph", segments: [
      { type: "text", text: "See " }, { type: "cite", refs: [{ id: "ref-1", resolved: true }], raw: "[see Smith et al., 2020, sec. 2]" },
      { type: "text", text: " and " }, { type: "xref", target: { id: "eq-1", resolved: true, number: "2.1" }, raw: "(2.1)" },
    ] } }] },
    c_00000002: { source: serializeCell(doc.cells[1]!), items: [{ kind: "block", block: { id: "eq-1", type: "equation", latex: "ignored combined body", number: "2.1,2.2" }, rows: [
      { latex: "a=b", number: "2.1" }, { latex: "c=d", number: "2.2" },
    ] }] },
  },
};
const numbering: WriterNumberingResponse = { status: "ok", facts: { sections: [], equations: [{ cell: "c_00000002", number: "2.1,2.2", env: "align", label: "eq:a" }], labels: { "eq:a": "2.1" } }, lastError: null, preview };

it("consumes citation raw verbatim and displays each compiled equation row number", () => {
  const first = render(<WriterCellPreview cell={doc.cells[0]!} cells={doc.cells} docId={doc.id} numbering={numbering} />);
  expect(first.container.querySelector(".w-cite")?.textContent).toBe("[see Smith et al., 2020, sec. 2]");
  expect(first.container.querySelector(".w-xref")?.textContent).toBe("(2.1)");
  const second = render(<WriterCellPreview cell={doc.cells[1]!} cells={doc.cells} docId={doc.id} numbering={numbering} />);
  expect([...second.container.querySelectorAll(".w-equation-number")].map((e) => e.textContent)).toEqual(["(2.1)", "(2.2)"]);
  expect(second.container.querySelectorAll(".katex-display")).toHaveLength(2);
});

it("cannot bind old numbers to changed targets, even if the label and cell id stayed the same", () => {
  const draft = structuredClone(doc);
  draft.cells[1]!.data.source = "\\begin{equation}NEW\\label{eq:a}\\end{equation}";
  const guarded = writerNumberingForDraft(numbering, draft, template)!;
  expect(guarded.status).toBe("stale");
  expect(guarded.facts?.equations).toEqual([]);
  expect(guarded.facts?.labels).toEqual({});
  const first = render(<WriterCellPreview cell={draft.cells[0]!} cells={draft.cells} docId={draft.id} numbering={guarded} />);
  expect(first.container.querySelector(".w-xref")?.textContent).toBe("(?)");
  expect(first.container.querySelector(".w-preview-stale")).not.toBeNull();
  const second = render(<WriterCellPreview cell={draft.cells[1]!} cells={draft.cells} docId={draft.id} numbering={guarded} />);
  expect(second.container.querySelector(".w-source-preview")?.textContent).toContain("NEW");
  expect(second.container.querySelector(".w-equation-number")).toBeNull();
});

it("treats reordered/unsaved drafts and template changes as stale, but not comments", () => {
  const reordered = { ...doc, cells: [...doc.cells].reverse() };
  expect(writerNumberingForDraft(numbering, reordered, template)?.status).toBe("stale");
  expect(writerNumberingForDraft(numbering, doc, { ...template, preamble: `${template.preamble}\n\\setcitestyle{numbers}` })?.status).toBe("stale");
  expect(writerNumberingForDraft(numbering, { ...doc, rev: 99 }, template)?.status).toBe("ok");
  expect(writerNumberingForDraft({ ...numbering, preview: null }, doc, template)?.facts).toBeNull();
  const duplicate = { ...doc, cells: [doc.cells[0]!, doc.cells[0]!] };
  expect(writerNumberingForDraft(numbering, duplicate, template)?.preview).toBeNull();
});

it("compiled side-panel targets ignore commented-out equations instead of shifting ordinal numbers", () => {
  const draft = structuredClone(doc);
  draft.cells[1]!.data.source = "% \\begin{equation}fake\\label{eq:fake}\\end{equation}\n" + draft.cells[1]!.data.source;
  const projected = structuredClone(preview);
  projected.cells.c_00000002!.source = serializeCell(draft.cells[1]!);
  const targets = writerCrossrefs(draft.cells, { ...numbering, preview: projected });
  expect(targets).toHaveLength(1);
  expect(targets[0]).toMatchObject({ label: "eq:a", number: "2.1", targetId: "eq-1" });
});

it("multiple headings in one cell do not leave ghost rows across unresolved/compiled transitions", () => {
  const cells = [{ id: doc.cells[0]!.id, type: "latex" as const, data: { source: "\\chapter{Intro}\\section{Setup}" } }];
  const props = { cells, onJump: () => {}, onInsertLabel: () => {} };
  const ui = render(<OutlinePanel {...props} numbering={null} />);
  const compiled: WriterNumberingResponse = { status: "ok", lastError: null, facts: { sections: [
    { cell: cells[0]!.id, number: "1", title: "Intro", label: null },
    { cell: cells[0]!.id, number: "1.1", title: "Setup", label: null },
  ], equations: [], labels: {} } };
  for (let i = 0; i < 3; i++) {
    ui.rerender(<OutlinePanel {...props} numbering={compiled} />);
    expect(ui.container.querySelectorAll(".w-outline-row")).toHaveLength(2);
    ui.rerender(<OutlinePanel {...props} numbering={null} />);
    expect(ui.container.querySelectorAll(".w-outline-row")).toHaveLength(2);
  }
});
