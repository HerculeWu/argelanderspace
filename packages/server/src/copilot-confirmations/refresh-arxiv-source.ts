import type { Workbench } from "../copilot.js";
import { prepareArxivRefresh } from "../library-actions.js";
import { type ConfirmationKind, detailOf } from "./kind.js";

/** Replacing the text of an existing LaTeX Doc: the arXiv refresh, the Files tab dialog's annotation-risk step. */
export function refreshArxivSourceKind(
  workbench: Workbench | undefined
): ConfirmationKind<"refresh_arxiv_source"> {
  return {
    action: "refresh_arxiv_source",
    card: (id, runId, entry) => ({
      id,
      runId,
      toolCallId: entry.toolCallId,
      baseRev: entry.baseRev,
      action: entry.action,
      object: { kind: "doc", id: entry.docId, workId: entry.workId },
      label: entry.label,
      impact: entry.impact,
      objectDigest: entry.objectDigest,
    }),
    requestedFields: (entry) => ({
      action: entry.action,
      workId: entry.workId,
      docId: entry.docId,
    }),
    resolvedFields: (card) => ({
      action: card.action,
      workId: card.object.workId,
      docId: card.object.id,
    }),
    askedLine: (entry) => `${entry.action} ${entry.workId} ${entry.docId}`,
    /**
     * The Work still refreshes the same arXiv Doc and the dialog's annotation risk (count, rev, the Work's Docs) is what
     * the card showed. Reading the risk goes through the annotations access path, as the acquisition dialog does.
     */
    check: async (card) => {
      const library = workbench?.library;
      if (!library?.acquisition) return "changed";
      try {
        const workId = card.object.workId;
        const plan = library.acquisition.describeSource(workId);
        if (plan.kind !== "refresh" || plan.docId !== card.object.id) return "changed";
        // Not ok: the Doc is gone or a task is writing or deleting it, so it is not refreshable as shown (a change). A
        // risk that cannot be read is an unknown count inside an ok answer, and a read that throws is an error below.
        const now = await prepareArxivRefresh(library, workId, plan);
        return now.ok && now.digest === card.objectDigest && now.rev === card.baseRev
          ? "valid"
          : "changed";
      } catch (error) {
        // The Work or the annotation risk could not be read: a system error, never reported as a change.
        return { error: detailOf(error) };
      }
    },
    revalidateOn: "doc",
    boundToNavView: false,
  };
}
