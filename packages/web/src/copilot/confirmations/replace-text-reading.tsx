import type { CopilotConfirmation } from "@argelanderspace/contracts";
import { useTranslation } from "react-i18next";
import type { ConfirmationCardKind } from "./kind";

type ReplaceTextReadingConfirmation = Extract<CopilotConfirmation, { action: "replace_text_reading" }>;

/** Replacing the reading text of a text Doc that has annotations (ticket 29): the page's replacement dialog, as a card. */
function ReplaceTextReadingBody({ card }: { card: ReplaceTextReadingConfirmation }) {
  const { t } = useTranslation();
  return <>
    <h3>{t("copilot.confirmation.replaceText", { name: card.label })}</h3>
    <p data-ui="copilot-confirmation-risk">{t("doc.text.replace.body", { count: card.impact.annotations })}</p>
    <div className="copilot-confirmation-meta" data-ui="copilot-confirmation-basis">{t("doc.text.replace.basis", { source: card.impact.sourceRev, published: card.impact.publishedSourceRev, annotationsRev: card.impact.annotationsRev })}</div>
  </>;
}

export const replaceTextReading: ConfirmationCardKind<ReplaceTextReadingConfirmation> = {
  match: (card): card is ReplaceTextReadingConfirmation => card.action === "replace_text_reading",
  Body: ReplaceTextReadingBody,
  confirmLabel: (t, card) => t("doc.text.replace.confirm", { count: card.impact.annotations }),
  tone: "danger",
  problemScope: "doc",
};
