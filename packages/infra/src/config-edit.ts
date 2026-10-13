/**
 * Change one key of config.toml text and leave every other byte alone. Pure: text in, text out, nothing read or
 * written (the file side is `config-write.ts`).
 *
 * Only two shapes are edited: `key = scalar` at the top level, and `key = scalar` directly under a one-level table
 * header (`[ui]`). The value's bytes are replaced, or the key's line is removed ("restore default"), or a new line
 * is added; the key, the spacing around `=`, the comment at the end of the line, every other line, the line
 * endings and a leading byte order mark stay as they were. Anything else the key could be written as is refused
 * with a category, and a refusal carries no text of the file.
 *
 * The rules:
 *
 * - The key's name is matched after unquoting, so `"port" = 1` and `'port' = 1` are the key `port`; the key's own
 *   bytes are not rewritten. A table header is matched the same way (`[ ui ]`, `["ui"]`, a comment after it).
 * - Setting a key to the value it already has changes nothing (`port = 0x10` stays when 16 is asked for).
 * - Restoring the default of a key the file does not set changes nothing. Removing a line removes that line and its
 *   own line ending and nothing else: a table header left without keys stays, and when the removed line was the
 *   last one and had no line ending, the file now ends with the line ending of the line before it.
 * - A new line goes after the last `key = value` line of its section (top level: the lines before the first table
 *   header; a table: the lines after its header up to the next header), with that line's indentation. A table with
 *   no key yet gets it right after the header. A top level with no key yet gets it just above the first header and
 *   the comment lines directly attached to it, or at the end of a file that has no header.
 * - A key of a table the file does not have gets the header and the key at the end of the file, after one blank
 *   line.
 * - A new line ends the way the line before it ends; with no line before it, the way the first line of the file
 *   ends; in a file without any line ending, with LF. A file whose last line has no line ending still has none
 *   afterwards (an empty file gets one).
 * - A string is written as a basic string with `"` and `\` escaped; other characters are written as they are. A
 *   string with a control character (U+0000–U+001F, U+007F) or an unpaired surrogate is refused, not escaped: no
 *   setting takes one. Integers are written in decimal; minus zero is zero.
 * - A bare value (a number, a boolean, a date) ends where the parser ends it: before everything JavaScript's
 *   `trimEnd` removes, which is more than the blank and the tab TOML allows (a no-break space, U+2028, U+FEFF, a
 *   form feed, a carriage return that is not part of a line ending, …). Those bytes are after the value and stay.
 * - A change that is neither `{ set: scalar }` nor `{ reset: true }` is `invalid_value`.
 * - `unsupported_layout`: the parser accepts the text and the line scan here does not follow it. It happens: the
 *   parser (smol-toml 1.8.0) reads a quoted key with no `=` after it together with the next line, and takes any one
 *   character after `[[a]` as the second `]`. The scan refuses both.
 * - The self-check: the result is parsed again; the key must have the asked value (or be gone), and every other
 *   value of the file must be what it was. `proposeConfigEdit` makes the candidate and `checkConfigEdit` judges it;
 *   `editConfigText` is the two together, and takes the proposing step as an argument so that the check can be
 *   shown to stop a bad candidate. The check compares parsed values, not how they are written: see
 *   `checkConfigEdit` for what it cannot see.
 */

import { isDeepStrictEqual } from "node:util";
import {
  checkSettingValue,
  isSettingKey,
  type SettingKey,
  type SettingValue,
  settingDef,
} from "@argelanderspace/contracts";
import { parse as parseToml, TomlDate } from "smol-toml";
import { CONFIG_FILE_BOM as BOM } from "./config.js";

/** Set a key to a value, or remove it so that its default applies. */
export type ConfigChange = { set: SettingValue } | { reset: true };

/**
 * Why an edit was refused. A category; never text from the file or the value.
 *
 *   unknown_key            not a key of the Settings schema
 *   invalid_value          the new value is not acceptable for the key, or the change is not a change at all
 *   unrepresentable_value  a string with a control character or an unpaired surrogate
 *   unparseable            the file is not TOML
 *   unsupported_layout     the file is TOML, but this editor could not follow how it is laid out
 *   duplicate_key          the key is written more than once
 *   dotted_key             the key, or its table, is written with a dotted key (`ui.theme = …`)
 *   inline_table           the key's value, or its table, is an inline table (`ui = { … }`)
 *   multiline_string       the key's value is a `"""` or `'''` string
 *   array_of_tables        the key's table is an array of tables (`[[ui]]`)
 *   not_a_scalar           the key's value is an array or a table
 *   table_not_a_table      the key's table is written as a plain value
 *   self_check_failed      the edited text did not parse back to exactly the intended change
 */
export const CONFIG_EDIT_REFUSALS = [
  "unknown_key",
  "invalid_value",
  "unrepresentable_value",
  "unparseable",
  "unsupported_layout",
  "duplicate_key",
  "dotted_key",
  "inline_table",
  "multiline_string",
  "array_of_tables",
  "not_a_scalar",
  "table_not_a_table",
  "self_check_failed",
] as const;
export type ConfigEditRefusal = (typeof CONFIG_EDIT_REFUSALS)[number];

export type ConfigEditResult =
  | { ok: true; text: string; changed: boolean }
  | { ok: false; reason: ConfigEditRefusal };

// --------------------------------------------------------------------------- //
// Layout scan: where the statements of a TOML text are
// --------------------------------------------------------------------------- //

type ValueKind = "basic" | "literal" | "ml-basic" | "ml-literal" | "array" | "inline" | "bare";

interface Header {
  array: boolean;
  path: string[];
  /** Start of the header's line and the position after its line ending. */
  lineStart: number;
  lineEnd: number;
}

interface Pair {
  /** The header the pair sits under; `null` at the top level. */
  header: Header | null;
  path: string[];
  lineStart: number;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
  valueKind: ValueKind;
  /** The position after the line ending of the line the value ends on. */
  lineEnd: number;
}

interface Layout {
  headers: Header[];
  pairs: Pair[];
}

class ScanError extends Error {}

const BARE_KEY = /[A-Za-z0-9_-]/;

/**
 * A change as the rest of this file uses it, or `null` when it is not one: exactly `{ set: scalar }` or exactly
 * `{ reset: true }`. Minus zero becomes zero (it is written `0` and reads back as zero).
 */
export function normalizeConfigChange(change: unknown): ConfigChange | null {
  if (typeof change !== "object" || change === null || Array.isArray(change)) return null;
  const keys = Object.keys(change);
  if (keys.length !== 1) return null;
  const record = change as Record<string, unknown>;
  if (keys[0] === "reset") return record.reset === true ? { reset: true } : null;
  if (keys[0] !== "set") return null;
  const value = record.set;
  if (typeof value === "number") return { set: value === 0 ? 0 : value };
  return typeof value === "string" || typeof value === "boolean" ? { set: value } : null;
}

/** The statements of `text` from `start` on. Throws ScanError on anything it does not recognise. */
function scan(text: string, start: number): Layout {
  const headers: Header[] = [];
  const pairs: Pair[] = [];
  let pos = start;
  let header: Header | null = null;
  /** Where the last bare value read ends; `pos` is left after what trails it. */
  let bareEnd = start;

  const fail = (): never => {
    throw new ScanError();
  };
  const at = (s: string): boolean => text.startsWith(s, pos);
  const skipBlank = (): void => {
    while (text[pos] === " " || text[pos] === "\t") pos++;
  };
  const atLineEnd = (): boolean => pos >= text.length || at("\n") || at("\r\n");
  const skipComment = (): void => {
    while (!atLineEnd()) pos++;
  };
  /** Blanks, an optional comment, then the line ending (or the end of the text). */
  const endLine = (): void => {
    skipBlank();
    if (at("#")) skipComment();
    if (pos >= text.length) return;
    if (at("\n")) pos += 1;
    else if (at("\r\n")) pos += 2;
    else fail();
  };
  /** Blanks, line endings and comments, inside an array or an inline table. */
  const skipFiller = (): void => {
    for (;;) {
      skipBlank();
      if (at("#")) skipComment();
      else if (at("\n")) pos += 1;
      else if (at("\r\n")) pos += 2;
      else return;
    }
  };

  const basicEscape = (): string => {
    // pos is on the backslash
    const c = text[pos + 1];
    const simple: Record<string, string> = {
      b: "\b",
      t: "\t",
      n: "\n",
      f: "\f",
      r: "\r",
      e: "\u001b",
      '"': '"',
      "\\": "\\",
    };
    if (c !== undefined && Object.hasOwn(simple, c)) {
      pos += 2;
      return simple[c] as string;
    }
    const width = c === "x" ? 2 : c === "u" ? 4 : c === "U" ? 8 : 0;
    const hex = text.slice(pos + 2, pos + 2 + width);
    if (width === 0 || hex.length !== width || !/^[0-9A-Fa-f]+$/.test(hex)) fail();
    const code = Number.parseInt(hex, 16);
    if (code > 0x10ffff) fail();
    pos += 2 + width;
    return String.fromCodePoint(code);
  };

  const key = (): string => {
    if (at('"')) {
      pos++;
      let out = "";
      for (;;) {
        if (atLineEnd()) fail();
        if (at('"')) break;
        if (at("\\")) out += basicEscape();
        else out += text[pos++];
      }
      pos++;
      return out;
    }
    if (at("'")) {
      const end = text.indexOf("'", pos + 1);
      if (end === -1 || text.slice(pos, end).includes("\n")) fail();
      const out = text.slice(pos + 1, end);
      pos = end + 1;
      return out;
    }
    const from = pos;
    while (pos < text.length && BARE_KEY.test(text[pos] as string)) pos++;
    if (pos === from) fail();
    return text.slice(from, pos);
  };
  const keyPath = (): string[] => {
    const path: string[] = [];
    for (;;) {
      skipBlank();
      path.push(key());
      skipBlank();
      if (!at(".")) return path;
      pos++;
    }
  };

  const multiline = (quote: string, escapes: boolean): void => {
    pos += 3;
    for (;;) {
      if (pos >= text.length) fail();
      if (escapes && at("\\")) pos += 2;
      else if (at(quote + quote + quote)) {
        pos += 3;
        // One or two quotes right before the closing three belong to the string.
        for (let extra = 0; extra < 2 && at(quote); extra++) pos++;
        return;
      } else pos++;
    }
  };
  const value = (): ValueKind => {
    if (at('"""')) {
      multiline('"', true);
      return "ml-basic";
    }
    if (at("'''")) {
      multiline("'", false);
      return "ml-literal";
    }
    if (at('"')) {
      pos++;
      for (;;) {
        if (atLineEnd()) fail();
        if (at("\\")) pos += 2;
        else if (at('"')) break;
        else pos++;
      }
      pos++;
      return "basic";
    }
    if (at("'")) {
      pos++;
      for (;;) {
        if (atLineEnd()) fail();
        if (at("'")) break;
        pos++;
      }
      pos++;
      return "literal";
    }
    if (at("[")) {
      pos++;
      for (;;) {
        skipFiller();
        if (at("]")) break;
        value();
        skipFiller();
        if (at(",")) pos++;
        else if (!at("]")) fail();
      }
      pos++;
      return "array";
    }
    if (at("{")) {
      pos++;
      for (;;) {
        skipFiller();
        if (at("}")) break;
        keyPath();
        if (!at("=")) fail();
        pos++;
        skipBlank();
        value();
        skipFiller();
        if (at(",")) pos++;
        else if (!at("}")) fail();
      }
      pos++;
      return "inline";
    }
    const from = pos;
    while (!atLineEnd() && !"#,]}".includes(text[pos] as string)) pos++;
    // The parser ends a bare value with `trimEnd`, which removes more than blanks and tabs. What it removes is
    // not part of the value, and `pos` stays after it: it is on the line, and nothing here reads it again.
    bareEnd = from + text.slice(from, pos).trimEnd().length;
    if (bareEnd === from) fail();
    return "bare";
  };

  while (pos < text.length) {
    const lineStart = pos;
    skipBlank();
    if (pos >= text.length) break;
    if (at("\n") || at("\r\n") || at("#")) {
      endLine();
      continue;
    }
    if (at("[")) {
      const array = at("[[");
      pos += array ? 2 : 1;
      const path = keyPath();
      if (!at(array ? "]]" : "]")) fail();
      pos += array ? 2 : 1;
      endLine();
      header = { array, path, lineStart, lineEnd: pos };
      headers.push(header);
      continue;
    }
    const keyStart = pos;
    const path = keyPath();
    if (!at("=")) fail();
    pos++;
    skipBlank();
    const valueStart = pos;
    const valueKind = value();
    const valueEnd = valueKind === "bare" ? bareEnd : pos;
    endLine();
    pairs.push({
      header,
      path,
      lineStart,
      keyStart,
      valueStart,
      valueEnd,
      valueKind,
      lineEnd: pos,
    });
  }
  return { headers, pairs };
}

// --------------------------------------------------------------------------- //
// Proposing an edit
// --------------------------------------------------------------------------- //

function parseOrNull(body: string): Record<string, unknown> | null {
  try {
    return parseToml(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((part, i) => part === b[i]);
}

function isPlainTable(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

/** No control character and no unpaired surrogate: what a basic string can hold on one line and UTF-8 can carry. */
function representable(value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is looked for
  return !/[\u0000-\u001f\u007f]/.test(value) && !/\p{Cs}/u.test(value);
}

function literal(value: SettingValue): string {
  if (typeof value === "string") {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return String(value);
}

/** The line ending right before `pos`, when `pos` is the start of a line that has one before it. */
function endingBefore(text: string, pos: number): string | null {
  if (text[pos - 1] !== "\n") return null;
  return text[pos - 2] === "\r" ? "\r\n" : "\n";
}

function firstEnding(text: string): string {
  const at = text.indexOf("\n");
  if (at === -1) return "\n";
  return text[at - 1] === "\r" ? "\r\n" : "\n";
}

/** Put a whole line in at `pos`, which is the start of a line or the end of the text; `floor` is where the text starts. */
function insertLine(text: string, pos: number, line: string, floor: number): string {
  const ending = endingBefore(text, pos) ?? firstEnding(text);
  // At the end of a text whose last line has no line ending: the new line becomes the unterminated last line.
  if (pos === text.length && pos > floor && endingBefore(text, pos) === null) {
    return `${text}${ending}${line}`;
  }
  return `${text.slice(0, pos)}${line}${ending}${text.slice(pos)}`;
}

/** The start of the comment lines directly above `pos` (a line start), or `pos` when there are none. */
function attachedCommentStart(text: string, pos: number, floor: number): number {
  let start = pos;
  while (start > floor) {
    const previousStart = text.lastIndexOf("\n", start - 2) + 1;
    const from = Math.max(previousStart, floor);
    if (!/^[ \t]*#/.test(text.slice(from, start))) break;
    start = from;
  }
  return start;
}

/**
 * Make the edited text, without judging it. Refuses what the editor does not handle; what it returns still has to
 * pass `checkConfigEdit`.
 */
export function proposeConfigEdit(
  text: string,
  key: string,
  asked: ConfigChange
): ConfigEditResult {
  const refuse = (reason: ConfigEditRefusal): ConfigEditResult => ({ ok: false, reason });
  const unchanged: ConfigEditResult = { ok: true, text, changed: false };
  if (!isSettingKey(key)) return refuse("unknown_key");
  const change = normalizeConfigChange(asked);
  if (change === null) return refuse("invalid_value");
  const { table, name } = settingDef(key);
  if ("set" in change) {
    if (checkSettingValue(key, change.set) !== null) return refuse("invalid_value");
    if (typeof change.set === "string" && !representable(change.set)) {
      return refuse("unrepresentable_value");
    }
  }

  const bodyStart = text.startsWith(BOM) ? 1 : 0;
  const doc = parseOrNull(text.slice(bodyStart));
  let layout: Layout;
  try {
    layout = scan(text, bodyStart);
  } catch {
    return refuse(doc === null ? "unparseable" : "unsupported_layout");
  }
  const { headers, pairs } = layout;

  const section = table === null ? [] : [table];
  const inSection = (pair: Pair): boolean =>
    pair.header === null
      ? table === null
      : !pair.header.array && sameStrings(pair.header.path, section);
  const direct = pairs.filter((pair) => inSection(pair) && sameStrings(pair.path, [name]));
  if (direct.length > 1) return refuse("duplicate_key");
  if (doc === null) return refuse("unparseable");

  // The other ways the key, or the table it belongs to, can come to exist.
  const topLevel = pairs.filter((pair) => pair.header === null);
  if (table === null) {
    if (topLevel.some((pair) => pair.path.length > 1 && pair.path[0] === name)) {
      return refuse("dotted_key");
    }
    const asTable = headers.find((header) => header.path[0] === name);
    if (asTable) return refuse(asTable.array ? "array_of_tables" : "not_a_scalar");
  } else {
    const written = topLevel.find((pair) => pair.path[0] === table);
    if (written) {
      if (written.path.length > 1) return refuse("dotted_key");
      return refuse(written.valueKind === "inline" ? "inline_table" : "table_not_a_table");
    }
    if (headers.some((header) => header.array && sameStrings(header.path, section))) {
      return refuse("array_of_tables");
    }
    if (headers.some((header) => sameStrings(header.path.slice(0, 2), [table, name]))) {
      return refuse("not_a_scalar");
    }
  }
  if (pairs.some((pair) => inSection(pair) && pair.path.length > 1 && pair.path[0] === name)) {
    return refuse("dotted_key");
  }

  const existing = direct[0];
  if (existing) {
    if (existing.valueKind === "ml-basic" || existing.valueKind === "ml-literal") {
      return refuse("multiline_string");
    }
    if (existing.valueKind === "inline") return refuse("inline_table");
    if (existing.valueKind === "array") return refuse("not_a_scalar");
    if ("reset" in change) {
      return {
        ok: true,
        text: text.slice(0, existing.lineStart) + text.slice(existing.lineEnd),
        changed: true,
      };
    }
    const holder = table === null ? doc : doc[table];
    if (isPlainTable(holder) && Object.is(holder[name], change.set)) return unchanged;
    return {
      ok: true,
      text:
        text.slice(0, existing.valueStart) + literal(change.set) + text.slice(existing.valueEnd),
      changed: true,
    };
  }

  if ("reset" in change) return unchanged;
  const line = `${name} = ${literal(change.set)}`;
  const ownHeader = headers.find((header) => !header.array && sameStrings(header.path, section));
  const sectionPairs = pairs.filter(inSection);
  const last = sectionPairs[sectionPairs.length - 1];
  if (last) {
    const indent = text.slice(last.lineStart, last.keyStart);
    return {
      ok: true,
      text: insertLine(text, last.lineEnd, indent + line, bodyStart),
      changed: true,
    };
  }
  if (table !== null && ownHeader) {
    return { ok: true, text: insertLine(text, ownHeader.lineEnd, line, bodyStart), changed: true };
  }
  if (table === null) {
    const firstHeader = headers[0];
    const pos = firstHeader
      ? attachedCommentStart(text, firstHeader.lineStart, bodyStart)
      : text.length;
    return { ok: true, text: insertLine(text, pos, line, bodyStart), changed: true };
  }
  // A new table at the end of the file, after one blank line.
  let out = text;
  if (out.length > bodyStart) {
    const open = endingBefore(out, out.length) === null;
    const ending = endingBefore(out, out.length) ?? firstEnding(out);
    if (open) {
      return {
        ok: true,
        text: `${out}${ending}${ending}[${table}]${ending}${line}`,
        changed: true,
      };
    }
    if (!/(?:^|\n)[ \t]*\r?\n$/.test(out.slice(bodyStart))) out += ending;
  }
  out = insertLine(out, out.length, `[${table}]`, out.length);
  return { ok: true, text: insertLine(out, out.length, line, 0), changed: true };
}

// --------------------------------------------------------------------------- //
// The self-check
// --------------------------------------------------------------------------- //

/**
 * Whether two parsed documents have dates of the same kind in the same places. `isDeepStrictEqual` compares two
 * dates by their instant, and the parser gives a local date, a local time, a local date-time and a date-time with
 * an offset the same `Date` when they fall on the same instant; its `toISOString` writes each kind, and the offset,
 * differently.
 */
function sameDates(a: unknown, b: unknown): boolean {
  if (a instanceof TomlDate || b instanceof TomlDate) {
    return a instanceof TomlDate && b instanceof TomlDate && a.toISOString() === b.toISOString();
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.every((item, i) => sameDates(item, b[i]));
  if (isPlainTable(a) && isPlainTable(b)) {
    return Object.keys(a).every((name) => sameDates(a[name], b[name]));
  }
  return true;
}

/**
 * Whether `candidate` is `original` with exactly this change: it parses, the key has the asked value (or is gone),
 * every other value is what it was, and the byte order mark is as it was. A table of the key that is left or made
 * empty counts as no value. A change that is not well formed is never accepted.
 *
 * It compares what the parser returns, not the text. Seen: a value of another type or another amount, a missing or
 * an added key, the order of an array, a date of another kind (local date, local time, local date-time, date-time
 * with an offset) or under another offset. Not seen, because the parser returns the same thing for both: another
 * writing of the same value (`1.0` and `1`, `nan` and `-nan`, `0x10` and `16`, `"a"` and `'a'`, a date-time with
 * `T` or with a blank), comments and blank lines, and the order of the keys. Those stay as they were because the
 * proposing step leaves every other line alone, not because this check would notice.
 */
export function checkConfigEdit(
  original: string,
  candidate: string,
  key: SettingKey,
  asked: ConfigChange
): boolean {
  const change = normalizeConfigChange(asked);
  if (change === null) return false;
  if (original.startsWith(BOM) !== candidate.startsWith(BOM)) return false;
  const body = (text: string): string => (text.startsWith(BOM) ? text.slice(1) : text);
  const before = parseOrNull(body(original));
  const after = parseOrNull(body(candidate));
  if (before === null || after === null) return false;
  const { table, name } = settingDef(key);

  const holderOf = (doc: Record<string, unknown>): Record<string, unknown> | null => {
    if (table === null) return doc;
    if (!Object.hasOwn(doc, table)) return null;
    const inner = doc[table];
    return isPlainTable(inner) ? inner : null;
  };
  const holder = holderOf(after);
  const has = holder !== null && Object.hasOwn(holder, name);
  if ("set" in change) {
    if (!has || !Object.is(holder[name], change.set)) return false;
  } else if (has) return false;

  for (const doc of [before, after]) {
    const inner = holderOf(doc);
    if (inner === null) continue;
    delete inner[name];
    if (table !== null && Object.keys(inner).length === 0) delete doc[table];
  }
  return isDeepStrictEqual(before, after) && sameDates(before, after);
}

/**
 * Change one key of config.toml text. `changed: false` means the text already says what was asked and is returned
 * as it came. A refusal changes nothing. `propose` is the step that makes the candidate; whatever it returns is
 * only handed back after `checkConfigEdit` has accepted it.
 */
export function editConfigText(
  text: string,
  key: string,
  change: ConfigChange,
  propose: typeof proposeConfigEdit = proposeConfigEdit
): ConfigEditResult {
  if (isSettingKey(key) && normalizeConfigChange(change) === null)
    return { ok: false, reason: "invalid_value" };
  const proposed = propose(text, key, change);
  if (!proposed.ok || !proposed.changed) return proposed;
  if (!isSettingKey(key) || !checkConfigEdit(text, proposed.text, key, change)) {
    return { ok: false, reason: "self_check_failed" };
  }
  return proposed;
}
