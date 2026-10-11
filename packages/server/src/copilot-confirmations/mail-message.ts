import type { CopilotConfirmation, OperationConfirmation } from "@argelanderspace/contracts";
import type { ConfirmationRequest } from "../copilot-tool-kit.js";
import type { ConfirmationCheck, ConfirmationKind } from "./kind.js";

/** Moving a message to Trash, deleting it for good from Trash, or moving it to another folder (Mail ticket 09). */
type MessageAction = "delete_mail" | "move_mail";
type MessageRequest = Extract<ConfirmationRequest, { action: MessageAction }>;
type MessageCard = Extract<CopilotConfirmation, { action: MessageAction }>;

const object = (entry: MessageRequest) => ({
  kind: "mail_message" as const,
  id: `${entry.accountId}:${entry.message.folder}:${entry.message.uid}`,
  accountId: entry.accountId,
});
const requestedFields = <R extends MessageRequest>(entry: R) => ({
  action: entry.action as R["action"],
  accountId: entry.accountId,
  folder: entry.message.folder,
  uid: entry.message.uid,
});
const resolvedFields = <C extends MessageCard>(card: C) => ({
  action: card.action as C["action"],
  accountId: card.object.accountId,
  folder: card.message.folder,
  uid: card.message.uid,
});
const askedLine = (entry: OperationConfirmation & { action: MessageAction }) =>
  `${entry.action} ${entry.accountId} ${entry.folder} uid ${entry.uid}`;
// A delete or move names one message by uid and uidValidity; the server refuses a changed one when it runs.
const check = (): Promise<ConfirmationCheck> => Promise.resolve("valid");

export const deleteMailKind: ConfirmationKind<"delete_mail"> = {
  action: "delete_mail",
  card: (id, runId, entry) => ({
    id,
    runId,
    toolCallId: entry.toolCallId,
    baseRev: entry.baseRev,
    action: entry.action,
    object: object(entry),
    account: entry.account,
    message: entry.message,
    permanent: entry.permanent,
    objectDigest: entry.objectDigest,
  }),
  requestedFields,
  resolvedFields,
  askedLine,
  check,
  // Mail cards are checked at the click (an IMAP read is not a background poll).
  revalidateOn: null,
  boundToNavView: false,
};

export const moveMailKind: ConfirmationKind<"move_mail"> = {
  action: "move_mail",
  card: (id, runId, entry) => ({
    id,
    runId,
    toolCallId: entry.toolCallId,
    baseRev: entry.baseRev,
    action: entry.action,
    object: object(entry),
    account: entry.account,
    message: entry.message,
    destination: entry.destination,
    objectDigest: entry.objectDigest,
  }),
  requestedFields,
  resolvedFields,
  askedLine,
  check,
  revalidateOn: null,
  boundToNavView: false,
};
