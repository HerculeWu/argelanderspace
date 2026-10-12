/** The audit badge of the header and its list (ticket 04): the count of findings or "audit passed"; a click opens the list. */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { ActionButton } from "../ui";
import type { Finding } from "./findings";
import type { DescribeFinding } from "./useFindingText";

export function ArgumentAudit({ findings, describe, onSelect }: { findings: readonly Finding[]; describe: DescribeFinding; onSelect: (id: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  // an outside click or Escape closes the list; the badge itself toggles it
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  // a list that is no longer there (the graph changed under it) must not stay open
  useEffect(() => {
    if (findings.length === 0) setOpen(false);
  }, [findings.length]);

  const label = findings.length ? t("argument.view.audit.count", { n: findings.length }) : t("argument.view.audit.none");
  return (
    <span className="ag-chip-anchor" ref={root}>
      <ActionButton
        unstyled
        mode="text"
        className={`ag-audit-chip ${findings.length ? "warn" : "ok"}`}
        data-ui="argument-audit-summary"
        data-state={findings.length ? "findings" : "passed"}
        label={label}
        aria-expanded={findings.length ? open : undefined}
        aria-haspopup={findings.length ? "true" : undefined}
        onClick={() => findings.length && setOpen((o) => !o)}
      >
        <Icon name={findings.length ? "triangle-alert" : "check"} cls="ico-sm" />
        {label}
      </ActionButton>
      {open && findings.length > 0 && (
        <div className="ag-audit-pop" data-ui="argument-audit-popover" role="group" aria-label={t("argument.view.audit.listLabel")}>
          <div className="ag-audit-list" data-ui="argument-audit-list">
            {findings.map((f, i) => (
              <button
                key={i}
                type="button"
                className={`ag-audit-row kind-${f.kind}`}
                data-ui="argument-audit-finding"
                data-ui-key={f.kind}
                disabled={f.ids.length === 0}
                onClick={() => f.ids[0] && onSelect(f.ids[0])}
              >
                <Icon name={f.kind === "cycle" ? "refresh-cw" : "triangle-alert"} cls="ico-sm" />
                <span>{describe(f)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}
