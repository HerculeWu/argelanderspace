import {
  type CopilotOperation,
  GRAPH_CONTROLS,
  LIBRARY_DETAIL_TABS,
  LIBRARY_LABEL_KEYS,
  LIBRARY_OPERATION_ACTIONS,
  LibraryReadOperationSchema,
  LibrarySetMainDocSchema,
  type LibraryViewAction,
  LibraryViewActionSchema,
} from "@argelanderspace/contracts";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { digest, type OperationJournalPort } from "./copilot-plan-tool.js";
import { type ViewActionOutcome, viewOutcomeResult } from "./copilot-workspace-tool.js";
import { applyLibraryOperation, type LibraryOpDeps, readLibrary } from "./library-actions.js";

export const LIBRARY_TOOL_NAME = "library";

export interface LibraryToolContext {
  library: LibraryOpDeps;
  /** Present in the real host; the write is journaled so a repeated operationId is answered, not rerun. */
  journal?: OperationJournalPort;
  /** Counts an operation as in flight until it settles, so a terminal run state waits for it. */
  track?: <T>(work: Promise<T>) => Promise<T>;
  runId?: string;
  /** Resolves only after the bound browser view reports the outcome. */
  viewAction: (action: LibraryViewAction) => Promise<ViewActionOutcome>;
  /** False once the host stopped admitting operations (Stop, shutdown). */
  admitting: () => boolean;
}

const lit = <T extends string>(values: readonly T[]) =>
  Type.Unsafe<T>({ type: "string", enum: [...values] });

const parameters = Type.Object(
  {
    action: lit(LIBRARY_OPERATION_ACTIONS),
    operationId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 64,
        description:
          "Optional idempotency key for set_main_doc. Repeating the same key with the same parameters returns the first result instead of writing again.",
      })
    ),
    query: Type.Optional(
      Type.String({
        description:
          "read: the sidebar search (title, authors, cite key; case-insensitive). filter_library: the text to put in the search box (empty clears it).",
      })
    ),
    refId: Type.Optional(
      Type.String({
        description:
          "The work id (for example doi:10.1051/..., arxiv:2603.03522). read: return that one work in full. Other actions: the target work; select_work accepts null to close the detail.",
      })
    ),
    offset: Type.Optional(
      Type.Integer({ minimum: 0, description: "read: first match to return." })
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 200, description: "read: page size, default 100." })
    ),
    links: Type.Optional(
      Type.Boolean({ description: "read: also return the citation links among the matched works." })
    ),
    docId: Type.Optional(
      Type.String({ description: "set_main_doc: the Doc to make the main Doc." })
    ),
    expectedMainDocId: Type.Optional(
      Type.Union([Type.String(), Type.Null()], {
        description:
          "set_main_doc: the main Doc (first of doc_ids) you read for this work, or null if it had none. Required.",
      })
    ),
    tab: Type.Optional(lit(LIBRARY_DETAIL_TABS)),
    on: Type.Optional(
      Type.Boolean({ description: "set_graph_labels: show (true) or hide the node labels." })
    ),
    control: Type.Optional(lit(GRAPH_CONTROLS)),
    collapsed: Type.Optional(
      Type.Boolean({ description: "set_sidebar: fold (true) or open the list." })
    ),
    label: Type.Optional(
      Type.Union([lit(LIBRARY_LABEL_KEYS), Type.Null()], {
        description: "set_temp_label: the colour, or null to clear it.",
      })
    ),
  },
  { additionalProperties: false }
);

const description = [
  "Read and operate the user's Library page: the saved works, search, the detail panel and its tabs, and the main-Doc choice. It never imports, uploads, fetches full text, deletes Docs or explores; notes, tags and the read flag have no editing control in the application, so you cannot change them.",
  "read returns the page's own data: one page of the works matching query (title, authors, cite key), with the total, or one work in full with refId. Reading never opens or selects anything.",
  "set_main_doc is the Files tab's 'set as main': it needs expectedMainDocId, the main Doc from your latest read of that work. If it changed, the result is conflict: read the work again and form a new request; do not resend the stale one. Other fields of the work, including ones you did not read, are kept. If saving fails the status is error: the file was not replaced, except in the rare case of a failure between the two final renames, where library.json may already be updated, so read the work again before deciding. Writes wait their turn behind other library writes; they are not refused as busy.",
  "filter_library, select_work, set_detail_tab, set_sidebar, set_graph_labels and graph_control (zoom_in, zoom_out, fit, relayout of the citation graph; dragging and panning are the user's gestures) change what the user sees in the bound tab; use them only when asked to show something. To open a Doc in the Reader use the workspace tool's open_doc.",
  "set_temp_label sets the colour dot the right-click menu offers. It is temporary: it exists only in that browser tab and is never saved to the library, so do not describe it as saved.",
  "A page whose source is demo is built-in example data, and source error means the library could not be read (see its error): say so, and do not describe its works as the user's.",
  "Only report results whose status is ok or noop as done. A set_main_doc whose status is unknown may or may not have been applied: read the work to find out, never repeat it blindly.",
].join(" ");

function record(id: string, action: string, partial: Partial<CopilotOperation>): CopilotOperation {
  return { id, tool: LIBRARY_TOOL_NAME, action, status: "error", ...partial };
}

export function createLibraryTool(context: LibraryToolContext) {
  return defineTool({
    name: LIBRARY_TOOL_NAME,
    label: "Library",
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
        const { operationId: requestedId, ...rest } = params as Record<string, unknown>;
        const read = LibraryReadOperationSchema.safeParse(rest);
        if (read.success) {
          let outcome: Awaited<ReturnType<typeof readLibrary>>;
          try {
            outcome = await readLibrary(context.library, read.data);
          } catch {
            // An unreadable library is an error, never an empty one.
            return done(record(toolCallId, "read", { status: "error" }), {
              ok: false,
              status: "error",
              detail: "the library could not be read; nothing is known about its content",
            });
          }
          if (!outcome.ok)
            return done(record(toolCallId, "read", { status: "not_found" }), outcome);
          return done(
            record(toolCallId, "read", {
              status: "ok",
              ...("ref" in outcome
                ? {
                    object: { kind: "work" as const, id: outcome.ref.id },
                    label: outcome.ref.title,
                  }
                : {}),
            }),
            outcome
          );
        }
        const view = LibraryViewActionSchema.safeParse(rest);
        if (view.success) {
          const shown = viewOutcomeResult(await context.viewAction(view.data));
          const temporary =
            view.data.action === "set_temp_label" && shown.status === "ok"
              ? {
                  temporary: true,
                  detail:
                    "temporary colour dot in the user's current browser tab only; it is not saved in the library and is lost when the page reloads",
                }
              : {};
          return done(record(toolCallId, action, { status: shown.status }), {
            ...shown.payload,
            ...temporary,
          });
        }
        const write = LibrarySetMainDocSchema.safeParse(rest);
        if (!write.success)
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
              "this operation started earlier and its outcome was not recorded; read the work to find out, do not repeat it blindly",
          });
        try {
          journal?.begin({
            operationId,
            toolCallId,
            action,
            hash,
            object: { workId: write.data.refId },
          });
        } catch {
          return done(record(toolCallId, action, { status: "error" }), {
            ok: false,
            status: "error",
            detail: "the conversation could not be saved; nothing was written",
          });
        }
        const work = applyLibraryOperation(context.library, write.data);
        const outcome = await (context.track ? context.track(work) : work);
        const result = outcome.ok
          ? done(
              record(toolCallId, action, {
                status: outcome.status,
                object: outcome.object,
                label: outcome.label,
                ...(outcome.warnings ? { warnings: outcome.warnings } : {}),
              }),
              outcome
            )
          : done(
              record(toolCallId, action, {
                status: outcome.status,
                object: { kind: "work", id: write.data.refId },
              }),
              outcome
            );
        journal?.done(operationId, outcome as unknown as Record<string, unknown>, result.details);
        return result;
      } catch {
        return done(record(toolCallId, action, { status: "unknown" }), {
          ok: false,
          status: "unknown",
          detail:
            "unexpected failure; the outcome is not known, read the work again before retrying",
        });
      }
    },
  });
}
