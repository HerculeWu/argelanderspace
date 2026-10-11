import type { CopilotConfirmation } from "@argelanderspace/contracts";
import { useTranslation } from "react-i18next";
import type { ConfirmationCardKind } from "./kind";

type DeletePlanConfirmation = Extract<CopilotConfirmation, { action: "delete_plan" }>;

/** The waiting card of prototype A: the plan, what it takes with it, and the user's own decision (ticket 11). */
function DeletePlanBody({ card }: { card: DeletePlanConfirmation }) {
  const { t } = useTranslation();
  return <>
    <h3>{t("copilot.confirmation.deletePlan", { name: card.label })}</h3>
    <p>{t("copilot.confirmation.planScope", { count: card.impact.tasks, open: card.impact.openTasks })}</p>
    <div className="copilot-confirmation-meta">{t("copilot.confirmation.meta", { id: card.object.id, rev: card.baseRev })}</div>
  </>;
}

export const deletePlan: ConfirmationCardKind<DeletePlanConfirmation> = {
  match: (card): card is DeletePlanConfirmation => card.action === "delete_plan",
  Body: DeletePlanBody,
  confirmLabel: (t) => t("plan.deletePlan.confirm"),
  tone: "danger",
  problemScope: "plan",
};
