/**
 * Zod schemas for the Library payload (`GET /api/library`).
 *
 * Mirrors `bibgraph/library/build.py::library_payload()` +
 * `bibgraph/library/graph.py::work_to_ref()` / `_saved_node()`, and the
 * frontend's `web/src/library/types.ts`. (The suggested-node architecture was
 * retired in Stage 14.)
 *
 * Serialization notes (bug-for-bug):
 * - `LibraryRef`: the 11 base keys are always present (never stripped);
 *   optional keys are *absent* when unset (None/"" are filtered out).
 * - `GraphNode`: the graph JSON is dumped *without* compaction, so nodes
 *   carry explicit `null` for unset `doi` / `arxiv_id` / `doc_id` —
 *   `.nullish()`.
 */

import { z } from "zod";
import { ArgumentGraphMergeNoteSchema } from "./argument-graph.js";

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
  /** The short OpenAlex id (shelf ticket 05: the page tells "the same paper on the Shelf" by DOI, arXiv or OpenAlex). */
  openalex_id: z.string().optional(),
  /**
   * ADS bibcode (Stage 14): presence enables the "explore related papers"
   * action in the web UI. Web/API-internal increment — the frozen CLI
   * surface (`search`/`list`) never consumes this payload.
   */
  bibcode: z.string().optional(),
  /** Reader doc id, when this work is ingested. The main doc (= doc_ids[0]). */
  doc_id: z.string().optional(),
  /**
   * All reader docs of this work (versions; Stage 7 MS3 re-upload). `doc_ids[0]`
   * is the main doc; absent when the work has no docs (CLI-safe: the agent
   * surface never consumes this payload — `search`/`list` read the store).
   */
  doc_ids: z.array(z.string()).optional(),
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
 * A node in the citation graph — a saved work (Stage 14: the Library graph
 * is saved-only; the old ref-less "suggested" nodes are gone with the global
 * recommendation architecture). `c` = citation count (node radius), `y` =
 * year (hue).
 */
export const GraphNodeSchema = z.object({
  /** Canonical work id. */
  id: z.string(),
  /** Library ref id (always set: every graph node is a saved work). */
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

/**
 * The current graph-cache format version (Stage 14, D7/D13): the saved-only
 * graph without suggested nodes. Files missing `version`, carrying a
 * different one, corrupt, or schema-invalid are all stale — the server
 * rebuilds them lazily under `libraryLock`. The single constant is the only
 * place the version lives; its concrete integer is not product semantics.
 */
export const CURRENT_GRAPH_VERSION = 2;

export const GraphDataSchema = z.object({
  version: z.literal(CURRENT_GRAPH_VERSION),
  nodes: z.array(GraphNodeSchema),
  links: z.array(GraphLinkSchema),
});

/** At most this many bibcodes in one batch bibcode import (project intake ticket 03). */
export const MANUAL_BIBCODES_MAX = 200;

/**
 * Request of `POST /api/library/works` (Stage 13 manual work creation).
 * - `identifier`: a DOI / doi.org URL / arXiv id / arXiv URL (server detects).
 * - `bibcode`: one ADS bibcode — fail-fast when ADS is unreachable / has no
 *   such record (the user's semantic is "pick from ADS").
 * - `bibcodes`: a batch of ADS bibcodes (project intake ticket 03; at most {@link MANUAL_BIBCODES_MAX}). Each is
 *   handled on its own and reported on its own; the import dialog never sends it (only the Copilot `library` tool
 *   and a direct request do).
 * - `bib`: raw BibTeX text, one or many entries; per-entry results.
 */
export const ManualWorkRequestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("identifier"), value: z.string().trim().min(1).max(500) }),
  z.object({ mode: z.literal("bibcode"), bibcode: z.string().trim().min(1).max(64) }),
  z.object({
    mode: z.literal("bibcodes"),
    bibcodes: z.array(z.string().trim().min(1).max(64)).min(1).max(MANUAL_BIBCODES_MAX),
  }),
  z.object({ mode: z.literal("bib"), bib: z.string().min(1).max(1_000_000) }),
]);

/**
 * Why a batch bibcode entry did not simply create a Work (`bibcodes` results, and bib results of a refused batch on the agent path, carry these):
 * `merge_refused` (it would have merged stored Works into one; nothing of it was written, `works` names them),
 * `not_found` (ADS answered but has no such record), `ads_unavailable` (ADS could not be asked or answered:
 * offline, no or rejected token, rate limit, timeout; no stub is kept), `id_collision` (a new Work's derived id is
 * held by a different paper), `repeated` (the same bibcode earlier in the batch; the result mirrors that entry),
 * `same_paper_as_earlier` (a different bibcode that is the same paper as an earlier entry of this batch; it
 * resolved to that Work). `batch_refused` (bib mode of the Copilot `library` tool only: another entry of the text
 * would have merged stored Works, so the whole text was refused and this entry, fine on its own, was not imported;
 * the entry that would merge carries `merge_refused` and `works`).
 */
export const ManualBibcodeReasonSchema = z.enum([
  "merge_refused",
  "not_found",
  "ads_unavailable",
  "id_collision",
  "repeated",
  "same_paper_as_earlier",
  "batch_refused",
]);

/** One entry's outcome. `key` echoes the attempted/assigned cite key. */
export const ManualWorkResultSchema = z.object({
  status: z.enum(["created", "exists", "error"]),
  ref: LibraryRefSchema.optional(),
  key: z.string().optional(),
  error: z.string().optional(),
  /** `bibcodes` mode only: the bibcode this entry was for. */
  bibcode: z.string().optional(),
  /**
   * `bibcodes` mode: see {@link ManualBibcodeReasonSchema}. `bib` mode: only when the Copilot tool refused the text
   * (`merge_refused` / `batch_refused`); the page's own import never carries it.
   */
  reason: ManualBibcodeReasonSchema.optional(),
  /** `merge_refused` only (`bibcodes` and `bib` modes): the stored Works the entry would have merged. */
  works: z.array(z.string()).optional(),
});

/** Response of `POST /api/library/works` (always 200 for well-formed bodies). */
export const ManualWorkResponseSchema = z.object({
  results: z.array(ManualWorkResultSchema),
  /** Present only when the import folded Works and an absorbed Work had an argument graph. */
  argument_graph_merges: z.array(ArgumentGraphMergeNoteSchema).optional(),
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
export type ManualBibcodeReason = z.infer<typeof ManualBibcodeReasonSchema>;
export type ManualWorkRequest = z.infer<typeof ManualWorkRequestSchema>;
export type ManualWorkResult = z.infer<typeof ManualWorkResultSchema>;
export type ManualWorkResponse = z.infer<typeof ManualWorkResponseSchema>;
export type LibraryPayload = z.infer<typeof LibraryPayloadSchema>;
