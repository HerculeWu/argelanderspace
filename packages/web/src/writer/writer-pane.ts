/**
 * The Writer page as a pane adapter (copilot ticket 37): the manuscript list, or the open manuscript with its saved
 * content and unsaved draft. With no Write pane, closing a manuscript is already done (no Writer is opened for it);
 * an action is tried once, since the Writer's controller waits for what it started itself.
 */
import { type CopilotViewAction, type WriterPage, WriterViewActionSchema, type WriterViewAction } from "@argelanderspace/contracts";
import { type PaneAdapter, registered, reported, unavailable } from "../argelander/panes";
import { writerPageStatus } from "./writer-context";
import type { WriterViewController } from "./WriterView";

export function createWriterPane(notify: () => void) {
  const page = reported<WriterPage>(notify);
  const controller = registered<WriterViewController>();
  const adapter: PaneAdapter = {
    page: "write",
    status: () => writerPageStatus(page.get()),
    context: () => ({ writer: page.get() }),
    handles: (action) => WriterViewActionSchema.safeParse(action).success,
    needsPane: () => "any",
    noPaneResult: (action) => (action.action === "close_manuscript" ? { ok: true } : null),
    ready: () => controller.get() !== null,
    apply: async (action: CopilotViewAction) => {
      const current = controller.get();
      return current ? current.apply(action as WriterViewAction) : unavailable();
    },
    timeouts: { readyMs: 2000, applyMs: 0 },
  };
  return { adapter, props: { onContext: page.set, onController: controller.set } };
}
