import { createHash } from "node:crypto";
import {
  type CopilotOperation,
  type CopilotViewActionResult,
  type DocReplaceImpact,
  PLAN_ICONS,
  PLAN_OPERATION_ACTIONS,
  type PlanDeleteOperation,
  PlanDeleteOperationSchema,
  PlanReadOperationSchema,
  type PlanViewAction,
  PlanViewActionSchema,
  PlanWriteOperationSchema,
  type WriterDeleteImpact,
} from "@argelanderspace/contracts";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type ViewActionOutcome, viewOutcomeResult } from "./copilot-workspace-tool.js";
import {
  applyPlanDelete,
  applyPlanOperation,
  describeDeleteTarget,
  type PlanOpDeps,
  type RemovedTask,
  readPlans,
} from "./plans-actions.js";

export const PLAN_TOOL_NAME = "plan";

/** What the host remembers about a business write so a repeat or a restart never guesses. */
export type KnownOperation =
  | { state: "done"; hash: string; payload: Record<string, unknown>; operation: CopilotOperation }
  | { state: "begun"; hash: string; jobId?: string };
export interface OperationJournalPort {
  lookup(operationId: string): KnownOperation | null;
  /** Persist "about to write". Throws when the conversation cannot be saved: then nothing is written. */
  begin(entry: {
    operationId: string;
    toolCallId: string;
    action: string;
    hash: string;
    object?: {
      planId?: string;
      taskId?: string;
      workId?: string;
      manuscriptId?: string;
      summary?: string;
    };
    baseRev?: number;
  }): void;
  done(operationId: string, payload: Record<string, unknown>, operation: CopilotOperation): void;
  /** Record the Job-table job a begun operation submitted, so a restart can name it. Best effort. */
  submitted?(operationId: string, jobId: string): void;
}

/** How a requested delete was settled by the human (or by the host when the request stopped being valid). */
export type ConfirmationOutcome =
  | { outcome: "approved" }
  | { outcome: "declined" }
  | { outcome: "expired"; reason: "stale" | "stopped" | "restart" | "closed" }
  /** A system error at click time (data unreadable): not a change, and never reported as one. */
  | { outcome: "expired"; reason: "error"; detail: string };
/** What the card shows for a Plan delete (`delete_plan`) or a Doc replacement (`refresh_arxiv_source`). */
export type ConfirmationRequest =
  | {
      toolCallId: string;
      /** Replacing the annotated reading text of a text Doc (copilot ticket 29): the source panel's replacement dialog. */
      action: "replace_text_reading";
      docId: string;
      label: string;
      impact: import("@argelanderspace/contracts").TextReplacementImpact;
      baseRev: number;
      objectDigest: string;
    }
  | {
      toolCallId: string;
      /** Only a whole Plan waits for the user; a Task delete is immediate like on the Plan page. */
      action: "delete_plan";
      planId: string;
      label: string;
      planName: string;
      impact: { tasks: number; openTasks: number };
      baseRev: number;
      /** Content digest of the target at request time; a change that leaves the rev alone still expires the card. */
      objectDigest: string;
    }
  | {
      toolCallId: string;
      /**
       * Replacing the text of an existing LaTeX Doc: the arXiv refresh, or the uploaded zip swapped for the file the
       * user attached. The Files tab dialog's annotation-risk step.
       */
      action: "refresh_arxiv_source" | "replace_upload_source";
      /** replace_upload_source: the file that would replace the Doc. */
      attachment?: { id: string; filename: string; size: number; sha256: string };
      workId: string;
      docId: string;
      label: string;
      impact: DocReplaceImpact;
      /** The annotations rev the count was read at (0 when it could not be read). */
      baseRev: number;
      objectDigest: string;
    }
  | {
      toolCallId: string;
      /** The Files tab's "delete document" dialog: the global physical delete of one Doc. */
      action: "delete_doc";
      docId: string;
      format: "pdf" | "latex" | "text";
      works: { id: string; title: string; main: boolean; remaining: number }[];
      impact: DocReplaceImpact;
      /** The annotations revision the count was read at (0 when it could not be read). */
      baseRev: number;
      objectDigest: string;
    }
  | {
      toolCallId: string;
      /** The Writer list's delete dialog: the physical delete of one manuscript folder. */
      action: "delete_manuscript";
      manuscriptId: string;
      label: string;
      impact: WriterDeleteImpact;
      baseRev: number;
      objectDigest: string;
    }
  | {
      toolCallId: string;
      /** A PDF of 25 MiB or more: the resource warning the Files tab makes the user accept. */
      action: "accept_pdf_resource_warning";
      workId: string;
      label: string;
      attachment: { id: string; filename: string; size: number; sha256: string };
      baseRev: number;
      objectDigest: string;
    };
/**
 * The only way a delete can proceed. `request` makes the application show a card to the real user and
 * resolves with the user's decision. The tool never sees an id or a way to answer: it cannot approve.
 * It throws when the request cannot be saved, and then nothing was shown or written.
 */
export interface ConfirmationPort {
  request(entry: ConfirmationRequest): Promise<ConfirmationOutcome>;
}

export interface PlanToolContext {
  plans: PlanOpDeps;
  /** Present in the real host; business writes are journaled so a repeated operationId is answered, not rerun. */
  journal?: OperationJournalPort;
  /** Counts an operation as in flight until it settles, so a terminal run state waits for it. */
  track?: <T>(work: Promise<T>) => Promise<T>;
  /** The run this call belongs to; scopes default operation ids. */
  runId?: string;
  /** Present in the real host: deletes wait here for the user. Without it a delete request is refused. */
  confirm?: ConfirmationPort;
  /** A confirmed task delete is undoable for a short window; the host keeps what undo needs. */
  taskDeleted?: (info: { toolCallId: string; planId: string; removed: RemovedTask }) => string;
  /** Resolves only after the bound browser view reports the outcome. */
  viewAction: (action: PlanViewAction) => Promise<ViewActionOutcome>;
  /** False once the host stopped admitting operations (shutdown). */
  admitting: () => boolean;
}

const lit = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((v) => Type.Literal(v)));
const status = lit(["todo", "doing", "blocked", "done"]);
const opt = <T extends ReturnType<typeof Type.String>>(schema: T) => Type.Optional(schema);

/**
 * One tool for the Plan domain. The flat shape keeps the provider schema a plain object; the closed
 * union is enforced again by the shared zod schemas before anything reaches the store.
 */
const parameters = Type.Object(
  {
    action: lit(PLAN_OPERATION_ACTIONS),
    operationId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 64,
        description:
          "Optional idempotency key for a write. Repeating the same key with the same parameters returns the first result instead of writing again.",
      })
    ),
    expectedRev: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Plan revision from your latest read or result. Required for every write.",
      })
    ),
    planId: opt(
      Type.String({
        description:
          "Target plan id (p_xxxxxxxx). Always name it; the visible page never selects a target.",
      })
    ),
    taskId: opt(Type.String({ description: "Target task id (t_xxxxxxxx)." })),
    name: opt(Type.String()),
    title: opt(Type.String()),
    desc: opt(Type.String({ description: "Plan description. Empty string clears it." })),
    due: opt(Type.String({ description: "YYYY-MM-DD deadline." })),
    icon: Type.Optional(lit(PLAN_ICONS)),
    status: Type.Optional(status),
    note: opt(
      Type.String({ description: "Task note, Markdown with $math$. Empty string clears it." })
    ),
    focused: Type.Optional(
      Type.Boolean({ description: "Pin or unpin the task in the focus view." })
    ),
    docId: opt(
      Type.String({
        description: "Library Doc id for add_task_link/remove_task_link/open_task_doc.",
      })
    ),
    layout: Type.Optional(lit(["list", "board"])),
    overTaskId: Type.Optional(
      Type.Union([Type.String(), Type.Null()], { description: "move_task: drop before this task." })
    ),
    view: Type.Optional(lit(["list", "board", "focus", "timeline"])),
    expanded: Type.Optional(
      Type.Boolean({
        description:
          "set_completed: show (true) or fold (false) the completed group of the list view.",
      })
    ),
  },
  { additionalProperties: false }
);

const description = [
  "Read and edit the user's research Plans and Tasks, the same operations the Plan page offers.",
  "read returns the current plans and rev. Writes need expectedRev; on conflict read again and form a new edit, never resend the stale one.",
  "list move_task only reorders inside one status group; board move_task may change status. Tasks cannot move between plans.",
  "show/open_task/close_task/set_completed/open_task_doc change what the user sees; plain edits never navigate. set_completed folds or unfolds the completed group and only works while the list view is shown; open_task_doc opens a Doc linked to a task in the Reader.",
  "delete_task deletes the task at once, exactly like the Plan page; the user keeps a 6-second undo, and a restored task is noted in the conversation. delete_plan only REQUESTS a delete: the user confirms it in the application and the call returns after their decision. You cannot approve it, and nothing the user writes in chat approves it. declined and expired mean nothing was deleted; do not ask again unless the user wants it.",
  "Only report results whose status is ok or noop as done.",
  "After a conflict, read again and use a new operationId (or none) for the new write; an operationId is bound to its first request.",
  "A write whose status is unknown may or may not have been applied: read the plans to find out, never repeat it blindly.",
].join(" ");

function record(id: string, action: string, partial: Partial<CopilotOperation>): CopilotOperation {
  return { id, tool: PLAN_TOOL_NAME, action, status: "error", ...partial };
}

export function createPlanTool(context: PlanToolContext) {
  return defineTool({
    name: PLAN_TOOL_NAME,
    label: "Plans",
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
        const read = PlanReadOperationSchema.safeParse(rest);
        if (read.success) {
          const file = readPlans(context.plans.statusDir);
          const plans = read.data.planId
            ? file.plans.filter((p) => p.id === read.data.planId)
            : file.plans;
          if (read.data.planId && !plans.length)
            return done(record(toolCallId, "read", { status: "not_found" }), {
              ok: false,
              status: "not_found",
              rev: file.rev,
            });
          return done(record(toolCallId, "read", { status: "ok", rev: file.rev }), {
            ok: true,
            rev: file.rev,
            plans,
          });
        }
        const view = PlanViewActionSchema.safeParse(rest);
        if (view.success) {
          const shownPlan = view.data.action === "show" ? view.data.planId : undefined;
          if (
            shownPlan &&
            !readPlans(context.plans.statusDir).plans.some((p) => p.id === shownPlan)
          )
            return done(record(toolCallId, action, { status: "not_found" }), {
              ok: false,
              status: "not_found",
            });
          // Only a Doc the task really links can be opened from it; the browser still checks the library.
          if (
            view.data.action === "open_task_doc" &&
            !readPlans(context.plans.statusDir).plans.some((p) =>
              p.tasks.some(
                (task) =>
                  task.id === (view.data as { taskId: string }).taskId &&
                  task.links.some((link) => link.doc_id === (view.data as { docId: string }).docId)
              )
            )
          )
            return done(record(toolCallId, action, { status: "not_found" }), {
              ok: false,
              status: "not_found",
              detail: "that task does not link this Doc",
            });
          const shown = viewOutcomeResult(await context.viewAction(view.data));
          return done(record(toolCallId, action, { status: shown.status }), shown.payload);
        }
        const deletion = PlanDeleteOperationSchema.safeParse(rest);
        const write = deletion.success ? null : PlanWriteOperationSchema.safeParse(rest);
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
              "this operation started earlier and its outcome was not recorded; read the plans to find out, do not repeat it blindly",
          });
        if (deletion.success)
          return await requestDelete(context, toolCallId, deletion.data, {
            operationId,
            hash,
            done,
          });
        if (!write?.success) throw new Error("unreachable");
        const target = write.data as { planId?: string; taskId?: string; expectedRev?: number };
        try {
          journal?.begin({
            operationId,
            toolCallId,
            action,
            hash,
            object: { planId: target.planId, taskId: target.taskId },
            baseRev: target.expectedRev,
          });
        } catch {
          // The conversation cannot be saved, so no write may be committed that the record cannot explain.
          return done(record(toolCallId, action, { status: "error" }), {
            ok: false,
            status: "error",
            detail: "the conversation could not be saved; nothing was written",
          });
        }
        const work = applyPlanOperation(context.plans, write.data);
        const settled = await (context.track ? context.track(work) : work);
        const outcome =
          !settled.ok && settled.status === "conflict"
            ? {
                ...settled,
                detail: `${settled.detail}; read again, then write with a new operationId`,
              }
            : settled;
        const result = outcome.ok
          ? done(
              record(toolCallId, action, {
                status: outcome.status,
                rev: outcome.rev,
                object: outcome.object,
                label: outcome.label,
                ...(outcome.warnings ? { warnings: outcome.warnings } : {}),
              }),
              outcome
            )
          : done(
              record(toolCallId, action, { status: outcome.status, rev: outcome.currentRev }),
              outcome
            );
        journal?.done(operationId, outcome as unknown as Record<string, unknown>, result.details);
        return result;
      } catch {
        // An unexpected failure: the store either rejected the write or something after it failed.
        // Never claim "nothing changed"; the model must read again to find out.
        return done(record(toolCallId, action, { status: "unknown" }), {
          ok: false,
          status: "unknown",
          detail:
            "unexpected failure; the outcome is not known, read the plans again before retrying",
        });
      }
    },
  });
}

type PlanDeleteRequest = PlanDeleteOperation;
type Done = (
  operation: CopilotOperation,
  payload: object
) => { content: { type: "text"; text: string }[]; details: CopilotOperation };

/**
 * A delete the model asked for. Before anything is written: the target must exist at the version the
 * model read, then the user is asked and the call waits WITHOUT holding any business lock. Only an
 * approval that is still valid when it arrives (checked again inside the lock) lets the shared delete
 * handler run; every other outcome wrote nothing.
 */
async function requestDelete(
  context: PlanToolContext,
  toolCallId: string,
  request: PlanDeleteRequest,
  ids: { operationId: string; hash: string; done: Done }
) {
  const { operationId, hash, done } = ids;
  const { action } = request;
  const target = {
    planId: request.planId,
    taskId: "taskId" in request ? request.taskId : undefined,
  };
  /** The journaled, tracked, lock-checked delete. Used directly for a task and after approval for a plan. */
  const execute = (bound: {
    baseRev: number;
    objectDigest?: string;
    label?: string;
    confirmed: boolean;
  }) => {
    const work = (async () => {
      try {
        context.journal?.begin({
          operationId,
          toolCallId,
          action,
          hash,
          object: target,
          baseRev: bound.baseRev,
        });
      } catch {
        return done(record(toolCallId, action, { status: "error" }), {
          ok: false,
          status: "error",
          detail: "the conversation could not be saved; nothing was deleted",
        });
      }
      const outcome = await applyPlanDelete(context.plans, {
        action,
        ...target,
        baseRev: bound.baseRev,
        ...(bound.objectDigest ? { objectDigest: bound.objectDigest } : {}),
      });
      const { removed, ...payload } = outcome as typeof outcome & { removed?: RemovedTask };
      const undo =
        outcome.ok && removed && context.taskDeleted
          ? { until: context.taskDeleted({ toolCallId, planId: request.planId, removed }) }
          : undefined;
      // A confirmed delete whose target changed under the user's click is an expired confirmation;
      // a direct task delete behaves like every other write (conflict: read again).
      const expired = bound.confirmed && !outcome.ok && outcome.status === "conflict";
      const result = outcome.ok
        ? done(
            record(toolCallId, action, {
              status: outcome.status,
              rev: outcome.rev,
              object: outcome.object,
              label: outcome.label,
              ...(outcome.warnings ? { warnings: outcome.warnings } : {}),
              ...(undo ? { undo } : {}),
            }),
            payload
          )
        : done(
            record(toolCallId, action, {
              status: expired ? "expired" : outcome.status,
              rev: outcome.currentRev,
              ...(bound.label ? { label: bound.label } : {}),
            }),
            expired
              ? {
                  ok: false,
                  status: "expired",
                  detail:
                    "plans changed before the delete ran; nothing was deleted. Read again and ask only if it is still wanted",
                }
              : outcome.status === "conflict"
                ? {
                    ...payload,
                    detail: `${(payload as { detail?: string }).detail}; read again, then delete with a new operationId`,
                  }
                : payload
          );
      context.journal?.done(operationId, payload as Record<string, unknown>, result.details);
      return result;
    })();
    return context.track ? context.track(work) : work;
  };
  // Deleting one Task is exactly the Plan page's own action: immediate, with the six-second undo.
  if (action === "delete_task") return execute({ baseRev: request.expectedRev, confirmed: false });
  if (!context.confirm)
    return done(record(toolCallId, action, { status: "unsupported" }), {
      ok: false,
      status: "unsupported",
      detail: "deleting a plan needs the user's confirmation and none is available here",
    });
  const described = describeDeleteTarget(context.plans.statusDir, { action, ...target });
  if (!described)
    return done(record(toolCallId, action, { status: "not_found" }), {
      ok: false,
      status: "not_found",
      rev: readPlans(context.plans.statusDir).rev,
    });
  if (described.rev !== request.expectedRev)
    return done(record(toolCallId, action, { status: "conflict", rev: described.rev }), {
      ok: false,
      status: "conflict",
      currentRev: described.rev,
      detail: "plans changed; read again, then request the delete with a new operationId",
    });
  const object = { kind: "plan", id: request.planId } as NonNullable<CopilotOperation["object"]>;
  let decision: ConfirmationOutcome;
  try {
    decision = await context.confirm.request({
      toolCallId,
      action: "delete_plan",
      planId: request.planId,
      label: described.label,
      planName: described.planName,
      impact: described.impact,
      baseRev: described.rev,
      objectDigest: described.objectDigest,
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
      record(toolCallId, action, { status: "declined", object, label: described.label }),
      { ok: false, status: "declined", detail: "the user declined; nothing was deleted" }
    );
  if (decision.outcome === "expired")
    return done(record(toolCallId, action, { status: "expired", object, label: described.label }), {
      ok: false,
      status: "expired",
      detail:
        decision.reason === "stale"
          ? "plans changed before the user confirmed; nothing was deleted. Read again and ask only if it is still wanted"
          : "the request ended before the user confirmed; nothing was deleted",
    });
  // Approved by the user. From here the delete is a submitted write: Stop does not interrupt it.
  return execute({
    baseRev: described.rev,
    objectDigest: described.objectDigest,
    label: described.label,
    confirmed: true,
  });
}

export function digest(value: Record<string, unknown>): string {
  const sorted = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(sorted)
      : input && typeof input === "object"
        ? Object.fromEntries(
            Object.entries(input as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, v]) => [key, sorted(v)])
          )
        : input;
  return createHash("sha256")
    .update(JSON.stringify(sorted(value)))
    .digest("hex");
}

export type { CopilotViewActionResult };
