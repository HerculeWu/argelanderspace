import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CopilotCompaction } from "@argelanderspace/contracts";
import { ActionButton, Badge, getConfiguredIcon } from "../ui";
import { copilotMarkdown } from "./markdown";

/** `2026-10-28 14:32` in the viewer's local time; a time that does not parse is shown as it came. */
export function compactionTime(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/**
 * Where the model's view of the conversation begins to be the written messages again (release-0.2 ticket 11, prototype
 * 10): a rule with a chip that opens the read-only summary. The history above it is unchanged and fully shown.
 */
export function CompactionMarker({ compaction, open, onToggle }: { compaction: CopilotCompaction; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const summaryId = `copilot-compaction-summary-${compaction.id}`;
  const detail = `${t("copilot.compaction.count", { count: compaction.count })} · ${t(compaction.origin === "auto" ? "copilot.compaction.auto" : "copilot.compaction.manual")}`;
  return <div className="cmp-marker" data-ui="copilot-compaction-marker" data-ui-key={compaction.id}>
    <div className="cmp-rule">
      <ActionButton unstyled mode="text" label={`${t("copilot.compaction.marker")} · ${detail}`} data-ui="copilot-compaction-toggle" data-ui-key={compaction.id} className="cmp-chip" aria-expanded={open} aria-controls={summaryId} onClick={onToggle}>
        <span className="cmp-chevron" aria-hidden="true">{getConfiguredIcon("chevron-right", "copilot-compaction-toggle")}</span>
        <span className="cmp-lead">{t("copilot.compaction.marker")}</span>
        <span>· {detail}</span>
      </ActionButton>
    </div>
    {open && <div className="cmp-summary" id={summaryId} role="region" aria-label={t("copilot.compaction.summaryLabel")} data-ui="copilot-compaction-summary" data-ui-key={compaction.id}>
      <div className="cmp-meta">
        <Badge>{t("copilot.compaction.summaryLabel")}</Badge>
        {compaction.model && <span>{t("copilot.compaction.generatedBy", { model: compaction.model })}</span>}
        <span>{compactionTime(compaction.at)}</span>
        {compaction.includesPrevious && <span>{t("copilot.compaction.includesPrevious")}</span>}
      </div>
      <div className="copilot-markdown" dangerouslySetInnerHTML={{ __html: copilotMarkdown(compaction.summary) }} />
      <p className="cmp-note">{t("copilot.compaction.summaryNote")}</p>
    </div>}
  </div>;
}

/** A compaction under way: the conversation cannot be written to until it ends; Stop (the composer's button) gives it up. */
export function CompactionRunning({ origin, startedAt }: { origin: "manual" | "auto"; startedAt: number }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const auto = origin === "auto";
  return <div className="cmp-working" data-ui="copilot-compaction-running" data-origin={origin} role="status">
    <div className="cmp-rule">
      <span className="cmp-chip">
        <span className="copilot-pulse" aria-hidden="true" />
        {t(auto ? "copilot.compaction.runningAuto" : "copilot.compaction.running")}
        <span className="copilot-elapsed">{Math.max(0, Math.floor((now - startedAt) / 1000))}s</span>
      </span>
    </div>
    <p className="cmp-sub">{t(auto ? "copilot.compaction.runningAutoNote" : "copilot.compaction.runningNote")}</p>
  </div>;
}

/**
 * The conversation menu of the panel's header: for now one entry, "compact context". An entry that cannot be used stays
 * visible, grey, and says why (a reply is running, the conversation is still short, a compaction is under way).
 */
export function SessionMenu({ blocked, onCompact }: { blocked: "busy" | "running" | "short" | null; onCompact: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const close = () => setOpen(false);
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    window.addEventListener("click", close);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("click", close); window.removeEventListener("keydown", key); };
  }, [open]);
  const reason = blocked === "busy" ? t("copilot.compaction.menuBusy") : blocked === "running" ? t("copilot.compaction.menuRunning") : blocked === "short" ? t("copilot.compaction.menuShort") : null;
  return <div className="copilot-session-wrap" onClick={(event) => event.stopPropagation()}>
    <ActionButton ref={trigger} unstyled mode="icon" iconName="more" label={t("copilot.compaction.menu")} data-ui="copilot-session-menu-button" className="btn icon ghost" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)} />
    {open && <div className="pane-tool-menu copilot-session-menu" role="menu" aria-label={t("copilot.compaction.menu")} data-ui="copilot-session-menu">
      <ActionButton ref={first} unstyled mode="text" label={t("copilot.compaction.compact")} data-ui="copilot-compact" className="pane-tool-opt" role="menuitem" aria-disabled={blocked ? true : undefined} onClick={() => { if (blocked) return; setOpen(false); onCompact(); }}>
        <span className="copilot-session-icon" aria-hidden="true">{getConfiguredIcon("fold", "copilot-compact")}</span>
        <span>{t("copilot.compaction.compact")}{reason && <small>{reason}</small>}</span>
      </ActionButton>
    </div>}
  </div>;
}
