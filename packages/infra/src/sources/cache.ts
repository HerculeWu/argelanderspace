/**
 * Shared disk cache for the metadata-source clients: one JSON file per query
 * under `<cacheDir>/<sha1>.json`, exactly the Python layout so the existing
 * `data/library/cache/{ads,crossref,openalex}/` contents are reused.
 *
 * Parity notes:
 * - Cache keys are byte-identical to the Python (see lib/pyjson.ts).
 * - Cache *contents* are only parse-identical: Python writes
 *   `json.dumps(...)` (ensure_ascii → \uXXXX, ", "/": " separators) while we
 *   write JSON.stringify output (raw UTF-8, compact). JSON.parse reads both;
 *   the same divergence was already accepted for graph.json in M1b.
 * - An unparseable cache file is treated as a miss, like Python's
 *   `except ValueError: pass`.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function sha1Hex(s: string): string {
  return createHash("sha1").update(s, "utf-8").digest("hex");
}

export class SourceCache {
  constructor(public readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  /** Parsed cache entry, or undefined when absent/unparseable. */
  read(key: string): unknown {
    try {
      return JSON.parse(readFileSync(join(this.dir, `${key}.json`), "utf-8"));
    } catch {
      return undefined; // absent (ENOENT) or corrupt — Python treats both as a miss
    }
  }

  write(key: string, value: unknown): void {
    writeFileSync(join(this.dir, `${key}.json`), JSON.stringify(value), "utf-8");
  }
}
