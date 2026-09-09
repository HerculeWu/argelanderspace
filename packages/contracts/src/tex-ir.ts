/**
 * The Stage 5 stored-IR schema (roadmap Q3): what the new TeX pipeline
 * writes to `<doc_id>.json`. DocIr-isomorphic at the top level (same
 * sections/refsManifest/bib/references/citationsByBlock the web reader and
 * CLI markdown consume today — the block/segment sub-schemas are reused,
 * not forked) plus a `version` marker and the `source`/`meta` identity
 * block the library seed/stamp read (`seed.ts` looks up `source.doi`,
 * `source.arxiv_id`, `source.publisher`, `meta.title`, `references`).
 *
 * Differences from the retired Document JSON: segments are NATIVE
 * (cite/xref/math segments are stored directly; the `[[cite:…]]` token +
 * occurrences double-track is gone), and there are no write-only index
 * buckets, stats, or layout forensics.
 */

import { z } from "zod";
import { DocIrSchema } from "./doc-ir.js";

/** Schema version of the stored IR (bump on any incompatible change). */
export const TEX_IR_VERSION = 1;

/**
 * Provenance of the TeX document. Key names deliberately match the fields
 * the library seed reads on today's Document JSON (snake_case).
 */
export const TexIrSourceSchema = z.object({
  type: z.literal("latex"),
  /** The URL or local path we resolved (arXiv e-print URL / upload origin). */
  origin: z.string(),
  /** Driver .tex file name relative to the source root (e.g. "Arxiv.tex"). */
  main_tex: z.string(),
  arxiv_id: z.string().optional(),
  doi: z.string().optional(),
  publisher: z.string().optional(),
  /** Provenance for uploads (the upload attach stamps "user_latex_zip"). */
  acquired_via: z.string().optional(),
});

export const TexIrAuthorSchema = z.object({
  name: z.string(),
  /** 1-based indices into meta.affiliations (= printed superscripts). */
  affiliations: z.array(z.number().int()).optional(),
  email: z.string().optional(),
});

export const TexIrMetaSchema = z.object({
  /** Identity title (may carry the subtitle: "Title — Subtitle"). */
  title: z.string().optional(),
  /** Author names as raw strings (affiliation tails trimmed best-effort). */
  authors: z.array(z.string()).optional(),
  /** The engine that produced the compile artifacts ("pdflatex"/"xelatex"). */
  engine: z.string().optional(),
  /** Structured author block (Stage 6): affiliations/emails recovered from
   *  the source (AASTeX/revtex sequential \affiliation, aa.cls \institute
   *  positional, \email/\thanks addresses). Agent-invisible: not rendered by
   *  renderIrMarkdown/bib/ref. */
  authorDetails: z.array(TexIrAuthorSchema).optional(),
  /** Affiliation list referenced by authorDetails.affiliations (1-based). */
  affiliations: z.array(z.string()).optional(),
  /** Corresponding email that couldn't be attached to one author (aa.cls). */
  email: z.string().optional(),
});

export const TexDocIrSchema = DocIrSchema.extend({
  version: z.literal(TEX_IR_VERSION),
  source: TexIrSourceSchema,
  meta: TexIrMetaSchema,
});

export type TexIrSource = z.infer<typeof TexIrSourceSchema>;
export type TexIrMeta = z.infer<typeof TexIrMetaSchema>;
export type TexDocIr = z.infer<typeof TexDocIrSchema>;
