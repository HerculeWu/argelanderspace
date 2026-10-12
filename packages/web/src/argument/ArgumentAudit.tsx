/** The audit badge of the header and its list (ticket 04): the count of findings or "audit passed"; a click opens the list. */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { ActionButton, Badge } from "../ui";
import { type Finding, findingKey } from "./findings";
import type { DescribeFinding } from "./useFindingText";

export function ArgumentAudit({ findings, describe, onSelect }: { findings: readonly Finding[]; describe: DescribeFinding; onSelect: (id: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  // an outside click or Escape closes the list; the badge itself toggles it
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        // the list had the focus (or the badge did): keep the keyboard where it started
        chip.current?.focus();
      }
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
  // a clean audit has nothing to open: a plain badge, not a button that does nothing
  if (findings.length === 0)
    return (
      <span className="ag-audit-ok" data-ui="argument-audit-summary" data-state="passed">
        <Badge>
          <Icon name="check" cls="ico-sm" />
          {label}
        </Badge>
      </span>
    );
  return (
    <span className="ag-chip-anchor" ref={root}>
      <ActionButton
        ref={chip}
        unstyled
        mode="text"
        className="ag-audit-chip warn"
        data-ui="argument-audit-summary"
        data-state="findings"
        label={label}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="triangle-alert" cls="ico-sm" />
        {label}
      </ActionButton>
      {open && (
        <div className="ag-audit-pop" data-ui="argument-audit-popover" role="group" aria-label={t("argument.view.audit.listLabel")}>
          <div className="ag-audit-list" data-ui="argument-audit-list">
            {findings.map((f, i) => (
              <button
                key={i}
                type="button"
                className={`ag-audit-row kind-${f.kind}`}
                data-ui="argument-audit-finding"
                data-ui-key={findingKey(f)}
                disabled={f.ids.length === 0}
                onClick={() => {
                  if (!f.ids[0]) return;
                  onSelect(f.ids[0]);
                  // the panel this opens must not stay under the list
                  setOpen(false);
                }}
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
