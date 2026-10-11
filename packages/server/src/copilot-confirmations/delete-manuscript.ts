import type { Workbench } from "../copilot.js";
import { describeManuscriptDelete } from "../writer-actions.js";
import { type ConfirmationKind, detailOf } from "./kind.js";

/** The Writer list's delete (ticket 22): bound to the manuscript's revision and its stored bytes. */
export function deleteManuscriptKind(
  workbench: Workbench | undefined
): ConfirmationKind<"delete_manuscript"> {
  return {
    action: "delete_manuscript",
    card: (id, runId, entry) => ({
      id,
      runId,
      toolCallId: entry.toolCallId,
      baseRev: entry.baseRev,
      action: entry.action,
      object: { kind: "manuscript", id: entry.manuscriptId },
      label: entry.label,
      impact: entry.impact,
      objectDigest: entry.objectDigest,
    }),
    requestedFields: (entry) => ({ action: entry.action, manuscriptId: entry.manuscriptId }),
    resolvedFields: (card) => ({ action: card.action, manuscriptId: card.object.id }),
    askedLine: (entry) => `${entry.action} ${entry.manuscriptId}`,
    /** The manuscript still has the revision and the stored bytes the card showed (synchronous). */
    check: (card) => {
      const writer = workbench?.writer;
      if (!writer) return Promise.resolve("changed");
      try {
        const now = describeManuscriptDelete(writer, card.object.id);
        // `{ error }`: the manuscript file exists but cannot be read or parsed (a missing one is null, a change).
        if (now && "error" in now) return Promise.resolve({ error: now.error });
        return Promise.resolve(
          now && now.rev === card.baseRev && now.digest === card.objectDigest ? "valid" : "changed"
        );
      } catch (error) {
        // The manuscript could not be read: a system error, never reported as a change.
        return Promise.resolve({ error: detailOf(error) });
      }
    },
    revalidateOn: "writer",
    // A delete can take the open manuscript away from the bound view (the rule of ticket 12).
    boundToNavView: true,
  };
}
