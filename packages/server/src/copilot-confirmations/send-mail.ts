import type { Workbench } from "../copilot.js";
import { draftUnchanged } from "../mail-copilot.js";
import type { ConfirmationKind } from "./kind.js";

/** Sending a draft (Mail ticket 09): the card shows this very snapshot and this very snapshot is sent. */
export function sendMailKind(workbench: Workbench | undefined): ConfirmationKind<"send_mail"> {
  return {
    action: "send_mail",
    card: (id, runId, entry) => ({
      id,
      runId,
      toolCallId: entry.toolCallId,
      baseRev: entry.baseRev,
      action: entry.action,
      object: { kind: "mail_draft", id: entry.messageId, accountId: entry.accountId },
      account: entry.account,
      kind: entry.kind,
      to: entry.to,
      cc: entry.cc,
      bcc: entry.bcc,
      subject: entry.subject,
      text: entry.text,
      attachments: entry.attachments,
      inReplyTo: entry.inReplyTo,
      objectDigest: entry.objectDigest,
    }),
    requestedFields: (entry) => ({
      action: entry.action,
      accountId: entry.accountId,
      messageId: entry.messageId,
    }),
    resolvedFields: (card) => ({
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
  };
}
