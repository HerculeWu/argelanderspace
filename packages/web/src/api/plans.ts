import type { PlansFile } from "@argelanderspace/contracts";

// The plan page talks to /api/plans (Stage 4). Unlike the library API there
// is deliberately NO fixture fallback (the design's call): an unreachable
// server just yields `null` and the view shows an explicit load-failure
// state with a retry button (never the empty state — "can't reach the
// server" must not disguise itself as "no plans yet").

export async function fetchPlans(): Promise<PlansFile | null> {
  try {
    const r = await fetch("/api/plans");
    if (!r.ok) return null;
    return (await r.json()) as PlansFile;
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
    const r = await fetch("/api/plans/undo");
    if (!r.ok) return null;
    const body = (await r.json()) as { undoable?: UndoableDelete[] };
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
    const r = await fetch("/api/plans/undo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    if (r.ok) return { ok: true };
    const body = (await r.json().catch(() => ({}))) as { status?: string };
    return { ok: false, refused: body.status === "expired" ? "expired" : body.status === "conflict" ? "conflict" : "gone" };
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
    const r = await fetch("/api/plans", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    });
    if (r.ok) return { ok: true, doc: (await r.json()) as PlansFile };
    return { ok: false, conflict: r.status === 409 };
  } catch {
    return { ok: false, conflict: false };
  }
}
