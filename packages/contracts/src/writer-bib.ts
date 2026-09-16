/**
 * Writer export bibliography assembly (Stage 10 M3, plan §5): filter the
 * whole-library `library.bib` down to the entries a manuscript actually cites.
 * Pure string processing — entries are lifted VERBATIM (no reformatting, so
 * the user's library content is byte-stable), in first-citation order.
 */

/** One raw BibTeX entry span. */
interface BibEntry {
  /** cite key (trimmed, as written). */
  key: string;
  /** The full `@type{key, … }` source text, trimmed of surrounding blank lines. */
  text: string;
}

/**
 * Minimal entry scanner: `@type{key, …}` / `@type(…)` with balanced
 * braces/parens. Heuristic by design (quote-brace pathologies are not
 * handled); `library.bib` is machine-written by our own pipeline, so the
 * regular two-space format holds.
 */
export function scanBibEntries(bibText: string): BibEntry[] {
  const out: BibEntry[] = [];
  let i = 0;
  while (i < bibText.length) {
    const at = bibText.indexOf("@", i);
    if (at < 0) break;
    const head = /^@([A-Za-z]+)\s*([({])/.exec(bibText.slice(at));
    if (!head) {
      i = at + 1;
      continue;
    }
    // @comment blocks are not entries; skip them wholesale.
    if ((head[1] ?? "").toLowerCase() === "comment") {
      i = at + head[0].length;
      continue;
    }
    const open = head[2] === "{" ? "{" : "(";
    const close = open === "{" ? "}" : ")";
    let depth = 0;
    const j = at + head[0].length;
    // key = up to the first top-level comma (depth 1)
    let keyEnd = -1;
    for (let k = j; k < bibText.length; k++) {
      const ch = bibText.charAt(k);
      if (ch === open) depth++;
      else if (ch === close) depth--;
      else if (ch === "," && depth === 0) {
        keyEnd = k;
        break;
      }
    }
    if (keyEnd < 0) break; // malformed: stop scanning
    const key = bibText.slice(j, keyEnd).trim();
    // continue to the balanced close
    let end = -1;
    depth = 1;
    for (let k = keyEnd + 1; k < bibText.length; k++) {
      const ch = bibText.charAt(k);
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          end = k + 1;
          break;
        }
      }
    }
    if (end < 0) break;
    if (key) out.push({ key, text: bibText.slice(at, end).trim() });
    i = end;
  }
  return out;
}

/**
 * Build the manuscript's `references.bib`: entries for `keys` (citation
 * order, deduped) lifted verbatim from `libraryBibText`. Keys not present in
 * the library yield a trailing `% missing: <key>` comment line each and are
 * returned in `missing` (callers surface them as warnings).
 */
export function buildBib(
  keys: string[],
  libraryBibText: string
): { bib: string; missing: string[] } {
  const byKey = new Map<string, string>();
  for (const e of scanBibEntries(libraryBibText)) if (!byKey.has(e.key)) byKey.set(e.key, e.text);
  const parts: string[] = [];
  const missing: string[] = [];
  for (const key of new Set(
    keys.includes("*") ? [...byKey.keys(), ...keys.filter((k) => k !== "*")] : keys
  )) {
    const entry = byKey.get(key);
    if (entry) parts.push(entry);
    else {
      missing.push(key);
      parts.push(`% missing: ${key}`);
    }
  }
  return { bib: parts.join("\n\n") + (parts.length ? "\n" : ""), missing };
}
