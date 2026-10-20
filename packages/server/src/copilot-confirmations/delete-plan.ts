import type { Workbench } from "../copilot.js";
import { describeDeleteTarget } from "../plans-actions.js";
import { type ConfirmationKind, detailOf } from "./kind.js";

/** A whole Plan's delete (ticket 11): bound to the plans file's rev and the plan's stored content. */
export function deletePlanKind(workbench: Workbench | undefined) {
  return {
    action: "delete_plan",
    object: (entry) => ({ kind: "plan", id: entry.planId, planId: entry.planId }),
    record: (card) => ({ action: card.action, planId: card.object.planId }),
    askedLine: (entry) => `${entry.action} ${entry.planId}`,
    /** The plan's rev and content digest still match what the card showed (synchronous). */
    check: (card) => {
      const statusDir = workbench?.plans.statusDir;
      if (!statusDir) return Promise.resolve("changed");
      try {
        const now = describeDeleteTarget(statusDir, {
          action: card.action,
          planId: card.object.planId,
        });
        // The version AND the content shown: a hand edit of plans.json that leaves the rev alone also ends it.
        return Promise.resolve(
          now && now.rev === card.baseRev && now.objectDigest === card.objectDigest
            ? "valid"
            : "changed"
        );
      } catch (error) {
        // The plans could not be read: a system error, never reported as a change.
        return Promise.resolve({ error: detailOf(error) });
      }
    },
    revalidateOn: "plans",
    boundToNavView: false,
  } satisfies ConfirmationKind<"delete_plan", { planId: string }>;
}
