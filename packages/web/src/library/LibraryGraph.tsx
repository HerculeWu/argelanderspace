/**
 * LibraryGraph adapter (Stage 14, D4): maps the saved-only Library citation
 * graph (`GraphData`) onto the shared GraphCanvas. Every node is a saved
 * work — filled circles, no roles, no diamonds. The module-level stash keeps
 * the layout + viewport across remounts (the old cgCache's job).
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { GraphCanvas, type CanvasNode, type GraphCanvasStash } from "../graph/GraphCanvas";
import type { GraphData } from "./types";

/** Survives view-switch remounts (recomputed cheaply when the set changes). */
const libraryStash: GraphCanvasStash = { layout: null, view: null };

function shortLabel(a: string, y: number): string {
  return `${a.replace(/ et al\.| \+|\+$/, "+").split(" ")[0]!.replace(/,$/, "")} ’${("" + y).slice(2)}`;
}

export function LibraryGraph({
  graph,
  selId,
  onSel,
  query,
}: {
  graph: GraphData;
  selId: string | null;
  onSel: (id: string | null) => void;
  query: string;
}) {
  const { t } = useTranslation();
  const nodes: CanvasNode[] = useMemo(
    () =>
      graph.nodes.map((n) => ({
        id: n.id,
        title: n.t,
        label: shortLabel(n.a, n.y),
        year: n.y,
        citations: n.c,
        filled: true, // saved-only Library graph (Stage 14)
        diamond: false,
        seed: false,
        venue: n.v || null,
        roleTag: null,
      })),
    [graph]
  );
  // the layout re-seeds only when the node set itself changes
  const layoutKey = useMemo(
    () => "library:" + graph.nodes.map((n) => `${n.id}:${n.c}`).join(","),
    [graph]
  );
  return (
    <GraphCanvas
      nodes={nodes}
      edges={graph.links}
      selectedId={selId}
      onSelect={onSel}
      query={query}
      stash={libraryStash}
      layoutKey={layoutKey}
      heading={t("library.graph.heading")}
      note={t("library.graph.note")}
    />
  );
}
