import type { OperationConfirmation } from "@argelanderspace/contracts";
import type {
  ConfirmationCard,
  ConfirmationCheck,
  ConfirmationKind,
  ConfirmationRequestOf,
} from "./kind.js";

/** Moving a message to Trash, deleting it for good from Trash, or moving it to another folder (Mail ticket 09). */
type MessageAction = "delete_mail" | "move_mail";
type Ids = { accountId: string };

/** The message's object: account, folder and uid in one id (`acc:INBOX:7`), as the click repeats it. */
const object = (entry: ConfirmationRequestOf<MessageAction, Ids>) => ({
  kind: "mail_message" as const,
  id: `${entry.accountId}:${entry.message.folder}:${entry.message.uid}`,
  accountId: entry.accountId,
});
const record = <C extends ConfirmationCard<MessageAction>>(card: C) => ({
  action: card.action as C["action"],
  accountId: card.object.accountId,
  folder: card.message.folder,
  uid: card.message.uid,
});
const askedLine = (entry: OperationConfirmation & { action: MessageAction }) =>
  `${entry.action} ${entry.accountId} ${entry.folder} uid ${entry.uid}`;
// A delete or move names one message by uid and uidValidity; the server refuses a changed one when it runs.
const check = (): Promise<ConfirmationCheck> => Promise.resolve("valid");

export const deleteMailKind = {
  action: "delete_mail",
  object: (entry) => object(entry),
  record,
  askedLine,
  check,
  // Mail cards are checked at the click (an IMAP read is not a background poll).
  revalidateOn: null,
  boundToNavView: false,
} satisfies ConfirmationKind<"delete_mail", Ids>;

export const moveMailKind = {
  action: "move_mail",
  object: (entry) => object(entry),
  record,
  askedLine,
  check,
  revalidateOn: null,
  boundToNavView: false,
} satisfies ConfirmationKind<"move_mail", Ids>;
