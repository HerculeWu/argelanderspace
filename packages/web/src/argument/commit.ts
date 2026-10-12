/**
 * The one commit path of the argument graph page (ticket 05; the Copilot's argument-graph tools, ticket 09, share it):
 * take the graph the caller last read, apply one pure edit operation (contracts `argument-edit.ts`), and write the result
 * with the `rev` that graph carries. Nothing else writes. A refused operation sends nothing; a 409 overwrites nothing and
 * the caller keeps what the person typed; a 400 carries the server's reason.
 */
import type { ArgumentEditResult, ArgumentEditRejection, ArgumentGraph } from "@argelanderspace/contracts";
import { putArgumentGraph } from "../api/argument-graph";

export type CommitOutcome<T extends object = Record<never, never>> =
  | ({ kind: "ok"; graph: ArgumentGraph } & T)
  /** The operation itself refused (nothing was sent). */
  | { kind: "rejected"; rejection: ArgumentEditRejection }
  /** The graph moved on since `base` was read; nothing was written. */
  | { kind: "conflict"; rev: number | null }
  /** The server's structure check refused what the operation produced. */
  | { kind: "invalid"; detail: string }
  | { kind: "not-found" }
  | { kind: "corrupt" }
  | { kind: "error"; unreachable: boolean };

/**
 * What an edit returns when the graph it finally runs on no longer is the one the person's request was made against (the
 * argument under a form changed elsewhere, the counts a confirmation showed moved on): nothing is written, the outcome is a
 * `conflict`. The check belongs inside the edit because a queued write runs on the graph of the moment it runs, not of the
 * moment it was asked for.
 */
export const STALE = { ok: false, stale: true } as const;
export type StaleEdit = typeof STALE;

/** Applies `edit` to `base` and writes the result at `base.rev`. */
export async function commitArgumentEdit<T extends object = Record<never, never>>(
  workId: string,
  base: ArgumentGraph,
  edit: (graph: ArgumentGraph) => ArgumentEditResult<T> | StaleEdit
): Promise<CommitOutcome<T>> {
  const result = edit(base);
  if ("stale" in result) return { kind: "conflict", rev: base.rev };
  if (!result.ok) return { kind: "rejected", rejection: result.rejection };
  const { ok: _ok, graph: next, ...extra } = result;
  const written = await putArgumentGraph(workId, { ...next, rev: base.rev, work_id: base.work_id });
  if (written.kind === "ok") return { kind: "ok", graph: written.graph, ...(extra as unknown as T) };
  return written;
}
