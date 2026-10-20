import {
  type CopilotConfirmation,
  CopilotConfirmationSchema,
  type OperationConfirmation,
} from "@argelanderspace/contracts";
import type { Workbench } from "../copilot.js";
import { deleteDocKind } from "./delete-doc.js";
import { deleteManuscriptKind } from "./delete-manuscript.js";
import { deletePlanKind } from "./delete-plan.js";
import { editFileKind, runCommandKind, writeFileKind } from "./file-tools.js";
import type {
  ConfirmationAction,
  ConfirmationKind,
  ConfirmationKinds,
  ConfirmationRecordFields,
} from "./kind.js";
import { deleteMailKind, moveMailKind } from "./mail-message.js";
import { refreshArxivSourceKind } from "./refresh-arxiv-source.js";
import { replaceArgumentGraphKind } from "./replace-argument-graph.js";
import { replaceTextReadingKind } from "./replace-text-reading.js";
import { sendMailKind } from "./send-mail.js";

export type {
  ConfirmationAction,
  ConfirmationCard,
  ConfirmationCheck,
  ConfirmationKind,
  ConfirmationKinds,
  ConfirmationRecordFields,
  ConfirmationRequestOf,
  ConfirmationTrigger,
} from "./kind.js";

/** Every confirmation kind, its checks reading this workbench (none: every check says changed, as before). */
export function createConfirmationKinds(workbench: Workbench | undefined) {
  return {
    send_mail: sendMailKind(workbench),
    delete_mail: deleteMailKind,
    move_mail: moveMailKind,
    replace_text_reading: replaceTextReadingKind(workbench),
    delete_plan: deletePlanKind(workbench),
    delete_manuscript: deleteManuscriptKind(workbench),
    delete_doc: deleteDocKind(workbench),
    refresh_arxiv_source: refreshArxivSourceKind(workbench),
    replace_argument_graph: replaceArgumentGraphKind(workbench),
    run_command: runCommandKind,
    edit_file: editFileKind,
    write_file: writeFileKind,
  } satisfies ConfirmationKinds;
}

type Kinds = ReturnType<typeof createConfirmationKinds>;
/** The keys a kind's record projection gives beyond its arm of the record schema (none, for every kind). */
export type ExtraRecordKeys<K> = K extends {
  action: infer A extends ConfirmationAction;
  record: (card: never) => infer R;
}
  ? Exclude<keyof R, keyof ConfirmationRecordFields<A>>
  : never;
// Compile-time check: a record carries exactly the fields of its arm (a missing or renamed one already fails the
// kind's `satisfies`; an extra one fails here).
const exactRecords: [{ [A in keyof Kinds]: ExtraRecordKeys<Kinds[A]> }[keyof Kinds]] extends [never]
  ? true
  : false = true;
void exactRecords;
/**
 * What the card shows, as a tool asks for it: for each action, the card's fields from the contracts' card schema
 * without the host's `id` and `runId`, and with the flat identifiers that kind makes the card's `object` from.
 */
export type ConfirmationRequest = {
  [A in keyof Kinds]: Parameters<Kinds[A]["object"]>[0];
}[keyof Kinds];

/** The keys of each action's card schema, in schema order: a card carries these and nothing else. */
const CARD_KEYS: ReadonlyMap<string, readonly string[]> = new Map(
  CopilotConfirmationSchema.options.map((card) => [
    card.shape.action.value,
    Object.keys(card.shape),
  ])
);

/**
 * The card for one request: the host's id and run, the request's fields and the kind's object, picked by the keys of
 * that action's card schema, so a field the request carries beyond them (a flat identifier) never reaches the page.
 */
export function confirmationCard(
  kind: ConfirmationKind,
  id: string,
  runId: string,
  request: ConfirmationRequest
): CopilotConfirmation {
  const fields: Record<string, unknown> = {
    ...request,
    id,
    runId,
    object: kind.object(request as never),
  };
  const keys = CARD_KEYS.get(request.action) ?? [];
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(fields, key)).map((key) => [key, fields[key]])
  ) as CopilotConfirmation;
}

/**
 * The durable record of one card: the common fields, then the kind's own (read off the card), in the order every
 * record of this version was written in. "requested" is saved before the card is registered; "resolved" carries the
 * outcome and is saved before the tool hears it.
 */
export function confirmationRecord(
  kind: ConfirmationKind,
  card: CopilotConfirmation,
  phase: "requested"
): OperationConfirmation;
export function confirmationRecord(
  kind: ConfirmationKind,
  card: CopilotConfirmation,
  phase: "resolved",
  outcome: "approved" | "declined" | "expired"
): OperationConfirmation;
export function confirmationRecord(
  kind: ConfirmationKind,
  card: CopilotConfirmation,
  phase: "requested" | "resolved",
  outcome?: "approved" | "declined" | "expired"
): OperationConfirmation {
  return {
    version: 1,
    phase,
    confirmationId: card.id,
    runId: card.runId,
    toolCallId: card.toolCallId,
    baseRev: card.baseRev,
    ...(outcome ? { outcome } : {}),
    ...kind.record(card as never),
  } satisfies OperationConfirmation;
}
