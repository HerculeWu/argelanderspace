/**
 * The Library page as a pane adapter (copilot ticket 37), Discovery included: while the pane explores, its
 * exploration page replaces the Library page for the Copilot. Only live data is complete (example data, a Library
 * still loading and a failed load are not). An exploration control acts only on the active pane while it explores
 * (`active-only`): it never opens a Library page or switches pane; every other Library action, and the two that
 * enter an exploration, open or use a Library page. The argument graph view (ticket 04) replaces the page the same way: while
 * it is open the pane publishes its `ArgumentPage` (and no Library page); the graph really loaded (ready or empty) is complete,
 * a failed read is `error`, a read still going `unavailable`. The Library page's own actions answer `unavailable` meanwhile.
 */
import { type ArgumentViewAction, ArgumentViewActionSchema, type CopilotViewAction, type DiscoveryPage, type DiscoverySavedViewAction, discoveryActionNeedsExploration, type LibraryPage, isArgumentViewAction, LibraryViewActionSchema, type LibraryViewAction } from "@argelanderspace/contracts";
import type { ArgumentPage } from "../argument/page";
import { type PaneAdapter, registered, reported, unavailable } from "../argelander/panes";
import type { LibraryViewController } from "./LibraryView";

export function createLibraryPane(notify: () => void) {
  const library = reported<LibraryPage>(notify);
  const discovery = reported<DiscoveryPage>(notify);
  // The argument graph view (ticket 04): published as the pane's page while it is open.
  const argument = reported<ArgumentPage>(notify);
  const controller = registered<LibraryViewController>();
  const adapter: PaneAdapter = {
    page: "library",
    status: () => {
      const graphView = argument.get();
      if (graphView) return graphView.phase === "ready" || graphView.phase === "empty" ? "complete" : graphView.phase === "loading" ? "unavailable" : "error";
      const exploring = discovery.get();
      if (exploring) return exploring.graph ? "complete" : exploring.error ? "error" : "unavailable";
      const source = library.get()?.source;
      return source === "live" ? "complete" : source === "error" ? "error" : "unavailable";
    },
    context: () => ({ library: discovery.get() || argument.get() ? null : library.get(), discovery: discovery.get(), argument: argument.get() }),
    handles: (action) => LibraryViewActionSchema.safeParse(action).success || ArgumentViewActionSchema.safeParse(action).success,
    // Opening an argument graph opens or uses a Library page; selecting an argument and leaving the view need one that shows
    // the graph. An exploration control needs this pane to be exploring.
    needsPane: (action) => (isArgumentViewAction(action) ? (action.action === "open_argument_graph" ? "any" : "existing-only") : discoveryActionNeedsExploration(action) ? "active-only" : "any"),
    available: (action) => {
      if (!isArgumentViewAction(action)) return discovery.get() !== null;
      const shown = argument.get();
      return shown !== null && (action.action !== "select_argument" || shown.work.id === action.workId);
    },
    // also the service's `discovery_saved` sync, which the Shell hands every Library pane
    apply: async (action: CopilotViewAction) => {
      const current = controller.get();
      return current ? current.apply(action as LibraryViewAction | DiscoverySavedViewAction | ArgumentViewAction) : unavailable();
    },
    timeouts: { readyMs: 0, applyMs: 2000 },
  };
  return { adapter, argument, props: { onContext: library.set, onDiscovery: discovery.set, onArgument: argument.set, onController: controller.set } };
}
