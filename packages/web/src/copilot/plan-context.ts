import type { PlanPage, PlansFile } from "@argelanderspace/contracts";
import { focusGroups, resolvePlanSelection } from "../plan/model";

export function capturePlanPage(file: PlansFile, selectedId: string | null, openTaskId: string | null, mode: PlanPage["mode"], today: string, saveState: PlanPage["saveState"]): PlanPage {
  const { plan, taskLoc } = resolvePlanSelection(file.plans, selectedId, openTaskId);
  const focus = mode === "focus" ? focusGroups(file.plans, today) : [];
  const ids = new Set(focus.flatMap((group) => group.items.map((item) => item.task.id)));
  const plans = mode === "timeline" ? file.plans : mode === "focus" ? file.plans.filter((item) => item.tasks.some((task) => ids.has(task.id))).map((item) => ({ ...item, tasks: item.tasks.filter((task) => ids.has(task.id)) })) : plan ? [plan] : [];
  return { rev: file.rev, selectedPlanId: plan?.id ?? null, mode, plans,
    groups: mode === "focus" ? focus.map((group) => ({ key: group.key, taskIds: group.items.map((item) => item.task.id) })) : mode === "list" && plan ? ["doing", "todo", "blocked", "done"].map((key) => ({ key, taskIds: plan.tasks.filter((task) => task.status === key).map((task) => task.id) })).filter((group) => group.taskIds.length > 0) : [],
    detail: taskLoc ? { planId: taskLoc.plan.id, task: taskLoc.task } : null, saveState };
}
