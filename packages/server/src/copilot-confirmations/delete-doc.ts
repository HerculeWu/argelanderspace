import type { Workbench } from "../copilot.js";
import { type ConfirmationKind, detailOf } from "./kind.js";

/** The Files tab's "delete document" dialog (ticket 16): the global physical delete of one Doc. */
export function deleteDocKind(workbench: Workbench | undefined) {
  return {
    action: "delete_doc",
    object: (entry) => ({ kind: "doc", id: entry.docId }),
    record: (card) => ({ action: card.action, docId: card.object.id }),
    askedLine: (entry) => `${entry.action} ${entry.docId}`,
    /**
     * The card shows the Doc, every Work listing it, the annotation count and the content binding: all still the same.
     * Read without writing (no ensure/archive), as the delete dialog does.
     */
    check: async (card) => {
      const deletion = workbench?.library?.deletion;
      if (!deletion) return "changed";
      try {
        const now = await deletion.describe(card.object.id);
        // The library holding the Doc could not be read: a system error. Gone, busy or orphaned: a change.
        if (now.kind === "error") return { error: now.detail };
        return now.kind === "ready" && now.digest === card.objectDigest && now.rev === card.baseRev
          ? "valid"
          : "changed";
      } catch (error) {
        // The Doc could not be described: a system error, never reported as a change.
        return { error: detailOf(error) };
      }
    },
    revalidateOn: "doc",
    // A Doc delete can take the open Doc away from the bound view and the leave guard (unsaved drafts) is asked by the
    // clicking tab about ITS Doc (the rule of ticket 12).
    boundToNavView: true,
  } satisfies ConfirmationKind<"delete_doc", { docId: string }>;
}
