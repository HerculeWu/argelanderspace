/**
 * The one definition of the `workbench_required` answer (release-0.2; `docs/operation-catalog.md`, "确认卡"): what an
 * operation says when it needs a running workbench (a confirmation card to show, or a window to open something in) and
 * none runs for the data directory. The CLI's up-front refusal for `confirm: "card"` operations and each handler's own
 * refusal build it here, so the two wordings cannot drift apart.
 */

/** `needs` is the subject and what it needs ("deleting a Doc needs your confirmation on a card in the workbench"); `nothing` completes "Nothing was …". */
export function workbenchRequiredDetail(needs: string, nothing: string): string {
  return `${needs}, and no workbench is running for this data directory; open ArgelanderSpace on this project first (the command never starts it). Nothing was ${nothing}`;
}

export function workbenchRequired(
  needs: string,
  nothing: string
): { ok: false; status: "workbench_required"; detail: string } {
  return {
    ok: false,
    status: "workbench_required",
    detail: workbenchRequiredDetail(needs, nothing),
  };
}

/** The sentence for an operation whose whole call waits for a card. */
export const needsCard = (what: string): string =>
  `${what} needs your confirmation on a card in the workbench`;

/** How each `confirm: "card"` operation names itself; an operation not listed is named by its id. */
const CARD_OPERATIONS: Readonly<Record<string, { what: string; nothing: string }>> = {
  "library.delete_doc": { what: "deleting a Doc", nothing: "deleted" },
};

/** The refusal of a `confirm: "card"` operation when no workbench runs (the CLI's, and the handler's own). */
export function cardWorkbenchRequired(operationId: string) {
  const named = CARD_OPERATIONS[operationId] ?? { what: operationId, nothing: "done" };
  return workbenchRequired(needsCard(named.what), named.nothing);
}
