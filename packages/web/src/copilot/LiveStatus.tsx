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
  // The elapsed anchor is derived while rendering (never one frame behind): a new server reading re-bases the counter.
  const [anchor, setAnchor] = useState({ key: live?.elapsedMs, ms: live?.elapsedMs ?? 0, at: Date.now() });
  if (live && anchor.key !== live.elapsedMs) setAnchor({ key: live.elapsedMs, ms: live.elapsedMs, at: Date.now() });
  const [now, setNow] = useState(() => Date.now());
  const active = live !== null;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  // A tool call whose action is not parsed yet has no name worth announcing: say only that it works.
  const target = live
    ? live.phase === "operation" && live.operation?.action
      ? { phase: live.phase, text: t(live.operation.page ? "copilot.live.operationPage" : "copilot.live.operation", { action: actionLabel(live.operation), page: live.operation.page }) }
      : { phase: live.phase === "operation" ? "working" : live.phase, text: t(live.phase === "operation" ? "copilot.live.working" : `copilot.live.${live.phase}`) }
    : { phase: "working", text: t("copilot.running") };
  // What is announced changes at most every 300 ms, so quick phase flips do not chatter in a screen reader.
  const [shown, setShown] = useState(target);
  useEffect(() => {
    if (shown.text === target.text && shown.phase === target.phase) return;
    const timer = setTimeout(() => setShown(target), 300);
    return () => clearTimeout(timer);
  }, [target.text, target.phase, shown.text, shown.phase]);
  if (stopping) return <span data-ui="copilot-live-status" data-phase="stopping">{t("copilot.stopping")}</span>;
  const elapsed = (live ? anchor.ms : 0) + Math.max(0, now - anchor.at);
  return <>
    <span data-ui="copilot-live-status" data-phase={shown.phase}>{shown.text}</span>
    {live && elapsed >= ELAPSED_FROM_MS && <span className="copilot-elapsed" aria-hidden="true" data-ui="copilot-elapsed">{t("copilot.live.elapsed", { time: formatElapsed(elapsed) })}</span>}
  </>;
}

/**
 * The reasoning text a provider exposed for a reply (a summary for OpenAI/Codex): collapsible, muted, plain text (never rendered as markup, never
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
