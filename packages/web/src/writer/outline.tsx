/**
 * Stage 10 Writer — left outline panel (prototype renderOutline): structure
 * groups derived from the cells, a filter box, jump-to-cell, and mini
 * insert-label buttons that auto-complete a missing \label first.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { ActionButton } from "../ui";
import type { WriterCell, WriterNumberingResponse } from "@argelanderspace/contracts";
import { writerCrossrefs, type CrossrefTarget } from "./model";

const GROUPS = [
  { kind: "section", labelKey: "writer.outline.sections" },
  { kind: "equation", labelKey: "writer.outline.equations" },
  { kind: "figure", labelKey: "writer.outline.figures" },
  { kind: "table", labelKey: "writer.outline.tables" },
  { kind: "code", labelKey: "writer.outline.code" },
] as const satisfies readonly { kind: CrossrefTarget["kind"]; labelKey: string }[];

export function OutlinePanel({
  cells,
  numbering,
  onJump,
  onInsertLabel,
}: {
  cells: WriterCell[];
  /** Compile-truth numbering; missing facts display unresolved placeholders. */
  numbering?: WriterNumberingResponse | null;
  onJump: (cellId: string) => void;
  onInsertLabel: (targetCell: string, label: string, envIndex?: number, sectionIndex?: number) => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const targets = writerCrossrefs(cells, numbering);
  const needle = q.trim().toLowerCase();
  const visible = (x: CrossrefTarget) =>
    !needle || `${x.title} ${x.label}`.toLowerCase().includes(needle);

  return (
    <div className="w-panel-body" data-ui="writer-outline">
      <div className="w-panel-title">
        {t("writer.outline.title")}
        {numbering?.status === "stale" && (
          <span className="w-stale" title={numbering.lastError ?? undefined}>
            {t("writer.numbering.stale")}
          </span>
        )}
      </div>
      <div className="w-search" data-ui="search-writer-outline">
        <Icon name="search" cls="ico-sm" />
        <input data-ui="writer-outline-query"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("writer.outline.filter")}
        />
      </div>
      {GROUPS.map(({ kind, labelKey }) => {
        const rows = targets.filter((x) => x.kind === kind);
        if (!rows.length) return null;
        return (
          <div className="w-outline-group" key={kind}>
            <div className="w-outline-group-head">{t(labelKey)}</div>
            {rows.map((x) => (
              <div
                className="w-outline-row" data-ui="outline-cell" data-ui-key={`${x.cell}:${x.targetId ?? `${x.kind}-${x.sectionIndex ?? x.envIndex ?? 0}`}`}
                key={`${x.cell}-${x.targetId ?? `${x.kind}-${x.sectionIndex ?? x.envIndex ?? 0}`}`}
                style={visible(x) ? undefined : { display: "none" }}
              >
                <ActionButton unstyled mode="text" className="w-jump" data-ui="jump-to-cell"
                  label={t("writer.outline.jumpTo", { title: x.title })} tooltip={t("writer.outline.jumpTo", { title: x.title })}
                  onClick={() => onJump(x.cell)}>
                  <span className="w-num">{x.number}</span> {x.title}
                </ActionButton>
                <ActionButton
                  unstyled
                  mode="text" className="w-insert-mini"
                  label={t(x.insertable === false ? "writer.xref.needsLabel" : "writer.outline.insertLabel")}
                  tooltip={t(x.insertable === false ? "writer.xref.needsLabel" : "writer.outline.insertLabel")}
                  data-ui="insert-cell-label"
                  data-insert-label={x.label}
                  data-target-cell={x.cell}
                  disabled={x.insertable === false}
                  onClick={() => onInsertLabel(x.cell, x.label, x.envIndex, x.sectionIndex)}
                >
                  {x.label}
                </ActionButton>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
