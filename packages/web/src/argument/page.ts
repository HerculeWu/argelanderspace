/**
 * What the argument graph view tells the Copilot (ADR 0005, ticket 04): the Work, the whole graph as it was read, and
 * the selected argument. The audit is not carried: it is derived from the graph (`auditArgumentGraph`).
 *
 * The shape lives here, in the web package, because the shared PageContext (contracts `copilot.ts`) has no field for it
 * yet: the pane adapter keeps the page, but the Library pane still publishes `unavailable` while this view is open
 * (library-pane.ts). Moving the shape into the contract is the Copilot ticket's (09) first step.
 */
import type { ArgumentGraph } from "@argelanderspace/contracts";

export interface ArgumentPage {
  version: 1;
  work: { id: string; title: string };
  /** How the read of the graph stands; `ready` is the only phase that carries a graph. */
  phase: "loading" | "ready" | "not-found" | "corrupt" | "error";
  graph: ArgumentGraph | null;
  /** The argument the panel shows, if any (it always exists in `graph`). */
  selectedId: string | null;
}

export function captureArgumentPage(input: { workId: string; title: string; graph: ArgumentGraph | null; phase: ArgumentPage["phase"]; selectedId: string | null }): ArgumentPage {
  const selectedId = input.graph?.arguments.some((a) => a.id === input.selectedId) ? input.selectedId : null;
  return { version: 1, work: { id: input.workId, title: input.title }, phase: input.phase, graph: input.graph, selectedId };
}
