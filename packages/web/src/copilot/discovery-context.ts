import {
  type DiscoveryFilter,
  type DiscoveryGraph,
  DISCOVERY_HISTORY_LIMIT,
  type DiscoveryPage,
  discoveryVisibleNodes,
} from "@argelanderspace/contracts";

/**
 * What the exploration page shows right now, built from the session graph and the view state (never from mounted
 * rows): the nodes the filter and search leave visible, the real citation edges among them, the open candidate in
 * full, the history and the loading/error/saving state. Pure, so the same input always gives the same page.
 */
export function captureDiscoveryPage(input: {
  graph: DiscoveryGraph | null;
  seeds: string[];
  index: number;
  loading: { seed: string } | null;
  error: { seed: string; status: number } | null;
  adding: string | null;
  addFailed: string | null;
  selection: string | null;
  query: string;
  filter: DiscoveryFilter;
  display: "graph" | "list";
  detailTab: "abstract" | "citations";
  labelsOn: boolean;
}): DiscoveryPage {
  const { graph } = input;
  const visible = graph ? discoveryVisibleNodes(graph.nodes, input.query, input.filter) : [];
  const ids = new Set(visible.map((node) => node.bibcode));
  const selected = graph?.nodes.find((node) => node.bibcode === input.selection) ?? null;
  const known = new Set(graph?.nodes.map((node) => node.bibcode) ?? []);
  // the report holds the newest seeds only (the schema's limit); the index stays pointing at the same entry
  const dropped = Math.max(0, input.seeds.length - DISCOVERY_HISTORY_LIMIT);
  return {
    history: { index: input.index < 0 ? -1 : Math.max(0, input.index - dropped), seeds: input.seeds.slice(dropped) },
    graph: graph
      ? {
          provider: graph.provider,
          seed: graph.seed,
          filter: input.filter,
          query: input.query,
          // the abstract is shown (and sent) only for the open candidate, like the page
          nodes: visible.map(({ abstract: _abstract, ...node }) => node),
          edges: graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
          totals: {
            nodes: graph.nodes.length,
            related: graph.nodes.filter((node) => node.roles.includes("related")).length,
            useful: graph.nodes.filter((node) => node.roles.includes("useful")).length,
            saved: graph.nodes.filter((node) => node.libraryId !== null).length,
          },
          warnings: graph.warnings,
          empty: graph.nodes.length <= 1,
        }
      : null,
    display: input.display,
    selectedBibcode: selected?.bibcode ?? null,
    detail: selected
      ? {
          paper: selected,
          tab: input.detailTab,
          references: (graph?.edges ?? []).filter((edge) => edge.from === selected.bibcode && known.has(edge.to)).map((edge) => edge.to),
          citedBy: (graph?.edges ?? []).filter((edge) => edge.to === selected.bibcode && known.has(edge.from)).map((edge) => edge.from),
        }
      : null,
    loading: input.loading,
    error: input.error,
    saving: { adding: input.adding, failed: input.addFailed },
    graphView: { labelsOn: input.labelsOn },
  };
}
