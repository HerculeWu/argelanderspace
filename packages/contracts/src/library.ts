/**
 * Zod schemas for the Library payload (`GET /api/library`).
 *
 * Mirrors `bibgraph/library/build.py::library_payload()` +
 * `bibgraph/library/graph.py::work_to_ref()` / `_saved_node()` /
 * `_suggested_node()`, and the frontend's `web/src/library/types.ts`.
 *
 * Serialization notes (bug-for-bug):
 * - `LibraryRef`: the 11 base keys are always present (never stripped);
 *   optional keys are *absent* when unset (None/"" are filtered out).
 * - `GraphNode`: the graph JSON is dumped *without* compaction, so saved
 *   nodes carry explicit `null` for unset `doi` / `arxiv_id` / `doc_id`
 *   (observed in data/library/cache/graph.json) → `.nullish()`. Suggested
 *   nodes omit `ref` / `arxiv_id` / `doc_id` entirely.
 */

import { z } from "zod";

export const LibraryProjectSchema = z.object({
  name: z.string(),
  short: z.string().optional(),
  field: z.string().optional(),
});

/** A saved reference (Zotero-like record). */
export const LibraryRefSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Display string, e.g. "Dieleman, Willett & Dambre". */
  authors: z.string(),
  /** 0 when the year is unknown. */
  year: z.number().int(),
  venue: z.string(),
  type: z.enum(["article", "conf"]),
  /** BibTeX cite key. */
  cite: z.string(),
  tags: z.array(z.string()),
  pdf: z.boolean(),
  read: z.boolean(),
  star: z.boolean(),
  // ---- optional (absent when unset) ---- //
  abstract: z.string().optional(),
  /** Full note text (Stage 3 / MS3: no longer squashed to a boolean). */
  note: z.string().optional(),
  doi: z.string().optional(),
  arxiv_id: z.string().optional(),
  /** Reader doc id, when this work is ingested. */
  doc_id: z.string().optional(),
  citedBy: z.number().int().optional(),
  /** Color-label key (red|amber|green|blue|violet). */
  label: z.string().optional(),
  /** Short journal label, e.g. "A&A". */
  journal: z.string().optional(),
  /** Acquisition planner output: chosen tier, e.g. journal_html | journal_pdf | arxiv_latex | ads_scan. */
  source: z.string().optional(),
  /** Human label, e.g. "A&A HTML". */
  sourceLabel: z.string().optional(),
  /** ready | blocked | needs_adapter | needs_access */
  sourceStatus: z.string().optional(),
  /** Top tier fetchable now, if any. */
  sourceReady: z.string().optional(),
  /** Bot-walled & no auto source → user must upload a PDF. */
  needs_upload: z.boolean().optional(),
  /** Citation-count provenance: ads | crossref | openalex */
  resolvedBy: z.string().optional(),
});

/**
 * A node in the citation graph. Saved works carry `ref` (their library id);
 * suggested works don't. `c` = citation count (node radius), `y` = year (hue).
 */
export const GraphNodeSchema = z.object({
  /** Canonical work id (cite key prefix for suggested papers, e.g. "oa:W…"). */
  id: z.string(),
  /** Library ref id, when this node is a saved work. */
  ref: z.string().optional(),
  y: z.number().int(),
  c: z.number().int(),
  /** Short author string, e.g. "Dieleman et al.". */
  a: z.string(),
  /** Venue, e.g. "MNRAS". */
  v: z.string(),
  /** Title. */
  t: z.string(),
  doi: z.string().nullish(),
  arxiv_id: z.string().nullish(),
  doc_id: z.string().nullish(),
});

/** Directed edge `[from, to]` between node ids. */
export const GraphLinkSchema = z.tuple([z.string(), z.string()]);

export const GraphDataSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  links: z.array(GraphLinkSchema),
});

/** Response of `GET /api/library`. */
export const LibraryPayloadSchema = z.object({
  project: LibraryProjectSchema,
  refs: z.array(LibraryRefSchema),
  tags: z.array(z.string()),
  graph: GraphDataSchema,
});

// --------------------------------------------------------------------------- //
// Inferred types
// --------------------------------------------------------------------------- //

export type LibraryProject = z.infer<typeof LibraryProjectSchema>;
export type LibraryRef = z.infer<typeof LibraryRefSchema>;
export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type GraphLink = z.infer<typeof GraphLinkSchema>;
export type GraphData = z.infer<typeof GraphDataSchema>;
export type LibraryPayload = z.infer<typeof LibraryPayloadSchema>;
