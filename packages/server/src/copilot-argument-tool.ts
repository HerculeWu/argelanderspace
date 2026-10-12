/**
 * The Copilot's `argument` tool (argument graph ticket 09, ADR 0005): the argument graph page's operations for the
 * model, on any Work, with or without the view open.
 *
 * One write path. A tool edit is the page's edit: the same pure operations (`argument-edit.ts`: each result is checked
 * against `ArgumentGraphSchema`, so "refused here" and "rejected by the server" are one rule set) applied to the stored
 * graph, then written by `writeArgumentGraph`, the function `PUT /api/works/:workId/argument-graph` uses, on the same
 * lock with the same rev check and the same in-lock "the Work is still in the library" check. The tool never writes a
 * file itself and never overwrites with a copy older than the stored rev: `expectedRev` is compared with the stored graph
 * first, and the write checks the rev again inside the lock.
 *
 * Replacing or clearing a graph that has arguments is the one write that waits for the user (a confirmation card, kind
 * `replace_argument_graph`): the page asks the same before it clears. The model cannot approve it.
 */
import {
  ARGUMENT_READ_MAX_CHARS,
  ARGUMENT_READ_MAX_EDGES,
  ARGUMENT_TOOL_ACTIONS,
  type ArgumentDraft,
  type ArgumentEditIssue,
  type ArgumentEditRejection,
  type ArgumentEditResult,
  type ArgumentGraph,
  ArgumentGraphSchema,
  type ArgumentGraphSize,
  type ArgumentToolRead,
  ArgumentToolReadSchema,
  type ArgumentToolWrite,
  ArgumentToolWriteSchema,
  type ArgumentViewAction,
  addEdge,
  auditArgumentGraph,
  type CopilotOperation,
  checkArgumentGraphForWrite,
  clearArgumentGraph,
  createArgument,
  deleteArgument,
  type RemovedArgument,
  removeEdge,
  restoreArgument,
  updateArgument,
} from "@argelanderspace/contracts";
import { ArgumentGraphFileError, loadArgumentGraph } from "@argelanderspace/core";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { writeArgumentGraph } from "./argument-graph-actions.js";
import { ARGUMENT_GUIDE } from "./copilot-argument-guide.js";
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
import { type ViewActionOutcome, viewOutcomeResult } from "./copilot-workspace-tool.js";
import type { AsyncLock } from "./lock.js";

export const ARGUMENT_TOOL_NAME = "argument";

/** A Work as the library lists it, for the tool's purposes. */
export interface ArgumentWork {
  id: string;
  title: string;
  /** The Work's Docs; the first is the main Doc. */
  docIds: string[];
}

/** Arguments deleted through the tool, so `undo_delete` can put one back (in memory; a restart forgets them). */
export class ArgumentUndoRegistry {
  private readonly entries = new Map<string, { removed: RemovedArgument; rev: number }>();
  private static key(workId: string, id: string) {
    return `${workId}\u0000${id}`;
  }
  remember(workId: string, removed: RemovedArgument, rev: number): void {
    const key = ArgumentUndoRegistry.key(workId, removed.argument.id);
    this.entries.delete(key);
    this.entries.set(key, { removed, rev });
    // Bounded: only the latest few deletions can be taken back.
    while (this.entries.size > 50) this.entries.delete(this.entries.keys().next().value as string);
  }
  take(workId: string, id: string) {
    return this.entries.get(ArgumentUndoRegistry.key(workId, id));
  }
  forget(workId: string, id: string): void {
    this.entries.delete(ArgumentUndoRegistry.key(workId, id));
  }
}

/** The seam the app gives the host: the graph store, its lock and the library lookup the page's route uses. */
export interface ArgumentOpDeps {
  dataDir: string;
  lock: AsyncLock;
  /** After a successful write: broadcasts `argument-graph.changed{put}` (and rechecks a pending card). */
  onChanged: (workId: string) => void;
  /** The Work in the library; null: not there; "error": the library could not be read. */
  work: (workId: string) => ArgumentWork | null | "error";
  undo: ArgumentUndoRegistry;
}

export interface ArgumentToolContext extends ToolHostContext {
  argument: ArgumentOpDeps;
  /** Resolves only after the bound browser view reports the outcome. */
  viewAction: (action: ArgumentViewAction) => Promise<ViewActionOutcome>;
  /** Bytes one more tool result may take (what the model's window has left); absent: the fixed cap alone. */
  budget?: () => number;
}

// ---- Reading --------------------------------------------------------------------------------------------------- //

type Loaded =
  | { kind: "ok"; work: ArgumentWork; graph: ArgumentGraph }
  | { kind: "no_work" }
  | { kind: "library_error" }
  | { kind: "unreadable"; problem: string };

/** The Work and its stored graph (the page's GET); a graph file that cannot be read is a system error, never empty. */
export function loadForTool(deps: ArgumentOpDeps, workId: string): Loaded {
  const work = deps.work(workId);
  if (work === "error") return { kind: "library_error" };
  if (!work) return { kind: "no_work" };
  try {
    return { kind: "ok", work, graph: loadArgumentGraph(deps.dataDir, workId) };
  } catch (error) {
    return {
      kind: "unreadable",
      problem: error instanceof ArgumentGraphFileError ? error.kind : "unreadable",
    };
  }
}

const sizeOf = (graph: ArgumentGraph): ArgumentGraphSize => ({
  arguments: graph.arguments.length,
  edges: graph.edges.length,
});

/** What a confirmation binds: the stored graph as it is now. */
export function describeArgumentTarget(
  deps: ArgumentOpDeps,
  workId: string
): { rev: number; label: string; size: ArgumentGraphSize; objectDigest: string } | null {
  const loaded = loadForTool(deps, workId);
  if (loaded.kind === "no_work") return null;
  if (loaded.kind === "library_error") throw new Error("the library could not be read");
  if (loaded.kind === "unreadable") throw new Error("the argument graph file could not be read");
  const { graph, work } = loaded;
  return {
    rev: graph.rev,
    label: work.title,
    size: sizeOf(graph),
    objectDigest: digest({ rev: graph.rev, arguments: graph.arguments, edges: graph.edges }),
  };
}

/** The audit findings as ids and titles' ids (capped); the whole list is what `auditArgumentGraph` computes. */
function auditSummary(graph: ArgumentGraph) {
  const audit = auditArgumentGraph(graph);
  const cap = <T>(items: T[]) => items.slice(0, 50);
  const total =
    audit.cycles.length +
    audit.noPathToEnd.length +
    (audit.noEnd ? 1 : 0) +
    audit.endWithOutEdge.length +
    audit.nativeWithInEdge.length +
    audit.incomplete.length;
  return {
    total,
    cycles: cap(audit.cycles.map((cycle) => cycle.arguments)),
    noPathToEnd: cap(audit.noPathToEnd),
    noEnd: audit.noEnd,
    endWithOutEdge: cap(audit.endWithOutEdge),
    nativeWithInEdge: cap(audit.nativeWithInEdge),
    incomplete: cap(audit.incomplete),
  };
}

const jsonLength = (value: unknown): number => JSON.stringify(value).length;

/**
 * The read payload: header (rev, counts, audit), then whole arguments from `offset` (or the named ones) up to the
 * character cap, then edges from `edgeOffset` up to the edge cap. `batch` and `edgesBatch` say what is delivered
 * ([from, to) zero-based over `total`); status `partial` means the rest is NOT read, so the model continues from `to`.
 */
export function readPayload(
  work: ArgumentWork,
  graph: ArgumentGraph,
  options: { offset?: number; edgeOffset?: number; ids?: string[]; room?: number } = {}
) {
  const cap = Math.max(
    2_000,
    Math.min(ARGUMENT_READ_MAX_CHARS, Math.floor((options.room ?? Number.POSITIVE_INFINITY) / 2))
  );
  const header = {
    rev: graph.rev,
    work: {
      id: work.id,
      title: work.title,
      docs: work.docIds.map((id, index) => ({ id, main: index === 0 })),
    },
    counts: sizeOf(graph),
    audit: auditSummary(graph),
  };
  const pool = options.ids
    ? options.ids.flatMap((id) => {
        const found = graph.arguments.find((a) => a.id === id);
        return found ? [found] : [];
      })
    : graph.arguments;
  const missing = options.ids
    ? options.ids.filter((id) => !graph.arguments.some((a) => a.id === id))
    : [];
  const from = options.ids ? 0 : Math.min(options.offset ?? 0, pool.length);
  const taken: typeof pool = [];
  let used = 0;
  let gap: { id: string; chars: number } | undefined;
  for (let i = from; i < pool.length; i++) {
    const item = pool[i] as (typeof pool)[number];
    const size = jsonLength(item) + 1;
    if (used + size > cap) {
      if (taken.length === 0) gap = { id: item.id, chars: size };
      break;
    }
    taken.push(item);
    used += size;
  }
  const to = from + taken.length;
  const argumentsBatch = {
    from,
    to,
    total: pool.length,
    status: gap
      ? ("omitted" as const)
      : to >= pool.length
        ? ("complete" as const)
        : ("partial" as const),
    ...(gap ? { gap } : {}),
  };
  const edgeFrom = Math.min(options.edgeOffset ?? 0, graph.edges.length);
  const edges = options.ids
    ? graph.edges.filter((e) => options.ids?.includes(e.from) || options.ids?.includes(e.to))
    : graph.edges.slice(edgeFrom, edgeFrom + ARGUMENT_READ_MAX_EDGES);
  const edgesTo = options.ids ? edges.length : edgeFrom + edges.length;
  return {
    ...header,
    arguments: taken,
    batch: argumentsBatch,
    edges,
    edgesBatch: {
      from: options.ids ? 0 : edgeFrom,
      to: edgesTo,
      total: options.ids ? edges.length : graph.edges.length,
      status:
        options.ids || edgesTo >= graph.edges.length ? ("complete" as const) : ("partial" as const),
    },
    ...(missing.length ? { notFound: missing } : {}),
    note:
      argumentsBatch.status === "partial" ||
      argumentsBatch.status === "omitted" ||
      (!options.ids && edgesTo < graph.edges.length)
        ? "Part of the graph is NOT read yet: call read again with offset = batch.to and/or edgeOffset = edgesBatch.to until both say complete before you rely on the whole graph, and note what you need from earlier parts first."
        : options.ids
          ? "These arguments in full, and every edge that touches them."
          : "The whole graph.",
  };
}

// ---- Writing --------------------------------------------------------------------------------------------------- //

/** A readable sentence for a refused edit (the model reads it; the page words its own). */
function reject(rejection: ArgumentEditRejection): {
  status: "not_found" | "rejected" | "invalid";
  detail: string;
  issues?: ArgumentEditIssue[];
} {
  switch (rejection.code) {
    case "not_found":
      return { status: "not_found", detail: `no argument has the id "${rejection.id}"` };
    case "self_loop":
      return {
        status: "rejected",
        detail: `an argument cannot rest on itself ("${rejection.id}")`,
      };
    case "duplicate_edge":
      return {
        status: "rejected",
        detail: `"${rejection.from}" already plays ${rejection.role} in "${rejection.to}"`,
      };
    case "edge_not_found":
      return {
        status: "rejected",
        detail: `there is no ${rejection.role} edge from "${rejection.from}" to "${rejection.to}"`,
      };
    case "invalid":
      return {
        status: "invalid",
        detail: "the result would not be a valid argument graph; nothing was written",
        issues: rejection.issues,
      };
  }
}

type Committed<T extends object> =
  | { kind: "ok"; graph: ArgumentGraph; extra: T; work: ArgumentWork }
  | { kind: "no_work" }
  | { kind: "library_error" }
  | { kind: "unreadable"; problem: string }
  | { kind: "conflict"; latest: ArgumentGraph | null; work: ArgumentWork }
  | { kind: "rejected"; rejection: ArgumentEditRejection };

/**
 * Applies one pure edit to the stored graph and writes it with the same function the page's PUT uses. `begin` runs
 * after every refusal that needs no write and before the write itself.
 */
async function commitEdit<T extends object>(
  deps: ArgumentOpDeps,
  workId: string,
  expectedRev: number,
  edit: (graph: ArgumentGraph) => ArgumentEditResult<T>,
  begin: () => boolean
): Promise<Committed<T> | { kind: "not_saved" } | { kind: "unknown" }> {
  const loaded = loadForTool(deps, workId);
  if (loaded.kind !== "ok") return loaded;
  const { graph: current, work } = loaded;
  if (current.rev !== expectedRev) return { kind: "conflict", latest: current, work };
  const result = edit(current);
  if (!result.ok) return { kind: "rejected", rejection: result.rejection };
  const { ok: _ok, graph: next, ...extra } = result;
  return await write(deps, workId, work, current.rev, next, extra as unknown as T, begin);
}

async function write<T extends object>(
  deps: ArgumentOpDeps,
  workId: string,
  work: ArgumentWork,
  rev: number,
  next: ArgumentGraph,
  extra: T,
  begin: () => boolean
): Promise<Committed<T> | { kind: "not_saved" } | { kind: "unknown" }> {
  if (!begin()) return { kind: "not_saved" };
  try {
    const outcome = await writeArgumentGraph(
      deps.dataDir,
      deps.lock,
      { ...next, rev, work_id: workId },
      () => deps.onChanged(workId),
      () => {
        const known = deps.work(workId);
        return known === "error" ? "error" : known !== null;
      }
    );
    if ("gone" in outcome) return { kind: "no_work" };
    if ("libraryUnreadable" in outcome) return { kind: "library_error" };
    if ("conflictRev" in outcome) {
      const latest = loadForTool(deps, workId);
      return { kind: "conflict", latest: latest.kind === "ok" ? latest.graph : null, work };
    }
    return { kind: "ok", graph: outcome.saved, extra, work };
  } catch {
    return { kind: "unknown" };
  }
}

// ---- The tool -------------------------------------------------------------------------------------------------- //

const lit = <T extends string>(values: readonly T[]) =>
  Type.Unsafe<T>({ type: "string", enum: [...values] });
const opt = <T extends ReturnType<typeof Type.String>>(schema: T) => Type.Optional(schema);
const loose = () => Type.Optional(Type.Object({}, { additionalProperties: true }));

const parameters = Type.Object(
  {
    action: lit(ARGUMENT_TOOL_ACTIONS),
    operationId: opt(Type.String({ minLength: 1, maxLength: 64 })),
    workId: opt(Type.String()),
    expectedRev: Type.Optional(Type.Integer({ minimum: 0 })),
    id: opt(Type.String()),
    argument: loose(),
    patch: loose(),
    graph: loose(),
    from: opt(Type.String()),
    to: opt(Type.String()),
    role: Type.Optional(lit(["grounds", "warrant", "backing", "rebuttal"] as const)),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    edgeOffset: Type.Optional(Type.Integer({ minimum: 0 })),
    ids: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false }
);

const description = [
  "Argument graph (论证图) of one Work, edited like the argument page; every call names workId and the page need not be open.",
  "read: rev, counts, audit, arguments, edges; a big graph comes in parts (batch / edgesBatch partial = the rest is NOT read: continue with offset / edgeOffset); ids: only those arguments, in full.",
  "guide: the method for organizing a paper's graph; call it first for that, then read the body with the reader tool.",
  "Writes need expectedRev; on conflict the result carries the latest graph: form a new edit from it, never resend the stale one.",
  "create {argument}, update {id, patch}, delete {id}, undo_delete {id, expectedRev = the rev delete returned}, add_edge / remove_edge {from, to, role}, replace {graph: {arguments, edges}}, clear.",
  "Argument fields: title (required), claim, grounds, warrant, backing, qualifier, rebuttal, warrant_implicit, kind native|end|normal, sources [{text, target?: {doc_id, anchor | page}}]; an edge's from-Claim plays role (grounds|warrant|backing|rebuttal) in to.",
  "replace and clear of a graph that has arguments only REQUEST the change: the user confirms on a card, you cannot approve it; declined and expired mean nothing was written.",
  "open / select {id} / exit change what the user sees. Only ok and noop are done; unknown: read to find out.",
].join(" ");

const record = (id: string, action: string, partial: Partial<CopilotOperation>) =>
  recordFor(ARGUMENT_TOOL_NAME, id, action, partial);

export function createArgumentTool(context: ArgumentToolContext) {
  return defineTool({
    name: ARGUMENT_TOOL_NAME,
    label: "Argument graph",
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
        if (action === "guide")
          return done(record(toolCallId, "guide", { status: "ok" }), {
            ok: true,
            status: "ok",
            guide: ARGUMENT_GUIDE,
          });
        if (action === "read") return await read(context, toolCallId, rest);
        if (action === "open" || action === "select" || action === "exit")
          return await navigate(context, toolCallId, action, rest);
        const parsed = ArgumentToolWriteSchema.safeParse(rest);
        if (!parsed.success)
          return done(record(toolCallId, action, { status: "unsupported" }), {
            ok: false,
            status: "unsupported",
            detail: "unknown action or invalid parameters",
            issues: parsed.error.issues
              .slice(0, 5)
              .map((issue) => ({ path: issue.path.join("."), message: issue.message })),
          });
        const write = parsed.data;
        return await runOperation(
          context,
          {
            tool: ARGUMENT_TOOL_NAME,
            toolCallId,
            action,
            rest,
            requestedId,
            readBack: "read the argument graph to find out",
            named: { object: { kind: "work", id: write.workId } },
          },
          (op) =>
            write.action === "replace" || write.action === "clear"
              ? replaceOrClear(context, toolCallId, write, op)
              : edit(context, toolCallId, write, op)
        );
      } catch {
        // Never claim "nothing changed" after an unexpected failure: the model must read to find out.
        return done(record(toolCallId, action, { status: "unknown" }), {
          ok: false,
          status: "unknown",
          detail:
            "unexpected failure; the outcome is not known, read the argument graph again before retrying",
        });
      }
    },
  });
}

const work = (id: string) => ({ kind: "work" as const, id });

/** The result for a state in which nothing could be done, shared by every operation. */
function unavailable(
  toolCallId: string,
  action: string,
  workId: string,
  state: { kind: "no_work" } | { kind: "library_error" } | { kind: "unreadable"; problem: string }
): ToolResult {
  if (state.kind === "no_work")
    return done(record(toolCallId, action, { status: "not_found", object: work(workId) }), {
      ok: false,
      status: "not_found",
      detail: "no such Work in the library; nothing was changed",
    });
  return done(record(toolCallId, action, { status: "error", object: work(workId) }), {
    ok: false,
    status: "error",
    detail:
      state.kind === "library_error"
        ? "the library could not be read; nothing was changed"
        : `the Work's argument graph file is unreadable (${state.problem}); it is not an empty graph and nothing was changed. Tell the user; do not try to work around it`,
  });
}

async function read(
  context: ArgumentToolContext,
  toolCallId: string,
  rest: Record<string, unknown>
) {
  const parsed = ArgumentToolReadSchema.safeParse(rest);
  if (!parsed.success)
    return done(record(toolCallId, "read", { status: "unsupported" }), {
      ok: false,
      status: "unsupported",
      detail: "read needs workId (and optionally offset, edgeOffset or ids)",
    });
  const request: ArgumentToolRead = parsed.data;
  const loaded = loadForTool(context.argument, request.workId);
  if (loaded.kind !== "ok") return unavailable(toolCallId, "read", request.workId, loaded);
  const room = context.budget?.();
  const payload = readPayload(loaded.work, loaded.graph, {
    ...(request.offset !== undefined ? { offset: request.offset } : {}),
    ...(request.edgeOffset !== undefined ? { edgeOffset: request.edgeOffset } : {}),
    ...(request.ids ? { ids: request.ids } : {}),
    ...(room !== undefined ? { room } : {}),
  });
  return done(
    record(toolCallId, "read", {
      status: "ok",
      rev: loaded.graph.rev,
      object: work(request.workId),
      label: loaded.work.title,
    }),
    { ok: true, status: "ok", ...payload }
  );
}

async function navigate(
  context: ArgumentToolContext,
  toolCallId: string,
  action: "open" | "select" | "exit",
  rest: Record<string, unknown>
) {
  const workId = typeof rest.workId === "string" ? rest.workId : "";
  if (action !== "exit" && !workId)
    return done(record(toolCallId, action, { status: "unsupported" }), {
      ok: false,
      status: "unsupported",
      detail: `${action} needs workId`,
    });
  let view: ArgumentViewAction;
  if (action === "exit") view = { action: "exit_argument_graph" };
  else if (action === "open") view = { action: "open_argument_graph", workId };
  else
    view = {
      action: "select_argument",
      workId,
      argumentId: typeof rest.id === "string" && rest.id ? rest.id : null,
    };
  if (action !== "exit") {
    const loaded = loadForTool(context.argument, workId);
    if (loaded.kind === "no_work" || loaded.kind === "library_error")
      return unavailable(toolCallId, action, workId, loaded);
    // Opening shows the page's own error state for an unreadable file; selecting needs the graph.
    if (action === "select") {
      if (loaded.kind === "unreadable") return unavailable(toolCallId, action, workId, loaded);
      if (
        view.action === "select_argument" &&
        view.argumentId !== null &&
        !loaded.graph.arguments.some((a) => a.id === view.argumentId)
      )
        return done(record(toolCallId, action, { status: "not_found", object: work(workId) }), {
          ok: false,
          status: "not_found",
          detail: `no argument has the id "${view.argumentId}"`,
        });
    }
  }
  const shown = viewOutcomeResult(await context.viewAction(view), view.action);
  return done(
    record(toolCallId, action, {
      status: shown.status,
      ...(workId ? { object: work(workId) } : {}),
    }),
    shown.payload
  );
}

/** The result of a conflict: the stored graph as it is now, so the model decides again from it. */
function conflict(
  toolCallId: string,
  action: string,
  workId: string,
  latest: ArgumentGraph | null,
  info: ArgumentWork,
  room: number | undefined
) {
  return done(
    record(toolCallId, action, {
      status: "conflict",
      ...(latest ? { rev: latest.rev } : {}),
      object: work(workId),
    }),
    {
      ok: false,
      status: "conflict",
      ...(latest ? { currentRev: latest.rev } : {}),
      detail:
        "the graph changed since you read it (the user may have edited it); nothing was written. Its latest state is below: look at it, form a new edit from it, never resend the stale one",
      ...(latest ? { latest: readPayload(info, latest, room !== undefined ? { room } : {}) } : {}),
    }
  );
}

/** The result of an edit the pure operation refused (nothing was written). */
function refused(
  toolCallId: string,
  action: string,
  workId: string,
  rev: number | undefined,
  rejection: ArgumentEditRejection
) {
  const why = reject(rejection);
  return done(
    record(toolCallId, action, {
      status: why.status,
      ...(rev !== undefined ? { rev } : {}),
      object: work(workId),
    }),
    {
      ok: false,
      status: why.status,
      detail: why.detail,
      ...(why.issues ? { issues: why.issues } : {}),
      ...(rev !== undefined ? { currentRev: rev } : {}),
    }
  );
}

async function edit(
  context: ArgumentToolContext,
  toolCallId: string,
  request: Exclude<ArgumentToolWrite, { action: "replace" | "clear" }>,
  op: Op
): Promise<ToolResult> {
  const { workId, expectedRev, action } = request;
  const deps = context.argument;
  let deleted: RemovedArgument | undefined;
  if (request.action === "undo_delete") {
    // Like the page's Undo: only onto the graph the delete produced. Anything else may have moved on.
    const entry = deps.undo.take(workId, request.id);
    if (!entry)
      return done(record(toolCallId, action, { status: "not_found", object: work(workId) }), {
        ok: false,
        status: "not_found",
        detail:
          "nothing of yours to undo for that argument (not deleted by you since the service started, or already put back)",
      });
    if (entry.rev !== expectedRev) {
      const latest = loadForTool(deps, workId);
      if (latest.kind !== "ok") return unavailable(toolCallId, action, workId, latest);
      return op.finish(
        conflict(toolCallId, action, workId, latest.graph, latest.work, context.budget?.())
      );
    }
  }
  const outcome = await op.track(
    commitEdit(
      deps,
      workId,
      expectedRev,
      (graph): ArgumentEditResult<object> => {
        switch (request.action) {
          case "create":
            return createArgument(graph, request.argument as ArgumentDraft, request.id);
          case "update":
            return updateArgument(graph, request.id, request.patch as Partial<ArgumentDraft>);
          case "delete": {
            const result = deleteArgument(graph, request.id);
            if (result.ok) deleted = result.removed;
            return result;
          }
          case "undo_delete": {
            const entry = deps.undo.take(workId, request.id);
            if (!entry) return { ok: false, rejection: { code: "not_found", id: request.id } };
            return restoreArgument(graph, entry.removed);
          }
          case "add_edge":
            return addEdge(graph, { from: request.from, to: request.to, role: request.role });
          case "remove_edge":
            return removeEdge(graph, { from: request.from, to: request.to, role: request.role });
        }
      },
      () => op.begin({ workId }, expectedRev)
    )
  );
  switch (outcome.kind) {
    case "not_saved":
      return op.notSaved("written");
    case "unknown":
      return done(record(toolCallId, action, { status: "unknown", object: work(workId) }), {
        ok: false,
        status: "unknown",
        detail:
          "unexpected failure; the outcome is not known, read the argument graph before retrying",
      });
    case "no_work":
    case "library_error":
    case "unreadable":
      return unavailable(toolCallId, action, workId, outcome);
    case "conflict":
      return op.finish(
        conflict(toolCallId, action, workId, outcome.latest, outcome.work, context.budget?.())
      );
    case "rejected":
      return refused(toolCallId, action, workId, undefined, outcome.rejection);
    case "ok": {
      const saved = outcome.graph;
      const extra = outcome.extra as { id?: string };
      if (deleted) deps.undo.remember(workId, deleted, saved.rev);
      if (request.action === "undo_delete") deps.undo.forget(workId, request.id);
      const payload = {
        ok: true,
        status: "ok",
        rev: saved.rev,
        counts: sizeOf(saved),
        ...(request.action === "create" ? { id: extra.id } : {}),
        ...(deleted
          ? {
              removed: {
                id: deleted.argument.id,
                title: deleted.argument.title,
                edges: deleted.edges.length,
              },
              note: "undo_delete {id, expectedRev: rev} puts it back with its edges while the graph is unchanged",
            }
          : {}),
      };
      return op.finish(
        done(
          record(toolCallId, action, {
            status: "ok",
            rev: saved.rev,
            object: work(workId),
            label: outcome.work.title,
          }),
          payload
        )
      );
    }
  }
}

/** Replace the whole graph, or clear it: a card first when the stored graph has arguments. */
async function replaceOrClear(
  context: ArgumentToolContext,
  toolCallId: string,
  request: Extract<ArgumentToolWrite, { action: "replace" | "clear" }>,
  op: Op
): Promise<ToolResult> {
  const { workId, expectedRev, action } = request;
  const deps = context.argument;
  const loaded = loadForTool(deps, workId);
  if (loaded.kind !== "ok") return unavailable(toolCallId, action, workId, loaded);
  const { graph: current, work: info } = loaded;
  if (current.rev !== expectedRev)
    return op.finish(conflict(toolCallId, action, workId, current, info, context.budget?.()));
  // The proposed graph, checked the way every write is checked, before the user is bothered with it.
  let proposed: ArgumentGraph;
  if (request.action === "clear") {
    const cleared = clearArgumentGraph(current);
    if (!cleared.ok) return refused(toolCallId, action, workId, current.rev, cleared.rejection);
    proposed = cleared.graph;
  } else {
    const built = ArgumentGraphSchema.safeParse({
      version: 1,
      rev: current.rev,
      work_id: workId,
      ...request.graph,
    });
    if (!built.success) {
      const issues = checkArgumentGraphForWrite({
        version: 1,
        rev: current.rev,
        work_id: workId,
        ...request.graph,
      });
      return refused(toolCallId, action, workId, current.rev, { code: "invalid", issues });
    }
    proposed = built.data;
  }
  if (current.arguments.length === 0 && request.action === "clear")
    return op.finish(
      done(
        record(toolCallId, action, {
          status: "noop",
          rev: current.rev,
          object: work(workId),
          label: info.title,
        }),
        {
          ok: true,
          status: "noop",
          rev: current.rev,
          counts: sizeOf(current),
          detail: "the graph is already empty",
        }
      )
    );
  let baseRev = current.rev;
  let label = info.title;
  if (current.arguments.length > 0) {
    // Whatever is there would be lost: only the real user can say yes.
    const unsupported = confirmUnavailable(context, {
      tool: ARGUMENT_TOOL_NAME,
      toolCallId,
      action,
      nothing: "written",
      object: work(workId),
      label,
    });
    if (unsupported) return unsupported;
    const described = describeArgumentTarget(deps, workId);
    if (!described) return unavailable(toolCallId, action, workId, { kind: "no_work" });
    baseRev = described.rev;
    label = described.label;
    const answer = await askUser(context, {
      tool: ARGUMENT_TOOL_NAME,
      toolCallId,
      action,
      object: work(workId),
      label,
      request: {
        toolCallId,
        action: "replace_argument_graph",
        workId,
        label,
        mode: request.action === "clear" ? "clear" : "replace",
        current: described.size,
        next: sizeOf(proposed),
        baseRev,
        objectDigest: described.objectDigest,
      },
      nothing: "written",
      changed: "the argument graph",
    });
    if (!answer.approved) return answer.result;
    // Approved. From here it is a submitted write; check once more that it is the graph the card showed.
    const again = describeArgumentTarget(deps, workId);
    if (!again || again.rev !== baseRev || again.objectDigest !== described.objectDigest)
      return done(record(toolCallId, action, { status: "expired", object: work(workId), label }), {
        ok: false,
        status: "expired",
        detail:
          "the argument graph changed before the write ran; nothing was written. Read again and ask only if it is still wanted",
      });
  }
  const outcome = await op.track(
    write(deps, workId, info, baseRev, proposed, {}, () => op.begin({ workId }, baseRev))
  );
  switch (outcome.kind) {
    case "not_saved":
      return op.notSaved("written");
    case "unknown":
      return done(record(toolCallId, action, { status: "unknown", object: work(workId), label }), {
        ok: false,
        status: "unknown",
        detail:
          "unexpected failure; the outcome is not known, read the argument graph before retrying",
      });
    case "no_work":
    case "library_error":
    case "unreadable":
      return unavailable(toolCallId, action, workId, outcome);
    case "conflict":
      return op.finish(
        current.arguments.length > 0
          ? done(record(toolCallId, action, { status: "expired", object: work(workId), label }), {
              ok: false,
              status: "expired",
              detail:
                "the argument graph changed before the write ran; nothing was written. Read again and ask only if it is still wanted",
            })
          : conflict(toolCallId, action, workId, outcome.latest, outcome.work, context.budget?.())
      );
    case "rejected":
      return refused(toolCallId, action, workId, undefined, outcome.rejection);
    case "ok":
      return op.finish(
        done(
          record(toolCallId, action, {
            status: "ok",
            rev: outcome.graph.rev,
            object: work(workId),
            label,
          }),
          {
            ok: true,
            status: "ok",
            rev: outcome.graph.rev,
            counts: sizeOf(outcome.graph),
          }
        )
      );
  }
}

/** Added to the base instruction when the tool exists: short, the tool description holds the actions. */
export const ARGUMENT_PROMPT =
  " The argument tool edits any Work's argument graph (论证图); argument guide holds the method. A partial page.argument is only an outline: argument read fetches the rest. Replacing or clearing a graph that has arguments waits for the user's card: you cannot approve it.";
