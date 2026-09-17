/**
 * DiscoveryGraph adapter (Stage 14, D4): maps a `DiscoveryGraph` payload onto
 * the shared GraphCanvas. Domain rules live here and only here: the seed is
 * the pinned ringed origin, Related candidates are circles, Useful candidates
 * are diamonds, in-library nodes are filled. Position is NOT a similarity
 * score; the only edges are real citations.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { DiscoveryGraph } from "@argelanderspace/contracts";
import { GraphCanvas, type CanvasNode, type GraphCanvasStash } from "../graph/GraphCanvas";

function shortLabel(p: { authors: string[]; year: number | null }): string {
  const first = p.authors[0] ?? "?";
  // ADS author display form is "Family, G. N." — the label keeps the family name
  const family = first.split(",")[0]?.trim() || first;
  const collab = /collaboration/i.test(family) ? family.split(" ")[0]! : family;
  return `${collab} ’${p.year !== null ? String(p.year).slice(2) : "??"}`;
}

export function DiscoveryGraphView({
  graph,
  stash,
  layoutKey,
  selectedId,
  onSelect,
  query,
  addingId,
}: {
  graph: DiscoveryGraph;
  stash: GraphCanvasStash;
  layoutKey: string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  query: string;
  addingId: string | null;
}) {
  const { t } = useTranslation();
  const nodes: CanvasNode[] = useMemo(
    () =>
      graph.nodes.map((n) => ({
        id: n.bibcode,
        title: n.title,
        label: shortLabel(n),
        year: n.year,
        citations: n.citationCount ?? 0,
        filled: n.libraryId !== null,
        diamond: n.roles.includes("useful") && !n.roles.includes("seed"),
        seed: n.roles.includes("seed"),
        venue: n.venue,
        roleTag: n.roles.includes("seed")
          ? "ORIGIN"
          : n.roles.includes("useful")
            ? "USEFUL"
            : "RELATED",
      })),
    [graph]
  );
  const edges = useMemo(
    () => graph.edges.map((e): [string, string] => [e.from, e.to]),
    [graph]
  );
  return (
    <GraphCanvas
      nodes={nodes}
      edges={edges}
      seedId={graph.seed}
      selectedId={selectedId}
      onSelect={onSelect}
      query={query}
      stash={stash}
      layoutKey={layoutKey}
      addingId={addingId}
      heading={t("explore.graph.heading")}
      note={t("explore.graph.note")}
      usefulLegend
      isolatedNote
    />
  );
}
