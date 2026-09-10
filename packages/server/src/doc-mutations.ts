/**
 * The doc-mutation registry (Stage 8 roadmap §8): the lifecycle lock between
 * `DELETE /api/paper/:doc_id` and the server's doc-writing jobs.
 *
 * libraryLock alone cannot serialize this: an upload job writes
 * `output/<doc>/` OUTSIDE the lock for the whole ingest (minutes — holding
 * the library lock across it would block every user edit; the Stage 3.1
 * design deliberately doesn't), so a delete and an ingest of the same doc
 * could interleave. This registry closes the gap with two pin sets, every
 * check+claim running as ONE synchronous event-loop section (no awaits
 * inside), which is what makes the mutual exclusion airtight:
 *
 * - **writer pins** (per doc): a job that may write `output/<docId>/` pins it
 *   from submit time until the job reaches a terminal state. Upload computes
 *   its doc id at submit time — `uploadDocId(workId)` is a pure function of
 *   the resolved work id (an unresolvable work pins nothing; the job fails
 *   later exactly as before). The `?sync=1` upload path pins around the
 *   attach call instead.
 * - **refresh pins** (global count): `rebuild()` never writes doc dirs, but
 *   it re-derives EVERY work's `doc_ids` from `output/` and holds libraryLock
 *   across the enrichment — a delete slipping in would hang behind that lock
 *   and race the rebuild's stale save. Its plannable target set is the whole
 *   output listing, so a queued/running refresh conservatively busy-blocks
 *   every delete (refresh is rare and user-visible; finer per-doc tracking
 *   has no correct seam — rebuild's doc set is only fixed at run time).
 *
 * `DELETE` claims the doc's delete slot (`tryBeginDelete`) before any
 * mutation and holds it across the physical delete + library removal; a
 * claimed slot makes upload submissions for the same doc fail with 409 (the
 * reverse direction of §8: while a delete is executing, no upload may write
 * that doc). CLI/other-process mutations of the same doc are an unsupported
 * operation boundary (roadmap §8 — no cross-process locking).
 */
export class DocMutationRegistry {
  /** docId → number of live writer pins (queued/running upload jobs). */
  private readonly writers = new Map<string, number>();
  /** Queued/running refresh jobs (whole-library target set — see the banner). */
  private refreshPins = 0;
  /** Doc ids with an in-flight DELETE. */
  private readonly deletions = new Set<string>();

  pinWriter(docId: string): void {
    this.writers.set(docId, (this.writers.get(docId) ?? 0) + 1);
  }

  unpinWriter(docId: string): void {
    const n = (this.writers.get(docId) ?? 0) - 1;
    if (n <= 0) this.writers.delete(docId);
    else this.writers.set(docId, n);
  }

  pinRefresh(): void {
    this.refreshPins += 1;
  }

  unpinRefresh(): void {
    this.refreshPins = Math.max(0, this.refreshPins - 1);
  }

  /** True while a queued/running job may write this doc (upload of the doc
   *  itself, or any refresh — see the banner). */
  isBusy(docId: string): boolean {
    return this.writers.has(docId) || this.refreshPins > 0;
  }

  /** True while a DELETE of this doc is executing (uploads must refuse). */
  isDeleting(docId: string): boolean {
    return this.deletions.has(docId);
  }

  /**
   * Atomically claim the doc's delete slot: false when the doc is busy (409
   * "document busy", never wait) or already being deleted; true = the caller
   * owns the delete until {@link endDelete}.
   */
  tryBeginDelete(docId: string): boolean {
    if (this.isBusy(docId) || this.deletions.has(docId)) return false;
    this.deletions.add(docId);
    return true;
  }

  endDelete(docId: string): void {
    this.deletions.delete(docId);
  }
}
