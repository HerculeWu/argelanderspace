/**
 * Low-level balanced-brace scanning shared by the compiler-facts parsers.
 *
 * The parsers consume fact files written by TeX itself; they are small
 * total scanners, not a TeX parser: malformed input yields partial
 * results, never an exception.
 */

export interface TexGroup {
  /** Text between the braces (outer braces stripped, nesting preserved). */
  content: string;
  /** Index one past the closing brace. */
  end: number;
}

/** Read a balanced `{...}` group; `text[open]` must be "{". Null if unbalanced. */
export function readTexGroup(text: string, open: number): TexGroup | null {
  if (text[open] !== "{") return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++; // skip escaped char (\{ \} \\ ...)
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { content: text.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** Skip whitespace (including newlines) from `from`. */
export function skipTexWhitespace(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i] ?? "")) i++;
  return i;
}

/**
 * Yield the index just past each `\name` command token in `text`.
 * A following command letter means a different command (`\newlabels`)
 * and the occurrence is skipped.
 */
export function* texCommandPositions(text: string, name: string): Generator<number> {
  const needle = `\\${name}`;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) return;
    from = at + needle.length;
    const next = text[from];
    if (next !== undefined && /[a-zA-Z@]/.test(next)) continue;
    yield from;
  }
}

/** Read `count` consecutive brace groups (whitespace between them allowed). */
export function readTexGroups(text: string, from: number, count: number): TexGroup[] | null {
  const groups: TexGroup[] = [];
  let i = from;
  for (let n = 0; n < count; n++) {
    i = skipTexWhitespace(text, i);
    const g = readTexGroup(text, i);
    if (!g) return null;
    groups.push(g);
    i = g.end;
  }
  return groups;
}
