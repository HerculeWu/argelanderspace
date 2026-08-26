/**
 * The library.json mutual exclusion (Python `library/build.py::_WRITE_LOCK`).
 *
 * `LibraryStore.load`/`save` are synchronous, so a single PATCH is atomic on
 * the event loop — but `rebuild()` is load → *minutes of awaited enrichment* →
 * save, and a PATCH landing inside that window would be silently overwritten
 * by rebuild's stale save. Python serializes both with one threading lock;
 * this promise-chain mutex is the same exclusion for the async port:
 * `rebuild` (refresh endpoint + upload's internal relink) and the immediate
 * PATCH/POST refs endpoints all run through it. It is deliberately *not* held
 * across MinerU OCR — Python didn't lock that either, and a queued upload must
 * not block user edits for minutes.
 */

export class AsyncLock {
  private tail: Promise<void> = Promise.resolve();

  /** Run *fn* exclusively with respect to every other `run` on this lock. */
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(fn);
    // The chain itself must not reject (a failed section must not wedge the lock).
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
