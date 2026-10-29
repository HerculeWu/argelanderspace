/**
 * The catalog operation `library.delete_doc` (release-0.2 ticket 04): the Files tab's global physical delete of one
 * Doc, asked of a real person first. Two channels ask, with the same business code behind them:
 * - the Copilot `library` tool (copilot-library-tool.ts) puts the card in its conversation and uses
 *   {@link prepareDocDelete} / {@link recheckDocDelete} around its own wait;
 * - the CLI over the workbench's operation route ({@link runDeleteDocOperation}) puts the card in the external
 *   requests queue (external-requests.ts) and runs the same delete after the click.
 * Both read what the dialog would show without writing, refuse a Doc the dialog would not offer, and check again after
 * the click, so the wording of every refusal is defined once, here.
 */

import { askCard } from "./confirm-card.js";
import {
  applyDocDelete,
  type DocDeleteDescription,
  type DocDeletionPort,
} from "./library-actions.js";
import type { OperationCall, OperationRuntime } from "./operation-catalog.js";
import { cardWorkbenchRequired } from "./workbench-required.js";

export type DocDeleteReady = Extract<DocDeleteDescription, { kind: "ready" }>;
export type DocDeleteRefusal = {
  ok: false;
  status: "error" | "rejected" | "not_found" | "expired" | "unsupported";
  detail: string;
};

export const DOC_DELETE_UNAVAILABLE = "deleting documents is not available in this host";

/** What the dialog would show, or the refusal of a Doc it would not offer (nothing is written, no card is asked). */
export async function prepareDocDelete(
  port: DocDeletionPort,
  docId: string
): Promise<{ ok: true; described: DocDeleteReady } | DocDeleteRefusal> {
  let described: DocDeleteDescription;
  try {
    described = await port.describe(docId);
  } catch {
    return {
      ok: false,
      status: "error",
      detail: "the document could not be checked; nothing was deleted",
    };
  }
  if (described.kind === "ready") return { ok: true, described };
  if (described.kind === "error")
    return { ok: false, status: "error", detail: `${described.detail}; nothing was deleted` };
  if (described.kind === "bad_id")
    return { ok: false, status: "rejected", detail: "that is not a valid Doc id" };
  if (described.kind === "orphan")
    return {
      ok: false,
      status: "rejected",
      detail:
        "no work lists this Doc, and the Files tab can only delete Docs a work lists, so it is not offered here either; nothing was deleted. Tell the user it has to be dealt with outside the application",
    };
  if (described.kind === "busy")
    return {
      ok: false,
      status: "rejected",
      detail:
        "the document is busy (an upload or refresh is writing it, or it is being deleted); nothing was deleted and no confirmation was asked. Try again when the task finishes",
    };
  return {
    ok: false,
    status: "not_found",
    detail: "no such Doc (it may already have been deleted); nothing was deleted",
  };
}

/** The check made once the user approved, right before the delete runs: still exactly what the card showed. */
export async function recheckDocDelete(
  port: DocDeletionPort,
  docId: string,
  shown: DocDeleteReady
): Promise<{ ok: true; holders: string } | DocDeleteRefusal> {
  let again: DocDeleteDescription;
  try {
    again = await port.describe(docId);
  } catch {
    return {
      ok: false,
      status: "error",
      detail: "the document could not be checked again; nothing was deleted",
    };
  }
  if (again.kind !== "ready" || again.digest !== shown.digest)
    return {
      ok: false,
      status: "expired",
      detail:
        "the Doc, the works that list it or its annotations changed after the user confirmed; nothing was deleted. Read again and ask only if it is still wanted",
    };
  return { ok: true, holders: again.holders };
}

/** The CLI's `library delete-doc`: card in the workbench's queue, the delete after the click. */
export async function runDeleteDocOperation(
  runtime: OperationRuntime,
  params: { docId: string },
  call: OperationCall
): Promise<unknown> {
  const port = runtime.library.deletion;
  if (!port) return { ok: false, status: "unsupported", detail: DOC_DELETE_UNAVAILABLE };
  // Only the running workbench has a place to show the card; without it nothing is deleted and nothing is asked.
  if (!runtime.confirm) return cardWorkbenchRequired("library.delete_doc");
  const prepared = await prepareDocDelete(port, params.docId);
  if (!prepared.ok) return prepared;
  const { described } = prepared;
  const card = await askCard(
    runtime,
    {
      action: "delete_doc",
      object: { kind: "doc", id: params.docId },
      format: described.format,
      works: described.works,
      impact: described.impact,
      baseRev: described.rev,
      objectDigest: described.digest,
    },
    call,
    "deleted"
  );
  if (!card.approved) return card.refusal;
  const { asked } = card;
  // Approved: the click is the commit. Whatever happens next is reported to the decision call.
  let result: unknown;
  try {
    const checked = await recheckDocDelete(port, params.docId, described);
    result = checked.ok
      ? await applyDocDelete(runtime.library, params.docId, { holders: checked.holders })
      : checked;
  } catch (e) {
    result = { ok: false, status: "error", detail: e instanceof Error ? e.message : String(e) };
    asked.settle(result);
    throw e;
  }
  asked.settle(result);
  return result;
}
