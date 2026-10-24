/**
 * The Copilot's `shelf` tool (shelf ticket 07; contracts「文献仓」, ADR 0005, ADR 0013): the Shelf (文献仓) for the
 * model. It lists and searches the Shelf with the rows of `GET /api/shelf` (bibliography, Doc kinds, annotation and
 * argument counts; never an annotation body, note text or a graph) and asks for its four writes — add, replace (an add of a paper the
 * Shelf already has), delete and take — through the very functions the routes use (`createShelfWriter`,
 * `createShelfTake`): their meaning is not changed here.
 *
 * Every write waits for the user's confirmation card, and nothing the model sends can approve one: no schema has a
 * confirm, impact or digest field (TypeBox and zod both refuse unknown keys), and the tool never sees the card's id.
 * The service makes the request from the model's choices BEFORE the card exists and keeps it: the card shows the
 * read-only preview of exactly that request (the request itself is on the card), and an approval sends exactly that
 * request — for an add with the previewed replacement `impact` as `confirm`, for a take with the previewed
 * `planDigest`, for a delete at the rev shown. The model's later calls cannot change it. The click checks the preview
 * again (`copilot-confirmations/shelf.ts`), the tool checks once more before writing, and the server compares under
 * its own locks (`confirmation_changed`, `plan_changed`, `rev_mismatch`): a difference writes nothing, and the model is
 * told so and may ask again (a new card).
 */
import {
  type CopilotOperation,
  SHELF_OPERATION_ACTIONS,
  ShelfAddOperationSchema,
  type ShelfAddPreviewRequest,
  type ShelfAddPreviewResponse,
  type ShelfAddResponse,
  ShelfDeleteOperationSchema,
  ShelfListOperationSchema,
  type ShelfListRow,
  type ShelfReplacedEntry,
  ShelfTakeOperationSchema,
  type ShelfTakePreview,
  type ShelfTakeRequest,
  type ShelfTakeResult,
} from "@argelanderspace/contracts";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  askUser,
  confirmUnavailable,
  digest,
  done,
  type Op,
  record as recordFor,
  runOperation,
  type ToolHostContext,
  type ToolResult,
} from "./copilot-tool-kit.js";
import type { ShelfAnswer, ShelfWriter } from "./shelf-add.js";
import type { ShelfTake } from "./shelf-take.js";

export const SHELF_TOOL_NAME = "shelf";

/** What the tool and its confirmation kinds use: the app's own Shelf writer and take, and the list of the route. */
export interface ShelfOpDeps {
  /** The app's one writer (`POST /api/shelf/entries`, its preview, `DELETE /api/shelf/entries/:id`). */
  writer: Pick<ShelfWriter, "add" | "preview" | "remove">;
  /** The app's one take (`POST /api/shelf/entries/:id/take` and its preview). */
  take: ShelfTake;
  /** The rows of `GET /api/shelf`; throws when the Shelf cannot be read (never an empty list). */
  list(): Promise<ShelfListRow[]>;
  /** A Work of this project, as the library lists it; "error" when the library cannot be read. */
  work(workId: string): { id: string; title: string; docIds: string[] } | null | "error";
}

export interface ShelfToolContext extends ToolHostContext {
  shelf: ShelfOpDeps;
}

/** The binding of an add card: the request and its read-only preview. */
export function shelfAddDigest(
  request: ShelfAddPreviewRequest,
  preview: ShelfAddPreviewResponse
): string {
  return digest({ request, preview });
}
/**
 * The binding of a delete card: the entry's list row, without the argument count. The count is read from the graph
 * file each time and is null when that read fails, so binding it would turn a system error at the click into "the
 * entry changed"; the card does not show it, and the rev already binds the entry's content.
 */
export function shelfDeleteDigest(row: ShelfListRow): string {
  if (row.status !== "ok") return digest({ row });
  const { argumentCount: _count, ...bound } = row;
  return digest({ row: bound });
}
/** What a delete card shows of an entry of this build's format (the shape of a replacement's impact row). */
export function deletedEntryOf(row: Extract<ShelfListRow, { status: "ok" }>): ShelfReplacedEntry {
  return {
    entryId: row.entryId,
    rev: row.rev,
    title: row.title,
    addedAt: row.addedAt,
    sourceProject: row.source.project,
    docs: row.docs.map((d) => ({ docId: d.docId, kind: d.kind, bytes: d.bytes })),
    annotations: row.annotations,
    argumentGraph: row.argumentGraph,
    note: row.note,
  };
}

const lit = <T extends string>(values: readonly T[]) =>
  Type.Unsafe<T>({ type: "string", enum: [...values] });

const parameters = Type.Object(
  {
    action: lit(SHELF_OPERATION_ACTIONS),
    operationId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 64,
        description: "Optional idempotency key (writes).",
      })
    ),
    query: Type.Optional(Type.String({ description: "list: search text; empty lists all." })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "default 50" })),
    workId: Type.Optional(Type.String({ description: "add: the project's work." })),
    docIds: Type.Optional(
      Type.Array(Type.String(), { description: "add: Docs to carry; default all." })
    ),
    annotations: Type.Optional(
      Type.Record(Type.String(), Type.Array(Type.String()), {
        description: "add: per Doc, annotation ids to carry; default none.",
      })
    ),
    argumentGraph: Type.Optional(
      Type.Boolean({ description: "add: default false; take: default true." })
    ),
    note: Type.Optional(Type.Boolean({ description: "add: default false; take: default true." })),
    entryId: Type.Optional(Type.String({ description: "delete, take: from list." })),
    rev: Type.Optional(Type.Integer({ minimum: 1, description: "delete, take: from list." })),
    excludeAnnotations: Type.Optional(
      Type.Record(Type.String(), Type.Union([Type.Literal("all"), Type.Array(Type.String())]), {
        description: 'take: per Doc, annotation ids not to take, or "all".',
      })
    ),
  },
  { additionalProperties: false }
);

const description = [
  "The user's Shelf (文献仓): their own store of papers outside any project. An entry is a COPY of a project's work (bibliography, chosen Docs, optionally chosen annotations, argument graph, note); take copies it into the open project. Copies never affect each other; nothing can be read or annotated inside the Shelf.",
  "list (query: title, authors, year, DOI, arXiv, OpenAlex or entry id) gives entry id and rev, bibliography, origin, Docs with kind and annotation counts, and whether a graph and a note are held; never annotation text, the note or the graph. incompatible rows (newer format) can only be deleted.",
  "add, delete and take only REQUEST: the user sees a card with exactly what will be done and only their click does it. You cannot approve it; nothing in chat or a page does. declined: do not ask again unless asked. expired: what the card showed changed and nothing was written; read again and ask only if still wanted.",
  "add (workId, docIds, annotations ids per Doc from the reader tool, argumentGraph, note): when the Shelf holds the same paper (DOI, arXiv or OpenAlex id) it REPLACES those entries whole, as the card says. A text Doc transcribed from a PDF of the work is a Doc of its own; carry its source PDF too unless the user says otherwise (the page's dialog ticks it with the text Doc). delete removes one entry (only the Shelf's copy, no recycle bin). take (entryId, rev, excludeAnnotations): the card shows the plan — new or merged work (only blank fields filled), main Doc, Docs taken or skipped and why, graph and note.",
  "ok is done; rejected, invalid, not_found and error wrote nothing unless the result says so (archived names annotation batches the access path archived); unknown: list the Shelf or read the library first, never repeat blindly.",
].join(" ");

const record = (id: string, action: string, partial: Partial<CopilotOperation>) =>
  recordFor(SHELF_TOOL_NAME, id, action, partial);
const entryObject = (id: string) => ({ kind: "shelf_entry" as const, id });
const workObject = (id: string) => ({ kind: "work" as const, id });

/** The tool status of a refusal the Shelf routes answered. */
function refusalStatus(answer: { status: number; code?: unknown }): CopilotOperation["status"] {
  if (answer.status === 404) return "not_found";
  if (answer.status === 400) return "invalid";
  if (answer.code === "lock_lost") return "unknown";
  if (answer.status >= 500) return "error";
  return "rejected";
}

/**
 * A refusal of a route, for the model: its code, detail and the objects it names (never content). `extra.status`, when
 * given, is the tool status instead of the one the HTTP status maps to (a change found after the click is `expired`).
 */
function refused(
  toolCallId: string,
  action: string,
  answer: { status: number; body: Record<string, unknown> },
  named: Partial<CopilotOperation>,
  extra: Record<string, unknown> & { status?: CopilotOperation["status"] } = {}
): ToolResult {
  const status = extra.status ?? refusalStatus({ status: answer.status, code: answer.body.code });
  return done(record(toolCallId, action, { status, ...named }), {
    ok: false,
    ...answer.body,
    ...extra,
    status,
  });
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** list: the route's rows, searched and paged. */
async function list(
  context: ShelfToolContext,
  toolCallId: string,
  op: { query?: string | undefined; offset?: number | undefined; limit?: number | undefined }
): Promise<ToolResult> {
  let rows: ShelfListRow[];
  try {
    rows = await context.shelf.list();
  } catch {
    // An unreadable Shelf is an error, never an empty one.
    return done(record(toolCallId, "list", { status: "error" }), {
      ok: false,
      status: "error",
      code: "shelf_unreadable",
      detail: "the Shelf could not be read; nothing is known about its content",
    });
  }
  const q = (op.query ?? "").trim().toLowerCase();
  const matches = (row: ShelfListRow) => {
    if (!q) return true;
    const fields: string[] = [row.entryId];
    if (row.status === "ok")
      fields.push(
        row.title,
        ...row.authors,
        row.year === null ? "" : String(row.year),
        text(row.identity.doi),
        text(row.identity.arxiv),
        text(row.identity.openalex)
      );
    else if (row.status === "incompatible") fields.push(row.title ?? "");
    return fields.some((f) => f.toLowerCase().includes(q));
  };
  const matched = rows.filter(matches);
  const offset = op.offset ?? 0;
  const limit = op.limit ?? 50;
  const page = matched.slice(offset, offset + limit).map((row) =>
    row.status === "ok"
      ? {
          status: row.status,
          entryId: row.entryId,
          rev: row.rev,
          title: row.title,
          authors: row.authors.slice(0, 20),
          ...(row.authors.length > 20 ? { authorsTotal: row.authors.length } : {}),
          year: row.year,
          identity: row.identity,
          addedAt: row.addedAt,
          source: row.source,
          docs: row.docs,
          annotations: row.annotations,
          argumentGraph: row.argumentGraph,
          argumentCount: row.argumentCount,
          note: row.note,
          bytes: row.bytes,
        }
      : row
  );
  return done(record(toolCallId, "list", { status: "ok" }), {
    ok: true,
    total: rows.length,
    matched: matched.length,
    offset,
    entries: page,
  });
}

/** add: the Add dialog's submit, after the user's card. */
async function add(
  context: ShelfToolContext,
  toolCallId: string,
  operation: ReturnType<typeof ShelfAddOperationSchema.parse>,
  op: Op
): Promise<ToolResult> {
  const action = "add";
  const named = { object: workObject(operation.workId) };
  const fail = (status: CopilotOperation["status"], detail: string, extra: object = {}) =>
    done(record(toolCallId, action, { status, ...named }), {
      ok: false,
      status,
      detail,
      ...extra,
    });
  const work = context.shelf.work(operation.workId);
  if (work === "error")
    return fail("error", "the library could not be read; nothing was written to the Shelf");
  if (!work) return fail("not_found", "there is no such work in this project; nothing was written");
  const label = work.title;
  const docIds = [...new Set(operation.docIds ?? work.docIds)];
  const annotations = operation.annotations ?? {};
  for (const docId of Object.keys(annotations))
    if (!docIds.includes(docId))
      return fail(
        "invalid",
        `annotations name Doc ${docId}, which is not among the Docs to carry; nothing was written`
      );
  // The request the card shows and an approval sends: made here, once, from the model's choices.
  const request: ShelfAddPreviewRequest = {
    workId: work.id,
    docs: docIds.map((docId) => ({
      docId,
      annotationIds: [...new Set(Object.hasOwn(annotations, docId) ? annotations[docId] : [])],
    })),
    argumentGraph: operation.argumentGraph ?? false,
    note: operation.note ?? false,
  };
  const first = await context.shelf.writer.preview(request);
  if (first.status !== 200)
    return refused(
      toolCallId,
      action,
      first,
      { ...named, label },
      {
        detail: `${text(first.body.detail)}; no confirmation was asked and nothing was written`,
      }
    );
  const preview = first.body as unknown as ShelfAddPreviewResponse;
  const objectDigest = shelfAddDigest(request, preview);
  const unavailable = confirmUnavailable(context, {
    tool: SHELF_TOOL_NAME,
    toolCallId,
    action,
    nothing: "written to the Shelf",
    ...named,
    label,
  });
  if (unavailable) return unavailable;
  // The wait for the user is not tracked: Stop must still be able to end the card.
  const answer = await askUser(context, {
    tool: SHELF_TOOL_NAME,
    toolCallId,
    action,
    ...named,
    label,
    request: {
      toolCallId,
      action: "shelf_add",
      workId: work.id,
      label,
      request,
      carried: preview.carried,
      notCarried: preview.notCarried,
      wouldArchive: preview.wouldArchive,
      impact: preview.impact,
      baseRev: 0,
      objectDigest,
    },
    nothing: "written to the Shelf",
    changed: "the work, its Docs or annotations, or the Shelf's entries of this paper",
  });
  if (!answer.approved) return answer.result;
  // Approved. The same check the click made, now that the add is about to run.
  const again = await context.shelf.writer.preview(request);
  if (again.status !== 200) {
    const status = refusalStatus({ status: again.status, code: again.body.code });
    return refused(
      toolCallId,
      action,
      again,
      { ...named, label },
      {
        status: status === "rejected" || status === "not_found" ? "expired" : status,
        detail: `${text(again.body.detail)}; checked again after the user confirmed, nothing was written`,
      }
    );
  }
  if (shelfAddDigest(request, again.body as unknown as ShelfAddPreviewResponse) !== objectDigest)
    return fail(
      "expired",
      "the work, its Docs or annotations, or the Shelf's entries of this paper changed after the user confirmed; nothing was written. Read again and ask only if it is still wanted"
    );
  if (!context.admitting())
    return fail("expired", "the run was stopped before the add; nothing was written");
  if (!op.begin({ workId: work.id, summary: `shelf add ${work.id}` }))
    return op.notSaved("written to the Shelf");
  // Exactly the request on the card, with the replacement it showed as the confirmation (none for a new entry), and
  // bound to the preview the card showed: the add writes the Shelf only when what it read is that (in-process only).
  const outcome: ShelfAnswer = await op.track(
    context.shelf.writer.add(preview.impact ? { ...request, confirm: preview.impact } : request, {
      expect: preview,
    })
  );
  if (outcome.status === 200) {
    const body = outcome.body as unknown as ShelfAddResponse;
    return op.finish(
      done(record(toolCallId, action, { status: "ok", ...named, label }), {
        ok: true,
        status: "ok",
        ...body,
      })
    );
  }
  const code = outcome.body.code;
  if (
    code === "confirmation_required" ||
    code === "confirmation_changed" ||
    code === "carried_changed"
  ) {
    // The server's own words first (they also say what an access on the way archived), then what to do.
    const next =
      code === "confirmation_required"
        ? "The Shelf got an entry of the same paper after the user confirmed, so this add would now replace it. Ask again only if it is still wanted (the new card shows the replacement)"
        : code === "carried_changed"
          ? "The work's Docs or annotations changed after the user confirmed. Ask again only if it is still wanted (the new card shows what goes in now)"
          : "List the Shelf again and ask only if it is still wanted";
    return op.finish(
      refused(
        toolCallId,
        action,
        outcome,
        { ...named, label },
        { status: "expired", detail: `${text(outcome.body.detail)}. ${next}` }
      )
    );
  }
  return op.finish(refused(toolCallId, action, outcome, { ...named, label }));
}

/** delete: the Shelf dialog's delete of one entry, after the user's card. */
async function remove(
  context: ShelfToolContext,
  toolCallId: string,
  operation: ReturnType<typeof ShelfDeleteOperationSchema.parse>,
  op: Op
): Promise<ToolResult> {
  const action = "delete";
  const named = { object: entryObject(operation.entryId) };
  const fail = (status: CopilotOperation["status"], detail: string, label?: string) =>
    done(record(toolCallId, action, { status, ...named, ...(label ? { label } : {}) }), {
      ok: false,
      status,
      detail,
    });
  const find = async () =>
    (await context.shelf.list()).find((row) => row.entryId === operation.entryId);
  let row: ShelfListRow | undefined;
  try {
    row = await find();
  } catch {
    return fail("error", "the Shelf could not be read; nothing was deleted");
  }
  if (!row) return fail("not_found", "there is no such Shelf entry; nothing was deleted");
  if (row.rev !== operation.rev)
    return fail(
      "conflict",
      `the entry was replaced since (it is at rev ${row.rev} now); nothing was deleted. List the Shelf again`
    );
  if (row.status === "unreadable")
    return fail(
      "error",
      `the entry could not be looked at (${row.code}, a system error); nothing was deleted`
    );
  const shown = row;
  const label =
    shown.status === "ok"
      ? shown.title
      : shown.status === "incompatible"
        ? (shown.title ?? "")
        : "";
  const objectDigest = shelfDeleteDigest(shown);
  const unavailable = confirmUnavailable(context, {
    tool: SHELF_TOOL_NAME,
    toolCallId,
    action,
    nothing: "deleted",
    ...named,
    label,
  });
  if (unavailable) return unavailable;
  const answer = await askUser(context, {
    tool: SHELF_TOOL_NAME,
    toolCallId,
    action,
    ...named,
    label,
    request: {
      toolCallId,
      action: "shelf_delete",
      entryId: shown.entryId,
      label,
      status: shown.status,
      entry: shown.status === "ok" ? deletedEntryOf(shown) : null,
      baseRev: shown.rev,
      objectDigest,
    },
    nothing: "deleted",
    changed: "the Shelf entry",
  });
  if (!answer.approved) return answer.result;
  let now: ShelfListRow | undefined;
  try {
    now = await find();
  } catch {
    return fail("error", "the Shelf could not be checked again; nothing was deleted", label);
  }
  // The entry could not be looked at: a system error, never a change by anyone.
  if (now?.status === "unreadable")
    return fail(
      "error",
      `the Shelf entry could not be looked at when checked after the user confirmed (${now.code}, a system error); this is not a change, and nothing was deleted. Tell the user; do not retry blindly`,
      label
    );
  if (!now || shelfDeleteDigest(now) !== objectDigest)
    return fail(
      "expired",
      "the Shelf entry changed or went away after the user confirmed; nothing was deleted. List the Shelf again",
      label
    );
  if (!context.admitting())
    return fail("expired", "the run was stopped before the delete; nothing was deleted", label);
  if (!op.begin({ summary: `shelf delete ${shown.entryId}@${shown.rev}` }))
    return op.notSaved("deleted");
  const outcome = await op.track(context.shelf.writer.remove(shown.entryId, String(shown.rev)));
  if (outcome.status === 200)
    return op.finish(
      done(record(toolCallId, action, { status: "ok", ...named, label, rev: shown.rev }), {
        ok: true,
        status: "ok",
        ...outcome.body,
      })
    );
  const code = outcome.body.code;
  if (code === "rev_mismatch")
    return op.finish(
      refused(
        toolCallId,
        action,
        outcome,
        { ...named, label },
        {
          status: "expired",
          detail:
            "the entry was replaced after the user confirmed; nothing was deleted. List the Shelf again and ask only if it is still wanted",
        }
      )
    );
  if (code === "not_found")
    return op.finish(
      refused(
        toolCallId,
        action,
        outcome,
        { ...named, label },
        {
          detail: "the entry was already gone (deleted elsewhere); this delete removed nothing",
        }
      )
    );
  return op.finish(refused(toolCallId, action, outcome, { ...named, label }));
}

/** take: the take dialog's submit, after the user's card. */
async function take(
  context: ShelfToolContext,
  toolCallId: string,
  operation: ReturnType<typeof ShelfTakeOperationSchema.parse>,
  op: Op
): Promise<ToolResult> {
  const action = "take";
  const named = { object: entryObject(operation.entryId) };
  const fail = (status: CopilotOperation["status"], detail: string, label?: string) =>
    done(record(toolCallId, action, { status, ...named, ...(label ? { label } : {}) }), {
      ok: false,
      status,
      detail,
    });
  // The request the card shows and an approval sends (with the previewed digest): made here, once.
  const request: Omit<ShelfTakeRequest, "planDigest"> = {
    rev: operation.rev,
    ...(operation.excludeAnnotations ? { excludeAnnotations: operation.excludeAnnotations } : {}),
    argumentGraph: operation.argumentGraph ?? true,
    note: operation.note ?? true,
  };
  const first = await context.shelf.take.preview(operation.entryId, request);
  if (!first.ok)
    return refused(toolCallId, action, first, named, {
      detail: `${first.body.detail}; no confirmation was asked and nothing was written`,
    });
  const shown: ShelfTakePreview = first.preview;
  const label = shown.plan.work.title;
  const unavailable = confirmUnavailable(context, {
    tool: SHELF_TOOL_NAME,
    toolCallId,
    action,
    nothing: "taken into the project",
    ...named,
    label,
  });
  if (unavailable) return unavailable;
  const answer = await askUser(context, {
    tool: SHELF_TOOL_NAME,
    toolCallId,
    action,
    ...named,
    label,
    request: {
      toolCallId,
      action: "shelf_take",
      entryId: operation.entryId,
      label,
      request,
      plan: shown.plan,
      planDigest: shown.planDigest,
      baseRev: operation.rev,
      objectDigest: shown.planDigest,
    },
    nothing: "taken into the project",
    changed: "the Shelf entry or the project",
  });
  if (!answer.approved) return answer.result;
  const again = await context.shelf.take.preview(operation.entryId, request);
  const againStatus = again.ok
    ? "expired"
    : refusalStatus({ status: again.status, code: again.body.code });
  if (!again.ok || again.preview.planDigest !== shown.planDigest)
    return fail(
      againStatus === "rejected" || againStatus === "not_found" ? "expired" : againStatus,
      again.ok
        ? "the Shelf entry or the project changed after the user confirmed, so the take would now do something else; nothing was written. Ask again only if it is still wanted (a new card shows the new plan)"
        : `${again.body.detail}; checked again after the user confirmed, nothing was written`,
      label
    );
  if (!context.admitting())
    return fail("expired", "the run was stopped before the take; nothing was written", label);
  if (!op.begin({ summary: `shelf take ${operation.entryId}@${operation.rev}` }))
    return op.notSaved("taken into the project");
  // Exactly the request on the card, bound to the plan it showed.
  const outcome = await op.track(
    context.shelf.take.take(operation.entryId, { ...request, planDigest: shown.planDigest })
  );
  if (outcome.ok) {
    const result: ShelfTakeResult = outcome.result;
    return op.finish(
      done(
        record(toolCallId, action, {
          status: "ok",
          ...named,
          label: result.work.title,
        }),
        { ok: true, status: "ok", result }
      )
    );
  }
  const code = outcome.body.code;
  if (code === "plan_changed" || code === "changed")
    return op.finish(
      refused(
        toolCallId,
        action,
        outcome,
        { ...named, label },
        {
          status: "expired",
          detail:
            code === "changed"
              ? "the Shelf entry was replaced after the user confirmed; nothing was written. List the Shelf again and ask only if it is still wanted"
              : "the project or the entry changed after the user confirmed, so the take would now do something else; nothing was written. Ask again only if it is still wanted (a new card shows the new plan)",
          // The new plan is the server's; the model asks again for a card rather than acting on it.
          plan: undefined,
          planDigest: undefined,
        }
      )
    );
  return op.finish(refused(toolCallId, action, outcome, { ...named, label }));
}

export function createShelfTool(context: ShelfToolContext) {
  return defineTool({
    name: SHELF_TOOL_NAME,
    label: "Shelf",
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
      const { operationId: requestedId, ...rest } = params as Record<string, unknown>;
      try {
        const listed = ShelfListOperationSchema.safeParse(rest);
        if (listed.success) return await list(context, toolCallId, listed.data);
        const added = ShelfAddOperationSchema.safeParse(rest);
        const deleted = ShelfDeleteOperationSchema.safeParse(rest);
        const taken = ShelfTakeOperationSchema.safeParse(rest);
        if (!added.success && !deleted.success && !taken.success) {
          const failure =
            rest.action === "add"
              ? added
              : rest.action === "delete"
                ? deleted
                : rest.action === "take"
                  ? taken
                  : listed;
          return done(record(toolCallId, action, { status: "unsupported" }), {
            ok: false,
            status: "unsupported",
            detail: "unknown action or invalid parameters; nothing was asked or written",
            issues: (failure.success ? [] : failure.error.issues)
              .slice(0, 5)
              .map((issue) => ({ path: issue.path.join("."), message: issue.message })),
          });
        }
        const named = added.success
          ? { object: workObject(added.data.workId) }
          : { object: entryObject((deleted.success ? deleted.data : taken.data)?.entryId ?? "") };
        return await runOperation(
          context,
          {
            tool: SHELF_TOOL_NAME,
            toolCallId,
            action,
            rest,
            requestedId,
            readBack: added.success
              ? "list the Shelf to see whether the entry is there"
              : deleted.success
                ? "list the Shelf to see whether the entry is still there"
                : "read the library to see whether the work and its Docs are there",
            named,
          },
          (op) =>
            added.success
              ? add(context, toolCallId, added.data, op)
              : deleted.success
                ? remove(context, toolCallId, deleted.data, op)
                : take(context, toolCallId, taken.data as NonNullable<typeof taken.data>, op)
        );
      } catch {
        // Never claim "nothing changed" after an unexpected failure: the model must read to find out.
        return done(record(toolCallId, action, { status: "unknown" }), {
          ok: false,
          status: "unknown",
          detail:
            "unexpected failure; the outcome is not known, list the Shelf (and read the library) before retrying",
        });
      }
    },
  });
}
