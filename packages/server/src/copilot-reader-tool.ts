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
  READER_OPERATION_ACTIONS,
  READER_PANELS,
  READER_RIGHT_TABS,
  READER_WRITE_ACTIONS,
  type ReaderReading,
  ReaderReadOperationSchema,
  ReaderReadPageImageOperationSchema,
  type ReaderViewAction,
  ReaderViewActionSchema,
  type ReaderWriteOperation,
  ReaderWriteOperationSchema,
} from "@argelanderspace/contracts";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { pdfBatch, pdfVersion, readerBatch, readerVersion } from "./copilot-batching.js";
import { type ViewActionOutcome, viewOutcomeResult } from "./copilot-workspace-tool.js";

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
  read: (docId: string) => Promise<ReaderReadOutcome>;
  write: (operation: ReaderWriteOperation) => Promise<ReaderWriteOutcome>;
}

export interface ReaderToolContext {
  reader: ReaderOpDeps;
  /** The conversation this tool serves (the owner of the PDF annotation undo history it builds). */
  conversationId: string;
  /** Resolves only after the bound browser view reports the outcome. */
  viewAction: (action: ReaderViewAction) => Promise<ViewActionOutcome>;
  /** False once the host stopped admitting operations (Stop, shutdown). */
  admitting: () => boolean;
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
          "read_page_image and every PDF annotation write: REQUIRED, reading.sha256 of the PDF reading you are working from; a different original is refused (conflict).",
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
  "Read and navigate the LaTeX Reader. read returns the WHOLE document of a Doc from disk, in the background, without opening or moving anything: every section, paragraph, list, equation, figure, full table body, code/algorithm body, the whole bibliography, cite/xref identities and the Doc's current annotations with their full bodies, plus the content fingerprint and annotation revision they belong together under. Text is the canonical annotation text: a selection's start/end are UTF-16 offsets into it, math/cite/xref are atomic marks. Saved annotations of older content are left out and the archive is never read. A document too large for the room left in this model's window is delivered in parts, never cut: the result carries batch {from, to, total, status}; while status is partial the rest is NOT read: call read again with from = batch.to and version = batch.version until it says complete (the last part says so); a conflict with reason version_changed means the document changed: read it again from 0 (and not before taking down the key points of what you read, because earlier parts leave the conversation to make room), and do not claim the whole document was read before that. A single entry or page too large for the room is refused with its size and the actual gap.",
  "create_annotation, update_annotation and delete_annotation are the Annotations panel's, the selection toolbar's, the block buttons' and the editor's own operations, run through the page's own save: they write straight to the Doc's saved annotations and the user's open Reader shows the change at once. Plan each from a reading and send its reading.epoch.fingerprint and reading.epoch.annotationsRev: a write whose epoch is no longer current is refused (conflict) and writes nothing, so read the Doc again and form a new request; never just replace the numbers and resend. create_annotation takes target document, structure {id} (the section or block you name; the kind and the full content snapshot are taken from the stored document) or text {block, container, start, end, quote} in the reading's canonical text, where quote is required and must equal the canonical text at [start, end) as you counted it (offsets resent after the document changed can never anchor to different text): one container of one block (a paragraph's content, one list item, a figure/table/code/algorithm caption), UTF-16 offsets; a range that touches the inside of a math, cite or xref mark is widened to the whole mark (the quote is still checked against the range as you gave it; the saved target is in the result); equation, code, algorithm and table bodies and headings can only be structure targets, and a range across containers or blocks is refused. update_annotation and delete_annotation also carry expectedUpdatedAt, that annotation's updated_at exactly as your latest reading or write result showed it: if the annotation was edited after your reading (even when the epoch numbers are current again) the call is refused as conflict annotation_changed and writes nothing; read again, look at what the user wrote, then decide. update_annotation changes only the body (target and created time never change; moving an annotation means delete_annotation then create_annotation); an identical body is noop and writes nothing. delete_annotation removes one annotation at once without a confirmation, as the trash button does. Keys the file has that this application does not know are kept. If the call found the Doc's text replaced it archived the older annotations (as opening the Doc does) and says archivedOlder with their count: tell the user. An error never means your request was written; only the older batch may have been archived (archivedOlder). The body is saved byte for byte. A text the user has typed but not saved is theirs and stays in their editor; page.drafts says whether there is one. Archived annotations cannot be read or written.",
  "PDF Docs: read returns the PDF in the background (in parts, with batch, when it does not fit; from continues): every page's real extractable text in page order (zero-based pageIndex; a page with no text layer has hasTextLayer false and text null, never an invented text), the outline, the workbench annotations (read-only here) and the SHA-256 of the original. read_page_image returns ONE original page as an image (any page, whatever the Reader has rendered; longEdge sets the resolution) for a model that can take images; a page you cannot read as text must be read from its image, never guessed. If the selected model cannot take images, read_page_image is refused and says so: tell the user to choose an image-capable model. A bad sha256, a bad pageIndex or a PDF that changed is refused with its true state. goto_page, next_page, previous_page, open_outline_item, search (the search box: results come back in the reply; refused while a search is still running, as the box is disabled then), open_search_result, open_annotation (the page of one workbench annotation, like its go-to button) and zoom (in, out, fit_width, fit_page) are the PDF Reader's own controls; set_panel works on its outline and annotations panels. Copying, the page link and downloading the original are the user's own gestures (the browser lets only the user), so you cannot do them.",
  "PDF workbench annotations (the PDF Reader's own tools, panel and buttons, through the page's own save rules; the PDF itself is never changed): create_pdf_annotation (kind rectangle {pageIndex, rectangle}, page_comment {pageIndex}, document_comment, or highlight/underline/strikeout {parts}; body is required), update_pdf_annotation (the body, a rectangle's rectangle and style, a highlight's color; what an annotation is anchored to never changes: delete and create instead), delete_pdf_annotation (at once, no confirmation, like the trash button), undo_pdf_annotation and redo_pdf_annotation (the panel's buttons, for the changes you made through this tool in this conversation). Every one carries docId, sha256 (reading.sha256) and rev (reading.annotationsRev, or epoch.annotationsRev of your last write result); update and delete also carry expectedUpdatedAt, that annotation's updated_at from your latest reading or write result. A stale original, revision or annotation is refused as conflict and writes nothing: read the Doc again, look at what the user changed, and form a new request, never just replace the numbers and resend. Text annotations mark REAL text of a page's text layer: parts is one {pageIndex, quote} per page in ascending order, the quote copied exactly from that page's text in the reading (the user's selection is in page.pdf.selection; split it at the page boundary), unique on the page unless occurrence says which; the rectangles are computed from the text layer, never given by you, and a page with no text layer (hasTextLayer false) cannot be marked, use a rectangle or a comment there. Page indexes are zero-based, rectangles are fractions of the visible page from its top-left corner. Embedded annotations of the PDF file itself are read-only and not part of this. Undo and redo follow the panel's rules: only changes made through this tool can be undone, a change by the user or anyone else ends that history, a new change clears redo, and the history is kept only until the service restarts. A text the user has typed in the panel and not saved is theirs: page.pdf.drafts says whether there is one (presence only, never the text) and whether the panel is blocked. Your write never replaces or saves it; the draft stays visible in the panel, even when you deleted the annotation it was for (the user can copy or discard it), and the panel shows its usual notice that the annotations changed elsewhere. Undo and redo reach only the changes made through this tool by THIS conversation.",
  "navigate/jump_back/set_panel/set_right_tab/retry_sync act on the user's visible Reader like the outline, reference cards, chips, the undo-navigation button, the panel folds, the tabs and Retry: call them only when asked to show something, never to read. navigate and jump_back stop at a Reader that is syncing or showing an error (nothing moves, not_displayed); set_panel, set_right_tab and retry_sync are folds, tabs and Retry and work in any state.",
].join(" ");

/** What `execute` returns: the payload as the model's text and the operation record as details. */
type ToolResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  details: CopilotOperation;
};

function record(id: string, action: string, partial: Partial<CopilotOperation>): CopilotOperation {
  return { id, tool: READER_TOOL_NAME, action, status: "error", ...partial };
}

export function createReaderTool(context: ReaderToolContext) {
  const write = async (
    id: string,
    op: ReaderWriteOperation,
    done: (operation: CopilotOperation, payload: object) => ToolResult
  ) => {
    const object = { kind: "doc" as const, id: op.docId };
    const outcome = await context.reader.write(op);
    const reread = "read the Doc again (reader read) to see what is stored now";
    const older = (n: number | undefined) =>
      n === undefined
        ? {}
        : {
            archivedOlder: n,
            archivedNote: `this call found the Doc's text replaced and archived ${n} annotation(s) of the older text (they are no longer current and cannot be read or written; tell the user)`,
          };
    switch (outcome.kind) {
      case "saved":
        return done(
          record(id, op.action, {
            status: "ok",
            object,
            label: outcome.label,
            rev: outcome.epoch.annotationsRev,
          }),
          {
            ok: true,
            status: "ok",
            ...(outcome.annotation ? { annotation: outcome.annotation } : {}),
            ...(outcome.deleted ? { deleted: outcome.deleted } : {}),
            ...(outcome.expanded
              ? {
                  widened:
                    "the range touched the inside of a math, cite or xref mark and was widened to the whole mark, as selecting it in the Reader does; annotation.target holds what was saved",
                }
              : {}),
            epoch: outcome.epoch,
            observed:
              "saved through the page's own save; the user's Reader shows it at once. The new epoch.annotationsRev replaces the one you sent; an update or delete of an annotation needs its updated_at from a reading, or from annotation here",
            ...older(outcome.archived),
          }
        );
      case "unchanged":
        return done(
          record(id, op.action, {
            status: "noop",
            object,
            label: outcome.label,
            rev: outcome.epoch.annotationsRev,
          }),
          {
            ok: true,
            status: "noop",
            detail: "the body bytes are exactly what is stored; nothing was written",
            annotation: outcome.annotation,
            epoch: outcome.epoch,
            ...older(outcome.archived),
          }
        );
      case "conflict":
        return done(
          record(id, op.action, {
            status: "conflict",
            object,
            rev: outcome.epoch.annotationsRev,
          }),
          {
            ok: false,
            status: "conflict",
            reason: outcome.reason,
            current: outcome.epoch,
            ...(outcome.annotation ? { annotation: outcome.annotation } : {}),
            detail:
              outcome.reason === "document_changed"
                ? `the Doc's text is not the one your reading was of (it was replaced; annotations of the older text are no longer current). Nothing was written. ${reread}, then form a new request from that`
                : outcome.reason === "annotation_changed"
                  ? `this annotation was changed after your reading (its body is not the one you saw; annotation shows it now). Nothing was written. ${reread}, decide again from what the user wrote, then form a new request with the updated_at of that reading; never reuse the old one`
                  : `the annotations changed since your reading (the user or another call saved first). Nothing was written. ${reread}, then form a new request from that; do not resend with the new revision`,
            ...older(outcome.archived),
          }
        );
      case "no_annotation":
        return done(record(id, op.action, { status: "not_found", object }), {
          ok: false,
          status: "not_found",
          detail: `no annotation ${outcome.annotationId} in this epoch (it may have been deleted); nothing was written. ${reread}`,
          ...older(outcome.archived),
        });
      case "invalid":
        return done(record(id, op.action, { status: "invalid", object }), {
          ok: false,
          status: "invalid",
          detail: `${outcome.detail}; nothing was written`,
          ...older(outcome.archived),
        });
      case "not_found":
        return done(record(id, op.action, { status: "not_found", object }), {
          ok: false,
          status: "not_found",
          detail: "no such Doc",
        });
      case "busy":
        return done(record(id, op.action, { status: "rejected", object }), {
          ok: false,
          status: "rejected",
          detail:
            "the Doc is being replaced or deleted right now; nothing was written. Try again when the job has finished",
        });
      case "pdf":
        return done(record(id, op.action, { status: "unsupported", object }), {
          ok: false,
          status: "unsupported",
          detail:
            "this is a PDF Doc; create_annotation, update_annotation and delete_annotation are for LaTeX Docs. A PDF Doc's workbench annotations are written with create_pdf_annotation, update_pdf_annotation, delete_pdf_annotation, undo_pdf_annotation and redo_pdf_annotation (sha256 and rev from the PDF reading); nothing was written",
        });
      case "error":
        return done(record(id, op.action, { status: "error", object }), {
          ok: false,
          status: "error",
          detail: outcome.detail,
          ...(outcome.archivedOlder ? { archivedOlder: true } : {}),
        });
    }
  };
  /** The PDF annotation writes: the same panel operations as the user's tools, through the page's own commit rules. */
  const writePdf = async (
    id: string,
    op: PdfAnnotationOperation,
    done: (operation: CopilotOperation, payload: object) => ToolResult
  ): Promise<ToolResult> => {
    const object = { kind: "doc" as const, id: op.docId };
    if (!context.reader.pdf?.write)
      return done(record(id, op.action, { status: "unsupported", object }), {
        ok: false,
        status: "unsupported",
        detail: "PDF annotation writes are not available in this host; nothing was written",
      });
    const outcome = await context.reader.pdf.write(op, { conversationId: context.conversationId });
    const reread = "read the Doc again (reader read) to see what is stored now";
    switch (outcome.kind) {
      case "saved":
        return done(
          record(id, op.action, {
            status: "ok",
            object,
            label: outcome.label,
            rev: outcome.epoch.annotationsRev,
          }),
          {
            ok: true,
            status: "ok",
            ...(outcome.annotation ? { annotation: outcome.annotation } : {}),
            ...(outcome.deleted ? { deleted: outcome.deleted } : {}),
            ...(outcome.moved ? { [outcome.moved === "undo" ? "undone" : "redone"]: true } : {}),
            epoch: outcome.epoch,
            history: outcome.history,
            observed:
              "saved through the page's own save rules (the original's SHA-256 and the revision were checked in the same critical section); the open PDF Reader shows it at once. epoch.annotationsRev replaces the revision you sent. An update or delete of an annotation needs its updated_at from a reading, or from annotation here",
          }
        );
      case "unchanged":
        return done(
          record(id, op.action, {
            status: "noop",
            object,
            label: outcome.label,
            rev: outcome.epoch.annotationsRev,
          }),
          {
            ok: true,
            status: "noop",
            detail: "the annotation already has exactly this content; nothing was written",
            annotation: outcome.annotation,
            epoch: outcome.epoch,
          }
        );
      case "nothing":
        return done(
          record(id, op.action, { status: "noop", object, rev: outcome.epoch.annotationsRev }),
          {
            ok: true,
            status: "noop",
            reason: outcome.reason,
            detail:
              outcome.reason === "history_ended"
                ? "the annotations were changed by someone else (the user or another call) after your last change, which ends the history, as it ends the panel's undo history; nothing was changed"
                : outcome.reason === "changed"
                  ? "the stored annotations are not what your last change left, so they were not overwritten and the history ended; nothing was changed"
                  : "there is nothing to undo or redo: only changes you made to this Doc through this tool can be undone, and the service keeps them only until it restarts; nothing was changed",
            epoch: outcome.epoch,
          }
        );
      case "conflict":
        return done(
          record(id, op.action, {
            status: "conflict",
            object,
            ...(outcome.epoch.annotationsRev !== null ? { rev: outcome.epoch.annotationsRev } : {}),
          }),
          {
            ok: false,
            status: "conflict",
            reason: outcome.reason,
            current: outcome.epoch,
            ...(outcome.annotation ? { annotation: outcome.annotation } : {}),
            detail:
              outcome.reason === "document_changed"
                ? `the PDF is not the original your reading was of (document changed). Nothing was written. ${reread}, then form a new request from that`
                : outcome.reason === "annotation_changed"
                  ? `this annotation was changed after your reading (annotation shows it now). Nothing was written. ${reread}, decide again from what is stored, then form a new request with the updated_at of that reading; never reuse the old one`
                  : `the annotations changed since your reading (the user or another call saved first; current shows the revision). Nothing was written. ${reread}, then form a new request from that; do not resend with the new revision`,
          }
        );
      case "no_annotation":
        return done(record(id, op.action, { status: "not_found", object }), {
          ok: false,
          status: "not_found",
          detail: `no annotation ${outcome.annotationId} in this PDF (it may have been deleted); nothing was written. ${reread}`,
        });
      case "invalid":
        return done(record(id, op.action, { status: "invalid", object }), {
          ok: false,
          status: "invalid",
          detail: `${outcome.detail}; nothing was written`,
        });
      case "unsupported":
        return done(record(id, op.action, { status: "unsupported", object }), {
          ok: false,
          status: "unsupported",
          detail:
            "this Doc is not a PDF: the PDF annotation actions are for PDF Docs; a LaTeX Doc's annotations are written with create_annotation, update_annotation and delete_annotation; nothing was written",
        });
      case "not_found":
        return done(record(id, op.action, { status: "not_found", object }), {
          ok: false,
          status: "not_found",
          detail: "no such PDF Doc",
        });
      case "busy":
        return done(record(id, op.action, { status: "rejected", object }), {
          ok: false,
          status: "rejected",
          detail:
            "the Doc is being replaced or deleted right now; nothing was written. Try again when the job has finished",
        });
      case "error":
        return done(record(id, op.action, { status: "error", object }), {
          ok: false,
          status: "error",
          detail: outcome.detail,
        });
    }
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
      return done(record(id, "read", { status: "rejected", object }), {
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
  /** `read_page_image`: one original page as an image; a model that cannot see is told so and gets nothing. */
  const readPageImage = async (
    id: string,
    op: ReturnType<typeof ReaderReadPageImageOperationSchema.parse>,
    done: (
      operation: CopilotOperation,
      payload: object,
      image?: { data: string; mimeType: string }
    ) => ToolResult
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
    // Byte limits first: one image over the per-image cap, or images past the history total, are refused whole so that
    // nothing a provider would reject can ever enter the history (which is sent again with every turn).
    const used = context.imageBytesUsed?.() ?? 0;
    if (outcome.png.length > PDF_IMAGE_MAX_BYTES)
      return done(record(id, "read_page_image", { status: "rejected", object }), {
        ok: false,
        status: "rejected",
        detail: `capacity: this page image is ${outcome.png.length} bytes, more than the ${PDF_IMAGE_MAX_BYTES} bytes one image may be; nothing was returned. Ask again with a smaller longEdge`,
      });
    if (used + outcome.png.length > PDF_IMAGE_HISTORY_MAX_BYTES)
      return done(record(id, "read_page_image", { status: "rejected", object }), {
        ok: false,
        status: "rejected",
        detail: `capacity: the images of this conversation would be ${used + outcome.png.length} bytes, more than the ${PDF_IMAGE_HISTORY_MAX_BYTES} bytes they may be together (they are sent again with every turn); nothing was returned. Read fewer pages, or ask for a smaller longEdge, or continue in a new conversation`,
      });
    const room = context.budget?.();
    // An image costs what a model is charged for its pixels (the one rule `imageTokens`, also used for the history),
    // never the length of its base64 text.
    const cost = imageTokens(outcome.width, outcome.height) * IMAGE_BYTES_PER_TOKEN;
    if (room !== undefined && cost + 1024 > room)
      return done(record(id, "read_page_image", { status: "rejected", object }), {
        ok: false,
        status: "rejected",
        detail: `capacity: this page image (${outcome.width}x${outcome.height} px, about ${imageTokens(outcome.width, outcome.height)} tokens) is more than the room left in this model's window (${Math.max(0, room)} bytes at ${IMAGE_BYTES_PER_TOKEN} per token); nothing was returned. Ask again with a smaller longEdge`,
      });
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
      { data, mimeType: "image/png" }
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
      const done = (
        operation: CopilotOperation,
        payload: object,
        image?: { data: string; mimeType: string }
      ): ToolResult => ({
        content: [
          { type: "text" as const, text: JSON.stringify(payload) },
          ...(image ? [{ type: "image" as const, ...image }] : []),
        ],
        details: operation,
      });
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
            return done(record(toolCallId, "read", { status: "rejected", object }), {
              ok: false,
              status: "rejected",
              detail: batched.detail,
              coverage: outcome.reading.coverage,
              batch: batched.coverage,
            });
          return done(
            record(toolCallId, "read", { status: "ok", object, batch: batched.coverage }),
            batched.payload
          );
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
          const written = PdfAnnotationOperationSchema.safeParse(params);
          if (!written.success)
            return done(record(toolCallId, action, { status: "invalid" }), {
              ok: false,
              status: "invalid",
              detail:
                "invalid parameters; nothing was written. Every PDF annotation write needs docId, sha256 and rev from the PDF reading and the fields of its action",
              issues: written.error.issues
                .slice(0, 5)
                .map((issue) => ({ path: issue.path.join("."), message: issue.message })),
            });
          return await writePdf(toolCallId, written.data, done);
        }
        if ((READER_WRITE_ACTIONS as readonly string[]).includes(action)) {
          const written = ReaderWriteOperationSchema.safeParse(params);
          if (!written.success)
            return done(record(toolCallId, action, { status: "invalid" }), {
              ok: false,
              status: "invalid",
              detail:
                "invalid parameters; nothing was written. Every write needs docId, fingerprint and rev from the reading, and the fields of its action",
              issues: written.error.issues
                .slice(0, 5)
                .map((issue) => ({ path: issue.path.join("."), message: issue.message })),
            });
          return await write(toolCallId, written.data, done);
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
        const outcome = viewOutcomeResult(await context.viewAction(parsed.data));
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
