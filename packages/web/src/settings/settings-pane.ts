/**
 * The settings page as a pane adapter. The page reports nothing to the Copilot and takes no view action: its pane
 * is published with the view name only, as `unavailable`.
 */
import { type PaneAdapter, unavailable } from "../argelander/panes";

export function createSettingsPane() {
  const adapter: PaneAdapter = {
    page: "settings",
    status: () => "unavailable",
    context: () => ({}),
    handles: () => false,
    needsPane: () => "existing-only",
    apply: async () => unavailable(),
  };
  return { adapter };
}
