/**
 * The undo of a task delete that the service holds (copilot ticket 33 follow-up). One registry, one operation:
 * the Copilot `plan` tool (`undo_delete_task`), the Copilot panel's notice and the Plan page's undo snackbar all
 * restore through `TaskUndoRegistry.undo`, which is `restoreDeletedTask` inside the Plan lock plus the window and
 * conflict rules. The restorable state (the removed raw task, unknown keys included, and its index) lives here in
 * the service's memory, like the window itself: a restart forgets it, honestly, and nothing is added to plans.json.
 *
 * Rules, all refusals write nothing:
 * - `expired`: the 8 s window (TASK_UNDO_WINDOW_MS) is over. The handle is kept for a while so the refusal says why.
 * - `conflict`: the plan the task came from no longer exists (or the document cannot take the task back).
 * - `noop`: the task is already back; a task edited or moved since is never rolled back, the restore only
 *   reinserts the removed task into the CURRENT document under the Plan lock (rev bump, plan.changed).
 * - used: a handle that was used stays as a tombstone: a repeat (another surface, or the same instant) answers `noop`
 *   with the current rev, or the same refusal again, never `not_found`.
 * - `not_found`: no such handle (forgotten after a restart, or never registered by the Copilot).
 *
 * Only task deletes the COPILOT made are registered (the user's own page deletes keep the page's in-browser undo).
 */
import { randomUUID } from "node:crypto";
import { TASK_UNDO_WINDOW_MS } from "@argelanderspace/contracts";
import {
  type PlanOpDeps,
  type PlanOpOutcome,
  type RemovedTask,
  readPlans,
  restoreDeletedTask,
} from "./plans-actions.js";

/** How long an expired handle is remembered, only to answer `expired` instead of `not_found`. */
const EXPIRED_MEMORY_MS = 10 * 60 * 1000;

export interface UndoEntry {
  id: string;
  planId: string;
  taskId: string;
  title: string;
  removed: RemovedTask;
  /** Epoch ms: the window closes at this instant. */
  until: number;
  /** The final outcome once the undo ran (restored or refused): the handle is no longer undoable. */
  result?: UndoResult;
  /** The undo in flight, so a second caller waits for it instead of writing twice. */
  pending?: Promise<UndoResult>;
  /** The Copilot call that deleted the task, so the panel can address its own notice. */
  source?: { conversationId: string; toolCallId: string };
}

export type UndoSelector =
  | { id: string }
  | { planId: string; taskId: string }
  | { conversationId: string; toolCallId: string };

export type UndoResult =
  | Extract<PlanOpOutcome, { ok: true }>
  | {
      ok: false;
      status: "expired" | "conflict" | "not_found" | "invalid";
      detail: string;
      rev?: number;
    };

export class TaskUndoRegistry {
  private readonly entries = new Map<string, UndoEntry>();

  register(input: {
    planId: string;
    taskId: string;
    title: string;
    removed: RemovedTask;
    source?: UndoEntry["source"];
  }): UndoEntry {
    this.sweep();
    const entry: UndoEntry = {
      id: randomUUID(),
      planId: input.planId,
      taskId: input.taskId,
      title: input.title,
      removed: input.removed,
      until: Date.now() + TASK_UNDO_WINDOW_MS,
      ...(input.source ? { source: input.source } : {}),
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  /** The deletes that can still be undone right now, oldest first. */
  active(): UndoEntry[] {
    this.sweep();
    const now = Date.now();
    return [...this.entries.values()].filter((entry) => entry.until >= now && !entry.result);
  }

  find(selector: UndoSelector): UndoEntry | undefined {
    this.sweep();
    if ("id" in selector) return this.entries.get(selector.id);
    const all = [...this.entries.values()].reverse(); // newest first
    if ("toolCallId" in selector)
      return all.find(
        (entry) =>
          entry.source?.conversationId === selector.conversationId &&
          entry.source.toolCallId === selector.toolCallId
      );
    return all.find(
      (entry) => entry.planId === selector.planId && entry.taskId === selector.taskId
    );
  }

  async undo(deps: PlanOpDeps, selector: UndoSelector): Promise<UndoResult> {
    const entry = this.find(selector);
    if (!entry)
      return {
        ok: false,
        status: "not_found",
        detail:
          "there is no task delete of the Copilot's to undo for this: it is older than the undo window, the service restarted, or the task was not deleted by the Copilot (the user's own deletes are undone from the Plan page)",
      };
    // Whoever asks second, at the same instant or later, gets the same answer as the first: no second write, no false failure.
    if (entry.pending) await entry.pending.catch(() => undefined);
    if (entry.result) return replay(deps, entry, entry.result);
    if (Date.now() > entry.until)
      return {
        ok: false,
        status: "expired",
        detail: `the ${TASK_UNDO_WINDOW_MS / 1000}-second undo window is over; the task stays deleted. Create it again only if the user wants it`,
      };
    const work = this.restore(deps, entry);
    entry.pending = work;
    try {
      return await work;
    } finally {
      entry.pending = undefined;
    }
  }

  private async restore(deps: PlanOpDeps, entry: UndoEntry): Promise<UndoResult> {
    const outcome = await restoreDeletedTask(deps, { planId: entry.planId, ...entry.removed }); // a throw leaves the handle open
    const result: UndoResult = outcome.ok
      ? outcome
      : {
          ok: false,
          status: outcome.status === "not_found" ? "conflict" : "invalid",
          detail:
            outcome.status === "not_found"
              ? "the plan this task belonged to no longer exists; the task stays deleted"
              : "the plans document cannot take the task back; the task stays deleted",
          rev: outcome.currentRev,
        };
    entry.result = result; // kept as a tombstone: no longer undoable, and repeats are answered, not "not found"
    return result;
  }

  private sweep(): void {
    const cutoff = Date.now() - EXPIRED_MEMORY_MS;
    for (const [id, entry] of this.entries) if (entry.until < cutoff) this.entries.delete(id);
  }
}

/** What a repeated undo answers: the first outcome's failure again, or "already back" (noop) at the current rev. */
function replay(deps: PlanOpDeps, entry: UndoEntry, first: UndoResult): UndoResult {
  if (!first.ok) return first;
  return {
    ok: true,
    status: "noop",
    rev: readPlans(deps.statusDir).rev,
    object: { kind: "task", id: entry.taskId, planId: entry.planId },
    label: entry.title,
  };
}
