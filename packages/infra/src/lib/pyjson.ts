/**
 * Python-`json.dumps`-compatible JSON for the metadata-source disk-cache keys.
 *
 * The Python clients key their disk cache with
 * `sha1(path + "?" + json.dumps(params, sort_keys=True))`. Reproducing that
 * serialization byte-for-byte (key order, `", "`/`": "` separators,
 * `ensure_ascii` `\uXXXX` escaping) means the TS clients reuse the *existing*
 * `data/library/cache/{ads,crossref,openalex}/<sha1>.json` entries written by
 * the Python pipeline instead of cold-refetching every query.
 *
 * Only the JSON value shapes the sources actually put in params are supported:
 * strings, finite integers, booleans, null (no floats, no nested structures —
 * `rows: 5`, `per-page: 50`, `filter: "..."`, `q: "..."` are all flat scalars).
 */

/** Python `sorted(keys)` orders str by code point; JS `.sort()` is UTF-16 units. */
function compareCodePoints(a: string, b: string): number {
  const ai = Array.from(a);
  const bi = Array.from(b);
  const n = Math.min(ai.length, bi.length);
  for (let i = 0; i < n; i++) {
    const d = (ai[i]?.codePointAt(0) ?? 0) - (bi[i]?.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return ai.length - bi.length;
}

/** `json.dumps(str)` with ensure_ascii=True (the default). */
function dumpStr(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (cp >= 0x20 && cp < 0x7f) out += ch;
    else if (cp <= 0xffff) {
      out += `\\u${cp.toString(16).padStart(4, "0")}`;
    } else {
      // ensure_ascii emits astral chars as a UTF-16 surrogate pair.
      const u = cp - 0x10000;
      const hi = 0xd800 + (u >> 10);
      const lo = 0xdc00 + (u & 0x3ff);
      out += `\\u${hi.toString(16)}\\u${lo.toString(16)}`;
    }
  }
  return `${out}"`;
}

type CacheParam = string | number | boolean | null;

/** `json.dumps(params, sort_keys=True)` for a flat scalar dict. */
export function pyJsonStable(params: Record<string, CacheParam>): string {
  const keys = Object.keys(params).sort(compareCodePoints);
  const parts = keys.map((k) => {
    const v = params[k];
    let vs: string;
    if (typeof v === "string") vs = dumpStr(v);
    else if (v === null) vs = "null";
    else if (typeof v === "boolean") vs = v ? "true" : "false";
    else if (Number.isInteger(v)) vs = String(v);
    else throw new Error(`pyJsonStable: unsupported value for ${k}: ${String(v)}`);
    return `${dumpStr(k)}: ${vs}`;
  });
  return `{${parts.join(", ")}}`;
}
