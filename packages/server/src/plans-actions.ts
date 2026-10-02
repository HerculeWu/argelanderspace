import {
  type CopilotOperation,
  moveToColumn,
  type Plan,
  type PlansFile,
  PlansFileSchema,
  type PlanWriteOperation,
  PlanWriteOperationSchema,
  reorderWithinStatus,
  type Task,
} from "@argelanderspace/contracts";
import {
  loadPlans,
  loadPlansRaw,
  newPlanId,
  newTaskId,
  savePlans,
  savePlansRaw,
} from "@argelanderspace/core";
import type { AsyncLock } from "./lock.js";

export function readPlans(statusDir: string): PlansFile {
  return loadPlans(statusDir);
}

/** Replace a validated whole document using the app's dedicated Plan lock. */
export async function replacePlans(
  statusDir: string,
  planLock: AsyncLock,
  file: PlansFile,
  onChanged: () => void
): Promise<{ conflictRev: number } | { saved: PlansFile }> {
  const outcome = await planLock.run(() => {
    const current = readPlans(statusDir);
    if (file.rev !== current.rev) return { conflictRev: current.rev } as const;
    savePlans(statusDir, file, { bumpRev: true });
    return { saved: { ...file, rev: file.rev + 1 } } as const;
  });
  if ("saved" in outcome) onChanged();
  return outcome;
}

// ---- Narrow operations (UI-equivalent edits used by the Copilot `plan` tool) ----- //
//
// They share the dedicated Plan lock, the rev check, the atomic save, the rev bump and the
// `plan.changed` notification with replacePlans(). The difference is the unit of change: a
// named field/array operation applied to the CURRENT raw document inside the lock, so a field
// the caller did not name, and keys this schema does not know, are never rewritten.

type Raw = Record<string, unknown>;

export type PlanOpStatus = "conflict" | "not_found" | "rejected" | "invalid";
export type PlanOpOutcome =
  | {
      ok: true;
      status: "ok" | "noop";
      rev: number;
      object?: NonNullable<CopilotOperation["object"]>;
      label?: string;
      warnings?: string[];
    }
  | { ok: false; status: PlanOpStatus; currentRev: number; detail: string };

export interface PlanOpDeps {
  statusDir: string;
  planLock: AsyncLock;
  onChanged: () => void;
  /** Whether a Doc id belongs to a library Work (the UI's link candidates). */
  docExists: (docId: string) => boolean;
}

const fail = (status: PlanOpStatus, currentRev: number, detail: string): PlanOpOutcome => ({
  ok: false,
  status,
  currentRev,
  detail,
});

export async function applyPlanOperation(
  deps: PlanOpDeps,
  input: PlanWriteOperation
): Promise<PlanOpOutcome> {
  const op = PlanWriteOperationSchema.parse(input);
  const outcome = await deps.planLock.run((): PlanOpOutcome & { wrote?: boolean } => {
    const { raw, file } = loadPlansRaw(deps.statusDir);
    if (op.expectedRev !== file.rev) return fail("conflict", file.rev, "plans changed; read again");
    const next = structuredClone(raw);
    const rawPlans = next.plans as Raw[];
    const planIndex =
      op.action === "create_plan" ? -1 : file.plans.findIndex((p) => p.id === op.planId);
    if (op.action !== "create_plan" && planIndex < 0) return fail("not_found", file.rev, "plan");
    // Only create_plan has no target plan, and it never reads these.
    const plan = file.plans[planIndex] as Plan;
    const rawPlan = rawPlans[planIndex] as Raw;
    // `tasks` defaults to [] in the schema, so a legal file may omit it; it is only written when we write.
    const rawTasks = () => {
      if (!Array.isArray(rawPlan.tasks)) rawPlan.tasks = [];
      return rawPlan.tasks as Raw[];
    };
    let result: {
      object: NonNullable<CopilotOperation["object"]>;
      label: string;
      warnings?: string[];
    };
    const taskOf = (taskId: string) => {
      const index = plan.tasks.findIndex((t) => t.id === taskId);
      return index < 0
        ? null
        : { index, task: plan.tasks[index] as Task, raw: rawTasks()[index] as Raw };
    };
    const warn = (due: string) =>
      plan && due > plan.due ? ["task_due_after_plan_due"] : undefined;
    switch (op.action) {
      case "create_plan": {
        const id = newPlanId();
        const desc = op.desc?.trim();
        rawPlans.push({
          id,
          name: op.name,
          ...(desc ? { desc } : {}),
          due: op.due,
          icon: op.icon ?? "target",
          created_at: new Date().toISOString(),
          tasks: [],
        });
        result = { object: { kind: "plan", id }, label: op.name };
        break;
      }
      case "update_plan": {
        const target = rawPlan;
        if (op.name !== undefined) target.name = op.name;
        if (op.due !== undefined) target.due = op.due;
        if (op.icon !== undefined) target.icon = op.icon;
        if (op.desc !== undefined) {
          const desc = op.desc.trim();
          if (desc) target.desc = desc;
          else delete target.desc;
        }
        result = { object: { kind: "plan", id: op.planId }, label: String(target.name) };
        break;
      }
      case "create_task": {
        const id = newTaskId();
        const due = op.due ?? plan.due;
        rawTasks().push({
          id,
          title: op.title,
          status: op.status ?? "todo",
          due,
          links: [],
          focused: false,
          created_at: new Date().toISOString(),
        });
        result = {
          object: { kind: "task", id, planId: op.planId },
          label: op.title,
          warnings: warn(due),
        };
        break;
      }
      case "update_task":
      case "add_task_link":
      case "remove_task_link": {
        const found = taskOf(op.taskId);
        if (!found) return fail("not_found", file.rev, "task");
        const target = found.raw;
        if (op.action === "update_task") {
          if (op.title !== undefined) target.title = op.title;
          if (op.status !== undefined) target.status = op.status;
          if (op.due !== undefined) target.due = op.due;
          if (op.focused !== undefined) target.focused = op.focused;
          if (op.note !== undefined) {
            const note = op.note.trim();
            if (note) target.note = note;
            else delete target.note;
          }
        } else {
          const links = Array.isArray(target.links) ? (target.links as Raw[]) : [];
          const linked = links.some((l) => l.doc_id === op.docId);
          if (op.action === "add_task_link") {
            if (!deps.docExists(op.docId)) return fail("rejected", file.rev, "unknown_doc");
            if (!linked) target.links = [...links, { doc_id: op.docId }];
          } else if (linked) target.links = links.filter((l) => l.doc_id !== op.docId);
        }
        result = {
          object: { kind: "task", id: op.taskId, planId: op.planId },
          label: String(target.title),
          warnings: warn(String(target.due)),
        };
        break;
      }
      case "move_task": {
        const found = taskOf(op.taskId);
        if (!found) return fail("not_found", file.rev, "task");
        const tasks = plan.tasks;
        let reordered: Task[];
        if (op.layout === "list") {
          if (!op.overTaskId) return fail("invalid", file.rev, "overTaskId required");
          const over = tasks.find((t) => t.id === op.overTaskId);
          if (!over) return fail("not_found", file.rev, "over task");
          // The list renders one group per status and refuses a cross-group drop.
          if (over.status !== found.task.status) return fail("rejected", file.rev, "cross_status");
          reordered = reorderWithinStatus(tasks, found.task.status, op.taskId, op.overTaskId);
        } else {
          if (!op.status) return fail("invalid", file.rev, "status required");
          if (op.overTaskId && !tasks.some((t) => t.id === op.overTaskId))
            return fail("not_found", file.rev, "over task");
          reordered = moveToColumn(tasks, op.taskId, op.status, op.overTaskId ?? null);
        }
        if (reordered !== tasks) {
          const byId = new Map(rawTasks().map((t) => [t.id, t]));
          const oldStatus = new Map(tasks.map((t) => [t.id, t.status]));
          rawPlan.tasks = reordered.map((t) => {
            const entry = byId.get(t.id) as Raw;
            return oldStatus.get(t.id) === t.status ? entry : { ...entry, status: t.status };
          });
        }
        result = {
          object: { kind: "task", id: op.taskId, planId: op.planId },
          label: found.task.title,
        };
        break;
      }
    }
    if (JSON.stringify(next) === JSON.stringify(raw))
      return { ok: true, status: "noop", rev: file.rev, ...result };
    // Validate here so "invalid" is a schema verdict, not a guess from a storage error message.
    if (!PlansFileSchema.safeParse({ ...next, rev: file.rev + 1 }).success)
      return fail("invalid", file.rev, "result is not a valid plan document");
    return {
      ok: true,
      status: "ok",
      rev: savePlansRaw(deps.statusDir, next).rev,
      ...result,
      wrote: true,
    };
  });
  const { wrote, ...visible } = outcome as PlanOpOutcome & { wrote?: boolean };
  if (visible.ok && wrote) {
    try {
      deps.onChanged();
    } catch {
      // The write is committed; only the live notification failed. Say so instead of hiding the write.
      visible.warnings = [...(visible.warnings ?? []), "change_notification_failed"];
    }
  }
  return visible as PlanOpOutcome;
}

/**
 * Doc ids the Plan UI lets a user link: each Work's main Doc (`doc_ids[0]`, the library payload's
 * `doc_id`). Secondary Docs are not offered by the link picker, so the tool does not accept them.
 */
export function isLinkableDoc(works: { doc_ids: string[] }[], docId: string): boolean {
  return works.some((work) => work.doc_ids[0] === docId);
}
