import type { CopilotConfirmation } from "@argelanderspace/contracts";
import { useTranslation } from "react-i18next";
import type { ConfirmationCardKind } from "./kind";

type RefreshArxivSourceConfirmation = Extract<CopilotConfirmation, { action: "refresh_arxiv_source" }>;

/** The Files tab's "refresh arXiv source" the model asked for: the Work and the annotations the replacement puts at risk. */
function RefreshArxivSourceBody({ card }: { card: RefreshArxivSourceConfirmation }) {
  const { t } = useTranslation();
  return <>
    <h3>{t("copilot.confirmation.refreshArxiv", { name: card.label })}</h3>
    <p>{card.impact.annotations === "known" ? (card.impact.count > 0 ? t("library.detail.acquisition.riskKnown", { count: card.impact.count }) : t("library.detail.acquisition.riskZero")) : t("library.detail.acquisition.riskUnknown")}</p>
    <div className="copilot-confirmation-meta">{card.impact.annotations === "known" ? t("copilot.confirmation.metaDoc", { id: card.object.id, rev: card.baseRev }) : card.object.id}</div>
  </>;
}

export const refreshArxivSource: ConfirmationCardKind<RefreshArxivSourceConfirmation> = {
  Body: RefreshArxivSourceBody,
  confirmLabel: (t) => t("library.detail.acquisition.confirmUpdate"),
  tone: "danger",
  problemScope: "doc",
};
