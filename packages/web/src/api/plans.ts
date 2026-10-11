import type { PlansFile } from "@argelanderspace/contracts";
import { apiRequest, HttpError } from "./request";

// The plan page talks to /api/plans (Stage 4). Unlike the library API there
// is deliberately NO fixture fallback (the design's call): an unreachable
// server just yields `null` and the view shows an explicit load-failure
// state with a retry button (never the empty state — "can't reach the
// server" must not disguise itself as "no plans yet").

export async function fetchPlans(): Promise<PlansFile | null> {
  try {
    return await apiRequest<PlansFile>("/api/plans");
  } catch {
    return null;
  }
}

/** A task delete the service can still undo (8-second window): today the ones the Copilot made. */
export interface UndoableDelete {
  id: string;
  /** The Copilot call that made the delete. */
  conversationId?: string;
  toolCallId?: string;
  planId: string;
  taskId: string;
  title: string;
  until: string;
}

/** What the service can still undo; null when it could not be read (then nothing may be hidden or claimed). */
export async function fetchUndoableState(): Promise<UndoableDelete[] | null> {
  try {
    const body = await apiRequest<{ undoable?: UndoableDelete[] }>("/api/plans/undo");
    return Array.isArray(body.undoable) ? body.undoable : null;
  } catch {
    return null;
  }
}

export async function fetchUndoableDeletes(): Promise<UndoableDelete[]> {
  return (await fetchUndoableState()) ?? [];
}

/** The service's one task-delete undo; `refused` says why nothing was restored. */
export async function undoServerDelete(id: string): Promise<{ ok: true } | { ok: false; refused: "expired" | "conflict" | "gone" }> {
  try {
    try {
      await apiRequest("/api/plans/undo", { method: "POST", json: { id } }, { parse: "none" });
      return { ok: true };
    } catch (e) {
      if (!(e instanceof HttpError) || e.status === 0) throw e;
      // The refusal is the body's `status`; a body that is not JSON reads as `gone`.
      const body = (e.cause !== undefined ? {} : e.body) as { status?: string };
      return { ok: false, refused: body.status === "expired" ? "expired" : body.status === "conflict" ? "conflict" : "gone" };
    }
  } catch {
    return { ok: false, refused: "gone" };
  }
}

export type PutPlansResult =
  | { ok: true; doc: PlansFile } // 200: the persisted doc, rev bumped
  | { ok: false; conflict: boolean }; // 409 → conflict (caller reloads); else a failure

/** Whole-document replace. The body carries the client's rev; the server
 *  answers 200 with the bumped doc or 409 when the rev is stale. */
export async function putPlans(doc: PlansFile): Promise<PutPlansResult> {
  try {
    return { ok: true, doc: await apiRequest<PlansFile>("/api/plans", { method: "PUT", json: doc }) };
  } catch (e) {
    return { ok: false, conflict: e instanceof HttpError && e.status === 409 };
  }
}
