import type { CopilotConfirmation } from "@argelanderspace/contracts";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { ConfirmationCardKind } from "./kind";

type MailConfirmation = Extract<CopilotConfirmation, { action: "send_mail" | "delete_mail" | "move_mail" }>;

const person = (a: { name: string; address: string }) => (a.name.trim() ? `${a.name} <${a.address}>` : a.address);
const list = (people: { name: string; address: string }[]) => people.map(person).join(", ");
const size = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * The card the real user decides on (Mail ticket 09). A send shows the account it leaves from, every recipient (Cc and Bcc
 * included), the subject and the WHOLE body exactly as they will be sent; a delete or move names the one message.
 * Everything here is third-party text, rendered as plain text only.
 */
function MailCardBody({ card }: { card: MailConfirmation }) {
  const { t } = useTranslation();
  const account = `${card.account.displayName} <${card.account.address}>`;
  if (card.action === "send_mail")
    return <>
      <h3>{t(card.kind === "reply" ? "copilot.mailCard.replyTitle" : card.kind === "forward" ? "copilot.mailCard.forwardTitle" : "copilot.mailCard.sendTitle")}</h3>
      {card.kind === "forward" && <p className="copilot-mail-note" data-ui="copilot-confirmation-kind">{t("copilot.mailCard.isForward")}</p>}
      <dl className="copilot-mail-fields" data-ui="copilot-confirmation-mail">
        <dt>{t("copilot.mailCard.from")}</dt><dd data-ui="copilot-confirmation-account">{account}</dd>
        <dt>{t("copilot.mailCard.to")}</dt><dd data-ui="copilot-confirmation-to">{list(card.to) || t("copilot.mailCard.none")}</dd>
        {card.cc.length > 0 && <><dt>{t("copilot.mailCard.cc")}</dt><dd data-ui="copilot-confirmation-cc">{list(card.cc)}</dd></>}
        {card.bcc.length > 0 && <><dt>{t("copilot.mailCard.bcc")}</dt><dd data-ui="copilot-confirmation-bcc">{list(card.bcc)}</dd></>}
        <dt>{t("copilot.mailCard.subject")}</dt><dd data-ui="copilot-confirmation-subject">{card.subject || t("mail.noSubject")}</dd>
        {card.kind === "reply" && <><dt>{t("copilot.mailCard.thread")}</dt><dd>{t("copilot.mailCard.isReply")}</dd></>}
        {card.attachments.length > 0 && <><dt>{t("copilot.mailCard.attachments")}</dt><dd data-ui="copilot-confirmation-attachments">{card.attachments.map((a) => `${a.filename || t("mail.attachments")} (${size(a.size)})`).join(", ")}</dd></>}
        <dt>{t("copilot.mailCard.body")}</dt><dd><pre className="copilot-mail-body" data-ui="copilot-confirmation-body">{card.text || t("mail.noBody")}</pre></dd>
      </dl>
      <p className="copilot-mail-note" data-ui="copilot-confirmation-undo-note">{t("copilot.mailCard.undoNote")}</p>
    </>;
  const m = card.message;
  return <>
    <h3>{t(card.action === "delete_mail" ? "copilot.mailCard.deleteTitle" : "copilot.mailCard.moveTitle")}</h3>
    <dl className="copilot-mail-fields" data-ui="copilot-confirmation-message">
      <dt>{t("copilot.mailCard.from")}</dt><dd>{m.from ? person(m.from) : t("mail.noSender")}</dd>
      <dt>{t("copilot.mailCard.subject")}</dt><dd data-ui="copilot-confirmation-subject">{m.subject || t("mail.noSubject")}</dd>
      <dt>{t("copilot.mailCard.folder")}</dt><dd>{m.folder}</dd>
      {card.action === "move_mail" && <><dt>{t("copilot.mailCard.destination")}</dt><dd data-ui="copilot-confirmation-destination">{card.destination}</dd></>}
    </dl>
    <p data-ui="copilot-confirmation-scope" className={card.action === "delete_mail" && card.permanent ? "copilot-mail-danger" : undefined}>
      {card.action === "move_mail" ? t("copilot.mailCard.moveScope") : card.permanent ? t("copilot.mailCard.deletePermanent") : t("copilot.mailCard.deleteScope")}
    </p>
    <div className="copilot-confirmation-meta" data-ui="copilot-confirmation-account">{account}</div>
  </>;
}

function mailConfirmLabel(t: TFunction, card: MailConfirmation): string {
  return t(card.action === "send_mail" ? "copilot.mailCard.confirmSend" : card.action === "delete_mail" ? "copilot.mailCard.confirmDelete" : "copilot.mailCard.confirmMove");
}

type SendMailConfirmation = Extract<CopilotConfirmation, { action: "send_mail" }>;
type DeleteMailConfirmation = Extract<CopilotConfirmation, { action: "delete_mail" }>;
type MoveMailConfirmation = Extract<CopilotConfirmation, { action: "move_mail" }>;

export const sendMail: ConfirmationCardKind<SendMailConfirmation> = {
  match: (card): card is SendMailConfirmation => card.action === "send_mail",
  Body: MailCardBody,
  confirmLabel: mailConfirmLabel,
  problemScope: "mail",
};

export const deleteMail: ConfirmationCardKind<DeleteMailConfirmation> = {
  match: (card): card is DeleteMailConfirmation => card.action === "delete_mail",
  Body: MailCardBody,
  confirmLabel: mailConfirmLabel,
  tone: "danger",
  problemScope: "mail",
};

export const moveMail: ConfirmationCardKind<MoveMailConfirmation> = {
  match: (card): card is MoveMailConfirmation => card.action === "move_mail",
  Body: MailCardBody,
  confirmLabel: mailConfirmLabel,
  problemScope: "mail",
};
