/**
 * Zod schemas for document annotations (Stage 8) — the on-disk shape of
 * `<dataDir>/annotations/<doc_id>/current.json` (+ `archive/`) and the
 * `annotation.changed` WebSocket message. Locked design:
 * `.kimi-code/memory/2026-09-10-stage8-roadmap.md` §1 (data model) / §2
 * (storage) / §3 (fingerprint) / §4 (invalidation).
 *
 * Data model:
 * - annotation = `{id: a_<8 hex>, target, body, created_at, updated_at}`;
 *  `body` is markdown + `$…$` math, stored as raw bytes (never trimmed —
 *  whitespace matters in markdown/code), but must not be trim-empty;
 *  `target`/`snapshot`/`created_at` are immutable after creation,
 *  `updated_at` only bumps when the body bytes actually change.
 * - target is a discriminated union on `type`:
 *   - `document` — free whole-doc annotation;
 *   - `structure` — anchored to a section/block id; `snapshot` is a
 *     creation-time copy of the anchored content for UI display / agent
 *     context / future migration input (never for automatic re-anchoring);
 *   - `text` — anchored to a UTF-16 code-unit range `[start, end)` of the
 *     container's canonical annotation text, with `quote = slice(start, end)`.
 * - `snapshot` is ONE zod object with all-optional fields covering every
 *   kind (roadmap §1 lists the per-kind subsets: section number?/heading,
 *   paragraph text, list ordered/items, equation number?/label?/latex,
 *   figure·table number?/label?/caption?/footnote?/asset_hash? (+ table
 *   table_body?), code …/lang?/body?, algorithm …/body?). A single shape
 *   keeps the stored JSON self-describing and forward-compatible — writers
 *   only ever fill the fields of the target kind.
 *
 * Canonical annotation text (the coordinate system for `text` targets; one
 * implementation shared by the core fingerprint, the CLI, and the web
 * selection mapper — no DOM involved):
 * - `text` segment → `text` as-is;
 * - `math` segment → `"$" + latex + "$"` (the `$…$` source form; math is an
 *   atomic segment — a selection never lands inside KaTeX output);
 * - `cite` segment → the reader-visible string of the Stage-6 per-ref chip
 *   rendering (`packages/web/src/lib/segments.tsx`). Every render path —
 *   per-ref split chips (raw split on "; " re-joined with the same
 *   separator and the outer wrapper re-attached reproduces `raw` verbatim),
 *   the pathological-raw single-chip fallback, and the raw-less fallbacks —
 *   reduces to `raw || refs.map(resolved&&short!==undefined ? short : id)
 *   .join("; ") || "?"`;
 * - `xref` segment → `raw || prettify`, where prettify is the web
 *   `KIND_LABEL` table (`equation→"Eq."`, `figure→"Fig."`, `table→"Table"`,
 *   `section→"Sec."`, `algorithm→"Alg."`, `code→"Listing"`) + " " + number
 *   when both `targetType` and `number` resolve, else the target `id`.
 * cite/xref are atomic segments too: creation expands a selection touching
 * them to the whole segment, so canonical offsets never point inside a chip.
 */

import { z } from "zod";
import type { IrBlock, IrSegment, IrXrefTargetType } from "./doc-ir.js";

// ---- Target ---------------------------------------------------------------- //

/** The structure-target kinds (roadmap §1: "section" is included even though
 *  it is not an IrBlock; reference entries are deliberately not supported). */
export const AnnotationStructureKindSchema = z.enum([
  "section",
  "paragraph",
  "list",
  "equation",
  "figure",
  "table",
  "code",
  "algorithm",
]);

/**
 * Creation-time content snapshot of a structure target. ONE object with
 * all-optional fields covering every kind (see the banner); writers fill
 * only the fields of the target's kind, readers must tolerate the rest.
 */
export const AnnotationSnapshotSchema = z.object({
  number: z.string().optional(),
  heading: z.string().optional(),
  text: z.string().optional(),
  ordered: z.boolean().optional(),
  items: z.array(z.string()).optional(),
  label: z.string().optional(),
  latex: z.string().optional(),
  caption: z.string().optional(),
  footnote: z.string().optional(),
  asset_hash: z.string().optional(),
  table_body: z.string().optional(),
  lang: z.string().optional(),
  body: z.string().optional(),
});

export const AnnotationDocumentTargetSchema = z.object({
  type: z.literal("document"),
});

export const AnnotationStructureTargetSchema = z.object({
  type: z.literal("structure"),
  /** Section/block id (`sec-N`/`p-N`/`fig-N`/…). */
  id: z.string().min(1),
  kind: AnnotationStructureKindSchema,
  snapshot: AnnotationSnapshotSchema,
});

/**
 * The logical container a text range lives in (roadmap §1): a paragraph's
 * content, a list item (by index), or the caption of a
 * figure/table/code/algorithm block. Equation bodies, code/algorithm bodies,
 * table bodies, and section headings are structure-anchor only.
 */
export const AnnotationTextContainerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("content") }),
  z.object({ type: z.literal("caption") }),
  z.object({ type: z.literal("list_item"), index: z.number().int().nonnegative() }),
]);

export const AnnotationTextTargetSchema = z
  .object({
    type: z.literal("text"),
    /** Id of the block carrying the container. */
    block: z.string().min(1),
    container: AnnotationTextContainerSchema,
    /** UTF-16 code-unit offsets into the container's canonical text. */
    start: z.number().int().nonnegative(),
    end: z.number().int(),
    /** `canonicalText.slice(start, end)` at creation time. */
    quote: z.string(),
  })
  .refine((t) => t.end > t.start, { message: "end must be greater than start" });

export const AnnotationTargetSchema = z.discriminatedUnion("type", [
  AnnotationDocumentTargetSchema,
  AnnotationStructureTargetSchema,
  AnnotationTextTargetSchema,
]);

// ---- Annotation ------------------------------------------------------------ //

export const AnnotationSchema = z
  .object({
    /** `a_<8 hex>` (crypto.randomBytes). */
    id: z.string().regex(/^a_[0-9a-f]{8}$/),
    target: AnnotationTargetSchema,
    /** Markdown + `$…$` math; raw bytes kept, but a trim-empty body is rejected. */
    body: z.string(),
    /** ISO-8601 timestamp. */
    created_at: z.iso.datetime(),
    /** ISO-8601 timestamp; bumps only when the body bytes change. */
    updated_at: z.iso.datetime(),
  })
  .refine((a) => a.body.trim() !== "", { message: "body must not be empty" });

// ---- AnnotationsFile -------------------------------------------------------- //

/**
 * One doc's `annotations/<doc_id>/current.json`. `content_fingerprint` binds
 * the file to the exact document content it was created against (core
 * `docContentFingerprint`, sha256); `rev` is the optimistic-lock version the
 * server checks on PUT and bumps on every accepted write — it restarts from
 * 0 on every new fingerprint epoch (invalidation archives the old current).
 */
export const AnnotationsFileSchema = z.object({
  version: z.literal(1),
  rev: z.number().int().nonnegative(),
  content_fingerprint: z.string(),
  annotations: z.array(AnnotationSchema),
});

// ---- WebSocket message (server → client) ------------------------------------ //

/**
 * Fired after a successful `PUT /api/paper/:doc_id/annotations`, after an
 * invalidation archived the current file, or when the annotations poller
 * spotted an external write; `cause` names the trigger. Same shape
 * discipline as `WsPlanChangedSchema` (optional `cause`, plain `at`), with
 * the doc this change belongs to.
 */
export const WsAnnotationChangedSchema = z.object({
  type: z.literal("annotation.changed"),
  doc_id: z.string().min(1),
  cause: z.enum(["put", "invalidate", "external"]).optional(),
  /** ISO-8601 timestamp. */
  at: z.string(),
});

// --------------------------------------------------------------------------- //
// Canonical annotation text (pure functions over IR segments — see the banner)
// --------------------------------------------------------------------------- //

/** The web reader's xref chip label table (`segments.tsx` `KIND_LABEL`). */
const XREF_KIND_LABEL: Record<IrXrefTargetType, string> = {
  equation: "Eq.",
  figure: "Fig.",
  table: "Table",
  section: "Sec.",
  algorithm: "Alg.",
  code: "Listing",
};

/** The canonical annotation text of one IR segment (see the banner rules). */
export function canonicalSegmentText(seg: IrSegment): string {
  switch (seg.type) {
    case "text":
      return seg.text;
    case "math":
      return `$${seg.latex}$`;
    case "cite":
      return (
        seg.raw ||
        seg.refs.map((r) => (r.resolved && r.short !== undefined ? r.short : r.id)).join("; ") ||
        "?"
      );
    case "xref": {
      if (seg.raw) return seg.raw;
      const t = seg.target;
      if (t.targetType !== undefined && t.number !== undefined) {
        return `${XREF_KIND_LABEL[t.targetType]} ${t.number}`;
      }
      return t.id;
    }
  }
}

/** The canonical annotation text of a segment run (concatenation). */
export function canonicalSegmentsText(segments: IrSegment[]): string {
  return segments.map(canonicalSegmentText).join("");
}

/**
 * The canonical annotation text of a text-target container on *block*
 * (paragraph content / list item / float caption). Throws when the container
 * does not exist on the block — a wrong container kind, a caption-less
 * float, or an out-of-range list index is a caller bug, never an empty
 * string.
 */
export function canonicalContainerText(block: IrBlock, container: AnnotationTextContainer): string {
  switch (container.type) {
    case "content":
      if (block.type !== "paragraph") {
        throw new Error(`annotations: block ${block.id} (${block.type}) has no content container`);
      }
      return canonicalSegmentsText(block.segments);
    case "list_item": {
      if (block.type !== "list") {
        throw new Error(`annotations: block ${block.id} (${block.type}) has no list items`);
      }
      const item = block.items[container.index];
      if (item === undefined) {
        throw new Error(
          `annotations: list item index ${container.index} out of range ` +
            `(block ${block.id} has ${block.items.length} items)`
        );
      }
      return canonicalSegmentsText(item.segments);
    }
    case "caption":
      if (
        block.type !== "figure" &&
        block.type !== "table" &&
        block.type !== "code" &&
        block.type !== "algorithm"
      ) {
        throw new Error(`annotations: block ${block.id} (${block.type}) has no caption container`);
      }
      if (block.captionSegments === undefined) {
        throw new Error(`annotations: block ${block.id} (${block.type}) has no caption`);
      }
      return canonicalSegmentsText(block.captionSegments);
  }
}

// --------------------------------------------------------------------------- //
// Inferred types
// --------------------------------------------------------------------------- //

export type AnnotationStructureKind = z.infer<typeof AnnotationStructureKindSchema>;
export type AnnotationSnapshot = z.infer<typeof AnnotationSnapshotSchema>;
export type AnnotationDocumentTarget = z.infer<typeof AnnotationDocumentTargetSchema>;
export type AnnotationStructureTarget = z.infer<typeof AnnotationStructureTargetSchema>;
export type AnnotationTextContainer = z.infer<typeof AnnotationTextContainerSchema>;
export type AnnotationTextTarget = z.infer<typeof AnnotationTextTargetSchema>;
export type AnnotationTarget = z.infer<typeof AnnotationTargetSchema>;
export type Annotation = z.infer<typeof AnnotationSchema>;
export type AnnotationsFile = z.infer<typeof AnnotationsFileSchema>;
export type WsAnnotationChanged = z.infer<typeof WsAnnotationChangedSchema>;
