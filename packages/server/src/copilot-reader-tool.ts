import {
  type Annotation,
  type CopilotOperation,
  READER_OPERATION_ACTIONS,
  READER_PANELS,
  READER_RIGHT_TABS,
  READER_WRITE_ACTIONS,
  type ReaderReading,
  ReaderReadOperationSchema,
  type ReaderViewAction,
  ReaderViewActionSchema,
  type ReaderWriteOperation,
  ReaderWriteOperationSchema,
} from "@argelanderspace/contracts";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
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

/**
 * The Reader's data seam. `read` is one read-only pass over the Doc's IR, assets and current annotations. `write` is
 * the annotations PUT's own handler: the same lock, three-state fingerprint rules, double check, save and
 * notification as the page's Save; the tool never ensures, archives or writes a file itself.
 */
export interface ReaderOpDeps {
  read: (docId: string) => Promise<ReaderReadOutcome>;
  write: (operation: ReaderWriteOperation) => Promise<ReaderWriteOutcome>;
}

export interface ReaderToolContext {
  reader: ReaderOpDeps;
  /** Resolves only after the bound browser view reports the outcome. */
  viewAction: (action: ReaderViewAction) => Promise<ViewActionOutcome>;
  /** False once the host stopped admitting operations (Stop, shutdown). */
  admitting: () => boolean;
  /**
   * Bytes this conversation can still take in one tool result (the model's window less what is already in it).
   * A reading larger than that is refused whole, with its size, instead of being cut or poisoning the history.
   */
  budget?: () => number;
}

const lit = <T extends string>(values: readonly T[]) =>
  Type.Unsafe<T>({ type: "string", enum: [...values] });

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
          "create/update/delete_annotation: reading.epoch.annotationsRev of that same reading.",
      })
    ),
    annotationId: Type.Optional(
      Type.String({
        description: "update/delete_annotation: the annotation id (a_ and 8 hex digits).",
      })
    ),
    expectedUpdatedAt: Type.Optional(
      Type.String({
        description:
          "update/delete_annotation: that annotation's updated_at exactly as your latest reading (or write result) showed it. It changes whenever the body changes; if it no longer matches, the annotation was edited after your reading and the call is refused (conflict annotation_changed).",
      })
    ),
    body: Type.Optional(
      Type.String({
        description:
          "create/update_annotation: the annotation text, Markdown with $math$; saved byte for byte, must not be blank.",
      })
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
  "Read and navigate the LaTeX Reader. read returns the WHOLE document of a Doc from disk, in the background, without opening or moving anything: every section, paragraph, list, equation, figure, full table body, code/algorithm body, the whole bibliography, cite/xref identities and the Doc's current annotations with their full bodies, plus the content fingerprint and annotation revision they belong together under. Text is the canonical annotation text: a selection's start/end are UTF-16 offsets into it, math/cite/xref are atomic marks. Saved annotations of older content are left out and the archive is never read. A document too large for the room left in this model's window is refused with its size, never cut.",
  "create_annotation, update_annotation and delete_annotation are the Annotations panel's, the selection toolbar's, the block buttons' and the editor's own operations, run through the page's own save: they write straight to the Doc's saved annotations and the user's open Reader shows the change at once. Plan each from a reading and send its reading.epoch.fingerprint and reading.epoch.annotationsRev: a write whose epoch is no longer current is refused (conflict) and writes nothing, so read the Doc again and form a new request; never just replace the numbers and resend. create_annotation takes target document, structure {id} (the section or block you name; the kind and the full content snapshot are taken from the stored document) or text {block, container, start, end, quote} in the reading's canonical text, where quote is required and must equal the canonical text at [start, end) as you counted it (offsets resent after the document changed can never anchor to different text): one container of one block (a paragraph's content, one list item, a figure/table/code/algorithm caption), UTF-16 offsets; a range that touches the inside of a math, cite or xref mark is widened to the whole mark (the quote is still checked against the range as you gave it; the saved target is in the result); equation, code, algorithm and table bodies and headings can only be structure targets, and a range across containers or blocks is refused. update_annotation and delete_annotation also carry expectedUpdatedAt, that annotation's updated_at exactly as your latest reading or write result showed it: if the annotation was edited after your reading (even when the epoch numbers are current again) the call is refused as conflict annotation_changed and writes nothing; read again, look at what the user wrote, then decide. update_annotation changes only the body (target and created time never change; moving an annotation means delete_annotation then create_annotation); an identical body is noop and writes nothing. delete_annotation removes one annotation at once without a confirmation, as the trash button does. Keys the file has that this application does not know are kept. If the call found the Doc's text replaced it archived the older annotations (as opening the Doc does) and says archivedOlder with their count: tell the user. An error never means your request was written; only the older batch may have been archived (archivedOlder). The body is saved byte for byte. A text the user has typed but not saved is theirs and stays in their editor; page.drafts says whether there is one. Archived annotations cannot be read or written.",
  "navigate/jump_back/set_panel/set_right_tab/retry_sync act on the user's visible Reader like the outline, reference cards, chips, the undo-navigation button, the panel folds, the tabs and Retry: call them only when asked to show something, never to read. navigate and jump_back stop at a Reader that is syncing or showing an error (nothing moves, not_displayed); set_panel, set_right_tab and retry_sync are folds, tabs and Retry and work in any state.",
].join(" ");

/** What `execute` returns: the payload as the model's text and the operation record as details. */
type ToolResult = { content: { type: "text"; text: string }[]; details: CopilotOperation };

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
            "this is a PDF Doc; the Reader tool writes LaTeX Doc annotations only (PDF annotations are not available to you yet)",
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
  return defineTool({
    name: READER_TOOL_NAME,
    label: "Reader",
    description,
    executionMode: "sequential",
    parameters,
    async execute(toolCallId, params) {
      const action = typeof params.action === "string" ? params.action : "unknown";
      const done = (operation: CopilotOperation, payload: object) => ({
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
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
            return done(record(toolCallId, "read", { status: "unsupported", object }), {
              ok: false,
              status: "unsupported",
              detail:
                "this is a PDF Doc; the Reader tool reads LaTeX Docs only (workspace open_doc shows it to the user)",
            });
          if (outcome.kind === "error")
            return done(record(toolCallId, "read", { status: "error", object }), {
              ok: false,
              status: "error",
              detail: outcome.detail,
            });
          const payload = {
            ok: true,
            status: "ok",
            observed:
              "the Doc as stored right now (one coherent read); the user may change annotations afterwards, so read again before relying on them",
            reading: outcome.reading,
          };
          const text = JSON.stringify(payload);
          const room = context.budget?.();
          if (room !== undefined && Buffer.byteLength(text) > room)
            return done(record(toolCallId, "read", { status: "rejected", object }), {
              ok: false,
              status: "rejected",
              detail: `capacity: the complete reading is ${outcome.reading.coverage.characters} characters of text (${Buffer.byteLength(text)} bytes encoded) in ${outcome.reading.coverage.sections} sections, more than the ${Math.max(0, room)} bytes left in this model's window. It was not cut or partly returned; reading it in parts is not available yet`,
              coverage: outcome.reading.coverage,
            });
          return done(record(toolCallId, "read", { status: "ok", object }), payload);
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
        const outcome = viewOutcomeResult(await context.viewAction(parsed.data));
        return done(
          record(toolCallId, action, {
            status: outcome.status,
            object: { kind: "doc", id: parsed.data.docId },
          }),
          outcome.payload
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
