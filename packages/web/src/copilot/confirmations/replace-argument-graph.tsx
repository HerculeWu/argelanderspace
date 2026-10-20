import type { CopilotConfirmation } from "@argelanderspace/contracts";
import { useTranslation } from "react-i18next";
import type { ConfirmationCardKind } from "./kind";

type ReplaceArgumentGraphConfirmation = Extract<CopilotConfirmation, { action: "replace_argument_graph" }>;

/**
 * The argument graph's replace/clear the model asked for (argument graph ticket 09, prototype C's card): the work, what the
 * graph holds now (it is lost) and what it will hold. The Clear dialog of the page, widened to a whole-graph write.
 */
function ReplaceArgumentGraphBody({ card }: { card: ReplaceArgumentGraphConfirmation }) {
  const { t } = useTranslation();
  const clearing = card.mode === "clear";
  return <>
    <h3 data-ui="copilot-confirmation-title">{t(clearing ? "copilot.confirmation.clearArgument" : "copilot.confirmation.replaceArgument")}</h3>
    <p data-ui="copilot-confirmation-work">{card.label}</p>
    <p data-ui="copilot-confirmation-scope">{t(clearing ? "copilot.confirmation.clearArgumentScope" : "copilot.confirmation.replaceArgumentScope", { currentArguments: card.current.arguments, currentEdges: card.current.edges, nextArguments: card.next.arguments, nextEdges: card.next.edges })}</p>
  </>;
}

export const replaceArgumentGraph: ConfirmationCardKind<ReplaceArgumentGraphConfirmation> = {
  Body: ReplaceArgumentGraphBody,
  confirmLabel: (t, card) => t(card.mode === "clear" ? "argument.edit.clearConfirm" : "copilot.confirmation.replaceArgumentConfirm"),
  tone: "danger",
  problemScope: "argument",
};
