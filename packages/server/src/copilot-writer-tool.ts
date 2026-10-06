import {
  CELL_FIELD_NAMES,
  type CopilotOperation,
  WRITER_CELL_ACTIONS,
  WRITER_OPERATION_ACTIONS,
  type WriterCellOperation,
  WriterCellOperationSchema,
  WriterDeleteOperationSchema,
  WriterReadOperationSchema,
  WriterRenderOperationSchema,
  WriterViewActionSchema,
  type WriterWriteOperation,
  WriterWriteOperationSchema,
} from "@argelanderspace/contracts";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type ConfirmationPort, digest, type OperationJournalPort } from "./copilot-plan-tool.js";
import { type ViewActionOutcome, viewOutcomeResult } from "./copilot-workspace-tool.js";
import {
  cellOperation,
  createManuscriptOp,
  deleteManuscriptOp,
  describeManuscriptDelete,
  patchManuscript,
  readWriter,
  renderManuscript,
  type WriterOpDeps,
  type WriterOpOutcome,
} from "./writer-actions.js";

export const WRITER_TOOL_NAME = "writer";

export interface WriterToolContext {
  writer: WriterOpDeps;
  /** Present in the real host; create/update/delete are journaled so a repeated operationId is answered, not rerun. */
  journal?: OperationJournalPort;
  track?: <T>(work: Promise<T>) => Promise<T>;
  runId?: string;
  /** A delete waits here for the user (the list's delete dialog). Without it a delete request is refused. */
  confirm?: ConfirmationPort;
  /** Resolves only after the bound browser view reports the outcome. */
  viewAction: (
    action: ReturnType<typeof WriterViewActionSchema.parse>
  ) => Promise<ViewActionOutcome>;
  admitting: () => boolean;
  /** Bytes this conversation can still take in one tool result; a larger reading is refused whole. */
  budget?: () => number;
  /** The file the user attached to a message of THIS conversation (the figure's image chooser); anything else is null. */
  attachment?: (attachmentId: string) => { meta: { filename: string }; bytes: Buffer } | null;
}

const lit = <T extends string>(values: readonly T[]) =>
  Type.Unsafe<T>({ type: "string", enum: [...values] });

const parameters = Type.Object(
  {
    action: lit(WRITER_OPERATION_ACTIONS),
    operationId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 64,
        description:
          "Optional idempotency key for a write. Repeating the same key with the same parameters returns the first result instead of writing again.",
      })
    ),
    manuscriptId: Type.Optional(
      Type.String({
        description:
          "The manuscript id (m_ and 8 hex digits). Every action names its own manuscript, never the page currently shown.",
      })
    ),
    expectedRev: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          "Every write (update_manuscript, delete_manuscript and all cell operations): the manuscript's rev from your latest read (saved.rev of the page, or read.manuscript.rev).",
      })
    ),
    template: Type.Optional(
      Type.String({
        description:
          "create_manuscript: a template id from read (the New dialog's template). update_manuscript: re-bind to another template (the editor's template select; cells it does not list are kept).",
      })
    ),
    title: Type.Optional(
      Type.String({
        description:
          "create_manuscript: the name (blank = default). update_manuscript: the title (Info modal).",
      })
    ),
    authors: Type.Optional(
      Type.Array(
        Type.Object(
          {
            name: Type.Optional(Type.String()),
            aff: Type.Optional(
              Type.String({ description: 'Affiliation number(s) as shown superscript, e.g. "1".' })
            ),
            email: Type.Optional(Type.String()),
          },
          { additionalProperties: false }
        ),
        {
          description:
            "update_manuscript: the whole author list (Info modal); replaces the current one. Keys the file has on an author beyond name/aff/email are kept only when the list keeps its length and the author at that index keeps its name (or you omit the name); a removed, added, reordered or renamed author does not inherit anything from another.",
        }
      )
    ),
    affiliations: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "update_manuscript: the whole affiliation list (Info modal); replaces the current one.",
      })
    ),
    userPreamble: Type.Optional(
      Type.String({
        description:
          "update_manuscript: the user preamble LaTeX (Preamble modal); the template's own preamble is read-only and not part of it. Replaces the current one.",
      })
    ),
    infoValues: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description:
          "update_manuscript: values for the template's extension fields (read lists their keys); the keys you give are set, the others stay.",
      })
    ),
    cellId: Type.Optional(
      Type.String({
        description:
          "update_cell, delete_cell, convert_cell, add_comment, insert_reference, set_figure_image, select_cell, edit_cell: the cell id (c_ and 8 hex digits) from your reading.",
      })
    ),
    cellType: Type.Optional(
      Type.String({
        description:
          "insert_cell: the type of the new cell (the add menu: only types the bound template lists). convert_cell: the new type (the type menu: the template's types and latex). One of latex, abstract-aa, figure, table, code, ack, appendix, recipient.",
      })
    ),
    index: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          "insert_cell: where the new cell goes (0 = first, the cell count = last; omit for last).",
      })
    ),
    fields: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description: `insert_cell, update_cell: the editing form's fields of that cell type; only the fields you give change. ${Object.entries(
          CELL_FIELD_NAMES
        )
          .map(([type, names]) => `${type}: ${names.join(", ") || "none"}`)
          .join(
            "; "
          )}. placement is left|center|right, width a percentage (figure 35-100, table 40-100), lineNumbers a boolean, label letters, digits and : _ . - / only. A figure's image is set with set_figure_image.`,
      })
    ),
    body: Type.Optional(
      Type.String({ description: "add_comment: the plain-text note (the Comments tab's Add)." })
    ),
    field: Type.Optional(
      Type.String({
        description:
          "insert_reference: the text field of the cell to insert into (latex/ack source, abstract part, caption, csv, code...).",
      })
    ),
    offset: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          "insert_reference: UTF-16 offset into that field (0 up to its length) where the text goes.",
      })
    ),
    kind: Type.Optional(lit(["cite", "label"] as const)),
    text: Type.Optional(
      Type.String({
        description:
          "insert_reference: a cite key of the saved library (kind cite) or a label (kind label), inserted bare, never wrapped in a cite or ref command. A label may be omitted when target needs one.",
      })
    ),
    target: Type.Optional(
      Type.Object(
        {
          cellId: Type.String(),
          envIndex: Type.Optional(Type.Integer({ minimum: 0 })),
          sectionIndex: Type.Optional(Type.Integer({ minimum: 0 })),
        },
        {
          additionalProperties: false,
          description:
            "insert_reference kind label: the cell (and its n-th numbered equation environment or heading) that must carry the label; a missing label is added there first, like the Crossrefs tab.",
        }
      )
    ),
    attachmentId: Type.Optional(
      Type.String({
        description:
          "set_figure_image: the id of an image the user attached to a message of this conversation.",
      })
    ),
    panel: Type.Optional(lit(["outline", "references"] as const)),
    collapsed: Type.Optional(
      Type.Boolean({ description: "set_writer_panel: true folds the panel." })
    ),
    tab: Type.Optional(lit(["references", "crossrefs", "comments"] as const)),
  },
  { additionalProperties: false }
);

const description = [
  "Read and edit the user's Writer manuscripts: the manuscript list, one manuscript's Info (title, authors, affiliations, extension fields), user preamble and template, its cells, comments and figures, and Render and export, the same operations the Writer's list, New dialog, Info and Preamble modals, template select, add/type menus, editing forms, Comments, References and Crossrefs tabs, image chooser, Render and Export buttons offer. A manuscript is its own object (never a library Work or Doc).",
  "read without manuscriptId returns the list (id, title, template, rev) and the template catalog (id, label, supported cell types, extension field keys); with a manuscriptId it returns the WHOLE saved manuscript from disk (every cell with its full content, comments, info, preamble) with its rev, the labels its cells define and its figure files, in the background, without opening or moving anything. Saved content is what is on disk: text the user has typed and not saved yet is theirs, shown in the page context as draft; a draft is never on disk, never replaced and never saved by you.",
  "create_manuscript makes a new empty manuscript from a template (title optional). update_manuscript changes only the fields you give (title, authors, affiliations, userPreamble, infoValues, template); it needs expectedRev from your latest read of THAT manuscript, and every key the file has that the application does not know is kept. Changing the template keeps every cell (those the new template does not list are only flagged, unsupportedCells in the result).",
  "Cells: insert_cell (the add menu; a type the bound template lists, at an index, with the editing form's fields), update_cell (set fields of one cell; only that type's fields), delete_cell (at once, like the page; its comments stay), convert_cell (the type menu: LOSSY by design, to latex keeps the serialized source, any other type starts from its defaults and does not get the old content back, so say so before converting something with content), add_comment (a plain-text note on a cell), insert_reference (a bare cite key of the saved library, or a bare label, at a UTF-16 offset of a text field; a label can be completed on a target cell first; nothing is wrapped) and set_figure_image (an image the user attached to the conversation; you never get a path, URL or the bytes). There is no reordering of cells and no template or Info-field management, because the page has none. Each of these writes only what it names, needs expectedRev from your latest read (and uses the rev in its result for the next one), keeps every key of the file it does not know, and the result names the cell it made or touched. Text you write is compiled by the real TeX engine, so file reading and writing, program execution and hidden control words (\\input, \\write, \\openin, \\csname, ^^ codes, packages that read files...) are refused with invalid and nothing is written. If the machine has no OS sandbox for TeX, render_manuscript and commit_cell are rejected (nothing compiles because of you); tell the user, who can press Render. Saving never compiles.",
  "render_manuscript is the Render button: it compiles the SAVED manuscript now (never the user's unsaved draft) and returns after the compile; ok means a preview was produced (read its warnings, and stale means the manuscript changed again while it ran), error carries the compile error and keeps the last good preview. Nothing renders unless you call it. export_manuscript is the Export button: the user's browser downloads the source zip, and like the button it first lets the page save its pending autosave (that can store text the user typed; you never save a draft yourself); it needs the manuscript open in the user's Writer (not_displayed otherwise).",
  "delete_manuscript only REQUESTS the delete of the whole manuscript folder (cells, comments and uploaded figures): the user confirms it in the application and the call returns after their decision. You cannot approve it and nothing the user writes in chat approves it; declined and expired mean nothing was deleted.",
  "A write whose expectedRev is no longer current is refused (conflict) and writes nothing: read the manuscript again, look at what changed, then form a new request; never just replace the number and resend. An operationId is bound to its first request.",
  "open_manuscript, close_manuscript, export_manuscript, select_cell, edit_cell, commit_cell (leave the editing form, save the pending autosave and render, like the button), set_writer_panel, set_writer_tab, dismiss_template_warning and retry_manuscript_list change what the user sees (the list row, the editor's back and Export buttons, a click on a cell, the pencil, the form's Render-this-cell button, the panel folds, the right tabs, the template warning's close button and the list's Retry): call them only when asked, never to read or edit; not_displayed means the user did not see it. Only report a result whose status is ok or noop as done; a status unknown may or may not have been applied: read to find out, never repeat it blindly.",
].join(" ");

/**
 * Appended to the host's system prompt (copilot ticket 22). It adds the Writer to what exists; everything the
 * prompt says about the other tools and about tool results still holds.
 */
export const WRITER_PROMPT =
  " Writer addendum (in addition to everything above, including the statements about which page context and tools exist): the Writer page context and the writer tool exist too. A Writer page is the manuscript list (id, title, template, rev, and the template catalog) or one open manuscript: page.writer.editor.saved is the WHOLE manuscript as last saved on disk (every cell in full, comments, info, preamble), and page.writer.editor.draft, when present, is only what the user has typed and not saved yet (changed fields, changed or new cells in full, removed cells): it is the user's, never on disk, you never replace or save it yourself (only the page's own autosave does, which export_manuscript and commit_cell trigger exactly as their buttons do), and a saved value and a draft value of the same thing must not be confused. A later observation may say the saved manuscript was left out because the task already holds that revision; call writer read for the current one. writer read, create_manuscript, update_manuscript (title, authors, affiliations, userPreamble, infoValues, template; expectedRev from your latest read of that manuscript; the file's unknown keys are kept; a conflict wrote nothing, so read again and form a new request, never just replace the number) and delete_manuscript (it only requests: the user confirms in the application, like delete_plan, and declined or expired mean nothing was deleted) are the Writer list, New dialog, Info and Preamble modals, template select and delete dialog; open_manuscript, close_manuscript, export_manuscript, select_cell, edit_cell, commit_cell, set_writer_panel, set_writer_tab, dismiss_template_warning and retry_manuscript_list only change what the user sees. The cell operations (insert_cell, update_cell, delete_cell, convert_cell, add_comment, insert_reference, set_figure_image) are the editor's add and type menus, editing forms, Comments tab, References and Crossrefs inserts and image chooser: each needs expectedRev from your latest read, writes only what it names, and its result carries the new rev for the next one; convert_cell is lossy by design (tell the user first when the cell has content); a figure image comes only from a file the user attached; text you write that reads or writes files, runs programs or hides control words is refused. render_manuscript compiles the saved manuscript when you call it and only then (saving, opening and switching never compile); a compile error is a failure, not a result to hide; export_manuscript starts the user's download (the page first saves its own pending autosave, like the Export button; that is the page's save, not yours). commit_cell and export_manuscript act on the user's open editor. The template catalog cannot be changed and cells cannot be reordered, because the page cannot.";

type ToolResult = { content: { type: "text"; text: string }[]; details: CopilotOperation };

function record(id: string, action: string, partial: Partial<CopilotOperation>): CopilotOperation {
  return { id, tool: WRITER_TOOL_NAME, action, status: "error", ...partial };
}

export function createWriterTool(context: WriterToolContext) {
  const done = (operation: CopilotOperation, payload: object): ToolResult => ({
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    details: operation,
  });
  const reread = "read the manuscript again to see what is stored now";

  /** A shared outcome as the model's result and the operation record. */
  const settle = (
    toolCallId: string,
    action: string,
    outcome: WriterOpOutcome,
    extra: Record<string, unknown> = {}
  ) => {
    const object = { kind: "manuscript" as const, id: outcome.ok ? outcome.id : "" };
    if (outcome.ok)
      return done(
        record(toolCallId, action, {
          status: outcome.status,
          rev: outcome.rev,
          object,
          label: outcome.label,
        }),
        {
          ok: true,
          status: outcome.status,
          id: outcome.id,
          rev: outcome.rev,
          title: outcome.label,
          ...extra,
        }
      );
    return done(
      record(toolCallId, action, {
        status: outcome.status,
        ...(outcome.currentRev !== undefined ? { rev: outcome.currentRev } : {}),
      }),
      {
        ok: false,
        status: outcome.status,
        ...(outcome.currentRev !== undefined ? { currentRev: outcome.currentRev } : {}),
        detail:
          outcome.status === "conflict"
            ? `${outcome.detail}; nothing was written. ${reread}, then form a new request (a new operationId)`
            : `${outcome.detail}; nothing was written`,
      }
    );
  };

  return defineTool({
    name: WRITER_TOOL_NAME,
    label: "Writer",
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
        const { operationId: requestedId, ...rest } = params as Record<string, unknown>;
        const read = WriterReadOperationSchema.safeParse(rest);
        if (read.success) {
          const outcome = readWriter(context.writer, read.data.manuscriptId);
          if (outcome.kind === "not_found")
            return done(record(toolCallId, "read", { status: "not_found" }), {
              ok: false,
              status: "not_found",
              detail: "no such manuscript",
            });
          if (outcome.kind === "error")
            return done(record(toolCallId, "read", { status: "error" }), {
              ok: false,
              status: "error",
              detail: outcome.detail,
            });
          const payload =
            outcome.kind === "list"
              ? {
                  ok: true,
                  status: "ok",
                  observed:
                    "the manuscripts as stored right now; the user may change them afterwards, read again before relying on them",
                  manuscripts: outcome.manuscripts,
                  templates: outcome.templates.map((template) => ({
                    id: template.id,
                    label: template.label,
                    types: template.types,
                    infoFields: template.infoFields,
                  })),
                  ...(outcome.warnings.length ? { warnings: outcome.warnings } : {}),
                }
              : {
                  ok: true,
                  status: "ok",
                  observed:
                    "the manuscript as saved on disk right now (one read); text the user typed and has not saved is not in it (page.writer.editor.draft). The user may change it afterwards, read again before relying on it",
                  manuscript: outcome.manuscript,
                  template: outcome.template
                    ? {
                        id: outcome.template.id,
                        label: outcome.template.label,
                        types: outcome.template.types,
                        infoFields: outcome.template.infoFields,
                      }
                    : null,
                  unsupportedCellIds: outcome.unsupportedCellIds,
                  labels: outcome.labels,
                  assets: outcome.assets,
                };
          const text = JSON.stringify(payload);
          const room = context.budget?.();
          if (room !== undefined && Buffer.byteLength(text) > room)
            return done(record(toolCallId, "read", { status: "rejected" }), {
              ok: false,
              status: "rejected",
              detail: `capacity: the complete reading is ${Buffer.byteLength(text)} bytes encoded, more than the ${Math.max(0, room)} bytes left in this model's window. It was not cut or partly returned; reading it in parts is not available yet`,
            });
          return done(
            record(toolCallId, "read", {
              status: "ok",
              ...(outcome.kind === "manuscript"
                ? {
                    rev: outcome.manuscript.rev,
                    object: { kind: "manuscript" as const, id: outcome.manuscript.id },
                    label: outcome.manuscript.title,
                  }
                : {}),
            }),
            payload
          );
        }
        const view = WriterViewActionSchema.safeParse(rest);
        if (view.success) {
          // commit_cell renders: without the OS sandbox the Copilot never causes a compile (the server's refresh route
          // refuses the marked request too; this stops it before the browser is asked).
          if (view.data.action === "commit_cell" && !context.writer.sandboxed())
            return done(record(toolCallId, action, { status: "rejected" }), {
              ok: false,
              status: "rejected",
              detail:
                "render not available: this machine has no OS sandbox for the Writer's TeX compile, so the Copilot cannot start a render (the user can press Render themselves); nothing was done",
            });
          if (view.data.action === "open_manuscript") {
            const found = readWriter(context.writer, view.data.manuscriptId);
            if (found.kind === "not_found")
              return done(record(toolCallId, action, { status: "not_found" }), {
                ok: false,
                status: "not_found",
                detail: "no such manuscript",
              });
          }
          const shown = viewOutcomeResult(await context.viewAction(view.data), view.data.action);
          return done(record(toolCallId, action, { status: shown.status }), shown.payload);
        }
        const rendering = WriterRenderOperationSchema.safeParse(rest);
        if (rendering.success) {
          // The Render button: a compile of the saved manuscript. Not a manuscript write (nothing is journaled or
          // rev-checked); a submitted compile finishes on its own after a Stop (the in-flight tracking), and the
          // previous good preview is never replaced by a failed one.
          const track = <T>(work: Promise<T>) => (context.track ? context.track(work) : work);
          const object = { kind: "manuscript" as const, id: rendering.data.manuscriptId };
          const outcome = await track(
            renderManuscript(context.writer, rendering.data.manuscriptId)
          );
          if (!outcome.ok)
            return done(record(toolCallId, action, { status: outcome.status, object }), {
              ok: false,
              status: outcome.status,
              detail: `${outcome.detail}; nothing in the manuscript was changed`,
            });
          return done(record(toolCallId, action, { status: "ok", rev: outcome.rev, object }), {
            ok: true,
            status: "ok",
            id: outcome.id,
            rev: outcome.rev,
            rendered:
              "the saved manuscript; compiledRev is the rev the preview was made from (null if the manuscript changed while it compiled)",
            compiledRev: outcome.compiledRev,
            stale: outcome.stale,
            warnings: outcome.warnings,
          });
        }
        const deletion = WriterDeleteOperationSchema.safeParse(rest);
        const isCellAction = (WRITER_CELL_ACTIONS as readonly unknown[]).includes(rest.action);
        const write = deletion.success
          ? null
          : isCellAction
            ? WriterCellOperationSchema.safeParse(rest)
            : WriterWriteOperationSchema.safeParse(rest);
        if (write && !write.success)
          return done(record(toolCallId, action, { status: "unsupported" }), {
            ok: false,
            status: "unsupported",
            detail: "unknown action or invalid parameters",
            issues: write.error.issues
              .slice(0, 5)
              .map((issue) => ({ path: issue.path.join("."), message: issue.message })),
          });
        const journal = context.journal;
        const operationId =
          typeof requestedId === "string" && requestedId
            ? requestedId
            : `${context.runId ?? "run"}:${toolCallId}`;
        const hash = digest(rest);
        const known = journal?.lookup(operationId);
        if (known && known.hash !== hash)
          return done(record(toolCallId, action, { status: "rejected" }), {
            ok: false,
            status: "rejected",
            detail: "operationId was already used for a different request",
          });
        if (known?.state === "done")
          return done(
            { ...known.operation, id: toolCallId },
            { ...known.payload, duplicate: true }
          );
        if (known)
          return done(record(toolCallId, action, { status: "unknown" }), {
            ok: false,
            status: "unknown",
            detail:
              "this operation started earlier and its outcome was not recorded; read the manuscripts to find out, do not repeat it blindly",
          });
        const track = <T>(work: Promise<T>) => (context.track ? context.track(work) : work);
        const begin = (object: { manuscriptId?: string }, baseRev?: number) => {
          try {
            journal?.begin({ operationId, toolCallId, action, hash, object, baseRev });
            return true;
          } catch {
            return false;
          }
        };
        const notSaved = () =>
          done(record(toolCallId, action, { status: "error" }), {
            ok: false,
            status: "error",
            detail: "the conversation could not be saved; nothing was written",
          });
        if (deletion.success) {
          const request = deletion.data;
          if (!context.confirm)
            return done(record(toolCallId, action, { status: "unsupported" }), {
              ok: false,
              status: "unsupported",
              detail:
                "deleting a manuscript needs the user's confirmation and none is available here",
            });
          const target = describeManuscriptDelete(context.writer, request.manuscriptId);
          if (target === null)
            return done(record(toolCallId, action, { status: "not_found" }), {
              ok: false,
              status: "not_found",
              detail: "no such manuscript",
            });
          if ("error" in target)
            return done(record(toolCallId, action, { status: "error" }), {
              ok: false,
              status: "error",
              detail: target.error,
            });
          if (target.rev !== request.expectedRev)
            return done(record(toolCallId, action, { status: "conflict", rev: target.rev }), {
              ok: false,
              status: "conflict",
              currentRev: target.rev,
              detail: `the manuscript changed since your reading; ${reread}, then request the delete with a new operationId`,
            });
          const object = { kind: "manuscript" as const, id: target.id };
          let decision: Awaited<ReturnType<ConfirmationPort["request"]>>;
          try {
            decision = await context.confirm.request({
              toolCallId,
              action: "delete_manuscript",
              manuscriptId: target.id,
              label: target.title,
              impact: target.impact,
              baseRev: target.rev,
              objectDigest: target.digest,
            });
          } catch {
            return done(record(toolCallId, action, { status: "error" }), {
              ok: false,
              status: "error",
              detail: "the confirmation could not be saved; nothing was deleted",
            });
          }
          if (decision.outcome === "declined")
            return done(
              record(toolCallId, action, { status: "declined", object, label: target.title }),
              {
                ok: false,
                status: "declined",
                detail: "the user declined; nothing was deleted",
              }
            );
          if (decision.outcome === "expired")
            return done(
              record(toolCallId, action, { status: "expired", object, label: target.title }),
              {
                ok: false,
                status: "expired",
                detail:
                  decision.reason === "stale"
                    ? "the manuscript changed before the user confirmed; nothing was deleted. Read again and ask only if it is still wanted"
                    : "the request ended before the user confirmed; nothing was deleted",
              }
            );
          // Approved by the user. From here the delete is a submitted write: Stop does not interrupt it.
          if (!begin({ manuscriptId: target.id }, target.rev)) return notSaved();
          const outcome = await track(
            deleteManuscriptOp(context.writer, target.id, {
              rev: target.rev,
              digest: target.digest,
            })
          );
          const expiredNow = !outcome.ok && outcome.status === "conflict";
          const result = expiredNow
            ? done(record(toolCallId, action, { status: "expired", object, label: target.title }), {
                ok: false,
                status: "expired",
                detail:
                  "the manuscript changed before the delete ran; nothing was deleted. Read again and ask only if it is still wanted",
              })
            : settle(
                toolCallId,
                action,
                outcome.ok ? { ...outcome, label: target.title } : outcome
              );
          journal?.done(operationId, JSON.parse(result.content[0]?.text ?? "{}"), result.details);
          return result;
        }
        if (!write?.success) throw new Error("unreachable");
        const op: WriterWriteOperation | WriterCellOperation = write.data;
        if (
          !begin(
            { manuscriptId: "manuscriptId" in op ? op.manuscriptId : undefined },
            "expectedRev" in op ? op.expectedRev : undefined
          )
        )
          return notSaved();
        const work =
          op.action === "create_manuscript"
            ? createManuscriptOp(
                context.writer,
                { template: op.template, title: op.title },
                { screen: true }
              )
            : op.action === "update_manuscript"
              ? patchManuscript(context.writer, op)
              : cellOperation(context.writer, op, {
                  ...(context.attachment ? { attachment: context.attachment } : {}),
                });
        const outcome = await track(work);
        const result = settle(
          toolCallId,
          action,
          outcome,
          outcome.ok && "unsupportedCells" in outcome && outcome.unsupportedCells
            ? {
                unsupportedCells: outcome.unsupportedCells,
                note: `${outcome.unsupportedCells} cell(s) have a type the new template does not list; they are kept unchanged and flagged for the user`,
              }
            : outcome.ok && outcome.detail
              ? outcome.detail
              : {}
        );
        journal?.done(operationId, JSON.parse(result.content[0]?.text ?? "{}"), result.details);
        return result;
      } catch {
        // Never claim "nothing changed": the write may or may not have reached the disk.
        return done(record(toolCallId, action, { status: "unknown" }), {
          ok: false,
          status: "unknown",
          detail:
            "unexpected failure; the outcome is not known, read the manuscript again before retrying",
        });
      }
    },
  });
}
