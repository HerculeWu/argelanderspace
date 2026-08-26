/**
 * The paper JSON cache (Python `server/app.py::_load_paper`).
 *
 * Python: `@lru_cache(maxsize=16)` keyed by `(doc_id, (mtime_ns, size))` — the
 * stat pair busts the cache when the file changes (ns avoids float rounding;
 * size catches same-mtime edits). Here the stat is taken by the caller (it
 * already stats for the 404 check), keyed per doc_id with LRU eviction at 16.
 */

import { readFileSync } from "node:fs";

interface CacheEntry {
  mtimeNs: bigint;
  size: bigint;
  doc: unknown;
}

const MAX_ENTRIES = 16;

export class PaperCache {
  /** Map iteration order doubles as LRU order (oldest first). */
  private readonly entries = new Map<string, CacheEntry>();

  /** Load *path*'s JSON, cached while `(mtimeNs, size)` is unchanged. */
  load(docId: string, path: string, stat: { mtimeNs: bigint; size: bigint }): unknown {
    const hit = this.entries.get(docId);
    if (hit && hit.mtimeNs === stat.mtimeNs && hit.size === stat.size) {
      // LRU touch: re-insert at the newest end.
      this.entries.delete(docId);
      this.entries.set(docId, hit);
      return hit.doc;
    }
    const doc = JSON.parse(readFileSync(path, "utf8")) as unknown;
    this.entries.delete(docId);
    this.entries.set(docId, { mtimeNs: stat.mtimeNs, size: stat.size, doc });
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return doc;
  }
}
