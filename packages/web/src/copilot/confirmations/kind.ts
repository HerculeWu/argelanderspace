import type { CopilotConfirmation } from "@argelanderspace/contracts";
import type { TFunction } from "i18next";
import type { JSX } from "react";

/** Which family of decision-problem copy a failed or expired decision on this card is told in. */
export type ConfirmationProblemScope = "plan" | "doc" | "deleteDoc" | "manuscript" | "mail" | "argument";

/**
 * One kind of human confirmation card (ticket 36): what the card shows, its confirm label and tone, how a failed
 * decision is told, and the page's own guard before an approval. The shared card only looks the kind up, renders its
 * `Body`, and decides.
 */
export interface ConfirmationCardKind<C extends CopilotConfirmation = CopilotConfirmation> {
  /** Discriminates by `action`. */
  match(card: CopilotConfirmation): card is C;
  /** The card's facts, with their `data-ui`. */
  Body(props: { card: C }): JSX.Element;
  confirmLabel(t: TFunction, card: C): string;
  tone?: "danger";
  problemScope: ConfirmationProblemScope;
  /** The page's guard before an approval; false keeps the card and sends nothing. */
  beforeApprove?(card: C, guards: ConfirmationGuards): boolean;
}

/** The workspace's guards a confirmation must pass before an approval takes something the user has open away. */
export interface ConfirmationGuards {
  /** Deleting a Doc: asks the workspace's leave guard only when it is the open Doc. */
  leaveDoc(docId: string): boolean;
  /** Deleting a manuscript: asks before discarding unsaved edits of an open editor. */
  leaveManuscript(id: string): boolean;
}
