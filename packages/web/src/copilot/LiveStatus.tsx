import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CopilotLive } from "@argelanderspace/contracts";

/** Shown only once a run is long enough that "is it alive?" becomes a question. */
const ELAPSED_FROM_MS = 10_000;

export const formatElapsed = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), seconds = total % 60;
  const two = (value: number) => String(value).padStart(2, "0");
  return hours ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`;
};

/**
 * What the run does right now (public status: the operation under way, the reply being written, or thinking), plus a
 * small elapsed-time counter that keeps ticking between events. Without a live state (an older service, or a run
 * that has not reported yet) it says only that a reply is coming, as before; while stopping it says that.
 */
export function LiveRunStatus({ live, stopping, actionLabel }: { live: CopilotLive | null; stopping: boolean; actionLabel: (operation: { tool: string; action?: string }) => string }) {
  const { t } = useTranslation();
  const received = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { received.current = Date.now(); setNow(received.current); }, [live?.elapsedMs]);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live === null]);
  if (stopping) return <span role="status" data-ui="copilot-live-status" data-phase="stopping">{t("copilot.stopping")}</span>;
  if (!live) return <span role="status" data-ui="copilot-live-status" data-phase="working">{t("copilot.running")}</span>;
  const text = live.phase === "operation" && live.operation
    ? t(live.operation.page ? "copilot.live.operationPage" : "copilot.live.operation", { action: actionLabel(live.operation), page: live.operation.page })
    : live.phase === "operation" ? t("copilot.live.working") : t(`copilot.live.${live.phase}`);
  const elapsed = live.elapsedMs + Math.max(0, now - received.current);
  return <>
    <span role="status" data-ui="copilot-live-status" data-phase={live.phase}>{text}</span>
    {elapsed >= ELAPSED_FROM_MS && <span className="copilot-elapsed" role="timer" data-ui="copilot-elapsed">{t("copilot.live.elapsed", { time: formatElapsed(elapsed) })}</span>}
  </>;
}

/**
 * The reasoning summary a provider exposed for a reply: collapsible, muted, plain text (never rendered as markup, never
 * sent back to the model). Open while it is still arriving; the saved reply shows it collapsed.
 */
export function ThinkingBlock({ text, live = false }: { text: string; live?: boolean }) {
  const { t } = useTranslation();
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { if (live && body.current) body.current.scrollTop = body.current.scrollHeight; }, [text, live]);
  return <details className="copilot-reasoning" data-ui="copilot-reasoning" data-live={live ? "true" : undefined} open={live}>
    <summary>{t(live ? "copilot.live.thinkingLive" : "copilot.live.thinkingTitle")}</summary>
    <div ref={body} className="copilot-reasoning-body" data-ui="copilot-reasoning-body">{text}</div>
  </details>;
}
