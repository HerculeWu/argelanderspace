import {
  type CopilotOperation,
  type CopilotViewActionResult,
  PLAN_ICONS,
  PLAN_OPERATION_ACTIONS,
  type PlanDeleteOperation,
  PlanDeleteOperationSchema,
  PlanReadOperationSchema,
  PlanUndoOperationSchema,
  type PlanViewAction,
  PlanViewActionSchema,
  PlanWriteOperationSchema,
} from "@argelanderspace/contracts";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  askUser,
  confirmUnavailable,
  done,
  type Op,
  record as recordFor,
  runOperation,
  type ToolHostContext,
} from "./copilot-tool-kit.js";
import { type ViewActionOutcome, viewOutcomeResult } from "./copilot-workspace-tool.js";
import {
  applyPlanDelete,
  applyPlanOperation,
  describeDeleteTarget,
  type PlanOpDeps,
  type RemovedTask,
  readPlans,
} from "./plans-actions.js";
import type { TaskUndoRegistry } from "./plans-undo.js";

export const PLAN_TOOL_NAME = "plan";

export interface PlanToolContext extends ToolHostContext {
  plans: PlanOpDeps;
  /** The service's undo registry: the same one the Plan page's undo and the Copilot panel use. */
  taskUndo?: TaskUndoRegistry;
  /** The calling conversation: the tool's undo only reaches a delete this conversation made. */
  conversationId?: string;
  /** A confirmed task delete is undoable for a short window; the host keeps what undo needs. */
  taskDeleted?: (info: { toolCallId: string; planId: string; removed: RemovedTask }) => string;
  /** Resolves only after the bound browser view reports the outcome. */
  viewAction: (action: PlanViewAction) => Promise<ViewActionOutcome>;
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
  "show/open_task/close_task/set_completed/open_task_doc change what the user sees; plain edits never navigate. set_completed folds or unfolds the completed group and only works while the list view is shown; open_task_doc opens a Doc linked to a task in the Reader. retry_plans reloads a Plan page that failed to load (else refused).",
  "delete_task deletes the task at once, exactly like the Plan page; the user keeps an 8-second undo, and a restored task is noted in the conversation. undo_delete_task {planId, taskId} puts back a task YOU deleted in the last 8 seconds (not one the user deleted on the page): ok = back with later edits kept; noop = already back (the user restored it): done, never create it again; expired = window over, conflict = its plan is gone, not_found = nothing of yours to undo (also: not deleted by you in this conversation, or deleted again since): those three changed nothing, so create the task again only if the user wants it. delete_plan only REQUESTS a delete: the user confirms it in the application and the call returns after their decision. You cannot approve it, and nothing the user writes in chat approves it. declined and expired mean nothing was deleted; do not ask again unless the user wants it.",
  "Only report results whose status is ok or noop as done.",
  "After a conflict, read again and use a new operationId (or none) for the new write; an operationId is bound to its first request.",
  "A write whose status is unknown may or may not have been applied: read the plans to find out, never repeat it blindly.",
].join(" ");

const record = (id: string, action: string, partial: Partial<CopilotOperation>) =>
  recordFor(PLAN_TOOL_NAME, id, action, partial);

export function createPlanTool(context: PlanToolContext) {
  return defineTool({
    name: PLAN_TOOL_NAME,
    label: "Plans",
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
      // A plans file that cannot be read is a plain error: nothing was written, and nothing can be "unknown".
      const unreadable = (name: string) =>
        done(record(toolCallId, name, { status: "error" }), {
          ok: false,
          status: "error",
          detail: "the plans file could not be read; nothing was changed",
        });
      const readable = () => {
        try {
          readPlans(context.plans.statusDir);
          return true;
        } catch {
          return false;
        }
      };
      try {
        const { operationId: requestedId, ...rest } = params as Record<string, unknown>;
        const read = PlanReadOperationSchema.safeParse(rest);
        if (read.success) {
          if (!readable()) return unreadable("read");
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
        const undoing = PlanUndoOperationSchema.safeParse(rest);
        const view = PlanViewActionSchema.safeParse(rest);
        if (view.success) {
          const shownPlan = view.data.action === "show" ? view.data.planId : undefined;
          if ((shownPlan || view.data.action === "open_task_doc") && !readable())
            return unreadable(action);
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
          const shown = viewOutcomeResult(await context.viewAction(view.data), view.data.action);
          return done(record(toolCallId, action, { status: shown.status }), shown.payload);
        }
        const deletion = PlanDeleteOperationSchema.safeParse(rest);
        const write =
          deletion.success || undoing.success ? null : PlanWriteOperationSchema.safeParse(rest);
        if (write && !write.success)
          return done(record(toolCallId, action, { status: "unsupported" }), {
            ok: false,
            status: "unsupported",
            detail: "unknown action or invalid parameters",
            issues: write.error.issues
              .slice(0, 5)
              .map((issue) => ({ path: issue.path.join("."), message: issue.message })),
          });
        return await runOperation(
          context,
          {
            tool: PLAN_TOOL_NAME,
            toolCallId,
            action,
            rest,
            requestedId,
            readBack: "read the plans to find out",
          },
          async (op) => {
            // Before anything is journaled: a store that cannot be read at all cannot have been written to.
            if (!readable()) return unreadable(action);
            if (deletion.success)
              return await requestDelete(context, toolCallId, deletion.data, op);
            if (undoing.success) {
              // A write like the others (spec 8.3): journaled by operationId, so a repeat returns the first result
              // and a crash between the save and the result reads back as `unknown`.
              if (!context.taskUndo)
                return done(record(toolCallId, action, { status: "unsupported" }), {
                  ok: false,
                  status: "unsupported",
                  detail: "undo is not available here",
                });
              const target = { planId: undoing.data.planId, taskId: undoing.data.taskId };
              if (!op.begin(target)) return op.notSaved("restored");
              const outcome = await op.track(
                context.taskUndo.undo(context.plans, {
                  ...undoing.data,
                  ...(context.conversationId ? { conversationId: context.conversationId } : {}),
                })
              );
              return op.finish(
                outcome.ok
                  ? done(
                      record(toolCallId, action, {
                        status: outcome.status,
                        rev: outcome.rev,
                        object: outcome.object,
                        label: outcome.label,
                      }),
                      outcome
                    )
                  : done(
                      record(toolCallId, action, {
                        status: outcome.status,
                        ...(outcome.rev !== undefined ? { rev: outcome.rev } : {}),
                        object: { kind: "task", id: target.taskId, planId: target.planId },
                      }),
                      outcome
                    )
              );
            }
            if (!write?.success) throw new Error("unreachable");
            const target = write.data as { planId?: string; taskId?: string; expectedRev?: number };
            // The conversation cannot be saved, so no write may be committed that the record cannot explain.
            if (!op.begin({ planId: target.planId, taskId: target.taskId }, target.expectedRev))
              return op.notSaved("written");
            const settled = await op.track(applyPlanOperation(context.plans, write.data));
            const outcome =
              !settled.ok && settled.status === "conflict"
                ? {
                    ...settled,
                    detail: `${settled.detail}; read again, then write with a new operationId`,
                  }
                : settled;
            return op.finish(
              outcome.ok
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
                  )
            );
          }
        );
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

/**
 * A delete the model asked for. Before anything is written: the target must exist at the version the
 * model read, then the user is asked and the call waits WITHOUT holding any business lock. Only an
 * approval that is still valid when it arrives (checked again inside the lock) lets the shared delete
 * handler run; every other outcome wrote nothing.
 */
async function requestDelete(
  context: PlanToolContext,
  toolCallId: string,
  request: PlanDeleteOperation,
  op: Op
) {
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
  }) =>
    op.track(
      (async () => {
        if (!op.begin(target, bound.baseRev)) return op.notSaved("deleted");
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
        // The journal keeps the shared handler's own answer, not the wording the model got for it.
        return op.finish(result, payload as Record<string, unknown>);
      })()
    );
  // Deleting one Task is exactly the Plan page's own action: immediate, with the eight-second undo.
  if (action === "delete_task") return execute({ baseRev: request.expectedRev, confirmed: false });
  const unavailable = confirmUnavailable(context, {
    tool: PLAN_TOOL_NAME,
    toolCallId,
    action,
    nothing: "deleted",
  });
  if (unavailable) return unavailable;
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
  // The wait for the user is not tracked: Stop must still be able to end the card.
  const answer = await askUser(context, {
    tool: PLAN_TOOL_NAME,
    toolCallId,
    action,
    object: { kind: "plan", id: request.planId },
    label: described.label,
    request: {
      toolCallId,
      action: "delete_plan",
      planId: request.planId,
      label: described.label,
      planName: described.planName,
      impact: described.impact,
      baseRev: described.rev,
      objectDigest: described.objectDigest,
    },
    nothing: "deleted",
    changed: "plans",
  });
  if (!answer.approved) return answer.result;
  // Approved by the user. From here the delete is a submitted write: Stop does not interrupt it.
  return execute({
    baseRev: described.rev,
    objectDigest: described.objectDigest,
    label: described.label,
    confirmed: true,
  });
}

export type { CopilotViewActionResult };
