/**
 * The Plan page as a pane adapter (copilot ticket 37). Its status is never `unavailable`: a page without a loaded
 * plans file is an error. Expanding the completed group and the load-failure Retry exist only on a mounted page that
 * has them: they never open or switch to a Plan page (`existing-only`) and are asked of `available` first.
 */
import { type CopilotViewAction, type PlanPage, PlanViewActionSchema, type PlanViewAction } from "@argelanderspace/contracts";
import { type PaneAdapter, registered, reported, unavailable, type ViewActionOutcome } from "../argelander/panes";
import type { PlanViewController } from "./PlanView";

export function createPlanPane(notify: () => void) {
  const page = reported<PlanPage>(notify);
  const controller = registered<PlanViewController>();
  const adapter: PaneAdapter = {
    page: "plan",
    status: () => (page.get() ? "complete" : "error"),
    context: () => ({ plan: page.get() }),
    // open_task_doc opens a Doc: the Shell does it before any page is asked.
    handles: (action) => action.action !== "open_task_doc" && PlanViewActionSchema.safeParse(action).success,
    needsPane: (action) => (action.action === "set_completed" || action.action === "retry_plans" ? "existing-only" : "any"),
    available: (action) => controller.get()?.available(action as PlanViewAction) ?? false,
    // a loaded page has no Retry button to press
    refused: (action): ViewActionOutcome => (action.action === "retry_plans" ? { ok: false, detail: "disabled" } : unavailable()),
    ready: () => controller.get() !== null,
    // only actions it `handles` reach `available` and `apply`
    apply: async (action: CopilotViewAction) => {
      const current = controller.get();
      return current ? current.apply(action as PlanViewAction) : unavailable();
    },
    timeouts: { readyMs: 2000, applyMs: 2000 },
  };
  return { adapter, props: { onContext: page.set, onController: controller.set } };
}
