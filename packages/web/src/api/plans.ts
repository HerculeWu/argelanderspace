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
