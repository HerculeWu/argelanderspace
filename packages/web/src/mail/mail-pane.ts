/**
 * The Mail page as a pane adapter (copilot ticket 37): its page only, no view actions. It is complete once its
 * accounts and lists really loaded; loading, no account and errors are not (never `error`).
 */
import type { MailPage } from "@argelanderspace/contracts";
import { type PaneAdapter, reported } from "../argelander/panes";

export function createMailPane(notify: () => void) {
  const page = reported<MailPage>(notify);
  const adapter: PaneAdapter = {
    page: "mail",
    status: () => (page.get()?.phase === "ready" ? "complete" : "unavailable"),
    context: () => ({ mail: page.get() }),
    handles: () => false,
    needsPane: () => "any",
  };
  return { adapter, props: { onContext: page.set } };
}
