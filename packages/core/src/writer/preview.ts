/** Writer adapter around the SAME facts/source/fuser used by the reader.
 * No ingest identity, library rebuild, annotation lifecycle, or IR file mutation.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  type IrSection,
  serializeCell,
  type TexCellRange,
  type WriterManuscript,
  type WriterNumberingFacts,
  type WriterPreview,
  type WriterPreviewItem,
  type WriterTemplate,
  writerDraftKey,
  writerTemplateKey,
} from "@argelanderspace/contracts";
import { stripOuterBraces } from "../pipelines/tex/fuse/numbering.js";
import { type FuseTexDocInput, fuseTexDoc } from "../pipelines/tex/pipeline.js";

export async function buildWriterPreview(
  input: FuseTexDocInput & {
    manuscript: WriterManuscript;
    template: WriterTemplate;
    cellRanges: TexCellRange[];
  }
): Promise<{ preview: WriterPreview; facts: WriterNumberingFacts }> {
  const result = await fuseTexDoc({ ...input, renderProfile: "writer" });
  const cells: WriterPreview["cells"] = Object.fromEntries(
    input.manuscript.cells.map((c) => [c.id, { source: serializeCell(c), items: [] }])
  );
  const preview: WriterPreview = {
    draftKey: writerDraftKey(input.manuscript),
    templateKey: writerTemplateKey(input.template),
    cells,
    targetCells: {},
    labelCells: {},
    targetLabels: {},
    references: result.ir.references ?? [],
    warnings: [...result.warnings],
  };
  const facts: WriterNumberingFacts = {
    sections: [],
    equations: [],
    floats: [],
    labels: Object.fromEntries(
      Object.entries(result.facts.labels).map(([k, v]) => [k, stripOuterBraces(v.number)])
    ),
  };
  const spans = new Map(result.sourceSpans.map((s) => [s.id, s]));
  const lines = readFileSync(input.mainTex, "utf8").split("\n");
  const owner = (id: string): string | undefined => {
    const span = spans.get(id);
    if (!span || span.file !== basename(input.mainTex)) return undefined;
    const range = input.cellRanges.find(
      (r) => r.startLine <= span.startLine && span.endLine <= r.endLine
    );
    if (
      !range &&
      input.cellRanges.some((r) => r.startLine <= span.startLine && span.startLine <= r.endLine)
    ) {
      preview.warnings.push(
        `IR block ${id} crosses cell boundaries; keep the complete environment in one cell to preview it`
      );
    }
    return range?.cell;
  };
  const labelFor = (id: string) =>
    [...result.labelTargets].find(([, target]) => target.id === id)?.[0] ?? null;
  const add = (cell: string | undefined, id: string, item: WriterPreviewItem) => {
    if (cell && cells[cell]) {
      cells[cell].items.push(item);
      preview.targetCells[id] = cell;
    }
  };
  const visit = (sections: IrSection[]) => {
    for (const section of sections) {
      // Abstract's synthetic heading has no source node; its first real block does.
      const cell =
        owner(section.id) ??
        (section.heading === "Abstract" && section.blocks[0]
          ? owner(section.blocks[0].id)
          : undefined);
      if (section.heading) {
        add(cell, section.id, {
          kind: "heading",
          id: section.id,
          level: section.level,
          heading: section.heading,
          ...(section.number !== undefined ? { number: section.number } : {}),
        });
        if (spans.has(section.id))
          facts.sections.push({
            number: section.number ?? "",
            title: section.heading,
            cell: cell ?? null,
            label: labelFor(section.id),
          });
      }
      for (const block of section.blocks) {
        const cell = owner(block.id);
        const rows = result.equationRows[block.id];
        add(cell, block.id, { kind: "block", block, ...(rows ? { rows: [...rows] } : {}) });
        if (cell && (block.type === "figure" || block.type === "table" || block.type === "code"))
          facts.floats?.push({ cell, kind: block.type, number: block.number ?? "" });
        if (block.type === "equation") {
          const line = spans.get(block.id)?.startLine ?? 0;
          facts.equations.push({
            number: block.number ?? "",
            env: /\\begin\s*\{([^}]+)\}/.exec(lines[line - 1] ?? "")?.[1] ?? "displaymath",
            cell: cell ?? null,
            label: labelFor(block.id),
          });
        }
      }
      visit(section.children);
    }
  };
  visit(result.ir.sections);
  for (const [key, target] of result.labelTargets) {
    const cell = preview.targetCells[target.id];
    if (cell && key) {
      preview.labelCells[key] = cell;
      if (!preview.targetLabels[target.id]) preview.targetLabels[target.id] = key;
    }
  }
  return { preview, facts };
}
