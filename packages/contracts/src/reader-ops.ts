/**
 * The LaTeX Reader's page context and the closed operation union of the Copilot `reader` tool (copilot ticket 18).
 *
 * The reading representation is built from ONE admitted epoch (the coherent read the Reader itself shows): the
 * stored IR, the saved annotations of that same fingerprint and the digests of the assets it references. It is the
 * whole scrollable document, not the mounted rows: every section, paragraph, list item, equation, figure, full table
 * body, code/algorithm body, the whole bibliography, the cite/xref identities and the current annotations with
 * their full bodies. It is a new, separate encoding; the CLI's lossy Markdown renderer and its golden files are
 * untouched.
 *
 * Text fields are the CANONICAL annotation text of their container (math as `$..$`, cite/xref as the chip text),
 * so a selection's UTF-16 offsets index straight into `text`. Atomic segments (math, cite, xref) are listed as
 * `marks` with their offsets, and a cite/xref mark carries the identity the plain text loses.
 *
 * `format` is the discriminator for the future: a text Doc will add its own variant (no `main_tex`, no LaTeX
 * metadata invented for it) instead of reusing this one.
 *
 * Tool actions mirror Reader controls: `navigate` (outline, floats, reference cards, xref/cite chips, deep-link
 * anchors and the annotation list's "go to"), `jump_back` (the undo-navigation button), `set_panel` (the two side
 * panel folds), `set_right_tab` (the references/annotations tabs) and `retry_sync` (the sync/error "retry"
 * buttons). `read` is the background read of any Doc; it never moves a page.
 */
import { z } from "zod";
import {
  AnnotationSchema,
  type AnnotationsFile,
  AnnotationTextContainerSchema,
  AnnotationTextTargetSchema,
  canonicalSegmentsText,
} from "./annotations.js";
import type { IrBlock, IrSection, IrSegment } from "./doc-ir.js";
import { ReferenceSchema } from "./doc-ir.js";
import { PDF_ANNOTATION_ACTIONS } from "./pdf-annotation-ops.js";
import {
  PDF_VIEW_ACTIONS,
  PdfReadPageImageOperationSchema,
  PdfViewActionSchema,
} from "./pdf-ops.js";
import type { AssetDigest } from "./reader-coherence.js";
import { isTexDocIr, type StoredDocIr } from "./text-doc.js";

const Id = z.string().min(1).max(500);
const Count = z.number().int().nonnegative();

// ---- Reading representation -------------------------------------------------------------------------- //

/** An atomic segment of a text container, by canonical UTF-16 offsets `[start, end)`. */
export const ReaderMarkSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("math"), start: Count, end: Count }).strict(),
  z
    .object({
      type: z.literal("cite"),
      start: Count,
      end: Count,
      refs: z.array(z.object({ id: z.string(), resolved: z.boolean() }).strict()),
    })
    .strict(),
  z
    .object({
      type: z.literal("xref"),
      start: Count,
      end: Count,
      target: z
        .object({
          id: z.string(),
          resolved: z.boolean(),
          targetType: z.string().optional(),
          number: z.string().optional(),
        })
        .strict(),
    })
    .strict(),
]);
export type ReaderMark = z.infer<typeof ReaderMarkSchema>;

const ReaderTextSchema = z
  .object({ text: z.string(), marks: z.array(ReaderMarkSchema).optional() })
  .strict();
export type ReaderText = z.infer<typeof ReaderTextSchema>;

export const ReaderAssetSchema = z
  .object({
    path: z.string(),
    /** SHA-256 of the file as admitted with this epoch; null only when no manifest entry exists. */
    sha256: z.string().nullable(),
    width: z.number().optional(),
    height: z.number().optional(),
  })
  .strict();
const Numbered = {
  id: Id,
  number: z.string().optional(),
  label: z.string().optional(),
};

export const ReaderEntrySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("section"),
      id: Id,
      level: z.number().int(),
      number: z.string().optional(),
      heading: z.string().optional(),
      /** "1 Introduction › 1.2 Data": the same path the Reader's annotation list shows. */
      path: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("paragraph"),
      id: Id,
      text: z.string(),
      marks: z.array(ReaderMarkSchema).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("list"),
      id: Id,
      ordered: z.boolean(),
      items: z.array(ReaderTextSchema),
    })
    .strict(),
  z.object({ kind: z.literal("equation"), ...Numbered, latex: z.string() }).strict(),
  z
    .object({
      kind: z.literal("figure"),
      ...Numbered,
      caption: ReaderTextSchema.optional(),
      footnote: z.string().optional(),
      asset: ReaderAssetSchema.optional(),
      chartType: z.string().optional(),
      chartData: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("table"),
      ...Numbered,
      caption: ReaderTextSchema.optional(),
      footnote: z.string().optional(),
      /** The stored HTML serialization of the whole table, rows, spans and all. */
      body: z.string().optional(),
      /** The picture shown instead when the table was not recognised. */
      asset: ReaderAssetSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("code"),
      ...Numbered,
      caption: ReaderTextSchema.optional(),
      lang: z.string().optional(),
      body: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("algorithm"),
      ...Numbered,
      caption: ReaderTextSchema.optional(),
      body: z.string().optional(),
    })
    .strict(),
]);
export type ReaderEntry = z.infer<typeof ReaderEntrySchema>;

export const ReaderReferenceSchema = ReferenceSchema.extend({
  /** "Belokurov et al. 2006": the label the inline citations use. */
  short: z.string().optional(),
});
export type ReaderReference = z.infer<typeof ReaderReferenceSchema>;

const ReaderCoverageSchema = z
  .object({
    sections: Count,
    blocks: Count,
    references: Count,
    annotations: Count,
    assets: Count,
    /** Total length of all text fields: a size hint for capacity decisions. */
    characters: Count,
  })
  .strict();

export const ReaderReadingSchema = z.discriminatedUnion("format", [
  z
    .object({
      format: z.literal("latex"),
      docId: Id,
      title: z.string().optional(),
      /**
       * What binds the parts together: the content fingerprint of the admitted epoch, the annotations revision of
       * that same epoch, and (background reads only) whether the saved annotations belong to older content and are
       * therefore not shown.
       */
      epoch: z
        .object({
          fingerprint: z.string().min(1),
          annotationsRev: Count,
          annotations: z.enum(["current", "stale"]),
        })
        .strict(),
      latex: z
        .object({
          authors: z.array(z.string()).optional(),
          /** The author block the Reader shows: per author the 1-based affiliation numbers and email. */
          authorDetails: z
            .array(
              z
                .object({
                  name: z.string(),
                  affiliations: z.array(z.number().int()).optional(),
                  email: z.string().optional(),
                })
                .strict()
            )
            .optional(),
          affiliations: z.array(z.string()).optional(),
          email: z.string().optional(),
          nPages: Count.optional(),
          arxivId: z.string().optional(),
          doi: z.string().optional(),
        })
        .strict(),
      entries: z.array(ReaderEntrySchema),
      references: z.array(ReaderReferenceSchema),
      /** Block id → reference ids it cites, including citations without an inline chip. */
      citationsByBlock: z.record(z.string(), z.array(z.string())),
      annotations: z.array(AnnotationSchema),
      coverage: ReaderCoverageSchema,
    })
    .strict(),
]);
export type ReaderReading = z.infer<typeof ReaderReadingSchema>;

const sectionLabel = (section: { number?: string; heading?: string; id: string }) =>
  ((section.number ? `${section.number} ` : "") + (section.heading ?? "")).trim() || section.id;

function readerText(segments: IrSegment[]): ReaderText {
  let text = "";
  const marks: ReaderMark[] = [];
  for (const segment of segments) {
    const piece = canonicalSegmentsText([segment]);
    const start = text.length;
    text += piece;
    const end = text.length;
    if (segment.type === "math") marks.push({ type: "math", start, end });
    else if (segment.type === "cite")
      marks.push({
        type: "cite",
        start,
        end,
        refs: segment.refs.map((ref) => ({ id: ref.id, resolved: ref.resolved })),
      });
    else if (segment.type === "xref")
      marks.push({
        type: "xref",
        start,
        end,
        target: {
          id: segment.target.id,
          resolved: segment.target.resolved,
          ...(segment.target.targetType !== undefined
            ? { targetType: segment.target.targetType }
            : {}),
          ...(segment.target.number !== undefined ? { number: segment.target.number } : {}),
        },
      });
  }
  return marks.length ? { text, marks } : { text };
}

/**
 * The whole reading representation of one admitted epoch. Pure and deterministic: the same IR, annotations file and
 * asset manifest always give the same bytes. `stale` is for a background read whose saved annotations belong to
 * older content: they are not part of this document and are left out (the next normal access archives them).
 */
export function buildReaderReading(input: {
  ir: StoredDocIr;
  file: AnnotationsFile;
  assets: readonly AssetDigest[];
  stale?: boolean;
}): ReaderReading {
  const { file } = input;
  const ir = input.ir;
  // The whole-reading representation is the LaTeX one; a text Doc gets its own with the text tools.
  if (!isTexDocIr(ir))
    throw new Error("buildReaderReading: a text document has no Reader reading yet");
  const digest = new Map(input.assets.map((asset) => [asset.imgPath, asset.sha256]));
  const asset = (path: string | undefined, width?: number, height?: number) =>
    path === undefined
      ? undefined
      : {
          path,
          sha256: digest.get(path) ?? null,
          ...(width !== undefined ? { width } : {}),
          ...(height !== undefined ? { height } : {}),
        };
  let characters = 0;
  let blocks = 0;
  let sections = 0;
  const assetPaths = new Set<string>();
  const entries: ReaderEntry[] = [];
  const count = (...parts: (string | undefined)[]) => {
    for (const part of parts) characters += part?.length ?? 0;
  };
  const caption = (segments: IrSegment[] | undefined) => {
    if (segments === undefined) return undefined;
    const value = readerText(segments);
    count(value.text);
    return value;
  };
  const withAsset = (path: string | undefined, width?: number, height?: number) => {
    const value = asset(path, width, height);
    if (value) assetPaths.add(value.path);
    return value ? { asset: value } : {};
  };
  const block = (b: IrBlock): ReaderEntry => {
    blocks += 1;
    switch (b.type) {
      case "paragraph": {
        const value = readerText(b.segments);
        count(value.text);
        return { kind: "paragraph", id: b.id, ...value };
      }
      case "list": {
        const items = b.items.map((item) => readerText(item.segments));
        for (const item of items) count(item.text);
        return { kind: "list", id: b.id, ordered: b.ordered, items };
      }
      case "equation":
        count(b.latex);
        return {
          kind: "equation",
          id: b.id,
          ...(b.number !== undefined ? { number: b.number } : {}),
          ...(b.label !== undefined ? { label: b.label } : {}),
          latex: b.latex,
        };
      case "figure": {
        const cap = caption(b.captionSegments);
        count(b.footnote, b.content);
        return {
          kind: "figure",
          id: b.id,
          ...(b.number !== undefined ? { number: b.number } : {}),
          ...(b.label !== undefined ? { label: b.label } : {}),
          ...(cap ? { caption: cap } : {}),
          ...(b.footnote !== undefined ? { footnote: b.footnote } : {}),
          ...withAsset(b.imgPath, b.imgWidth, b.imgHeight),
          ...(b.chartType !== undefined ? { chartType: b.chartType } : {}),
          ...(b.content !== undefined ? { chartData: b.content } : {}),
        };
      }
      case "table": {
        const cap = caption(b.captionSegments);
        count(b.footnote, b.tableBody);
        return {
          kind: "table",
          id: b.id,
          ...(b.number !== undefined ? { number: b.number } : {}),
          ...(b.label !== undefined ? { label: b.label } : {}),
          ...(cap ? { caption: cap } : {}),
          ...(b.footnote !== undefined ? { footnote: b.footnote } : {}),
          ...(b.tableBody !== undefined ? { body: b.tableBody } : {}),
          ...withAsset(b.imgPath),
        };
      }
      case "code": {
        const cap = caption(b.captionSegments);
        count(b.body);
        return {
          kind: "code",
          id: b.id,
          ...(b.number !== undefined ? { number: b.number } : {}),
          ...(b.label !== undefined ? { label: b.label } : {}),
          ...(cap ? { caption: cap } : {}),
          ...(b.lang !== undefined ? { lang: b.lang } : {}),
          ...(b.body !== undefined ? { body: b.body } : {}),
        };
      }
      case "algorithm": {
        const cap = caption(b.captionSegments);
        count(b.body);
        return {
          kind: "algorithm",
          id: b.id,
          ...(b.number !== undefined ? { number: b.number } : {}),
          ...(b.label !== undefined ? { label: b.label } : {}),
          ...(cap ? { caption: cap } : {}),
          ...(b.body !== undefined ? { body: b.body } : {}),
        };
      }
    }
  };
  const walk = (list: IrSection[], parentPath: string | null) => {
    for (const section of list) {
      sections += 1;
      const path = parentPath ? `${parentPath} › ${sectionLabel(section)}` : sectionLabel(section);
      count(section.heading);
      entries.push({
        kind: "section",
        id: section.id,
        level: section.level,
        ...(section.number !== undefined ? { number: section.number } : {}),
        ...(section.heading !== undefined ? { heading: section.heading } : {}),
        path,
      });
      for (const b of section.blocks) entries.push(block(b));
      walk(section.children, path);
    }
  };
  walk(ir.sections, null);

  const stored = new Map((ir.references ?? []).map((reference) => [reference.id, reference]));
  const references: ReaderReference[] = ir.bib.map((row) => {
    const reference = stored.get(row.id);
    stored.delete(row.id);
    return reference
      ? { ...reference, short: row.short }
      : {
          id: row.id,
          raw: row.raw,
          short: row.short,
          ...(row.title !== undefined ? { title: row.title } : {}),
          ...(row.year !== undefined ? { year: row.year } : {}),
          ...(row.venue !== undefined ? { venue: row.venue } : {}),
          ...(row.doi !== undefined ? { doi: row.doi } : {}),
          ...(row.arxiv_id !== undefined ? { arxiv_id: row.arxiv_id } : {}),
        };
  });
  for (const rest of stored.values()) references.push(rest);
  for (const reference of references) count(reference.raw);
  const annotations = input.stale ? [] : file.annotations;
  for (const annotation of annotations) count(annotation.body);

  return {
    format: "latex",
    docId: ir.docId,
    ...(ir.title !== undefined ? { title: ir.title } : {}),
    epoch: {
      fingerprint: file.content_fingerprint,
      annotationsRev: file.rev,
      annotations: input.stale ? "stale" : "current",
    },
    latex: {
      ...(ir.meta.authors !== undefined ? { authors: ir.meta.authors } : {}),
      ...(ir.meta.authorDetails !== undefined
        ? {
            authorDetails: ir.meta.authorDetails.map((author) => ({
              name: author.name,
              ...(author.affiliations !== undefined ? { affiliations: author.affiliations } : {}),
              ...(author.email !== undefined ? { email: author.email } : {}),
            })),
          }
        : {}),
      ...(ir.meta.affiliations !== undefined ? { affiliations: ir.meta.affiliations } : {}),
      ...(ir.meta.email !== undefined ? { email: ir.meta.email } : {}),
      ...(ir.nPages !== undefined ? { nPages: ir.nPages } : {}),
      ...(ir.source.arxiv_id !== undefined ? { arxivId: ir.source.arxiv_id } : {}),
      ...(ir.source.doi !== undefined ? { doi: ir.source.doi } : {}),
    },
    entries,
    references,
    citationsByBlock: ir.citationsByBlock,
    annotations,
    coverage: {
      sections,
      blocks,
      references: references.length,
      annotations: annotations.length,
      assets: assetPaths.size,
      characters,
    },
  };
}

// ---- Page context ------------------------------------------------------------------------------------ //

export const READER_RIGHT_TABS = ["references", "annotations"] as const;
export const READER_PANELS = ["outline", "right"] as const;
export type ReaderRightTab = (typeof READER_RIGHT_TABS)[number];
export type ReaderPanel = (typeof READER_PANELS)[number];

/**
 * The user's text selection, bound to the epoch it was made in. `target` is exactly what the annotation editor
 * would create from it: one container, canonical UTF-16 offsets, atomic segments already expanded. A selection of a
 * different epoch is never carried (the page drops it), and the page schema rejects one that names another.
 */
export const ReaderSelectionSchema = z
  .object({ fingerprint: z.string().min(1), target: AnnotationTextTargetSchema })
  .strict();
export type ReaderSelection = z.infer<typeof ReaderSelectionSchema>;

const ReaderPageBase = z
  .object({
    docId: Id,
    format: z.literal("latex"),
    /** `ready`: the reading below is what the page shows. Otherwise the page keeps old text but offers no reading. */
    sync: z
      .object({
        phase: z.enum(["ready", "syncing", "error", "missing"]),
        reason: z.enum(["busy", "read", "asset", "document-changed"]).optional(),
      })
      .strict(),
    reading: ReaderReadingSchema.nullable(),
    /**
     * Published only: the reading is the one the service already holds for this view (same Doc, fingerprint and
     * annotations revision), so a scroll does not upload the whole document again. The service puts the reading back
     * before anything reads the page; it answers `stale` when it holds no such reading and the view sends it whole.
     */
    readingRef: z
      .object({ fingerprint: z.string().min(1), annotationsRev: Count })
      .strict()
      .optional(),
    /**
     * Only in a later page observation (service-written, never accepted from a view): the reading was left out
     * (see `observationPage`).
     */
    readingOmitted: z
      .object({
        fingerprint: z.string().min(1),
        annotationsRev: Count,
        coverage: ReaderCoverageSchema,
        note: z.string(),
      })
      .strict()
      .optional(),
    /** A hint, never a limit: the section under the reading line and the blocks inside it. */
    position: z
      .object({
        activeSectionId: z.string().nullable(),
        visibleBlockIds: z.array(z.string()).max(1000),
      })
      .strict()
      .nullable(),
    selection: ReaderSelectionSchema.nullable(),
    /** The annotation whose popover is open (the one the user is looking at), if any. */
    openAnnotationId: z.string().nullable().optional(),
    panels: z
      .object({
        outlineCollapsed: z.boolean(),
        rightCollapsed: z.boolean(),
        rightTab: z.enum(READER_RIGHT_TABS),
      })
      .strict(),
    /** The undo-navigation button is showing. */
    canGoBack: z.boolean(),
    /**
     * Annotation text the user has typed and not saved (the page's own retained drafts). Presence only, never the
     * text: a write the agent makes never replaces a draft, and a draft is never saved for the user.
     */
    drafts: z
      .object({
        create: z.boolean(),
        edit: z.array(z.object({ annotationId: z.string(), blocked: z.boolean() }).strict()),
      })
      .strict()
      .optional(),
  })
  .strict();

function checkReaderPage(
  page: z.infer<typeof ReaderPageBase>,
  ctx: z.RefinementCtx,
  observation: boolean
) {
  if (page.reading !== null && page.sync.phase !== "ready")
    ctx.addIssue({ code: "custom", message: "a reading exists only for an admitted epoch" });
  if (!observation && page.readingOmitted !== undefined)
    ctx.addIssue({ code: "custom", message: "a view cannot publish an omitted reading" });
  if (observation && page.readingRef !== undefined)
    ctx.addIssue({ code: "custom", message: "an observation holds no reading reference" });
  if (page.reading !== null && page.readingRef !== undefined)
    ctx.addIssue({ code: "custom", message: "a reading and a reference to it are exclusive" });
  const epoch =
    page.reading?.epoch.fingerprint ??
    page.readingRef?.fingerprint ??
    page.readingOmitted?.fingerprint;
  if (page.selection !== null && page.selection.fingerprint !== epoch)
    ctx.addIssue({ code: "custom", message: "selection must name the epoch of the reading" });
}
/** What a view publishes. */
export const ReaderPageSchema = ReaderPageBase.superRefine((page, ctx) =>
  checkReaderPage(page, ctx, false)
);
/** What a later page observation shows the model (written by the service). */
export const ReaderObservationPageSchema = ReaderPageBase.superRefine((page, ctx) =>
  checkReaderPage(page, ctx, true)
);
export type ReaderPage = z.infer<typeof ReaderPageSchema>;

/** What a message records of the Reader it carried (identity and sizes; the content itself is in the history). */
export const ReaderContextSummarySchema = z
  .object({
    docId: Id,
    format: z.literal("latex"),
    phase: z.enum(["ready", "syncing", "error", "missing"]),
    fingerprint: z.string().nullable(),
    sections: Count,
    blocks: Count,
    references: Count,
    annotations: Count,
    characters: Count,
    selection: z.boolean(),
    activeSectionId: z.string().nullable(),
    /** The reading section's path ("1 Introduction › 1.2 Data") when the reading is at hand. */
    activeSectionLabel: z.string().optional(),
  })
  .strict();
export type ReaderContextSummary = z.infer<typeof ReaderContextSummarySchema>;

export function summarizeReaderPage(page: ReaderPage): ReaderContextSummary {
  const coverage = page.reading?.coverage;
  const active = page.position?.activeSectionId;
  const section = active
    ? page.reading?.entries.find((entry) => entry.kind === "section" && entry.id === active)
    : undefined;
  const label = section?.kind === "section" ? section.path : undefined;
  return {
    docId: page.docId,
    format: page.format,
    phase: page.sync.phase,
    fingerprint: page.reading?.epoch.fingerprint ?? null,
    sections: coverage?.sections ?? 0,
    blocks: coverage?.blocks ?? 0,
    references: coverage?.references ?? 0,
    annotations: coverage?.annotations ?? 0,
    characters: coverage?.characters ?? 0,
    selection: page.selection !== null,
    activeSectionId: page.position?.activeSectionId ?? null,
    ...(label ? { activeSectionLabel: label } : {}),
  };
}

// ---- Tool operations --------------------------------------------------------------------------------- //

export const ReaderReadOperationSchema = z
  .object({ action: z.literal("read"), docId: Id })
  .strict();
export type ReaderReadOperation = z.infer<typeof ReaderReadOperationSchema>;
/** One original PDF page as an image (copilot ticket 20); see `pdf-ops`. */
export const ReaderReadPageImageOperationSchema = PdfReadPageImageOperationSchema;

/** View operations run in the bound browser's Reader, through the Reader's own controllers. */
export const ReaderViewActionSchema = z.discriminatedUnion("action", [
  /**
   * Scroll to a deep-link anchor of the Doc: a section, block or float id, a reference id (its first citing block,
   * then its card), or `ann-<annotation id>` (the target block, the annotation activated and opened).
   */
  z.object({ action: z.literal("navigate"), docId: Id, anchor: Id }).strict(),
  /** The undo-navigation button (back to where the last jump started). */
  z.object({ action: z.literal("jump_back"), docId: Id }).strict(),
  /** The outline panel's and the right panel's fold buttons. */
  z
    .object({
      action: z.literal("set_panel"),
      docId: Id,
      panel: z.enum(READER_PANELS),
      collapsed: z.boolean(),
    })
    .strict(),
  /** The right panel's References / Annotations tabs. */
  z
    .object({ action: z.literal("set_right_tab"), docId: Id, tab: z.enum(READER_RIGHT_TABS) })
    .strict(),
  /** The Retry buttons of the sync/error banner, the load-error page and the annotations panel. */
  z.object({ action: z.literal("retry_sync"), docId: Id }).strict(),
  /** The PDF Reader's own controls (copilot ticket 20): pages are zero-based here. */
  ...PdfViewActionSchema.options,
]);
export type ReaderViewAction = z.infer<typeof ReaderViewActionSchema>;

export const READER_VIEW_ACTIONS = [
  "navigate",
  "jump_back",
  "set_panel",
  "set_right_tab",
  "retry_sync",
  ...PDF_VIEW_ACTIONS,
] as const;

// ---- Annotation writes (copilot ticket 19) ---------------------------------------------------------- //

/** Longest annotation body a tool call may carry (input sanity for the history; the page's editor has no limit). */
export const READER_ANNOTATION_BODY_MAX = 100_000;
const Fingerprint = z.string().min(1).max(200);
/**
 * Every write names the epoch it was planned against, exactly as the page's PUT does: the content fingerprint AND
 * the annotations revision of the reading it read (`reading.epoch`). A write whose epoch is no longer current is
 * refused (`conflict`); the agent reads again and forms a new request. Never replace the numbers and resend.
 */
const WriteEpoch = { docId: Id, fingerprint: Fingerprint, rev: Count };
/**
 * The state of the annotation as you last read it: its `updated_at` (it changes exactly when the body bytes change).
 * Update and delete are refused (`conflict`, reason `annotation_changed`) when the stored annotation no longer has it,
 * even if the epoch numbers are current again, so a body the user saved after your reading is never overwritten or
 * deleted by a request you planned from the old text.
 */
const ExpectedUpdatedAt = z.iso.datetime();
/** A body is Markdown+math with its bytes kept as given; trim-empty is refused like the editor's Save. */
const AnnotationBody = z
  .string()
  .max(READER_ANNOTATION_BODY_MAX)
  .refine((body) => body.trim() !== "", { message: "body must not be empty" });

/**
 * Where a new annotation goes, in the three forms the UI offers: the whole document (the panel's button), a
 * structure (the block edge buttons; kind and snapshot come from the stored document, not from the caller) or a
 * text range (the selection toolbar: one container, canonical UTF-16 offsets, math/cite/xref atomic).
 */
export const ReaderAnnotationTargetInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("document") }).strict(),
  z.object({ type: z.literal("structure"), id: Id }).strict(),
  z
    .object({
      type: z.literal("text"),
      block: Id,
      container: AnnotationTextContainerSchema,
      start: Count,
      end: Count,
      /**
       * Required: the exact canonical text at [start, end) AS YOU COUNTED IT (before any widening of a range that
       * touches the inside of a math/cite/xref mark). It must equal that slice, so offsets that were counted wrong,
       * or that are resent after the document changed, can never anchor to different text.
       */
      quote: z.string().min(1),
    })
    .strict(),
]);
export type ReaderAnnotationTargetInput = z.infer<typeof ReaderAnnotationTargetInputSchema>;

export const ReaderWriteOperationSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create_annotation"),
      ...WriteEpoch,
      target: ReaderAnnotationTargetInputSchema,
      body: AnnotationBody,
    })
    .strict(),
  /** The editor's Save on an existing annotation: only the body changes; target, snapshot and created_at never do. */
  z
    .object({
      action: z.literal("update_annotation"),
      ...WriteEpoch,
      annotationId: z.string().regex(/^a_[0-9a-f]{8}$/),
      expectedUpdatedAt: ExpectedUpdatedAt,
      body: AnnotationBody,
    })
    .strict(),
  /** The trash button: one annotation, at once (the UI asks no confirmation for a single annotation). */
  z
    .object({
      action: z.literal("delete_annotation"),
      ...WriteEpoch,
      annotationId: z.string().regex(/^a_[0-9a-f]{8}$/),
      expectedUpdatedAt: ExpectedUpdatedAt,
    })
    .strict(),
]);
export type ReaderWriteOperation = z.infer<typeof ReaderWriteOperationSchema>;
export const READER_WRITE_ACTIONS = [
  "create_annotation",
  "update_annotation",
  "delete_annotation",
] as const;
export const READER_OPERATION_ACTIONS = [
  "read",
  "read_page_image",
  ...READER_VIEW_ACTIONS,
  ...READER_WRITE_ACTIONS,
  ...PDF_ANNOTATION_ACTIONS,
] as const;

// ---- Shared context helpers -------------------------------------------------------------------------- //

/**
 * The objects a message's page names, with the version each was captured at. One function for the host (when it
 * records a message) and for the history check (when it loads one): the two must agree or a reload fails.
 * The Library names the open work, the Reader the Doc it shows, a Plan page its plans.
 */
export function copilotContextObjects(context: {
  plan?: { rev: number; plans: { id: string }[]; detail: { planId: string } | null } | null;
  library?: { selectedRefId: string | null } | null;
  reader?: { docId: string } | null;
  pdf?: { docId: string } | null;
  writer?: {
    editor: {
      manuscriptId: string;
      saved: { rev: number } | null;
      savedOmitted?: { rev: number };
    } | null;
  } | null;
}): { id: string; rev: number }[] {
  if (context.library?.selectedRefId) return [{ id: context.library.selectedRefId, rev: 0 }];
  if (context.reader) return [{ id: context.reader.docId, rev: 0 }];
  if (context.pdf) return [{ id: context.pdf.docId, rev: 0 }];
  // The manuscript an open Writer shows, at the revision it was captured at (the list names no one object).
  const editor = context.writer?.editor;
  if (editor)
    return [{ id: editor.manuscriptId, rev: editor.saved?.rev ?? editor.savedOmitted?.rev ?? 0 }];
  const page = context.plan;
  const objects = page ? page.plans.map((plan) => ({ id: plan.id, rev: page.rev })) : [];
  const detail = page?.detail;
  if (page && detail && !objects.some((object) => object.id === detail.planId))
    objects.push({ id: detail.planId, rev: page.rev });
  return objects;
}

/**
 * A page as a later observation shows it to the model. A reading the task's own context already holds (same Doc and
 * fingerprint, `held` holds `"<docId>:<fingerprint>"` keys) is left out, because repeating a document on every
 * scroll would fill the window; any other reading (another Doc, a new epoch) is not in the task's context, so it is
 * left out with a note to call `reader.read`, never presented as known.
 */
export function readingKey(docId: string, fingerprint: string): string {
  return `${docId}:${fingerprint}`;
}
export function observationPage<T extends { reader?: ReaderPage | null }>(
  page: T,
  held: ReadonlySet<string> = new Set()
): T {
  if (!page.reader?.reading) return page;
  const { reading, readingOmitted: _omitted, readingRef: _ref, ...rest } = page.reader;
  const known = held.has(readingKey(reading.docId, reading.epoch.fingerprint));
  return {
    ...page,
    reader: {
      ...rest,
      reading: null,
      readingOmitted: {
        fingerprint: reading.epoch.fingerprint,
        annotationsRev: reading.epoch.annotationsRev,
        coverage: reading.coverage,
        note: known
          ? "the full reading is in the task's context; call reader.read for the current one"
          : "this reading is not in the task's context (another Doc or a new epoch); call reader.read for it",
      },
    },
  } as unknown as T;
}
