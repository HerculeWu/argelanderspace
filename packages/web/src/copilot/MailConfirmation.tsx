import type { CopilotConfirmation, CopilotOperation, MailContextSummary } from "@argelanderspace/contracts";
import type { TFunction } from "i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchMailSendStatus, undoMailSend } from "../api/mail-compose";
import { Button, InlineMessage } from "../ui";

export type MailConfirmation = Extract<CopilotConfirmation, { action: "send_mail" | "delete_mail" | "move_mail" }>;
export const isMailConfirmation = (confirmation: CopilotConfirmation): confirmation is MailConfirmation =>
  confirmation.action === "send_mail" || confirmation.action === "delete_mail" || confirmation.action === "move_mail";

const person = (a: { name: string; address: string }) => (a.name.trim() ? `${a.name} <${a.address}>` : a.address);
const list = (people: { name: string; address: string }[]) => people.map(person).join(", ");
const size = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * The card the real user decides on (Mail ticket 09). A send shows the account it leaves from, every recipient (Cc and Bcc
 * included), the subject and the WHOLE body exactly as they will be sent; a delete or move names the one message.
 * Everything here is third-party text, rendered as plain text only.
 */
export function MailCardBody({ confirmation }: { confirmation: MailConfirmation }) {
  const { t } = useTranslation();
  const account = `${confirmation.account.displayName} <${confirmation.account.address}>`;
  if (confirmation.action === "send_mail")
    return <>
      <h3>{t(confirmation.kind === "reply" ? "copilot.mailCard.replyTitle" : confirmation.kind === "forward" ? "copilot.mailCard.forwardTitle" : "copilot.mailCard.sendTitle")}</h3>
      {confirmation.kind === "forward" && <p className="copilot-mail-note" data-ui="copilot-confirmation-kind">{t("copilot.mailCard.isForward")}</p>}
      <dl className="copilot-mail-fields" data-ui="copilot-confirmation-mail">
        <dt>{t("copilot.mailCard.from")}</dt><dd data-ui="copilot-confirmation-account">{account}</dd>
        <dt>{t("copilot.mailCard.to")}</dt><dd data-ui="copilot-confirmation-to">{list(confirmation.to) || t("copilot.mailCard.none")}</dd>
        {confirmation.cc.length > 0 && <><dt>{t("copilot.mailCard.cc")}</dt><dd data-ui="copilot-confirmation-cc">{list(confirmation.cc)}</dd></>}
        {confirmation.bcc.length > 0 && <><dt>{t("copilot.mailCard.bcc")}</dt><dd data-ui="copilot-confirmation-bcc">{list(confirmation.bcc)}</dd></>}
        <dt>{t("copilot.mailCard.subject")}</dt><dd data-ui="copilot-confirmation-subject">{confirmation.subject || t("mail.noSubject")}</dd>
        {confirmation.kind === "reply" && <><dt>{t("copilot.mailCard.thread")}</dt><dd>{t("copilot.mailCard.isReply")}</dd></>}
        {confirmation.attachments.length > 0 && <><dt>{t("copilot.mailCard.attachments")}</dt><dd data-ui="copilot-confirmation-attachments">{confirmation.attachments.map((a) => `${a.filename || t("mail.attachments")} (${size(a.size)})`).join(", ")}</dd></>}
        <dt>{t("copilot.mailCard.body")}</dt><dd><pre className="copilot-mail-body" data-ui="copilot-confirmation-body">{confirmation.text || t("mail.noBody")}</pre></dd>
      </dl>
      <p className="copilot-mail-note" data-ui="copilot-confirmation-undo-note">{t("copilot.mailCard.undoNote")}</p>
    </>;
  const m = confirmation.message;
  return <>
    <h3>{t(confirmation.action === "delete_mail" ? "copilot.mailCard.deleteTitle" : "copilot.mailCard.moveTitle")}</h3>
    <dl className="copilot-mail-fields" data-ui="copilot-confirmation-message">
      <dt>{t("copilot.mailCard.from")}</dt><dd>{m.from ? person(m.from) : t("mail.noSender")}</dd>
      <dt>{t("copilot.mailCard.subject")}</dt><dd data-ui="copilot-confirmation-subject">{m.subject || t("mail.noSubject")}</dd>
      <dt>{t("copilot.mailCard.folder")}</dt><dd>{m.folder}</dd>
      {confirmation.action === "move_mail" && <><dt>{t("copilot.mailCard.destination")}</dt><dd data-ui="copilot-confirmation-destination">{confirmation.destination}</dd></>}
    </dl>
    <p data-ui="copilot-confirmation-scope" className={confirmation.action === "delete_mail" && confirmation.permanent ? "copilot-mail-danger" : undefined}>
      {confirmation.action === "move_mail" ? t("copilot.mailCard.moveScope") : confirmation.permanent ? t("copilot.mailCard.deletePermanent") : t("copilot.mailCard.deleteScope")}
    </p>
    <div className="copilot-confirmation-meta" data-ui="copilot-confirmation-account">{account}</div>
  </>;
}

export function mailConfirmLabel(t: TFunction, confirmation: MailConfirmation): string {
  return t(confirmation.action === "send_mail" ? "copilot.mailCard.confirmSend" : confirmation.action === "delete_mail" ? "copilot.mailCard.confirmDelete" : "copilot.mailCard.confirmMove");
}

/** What the Mail page carried (no body, no addresses): where the user was and which message was open. */
export function MailSummary({ summary }: { summary: MailContextSummary }) {
  const { t } = useTranslation();
  return <div className="copilot-library-summary" data-ui="copilot-mail-summary">
    <p>{summary.phase === "ready" ? t("copilot.mailContext.ready") : summary.phase === "no_accounts" ? t("copilot.mailContext.noAccounts") : summary.phase === "error" ? t("copilot.mailContext.error") : t("copilot.mailContext.loading")}</p>
    {summary.phase === "ready" && <p>{t("copilot.mailContext.headers", { count: summary.headers })}</p>}
    {summary.open && <p>{t(summary.open.status === "ok" ? (summary.open.textTruncated ? "copilot.mailContext.openCut" : "copilot.mailContext.open") : summary.open.status === "loading" ? "copilot.mailContext.openLoading" : "copilot.mailContext.openError", { chars: summary.open.textChars ?? 0 })}</p>}
    <p className="copilot-mail-note">{t("copilot.mailContext.untrusted")}</p>
  </div>;
}

/**
 * The 8 second undo window of a send the Copilot started (it shares the Mail page's own undo): shown while the service
 * still holds the send in its window, then what became of it. It reads the send's state from the server, so a send
 * the application stopped inside the window is shown as not sent.
 */
export function MailSendUndo({ operations }: { operations: CopilotOperation[] }) {
  const { t } = useTranslation();
  const op = [...operations].reverse().find((o) => o.mailSend && o.undo && Date.parse(o.undo.until) > Date.now() - 60_000);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [state, setState] = useState<{ id: string; state: string; remainingMs: number | null; code?: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const target = op?.mailSend;
  const id = op?.id;
  useEffect(() => {
    if (!target || !id) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const s = await fetchMailSendStatus(target.accountId, target.sendId);
        if (stop || !alive.current) return;
        setState({ id, state: s.state, remainingMs: s.remainingMs, code: s.code });
        if (s.state === "pending" || s.state === "sending") timer = setTimeout(() => void poll(), 600);
      } catch {
        if (!stop && alive.current) timer = setTimeout(() => void poll(), 1500);
      }
    };
    void poll();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [target?.accountId, target?.sendId, id]); // eslint-disable-line react-hooks/exhaustive-deps
  const undo = useCallback(async () => {
    if (!target || busy) return;
    setBusy(true);
    try { await undoMailSend(target.accountId, target.sendId); } catch { /* the next poll shows the real state */ }
    try { const s = await fetchMailSendStatus(target.accountId, target.sendId); if (alive.current) setState({ id: id ?? "", state: s.state, remainingMs: s.remainingMs, code: s.code }); } catch { /* keep the last state */ }
    if (alive.current) setBusy(false);
  }, [target, busy, id]);
  if (!op || !target || !state || state.id !== op.id || dismissed.has(op.id)) return null;
  if (state.state === "pending")
    return <div className="copilot-notice" data-ui="copilot-mail-undo" data-state="pending" role="status"><span>{t("copilot.mailUndo.pending", { seconds: Math.max(1, Math.ceil((state.remainingMs ?? 0) / 1000)) })}</span><Button data-ui="copilot-mail-undo-action" disabled={busy} onClick={() => void undo()}>{t("copilot.mailUndo.action")}</Button></div>;
  if (state.state === "sending") return <div className="copilot-notice" data-ui="copilot-mail-undo" data-state="sending" role="status"><span>{t("copilot.mailUndo.sending")}</span></div>;
  // A send the mail server may have accepted without telling us (code outcome_unknown) is not "not sent".
  const key = state.state === "sent" ? "sent" : state.state === "cancelled" ? "cancelled" : state.state === "interrupted" ? "interrupted" : state.state === "unknown" || state.code === "outcome_unknown" ? "unknown" : "failed";
  return <div className="copilot-notice" data-ui="copilot-mail-undo" data-state={state.state} role="status"><InlineMessage tone={key === "sent" || key === "cancelled" ? "info" : "warning"}>{t(`copilot.mailUndo.${key}`)}</InlineMessage><Button data-ui="copilot-mail-undo-dismiss" aria-label={t("copilot.mailUndo.dismissLabel")} onClick={() => setDismissed((previous) => new Set(previous).add(op.id))}>{t("copilot.mailUndo.dismiss")}</Button></div>;
}
