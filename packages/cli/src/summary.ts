/**
 * The human output of the CLI: the `=== ingest summary ===` block
 * (`bibgraph/cli.py::_summarize`) and the acquisition-plan table rows
 * (`bibgraph/acquire/__main__.py::_row`). Kept free of I/O so the smoke tests
 * can assert on the exact strings.
 */

import type { IrSection, TexDocIr } from "@argelanderspace/contracts";
import type { Work } from "@argelanderspace/core";

/** Python `f"{k:<12}"` (left-justify, pad with spaces). */
function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** Python `str(v)`: None for missing, lower-case booleans never occur here. */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  return String(v);
}

/** Python `d.get(k) or fallback` (empty string / 0 / null all fall back). */
function pyOr(v: unknown, fallback: string): string {
  if (v === null || v === undefined || v === "" || v === 0 || v === false) return fallback;
  return String(v);
}

const STAT_KEYS = [
  "n_sections",
  "n_paragraphs",
  "n_figures",
  "n_tables",
  "n_equations",
  "n_code",
  "n_algorithms",
  "n_references",
] as const;

/**
 * The `=== ingest summary ===` block (without the leading blank line).
 * Takes the *serialized* document (`documentToJson(doc)` — Python's
 * `doc.to_dict(compact_json)`): stats are computed at serialization time.
 */
export function formatIngestSummary(docJson: Record<string, unknown>): string {
  const meta = (docJson.meta ?? {}) as Record<string, unknown>;
  const source = (docJson.source ?? {}) as Record<string, unknown>;
  const stats = (docJson.stats ?? {}) as Record<string, unknown>;
  const num = (k: string): unknown => stats[k] ?? 0;
  const lines: string[] = ["=== ingest summary ==="];
  lines.push(`  ${pad("title", 12)}: ${pyStr(meta.title)}`);
  lines.push(`  ${pad("pages", 12)}: ${pyStr(source.n_pages)}`);
  for (const k of STAT_KEYS) {
    lines.push(`  ${pad(k, 12)}: ${String(num(k))}`);
  }
  lines.push(
    `  ${pad("citations", 12)}: ${String(num("n_citations"))} (${String(num("n_citations_resolved"))} resolved)`
  );
  lines.push(
    `  ${pad("crossrefs", 12)}: ${String(num("n_crossrefs"))} (${String(num("n_crossrefs_resolved"))} resolved)`
  );
  const tf = meta.textfix as Record<string, unknown> | undefined;
  if (tf) {
    const fixed = typeof tf.gaps_fixed === "number" ? tf.gaps_fixed : 0;
    const before = typeof tf.gaps_before === "number" ? tf.gaps_before : 0;
    lines.push(
      `  ${pad("textfix", 12)}: repaired ${fixed}/${before} ?-gaps from the PDF text layer`
    );
  }
  return lines.join("\n");
}

/**
 * The `=== ingest summary ===` block for the Stage 5 stored IR (MS3a): same
 * label layout as the Document-JSON version, with stats computed from the
 * IR (the retired `stats` bucket is gone) and the compile engine + warning
 * count appended.
 */
export function formatTexIngestSummary(
  ir: TexDocIr,
  info: { engine?: string; warnings?: number } = {}
): string {
  let paragraphs = 0;
  let figures = 0;
  let tables = 0;
  let equations = 0;
  let code = 0;
  let algorithms = 0;
  let nBlocks = 0;
  let nSections = 0;
  const walk = (secs: IrSection[]): void => {
    for (const s of secs) {
      nSections += 1;
      for (const b of s.blocks) {
        nBlocks += 1;
        if (b.type === "paragraph") paragraphs += 1;
        else if (b.type === "figure") figures += 1;
        else if (b.type === "table") tables += 1;
        else if (b.type === "equation") equations += 1;
        else if (b.type === "code") code += 1;
        else if (b.type === "algorithm") algorithms += 1;
      }
      walk(s.children);
    }
  };
  walk(ir.sections);
  const counts: Array<[string, number]> = [
    ["n_sections", nSections],
    ["n_paragraphs", paragraphs],
    ["n_figures", figures],
    ["n_tables", tables],
    ["n_equations", equations],
    ["n_code", code],
    ["n_algorithms", algorithms],
    ["n_references", ir.references?.length ?? 0],
  ];
  const lines: string[] = ["=== ingest summary ==="];
  lines.push(`  ${pad("title", 12)}: ${pyStr(ir.title)}`);
  lines.push(`  ${pad("pages", 12)}: ${pyStr(ir.nPages)}`);
  for (const [k, v] of counts) {
    lines.push(`  ${pad(k, 12)}: ${String(v)}`);
  }
  lines.push(`  ${pad("blocks", 12)}: ${String(nBlocks)}`);
  if (info.engine !== undefined) lines.push(`  ${pad("engine", 12)}: ${info.engine}`);
  if (info.warnings !== undefined && info.warnings > 0) {
    lines.push(`  ${pad("warnings", 12)}: ${String(info.warnings)} (see stderr)`);
  }
  return lines.join("\n");
}

// --------------------------------------------------------------------------- //
// acquire plan table
// --------------------------------------------------------------------------- //

/** `_STATUS_MARK`: planner status → display mark. */
export const STATUS_MARK: Record<string, string> = {
  ready: "✓ ready",
  needs_adapter: "⊕ needs-adapter",
  needs_access: "⊝ needs-access",
  blocked: "⊘ bot-walled",
  unavailable: "× none",
};

/** One `=== acquisition plan ===` row (`acquire/__main__.py::_row`). */
export function formatPlanRow(w: Work): string {
  const acq = w.acquisition ?? {};
  const chosen = pyOr(acq.chosen_label, "—");
  const rawStatus = pyOr(acq.status, "—");
  const status = STATUS_MARK[rawStatus] ?? rawStatus;
  const ready = pyOr(acq.ready, "—");
  const rb = pyOr(w.resolution?.count, "—");
  const cby =
    w.cited_by_count !== null && w.cited_by_count !== undefined ? String(w.cited_by_count) : "?";
  const tag = acq.ingested_doc ? "[in lib]" : "";
  const title = (w.title || w.id).slice(0, 46);
  return (
    `  ${pad(chosen, 11)} ${pad(status, 15)} ready=${pad(ready, 12)} ` +
    `cite=${pad(rb, 9)} n=${pad(cby, 6)} ${title} ${tag}`
  );
}

/** Python `sorted(works, key=lambda w: (w.acquisition or {}).get("chosen") or "z")`. */
export function planSortKey(w: Work): string {
  const chosen = w.acquisition?.chosen;
  return typeof chosen === "string" && chosen !== "" ? chosen : "z";
}
