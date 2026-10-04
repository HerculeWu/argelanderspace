import {
  type CopilotOperation,
  GRAPH_CONTROLS,
  LIBRARY_DETAIL_TABS,
  LIBRARY_LABEL_KEYS,
  LIBRARY_OPERATION_ACTIONS,
  LibraryImportWorksSchema,
  LibraryReadOperationSchema,
  type LibrarySetMainDoc,
  LibrarySetMainDocSchema,
  type LibraryViewAction,
  LibraryViewActionSchema,
} from "@argelanderspace/contracts";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { digest, type OperationJournalPort } from "./copilot-plan-tool.js";
import { type ViewActionOutcome, viewOutcomeResult } from "./copilot-workspace-tool.js";
import {
  applyLibraryImport,
  applyLibraryOperation,
  type LibraryImportOutcome,
  type LibraryOpDeps,
  type LibraryOpOutcome,
  readLibrary,
} from "./library-actions.js";

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
          "Optional idempotency key for set_main_doc and import_works. Repeating the same key with the same parameters returns the first result instead of writing again.",
      })
    ),
    query: Type.Optional(
      Type.String({
        description:
          "read: the sidebar search (title, authors, cite key; case-insensitive); an identifier (DOI, doi.org URL, arXiv:<id> or arxiv.org URL, bibcode, or a work id) also matches the work holding it, even one without a title. filter_library: the text to put in the search box (empty clears it).",
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
    mode: Type.Optional(lit(["identifier", "bibcode", "bib"] as const)),
    text: Type.Optional(
      Type.String({
        description:
          "import_works: exactly what the import dialog would receive for that mode. identifier: one DOI, doi.org URL, arXiv:<id> or arxiv.org URL (a bare arXiv id is rejected); bibcode: one ADS bibcode; bib: BibTeX text, one or many entries. Text only: no file paths.",
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
  "Read and operate the user's Library page: the saved works, search, the detail panel and its tabs, and the main-Doc choice. It never uploads files, fetches full text, deletes Docs or explores; notes, tags and the read flag have no editing control in the application, so you cannot change them.",
  "read returns the page's own data: one page of the works matching query (title, authors, cite key), with the total, or one work in full with refId. Reading never opens or selects anything.",
  "set_main_doc is the Files tab's 'set as main': it needs expectedMainDocId, the main Doc from your latest read of that work. If it changed, the result is conflict: read the work again and form a new request; do not resend the stale one. Other fields of the work, including ones you did not read, are kept. If saving fails the status is error: the file was not replaced, except in the rare case of a failure between the two final renames, where library.json may already be updated, so read the work again before deciding. Writes wait their turn behind other library writes; they are not refused as busy.",
  "import_works is the import menu's submit, with the same checks, duplicate detection and results: mode identifier (one DOI or arXiv:<id>), bibcode (one ADS bibcode; fails without a stub when ADS cannot answer) or bib (pasted BibTeX; per-entry results, your cite keys are kept, a key held by another work is an error for that entry). Give it text only; it cannot read files. Creating a Work does not select or open it; use select_work with a returned work id if the user wants it shown. An entry the library already holds comes back as exists and is not duplicated, but the import can still update that Work (blank fields are filled, its acquisition plan is recomputed, its type may change); the result lists those ids in updated, and your own data on it (note, tags, flags) is kept. A new entry without a DOI or arXiv id whose title-and-year derived work id is already used by a different paper (for example part II of a series) is an error for that entry with nothing written: ask the user for a DOI or arXiv id. A record that would merge two existing works into one is refused as rejected with nothing written: tell the user to resolve them in the Library page. Identifier and bibcode imports may also start the default arXiv PDF download exactly as the page does (a separate background job). Statuses: ok if something was created or updated, noop if the library was left exactly as it was, error if nothing was imported (the library is unchanged), rejected as above; results lists each entry. A partial batch is ok with some entries failed; report those. A status unknown means it may have saved some entries: search the library with read and the identifier (DOI, arXiv:<id> or bibcode) or the title as query before deciding, never repeat it blindly.",
  "filter_library, select_work, set_detail_tab, set_sidebar, set_graph_labels and graph_control (zoom_in, zoom_out, fit, relayout of the citation graph; dragging and panning are the user's gestures) change what the user sees in the bound tab; use them only when asked to show something. To open a Doc in the Reader use the workspace tool's open_doc.",
  "set_temp_label sets the colour dot the right-click menu offers. It is temporary: it exists only in that browser tab and is never saved to the library, so do not describe it as saved.",
  "A page whose source is demo is built-in example data, and source error means the library could not be read (see its error): say so, and do not describe its works as the user's.",
  "Only report results whose status is ok or noop as done. A set_main_doc whose status is unknown may or may not have been applied: read the work to find out, never repeat it blindly.",
].join(" ");

/** One readable line for the journal, so a resume note can say what an unfinished import was. */
function importSummary(op: { mode: string; text: string } | undefined): string {
  if (!op) return "";
  const flat = op.text.replace(/\s+/g, " ").trim();
  return `${op.mode}: ${flat.length > 80 ? `${flat.slice(0, 80)}…` : flat}`;
}

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
        const importOp = LibraryImportWorksSchema.safeParse(rest);
        const write = LibrarySetMainDocSchema.safeParse(rest);
        if (!importOp.success && !write.success) {
          const failure = rest.action === "import_works" ? importOp : write;
          return done(record(toolCallId, action, { status: "unsupported" }), {
            ok: false,
            status: "unsupported",
            detail: "unknown action or invalid parameters",
            issues: (failure.success ? [] : failure.error.issues)
              .slice(0, 5)
              .map((issue) => ({ path: issue.path.join("."), message: issue.message })),
          });
        }
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
              "this operation started earlier and its outcome was not recorded; read the library (the work, or search the identifier or title) to find out, do not repeat it blindly",
          });
        try {
          journal?.begin({
            operationId,
            toolCallId,
            action,
            hash,
            object: write.success
              ? { workId: write.data.refId }
              : { summary: importSummary(importOp.success ? importOp.data : undefined) },
          });
        } catch {
          return done(record(toolCallId, action, { status: "error" }), {
            ok: false,
            status: "error",
            detail: "the conversation could not be saved; nothing was written",
          });
        }
        const work: Promise<LibraryOpOutcome | LibraryImportOutcome> = importOp.success
          ? applyLibraryImport(context.library, importOp.data)
          : applyLibraryOperation(context.library, (write as { data: LibrarySetMainDoc }).data);
        const outcome = await (context.track ? context.track(work) : work);
        const failedObject = write.success
          ? { object: { kind: "work" as const, id: write.data.refId } }
          : {};
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
                ...failedObject,
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
