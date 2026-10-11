import type { CopilotOperation, MailContextSummary } from "@argelanderspace/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { browserSendTrackerDeps, COPILOT_SEND_POLICY, createSendTracker, type SendTracker, type SendView } from "../mail/send-tracker";
import { Button, InlineMessage } from "../ui";

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
 * still holds the send in its window, then what became of it. It reads the send's state from the server (through the
 * send tracker, with the Copilot bar's own polling policy), so a send the application stopped inside the window is
 * shown as not sent.
 */
export function MailSendUndo({ operations }: { operations: CopilotOperation[] }) {
  const { t } = useTranslation();
  const op = [...operations].reverse().find((o) => o.mailSend && o.undo && Date.parse(o.undo.until) > Date.now() - 60_000);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [views, setViews] = useState<SendView[]>([]);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const tracker = useRef<SendTracker | null>(null);
  useEffect(() => {
    alive.current = true;
    const tr = createSendTracker(browserSendTrackerDeps, COPILOT_SEND_POLICY);
    tracker.current = tr;
    const off = tr.subscribe(setViews);
    return () => { alive.current = false; off(); tr.dispose(); if (tracker.current === tr) tracker.current = null; };
  }, []);
  const target = op?.mailSend;
  const id = op?.id;
  useEffect(() => {
    const tr = tracker.current;
    if (!tr || !target || !id) return;
    tr.track(target.accountId, target.sendId);
    return () => tr.untrack(target.sendId);
  }, [target?.accountId, target?.sendId, id]); // eslint-disable-line react-hooks/exhaustive-deps
  const undo = useCallback(async () => {
    const tr = tracker.current;
    if (!target || !tr || busy) return;
    setBusy(true);
    // Whatever the answer, the bar shows the send's real state as the tracker learns it.
    await tr.undo(target.sendId);
    if (alive.current) setBusy(false);
  }, [target, busy]);
  const view = target ? views.find((v) => v.sendId === target.sendId) : undefined;
  if (!op || !target || !view || dismissed.has(op.id)) return null;
  // Nothing is shown until the server has said something about the send.
  if (view.status === null && (view.phase === "window" || view.phase === "sending")) return null;
  if (view.phase === "window")
    return <div className="copilot-notice" data-ui="copilot-mail-undo" data-state="pending" role="status"><span>{t("copilot.mailUndo.pending", { seconds: Math.max(1, Math.ceil(((view.endsAt ?? 0) - Date.now()) / 1000)) })}</span><Button data-ui="copilot-mail-undo-action" disabled={busy} onClick={() => void undo()}>{t("copilot.mailUndo.action")}</Button></div>;
  if (view.phase === "sending") return <div className="copilot-notice" data-ui="copilot-mail-undo" data-state="sending" role="status"><span>{t("copilot.mailUndo.sending")}</span></div>;
  const state = view.phase === "settled" && view.status ? view.status : null;
  // A send the mail server may have accepted without telling us (code outcome_unknown) is not "not sent".
  const key = !state ? "gone" : state.state === "sent" ? "sent" : state.state === "cancelled" ? "cancelled" : state.state === "interrupted" ? "interrupted" : state.state === "unknown" || state.code === "outcome_unknown" ? "unknown" : "failed";
  return <div className="copilot-notice" data-ui="copilot-mail-undo" data-state={state ? state.state : "gone"} role="status"><InlineMessage tone={key === "sent" || key === "cancelled" ? "info" : "warning"}>{t(`copilot.mailUndo.${key}`)}</InlineMessage><Button data-ui="copilot-mail-undo-dismiss" aria-label={t("copilot.mailUndo.dismissLabel")} onClick={() => setDismissed((previous) => new Set(previous).add(op.id))}>{t("copilot.mailUndo.dismiss")}</Button></div>;
}
