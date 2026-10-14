/**
 * The line editor against generated files. A fixed seed builds config files out of pieces — comments, blank lines,
 * known keys in every way they can be written, unknown keys with values that span lines and contain text that looks
 * like keys and headers, tables, sub-tables and arrays of tables, with LF, CRLF or mixed line endings, with and
 * without a byte order mark or a final line ending — and applies random edits. Each result is judged without the
 * editor's own self-check:
 *
 *   - re-parsed, the document is the original with exactly the asked change (deep equality, built independently);
 *   - a replaced value: the text is the pieces with that one value replaced (every other byte identical);
 *   - a removed key: the text is the pieces without that one line;
 *   - an added key: the text is the original with one run of bytes inserted, and the run is the new line (and the
 *     new header) with line endings the file already uses;
 *   - a refusal: the category is the one the way the key was written calls for.
 *
 * 4000 files and 16000 edits take a few seconds alone and several times that beside the other test files, hence
 * the timeout.
 */

import { isDeepStrictEqual } from "node:util";
import { SETTING_KEYS, SETTINGS_SCHEMA, type SettingKey } from "@argelanderspace/contracts";
import { parse as parseToml } from "smol-toml";
import { expect, test } from "vitest";
import { type ConfigChange, type ConfigEditRefusal, editConfigText } from "../src/config-edit.js";

const BOM = "\uFEFF";

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Form = "absent" | "scalar" | "multiline" | "inline" | "array";
type UiMode = "absent" | "header" | "implicit" | "dotted" | "inline" | "array" | "scalar";

/** A known key's line, in the parts the editor must and must not touch. */
interface KnownLine {
  key: SettingKey;
  prefix: string;
  raw: string;
  suffix: string;
}
type Piece = string | KnownLine;

interface Generated {
  text: string;
  /** The pieces whose concatenation is the text after the byte order mark; each ends with its line ending. */
  pieces: Piece[];
  forms: Record<SettingKey, Form>;
  ui: UiMode;
  bom: boolean;
}

const STRINGS = [
  '"lit"',
  "'lit'",
  '"a \\" # b = 1"',
  "'C:\\tex # x'",
  '"\\u00e9t\\u00e9"',
  '"文献/吴"',
  '""',
  "''",
  '"/abs/path"',
  '"dark"',
  '"zh-CN"',
  '"debug"',
];
const INTS = ["1859", "0x10", "1_000", "+1", "0", "0o17", "0b101", "70000", "-1"];
const OTHERS = ["true", "false", "1.5", "1979-05-27", "1979-05-27 07:32:00", "inf", "-nan", "1e3"];
const NAMES_IN_TABLES = ["port", "theme", "language", "labels", "x", "data_dir", "log_level"];

function generate(next: () => number): Generated {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const chance = (p: number): boolean => next() < p;
  const endingMode = pick(["lf", "crlf", "mixed"] as const);
  const ending = (): string =>
    endingMode === "lf" ? "\n" : endingMode === "crlf" ? "\r\n" : chance(0.5) ? "\n" : "\r\n";
  const ws = (): string => pick(["", " ", " ", "  ", "\t"]);
  const indent = (): string => pick(["", "", "", "  ", "\t"]);
  const comment = (): string =>
    pick(["", "", " # note", "# port = 1", "\t# [ui]", ' # theme = "x" = y', " #"]);
  const keyText = (name: string): string => pick([name, name, name, `"${name}"`, `'${name}'`]);
  const scalar = (): string => pick([...STRINGS, ...INTS, ...OTHERS]);
  const multilineString = (): string => {
    const nl = ending();
    return pick([
      `"""${nl}port = 1${nl}[ui]${nl}theme = "x"${nl}"""`,
      `'''${nl}port = 2${nl}"""${nl}[[ui]]${nl}'''`,
      '"""one line"""',
      "'''one ' line'''",
      `"""a \\${nl}   b\\" ""x"""`,
      '"""say "hi""""',
      `'''x''${nl}''y'''''`,
    ]);
  };
  const arrayValue = (): string => {
    const nl = ending();
    return pick([
      "[1, 2]",
      "[]",
      `[${nl}  "port = 1", # ] port = 2${nl}  '[ui]',${nl}]`,
      `[ [1, 2], { a = "]" } ]`,
      `[${nl}${nl}  1 ,${nl}  2${nl}  # c${nl}]`,
    ]);
  };
  const inlineValue = (): string =>
    pick(["{ x = 1 }", "{}", '{ port = 1, theme = "}" }', "{ a = { b = [1, { c = 2 }] } }"]);
  const anyValue = (): string => {
    const r = next();
    if (r < 0.55) return scalar();
    if (r < 0.75) return multilineString();
    if (r < 0.9) return arrayValue();
    return inlineValue();
  };

  const forms = {} as Record<SettingKey, Form>;
  for (const key of SETTING_KEYS) forms[key] = "absent";
  const pieces: Piece[] = [];
  let unknown = 0;
  const filler = (): string =>
    pick([
      `${ending()}`,
      `${ws()}${ending()}`,
      `# a comment${ending()}`,
      `  # port = 1${ending()}`,
      `#[ui]${ending()}`,
      `# theme = "dark"${ending()}`,
    ]);
  const unknownLine = (): string => {
    const name = pick([
      `u${unknown}`,
      `"u ${unknown}"`,
      `'u.${unknown}'`,
      `u${unknown}.sub`,
      `u${unknown}.port`,
    ]);
    unknown++;
    return `${indent()}${name}${ws()}=${ws()}${anyValue()}${ws()}${comment()}${ending()}`;
  };
  const knownLine = (key: SettingKey, inUi: boolean): Piece => {
    const name = SETTINGS_SCHEMA[key].name;
    const r = next();
    const form: Form = r < 0.7 ? "scalar" : r < 0.8 ? "multiline" : r < 0.9 ? "inline" : "array";
    forms[key] = form;
    const prefix = `${indent()}${keyText(name)}${ws()}=${ws()}`;
    const suffix = `${ws()}${comment()}${ending()}`;
    if (form === "scalar") return { key, prefix, raw: scalar(), suffix };
    void inUi;
    const raw =
      form === "multiline" ? multilineString() : form === "inline" ? inlineValue() : arrayValue();
    return `${prefix}${raw}${suffix}`;
  };
  const shuffle = <T>(items: T[]): T[] => {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [items[i], items[j]] = [items[j] as T, items[i] as T];
    }
    return items;
  };

  // The top level.
  const ui = pick([
    "absent",
    "absent",
    "header",
    "header",
    "header",
    "implicit",
    "dotted",
    "inline",
    "array",
    "scalar",
  ] as const);
  const top: Piece[] = [];
  for (const key of SETTING_KEYS) {
    if (SETTINGS_SCHEMA[key].table === null && chance(0.35)) top.push(knownLine(key, false));
  }
  for (let i = Math.floor(next() * 4); i > 0; i--) top.push(unknownLine());
  for (let i = Math.floor(next() * 4); i > 0; i--) top.push(filler());
  if (ui === "dotted") {
    top.push(
      `ui.${pick(["theme", "labels", "extra.x"])}${ws()}=${ws()}${pick(['"dark"', "true"])}${comment()}${ending()}`
    );
  } else if (ui === "inline") {
    top.push(
      `ui = ${pick(['{ theme = "dark" }', "{}", "{ labels = true, x = 1 }"])}${comment()}${ending()}`
    );
  } else if (ui === "scalar") {
    top.push(`ui = ${pick(["3", '"dark"', "[1]", '[{ theme = "dark" }]'])}${comment()}${ending()}`);
  }
  pieces.push(...shuffle(top));

  // The tables.
  const tables: Piece[][] = [];
  const body = (): Piece[] => {
    const lines: Piece[] = [];
    for (const name of shuffle([...NAMES_IN_TABLES]).slice(0, Math.floor(next() * 4))) {
      lines.push(
        `${indent()}${keyText(name)}${ws()}=${ws()}${anyValue()}${ws()}${comment()}${ending()}`
      );
    }
    for (let i = Math.floor(next() * 3); i > 0; i--) lines.push(filler());
    return shuffle(lines);
  };
  const headerLine = (inner: string, array = false): string => {
    const [open, close] = array ? ["[[", "]]"] : ["[", "]"];
    return `${indent()}${open}${ws()}${inner}${ws()}${close}${ws()}${comment()}${ending()}`;
  };
  if (ui === "header") {
    const lines: Piece[] = [];
    for (const key of SETTING_KEYS) {
      if (SETTINGS_SCHEMA[key].table === "ui" && chance(0.4)) lines.push(knownLine(key, true));
    }
    for (let i = Math.floor(next() * 3); i > 0; i--) lines.push(filler());
    for (let i = Math.floor(next() * 2); i > 0; i--) lines.push(unknownLine());
    tables.push([headerLine(pick(["ui", "ui", '"ui"', "'ui'"])), ...shuffle(lines)]);
  }
  if (ui === "array") {
    for (let i = 1 + Math.floor(next() * 2); i > 0; i--)
      tables.push([headerLine("ui", true), ...body()]);
  }
  if (ui === "implicit" || (ui === "header" && chance(0.3))) {
    tables.push([headerLine(pick(["ui.extra", 'ui . "extra"'])), ...body()]);
  }
  if (chance(0.5)) tables.push([headerLine("other"), ...body()]);
  if (chance(0.3)) tables.push([headerLine("other2.sub"), ...body()]);
  if (chance(0.3)) tables.push([headerLine("port_like"), ...body()]);
  for (let i = Math.floor(next() * 3); i > 0; i--)
    tables.push([headerLine("rows", true), ...body()]);
  // Tables of one array stay in order relative to each other only by name; any order is valid TOML here.
  for (const table of shuffle(tables)) pieces.push(...table);

  // Maybe no line ending on the last line.
  const last = pieces[pieces.length - 1];
  if (last !== undefined && chance(0.3)) {
    const strip = (s: string): string => s.replace(/\r?\n$/, "");
    pieces[pieces.length - 1] =
      typeof last === "string" ? strip(last) : { ...last, suffix: strip(last.suffix) };
  }
  const bom = chance(0.2);
  const text = (bom ? BOM : "") + pieces.map(render).join("");
  return { text, pieces, forms, ui, bom };
}

function render(piece: Piece): string {
  return typeof piece === "string" ? piece : piece.prefix + piece.raw + piece.suffix;
}

function parse(text: string): Record<string, unknown> {
  return parseToml(text.startsWith(BOM) ? text.slice(1) : text) as Record<string, unknown>;
}

/** A value the key accepts, written the way the editor must write it. */
function newValue(key: SettingKey, next: () => number): string | number | boolean {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const type = SETTINGS_SCHEMA[key].type;
  const tail = pick([
    "lit",
    'q"uo"te',
    "back\\slash",
    "文献 # 吴",
    "C:\\x\\y",
    "sp ace",
    "é😀",
    "a'b",
    "\\",
    '\\"',
  ]);
  switch (type.kind) {
    case "boolean":
      return next() < 0.5;
    case "integer":
      return pick([0, 1, 16, 1000, 1859, 65535, Math.floor(next() * 65536)]);
    case "enum":
      return pick(type.values);
    case "string":
      // An address keeps the shape the schema asks for (desktop-app ticket 11); the tail is not used.
      if ("format" in type && type.format === "email")
        return pick(["a@example.org", "first.last+tag@sub.example.com", "x_y@ex-ample.net"]);
      if ("path" in type && type.path === "absolute")
        return pick(["/", "C:\\", "\\\\host\\"]) + tail;
      if ("path" in type && type.path === "relative")
        return pick(["x", "./", "../", "lit/"]) + tail;
      return tail;
  }
}

const literal = (value: string | number | boolean): string =>
  typeof value === "string" ? JSON.stringify(value) : String(value);

function expectedRefusal(g: Generated, key: SettingKey): ConfigEditRefusal | null {
  const form = g.forms[key];
  if (SETTINGS_SCHEMA[key].table === "ui") {
    if (g.ui === "dotted") return "dotted_key";
    if (g.ui === "inline") return "inline_table";
    if (g.ui === "scalar") return "table_not_a_table";
    if (g.ui === "array") return "array_of_tables";
  }
  if (form === "multiline") return "multiline_string";
  if (form === "inline") return "inline_table";
  if (form === "array") return "not_a_scalar";
  return null;
}

test("generated files and random edits: the change asked for and no other byte", () => {
  const next = prng(20261013);
  const seen = { replaced: 0, removed: 0, added: 0, addedTable: 0, unchanged: 0, refused: 0 };
  const refusals = new Set<string>();
  for (let round = 0; round < 4000; round++) {
    const g = generate(next);
    const where = `round ${round}: ${JSON.stringify(g.text)}`;
    const before = parse(g.text); // the generator only makes valid TOML
    for (let n = 0; n < 4; n++) {
      const key = SETTING_KEYS[Math.floor(next() * SETTING_KEYS.length)] as SettingKey;
      const { table, name } = SETTINGS_SCHEMA[key];
      const value = newValue(key, next);
      const change: ConfigChange = next() < 0.3 ? { reset: true } : { set: value };
      const what = `${where}\n${key} ${JSON.stringify(change)}`;
      const got = editConfigText(g.text, key, change);

      const refusal = expectedRefusal(g, key);
      if (refusal !== null) {
        expect(got, what).toEqual({ ok: false, reason: refusal });
        seen.refused++;
        refusals.add(refusal);
        continue;
      }
      if (!got.ok) throw new Error(`refused (${got.reason}) — ${what}`);

      // The document: the original with exactly this change.
      const expected = parse(g.text);
      const holder = (table === null ? expected : expected[table]) as
        | Record<string, unknown>
        | undefined;
      const current = holder?.[name];
      if ("set" in change) {
        if (table !== null && holder === undefined) expected[table] = { [name]: change.set };
        else (holder as Record<string, unknown>)[name] = change.set;
      } else if (holder !== undefined) delete holder[name];
      const after = parse(got.text);
      expect(isDeepStrictEqual(after, expected), what).toBe(true);
      expect(got.text.startsWith(BOM), what).toBe(g.bom);

      // The bytes.
      const at = g.pieces.findIndex((piece) => typeof piece !== "string" && piece.key === key);
      const present = g.forms[key] === "scalar";
      expect(at !== -1, what).toBe(present);
      const prefixBom = g.bom ? BOM : "";
      if ("reset" in change) {
        if (!present) {
          expect(got, what).toEqual({ ok: true, text: g.text, changed: false });
          seen.unchanged++;
        } else {
          const pieces = g.pieces.filter((_, i) => i !== at);
          expect(got.text, what).toBe(prefixBom + pieces.map(render).join(""));
          expect(got.changed, what).toBe(true);
          seen.removed++;
        }
      } else if (present) {
        if (Object.is(current, change.set)) {
          expect(got, what).toEqual({ ok: true, text: g.text, changed: false });
          seen.unchanged++;
        } else {
          const pieces = g.pieces.map((piece, i) =>
            i === at ? { ...(piece as KnownLine), raw: literal(change.set) } : piece
          );
          expect(got.text, what).toBe(prefixBom + pieces.map(render).join(""));
          seen.replaced++;
        }
      } else {
        // One run of bytes was inserted, and it is the new line, a new header if the table was missing, and
        // line endings.
        const grown = got.text.length - g.text.length;
        expect(grown, what).toBeGreaterThan(0);
        const runs: string[] = [];
        for (let i = 0; i <= g.text.length; i++) {
          if (got.text.slice(0, i) !== g.text.slice(0, i)) break;
          if (got.text.slice(i + grown) === g.text.slice(i))
            runs.push(got.text.slice(i, i + grown));
        }
        expect(runs.length, what).toBeGreaterThan(0);
        const escaped = `${name} = ${literal(change.set)}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const newTable = table !== null && (before[table] === undefined || g.ui === "implicit");
        const shape = new RegExp(
          newTable
            ? `^(\\r?\\n){0,2}\\[${table}\\]\\r?\\n${escaped}(\\r?\\n)?$`
            : `^(\\r?\\n)?[ \\t]*${escaped}(\\r?\\n)?$`
        );
        expect(
          runs.some((run) => shape.test(run)),
          `${what}\n${JSON.stringify(runs)}`
        ).toBe(true);
        const run = runs.find((r) => shape.test(r)) as string;
        const endings = run.match(/\r?\n/g) ?? [];
        expect(endings.length, what).toBeGreaterThan(0);
        const fileEndings = new Set(g.text.match(/\r?\n/g) ?? ["\n"]);
        for (const e of endings) expect(fileEndings.has(e), what).toBe(true);
        // A file ends with a line ending afterwards exactly when it did before (an empty file gets one).
        const body = g.text.slice(prefixBom.length);
        expect(got.text.endsWith("\n"), what).toBe(body === "" || g.text.endsWith("\n"));
        if (newTable) seen.addedTable++;
        else seen.added++;
      }
    }
  }
  // The run exercised every outcome, many times over.
  for (const [outcome, count] of Object.entries(seen)) expect(count, outcome).toBeGreaterThan(200);
  expect([...refusals].sort()).toEqual([
    "array_of_tables",
    "dotted_key",
    "inline_table",
    "multiline_string",
    "not_a_scalar",
    "table_not_a_table",
  ]);
}, 120_000);
