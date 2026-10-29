import type { CopilotConfirmation, ExternalRequest } from "@argelanderspace/contracts";
import type { TFunction } from "i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { decideExternalRequest } from "../api/external-requests";
import { type ConfirmationGuards, kindOf } from "../copilot/confirmations";
import { Icon } from "../lib/icons";
import { Button } from "../ui";
import "./external-requests.css";
import { useExternalRequests } from "./use-external-requests";

/**
 * The external agents' confirmation cards (release-0.2 ticket 04, approved prototype 03, variant A): a non-modal card
 * floating at the bottom right of the main area, belonging to no Copilot conversation and shown on every page, plus a
 * chip in the title bar. The card is the Copilot card of the same action, drawn with the card kinds Copilot uses and
 * asking the same page guards before an approval; what is new is the source strip (who asked, the command line, how
 * long it has waited), the queue (only the earliest card can be decided) and the withdrawn state (the command left).
 */

/** How long the result of a decision stays where the card was. */
export const RESULT_MS = 4500;

type Result = { tone: "ok" | "warn"; title: string; body: string };

export interface ExternalRequestsModel {
  requests: ExternalRequest[];
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  expand: () => void;
}

/** One state for the title-bar chip and the dock; also the tab title's `(n)` prefix and the leave prompt. */
export function useExternalRequestsModel(): ExternalRequestsModel & { refresh: () => Promise<void>; dismiss: (id: string) => Promise<void> } {
  const { requests, refresh, dismiss } = useExternalRequests();
  const [collapsed, setCollapsed] = useState(false);
  // A card that arrives opens the dock again, so a request never waits unseen behind a bar the user folded earlier.
  const seen = useRef(new Set<string>());
  useEffect(() => {
    let fresh = false;
    for (const request of requests) if (!seen.current.has(request.id)) { seen.current.add(request.id); fresh = true; }
    if (fresh) setCollapsed(false);
  }, [requests]);
  const waiting = requests.filter((request) => request.state === "pending").length;
  // The tab title carries the number of requests waiting, for a window that is not in front (the browser form's only
  // reminder; a desktop shell has none yet).
  useEffect(() => {
    if (waiting === 0) return;
    const base = document.title;
    document.title = `(${waiting}) ${base}`;
    return () => { document.title = base; };
  }, [waiting]);
  // Closing the window or leaving the page ends every request the command lines wait on.
  useEffect(() => {
    if (waiting === 0) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [waiting]);
  return { requests, collapsed, setCollapsed, expand: () => setCollapsed(false), refresh, dismiss };
}

/** The title bar's chip: the number of requests, a way back to the dock when it is folded. */
export function ExternalRequestsChip({ model }: { model: ExternalRequestsModel }) {
  const { t } = useTranslation();
  const count = model.requests.length;
  if (count === 0) return null;
  return <button type="button" className="external-requests-chip" data-ui="external-requests-chip" aria-label={t("externalRequests.chipLabel", { count })} onClick={model.expand}>
    <Icon name="square-terminal" />{t("externalRequests.chip", { count })}
  </button>;
}

const waited = (since: string, now: number) => {
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** One line naming what a request asks, for the queue and the folded bar. */
function summaryOf(t: TFunction, card: CopilotConfirmation): string {
  if (card.action === "delete_doc") return t("copilot.confirmation.deleteDoc", { id: card.object.id });
  if (card.action === "refresh_arxiv_source") return t("copilot.confirmation.refreshArxiv", { name: card.label });
  return card.action;
}

export function ExternalRequestsDock({ model, guards, openDocId, onDocDeleted }: { model: ExternalRequestsModel & { refresh: () => Promise<void>; dismiss: (id: string) => Promise<void> }; guards: ConfirmationGuards; openDocId: string | null; onDocDeleted: (docId: string, remaining: string[]) => void }) {
  const { t } = useTranslation();
  const { requests, collapsed, setCollapsed, refresh, dismiss } = model;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const guard = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const any = requests.length > 0;
  useEffect(() => {
    if (!any) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [any]);
  const resultTimer = useRef<number | null>(null);
  const show = useCallback((next: Result) => {
    setResult(next);
    if (resultTimer.current !== null) window.clearTimeout(resultTimer.current);
    resultTimer.current = window.setTimeout(() => { resultTimer.current = null; setResult(null); }, RESULT_MS);
  }, []);
  useEffect(() => () => { if (resultTimer.current !== null) window.clearTimeout(resultTimer.current); }, []);

  const front = requests[0];
  const decide = async (request: ExternalRequest, decision: "approve" | "deny") => {
    if (guard.current) return;
    const kind = kindOf(request.card);
    if (!kind) return;
    // The page's own guard first, the one Copilot's card asks: the open Doc's leave guard (unsaved drafts). A refusal
    // keeps the card. The guard may ask with a dialog and answer later; a second press meanwhile does nothing.
    if (decision === "approve" && kind.beforeApprove) {
      const verdict = kind.beforeApprove(request.card, guards);
      if (verdict === false) return;
      if (verdict !== true) {
        guard.current = true;
        let ok = false;
        try { ok = await verdict; } finally { guard.current = false; }
        if (!ok || !alive.current) return;
      }
    }
    guard.current = true; setBusy(true);
    try {
      const outcome = await decideExternalRequest(request.id, decision);
      if (!alive.current) return;
      if (outcome.state === "stale") show({ tone: "warn", title: t("externalRequests.staleTitle"), body: t("externalRequests.staleBody") });
      else if (outcome.state === "denied") show({ tone: "ok", title: t("externalRequests.deniedTitle"), body: request.card.action === "refresh_arxiv_source" ? t("externalRequests.deniedBodyRefresh") : t("externalRequests.deniedBody") });
      else {
        const answer = outcome.result as { ok?: boolean; detail?: string; docId?: string; works?: { remaining: string[] }[] } | null;
        if (answer?.ok === true) {
          // The Shell's three-state update of the open Doc, as after a delete from the Library page or Copilot's card.
          if (request.card.action === "delete_doc") onDocDeleted(request.card.object.id, answer.works?.find((work) => work.remaining.length > 0)?.remaining ?? []);
          if (request.card.action === "refresh_arxiv_source") show({ tone: "ok", title: t("externalRequests.doneTitleRefresh"), body: t("externalRequests.doneBodyRefresh") });
          else show({ tone: "ok", title: t("externalRequests.doneTitle"), body: t("externalRequests.doneBody") });
        } else show({ tone: "warn", title: request.card.action === "refresh_arxiv_source" ? t("externalRequests.notDoneTitleRefresh") : t("externalRequests.notDoneTitle"), body: answer?.detail ?? "" });
      }
    } catch {
      if (alive.current) show({ tone: "warn", title: t("externalRequests.failedTitle"), body: t("externalRequests.failedBody") });
    } finally {
      guard.current = false;
      if (alive.current) setBusy(false);
      void refresh();
    }
  };

  if (!front) return result ? <div className="external-requests-dock result" data-ui="external-requests-dock" role="region" aria-label={t("externalRequests.region")}><ResultMessage result={result} /></div> : null;
  const summary = summaryOf(t, front.card);
  if (collapsed && front.state === "pending") return <div className="external-requests-dock folded" data-ui="external-requests-dock" role="region" aria-label={t("externalRequests.region")}>
    <div className="external-request-bar" data-ui="external-requests-bar">
      <Icon name="square-terminal" />
      <span className="external-request-bar-text">{requests.length > 1 ? t("externalRequests.barMany", { summary, count: requests.length }) : t("externalRequests.barOne", { summary })}</span>
      <Button data-ui="external-requests-toggle" onClick={() => setCollapsed(false)}>{t("externalRequests.expand")}</Button>
    </div>
  </div>;
  const kind = kindOf(front.card);
  const withdrawn = front.state === "withdrawn";
  const rest = requests.slice(1);
  return <div className="external-requests-dock" data-ui="external-requests-dock" role="region" aria-label={t("externalRequests.region")}>
    <section className={withdrawn ? "external-request withdrawn" : "external-request"} data-ui="external-request" data-action={front.card.action} data-state={front.state} aria-label={t("externalRequests.source")}>
      <div className="external-request-source">
        <Icon name="square-terminal" />
        <strong>{t("externalRequests.source")}</strong>
        <span className="external-request-tag">{t("externalRequests.tag")}</span>
        <span className="external-request-grow" />
        {requests.length > 1 && <span className="external-request-pager" data-ui="external-request-pager">1 / {requests.length}</span>}
        {!withdrawn && <Button data-ui="external-requests-toggle" onClick={() => setCollapsed(true)}>{t("externalRequests.collapse")}</Button>}
      </div>
      {withdrawn
        ? <div className="external-request-message warn" role="status" data-ui="external-request-withdrawn"><Icon name="triangle-alert" /><div><strong>{t("externalRequests.withdrawnTitle")}</strong>{front.card.action === "refresh_arxiv_source" ? t("externalRequests.withdrawnBodyRefresh") : t("externalRequests.withdrawnBody")}</div></div>
        : <>
          {front.client && <div className="external-request-command" data-ui="external-request-command">{front.client.commandLine}</div>}
          <div className="external-request-wait" data-ui="external-request-wait">{t("externalRequests.wait", { time: waited(front.receivedAt, now) })}</div>
        </>}
      {kind && <div className="copilot-confirmation" data-ui="copilot-confirmation" data-action={front.card.action}>
        <kind.Body card={front.card} />
        {!withdrawn && front.card.action === "delete_doc" && openDocId === front.card.object.id && <div className="copilot-confirmation-warn" role="status" data-ui="external-request-open-doc"><Icon name="triangle-alert" />{t("externalRequests.openDoc")}</div>}
        {!withdrawn && <div className="copilot-confirmation-actions">
          <Button data-ui="external-request-deny" disabled={busy} onClick={() => void decide(front, "deny")}>{t("externalRequests.deny")}</Button>
          <Button appearance="primary" tone={kind.toneOf ? kind.toneOf(front.card) : kind.tone} data-ui="external-request-approve" disabled={busy} onClick={() => void decide(front, "approve")}>{kind.confirmLabel(t, front.card)}</Button>
        </div>}
      </div>}
      {withdrawn && <div className="external-request-foot"><Button data-ui="external-request-dismiss" onClick={() => void dismiss(front.id)}>{t("externalRequests.close")}</Button></div>}
      {rest.length > 0 && <div className="external-request-queue" data-ui="external-request-queue">
        <h4>{t("externalRequests.queue", { count: rest.length })}</h4>
        {rest.map((request, index) => <div key={request.id} className={request.state === "withdrawn" ? "external-request-queued gone" : "external-request-queued"} data-ui="external-request-queued" data-ui-key={request.id}>
          <span className="n">{index + 2}</span>
          <span className="d">{summaryOf(t, request.card)}{request.state === "withdrawn" ? ` · ${t("externalRequests.queueWithdrawn")}` : ""}</span>
          <span className="w">{waited(request.receivedAt, now)}</span>
        </div>)}
        <div className="external-request-queued note"><span className="n" /><span className="d">{t("externalRequests.queueNote")}</span></div>
      </div>}
    </section>
    {result && <ResultMessage result={result} />}
  </div>;
}

function ResultMessage({ result }: { result: Result }) {
  return <div className={`external-request-message ${result.tone}`} role="status" data-ui="external-request-result"><Icon name={result.tone === "ok" ? "circle-check" : "triangle-alert"} /><div><strong>{result.title}</strong>{result.body}</div></div>;
}
