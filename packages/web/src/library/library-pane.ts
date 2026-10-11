/**
 * The Library page as a pane adapter (copilot ticket 37), Discovery included: while the pane explores, its
 * exploration page replaces the Library page for the Copilot. Only live data is complete (example data, a Library
 * still loading and a failed load are not). An exploration control acts only on the active pane while it explores
 * (`active-only`): it never opens a Library page or switches pane; every other Library action, and the two that
 * enter an exploration, open or use a Library page.
 */
import { type CopilotViewAction, type DiscoveryPage, type DiscoverySavedViewAction, discoveryActionNeedsExploration, type LibraryPage, LibraryViewActionSchema, type LibraryViewAction } from "@argelanderspace/contracts";
import { type PaneAdapter, registered, reported, unavailable } from "../argelander/panes";
import type { LibraryViewController } from "./LibraryView";

export function createLibraryPane(notify: () => void) {
  const library = reported<LibraryPage>(notify);
  const discovery = reported<DiscoveryPage>(notify);
  const controller = registered<LibraryViewController>();
  const adapter: PaneAdapter = {
    page: "library",
    status: () => {
      const exploring = discovery.get();
      if (exploring) return exploring.graph ? "complete" : exploring.error ? "error" : "unavailable";
      const source = library.get()?.source;
      return source === "live" ? "complete" : source === "error" ? "error" : "unavailable";
    },
    context: () => ({ library: discovery.get() ? null : library.get(), discovery: discovery.get() }),
    handles: (action) => LibraryViewActionSchema.safeParse(action).success,
    needsPane: (action) => (discoveryActionNeedsExploration(action) ? "active-only" : "any"),
    // an exploration control needs this pane to be exploring
    available: () => discovery.get() !== null,
    // also the service's `discovery_saved` sync, which the Shell hands every Library pane
    apply: async (action: CopilotViewAction) => {
      const current = controller.get();
      return current ? current.apply(action as LibraryViewAction | DiscoverySavedViewAction) : unavailable();
    },
    timeouts: { readyMs: 0, applyMs: 2000 },
  };
  return { adapter, props: { onContext: library.set, onDiscovery: discovery.set, onController: controller.set } };
}
