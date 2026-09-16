/**
 * Writer compile-cache contracts, including the shared-IR cell projection.
 * Legacy Stage 10 helpers below fuse an event stream (`<jobname>.argelander.jsonl`) plus the `.aux`
 * `\newlabel` table into per-manuscript numbering truth.
 *
 * Pure functions — the compile orchestration lives server-side; this module
 * only parses and fuses. Attribution to cells uses the assembly line map from
 * {@link buildTexDocumentMapped} (events carry `file: main.tex` + 1-based
 * `line`), never re-parsing the LaTeX source.
 *
 * Production Writer now uses the shared core facts/source/IR fuser after
 * converged latexmk compilation; these legacy helpers are NOT its renderer.
 */

import { z } from "zod";
import type { TexCellRange } from "./writer.js";
import { WriterPreviewSchema } from "./writer-preview.js";

// ---- facts shape (shared by the REST response and the persisted file) ------ //

export const WriterNumberingSectionSchema = z.looseObject({
  number: z.string(),
  title: z.string(),
  /** Owning cell id; null when the event maps outside every cell range. */
  cell: z.string().nullable(),
  label: z.string().nullable(),
});

export const WriterNumberingEquationSchema = z.looseObject({
  number: z.string(),
  /** Environment name as compiled (equation / align / …). */
  env: z.string(),
  cell: z.string().nullable(),
  label: z.string().nullable(),
});

export const WriterNumberingFactsSchema = z.looseObject({
  sections: z.array(WriterNumberingSectionSchema),
  equations: z.array(WriterNumberingEquationSchema),
  floats: z
    .array(
      z.object({ cell: z.string(), kind: z.enum(["figure", "table", "code"]), number: z.string() })
    )
    .optional(),
  /** Every labeled thing → printed number (aux \newlabel truth). */
  labels: z.record(z.string(), z.string()),
});

/** `manuscripts/<id>/build/numbering.json` — the last compile's outcome. */
export const WriterNumberingFileSchema = z.looseObject({
  version: z.literal(1),
  /** ISO-8601 time of the compile attempt. */
  at: z.iso.datetime(),
  /** sha256 of the assembled tex that was compiled. */
  texHash: z.string(),
  /** Null when the compile failed before any facts existed. */
  facts: WriterNumberingFactsSchema.nullable(),
  /** Full input hash includes bibliography, assets, template deps and compiler profile. */
  inputHash: z.string().optional(),
  preview: WriterPreviewSchema.optional(),
  /** Set when THIS attempt failed (facts then hold the last good ones). */
  lastError: z.string().nullable(),
});

/** `GET …/numbering` response: file state + freshness against the live draft. */
export const WriterNumberingResponseSchema = z.looseObject({
  /** never = no successful-or-failed compile yet; ok = hash matches; stale = draft moved on or the last compile failed. */
  status: z.enum(["never", "ok", "stale"]),
  at: z.iso.datetime().optional(),
  facts: WriterNumberingFactsSchema.nullable(),
  lastError: z.string().nullable(),
  preview: WriterPreviewSchema.nullable().optional(),
  compiling: z.boolean().optional(),
});

// ---- parsing / fusion ------------------------------------------------------- //

interface NumberingEvent {
  type: string;
  number?: string;
  title?: string;
  name?: string;
  env?: string;
  key?: string;
  file?: string;
  line?: number;
}

function* parseEvents(eventsText: string): Generator<NumberingEvent> {
  for (const line of eventsText.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed: unknown = JSON.parse(t);
      if (typeof parsed === "object" && parsed !== null && "type" in parsed) {
        yield parsed as NumberingEvent;
      }
    } catch {
      // tolerate a truncated tail line (killed compile)
    }
  }
}

/** `\newlabel{key}{{number}{page}…}` → key → number. */
export function parseAuxLabels(auxText: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of auxText.matchAll(/\\newlabel\{([^}]+)\}\{\{([^{}]*)\}/g)) {
    const [, key, number] = m;
    if (key && !(key in out)) out[key] = number ?? "";
  }
  return out;
}

function cellAtLine(cellRanges: TexCellRange[], line: number): string | null {
  let found: string | null = null;
  for (const r of cellRanges) {
    if (r.startLine <= line) found = r.cell;
    else break;
  }
  return found;
}

/**
 * Fuse the event stream + aux into numbering facts.
 * - sections: every `section` event, in stream order; its label is the
 *   `label` event on the same source line (if any).
 * - equations: `mathnum` events grouped by source line (a multi-row env like
 *   align reports one event per numbered row on the env's END line — the
 *   target block keeps the first row's number; per-row split is a documented
 *   simplification).
 * - labels: aux \newlabel truth ({} when the aux is unavailable).
 */
export function fuseNumberingEvents(
  eventsText: string,
  auxText: string,
  cellRanges: TexCellRange[]
): WriterNumberingFacts {
  const sections: WriterNumberingFacts["sections"] = [];
  const eqByLine = new Map<number, WriterNumberingFacts["equations"][number]>();
  const events = [...parseEvents(eventsText)];

  // Two passes: (1) collect owners (sections / mathnum) and labels;
  // (2) bind each label to its owner (same-line first, see below).
  const owners: { line: number; kind: "section" | "math"; target: { label: string | null } }[] = [];
  const labels: { line: number; key: string }[] = [];
  for (const ev of events) {
    const line = typeof ev.line === "number" ? ev.line : -1;
    if (ev.type === "section" && ev.number !== undefined) {
      const target = {
        number: ev.number,
        title: ev.title ?? "",
        cell: cellAtLine(cellRanges, line),
        label: null as string | null,
      };
      sections.push(target);
      owners.push({ line, kind: "section", target });
    } else if (ev.type === "mathnum" && ev.number !== undefined) {
      if (!eqByLine.has(line)) {
        const target = {
          number: ev.number,
          env: ev.env ?? "",
          cell: cellAtLine(cellRanges, line),
          label: null as string | null,
        };
        eqByLine.set(line, target);
        owners.push({ line, kind: "math", target });
      }
    } else if (ev.type === "label" && ev.key) {
      labels.push({ line, key: ev.key });
    }
  }
  // Bind each label to an unbound owner near its line. The event line is the
  // shipout-time line and the write can be delayed — 2026-09-15 probe: same
  // doc shape gave \label at the env-end line in one run and at its own
  // source line in another. Kind-aware windows (both runs verified):
  // - section owner: label on its own line or the NEXT line (a \label right
  //   after \section{…}); never a label ABOVE it — a chapter's trailing label
  //   must not poison the following section.
  // - mathnum owner: label within ±1 line (env-internal label may register at
  //   its source line or at the env-end line); multi-line envs with a wider
  //   gap fall back to the aux labels map.
  const sectionOwners = owners.filter((o) => o.kind === "section");
  const mathOwners = owners.filter((o) => o.kind === "math");
  const bind = (
    line: number,
    key: string,
    candidates: typeof owners,
    allowed: (d: number) => boolean
  ) => {
    let best: (typeof owners)[number] | null = null;
    for (const o of candidates) {
      if (o.target.label !== null) continue;
      const diff = line - o.line;
      if (!allowed(diff)) continue;
      if (best === null || Math.abs(diff) < Math.abs(line - best.line)) best = o;
    }
    if (best) best.target.label = key;
    return best !== null;
  };
  for (const { line, key } of labels) {
    // equations first when both could match on the same line (rare); a label
    // consumed by one owner is never reused by another.
    if (!bind(line, key, mathOwners, (d) => d >= -1 && d <= 1)) {
      bind(line, key, sectionOwners, (d) => d >= 0 && d <= 1);
    }
  }
  return {
    sections,
    equations: [...eqByLine.values()],
    labels: parseAuxLabels(auxText),
  };
}

// --------------------------------------------------------------------------- //
// Inferred types
// --------------------------------------------------------------------------- //

export type WriterNumberingSection = z.infer<typeof WriterNumberingSectionSchema>;
export type WriterNumberingEquation = z.infer<typeof WriterNumberingEquationSchema>;
export type WriterNumberingFacts = z.infer<typeof WriterNumberingFactsSchema>;
export type WriterNumberingFile = z.infer<typeof WriterNumberingFileSchema>;
export type WriterNumberingResponse = z.infer<typeof WriterNumberingResponseSchema>;
