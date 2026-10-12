/**
 * One kind of human confirmation (copilot ticket 35): everything the host needs to know about one `action` — the card
 * the user sees, the durable "requested"/"resolved" record fields, the resume line, and the click/background check.
 * The host keeps only persistence, the wait and the decision sequence; it looks a kind up by `action`.
 */
import type { CopilotConfirmation, OperationConfirmation } from "@argelanderspace/contracts";
import type { ConfirmationRequest } from "../copilot-tool-kit.js";

export type ConfirmationAction = ConfirmationRequest["action"];
/** What a check says about a card now: still what it showed, really changed, or not readable (a system error). */
export type ConfirmationCheck = "valid" | "changed" | { error: string };
/** Which change notification makes the host recheck a kind's pending cards in the background. */
export type ConfirmationTrigger = "plans" | "writer" | "doc" | "argument";

type RecordBase =
  | "version"
  | "phase"
  | "confirmationId"
  | "runId"
  | "toolCallId"
  | "baseRev"
  | "outcome";
/** The record's own fields for one action (the host adds the common ones). */
export type ConfirmationRecordFields<A extends ConfirmationAction> = A extends ConfirmationAction
  ? Omit<OperationConfirmation & { action: A }, RecordBase>
  : never;

export interface ConfirmationKind<A extends ConfirmationAction = ConfirmationAction> {
  action: A;
  /** The card the real user sees for one asked confirmation. */
  card(
    id: string,
    runId: string,
    request: Extract<ConfirmationRequest, { action: A }>
  ): Extract<CopilotConfirmation, { action: A }>;
  /** The durable "requested" record's own fields. */
  requestedFields(
    request: Extract<ConfirmationRequest, { action: A }>
  ): ConfirmationRecordFields<A>;
  /** The durable "resolved" record's own fields for one card. */
  resolvedFields(card: Extract<CopilotConfirmation, { action: A }>): ConfirmationRecordFields<A>;
  /** One line of a resume request for a confirmation that was asked and never answered. */
  askedLine(record: OperationConfirmation & { action: A }): string;
  /** Whether the card still shows what is there: at the click and at every background recheck. */
  check(card: Extract<CopilotConfirmation, { action: A }>): Promise<ConfirmationCheck>;
  /** The notification that rechecks pending cards in the background; null: checked only at the click. */
  revalidateOn: ConfirmationTrigger | null;
  /** Only the view the run is bound to may decide it (the rule of ticket 12). */
  boundToNavView: boolean;
}

/** Every kind, keyed by its action. */
export type ConfirmationKinds = { [A in ConfirmationAction]: ConfirmationKind<A> };

/** The message of a thrown value, for an `{ error }` check. */
export function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
