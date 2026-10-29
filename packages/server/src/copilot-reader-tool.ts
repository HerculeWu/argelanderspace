import {
  type Annotation,
  buildPdfReading,
  type CopilotOperation,
  IMAGE_BYTES_PER_TOKEN,
  imageTokens,
  type PageContext,
  PDF_ANNOTATION_ACTIONS,
  PDF_ANNOTATION_KINDS,
  PDF_IMAGE_HISTORY_MAX_BYTES,
  PDF_IMAGE_LONG_EDGE,
  PDF_IMAGE_MAX_BYTES,
  PDF_NO_IMAGE_NOTICE,
  PDF_RECTANGLE_MIN,
  type PdfAnnotation,
  type PdfAnnotationOperation,
  PdfAnnotationOperationSchema,
  PdfHighlightColorSchema,
  type PdfSearchState,
  type PdfSourceMaterial,
  parseCatalogCall,
  READER_OPERATION_ACTIONS,
  READER_PANELS,
  READER_RIGHT_TABS,
  READER_WRITE_ACTIONS,
  ReaderReadImageOperationSchema,
  type ReaderReading,
  ReaderReadOperationSchema,
  ReaderReadPageImageOperationSchema,
  ReaderReadSvgImageOperationSchema,
  type ReaderViewAction,
  ReaderViewActionSchema,
  type ReaderWriteOperation,
} from "@argelanderspace/contracts";
import { sniffImage, TextAssetError } from "@argelanderspace/core";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { pdfBatch, pdfVersion, readerBatch, readerVersion } from "./copilot-batching.js";
import {
  done,
  type Part,
  record as recordFor,
  type ToolHostContext,
  type ToolResult,
} from "./copilot-tool-kit.js";
import { type ViewActionOutcome, viewOutcomeResult } from "./copilot-workspace-tool.js";
import { runPdfWrite, runReaderWrite } from "./reader-operations.js";
import { renderSvgFigure, type SvgEngine } from "./svg-raster.js";

export const READER_TOOL_NAME = "reader";

/**
 * What a background read of one Doc found. `stale` annotations belong to older content and were left out (they are
 * archived by the next normal access, never by this read).
 */
export type ReaderReadOutcome =
  | { kind: "ok"; reading: ReaderReading }
  | { kind: "not_found" }
  | { kind: "busy" }
  | { kind: "pdf" }
  | { kind: "error"; detail: string };

/**
 * What a write found. `conflict` names the epoch that is current now (so the agent can tell a replaced document from
 * a changed annotation list, and reads again); `unchanged` means the bytes are what is stored (no write happened).
 */
export type ReaderWriteOutcome =
  | ({
      kind: "saved";
      annotation?: Annotation;
      deleted?: string;
      expanded?: boolean;
      label: string;
      epoch: { fingerprint: string; annotationsRev: number };
    } & ArchivedNote)
  | ({
      kind: "unchanged";
      annotation: Annotation;
      label: string;
      epoch: { fingerprint: string; annotationsRev: number };
    } & ArchivedNote)
  | ({
      kind: "conflict";
      reason: "document_changed" | "rev_mismatch" | "annotation_changed";
      epoch: { fingerprint: string | null; annotationsRev: number };
      /** With `annotation_changed`: the annotation as it is stored now. */
      annotation?: Annotation;
    } & ArchivedNote)
  | ({ kind: "no_annotation"; annotationId: string } & ArchivedNote)
  | ({ kind: "invalid"; detail: string } & ArchivedNote)
  | { kind: "not_found" }
  | { kind: "busy" }
  | { kind: "pdf" }
  | {
      kind: "error";
      detail: string /** The old batch was archived before the failure. */;
      archivedOlder?: boolean;
    };
/** This very access found the Doc's text replaced and archived this many annotations of the older text. */
type ArchivedNote = { archived?: number };

/** What a background read of one PDF Doc's material found (copilot ticket 20). */
export type PdfReadOutcome =
  | { kind: "ok"; material: PdfSourceMaterial }
  | { kind: "not_found" }
  | { kind: "busy" }
  | { kind: "changed" }
  | { kind: "resource"; detail: string }
  | { kind: "error"; detail: string };
/** One original page as a PNG, from the same verified bytes as the text. */
export type PdfImageOutcome =
  | {
      kind: "ok";
      png: Buffer;
      contentSha256: string;
      pageIndex: number;
      pageCount: number;
      width: number;
      height: number;
      hasTextLayer: boolean;
    }
  | { kind: "not_found" }
  | { kind: "busy" }
  | { kind: "changed" }
  | { kind: "invalid"; detail: string }
  | { kind: "resource"; detail: string }
  | { kind: "error"; detail: string };
/**
 * What a PDF annotation write found (copilot ticket 21). `epoch` is the original's SHA-256 and the sidecar revision
 * AFTER the write (or the current one for a refusal), the numbers the next request is planned from.
 */
export type PdfWriteOutcome =
  | {
      kind: "saved";
      annotation?: PdfAnnotation;
      deleted?: string;
      label: string;
      epoch: { sha256: string; annotationsRev: number };
      /** The undo/redo this call performed (its changes are the ones restored). */
      moved?: "undo" | "redo";
      history: { canUndo: boolean; canRedo: boolean };
    }
  | {
      kind: "unchanged";
      annotation: PdfAnnotation;
      label: string;
      epoch: { sha256: string; annotationsRev: number };
    }
  | {
      kind: "conflict";
      reason: "document_changed" | "rev_mismatch" | "annotation_changed";
      epoch: { sha256: string | null; annotationsRev: number | null };
      annotation?: PdfAnnotation;
    }
  /** Undo/redo had nothing to do (the buttons are disabled): no history, or a revision of someone else ended it. */
  | {
      kind: "nothing";
      reason: "nothing" | "history_ended" | "changed";
      epoch: { sha256: string; annotationsRev: number };
    }
  | { kind: "no_annotation"; annotationId: string }
  | { kind: "invalid"; detail: string }
  /** The Doc is not a PDF (a LaTeX Doc): these actions do not apply to it. */
  | { kind: "unsupported" }
  | { kind: "not_found" }
  | { kind: "busy" }
  | { kind: "error"; detail: string };

export type AssetImageOutcome =
  | { kind: "ok"; bytes: Buffer; sha256: string }
  | { kind: "not_found" }
  | { kind: "busy" }
  | { kind: "changed" }
  | { kind: "invalid"; detail: string }
  | { kind: "error"; detail: string };

export interface PdfOpDeps {
  /** The PDF annotation writes: the same lock, checks, save and notification as the page's own save. */
  write?: (
    operation: PdfAnnotationOperation,
    /** Whose changes undo and redo may reach: the conversation that makes them. */
    scope: { conversationId: string }
  ) => Promise<PdfWriteOutcome>;
  read: (docId: string) => Promise<PdfReadOutcome>;
  image: (op: {
    docId: string;
    pageIndex: number;
    sha256?: string;
    longEdge?: number;
  }) => Promise<PdfImageOutcome>;
}

/**
 * The Reader's data seam. `read` is one read-only pass over the Doc's IR, assets and current annotations. `write` is
 * the annotations PUT's own handler: the same lock, three-state fingerprint rules, double check, save and
 * notification as the page's Save; the tool never ensures, archives or writes a file itself.
 */
export interface ReaderOpDeps {
  /** The PDF Doc's material (copilot ticket 20); absent in hosts without a PDF engine. */
  pdf?: PdfOpDeps;
  /** One picture of a LaTeX or text Doc, the very bytes the images route serves, hash-checked (copilot ticket 30). */
  asset?: (op: { docId: string; path: string; sha256: string }) => Promise<AssetImageOutcome>;
  read: (docId: string) => Promise<ReaderReadOutcome>;
  write: (operation: ReaderWriteOperation) => Promise<ReaderWriteOutcome>;
}

export interface ReaderToolContext extends ToolHostContext {
  reader: ReaderOpDeps;
  /** The conversation this tool serves (the owner of the PDF annotation undo history it builds). */
  conversationId: string;
  /** Resolves only after the bound browser view reports the outcome. */
  viewAction: (action: ReaderViewAction) => Promise<ViewActionOutcome>;
  /** Whether the SELECTED model takes images (its own capability); a model that cannot never gets a page image. */
  modelAcceptsImages?: () => boolean;
  /** The bound view's latest page (the PDF search results the Reader shows after a search). */
  page?: () => PageContext | undefined;
  /**
   * Bytes this conversation can still take in one tool result (the model's window less what is already in it).
   * A reading larger than that is refused whole, with its size, instead of being cut or poisoning the history.
   */
  budget?: () => number;
  /**
   * Ticket 24: take every earlier reading delivery out of the conversation and return the room there is then. Asked
   * only when a reading did not fit whole, so a document larger than the window can be read part by part.
   */
  reclaim?: () => number;
  /** The SVG renderer (default: the optional resvg component); tests may pass another or null for "not installed". */
  svgEngine?: SvgEngine | null;
  /** Decoded bytes of all images already in this conversation's history (the total cap applies to it plus a new image). */
  imageBytesUsed?: () => number;
}

const lit = <T extends string>(values: readonly T[]) =>
  Type.Unsafe<T>({ type: "string", enum: [...values] });

const PDF_HIGHLIGHT_COLORS = PdfHighlightColorSchema.options;

const parameters = Type.Object(
  {
    action: lit(READER_OPERATION_ACTIONS),
    docId: Type.String({
      description: "The Doc id (for example arxiv-2601.00001). Every action names its own Doc.",
    }),
    anchor: Type.Optional(
      Type.String({
        description:
          "navigate: a deep-link anchor of the Doc: a section, block or float id from the reading (sec-3, p-12, fig-2, tab-1, eq-4), a reference id, or ann-<annotation id>.",
      })
    ),
    pageIndex: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          "PDF: a ZERO-BASED page index (the first page is 0; the Reader shows it as page 1). read_page_image, goto_page.",
      })
    ),
    sha256: Type.Optional(
      Type.String({
        description:
          "read_page_image and every PDF annotation write: REQUIRED, reading.sha256 of the PDF reading you are working from; a different original is refused (conflict). read_image: the picture's asset.sha256.",
      })
    ),
    path: Type.Optional(
      Type.String({
        description:
          "read_image: the picture's asset.path from the reading entry (a figure, or a table that is only a picture).",
      })
    ),
    longEdge: Type.Optional(
      Type.Integer({
        minimum: PDF_IMAGE_LONG_EDGE.min,
        maximum: PDF_IMAGE_LONG_EDGE.max,
        description: `read_page_image: resolution, the longer edge of the image in pixels (default ${PDF_IMAGE_LONG_EDGE.default}); ask for more when text in the page is not legible.`,
      })
    ),
    from: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          "read: continue a document delivered in parts. The zero-based index of the first entry (Reader) or page (PDF) not yet read: the `to` of the previous part's batch. Omit it to start at the beginning.",
      })
    ),
    version: Type.Optional(
      Type.String({
        description:
          "read with from: the version of the parts already read, exactly batch.version of the previous part. A document that changed since is refused (conflict, version_changed): start again at from 0.",
      })
    ),
    query: Type.Optional(Type.String({ description: "PDF search: the text to find." })),
    index: Type.Optional(
      Type.Integer({ minimum: 0, description: "open_search_result: 0-based result index." })
    ),
    outlineId: Type.Optional(
      Type.String({ description: "open_outline_item: an outline id from the PDF reading." })
    ),
    mode: Type.Optional(lit(["in", "out", "fit_width", "fit_page"] as const)),
    view: Type.Optional(
      Type.Unsafe<"reader" | "source">({
        type: "string",
        enum: ["reader", "source"],
        description:
          "set_text_view: a text Doc's tab, its reading (reader) or its Markdown source (source).",
      })
    ),
    panel: Type.Optional(lit(READER_PANELS)),
    collapsed: Type.Optional(Type.Boolean({ description: "set_panel: true folds the panel." })),
    tab: Type.Optional(lit(READER_RIGHT_TABS)),
    fingerprint: Type.Optional(
      Type.String({
        description:
          "create/update/delete_annotation: reading.epoch.fingerprint of the reading you planned the write from.",
      })
    ),
    rev: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          "create/update/delete_annotation: reading.epoch.annotationsRev of that same reading. PDF create/update/delete/undo/redo_pdf_annotation: reading.annotationsRev of the PDF reading (or the epoch.annotationsRev of your last PDF write result).",
      })
    ),
    annotationId: Type.Optional(
      Type.String({
        description:
          "update/delete_annotation: the annotation id (a_ and 8 hex digits). update/delete_pdf_annotation and open_annotation: a PDF workbench annotation id from the PDF reading.",
      })
    ),
    expectedUpdatedAt: Type.Optional(
      Type.String({
        description:
          "update/delete_annotation and update/delete_pdf_annotation: that annotation's updated_at exactly as your latest reading (or write result) showed it. It changes whenever the body changes; if it no longer matches, the annotation was edited after your reading and the call is refused (conflict annotation_changed).",
      })
    ),
    body: Type.Optional(
      Type.String({
        description:
          "create/update_annotation and create/update_pdf_annotation: the annotation text, Markdown with $math$; saved byte for byte, must not be blank.",
      })
    ),
    kind: Type.Optional(
      Type.Unsafe<(typeof PDF_ANNOTATION_KINDS)[number]>({
        type: "string",
        enum: [...PDF_ANNOTATION_KINDS],
        description:
          "create_pdf_annotation: rectangle (the area tool: pageIndex + rectangle), page_comment (pageIndex), document_comment, or highlight / underline / strikeout (the text tools: parts; highlight may take a colour).",
      })
    ),
    rectangle: Type.Optional(
      Type.Object(
        {
          x: Type.Number({ minimum: 0, maximum: 1 }),
          y: Type.Number({ minimum: 0, maximum: 1 }),
          width: Type.Number({ minimum: PDF_RECTANGLE_MIN, maximum: 1 }),
          height: Type.Number({ minimum: PDF_RECTANGLE_MIN, maximum: 1 }),
        },
        {
          additionalProperties: false,
          description:
            "PDF create (kind rectangle) / update (rectangle): the area in fractions of the VISIBLE page, x and y from its top-left corner, staying inside the page; at least 0.006 wide and high (the area tool ignores smaller ones).",
        }
      )
    ),
    style: Type.Optional(
      Type.Object(
        {
          color: Type.Optional(Type.String({ description: "#rrggbb" })),
          opacity: Type.Optional(Type.Number({ minimum: 0.1, maximum: 1 })),
          line_width: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
        },
        {
          additionalProperties: false,
          description:
            "PDF rectangle only: the panel's style controls. A new rectangle starts as the area tool draws it (#f4c542, opacity 0.35, line width 2); update changes only the fields you give.",
        }
      )
    ),
    color: Type.Optional(lit(PDF_HIGHLIGHT_COLORS)),
    parts: Type.Optional(
      Type.Array(
        Type.Object(
          {
            pageIndex: Type.Integer({ minimum: 0 }),
            quote: Type.String({
              description:
                "text copied EXACTLY from that page's text in the reading (reading.pages[].text), line breaks included",
            }),
            occurrence: Type.Optional(
              Type.Integer({
                minimum: 0,
                description:
                  "which occurrence when the quote appears more than once on the page (0-based, counting every start position)",
              })
            ),
          },
          { additionalProperties: false }
        ),
        {
          minItems: 1,
          description:
            "PDF create highlight/underline/strikeout: the real text to mark, one part per page in ascending page order (a selection across pages is one annotation: one part per page). Its rectangles come from the page's text layer, never from you; a page without a text layer (hasTextLayer false) cannot be marked.",
        }
      )
    ),
    target: Type.Optional(
      Type.Object(
        {
          type: lit(["document", "structure", "text"] as const),
          id: Type.Optional(
            Type.String({
              description:
                "structure: the section or block id from the reading (sec-1, p-12, fig-2, eq-3...).",
            })
          ),
          block: Type.Optional(
            Type.String({ description: "text: the block id that holds the text." })
          ),
          container: Type.Optional(
            Type.Object(
              {
                type: lit(["content", "caption", "list_item"] as const),
                index: Type.Optional(
                  Type.Integer({ minimum: 0, description: "list_item: the 0-based item." })
                ),
              },
              { additionalProperties: false }
            )
          ),
          start: Type.Optional(
            Type.Integer({
              minimum: 0,
              description: "text: UTF-16 offset into the container's canonical text (inclusive).",
            })
          ),
          end: Type.Optional(
            Type.Integer({ minimum: 0, description: "text: UTF-16 offset (exclusive)." })
          ),
          quote: Type.Optional(
            Type.String({
              description:
                "text: REQUIRED, the exact text at [start, end) as you counted it (before any widening). It must equal that slice of the canonical text, so wrongly counted or stale offsets are refused instead of anchoring to other text.",
            })
          ),
        },
        {
          additionalProperties: false,
          description:
            "create_annotation: document (the whole document), structure (one section or block: kind and snapshot come from the stored document) or text (one container of one block, canonical UTF-16 offsets).",
        }
      )
    ),
  },
  { additionalProperties: false }
);

const description = [
  "Read and navigate the Reader (LaTeX and text Docs). read returns the WHOLE document of a Doc from disk, in the background, without opening or moving anything: every section, paragraph, list, equation, figure, full table body, code/algorithm body, the whole bibliography, cite/xref identities and the Doc's current annotations with their full bodies, plus the content fingerprint and annotation revision they belong together under. Text is the canonical annotation text: a selection's start/end are UTF-16 offsets into it, math/cite/xref are atomic marks. Saved annotations of older content are left out and the archive is never read. A document too large for the room left in this model's window is delivered in parts, never cut: the result carries batch {from, to, total, status}; while status is partial the rest is NOT read: call read again with from = batch.to and version = batch.version until it says complete (the last part says so); a conflict with reason version_changed means the document changed: read it again from 0 (and not before taking down the key points of what you read, because earlier parts leave the conversation to make room), and do not claim the whole document was read before that. A single entry or page too large for the room is refused with its size and the actual gap.",
  "create_annotation, update_annotation and delete_annotation are the Annotations panel's, the selection toolbar's, the block buttons' and the editor's own operations, run through the page's own save: they write straight to the Doc's saved annotations and the user's open Reader shows the change at once. Plan each from a reading and send its reading.epoch.fingerprint and reading.epoch.annotationsRev: a write whose epoch is no longer current is refused (conflict) and writes nothing, so read the Doc again and form a new request; never just replace the numbers and resend. create_annotation takes target document, structure {id} (the section or block you name; the kind and the full content snapshot are taken from the stored document) or text {block, container, start, end, quote} in the reading's canonical text, where quote is required and must equal the canonical text at [start, end) as you counted it (offsets resent after the document changed can never anchor to different text): one container of one block (a paragraph's content, one list item, a figure/table/code/algorithm caption), UTF-16 offsets; a range that touches the inside of a math, cite or xref mark is widened to the whole mark (the quote is still checked against the range as you gave it; the saved target is in the result); equation, code, algorithm and table bodies and headings can only be structure targets, and a range across containers or blocks is refused. update_annotation and delete_annotation also carry expectedUpdatedAt, that annotation's updated_at exactly as your latest reading or write result showed it: if the annotation was edited after your reading (even when the epoch numbers are current again) the call is refused as conflict annotation_changed and writes nothing; read again, look at what the user wrote, then decide. update_annotation changes only the body (target and created time never change; moving an annotation means delete_annotation then create_annotation); an identical body is noop and writes nothing. delete_annotation removes one annotation at once without a confirmation, as the trash button does. Keys the file has that this application does not know are kept. If the call found the Doc's text replaced it archived the older annotations (as opening the Doc does) and says archivedOlder with their count: tell the user. An error never means your request was written; only the older batch may have been archived (archivedOlder). The body is saved byte for byte. A text the user has typed but not saved is theirs and stays in their editor; page.drafts says whether there is one. Archived annotations cannot be read or written.",
  "PDF Docs: read returns the PDF in the background (in parts, with batch, when it does not fit; from continues): every page's real extractable text in page order (zero-based pageIndex; a page with no text layer has hasTextLayer false and text null, never an invented text), the outline, the workbench annotations (read-only here) and the SHA-256 of the original. read_page_image returns ONE original page as an image (any page, whatever the Reader has rendered; longEdge sets the resolution) for a model that can take images; a page you cannot read as text must be read from its image, never guessed. If the selected model cannot take images, read_page_image is refused and says so: tell the user to choose an image-capable model. A bad sha256, a bad pageIndex or a PDF that changed is refused with its true state. read_image {docId, path, sha256} (asset.path/asset.sha256 of a reading entry) returns one picture of a LaTeX or text Doc the same way (PNG/JPEG/WebP only; a refused one says why: look at nothing else and do not guess it). An SVG figure is read with read_svg_image {docId, path, sha256, longEdge?}: it is drawn to a bounded PNG for you only (its own visible step, nothing is stored), after a safety check that refuses an SVG with script or any reference outside the file. goto_page, next_page, previous_page, open_outline_item, search (the search box: results come back in the reply; refused while a search is still running, as the box is disabled then), open_search_result, open_annotation (the page of one workbench annotation, like its go-to button) and zoom (in, out, fit_width, fit_page) are the PDF Reader's own controls; set_panel works on its outline and annotations panels. download_original is the toolbar's download button for the PDF Doc that is open: it saves the verified original in the user's browser, the same handler as the button (ok means the download was handed to the browser, which may ask the user to allow it; unavailable means that PDF Doc is not open, so open it first; error means the browser refused it; where the file goes is the browser's own setting). Copying the selection and the page link need the user's own clipboard permission in the browser, so you cannot do them.",
  "PDF workbench annotations (the PDF Reader's own tools, panel and buttons, through the page's own save rules; the PDF itself is never changed): create_pdf_annotation (kind rectangle {pageIndex, rectangle}, page_comment {pageIndex}, document_comment, or highlight/underline/strikeout {parts}; body is required), update_pdf_annotation (the body, a rectangle's rectangle and style, a highlight's color; what an annotation is anchored to never changes: delete and create instead), delete_pdf_annotation (at once, no confirmation, like the trash button), undo_pdf_annotation and redo_pdf_annotation (the panel's buttons, for the changes you made through this tool in this conversation). Every one carries docId, sha256 (reading.sha256) and rev (reading.annotationsRev, or epoch.annotationsRev of your last write result); update and delete also carry expectedUpdatedAt, that annotation's updated_at from your latest reading or write result. A stale original, revision or annotation is refused as conflict and writes nothing: read the Doc again, look at what the user changed, and form a new request, never just replace the numbers and resend. Text annotations mark REAL text of a page's text layer: parts is one {pageIndex, quote} per page in ascending order, the quote copied exactly from that page's text in the reading (the user's selection is in page.pdf.selection; split it at the page boundary), unique on the page unless occurrence says which; the rectangles are computed from the text layer, never given by you, and a page with no text layer (hasTextLayer false) cannot be marked, use a rectangle or a comment there. Page indexes are zero-based, rectangles are fractions of the visible page from its top-left corner. Embedded annotations of the PDF file itself are read-only and not part of this. Undo and redo follow the panel's rules: only changes made through this tool can be undone, a change by the user or anyone else ends that history, a new change clears redo, and the history is kept only until the service restarts. A text the user has typed in the panel and not saved is theirs: page.pdf.drafts says whether there is one (presence only, never the text) and whether the panel is blocked. Your write never replaces or saves it; the draft stays visible in the panel, even when you deleted the annotation it was for (the user can copy or discard it), and the panel shows its usual notice that the annotations changed elsewhere. Undo and redo reach only the changes made through this tool by THIS conversation.",
  "set_text_view switches a text Doc between its reading and its source tab. navigate/jump_back/set_panel/set_right_tab/retry_sync act on the user's visible Reader like the outline, reference cards, chips, the undo-navigation button, the panel folds, the tabs and Retry: call them only when asked to show something, never to read. navigate and jump_back stop at a Reader that is syncing or showing an error (nothing moves, not_displayed); set_panel, set_right_tab and retry_sync are folds, tabs and Retry and work in any state. Unfolding a panel that would leave the article under 240 px folds the other one: the result says folded.",
].join(" ");

const record = (id: string, action: string, partial: Partial<CopilotOperation>) =>
  recordFor(READER_TOOL_NAME, id, action, partial);

export function createReaderTool(context: ReaderToolContext) {
  // The annotation writes are catalog operations (reader.create_annotation ...): the answer, its words and the record
  // come from the one function the CLI's `annotation` commands also run (reader-operations.ts).
  const write = async (
    id: string,
    op: ReaderWriteOperation,
    done: (operation: CopilotOperation, payload: object) => ToolResult
  ) => {
    const answer = await runReaderWrite(context.reader, op);
    return done(
      record(id, op.action, { ...answer.record, object: { kind: "doc" as const, id: op.docId } }),
      answer.payload
    );
  };
  /** The PDF annotation writes: the same panel operations as the user's tools, through the page's own commit rules. */
  const writePdf = async (
    id: string,
    op: PdfAnnotationOperation,
    done: (operation: CopilotOperation, payload: object) => ToolResult
  ): Promise<ToolResult> => {
    const answer = await runPdfWrite(context.reader, op, {
      conversationId: context.conversationId,
    });
    return done(
      record(id, op.action, { ...answer.record, object: { kind: "doc" as const, id: op.docId } }),
      answer.payload
    );
  };
  const pdfOutcome = (
    id: string,
    action: string,
    docId: string,
    outcome: {
      kind: "not_found" | "busy" | "changed" | "resource" | "invalid" | "error";
      detail?: string;
    },
    done: (operation: CopilotOperation, payload: object) => ToolResult
  ): ToolResult => {
    const object = { kind: "doc" as const, id: docId };
    switch (outcome.kind) {
      case "not_found":
        return done(record(id, action, { status: "not_found", object }), {
          ok: false,
          status: "not_found",
          detail: "no such PDF Doc",
        });
      case "busy":
        return done(record(id, action, { status: "rejected", object }), {
          ok: false,
          status: "rejected",
          detail:
            "the Doc is being replaced or deleted right now; nothing was read. Try again when the job has finished",
        });
      case "changed":
        return done(record(id, action, { status: "conflict", object }), {
          ok: false,
          status: "conflict",
          detail:
            "the PDF is not the original your reading was of (document changed); nothing was returned. Read the Doc again (reader read) and use its sha256",
        });
      case "invalid":
        return done(record(id, action, { status: "invalid", object }), {
          ok: false,
          status: "invalid",
          detail: `${outcome.detail ?? "invalid request"}; nothing was returned`,
        });
      case "resource":
        return done(record(id, action, { status: "error", object }), {
          ok: false,
          status: "error",
          detail: `${outcome.detail ?? "the PDF engine is short of memory"}; try again later`,
        });
      default:
        return done(record(id, action, { status: "error", object }), {
          ok: false,
          status: "error",
          detail: outcome.detail ?? "the PDF could not be read",
        });
    }
  };
  /**
   * A continuation (`from` > 0) names the version of the parts already read; a document that changed since is a
   * conflict, never stitched onto them (ticket 24).
   */
  const versionGate = (
    id: string,
    object: { kind: "doc"; id: string },
    from: number,
    expected: string | undefined,
    current: string,
    total: number,
    unit: string,
    done: (operation: CopilotOperation, payload: object) => ToolResult
  ): ToolResult | null => {
    if (from === 0) return null;
    if (!expected)
      return done(record(id, "read", { status: "invalid", object }), {
        ok: false,
        status: "invalid",
        detail:
          "a continuation (from > 0) needs version: the batch.version of the part you are continuing; nothing was returned",
      });
    if (expected === current) return null;
    return done(record(id, "read", { status: "conflict", object }), {
      ok: false,
      status: "conflict",
      reason: "version_changed",
      detail: `the document changed since the parts you read (their version ${expected}, now ${current}); parts of two versions are never joined, so nothing was returned. Read it again from 0`,
      version: current,
      total,
      unit,
    });
  };
  /** `read` of a PDF Doc: the whole material, refused whole (with its size) when it does not fit the window. */
  const readPdf = async (
    id: string,
    docId: string,
    from: number,
    version: string | undefined,
    done: (operation: CopilotOperation, payload: object) => ToolResult
  ): Promise<ToolResult> => {
    const object = { kind: "doc" as const, id: docId };
    if (!context.reader.pdf)
      return done(record(id, "read", { status: "unsupported", object }), {
        ok: false,
        status: "unsupported",
        detail: "this is a PDF Doc and PDF material is not available in this host",
      });
    const outcome = await context.reader.pdf.read(docId);
    if (outcome.kind !== "ok") return pdfOutcome(id, "read", docId, outcome, done);
    const reading = buildPdfReading(outcome.material, context.modelAcceptsImages?.() ?? false);
    const observed =
      "the PDF's pages as stored right now, from the verified original (zero-based pageIndex; text only where the page has a text layer). Pages in imageOnlyPages are readable only from their image (read_page_image)";
    if (from > reading.pages.length || (from === reading.pages.length && from > 0))
      return done(record(id, "read", { status: "invalid", object }), {
        ok: false,
        status: "invalid",
        detail: `from ${from} is beyond the document: it has ${reading.pages.length} pages (zero-based 0..${reading.pages.length - 1}); nothing was returned`,
      });
    const gated = versionGate(
      id,
      object,
      from,
      version,
      pdfVersion(reading),
      reading.pages.length,
      "pages",
      done
    );
    if (gated) return gated;
    const room = context.budget?.();
    let batched = pdfBatch(reading, from, room ?? Number.POSITIVE_INFINITY, observed);
    if (context.reclaim && (batched.kind === "gap" || batched.coverage.to < reading.pages.length)) {
      const more = context.reclaim();
      if (more > (room ?? 0)) batched = pdfBatch(reading, from, more, observed);
    }
    if (batched.kind === "gap")
      return done(record(id, "read", { status: "rejected", object, batch: batched.coverage }), {
        ok: false,
        status: "rejected",
        detail: batched.detail,
        coverage: reading.coverage,
        batch: batched.coverage,
      });
    return done(
      record(id, "read", { status: "ok", object, batch: batched.coverage }),
      batched.payload
    );
  };
  /**
   * The three capacity rules every image the model is given obeys (a page image and a figure image alike), so nothing a
   * provider would reject can ever enter the history, which is sent again with every turn: one image's bytes, the
   * images of the conversation together, and what the model is charged for its pixels against the room left.
   */
  const imageCapacity = (
    id: string,
    action: string,
    object: { kind: "doc"; id: string },
    byteLength: number,
    width: number,
    height: number,
    smaller: string,
    done: (operation: CopilotOperation, payload: object) => ToolResult
  ): ToolResult | null => {
    const used = context.imageBytesUsed?.() ?? 0;
    if (byteLength > PDF_IMAGE_MAX_BYTES)
      return done(record(id, action, { status: "rejected", object }), {
        ok: false,
        status: "rejected",
        detail: `capacity: this image is ${byteLength} bytes, more than the ${PDF_IMAGE_MAX_BYTES} bytes one image may be; nothing was returned. ${smaller}`,
      });
    if (used + byteLength > PDF_IMAGE_HISTORY_MAX_BYTES)
      return done(record(id, action, { status: "rejected", object }), {
        ok: false,
        status: "rejected",
        detail: `capacity: the images of this conversation would be ${used + byteLength} bytes, more than the ${PDF_IMAGE_HISTORY_MAX_BYTES} bytes they may be together (they are sent again with every turn); nothing was returned. Read fewer images, or continue in a new conversation`,
      });
    const room = context.budget?.();
    // An image costs what a model is charged for its pixels (the one rule `imageTokens`, also used for the history),
    // never the length of its base64 text.
    const cost = imageTokens(width, height) * IMAGE_BYTES_PER_TOKEN;
    if (room !== undefined && cost + 1024 > room)
      return done(record(id, action, { status: "rejected", object }), {
        ok: false,
        status: "rejected",
        detail: `capacity: this image (${width}x${height} px, about ${imageTokens(width, height)} tokens) is more than the room left in this model's window (${Math.max(0, room)} bytes at ${IMAGE_BYTES_PER_TOKEN} per token); nothing was returned. ${smaller}`,
      });
    return null;
  };
  /**
   * `read_image`: one picture of a LaTeX or text Doc's reading, the same verified bytes the Reader shows, for a model
   * that can see. A model that cannot is told so (the same rule and words as a PDF page); a picture in a format a model
   * cannot take (an SVG, a GIF, a PDF figure) is said so and nothing is converted behind the user's back.
   */
  type PictureDone = (operation: CopilotOperation, payload: object, parts?: Part[]) => ToolResult;
  const NO_PICTURE_NOTICE =
    "no image was produced: this model cannot take images, so the pictures of the document cannot be looked at; do not guess what a figure shows from anything else (use its caption and the text of the reading, and say the picture was not seen). Tell the user to choose an image-capable model in the model selector.";
  /**
   * The checks and the hash-verified bytes both picture actions start from: the model can see, the host has the read,
   * the file is the one the reading listed. Returns the bytes, or the refusal to hand back.
   */
  const pictureBytes = async (
    id: string,
    action: "read_image" | "read_svg_image",
    op: { docId: string; path: string; sha256: string },
    done: PictureDone
  ): Promise<{ bytes: Buffer; sha256: string } | ToolResult> => {
    const object = { kind: "doc" as const, id: op.docId };
    if (context.modelAcceptsImages && !context.modelAcceptsImages())
      return done(record(id, action, { status: "unsupported", object }), {
        ok: false,
        status: "unsupported",
        detail: NO_PICTURE_NOTICE,
      });
    if (!context.reader.asset)
      return done(record(id, action, { status: "unsupported", object }), {
        ok: false,
        status: "unsupported",
        detail: "document pictures are not available in this host",
      });
    const outcome = await context.reader.asset({
      docId: op.docId,
      path: op.path,
      sha256: op.sha256,
    });
    if (outcome.kind === "ok") return { bytes: outcome.bytes, sha256: outcome.sha256 };
    switch (outcome.kind) {
      case "changed":
        return done(record(id, action, { status: "conflict", object }), {
          ok: false,
          status: "conflict",
          detail:
            "the picture is not the file your reading listed (its sha256 differs); nothing was returned. Read the Doc again (reader read) and use the sha256 it lists",
        });
      case "not_found":
        return done(record(id, action, { status: "not_found", object }), {
          ok: false,
          status: "not_found",
          detail:
            "no such Doc or no such picture in it (use the asset path from the reading); nothing was returned",
        });
      case "busy":
        return done(record(id, action, { status: "rejected", object }), {
          ok: false,
          status: "rejected",
          detail:
            "the Doc is being replaced or deleted right now; nothing was returned. Try again when it has finished",
        });
      case "invalid":
        return done(record(id, action, { status: "invalid", object }), {
          ok: false,
          status: "invalid",
          detail: `${outcome.detail}; nothing was returned`,
        });
      default:
        return done(record(id, action, { status: "error", object }), {
          ok: false,
          status: "error",
          detail: outcome.detail,
        });
    }
  };
  const isResult = (value: unknown): value is ToolResult =>
    typeof value === "object" && value !== null && "details" in value;
  const readImage = async (
    id: string,
    op: ReturnType<typeof ReaderReadImageOperationSchema.parse>,
    done: PictureDone
  ): Promise<ToolResult> => {
    const object = { kind: "doc" as const, id: op.docId };
    const got = await pictureBytes(id, "read_image", op, done);
    if (isResult(got)) return got;
    let sniffed: ReturnType<typeof sniffImage>;
    try {
      sniffed = sniffImage(got.bytes);
    } catch (error) {
      const code = error instanceof TextAssetError ? error.code : "";
      // too big in bytes or pixels is a capacity matter (a smaller picture is the way out), not an unsupported format
      if (code === "too_large" || code === "too_many_pixels")
        return done(record(id, "read_image", { status: "rejected", object }), {
          ok: false,
          status: "rejected",
          detail: `capacity: ${error instanceof Error ? error.message : "this picture is too large"}; nothing was returned. Say that this figure was not seen; the picture is not made smaller for you`,
        });
      const svg = /<svg[\s>]/i.test(got.bytes.subarray(0, 4096).toString("utf8"));
      return done(record(id, "read_image", { status: "unsupported", object }), {
        ok: false,
        status: "unsupported",
        detail: svg
          ? "this picture is an SVG, which a model cannot take as it is. read_svg_image {docId, path, sha256} renders it to a bounded PNG for you (it shows as its own step; nothing is stored). Until then it was not seen: do not guess what it shows"
          : `this picture cannot be given to a model (${error instanceof Error ? error.message : "unknown format"}; a model takes PNG, JPEG and WebP). Nothing was converted and nothing was returned: say that this figure was not seen, and use its caption and the text of the reading only. Do not guess what it shows`,
      });
    }
    const refused = imageCapacity(
      id,
      "read_image",
      object,
      got.bytes.length,
      sniffed.width,
      sniffed.height,
      "The picture is not made smaller for you: say that this figure was not seen",
      done
    );
    if (refused) return refused;
    return done(
      record(id, "read_image", { status: "ok", object }),
      {
        ok: true,
        status: "ok",
        observed:
          "the picture of the document as the Reader shows it (attached); read what it shows, say where something cannot be made out, never invent it",
        image: {
          path: op.path,
          width: sniffed.width,
          height: sniffed.height,
          mediaType: sniffed.mediaType,
          byteLength: got.bytes.length,
        },
        sha256: got.sha256,
      },
      [{ type: "image", data: got.bytes.toString("base64"), mimeType: sniffed.mediaType }]
    );
  };
  /**
   * `read_svg_image`: an SVG figure rendered to a bounded PNG for the model, on demand. The SVG is checked first and
   * refused whole when it could do more than draw; the picture is at most `longEdge` on its longer side and obeys the
   * byte/window rules of every image given to the model. Nothing is stored or changed.
   */
  const readSvgImage = async (
    id: string,
    op: ReturnType<typeof ReaderReadSvgImageOperationSchema.parse>,
    done: PictureDone
  ): Promise<ToolResult> => {
    const object = { kind: "doc" as const, id: op.docId };
    const got = await pictureBytes(id, "read_svg_image", op, done);
    if (isResult(got)) return got;
    const longEdge = op.longEdge ?? PDF_IMAGE_LONG_EDGE.default;
    const rendered = await renderSvgFigure(got.bytes, longEdge, context.svgEngine);
    const refuse = (status: CopilotOperation["status"], detail: string): ToolResult =>
      done(record(id, "read_svg_image", { status, object }), { ok: false, status, detail });
    switch (rendered.kind) {
      case "not_svg":
        return refuse(
          "invalid",
          "this picture is not an SVG (use read_image for PNG, JPEG and WebP); nothing was returned"
        );
      case "too_large":
        return refuse(
          "rejected",
          "capacity: this SVG is larger than 2 MiB; nothing was returned. Say that this figure was not seen"
        );
      case "unsafe":
        return refuse(
          "rejected",
          `this SVG was NOT rendered: ${rendered.reason}. Nothing was returned and nothing was changed. Say that this figure was not seen; do not guess what it shows`
        );
      case "invalid":
        return refuse(
          "invalid",
          `${rendered.detail}; nothing was returned. Say that this figure was not seen`
        );
      case "unavailable":
        return refuse(
          "unsupported",
          "the SVG renderer is not installed in this build, so SVG figures cannot be looked at; nothing was returned. Say that this figure was not seen"
        );
      default:
        break;
    }
    const refused = imageCapacity(
      id,
      "read_svg_image",
      object,
      rendered.png.length,
      rendered.width,
      rendered.height,
      "Ask again with a smaller longEdge",
      done
    );
    if (refused) return refused;
    return done(
      record(id, "read_svg_image", { status: "ok", object }),
      {
        ok: true,
        status: "ok",
        observed:
          "the SVG figure drawn as a picture for you only (attached; nothing was stored or changed); read what it shows, say where something cannot be made out, never invent it",
        image: {
          path: op.path,
          width: rendered.width,
          height: rendered.height,
          mediaType: "image/png",
          byteLength: rendered.png.length,
          renderedFrom: "svg",
        },
        sha256: got.sha256,
      },
      [{ type: "image", data: rendered.png.toString("base64"), mimeType: "image/png" }]
    );
  };
  /** `read_page_image`: one original page as an image; a model that cannot see is told so and gets nothing. */
  const readPageImage = async (
    id: string,
    op: ReturnType<typeof ReaderReadPageImageOperationSchema.parse>,
    done: (operation: CopilotOperation, payload: object, parts?: Part[]) => ToolResult
  ): Promise<ToolResult> => {
    const object = { kind: "doc" as const, id: op.docId };
    if (context.modelAcceptsImages && !context.modelAcceptsImages())
      return done(record(id, "read_page_image", { status: "unsupported", object }), {
        ok: false,
        status: "unsupported",
        detail: `no image was produced: ${PDF_NO_IMAGE_NOTICE}`,
      });
    if (!context.reader.pdf)
      return done(record(id, "read_page_image", { status: "unsupported", object }), {
        ok: false,
        status: "unsupported",
        detail: "PDF page images are not available in this host",
      });
    const outcome = await context.reader.pdf.image({
      docId: op.docId,
      pageIndex: op.pageIndex,
      ...(op.sha256 ? { sha256: op.sha256 } : {}),
      ...(op.longEdge ? { longEdge: op.longEdge } : {}),
    });
    if (outcome.kind !== "ok") return pdfOutcome(id, "read_page_image", op.docId, outcome, done);
    const data = outcome.png.toString("base64");
    const refused = imageCapacity(
      id,
      "read_page_image",
      object,
      outcome.png.length,
      outcome.width,
      outcome.height,
      "Ask again with a smaller longEdge",
      done
    );
    if (refused) return refused;
    return done(
      record(id, "read_page_image", { status: "ok", object }),
      {
        ok: true,
        status: "ok",
        observed:
          "the original page as an image (attached); read what it shows, say where something cannot be made out, never invent it",
        page: {
          pageIndex: outcome.pageIndex,
          pageCount: outcome.pageCount,
          imageWidth: outcome.width,
          imageHeight: outcome.height,
          hasTextLayer: outcome.hasTextLayer,
        },
        sha256: outcome.contentSha256,
      },
      [{ type: "image", data, mimeType: "image/png" }]
    );
  };
  /** The Reader's search results once its search has settled for this query (the box and its list are the Reader's). */
  const searchGeneration = () => context.page?.()?.pdf?.search?.generation ?? 0;
  const settledSearch = async (
    docId: string,
    query: string,
    after: number
  ): Promise<PdfSearchState | null> => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const pdf = context.page?.()?.pdf;
      const search = pdf?.search;
      // This search only: the same Doc, the same query and a generation later than the one before the action.
      if (
        pdf?.docId === docId &&
        search &&
        search.generation > after &&
        search.query === query &&
        search.status === "done"
      )
        return search;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  };
  return defineTool({
    name: READER_TOOL_NAME,
    label: "Reader",
    description,
    executionMode: "sequential",
    parameters,
    async execute(toolCallId, params) {
      const action = typeof params.action === "string" ? params.action : "unknown";
      if (!context.admitting())
        return done(record(toolCallId, action, { status: "error" }), {
          ok: false,
          status: "closed",
        });
      try {
        const read = ReaderReadOperationSchema.safeParse(params);
        if (read.success) {
          const object = { kind: "doc" as const, id: read.data.docId };
          const outcome = await context.reader.read(read.data.docId);
          if (outcome.kind === "not_found")
            return done(record(toolCallId, "read", { status: "not_found", object }), {
              ok: false,
              status: "not_found",
              detail: "no such Doc",
            });
          if (outcome.kind === "busy")
            return done(record(toolCallId, "read", { status: "rejected", object }), {
              ok: false,
              status: "rejected",
              detail:
                "the Doc is being replaced or deleted right now; nothing was read. Try again when the job has finished",
            });
          if (outcome.kind === "pdf")
            return await readPdf(
              toolCallId,
              read.data.docId,
              read.data.from ?? 0,
              read.data.version,
              done
            );
          if (outcome.kind === "error")
            return done(record(toolCallId, "read", { status: "error", object }), {
              ok: false,
              status: "error",
              detail: outcome.detail,
            });
          const from = read.data.from ?? 0;
          const total = outcome.reading.entries.length;
          if (from > total || (from === total && from > 0))
            return done(record(toolCallId, "read", { status: "invalid", object }), {
              ok: false,
              status: "invalid",
              detail: `from ${from} is beyond the document: it has ${total} entries (zero-based 0..${total - 1}); nothing was returned`,
            });
          const gated = versionGate(
            toolCallId,
            object,
            from,
            read.data.version,
            readerVersion(outcome.reading),
            total,
            "entries",
            done
          );
          if (gated) return gated;
          const room = context.budget?.();
          const observed =
            "the Doc as stored right now (one coherent read); the user may change annotations afterwards, so read again before relying on them";
          let batched = readerBatch(
            outcome.reading,
            from,
            room ?? Number.POSITIVE_INFINITY,
            observed
          );
          // A part that does not reach the end may be larger once earlier deliveries are out of the conversation.
          if (
            context.reclaim &&
            (batched.kind === "gap" || batched.coverage.to < outcome.reading.entries.length)
          ) {
            const more = context.reclaim();
            if (more > (room ?? 0)) batched = readerBatch(outcome.reading, from, more, observed);
          }
          if (batched.kind === "gap")
            return done(
              record(toolCallId, "read", { status: "rejected", object, batch: batched.coverage }),
              {
                ok: false,
                status: "rejected",
                detail: batched.detail,
                coverage: outcome.reading.coverage,
                batch: batched.coverage,
              }
            );
          return done(
            record(toolCallId, "read", { status: "ok", object, batch: batched.coverage }),
            batched.payload
          );
        }
        if (action === "read_svg_image") {
          const figure = ReaderReadSvgImageOperationSchema.safeParse(params);
          if (!figure.success)
            return done(record(toolCallId, action, { status: "invalid" }), {
              ok: false,
              status: "invalid",
              detail:
                "read_svg_image needs docId, the asset path and its sha256 from the reading (longEdge optional); nothing was returned",
              issues: figure.error.issues
                .slice(0, 5)
                .map((issue) => ({ path: issue.path.join("."), message: issue.message })),
            });
          return await readSvgImage(toolCallId, figure.data, done);
        }
        if (action === "read_image") {
          const picture = ReaderReadImageOperationSchema.safeParse(params);
          if (!picture.success)
            return done(record(toolCallId, action, { status: "invalid" }), {
              ok: false,
              status: "invalid",
              detail:
                "read_image needs docId, the asset path and its sha256 from the reading (reading entries list them as asset); nothing was returned",
              issues: picture.error.issues
                .slice(0, 5)
                .map((issue) => ({ path: issue.path.join("."), message: issue.message })),
            });
          return await readImage(toolCallId, picture.data, done);
        }
        if (action === "read_page_image") {
          const image = ReaderReadPageImageOperationSchema.safeParse(params);
          if (!image.success)
            return done(record(toolCallId, action, { status: "invalid" }), {
              ok: false,
              status: "invalid",
              detail:
                "read_page_image needs docId and a zero-based integer pageIndex (sha256 is required, longEdge optional); nothing was returned",
              issues: image.error.issues
                .slice(0, 5)
                .map((issue) => ({ path: issue.path.join("."), message: issue.message })),
            });
          return await readPageImage(toolCallId, image.data, done);
        }
        if ((PDF_ANNOTATION_ACTIONS as readonly string[]).includes(action)) {
          // create, update and delete are catalog operations (their parameters are the catalog entry's); undo and redo
          // are the conversation's own history and stay tool actions.
          const cataloged = parseCatalogCall(READER_TOOL_NAME, params);
          const written =
            cataloged.match && cataloged.success
              ? { success: true as const, data: { action, ...cataloged.params } }
              : cataloged.match
                ? { success: false as const, issues: cataloged.issues }
                : (() => {
                    const direct = PdfAnnotationOperationSchema.safeParse(params);
                    return direct.success
                      ? { success: true as const, data: direct.data }
                      : {
                          success: false as const,
                          issues: direct.error.issues.map((issue) => ({
                            path: issue.path.join("."),
                            message: issue.message,
                          })),
                        };
                  })();
          if (!written.success)
            return done(record(toolCallId, action, { status: "invalid" }), {
              ok: false,
              status: "invalid",
              detail:
                "invalid parameters; nothing was written. Every PDF annotation write needs docId, sha256 and rev from the PDF reading and the fields of its action",
              issues: written.issues.slice(0, 5),
            });
          return await writePdf(toolCallId, written.data as PdfAnnotationOperation, done);
        }
        if ((READER_WRITE_ACTIONS as readonly string[]).includes(action)) {
          const cataloged = parseCatalogCall(READER_TOOL_NAME, params);
          if (!cataloged.match || !cataloged.success)
            return done(record(toolCallId, action, { status: "invalid" }), {
              ok: false,
              status: "invalid",
              detail:
                "invalid parameters; nothing was written. Every write needs docId, fingerprint and rev from the reading, and the fields of its action",
              issues: cataloged.match ? cataloged.issues.slice(0, 5) : [],
            });
          return await write(
            toolCallId,
            { action, ...cataloged.params } as ReaderWriteOperation,
            done
          );
        }
        const parsed = ReaderViewActionSchema.safeParse(params);
        if (!parsed.success)
          return done(record(toolCallId, action, { status: "unsupported" }), {
            ok: false,
            status: "unsupported",
            detail: "unknown action or invalid parameters",
            issues: parsed.error.issues
              .slice(0, 5)
              .map((issue) => ({ path: issue.path.join("."), message: issue.message })),
          });
        const before = searchGeneration();
        const outcome = viewOutcomeResult(
          await context.viewAction(parsed.data),
          parsed.data.action
        );
        const found =
          parsed.data.action === "search" && outcome.status === "ok"
            ? await settledSearch(parsed.data.docId, parsed.data.query, before)
            : null;
        return done(
          record(toolCallId, action, {
            status: outcome.status,
            object: { kind: "doc", id: parsed.data.docId },
          }),
          parsed.data.action === "open_outline_item" && outcome.status === "rejected"
            ? {
                ...outcome.payload,
                reason:
                  "only an outline entry that goes to a page of this document can be opened (its pageIndex is not null and it is not disabled); an external link is the user's own click",
              }
            : found
              ? { ...outcome.payload, search: found }
              : parsed.data.action === "search" && outcome.status === "ok"
                ? {
                    ...outcome.payload,
                    detail: "the search was started but its results had not settled yet",
                  }
                : outcome.payload
        );
      } catch {
        return done(record(toolCallId, action, { status: "unknown" }), {
          ok: false,
          status: "unknown",
          detail: "unexpected failure; read the Doc again to see what is stored now",
        });
      }
    },
  });
}
