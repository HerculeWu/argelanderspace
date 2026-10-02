import {
  type CopilotOperation,
  type CopilotViewActionResult,
  PLAN_ICONS,
  PLAN_OPERATION_ACTIONS,
  PlanReadOperationSchema,
  type PlanViewAction,
  PlanViewActionSchema,
  PlanWriteOperationSchema,
} from "@argelanderspace/contracts";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { applyPlanOperation, type PlanOpDeps, readPlans } from "./plans-actions.js";

export const PLAN_TOOL_NAME = "plan";

export interface PlanToolContext {
  plans: PlanOpDeps;
  /** Resolves only after the bound browser view reports the outcome. */
  viewAction: (action: PlanViewAction) => Promise<"displayed" | "not_displayed" | "not_found">;
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
    docId: opt(Type.String({ description: "Library Doc id for add_task_link/remove_task_link." })),
    layout: Type.Optional(lit(["list", "board"])),
    overTaskId: Type.Optional(
      Type.Union([Type.String(), Type.Null()], { description: "move_task: drop before this task." })
    ),
    view: Type.Optional(lit(["list", "board", "focus", "timeline"])),
  },
  { additionalProperties: false }
);

const description = [
  "Read and edit the user's research Plans and Tasks, the same operations the Plan page offers.",
  "read returns the current plans and rev. Writes need expectedRev; on conflict read again and form a new edit, never resend the stale one.",
  "list move_task only reorders inside one status group; board move_task may change status. Tasks cannot move between plans.",
  "show/open_task/close_task change what the user sees; plain edits never navigate.",
  "There is no delete action. Only report results whose status is ok or noop as done.",
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
        const read = PlanReadOperationSchema.safeParse(params);
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
        const view = PlanViewActionSchema.safeParse(params);
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
          const shown = await context.viewAction(view.data);
          const mapped = shown === "displayed" ? "ok" : shown;
          return done(record(toolCallId, action, { status: mapped }), {
            ok: mapped === "ok",
            status: mapped,
          });
        }
        const write = PlanWriteOperationSchema.safeParse(params);
        if (!write.success)
          return done(record(toolCallId, action, { status: "unsupported" }), {
            ok: false,
            status: "unsupported",
            detail: "unknown action or invalid parameters",
            issues: write.error.issues
              .slice(0, 5)
              .map((issue) => ({ path: issue.path.join("."), message: issue.message })),
          });
        const outcome = await applyPlanOperation(context.plans, write.data);
        if (!outcome.ok)
          return done(
            record(toolCallId, action, { status: outcome.status, rev: outcome.currentRev }),
            outcome
          );
        return done(
          record(toolCallId, action, {
            status: outcome.status,
            rev: outcome.rev,
            object: outcome.object,
            label: outcome.label,
            ...(outcome.warnings ? { warnings: outcome.warnings } : {}),
          }),
          outcome
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

export type { CopilotViewActionResult };
