import type { CopilotConfirmation } from "@argelanderspace/contracts";
import { useTranslation } from "react-i18next";
import type { ConfirmationCardKind } from "./kind";

type DeleteDocConfirmation = Extract<CopilotConfirmation, { action: "delete_doc" }>;

/** The Files tab's "delete document" dialog the model asked for (ticket 16), with the dialog's own strings and facts. */
function DeleteDocBody({ card }: { card: DeleteDocConfirmation }) {
  const { t } = useTranslation();
  return <>
    <h3>{t("copilot.confirmation.deleteDoc", { id: card.object.id })}</h3>
    <p data-ui="copilot-confirmation-risk">{t("library.detail.deleteDoc.risk")}</p>
    <p data-ui="copilot-confirmation-scope"><strong>{t("library.detail.deleteDoc.scopeTitle")}</strong> {t(card.format === "pdf" ? "library.detail.deleteDoc.pdfScope" : card.format === "text" ? "library.detail.deleteDoc.textScope" : "library.detail.deleteDoc.scope")}</p>
    {card.works.length > 0 && <ul className="copilot-confirmation-works" data-ui="copilot-confirmation-works">{card.works.map((item) => <li key={item.id} data-ui="copilot-confirmation-work" data-ui-key={item.id}>{t("copilot.confirmation.deleteDocWork", { title: item.title || item.id, state: t(item.main ? "library.detail.files.mainBadge" : "library.detail.files.additionalBadge"), count: item.remaining })}</li>)}</ul>}
    <p role="status" data-ui="copilot-confirmation-count">{card.impact.annotations === "known" ? t("library.detail.deleteDoc.count", { count: card.impact.count }) : t("library.detail.deleteDoc.countUnknown")}</p>
    <div className="copilot-confirmation-meta">{card.impact.annotations === "known" ? t("copilot.confirmation.metaDoc", { id: card.object.id, rev: card.baseRev }) : card.object.id}</div>
  </>;
}

export const deleteDoc: ConfirmationCardKind<DeleteDocConfirmation> = {
  match: (card): card is DeleteDocConfirmation => card.action === "delete_doc",
  Body: DeleteDocBody,
  confirmLabel: (t) => t("library.detail.deleteDoc.confirm"),
  tone: "danger",
  problemScope: "deleteDoc",
  // The dialog's own order: deleting the open Doc first asks the workspace's leave guard (unsaved drafts); a refusal keeps the card.
  beforeApprove: (card, guards) => guards.leaveDoc(card.object.id),
};
