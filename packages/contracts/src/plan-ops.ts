/**
 * Closed Plan/Task operation union shared by the Copilot `plan` tool and the
 * pure task-order helpers the Plan UI also uses (copilot ticket 09).
 *
 * Only what the Plan UI can already do is listed here. Deleting is a separate request union
 * (`PlanDeleteOperationSchema`): the tool can only ASK for a delete, the real UI confirms it
 * (ticket 11). There is no cross-Plan move. `expectedRev` is the existing PlansFile.rev, not a
 * new library-wide revision.
 */
import { z } from "zod";
import { ContextCoverageSchema } from "./context-batch.js";
import { JobStatusSchema } from "./job-status.js";
import { type Task, type TaskStatus, TaskStatusSchema } from "./plans.js";

/** The 8 lucide names the Plan modal offers (`target` is the default). */
export const PLAN_ICONS = [
  "target",
  "telescope",
  "book-marked",
  "database",
  "brain-circuit",
  "sigma",
  "flask-conical",
  "microscope",
] as const;

const Rev = z.number().int().nonnegative();
// Same rules as the UI forms and PlanSchema/TaskSchema: trimmed, non-empty, no extra length limit.
const Text = z.string().trim().min(1);
const Id = z.string().min(1);
const Due = z.iso.date();

export const PlanWriteOperationSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create_plan"),
      expectedRev: Rev,
      name: Text,
      due: Due,
      desc: z.string().optional(),
      icon: z.enum(PLAN_ICONS).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("update_plan"),
      expectedRev: Rev,
      planId: Id,
      name: Text.optional(),
      due: Due.optional(),
      /** Empty string clears the description, like the Plan modal. */
      desc: z.string().optional(),
      icon: z.enum(PLAN_ICONS).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("create_task"),
      expectedRev: Rev,
      planId: Id,
      title: Text,
      status: TaskStatusSchema.optional(),
      /** Defaults to the Plan's deadline, like the Task modal. */
      due: Due.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("update_task"),
      expectedRev: Rev,
      planId: Id,
      taskId: Id,
      title: Text.optional(),
      status: TaskStatusSchema.optional(),
      due: Due.optional(),
      /** Markdown+math. Empty string clears it, like the drawer editor. */
      note: z.string().optional(),
      /** Pins the task into the focus view. */
      focused: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("add_task_link"),
      expectedRev: Rev,
      planId: Id,
      taskId: Id,
      docId: Id,
    })
    .strict(),
  z
    .object({
      action: z.literal("remove_task_link"),
      expectedRev: Rev,
      planId: Id,
      taskId: Id,
      docId: Id,
    })
    .strict(),
  z
    .object({
      action: z.literal("move_task"),
      expectedRev: Rev,
      planId: Id,
      taskId: Id,
      /** `list`: only among tasks of the same status. `board`: may change status. */
      layout: z.enum(["list", "board"]),
      /** Required column for `board`; ignored (the task's own status) for `list`. */
      status: TaskStatusSchema.optional(),
      /** Drop before this task; null/absent on `board` = end of the column. */
      overTaskId: Id.nullable().optional(),
    })
    .strict(),
]);

/**
 * A delete is requested, never executed, by the model: the application shows the confirmation to the
 * user, and only the user's click (bound to this object and this rev) lets the shared handler run it.
 * Deliberately NOT part of PlanWriteOperationSchema, so no write path can skip the confirmation.
 */
export const PlanDeleteOperationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("delete_plan"), expectedRev: Rev, planId: Id }).strict(),
  z.object({ action: z.literal("delete_task"), expectedRev: Rev, planId: Id, taskId: Id }).strict(),
]);

/**
 * Undo of a task delete (the Plan page's undo snackbar, for the Copilot): restores a task the user or the Copilot
 * deleted inside the 8-second window. Not a plan write: it carries no `expectedRev` because it only puts the removed
 * task back into the CURRENT plan and never overwrites anything; a plan that is gone is refused as a conflict.
 */
export const PlanUndoOperationSchema = z
  .object({ action: z.literal("undo_delete_task"), planId: Id, taskId: Id })
  .strict();

export const PlanReadOperationSchema = z
  .object({ action: z.literal("read"), planId: Id.optional() })
  .strict();

/** View operations are executed by the bound browser view, never by the store. */
export const PlanViewActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("show"),
      view: z.enum(["list", "board", "focus", "timeline"]),
      planId: Id.optional(),
    })
    .strict(),
  z.object({ action: z.literal("open_task"), taskId: Id }).strict(),
  z.object({ action: z.literal("close_task") }).strict(),
  /** The list view's "completed" group fold (`toggle-completed-tasks`), set explicitly rather than toggled. */
  z.object({ action: z.literal("set_completed"), expanded: z.boolean() }).strict(),
  /** The task drawer's linked-document button (`open-task-doc`): opens that Doc in the Reader. */
  z.object({ action: z.literal("open_task_doc"), taskId: Id, docId: Id }).strict(),
  /** The Retry button of the Plan page's load-failure state (`retry-plans`): reloads plans.json; nothing to press on a loaded page. */
  z.object({ action: z.literal("retry_plans") }).strict(),
]);

export const PlanOperationSchema = z.union([
  PlanWriteOperationSchema,
  PlanDeleteOperationSchema,
  PlanUndoOperationSchema,
  PlanReadOperationSchema,
  PlanViewActionSchema,
]);

export type PlanWriteOperation = z.infer<typeof PlanWriteOperationSchema>;
export type PlanDeleteOperation = z.infer<typeof PlanDeleteOperationSchema>;
export type PlanUndoOperation = z.infer<typeof PlanUndoOperationSchema>;
export type PlanViewAction = z.infer<typeof PlanViewActionSchema>;
export type PlanOperation = z.infer<typeof PlanOperationSchema>;
export const PLAN_OPERATION_ACTIONS = [
  "read",
  "create_plan",
  "update_plan",
  "create_task",
  "update_task",
  "add_task_link",
  "remove_task_link",
  "move_task",
  "delete_plan",
  "delete_task",
  "undo_delete_task",
  "show",
  "open_task",
  "close_task",
  "set_completed",
  "open_task_doc",
  "retry_plans",
] as const;

export const CopilotOperationSchema = z
  .object({
    id: z.string(),
    tool: z.string(),
    action: z.string(),
    /** `ok`/`noop` were committed or unnecessary; every other status wrote nothing. */
    status: z.enum([
      "ok",
      "noop",
      "conflict",
      "not_found",
      "rejected",
      "invalid",
      "not_displayed",
      "unsupported",
      "unknown",
      "error",
      /** A delete waits for the user's confirmation; nothing was written yet. */
      "confirmation_required",
      /** The user declined. Nothing was written. */
      "declined",
      /** The confirmation is no longer valid (changed, stopped or restarted). Nothing was written. */
      "expired",
      /** A background job was submitted and had not finished when the call ended; its outcome is `job.id` in the Job table. */
      "pending",
    ]),
    rev: Rev.optional(),
    object: z
      .object({
        kind: z.enum([
          "plan",
          "task",
          "work",
          "doc",
          /** A Writer manuscript (copilot ticket 22): its own identity, never a Doc. */
          "manuscript",
        ]),
        id: z.string(),
        planId: z.string().optional(),
      })
      .strict()
      .optional(),
    /** Verbatim user data (plan name / task title) for display. */
    label: z.string().optional(),
    warnings: z.array(z.string()).optional(),
    /** A deleted task can be restored until this instant (the Plan page's eight-second undo window). */
    undo: z.object({ until: z.string() }).strict().optional(),
    /** The existing Job-table job this operation submitted (upload / arXiv acquisition), with its state when the call ended. */
    job: z
      .object({
        id: z.string(),
        status: JobStatusSchema,
      })
      .strict()
      .optional(),
    /** The Doc the finished job actually created or refreshed. */
    docId: z.string().optional(),
    /** A `reader read` that delivered a part of a reading (copilot ticket 24): its range, total and what is not yet read. */
    batch: ContextCoverageSchema.optional(),
  })
  .strict();
export type CopilotOperation = z.infer<typeof CopilotOperationSchema>;

export const CopilotViewActionResultSchema = z
  .object({
    actionId: z.string().uuid(),
    ok: z.boolean(),
    detail: z
      .enum([
        "not_found",
        "unavailable",
        "leave_blocked",
        /** The control exists but is disabled right now (for example the pane limit). */
        "disabled",
        /** An exploration request the view ran failed (see `http`); nothing else was started or saved. */
        "failed",
        /** The user cancelled the exploration request the action started. */
        "cancelled",
      ])
      .optional(),
    /** With `failed`: the HTTP status the exploration answered (0 = network failure). */
    http: z.number().int().min(0).max(999).optional(),
    /** A Reader `set_panel` unfold that folded the other side panel to keep the article's minimum width. */
    folded: z.enum(["outline", "right"]).optional(),
  })
  .strict();
export type CopilotViewActionResult = z.infer<typeof CopilotViewActionResultSchema>;

/** The Plan page's undo window after deleting a task. */
export const TASK_UNDO_WINDOW_MS = 8000;

/**
 * Undo of a task delete: put the task back at its original index (clamped), unless it is already there.
 * Same array back when nothing changes. Shared by the Plan page and the service.
 */
export function reinsertTask<T extends { id: string }>(tasks: T[], index: number, task: T): T[] {
  if (tasks.some((t) => t.id === task.id)) return tasks;
  const out = [...tasks];
  out.splice(Math.min(index, out.length), 0, task);
  return out;
}

// --------------------------------------------------------------------------- //
// Task-array reorder helpers (drag results; shared by the UI and the tool)
// --------------------------------------------------------------------------- //

function spliceMove<T>(arr: T[], from: number, to: number): T[] {
  const out = [...arr];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x as T);
  return out;
}

/**
 * List mode: move *activeId* to *overId*'s position among the tasks sharing
 * *status* (their order inside the full array IS the group order). The group
 * is reordered in place; tasks of other statuses keep their exact positions.
 * Same array back when either id is unknown or they coincide.
 */
export function reorderWithinStatus(
  tasks: Task[],
  status: TaskStatus,
  activeId: string,
  overId: string
): Task[] {
  if (activeId === overId) return tasks;
  const groupIdx = tasks.flatMap((t, i) => (t.status === status ? [i] : []));
  const fromPos = groupIdx.findIndex((i) => tasks[i]?.id === activeId);
  const toPos = groupIdx.findIndex((i) => tasks[i]?.id === overId);
  if (fromPos < 0 || toPos < 0) return tasks;
  const group = groupIdx.map((i) => tasks[i] as Task);
  const [moved] = group.splice(fromPos, 1);
  group.splice(toPos, 0, moved as Task);
  const out = [...tasks];
  groupIdx.forEach((idx, k) => {
    out[idx] = group[k] as Task;
  });
  return out;
}

function endOfStatus(tasks: Task[], status: TaskStatus): number {
  for (let i = tasks.length - 1; i >= 0; i--) {
    if (tasks[i]?.status === status) return i + 1;
  }
  return tasks.length;
}

/**
 * Board mode: drop *activeId* into column *status*. Same column: take the
 * over card's place. Cross column: status change + position in one gesture,
 * before the over card or after the column's last card.
 */
export function moveToColumn(
  tasks: Task[],
  activeId: string,
  status: TaskStatus,
  overId: string | null
): Task[] {
  const from = tasks.findIndex((t) => t.id === activeId);
  if (from < 0) return tasks;
  const cur = tasks[from] as Task;
  if (cur.status === status) {
    if (!overId || overId === activeId) return tasks;
    const to = tasks.findIndex((t) => t.id === overId);
    return to < 0 ? tasks : spliceMove(tasks, from, to);
  }
  const moved = { ...cur, status };
  const rest = tasks.filter((t) => t.id !== activeId);
  let at = endOfStatus(rest, status);
  if (overId && overId !== activeId) {
    const i = rest.findIndex((t) => t.id === overId);
    if (i >= 0) at = i;
  }
  const out = [...rest];
  out.splice(at, 0, moved);
  return out;
}
