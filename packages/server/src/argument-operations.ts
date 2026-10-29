/**
 * The catalog operations of the argument graph (release-0.2 ticket 08; contracts `argument-catalog.ts`): the read, the
 * edits of one argument or one edge, and the whole-graph replace and clear. They are the Copilot `argument` tool's
 * operations without the Copilot: the same stored graph, the same pure edits (`argument-edit.ts`), the same write path
 * (`writeArgumentGraph`: one lock, the rev check inside it, the in-lock "the Work is still in the library" check) and
 * the same wording of every answer (`copilot-argument-tool.ts` exports the pieces both entrances use). What differs is
 * who is asked and what is remembered: the Copilot keeps a journal and a conversation card, this entrance has the CLI's
 * request and the workbench's external-requests queue.
 *
 * Replacing or clearing a graph that has arguments waits for the real user's card (the Copilot's
 * `replace_argument_graph` card, drawn by the workbench for an external agent). Without a running workbench there is no
 * place to show it: the answer is `workbench_required` and nothing is written. A graph without arguments is replaced at
 * once, like the Copilot and the page do.
 */
import type {
  ArgumentGraph,
  ArgumentToolRead,
  ArgumentToolWrite,
  RemovedArgument,
} from "@argelanderspace/contracts";
import {
  alreadyEmptyAnswer,
  applyEditRequest,
  commitEdit,
  conflictAnswer,
  describeArgumentTarget,
  editedAnswer,
  GRAPH_CHANGED_ANSWER,
  loadForTool,
  NOTHING_TO_UNDO,
  proposedGraph,
  readFieldPayload,
  readPayload,
  refusedAnswer,
  sizeOf,
  unavailableAnswer,
  writeArgumentProposal,
} from "./copilot-argument-tool.js";
import type { OperationCall, OperationRuntime } from "./operation-catalog.js";

const UNSUPPORTED_HERE = {
  ok: false,
  status: "unsupported",
  detail: "argument graphs are not available in this host",
} as const;

const UNKNOWN = {
  ok: false,
  status: "unknown",
  detail: "unexpected failure; the outcome is not known, read the argument graph before retrying",
} as const;

/** `argument.read`: the graph in parts, or one text of one argument (no window to fit: the fixed ceilings apply). */
export function runArgumentRead(runtime: OperationRuntime, request: ArgumentToolRead): unknown {
  const deps = runtime.argument;
  if (!deps) return UNSUPPORTED_HERE;
  if (request.field !== undefined && request.ids?.length !== 1)
    return {
      ok: false,
      status: "unsupported",
      detail: "field reads one text of ONE argument: pass ids with exactly that argument's id",
    };
  const loaded = loadForTool(deps, request.workId);
  if (loaded.kind !== "ok") return unavailableAnswer(loaded).payload;
  if (request.field !== undefined && request.ids) {
    const part = readFieldPayload(
      loaded.work,
      loaded.graph,
      request.ids[0] as string,
      request.field,
      request.offset ?? 0
    );
    if (part.kind === "not_found") return { ok: false, status: "not_found", detail: part.detail };
    if (part.kind === "out_of_range")
      return { ok: false, status: "unsupported", detail: part.detail };
    if (part.kind === "gap")
      return { ok: false, status: "rejected", detail: part.detail, gap: { bytes: part.needs } };
    return { ok: true, status: "ok", ...part.payload };
  }
  const outcome = readPayload(loaded.work, loaded.graph, {
    ...(request.offset !== undefined ? { offset: request.offset } : {}),
    ...(request.edgeOffset !== undefined ? { edgeOffset: request.edgeOffset } : {}),
    ...(request.ids ? { ids: request.ids } : {}),
  });
  if (outcome.kind === "gap")
    return { ok: false, status: "rejected", detail: outcome.detail, gap: { bytes: outcome.needs } };
  return { ok: true, status: "ok", ...outcome.payload };
}

/** `argument.create|update|delete|undo_delete|add_edge|remove_edge`: one pure edit, written with the page's write. */
export async function runArgumentEdit(
  runtime: OperationRuntime,
  request: Exclude<ArgumentToolWrite, { action: "replace" | "clear" }>
): Promise<unknown> {
  const deps = runtime.argument;
  if (!deps) return UNSUPPORTED_HERE;
  const { workId, expectedRev } = request;
  let deleted: RemovedArgument | undefined;
  if (request.action === "undo_delete") {
    // Like the page's Undo: only onto the graph the delete produced. Anything else may have moved on.
    const entry = deps.undo.take(workId, request.id);
    if (!entry) return { ok: false, status: "not_found", detail: NOTHING_TO_UNDO };
    if (entry.rev !== expectedRev) {
      const latest = loadForTool(deps, workId);
      if (latest.kind !== "ok") return unavailableAnswer(latest).payload;
      return conflictAnswer(latest.graph, latest.work, undefined);
    }
  }
  const outcome = await commitEdit(
    deps,
    workId,
    expectedRev,
    (graph) =>
      applyEditRequest(deps, request, graph, (removed) => {
        deleted = removed;
      }),
    () => true
  );
  switch (outcome.kind) {
    case "not_saved":
    case "unknown":
      return UNKNOWN;
    case "no_work":
    case "library_error":
    case "unreadable":
      return unavailableAnswer(outcome).payload;
    case "conflict":
      return conflictAnswer(outcome.latest, outcome.work, undefined);
    case "rejected":
      return refusedAnswer(undefined, outcome.rejection);
    case "ok": {
      const extra = outcome.extra as { id?: string };
      if (deleted) deps.undo.remember(workId, deleted, outcome.graph.rev);
      if (request.action === "undo_delete") deps.undo.forget(workId, request.id);
      return editedAnswer(
        outcome.graph,
        request.action === "create" ? extra.id : undefined,
        deleted
      );
    }
  }
}

/** The card an external agent's replace or clear puts up, with what the stored graph is now. */
function replaceCard(
  request: Extract<ArgumentToolWrite, { action: "replace" | "clear" }>,
  described: NonNullable<ReturnType<typeof describeArgumentTarget>>,
  proposed: ArgumentGraph
) {
  return {
    action: "replace_argument_graph" as const,
    object: { kind: "work" as const, id: request.workId, workId: request.workId },
    label: described.label,
    mode: request.action === "clear" ? ("clear" as const) : ("replace" as const),
    current: described.size,
    next: sizeOf(proposed),
    baseRev: described.rev,
    objectDigest: described.objectDigest,
  };
}

/**
 * `argument.replace` and `argument.clear`. The proposed graph is checked first (a bad one is refused before anyone is
 * asked); a graph that has arguments is replaced only after the user approved the card and the graph is still the one
 * the card showed.
 */
export async function runArgumentReplace(
  runtime: OperationRuntime,
  request: Extract<ArgumentToolWrite, { action: "replace" | "clear" }>,
  call: OperationCall
): Promise<unknown> {
  const deps = runtime.argument;
  if (!deps) return UNSUPPORTED_HERE;
  const { workId, expectedRev } = request;
  const loaded = loadForTool(deps, workId);
  if (loaded.kind !== "ok") return unavailableAnswer(loaded).payload;
  const { graph: current, work: info } = loaded;
  if (current.rev !== expectedRev) return conflictAnswer(current, info, undefined);
  const built = proposedGraph(current, request);
  if (!built.ok) return refusedAnswer(current.rev, built.rejection);
  if (current.arguments.length === 0 && request.action === "clear")
    return alreadyEmptyAnswer(current);
  let baseRev = current.rev;
  let settle: ((result: unknown) => void) | undefined;
  if (current.arguments.length > 0) {
    // Whatever is there would be lost: only the real user can say yes, and only the running workbench can ask.
    if (!runtime.confirm)
      return {
        ok: false,
        status: "workbench_required",
        detail: `${request.action} of a graph that has arguments needs your confirmation on a card in the workbench, and no workbench is running for this data directory; open ArgelanderSpace on this project first. Nothing was written`,
      };
    let described: ReturnType<typeof describeArgumentTarget>;
    try {
      described = describeArgumentTarget(deps, workId);
    } catch {
      return {
        ok: false,
        status: "error",
        detail: "the argument graph could not be checked; nothing was written",
      };
    }
    if (!described) return unavailableAnswer({ kind: "no_work" }).payload;
    baseRev = described.rev;
    const waiting = runtime.confirm.ask({
      card: replaceCard(request, described, built.graph),
      client: call.client,
      signal: call.signal,
    });
    if (waiting === null)
      return {
        ok: false,
        status: "rejected",
        detail:
          "too many requests are already waiting for the user's confirmation; nothing was written",
      };
    const asked = await waiting;
    if (asked.answer === "withdrawn")
      return {
        ok: false,
        status: "interrupted",
        detail: "the request was withdrawn before it was decided; nothing was written",
      };
    if (asked.answer === "denied")
      return {
        ok: false,
        status: "denied",
        detail: "the user denied the request; nothing was written",
      };
    settle = asked.settle;
    // Approved: the click is the commit. Check once more that it is the graph the card showed.
    let again: ReturnType<typeof describeArgumentTarget>;
    try {
      again = describeArgumentTarget(deps, workId);
    } catch {
      again = null;
    }
    if (!again || again.rev !== baseRev || again.objectDigest !== described.objectDigest) {
      settle(GRAPH_CHANGED_ANSWER);
      return GRAPH_CHANGED_ANSWER;
    }
  }
  let result: unknown;
  try {
    const outcome = await writeArgumentProposal(
      deps,
      workId,
      info,
      baseRev,
      built.graph,
      {},
      () => true
    );
    switch (outcome.kind) {
      case "not_saved":
      case "unknown":
        result = UNKNOWN;
        break;
      case "no_work":
      case "library_error":
      case "unreadable":
        result = unavailableAnswer(outcome).payload;
        break;
      case "conflict":
        // With a card shown, a change in between is "the graph changed", not a rebase hint (the card is spent).
        result =
          current.arguments.length > 0
            ? GRAPH_CHANGED_ANSWER
            : conflictAnswer(outcome.latest, outcome.work, undefined);
        break;
      case "rejected":
        result = refusedAnswer(undefined, outcome.rejection);
        break;
      case "ok":
        result = { ok: true, status: "ok", rev: outcome.graph.rev, counts: sizeOf(outcome.graph) };
        break;
    }
  } catch (e) {
    settle?.({ ok: false, status: "error", detail: e instanceof Error ? e.message : String(e) });
    throw e;
  }
  settle?.(result);
  return result;
}
