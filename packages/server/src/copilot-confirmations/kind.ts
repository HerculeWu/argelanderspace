/**
 * One kind of human confirmation (copilot ticket 35): everything the host needs to know about one `action` beyond the
 * card's fields — how the card's object is made, the durable record's own fields, the resume line, and the
 * click/background check. The fields of a card are the contracts' card schema (architecture-deepening ticket 07): the
 * tool's request and the record follow from it. The host keeps only persistence, the wait and the decision sequence;
 * it looks a kind up by `action`.
 */
import type {
  CopilotConfirmation,
  FileToolAllowClass,
  OperationConfirmation,
} from "@argelanderspace/contracts";

export type ConfirmationAction = CopilotConfirmation["action"];
/** The card of one action, as the contracts' card schema defines it. */
export type ConfirmationCard<A extends ConfirmationAction> = Extract<
  CopilotConfirmation,
  { action: A }
>;
/** What a check says about a card now: still what it showed, really changed, or not readable (a system error). */
export type ConfirmationCheck = "valid" | "changed" | { error: string };
/** Which change notification makes the host recheck a kind's pending cards in the background. */
export type ConfirmationTrigger = "plans" | "writer" | "doc" | "argument";

type Flat<T> = { [K in keyof T]: T[K] };
/**
 * What a tool asks for one action: the card's fields without the host's `id` and `runId` and without `object`, which the
 * kind makes from the flat identifiers `Ids` the tool gives in its place.
 */
export type ConfirmationRequestOf<A extends ConfirmationAction, Ids extends object> = Flat<
  Omit<ConfirmationCard<A>, "id" | "runId" | "object"> & Ids
>;

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

export interface ConfirmationKind<
  A extends ConfirmationAction = ConfirmationAction,
  Ids extends object = object,
> {
  action: A;
  /** The card's object, made from the flat identifiers the tool gives (and the request's own fields). */
  object(request: ConfirmationRequestOf<A, Ids>): ConfirmationCard<A>["object"];
  /** The durable record's own fields, read off the card: the same for the "requested" and the "resolved" record. */
  record(card: ConfirmationCard<A>): ConfirmationRecordFields<A>;
  /** One line of a resume request for a confirmation that was asked and never answered. */
  askedLine(record: OperationConfirmation & { action: A }): string;
  /** Whether the card still shows what is there: at the click and at every background recheck. */
  check(card: ConfirmationCard<A>): Promise<ConfirmationCheck>;
  /** The notification that rechecks pending cards in the background; null: checked only at the click. */
  revalidateOn: ConfirmationTrigger | null;
  /** Only the view the run is bound to may decide it (the rule of ticket 12). */
  boundToNavView: boolean;
  /**
   * File and command tools (copilot ticket 57): the class of call an approval can be extended to for the rest of the
   * conversation. Only a real view's click can ask for it; the tool never sees an id or a way to answer.
   */
  remembers?: FileToolAllowClass;
}

/** Every kind, keyed by its action. */
export type ConfirmationKinds = { [A in ConfirmationAction]: ConfirmationKind<A> };

/** The message of a thrown value, for an `{ error }` check. */
export function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
