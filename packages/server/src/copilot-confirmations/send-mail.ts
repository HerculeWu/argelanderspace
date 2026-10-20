import type { Workbench } from "../copilot.js";
import { draftUnchanged } from "../mail-copilot.js";
import type { ConfirmationKind } from "./kind.js";

/** Sending a draft (Mail ticket 09): the card shows this very snapshot and this very snapshot is sent. */
export function sendMailKind(workbench: Workbench | undefined) {
  return {
    action: "send_mail",
    object: (entry) => ({ kind: "mail_draft", id: entry.messageId, accountId: entry.accountId }),
    record: (card) => ({
      action: card.action,
      accountId: card.object.accountId,
      messageId: card.object.id,
    }),
    askedLine: (entry) => `${entry.action} ${entry.accountId} ${entry.messageId}`,
    /**
     * The stored draft is exactly what the card showed (the same digest the card was made from). An error is a system
     * error (the mail server could not be asked), never reported as a change.
     */
    check: async (card) => {
      const mail = workbench?.mail;
      if (!mail) return "changed";
      const now = await draftUnchanged(
        mail,
        card.object.accountId,
        card.object.id,
        card.objectDigest
      );
      if (now === "same") return "valid";
      if (now === "changed") return "changed";
      // The draft is gone or frozen (in a window, already sent): that is a change; the rest could not be read.
      return now.status === "not_found" || now.status === "conflict"
        ? "changed"
        : { error: now.code };
    },
    // Mail cards are checked at the click (an IMAP read is not a background poll).
    revalidateOn: null,
    boundToNavView: false,
  } satisfies ConfirmationKind<"send_mail", { accountId: string; messageId: string }>;
}
