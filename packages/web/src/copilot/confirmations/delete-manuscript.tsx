import type { CopilotConfirmation } from "@argelanderspace/contracts";
import { useTranslation } from "react-i18next";
import type { ConfirmationCardKind } from "./kind";

type DeleteManuscriptConfirmation = Extract<CopilotConfirmation, { action: "delete_manuscript" }>;

/** The manuscript list's delete dialog the model asked for (ticket 22): the title, what goes with it, id and version. */
function DeleteManuscriptBody({ card }: { card: DeleteManuscriptConfirmation }) {
  const { t } = useTranslation();
  return <>
    <h3>{t("copilot.confirmation.deleteManuscript", { title: card.label })}</h3>
    <p data-ui="copilot-confirmation-scope">{t("copilot.confirmation.manuscriptScope", { cells: card.impact.cells, comments: card.impact.comments, assets: card.impact.assets })}</p>
    <div className="copilot-confirmation-meta">{t("copilot.confirmation.metaManuscript", { id: card.object.id, rev: card.baseRev })}</div>
  </>;
}

export const deleteManuscript: ConfirmationCardKind<DeleteManuscriptConfirmation> = {
  match: (card): card is DeleteManuscriptConfirmation => card.action === "delete_manuscript",
  Body: DeleteManuscriptBody,
  confirmLabel: (t) => t("common.delete"),
  tone: "danger",
  problemScope: "manuscript",
  // Deleting an open manuscript would drop its unsaved edits: the workspace asks first, a refusal keeps the card.
  beforeApprove: (card, guards) => guards.leaveManuscript(card.object.id),
};
