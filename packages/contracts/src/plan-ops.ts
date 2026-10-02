/**
 * Closed Plan/Task operation union shared by the Copilot `plan` tool and the
 * pure task-order helpers the Plan UI also uses (copilot ticket 09).
 *
 * Only what the Plan UI can already do is listed here. There is no delete action
 * (ticket 11 owns deletion and its confirmation) and no cross-Plan move.
 * `expectedRev` is the existing PlansFile.rev, not a new library-wide revision.
 */
import { z } from "zod";
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
]);

export const PlanOperationSchema = z.union([
  PlanWriteOperationSchema,
  PlanReadOperationSchema,
  PlanViewActionSchema,
]);

export type PlanWriteOperation = z.infer<typeof PlanWriteOperationSchema>;
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
  "show",
  "open_task",
  "close_task",
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
    ]),
    rev: Rev.optional(),
    object: z
      .object({ kind: z.enum(["plan", "task"]), id: z.string(), planId: z.string().optional() })
      .strict()
      .optional(),
    /** Verbatim user data (plan name / task title) for display. */
    label: z.string().optional(),
    warnings: z.array(z.string()).optional(),
  })
  .strict();
export type CopilotOperation = z.infer<typeof CopilotOperationSchema>;

export const CopilotViewActionResultSchema = z
  .object({
    actionId: z.string().uuid(),
    ok: z.boolean(),
    detail: z.enum(["not_found", "unavailable", "leave_blocked"]).optional(),
  })
  .strict();
export type CopilotViewActionResult = z.infer<typeof CopilotViewActionResultSchema>;

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
