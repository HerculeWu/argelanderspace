/** The left column of the argument graph view (ticket 04): the outline by conclusion. Rows come from `buildOutline`. */
import type { ArgumentAudit, ArgumentGraph, ArgumentKind } from "@argelanderspace/contracts";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ActionButton } from "../ui";
import { auditCounts } from "./canvasModel";
import { buildOutline, type OutlineRow } from "./outline";
import { ROLE_NAME } from "./ArgumentPanel";
import { Icon } from "../lib/icons";

export type OutlineOpenState = ReadonlyMap<string, boolean>;

export function ArgumentOutline({
  graph,
  audit,
  selectedId,
  onSelect,
  openState,
  setOpenState,
}: {
  graph: ArgumentGraph;
  audit: ArgumentAudit;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Only what the user toggled; the rest follows the default depth. Held by the caller so a folded outline keeps it. */
  openState: OutlineOpenState;
  setOpenState: (update: (m: OutlineOpenState) => OutlineOpenState) => void;
}) {
  const { t } = useTranslation();
  const outline = useMemo(() => buildOutline(graph, audit, openState), [graph, audit, openState]);
  const flagged = useMemo(() => auditCounts(audit), [audit]);
  const byId = useMemo(() => new Map(graph.arguments.map((a) => [a.id, a])), [graph]);

  const row = (r: OutlineRow) => {
    const a = byId.get(r.id);
    if (!a) return null;
    const title = a.title || t("argument.view.panel.untitled");
    return (
      <div key={r.key} className={`ag-out-row${r.id === selectedId ? " sel" : ""}`} style={{ paddingLeft: 8 + r.depth * 14 }} data-ui="argument-outline-item" data-ui-key={r.id}>
        {r.expandable ? (
          <ActionButton
            unstyled
            mode="icon"
            iconName={r.open ? "chevron-down" : "chevron-right"}
            className="ag-out-tw"
            data-ui="toggle-argument-outline-node"
            aria-expanded={r.open}
            label={t(r.open ? "argument.view.outline.collapse" : "argument.view.outline.expand", { title })}
            tooltip={t(r.open ? "argument.view.outline.collapse" : "argument.view.outline.expand", { title })}
            onClick={() => setOpenState((m) => new Map(m).set(r.key, !r.open))}
          />
        ) : (
          <span className="ag-out-tw" />
        )}
        <button type="button" className="ag-out-title" data-ui="argument-outline-row" data-ui-key={r.id} aria-current={r.id === selectedId ? "true" : undefined} onClick={() => onSelect(r.id)}>
          {r.role && <span className={`ag-role-chip role-${r.role}`}>{ROLE_NAME[r.role]}</span>}
          <span className={`ag-kind-dot kind-${a.kind}`} aria-hidden="true" />
          <KindText kind={a.kind} />
          <span className="ag-out-text" title={title}>{title}</span>
          {r.cycle && (
            <span className="ag-out-loop" data-ui="argument-outline-cycle">
              <Icon name="refresh-cw" cls="ico-sm" />
              {t("argument.view.outline.cycle")}
            </span>
          )}
          {!r.cycle && flagged.has(r.id) && (
            <span className="ag-leg-mark" role="img" aria-label={t("argument.view.outline.flagged")} data-ui="argument-outline-flag">
              !
            </span>
          )}
        </button>
      </div>
    );
  };

  return (
    <div className="ag-outline" data-ui="argument-outline" role="group" aria-label={t("argument.view.outline.label")}>
      {outline.noEnd && (
        <div className="ag-hint pad" data-ui="argument-outline-no-end">
          {t("argument.view.outline.noEnd")}
        </div>
      )}
      {outline.ends.map(row)}
      {outline.orphans.length > 0 && (
        <>
          <div className="ag-out-group" data-ui="argument-outline-orphans">
            {t("argument.view.outline.orphans")}
          </div>
          {outline.orphans.map(row)}
        </>
      )}
    </div>
  );
}

/** The kind said in words for assistive technology only; the dot carries it visually. */
function KindText({ kind }: { kind: ArgumentKind }) {
  const { t } = useTranslation();
  return <span className="visually-hidden">{t(kind === "native" ? "argument.view.kind.native" : kind === "end" ? "argument.view.kind.end" : "argument.view.kind.normal")}</span>;
}
