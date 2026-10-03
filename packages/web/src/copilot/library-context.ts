import {
  type LibraryDetailTab,
  type LibraryPage,
  libraryLinksAmong,
  libraryRefBibtex,
  libraryRefMatches,
  summarizeLibraryRef,
} from "@argelanderspace/contracts";
import type { LibraryData } from "../library/types";

/**
 * What the Library page shows right now, built from the data and the view state (never from mounted rows):
 * the whole filtered list, the open work in full, and the display-only colour dots. The rest of the library
 * is a count. Pure, so the same input always gives the same page.
 */
export function captureLibraryPage(input: {
  data: LibraryData;
  live: boolean;
  failure?: { kind: "unreachable" | "error"; reason: string };
  graphLabelsOn?: boolean;
  query: string;
  selectedNodeId: string | null;
  tab: LibraryDetailTab;
  labels: Record<string, string | null>;
  sidebarCollapsed: boolean;
}): LibraryPage {
  const { data, query } = input;
  const matched = data.refs.filter((ref) => libraryRefMatches(ref, query));
  const node = input.selectedNodeId ? data.graph.nodes.find((n) => n.id === input.selectedNodeId) : undefined;
  const open = node?.ref ? data.refs.find((ref) => ref.id === node.ref) : undefined;
  const temporaryLabels: LibraryPage["temporaryLabels"] = {};
  for (const [id, label] of Object.entries(input.labels))
    if (label === null || (["red", "amber", "green", "blue", "violet"] as string[]).includes(label))
      temporaryLabels[id] = label as LibraryPage["temporaryLabels"][string];
  return {
    source: input.live ? "live" : input.failure?.kind === "error" ? "error" : "demo",
    ...(!input.live && input.failure?.kind === "error" ? { error: input.failure.reason } : {}),
    query,
    total: data.refs.length,
    matched: matched.length,
    refs: matched.map(summarizeLibraryRef),
    links: libraryLinksAmong(data.graph, new Set(matched.map((ref) => ref.id))),
    selectedRefId: open?.id ?? null,
    detail: open ? { ref: open, bibtex: libraryRefBibtex(open), tab: input.tab } : null,
    temporaryLabels,
    sidebarCollapsed: input.sidebarCollapsed,
    graph: { labelsOn: input.graphLabelsOn ?? false },
  };
}
