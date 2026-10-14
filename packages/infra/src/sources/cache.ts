/**
 * Shared disk cache for the metadata-source clients: one JSON file per query
 * under `<cacheDir>/<sha1>.json`, exactly the Python layout so the existing
 * `data/library/cache/{ads,crossref,openalex}/` contents are reused.
 *
 * Keys: `sha1(path + "?" + json.dumps(params, sort_keys=True))` (lib/pyjson.ts,
 * byte-identical to the Python client's derivation). For Crossref and OpenAlex
 * the params of the key are the request's own, without the contact email
 * (desktop-app ticket 11): the answer does not depend on it, so changing the
 * address keeps the cache. Entries written before that are keyed with the
 * params *plus* the `mailto` then sent; `readKeyed` falls back to that legacy
 * key — computed with the contact email set now — when the new key misses,
 * and copies a legacy hit forward under the new key (user decision
 * 2026-10-14). Legacy files are never deleted.
 *
 * Parity notes:
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
import { pyJsonStable } from "../lib/pyjson.js";

export function sha1Hex(s: string): string {
  return createHash("sha1").update(s, "utf-8").digest("hex");
}

/** The cache key of a query: `sha1(path + "?" + json.dumps(params, sort_keys=True))`. */
export function cacheKey(path: string, params: Record<string, string | number>): string {
  return sha1Hex(`${path}?${pyJsonStable(params)}`);
}

/**
 * Read a Crossref / OpenAlex query from the cache: the key without the contact email first; on a miss, when a
 * contact email is set, the legacy key with `mailto` in the params (how entries were keyed before desktop-app
 * ticket 11). A legacy hit is written again under the new key, so a later change of the address still finds it; the
 * legacy file stays. `key` is the new key, the one to write a fresh answer under.
 */
export function readKeyed(
  cache: SourceCache,
  path: string,
  params: Record<string, string | number>,
  mailto: string | null
): { key: string; hit: unknown } {
  const key = cacheKey(path, params);
  const hit = cache.read(key);
  if (hit !== undefined || mailto === null) return { key, hit };
  const legacy = cache.read(cacheKey(path, { ...params, mailto }));
  if (legacy !== undefined) {
    try {
      cache.write(key, legacy);
    } catch {
      /* the copy is a convenience; the legacy entry was found all the same */
    }
  }
  return { key, hit: legacy };
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
