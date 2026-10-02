import { createHash } from "node:crypto";
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

/** What the host remembers about a business write so a repeat or a restart never guesses. */
export type KnownOperation =
  | { state: "done"; hash: string; payload: Record<string, unknown>; operation: CopilotOperation }
  | { state: "begun"; hash: string };
export interface OperationJournalPort {
  lookup(operationId: string): KnownOperation | null;
  /** Persist "about to write". Throws when the conversation cannot be saved: then nothing is written. */
  begin(entry: {
    operationId: string;
    toolCallId: string;
    action: string;
    hash: string;
    object?: { planId?: string; taskId?: string };
    baseRev?: number;
  }): void;
  done(operationId: string, payload: Record<string, unknown>, operation: CopilotOperation): void;
}

export interface PlanToolContext {
  plans: PlanOpDeps;
  /** Present in the real host; business writes are journaled so a repeated operationId is answered, not rerun. */
  journal?: OperationJournalPort;
  /** Counts an operation as in flight until it settles, so a terminal run state waits for it. */
  track?: <T>(work: Promise<T>) => Promise<T>;
  /** The run this call belongs to; scopes default operation ids. */
  runId?: string;
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
          const shown = await context.viewAction(view.data);
          const mapped = shown === "displayed" ? "ok" : shown;
          return done(record(toolCallId, action, { status: mapped }), {
            ok: mapped === "ok",
            status: mapped,
          });
        }
        const write = PlanWriteOperationSchema.safeParse(rest);
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
              "this operation started earlier and its outcome was not recorded; read the plans to find out, do not repeat it blindly",
          });
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

function digest(value: Record<string, unknown>): string {
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
