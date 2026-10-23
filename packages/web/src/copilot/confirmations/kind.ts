import type { CopilotConfirmation } from "@argelanderspace/contracts";
import type { TFunction } from "i18next";
import type { JSX } from "react";

/** Which family of decision-problem copy a failed or expired decision on this card is told in. */
export type ConfirmationProblemScope = "plan" | "doc" | "deleteDoc" | "manuscript" | "mail" | "argument" | "file" | "shelf";

/**
 * One kind of human confirmation card (ticket 36): what the card shows, its confirm label and tone, how a failed
 * decision is told, and the page's own guard before an approval. The shared card only looks the kind up by `action`,
 * renders its `Body`, and decides.
 */
export interface ConfirmationCardKind<C extends CopilotConfirmation = CopilotConfirmation> {
  /** The card's facts, with their `data-ui`. */
  Body(props: { card: C }): JSX.Element;
  confirmLabel(t: TFunction, card: C): string;
  /**
   * Cards of Copilot's command and file tools (ticket 57) have three decisions: the cancel button reads "Deny", and a
   * middle button approves AND allows this class of call for the rest of the conversation.
   */
  session?: { label(t: TFunction): string };
  tone?: "danger";
  /** The confirm button's tone decided by the card, when it is not fixed (a Shelf add is a danger only when it replaces). */
  toneOf?(card: C): "danger" | undefined;
  problemScope: ConfirmationProblemScope;
  /** The page's guard before an approval; false keeps the card and sends nothing. */
  beforeApprove?(card: C, guards: ConfirmationGuards): boolean | Promise<boolean>;
}

/** Every card kind, keyed by its action (the shape of the server's `ConfirmationKinds`): a missing action does not compile. */
export type ConfirmationCardKinds = {
  [A in CopilotConfirmation["action"]]: ConfirmationCardKind<Extract<CopilotConfirmation, { action: A }>>;
};

/** The workspace's guards a confirmation must pass before an approval takes something the user has open away. */
export interface ConfirmationGuards {
  /** Deleting a Doc: asks the workspace's leave guard only when it is the open Doc. */
  leaveDoc(docId: string): boolean | Promise<boolean>;
  /** Deleting a manuscript: asks before discarding unsaved edits of an open editor. */
  leaveManuscript(id: string): boolean | Promise<boolean>;
}
