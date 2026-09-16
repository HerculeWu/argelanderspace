/** Writer-specific projection of the shared IR. This is a derived cache, not manuscript data. */
import { z } from "zod";
import { IrBlockSchema, ReferenceSchema } from "./doc-ir.js";
import { serializeCell, type WriterManuscript, type WriterTemplate } from "./writer.js";
import type { WriterNumberingResponse } from "./writer-numbering.js";

export const WriterMathRowSchema = z.object({
  latex: z.string(),
  number: z.string().optional(),
  tagStar: z.boolean().optional(),
});
export const WriterPreviewItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("heading"),
    id: z.string(),
    level: z.number(),
    heading: z.string(),
    number: z.string().optional(),
  }),
  z.object({
    kind: z.literal("block"),
    block: IrBlockSchema,
    rows: z.array(WriterMathRowSchema).optional(),
  }),
]);
export const WriterPreviewSchema = z.object({
  draftKey: z.string(),
  templateKey: z.string(),
  cells: z.record(
    z.string(),
    z.object({ source: z.string(), items: z.array(WriterPreviewItemSchema) })
  ),
  /** IR target id → cell id. Never assume a shifted IR id still identifies a new draft's target. */
  targetCells: z.record(z.string(), z.string()),
  labelCells: z.record(z.string(), z.string()),
  targetLabels: z.record(z.string(), z.string()),
  references: z.array(ReferenceSchema),
  warnings: z.array(z.string()),
});
export type WriterPreview = z.infer<typeof WriterPreviewSchema>;
export type WriterPreviewItem = z.infer<typeof WriterPreviewItemSchema>;

/** Exact equality (not a lossy hash). Ignore comments, rev and timestamps. */
export function writerDraftKey(doc: WriterManuscript): string {
  return JSON.stringify([
    doc.template,
    doc.title,
    doc.authors,
    doc.affiliations,
    doc.userPreamble,
    doc.infoValues,
    doc.cells.map((c) => [c.id, c.type, serializeCell(c)]),
  ]);
}
export function writerTemplateKey(template: WriterTemplate): string {
  return JSON.stringify([
    template.id,
    template.preamble,
    template.frontMatter,
    template.deps,
    template.bibliographyStyle,
  ]);
}

/** A stale projection may only stay attached to the exact same cell source. */
export function currentWriterCellPreview(
  preview: WriterPreview | null | undefined,
  cell: WriterManuscript["cells"][number]
) {
  const projected = preview?.cells[cell.id];
  return projected?.source === serializeCell(cell) ? projected : undefined;
}

/** Gate BOTH body and side panels against unsaved edits and target replacement. */
export function writerNumberingForDraft(
  numbering: WriterNumberingResponse | null,
  doc: WriterManuscript,
  template: WriterTemplate
): WriterNumberingResponse | null {
  if (!numbering) return null;
  if (new Set(doc.cells.map((c) => c.id)).size !== doc.cells.length)
    return {
      ...numbering,
      status: "stale",
      facts: null,
      preview: null,
      lastError: "duplicate cell ids: preview mapping is ambiguous",
    };
  const preview = numbering.preview;
  if (!preview) return { ...numbering, facts: null };
  const valid = new Set(
    doc.cells.filter((c) => currentWriterCellPreview(preview, c)).map((c) => c.id)
  );
  const current =
    numbering.status === "ok" &&
    preview.draftKey === writerDraftKey(doc) &&
    preview.templateKey === writerTemplateKey(template);
  const facts = numbering.facts;
  return {
    ...numbering,
    status: current ? "ok" : "stale",
    facts: facts
      ? {
          ...facts,
          sections: facts.sections.filter((f) => f.cell !== null && valid.has(f.cell)),
          equations: facts.equations.filter((f) => f.cell !== null && valid.has(f.cell)),
          floats: facts.floats?.filter((f) => valid.has(f.cell)),
          labels: Object.fromEntries(
            Object.entries(facts.labels).filter(([key]) => valid.has(preview.labelCells[key] ?? ""))
          ),
        }
      : null,
  };
}
