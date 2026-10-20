import type { Workbench } from "../copilot.js";
import { describeArgumentTarget } from "../copilot-argument-tool.js";
import { type ConfirmationKind, detailOf } from "./kind.js";

/**
 * Replacing or clearing a Work's argument graph while it holds arguments (argument graph ticket 09): bound to the graph's
 * rev and to the stored content shown. The card is only about this Work's graph, so any view may decide it; a change to
 * the graph (a write by the user, the page or anything else) ends it.
 */
export function replaceArgumentGraphKind(workbench: Workbench | undefined) {
  return {
    action: "replace_argument_graph",
    object: (entry) => ({ kind: "work", id: entry.workId, workId: entry.workId }),
    record: (card) => ({ action: card.action, workId: card.object.workId }),
    askedLine: (entry) => `${entry.action} ${entry.workId}`,
    /** The graph's rev and stored content still match what the card showed (a system error is never a change). */
    check: async (card) => {
      const argument = workbench?.argument;
      if (!argument) return "changed";
      try {
        const now = describeArgumentTarget(argument, card.object.workId);
        return now && now.rev === card.baseRev && now.objectDigest === card.objectDigest
          ? "valid"
          : "changed";
      } catch (error) {
        return { error: detailOf(error) };
      }
    },
    revalidateOn: "argument",
    boundToNavView: false,
  } satisfies ConfirmationKind<"replace_argument_graph", { workId: string }>;
}
