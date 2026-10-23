import type { ShelfAddPreviewResponse } from "@argelanderspace/contracts";
import type { Workbench } from "../copilot.js";
import { shelfAddDigest, shelfDeleteDigest } from "../copilot-shelf-tool.js";
import { type ConfirmationCheck, type ConfirmationKind, detailOf } from "./kind.js";

/** A refusal of a Shelf route at the click: a server failure is a system error, any other refusal a change. */
const refusalCheck = (status: number, detail: unknown): ConfirmationCheck =>
  status >= 500 ? { error: typeof detail === "string" ? detail : `HTTP ${status}` } : "changed";

/**
 * Adding a Work to the Shelf, or replacing the entries of the same paper (shelf ticket 07). The card carries the request
 * it sends; the click previews that very request again (read only: no ensure, nothing written) and finds it unchanged
 * only when the preview is what the card showed. Checked at the click only (a preview reads every chosen Doc).
 */
export function shelfAddKind(workbench: Workbench | undefined) {
  return {
    action: "shelf_add",
    object: (entry) => ({ kind: "work", id: entry.workId, workId: entry.workId }),
    record: (card) => ({ action: card.action, workId: card.object.workId }),
    askedLine: (entry) => `${entry.action} ${entry.workId}`,
    check: async (card) => {
      const shelf = workbench?.shelf;
      if (!shelf) return "changed";
      try {
        const now = await shelf.writer.preview(card.request);
        if (now.status !== 200) return refusalCheck(now.status, now.body.detail);
        return shelfAddDigest(card.request, now.body as unknown as ShelfAddPreviewResponse) ===
          card.objectDigest
          ? "valid"
          : "changed";
      } catch (error) {
        return { error: detailOf(error) };
      }
    },
    revalidateOn: null,
    boundToNavView: false,
  } satisfies ConfirmationKind<"shelf_add", { workId: string }>;
}

/**
 * Taking a Shelf entry into this project (shelf ticket 07): the click previews the card's request again and finds it
 * unchanged only when the plan's digest is the one shown. Checked at the click only.
 */
export function shelfTakeKind(workbench: Workbench | undefined) {
  return {
    action: "shelf_take",
    object: (entry) => ({ kind: "shelf_entry", id: entry.entryId }),
    record: (card) => ({ action: card.action, entryId: card.object.id }),
    askedLine: (entry) => `${entry.action} ${entry.entryId}`,
    check: async (card) => {
      const shelf = workbench?.shelf;
      if (!shelf) return "changed";
      try {
        const now = await shelf.take.preview(card.object.id, card.request);
        if (!now.ok) return refusalCheck(now.status, now.body.detail);
        return now.preview.planDigest === card.planDigest ? "valid" : "changed";
      } catch (error) {
        return { error: detailOf(error) };
      }
    },
    revalidateOn: null,
    boundToNavView: false,
  } satisfies ConfirmationKind<"shelf_take", { entryId: string }>;
}

/** Deleting one Shelf entry (shelf ticket 07): still listed at the rev, state and content the card showed. */
export function shelfDeleteKind(workbench: Workbench | undefined) {
  return {
    action: "shelf_delete",
    object: (entry) => ({ kind: "shelf_entry", id: entry.entryId }),
    record: (card) => ({ action: card.action, entryId: card.object.id }),
    askedLine: (entry) => `${entry.action} ${entry.entryId}`,
    check: async (card) => {
      const shelf = workbench?.shelf;
      if (!shelf) return "changed";
      try {
        const row = (await shelf.list()).find((r) => r.entryId === card.object.id);
        // An entry that could not be looked at is a system error, never a change (票 07 B2).
        if (row?.status === "unreadable")
          return { error: `the Shelf entry could not be looked at (${row.code})` };
        return row && row.rev === card.baseRev && shelfDeleteDigest(row) === card.objectDigest
          ? "valid"
          : "changed";
      } catch (error) {
        // The Shelf could not be read: a system error, never reported as a change.
        return { error: detailOf(error) };
      }
    },
    revalidateOn: null,
    boundToNavView: false,
  } satisfies ConfirmationKind<"shelf_delete", { entryId: string }>;
}
