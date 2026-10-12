/**
 * Argument graph adapter (ticket 03): maps a Work's argument graph (contracts
 * types) and its audit onto the shared layered canvas. Everything about what an
 * argument is lives here: kind colours, role colours and line styles, the audit
 * mark, tooltip content and the bilingual legend. The canvas itself does not
 * know the word "argument".
 */

import type { ArgumentEdgeRole, ArgumentGraph, ArgumentKind } from "@argelanderspace/contracts";
import { auditArgumentGraph } from "@argelanderspace/contracts";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { LayeredGraphCanvas, type LayeredCanvasStash } from "../graph/LayeredGraphCanvas";
import { mdWithMath } from "../lib/mdWithMath";
import { ARGUMENT_ROLES, ROLE_COLOR, auditCounts, buildArgumentCanvas } from "./canvasModel";

export type { LayeredCanvasStash as ArgumentCanvasStash };

export interface ArgumentGraphCanvasProps {
  graph: ArgumentGraph;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Per-scene persistence bag (dragged positions + viewport). */
  stash: LayeredCanvasStash;
  /** Identity of the scene (the Work). */
  sceneKey: string;
  /** Drag from the selected argument's handle onto another: the role choice and the write belong to the caller. */
  onConnect?: (from: string, to: string, at: { x: number; y: number }) => void;
  /** Edge ids whose role text stays on while not highlighted. */
  labelledEdges?: ReadonlySet<string>;
  /** Pixels at the right that a floating panel covers (the narrow-pane layout). */
  coverRight?: number;
}

export function ArgumentGraphCanvas({ graph, selectedId, onSelect, stash, sceneKey, onConnect, labelledEdges, coverRight }: ArgumentGraphCanvasProps) {
  const { t } = useTranslation();
  const audit = useMemo(() => auditArgumentGraph(graph), [graph]);
  const roleName = (role: ArgumentEdgeRole) => t(`argument.canvas.role${role[0]!.toUpperCase()}${role.slice(1)}` as "argument.canvas.roleGrounds");
  const kindName = (kind: ArgumentKind) =>
    kind === "native" ? t("argument.canvas.kindNative") : kind === "end" ? t("argument.canvas.kindEnd") : t("argument.canvas.kindNormal");
  const auditMark = t("argument.canvas.legendAudit");
  const { nodes, edges } = useMemo(
    () => buildArgumentCanvas(graph, audit, { roleName, kindName, auditMark }, labelledEdges),
    [graph, audit, labelledEdges, t]
  );
  const counts = useMemo(() => auditCounts(audit), [audit]);
  const byId = useMemo(() => new Map(graph.arguments.map((a) => [a.id, a])), [graph]);

  const legend = (
    <>
      <div className="cg-leg-row">
        <span className="lg-leg-node ag-leg-native" />
        <span className="cg-leg-note">{kindName("native")}</span>
        <span className="lg-leg-node ag-leg-normal" />
        <span className="cg-leg-note">{kindName("normal")}</span>
        <span className="lg-leg-node lg-leg-ring ag-leg-end" />
        <span className="cg-leg-note">{kindName("end")}</span>
      </div>
      <div className="cg-leg-row">
        {ARGUMENT_ROLES.map((r) => (
          <span key={r} className="lg-leg-edge">
            <svg width="22" height="8" aria-hidden="true">
              <line x1="0" y1="4" x2="22" y2="4" className={`cg-edge lg-edge${r === "backing" ? " lg-edge-dashed" : r === "rebuttal" ? " lg-edge-dotted" : ""}`} style={{ stroke: ROLE_COLOR[r] }} />
            </svg>
            <span className="cg-leg-note">{roleName(r)}</span>
          </span>
        ))}
      </div>
      <div className="cg-leg-row">
        <span className="lg-leg-edge">
          <svg width="22" height="8" aria-hidden="true">
            <line x1="0" y1="4" x2="22" y2="4" className="cg-edge lg-edge" style={{ stroke: "var(--danger)", strokeWidth: 1.8 }} />
          </svg>
          <span className="cg-leg-note">{t("argument.canvas.legendCycle")}</span>
        </span>
        <span className="ag-leg-mark">!</span>
        <span className="cg-leg-note">{auditMark}</span>
      </div>
    </>
  );

  return (
    <LayeredGraphCanvas
      nodes={nodes}
      edges={edges}
      selectedId={selectedId}
      onSelect={onSelect}
      stash={stash}
      sceneKey={sceneKey}
      ui="argument"
      heading={t("argument.canvas.heading")}
      note={t("argument.canvas.note")}
      legend={legend}
      connectHint={t("argument.canvas.connectHint")}
      onConnect={onConnect}
      coverRight={coverRight}
      renderTooltip={(id) => {
        const a = byId.get(id);
        if (!a) return null;
        const n = counts.get(id) ?? 0;
        return (
          <>
            <strong>{a.title}</strong>
            {a.claim.trim() ? (
              <div className="lg-tip-body plan-md-body" dangerouslySetInnerHTML={{ __html: mdWithMath(a.claim, { safe: true }) }} />
            ) : (
              <div className="lg-tip-body">{t("argument.canvas.notFilled")}</div>
            )}
            <div className="role">
              {kindName(a.kind)}
              {n > 0 && <span className="ag-tip-audit">{` · ! ${n}`}</span>}
            </div>
          </>
        );
      }}
    />
  );
}
