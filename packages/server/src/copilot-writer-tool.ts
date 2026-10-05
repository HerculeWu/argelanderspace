import {
  type CopilotOperation,
  WRITER_OPERATION_ACTIONS,
  WriterDeleteOperationSchema,
  WriterReadOperationSchema,
  WriterViewActionSchema,
  type WriterWriteOperation,
  WriterWriteOperationSchema,
} from "@argelanderspace/contracts";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type ConfirmationPort, digest, type OperationJournalPort } from "./copilot-plan-tool.js";
import { type ViewActionOutcome, viewOutcomeResult } from "./copilot-workspace-tool.js";
import {
  createManuscriptOp,
  deleteManuscriptOp,
  describeManuscriptDelete,
  patchManuscript,
  readWriter,
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
          "update_manuscript/delete_manuscript: the manuscript's rev from your latest read (saved.rev of the page, or read.manuscript.rev).",
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
          { additionalProperties: true }
        ),
        {
          description:
            "update_manuscript: the whole author list (Info modal); replaces the current one.",
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
  },
  { additionalProperties: false }
);

const description = [
  "Read and edit the user's Writer manuscripts: the manuscript list and one manuscript's Info (title, authors, affiliations, extension fields), user preamble and template, the same operations the Writer's list, New dialog, Info and Preamble modals and template select offer. A manuscript is its own object (never a library Work or Doc).",
  "read without manuscriptId returns the list (id, title, template, rev) and the template catalog (id, label, supported cell types, extension field keys); with a manuscriptId it returns the WHOLE saved manuscript from disk (every cell with its full content, comments, info, preamble) with its rev, in the background, without opening or moving anything. Saved content is what is on disk: text the user has typed and not saved yet is theirs, shown in the page context as draft; a draft is never on disk, never replaced and never saved by you.",
  "create_manuscript makes a new empty manuscript from a template (title optional). update_manuscript changes only the fields you give (title, authors, affiliations, userPreamble, infoValues, template); it needs expectedRev from your latest read of THAT manuscript, and every key the file has that the application does not know is kept. Changing the template keeps every cell (those the new template does not list are only flagged, unsupportedCells in the result). Cell, comment, figure and Render operations are not available to you yet; saving never compiles.",
  "delete_manuscript only REQUESTS the delete of the whole manuscript folder (cells, comments and uploaded figures): the user confirms it in the application and the call returns after their decision. You cannot approve it and nothing the user writes in chat approves it; declined and expired mean nothing was deleted.",
  "A write whose expectedRev is no longer current is refused (conflict) and writes nothing: read the manuscript again, look at what changed, then form a new request; never just replace the number and resend. An operationId is bound to its first request.",
  "open_manuscript and close_manuscript change what the user sees (the list row and the editor's back button): call them only when asked, never to read or edit; not_displayed means the user did not see it. Only report a result whose status is ok or noop as done; a status unknown may or may not have been applied: read to find out, never repeat it blindly.",
].join(" ");

/**
 * Appended to the host's system prompt (copilot ticket 22). It adds the Writer to what exists; everything the
 * prompt says about the other tools and about tool results still holds.
 */
export const WRITER_PROMPT =
  " Writer addendum (in addition to everything above, including the statements about which page context and tools exist): the Writer page context and the writer tool exist too. A Writer page is the manuscript list (id, title, template, rev, and the template catalog) or one open manuscript: page.writer.editor.saved is the WHOLE manuscript as last saved on disk (every cell in full, comments, info, preamble), and page.writer.editor.draft, when present, is only what the user has typed and not saved yet (changed fields, changed or new cells in full, removed cells): it is the user's, never on disk, you never replace or save it, and a saved value and a draft value of the same thing must not be confused. A later observation may say the saved manuscript was left out because the task already holds that revision; call writer read for the current one. writer read, create_manuscript, update_manuscript (title, authors, affiliations, userPreamble, infoValues, template; expectedRev from your latest read of that manuscript; the file's unknown keys are kept; a conflict wrote nothing, so read again and form a new request, never just replace the number) and delete_manuscript (it only requests: the user confirms in the application, like delete_plan, and declined or expired mean nothing was deleted) are the Writer list, New dialog, Info and Preamble modals, template select and delete dialog; open_manuscript and close_manuscript only change what the user sees. Cells, comments, figures, Render and export are not available to you yet, and saving never compiles. The template catalog cannot be changed.";

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
          if (view.data.action === "open_manuscript") {
            const found = readWriter(context.writer, view.data.manuscriptId);
            if (found.kind === "not_found")
              return done(record(toolCallId, action, { status: "not_found" }), {
                ok: false,
                status: "not_found",
                detail: "no such manuscript",
              });
          }
          const shown = viewOutcomeResult(await context.viewAction(view.data));
          return done(record(toolCallId, action, { status: shown.status }), shown.payload);
        }
        const deletion = WriterDeleteOperationSchema.safeParse(rest);
        const write = deletion.success ? null : WriterWriteOperationSchema.safeParse(rest);
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
        const op: WriterWriteOperation = write.data;
        if (
          !begin(
            { manuscriptId: "manuscriptId" in op ? op.manuscriptId : undefined },
            "expectedRev" in op ? op.expectedRev : undefined
          )
        )
          return notSaved();
        const work =
          op.action === "create_manuscript"
            ? createManuscriptOp(context.writer, { template: op.template, title: op.title })
            : patchManuscript(context.writer, op);
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
