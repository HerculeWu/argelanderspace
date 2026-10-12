/**
 * Argument-graph subcommands (论证图 ticket 07; ADR 0009, `docs/argument-graph.md` "CLI"):
 *
 *   argument get <workId>                       the Work's whole graph as JSON
 *   argument put <workId> <file> --rev <n> [--replace]
 *                                               replace the whole graph from a JSON file ("-" = stdin)
 *   pdf-path <docId>                            absolute path of a PDF Doc's original.pdf
 *
 * Direct disk access, no server. The read commands are truly read-only (no directory created, nothing
 * written). Writes go through the same `ArgumentGraphSchema` and core `replaceArgumentGraph` (rev lock,
 * atomic tmp+rename) the server's PUT uses. A cross-process write of the same graph at the same instant is
 * unsupported and has no file lock (contracts I013): the rev check stops writes based on a stale read.
 *
 * Output is frozen once released (contracts "论证图"; the full list is in ticket 07's Comments): `get` prints
 * keys in the fixed order of {@link orderedGraph}, never the insertion order of whatever object came in.
 *
 * Every message these commands print is worded HERE, in one line each: nothing of zod, commander (apart from the
 * unfrozen usage errors), V8 or Node leaks into a frozen text. Validation issues are positions (0-based indexes,
 * `arguments[1].title`) plus our own sentence, see {@link describeGraphIssue}.
 */

import { fstatSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  type Argument,
  type ArgumentEdge,
  type ArgumentGraph,
  ArgumentGraphSchema,
  type ArgumentSource,
  type ArgumentSourceTarget,
} from "@argelanderspace/contracts";
import {
  ArgumentGraphFileError,
  argumentGraphPath,
  LibraryStore,
  libraryPaths,
  loadArgumentGraph,
  readPdfMetadataIfPresent,
  replaceArgumentGraph,
} from "@argelanderspace/core";
import { ConfigError } from "@argelanderspace/infra";
import type { Command } from "commander";
import { resolveLinkPort } from "./agent.js";
import { fail, resolveDataDir, withDataDir } from "./common.js";

/** At most this many validation issues are listed; the rest are counted. */
const MAX_REPORTED_ISSUES = 100;
/** An id longer than this is cut (with an ellipsis) where a message quotes it. */
const MAX_QUOTED_CHARS = 100;

// --------------------------------------------------------------------------- //
// Our own messages (one line each)
// --------------------------------------------------------------------------- //

/** An error whose message is already final: one line, our wording. */
class ArgumentCliError extends Error {}

/**
 * Characters `JSON.stringify` leaves as they are but that can start a new line or reorder text where a terminal or a
 * log viewer shows them: DEL, the C1 controls (U+0080–U+009F, NEL included), the line and paragraph separators, and
 * the bidirectional marks and controls.
 */
const UNSAFE_TO_SHOW = /[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/**
 * The characters of `s` as they appear between JSON quotes: the escapes JSON makes (newline, quote, backslash, the
 * C0 controls, lone surrogates) plus `\uXXXX` for everything in {@link UNSAFE_TO_SHOW}.
 */
function escaped(s: string): string {
  return JSON.stringify(s)
    .slice(1, -1)
    .replace(UNSAFE_TO_SHOW, (c) => `\\u${(c.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`);
}

/** `s` in double quotes with {@link escaped} inside (a path, a file name): never a raw line break. */
function q(s: string): string {
  return `"${escaped(s)}"`;
}

/** Like {@link q}, cut to {@link MAX_QUOTED_CHARS} characters (ids): `"abc…"`. */
function quote(s: string): string {
  const chars = [...s];
  if (chars.length <= MAX_QUOTED_CHARS) return q(s);
  return `"${escaped(chars.slice(0, MAX_QUOTED_CHARS).join(""))}…"`;
}

function errnoCode(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : "UNKNOWN";
}

function isMissing(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** How many candidates are listed in an "unknown id" message (as `note` does). */
const MAX_CANDIDATES = 12;

/**
 * `unknown <kind> "<id>" — closest matches: … | available: … (N total) | <none>`, the shape of `note`'s. Same
 * wording, but built here: an empty id is matched against nothing (it would match every candidate as a "close"
 * one), and the "none" text says where we looked.
 */
function unknownMessage(
  kind: string,
  noneText: string,
  query: string,
  candidates: readonly string[]
) {
  const head = `unknown ${kind} "${escaped(query)}" — `;
  if (candidates.length === 0) return `${head}${noneText}`;
  const shown = candidates.map(escaped);
  const lower = query.toLowerCase();
  const close =
    query === ""
      ? []
      : candidates.filter((c) => {
          const cl = c.toLowerCase();
          return cl.includes(lower) || (lower.length >= 4 && lower.includes(cl));
        });
  if (close.length > 0) {
    return `${head}closest matches: ${close.slice(0, MAX_CANDIDATES).map(escaped).join(", ")}`;
  }
  const more = shown.length > MAX_CANDIDATES ? ` … (${shown.length} total)` : "";
  return `${head}available: ${shown.slice(0, MAX_CANDIDATES).join(", ")}${more}`;
}

// --------------------------------------------------------------------------- //
// Frozen key order (a field added to the schema fails to compile until it is listed here)
// --------------------------------------------------------------------------- //

/** Every key of `T`, required: an object literal of this type must name them all (and no others). */
type AllKeys<T> = { [K in keyof T]-?: unknown };

function dropUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

function orderedTarget(t: ArgumentSourceTarget): Record<string, unknown> {
  const out: AllKeys<ArgumentSourceTarget> = { doc_id: t.doc_id, anchor: t.anchor, page: t.page };
  return dropUndefined(out);
}

function orderedSource(s: ArgumentSource): Record<string, unknown> {
  const out: AllKeys<ArgumentSource> = {
    text: s.text,
    target: s.target === undefined ? undefined : orderedTarget(s.target),
  };
  return dropUndefined(out);
}

function orderedArgument(a: Argument): Record<string, unknown> {
  const out: AllKeys<Argument> = {
    id: a.id,
    title: a.title,
    claim: a.claim,
    grounds: a.grounds,
    warrant: a.warrant,
    backing: a.backing,
    qualifier: a.qualifier,
    rebuttal: a.rebuttal,
    warrant_implicit: a.warrant_implicit,
    kind: a.kind,
    sources: a.sources.map(orderedSource),
  };
  return out;
}

function orderedEdge(e: ArgumentEdge): Record<string, unknown> {
  const out: AllKeys<ArgumentEdge> = { from: e.from, to: e.to, role: e.role };
  return out;
}

/**
 * The frozen shape of `argument get`: `version, rev, work_id, arguments, edges`; an argument is
 * `id, title, claim, grounds, warrant, backing, qualifier, rebuttal, warrant_implicit, kind, sources`; a
 * source `text, target`; a target `doc_id` then `anchor` or `page`; an edge `from, to, role`.
 */
export function orderedGraph(g: ArgumentGraph): Record<string, unknown> {
  const out: AllKeys<ArgumentGraph> = {
    version: g.version,
    rev: g.rev,
    work_id: g.work_id,
    arguments: g.arguments.map(orderedArgument),
    edges: g.edges.map(orderedEdge),
  };
  return out;
}

// --------------------------------------------------------------------------- //
// Validation issues in our own words
// --------------------------------------------------------------------------- //

/** The part of a zod issue we read; anything else about it is ignored. */
export interface GraphIssueLike {
  code: string;
  path: readonly PropertyKey[];
  [key: string]: unknown;
}

/** `arguments[1].sources[0].target`; the root is `<root>`. Indexes are 0-based. */
function positionOf(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "<root>";
  let out = "";
  for (const seg of path) {
    out += typeof seg === "number" ? `[${seg}]` : `${out === "" ? "" : "."}${String(seg)}`;
  }
  return out;
}

function valueAt(data: unknown, path: readonly PropertyKey[]): unknown {
  let cur = data;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[seg];
  }
  return cur;
}

const FALLBACK = "does not satisfy the argument graph format";

const EXPECTED_TYPE: Record<string, string> = {
  object: "must be an object",
  array: "must be an array",
  string: "must be a string",
  number: "must be a number",
  boolean: "must be a boolean",
  int: "must be an integer",
};

/** A sentence about a position, and what makes two of them "the same" (the full text, not the shown cut). */
interface Sentence {
  text: string;
  identity: string;
}

const plain = (text: string): Sentence[] => [{ text, identity: text }];

/** One unknown key: shown cut to {@link MAX_QUOTED_CHARS} characters, but told apart by its whole name. */
function unknownField(key: string): Sentence {
  return { text: `unknown field ${quote(key)}`, identity: `unknown field ${key}` };
}

function sentencesFor(issue: GraphIssueLike, data: unknown): Sentence[] {
  const code = issue.code;
  if (code === "unrecognized_keys" && Array.isArray(issue.keys)) {
    return issue.keys.map((k) => unknownField(String(k)));
  }
  if (code === "custom") {
    const rule = (issue.params as { rule?: unknown } | undefined)?.rule;
    const last = issue.path[issue.path.length - 1];
    const idAt = (key: "from" | "to" | "id", path: readonly PropertyKey[]) => {
      const v = valueAt(data, [...path, key]);
      return typeof v === "string" ? quote(v) : "?";
    };
    const edgePath = issue.path.slice(0, 2);
    if (rule === "duplicate_id") return plain(`duplicate id ${idAt("id", issue.path.slice(0, 2))}`);
    if (rule === "unknown_argument" && (last === "from" || last === "to")) {
      return plain(`refers to unknown argument ${idAt(last, edgePath)}`);
    }
    if (rule === "self_loop") return plain(`connects argument ${idAt("from", edgePath)} to itself`);
    if (rule === "duplicate_edge") {
      const role = valueAt(data, [...edgePath, "role"]);
      return plain(
        `duplicate ${typeof role === "string" ? role : "?"} edge from ${idAt("from", edgePath)} to ${idAt("to", edgePath)}`
      );
    }
    if (rule === "blank_title") return plain("must not be blank");
    if (rule === "target_anchor_or_page") return plain("must have exactly one of anchor or page");
    return plain(FALLBACK);
  }
  // Everything else is about a value: absent means "is required" whatever the library calls it.
  const valueRules = ["invalid_type", "invalid_value", "too_small", "too_big"];
  if (
    valueRules.includes(code) &&
    issue.path.length > 0 &&
    valueAt(data, issue.path) === undefined
  ) {
    return plain("is required");
  }
  switch (code) {
    case "invalid_type": {
      const expected =
        typeof issue.expected === "string" ? EXPECTED_TYPE[issue.expected] : undefined;
      return plain(expected ?? FALLBACK);
    }
    case "too_big": {
      const max = issue.maximum;
      if (typeof max !== "number" && typeof max !== "bigint") return plain(FALLBACK);
      if (issue.origin === "string") return plain(`must be at most ${max} characters`);
      if (issue.origin === "array") return plain(`must have at most ${max} items`);
      if (issue.origin === "number" || issue.origin === "int")
        return plain(`must be at most ${max}`);
      return plain(FALLBACK);
    }
    case "too_small": {
      const min = issue.minimum;
      if (typeof min !== "number" && typeof min !== "bigint") return plain(FALLBACK);
      if (issue.origin === "string") {
        return plain(
          min === 1 && issue.inclusive !== false
            ? "must not be empty"
            : `must be at least ${min} characters`
        );
      }
      if (issue.origin === "array") return plain(`must have at least ${min} items`);
      if (issue.origin === "number" || issue.origin === "int") {
        return plain(
          issue.inclusive === false ? `must be greater than ${min}` : `must be at least ${min}`
        );
      }
      return plain(FALLBACK);
    }
    case "invalid_value": {
      const values = issue.values;
      if (!Array.isArray(values) || values.length === 0) return plain(FALLBACK);
      return plain(
        values.length === 1
          ? `must be ${String(values[0])}`
          : `must be one of ${values.map(String).join(", ")}`
      );
    }
    default:
      return plain(FALLBACK);
  }
}

/**
 * One zod issue as lines `<position>: <our sentence>` (an unrecognized-keys issue is one line per key). Every
 * quoted value is JSON-escaped, so a line never contains a raw newline. `data` is the parsed input, for the ids.
 */
export function describeGraphIssue(issue: GraphIssueLike, data: unknown): string[] {
  const position = positionOf(issue.path);
  return sentencesFor(issue, data).map((sentence) => `${position}: ${sentence.text}`);
}

/** A line of the report, with the key two lines are the same by (position and the uncut sentence). */
interface IssueLine {
  identity: string;
  line: string;
}

function issueLines(path: readonly PropertyKey[], sentences: readonly Sentence[]): IssueLine[] {
  const position = positionOf(path);
  return sentences.map((s) => ({
    identity: `${position}\u0000${s.identity}`,
    line: `${position}: ${s.text}`,
  }));
}

/**
 * Every object (at any depth) that has an OWN key named `__proto__`. `JSON.parse` keeps it as an ordinary property,
 * but the schema library never sees it as a key, so it would be ignored in silence; it is reported as an unknown
 * field like any other. Iterative: the depth of the input is the caller's.
 */
function protoKeyPositions(root: unknown): PropertyKey[][] {
  const found: PropertyKey[][] = [];
  const stack: { value: unknown; path: PropertyKey[] }[] = [{ value: root, path: [] }];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const { value, path } = item;
    // The format is six levels deep at most; anything below that is an unknown field of its parent anyway.
    if (value === null || typeof value !== "object" || path.length > 10) continue;
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        stack.push({ value: v, path: [...path, i] });
      });
      continue;
    }
    const obj = value as Record<string, unknown>;
    if (Object.hasOwn(obj, "__proto__")) found.push(path);
    for (const key of Object.keys(obj)) stack.push({ value: obj[key], path: [...path, key] });
  }
  return found;
}

// --------------------------------------------------------------------------- //
// Reading the library and the stored graph
// --------------------------------------------------------------------------- //

function loadLibrary(dataDir: string): LibraryStore {
  const paths = libraryPaths(dataDir);
  try {
    return LibraryStore.load(paths);
  } catch (e) {
    const file = q(paths.libraryJson);
    if (e instanceof SyntaxError)
      throw new ArgumentCliError(`library file ${file} is not valid JSON`);
    const code = (e as NodeJS.ErrnoException).code;
    if (typeof code === "string") {
      throw new ArgumentCliError(`library file ${file} could not be read (${code})`);
    }
    throw new ArgumentCliError(`library file ${file} has an unexpected structure`);
  }
}

/** The Work must be in the library (a merged-away Work is not), and its id must be usable as a file name. */
function requireWork(dataDir: string, workId: string): void {
  const store = loadLibrary(dataDir);
  if (store.get(workId) === undefined) {
    throw new ArgumentCliError(
      unknownMessage(
        "work",
        `the library at ${q(libraryPaths(dataDir).libraryJson)} has no works`,
        workId,
        store.works.map((w) => w.id)
      )
    );
  }
  try {
    argumentGraphPath(dataDir, workId);
  } catch (e) {
    if (e instanceof ArgumentGraphFileError && e.kind === "unsafe_id") {
      throw new ArgumentCliError(
        `work ${quote(workId)} cannot have an argument graph: its id cannot be used as a file name`
      );
    }
    throw e;
  }
}

function describeStoreProblem(e: ArgumentGraphFileError): string {
  const file = q(e.file ?? "?");
  const p = e.problem;
  const tail =
    p === undefined
      ? "could not be used"
      : p.reason === "unreadable"
        ? `could not be read (${p.code})`
        : p.reason === "not_json"
          ? "is not valid JSON"
          : p.reason === "schema"
            ? "does not match the argument graph format"
            : p.reason === "future_version"
              ? `has version ${p.version}; this build only reads version 1`
              : p.reason === "wrong_work"
                ? `belongs to work ${quote(p.workId)}`
                : "could not be used";
  return `stored argument graph ${file} ${tail}`;
}

/** The stored graph, or an {@link ArgumentCliError} in our words (never the store's own message). */
function loadStored(dataDir: string, workId: string): ArgumentGraph {
  try {
    return loadArgumentGraph(dataDir, workId);
  } catch (e) {
    if (e instanceof ArgumentGraphFileError) throw new ArgumentCliError(describeStoreProblem(e));
    throw e;
  }
}

/** Any error that is not already one of ours becomes one fixed line (the exception's own text is not printed). */
function asCliError(e: unknown): unknown {
  if (e instanceof ArgumentCliError) return e;
  // This repository's own sentence (`<path>/config.toml: "port" must be …`), printed as `note` prints it.
  if (e instanceof ConfigError) return new ArgumentCliError(e.message);
  const code = (e as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string") return new ArgumentCliError(`file system error (${code})`);
  return new ArgumentCliError(`unexpected failure (${e instanceof Error ? e.name : typeof e})`);
}

// --------------------------------------------------------------------------- //
// argument get / put
// --------------------------------------------------------------------------- //

function runArgumentGet(workId: string, dataDir: string): void {
  requireWork(dataDir, workId);
  const graph = loadStored(dataDir, workId); // missing file → empty graph at rev 0; anything unreadable → error
  console.log(JSON.stringify(orderedGraph(graph), null, 2));
}

function parseRev(raw: string | undefined): number {
  if (raw === undefined) {
    throw new ArgumentCliError(
      "--rev is required: pass the rev that `argument get` printed (0 when the work has no graph)"
    );
  }
  if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new ArgumentCliError(`--rev must be a non-negative integer, got "${escaped(raw)}"`);
  }
  return Number(raw);
}

/**
 * All of stdin, read asynchronously to EOF: while it waits for a writer the event loop keeps running, so Ctrl-C and
 * SIGTERM end the command at once (a blocking read cannot be interrupted by a signal handler). The bytes are joined
 * before they are decoded, so a multi-byte character cut between two chunks is intact.
 */
async function readStdin(): Promise<string> {
  // A stream over a directory just ends: that is not "empty input", so say what it is.
  let isDirectory = false;
  try {
    isDirectory = fstatSync(0).isDirectory();
  } catch {
    /* no usable fd 0: the read below reports it */
  }
  if (isDirectory) throw Object.assign(new Error("stdin is a directory"), { code: "EISDIR" });
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readGraphText(file: string): Promise<string> {
  try {
    if (file !== "-") return readFileSync(file, "utf8");
    // Waiting for a person to type a whole graph is never what `-` is for (and the line is easily forgotten in a
    // pipeline that lost its writer): refuse at once instead of waiting.
    if (process.stdin.isTTY === true) {
      throw new ArgumentCliError(
        'stdin is a terminal; "-" reads the graph from a pipe or a redirected file'
      );
    }
    return await readStdin();
  } catch (e) {
    if (e instanceof ArgumentCliError) throw e;
    throw new ArgumentCliError(`cannot read ${file === "-" ? "stdin" : q(file)} (${errnoCode(e)})`);
  }
}

interface PutOpts {
  rev?: string;
  replace?: boolean;
}

async function runArgumentPut(
  workId: string,
  file: string,
  opts: PutOpts,
  dataDir: string
): Promise<void> {
  const rev = parseRev(opts.rev);
  requireWork(dataDir, workId);
  const label = file === "-" ? "stdin" : q(file);
  let data: unknown;
  const text = await readGraphText(file);
  try {
    data = JSON.parse(text);
  } catch {
    throw new ArgumentCliError(`${label} is not valid JSON`);
  }
  // `work_id` is fixed by the command line: absent in the file → filled in; present → must agree.
  // `rev` in the file is ignored; `--rev` is the one the caller read. `version` may be left out (it is 1).
  const protoKeys = protoKeyPositions(data);
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const fileWork = (data as Record<string, unknown>).work_id;
    if (fileWork !== undefined && typeof fileWork !== "string") {
      throw new ArgumentCliError(`work_id in ${label} must be a string`);
    }
    if (fileWork !== undefined && fileWork !== workId) {
      throw new ArgumentCliError(
        `work_id in ${label} is ${quote(fileWork)}, which does not match work ${quote(workId)}`
      );
    }
    const withDefaults: Record<string, unknown> = {
      ...(data as Record<string, unknown>),
      rev,
      work_id: workId,
    };
    if (withDefaults.version === undefined) withDefaults.version = 1;
    data = withDefaults;
  }
  const parsed = ArgumentGraphSchema.safeParse(data);
  if (!parsed.success || protoKeys.length > 0) {
    const entries = [
      ...(parsed.success
        ? []
        : parsed.error.issues.flatMap((i) => {
            const issue = i as unknown as GraphIssueLike;
            return issueLines(issue.path, sentencesFor(issue, data));
          })),
      ...protoKeys.flatMap((path) => issueLines(path, [unknownField("__proto__")])),
    ];
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const entry of entries) {
      if (seen.has(entry.identity)) continue;
      seen.add(entry.identity);
      lines.push(entry.line);
    }
    const shown = lines.slice(0, MAX_REPORTED_ISSUES).map((l) => `  ${l}`);
    if (lines.length > shown.length) shown.push(`  … ${lines.length - shown.length} more`);
    throw new ArgumentCliError(
      `${label} is not a valid argument graph (${lines.length} issue${lines.length === 1 ? "" : "s"}); nothing was written\n${shown.join("\n")}`
    );
  }
  const graph = parsed.data;

  const current = loadStored(dataDir, workId); // an unreadable stored graph is never overwritten
  const mismatch = (stored: number): ArgumentCliError =>
    new ArgumentCliError(
      `rev mismatch: the stored graph of work ${quote(workId)} is at rev ${stored}, --rev ${rev} was given; ` +
        "run `argument get` again and rebase your changes; nothing was written"
    );
  if (current.rev !== rev) throw mismatch(current.rev);
  if (current.arguments.length > 0 && opts.replace !== true) {
    throw new ArgumentCliError(
      `work ${quote(workId)} already has a graph with ${current.arguments.length} argument${current.arguments.length === 1 ? "" : "s"}; ` +
        "pass --replace to replace it; nothing was written"
    );
  }
  let outcome: ReturnType<typeof replaceArgumentGraph>;
  try {
    outcome = replaceArgumentGraph(dataDir, graph);
  } catch (e) {
    if (e instanceof ArgumentGraphFileError) throw new ArgumentCliError(describeStoreProblem(e));
    throw new ArgumentCliError(
      `could not write the argument graph (${errnoCode(e)}); nothing was written`
    );
  }
  if ("conflictRev" in outcome) throw mismatch(outcome.conflictRev);
  const link = `http://localhost:${resolveLinkPort()}/#argument/${encodeURIComponent(workId)}`;
  console.log(JSON.stringify({ work_id: workId, rev: outcome.saved.rev, link }));
}

// --------------------------------------------------------------------------- //
// pdf-path
// --------------------------------------------------------------------------- //

/**
 * Doc ids under `output/` that are PDF Docs. Only a missing directory is "no docs"; one that cannot be listed is a
 * system error. A single Doc whose files cannot be read is skipped (this only feeds the candidates).
 */
function pdfDocIds(paths: ReturnType<typeof libraryPaths>): string[] {
  let names: string[];
  try {
    names = readdirSync(paths.outputDir);
  } catch (e) {
    if (isMissing(e)) return [];
    throw outputDirError(paths, e);
  }
  return names
    .filter((id) => {
      try {
        return (
          lstatSync(join(paths.outputDir, id, `${id}.json`)).isFile() &&
          readPdfMetadataIfPresent(paths, id) !== null
        );
      } catch {
        return false;
      }
    })
    .sort();
}

function outputDirError(paths: ReturnType<typeof libraryPaths>, e: unknown): ArgumentCliError {
  return new ArgumentCliError(
    `the output directory ${q(paths.outputDir)} could not be read (${errnoCode(e)})`
  );
}

/** The core's fixed messages for a PDF Doc whose files are not what they should be, in our wording. */
const PDF_METADATA_REASONS: Record<string, string> = {
  "invalid output directory": "the output directory is not a plain directory",
  "unsafe PDF Doc directory": "its folder is not a plain directory",
  "unsafe PDF Doc file": "its metadata file is not a regular file",
  "PDF metadata missing": "its metadata file is missing",
  "PDF metadata format is invalid": "its metadata is not marked as a PDF doc",
  "PDF metadata identity mismatch": "its metadata belongs to another doc",
  "invalid Doc metadata": "its metadata is not a JSON object",
};

function describePdfMetadataError(e: unknown): string {
  if (e instanceof SyntaxError) return "its metadata is not valid JSON";
  if (e instanceof Error && e.name === "ZodError")
    return "its metadata does not match the PDF doc format";
  const code = (e as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string") return `its files could not be read (${code})`;
  if (e instanceof Error && PDF_METADATA_REASONS[e.message] !== undefined) {
    return PDF_METADATA_REASONS[e.message] as string;
  }
  return "its metadata could not be read";
}

function runPdfPath(docId: string, dataDir: string): void {
  const paths = libraryPaths(dataDir);
  const unknown = (): ArgumentCliError =>
    new ArgumentCliError(
      unknownMessage(
        "PDF doc",
        `there are no PDF docs in ${q(paths.outputDir)}`,
        docId,
        pdfDocIds(paths)
      )
    );
  const unreadable = (e: unknown): ArgumentCliError =>
    new ArgumentCliError(`doc ${quote(docId)}: its files could not be read (${errnoCode(e)})`);

  // Only "there is no such file or directory" means "no such doc": a path we may not search, or an I/O error, says
  // so (the stored-graph reader makes the same distinction).
  try {
    if (!lstatSync(paths.outputDir).isDirectory()) {
      throw new ArgumentCliError(
        `doc ${quote(docId)}: ${PDF_METADATA_REASONS["invalid output directory"]}`
      );
    }
  } catch (e) {
    if (e instanceof ArgumentCliError) throw e;
    if (isMissing(e)) throw unknown();
    throw outputDirError(paths, e);
  }
  const plainName = docId !== "" && !/[/\\]/.test(docId) && !docId.startsWith(".");
  if (!plainName) throw unknown();
  const docDir = join(paths.outputDir, docId);
  let json: "present" | "absent" | "not-probed" = "not-probed";
  let docIsDirectory = false;
  try {
    docIsDirectory = lstatSync(docDir).isDirectory(); // failing to reach the entry is about output/ itself
  } catch (e) {
    if (isMissing(e)) throw unknown();
    throw outputDirError(paths, e);
  }
  if (docIsDirectory) {
    try {
      lstatSync(join(docDir, `${docId}.json`));
      json = "present";
    } catch (e) {
      if (!isMissing(e)) throw unreadable(e);
      json = "absent";
    }
  }
  let metadata: ReturnType<typeof readPdfMetadataIfPresent>;
  try {
    metadata = readPdfMetadataIfPresent(paths, docId);
  } catch (e) {
    throw new ArgumentCliError(`doc ${quote(docId)}: ${describePdfMetadataError(e)}`);
  }
  if (metadata === null) {
    if (json === "present") throw new ArgumentCliError(`doc ${quote(docId)} is not a PDF doc`);
    throw unknown();
  }
  let original: string;
  try {
    original = join(realpathSync(paths.outputDir), docId, "original.pdf");
  } catch (e) {
    throw unreadable(e);
  }
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(original);
  } catch (e) {
    if (isMissing(e))
      throw new ArgumentCliError(`the original PDF of doc ${quote(docId)} is missing`);
    throw unreadable(e);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ArgumentCliError(`the original PDF of doc ${quote(docId)} is not a regular file`);
  }
  console.log(original);
}

// --------------------------------------------------------------------------- //
// Registration
// --------------------------------------------------------------------------- //

/** Run a command body; every failure is printed as one `error: …` line of ours, exit 1. */
function guarded(body: () => void): void {
  try {
    body();
  } catch (e) {
    fail(asCliError(e));
  }
}

/** The same for a body that waits (stdin): the command's promise settles only after the failure is printed. */
async function guardedAsync(body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (e) {
    fail(asCliError(e));
  }
}

export function registerArgumentCommands(program: Command): void {
  const argument = program
    .command("argument")
    .description("Read or replace a work's argument graph (论证图) as JSON.");

  withDataDir(argument.command("get"))
    .description(
      "Print the work's whole argument graph as JSON (version 1, with rev); " +
        "a work without a graph prints the empty graph at rev 0."
    )
    .argument("<workId>", "library work id (see `search`)")
    .action((workId: string, _opts: { dataDir?: string }, cmd: Command) => {
      guarded(() => runArgumentGet(workId, resolveDataDir(cmd.optsWithGlobals())));
    });

  withDataDir(argument.command("put"))
    .description(
      'Replace the work\'s whole argument graph from a JSON file ("-" reads stdin). ' +
        "--rev must be the rev `argument get` printed; a work that already has arguments also needs " +
        "--replace. The file's own rev is ignored; its work_id may be left out but must match if present. " +
        "On success prints {work_id, rev, link}."
    )
    .argument("<workId>", "library work id (see `search`)")
    .argument("<file>", 'JSON file with the whole graph, or "-" for stdin')
    .option("--rev <n>", "the rev of the graph you read (0 when the work has none); required")
    .option("--replace", "allow replacing a graph that already has arguments")
    .action(async (workId: string, file: string, opts: PutOpts, cmd: Command) => {
      await guardedAsync(() =>
        runArgumentPut(workId, file, opts, resolveDataDir(cmd.optsWithGlobals()))
      );
    });

  withDataDir(program.command("pdf-path"))
    .description(
      "Print the absolute path of a PDF doc's original file (read-only; the PDF itself is not read)."
    )
    .argument("<docId>", "PDF doc id (pdf-…, see `search` doc_ids)")
    .action((docId: string, _opts: { dataDir?: string }, cmd: Command) => {
      guarded(() => runPdfPath(docId, resolveDataDir(cmd.optsWithGlobals())));
    });
}
