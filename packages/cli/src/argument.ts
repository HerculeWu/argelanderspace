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

import { existsSync, lstatSync, readFileSync, readSync, realpathSync } from "node:fs";
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
import type { Command } from "commander";
import { listDocIds, resolveLinkPort, unknownMsg } from "./agent.js";
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

/** The characters of `s` as they appear between JSON quotes (escapes for newline, quote, backslash, controls). */
function escaped(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}

/** A JSON-quoted string, cut to {@link MAX_QUOTED_CHARS} characters; never contains a raw newline. */
function quote(s: string): string {
  const chars = [...s];
  if (chars.length <= MAX_QUOTED_CHARS) return JSON.stringify(s);
  return `"${escaped(chars.slice(0, MAX_QUOTED_CHARS).join(""))}…"`;
}

function errnoCode(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : "unknown error";
}

/** `unknown <kind> "<id>" — closest matches: … | available: … (N total) | <none>`, same shape as `note`'s. */
function unknownMessage(
  kind: string,
  noneText: string,
  query: string,
  candidates: readonly string[]
) {
  if (candidates.length === 0) return `unknown ${kind} "${escaped(query)}" — ${noneText}`;
  return unknownMsg(kind, escaped(query), candidates.map(escaped));
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

function sentenceFor(issue: GraphIssueLike, data: unknown): string[] {
  const code = issue.code;
  if (code === "unrecognized_keys" && Array.isArray(issue.keys)) {
    return issue.keys.map((k) => `unknown field ${quote(String(k))}`);
  }
  if (code === "custom") {
    const rule = (issue.params as { rule?: unknown } | undefined)?.rule;
    const last = issue.path[issue.path.length - 1];
    const idAt = (key: "from" | "to" | "id", path: readonly PropertyKey[]) => {
      const v = valueAt(data, [...path, key]);
      return typeof v === "string" ? quote(v) : "?";
    };
    const edgePath = issue.path.slice(0, 2);
    if (rule === "duplicate_id") return [`duplicate id ${idAt("id", issue.path.slice(0, 2))}`];
    if (rule === "unknown_argument" && (last === "from" || last === "to")) {
      return [`refers to unknown argument ${idAt(last, edgePath)}`];
    }
    if (rule === "self_loop") return [`connects argument ${idAt("from", edgePath)} to itself`];
    if (rule === "duplicate_edge") {
      const role = valueAt(data, [...edgePath, "role"]);
      return [
        `duplicate ${typeof role === "string" ? role : "?"} edge from ${idAt("from", edgePath)} to ${idAt("to", edgePath)}`,
      ];
    }
    if (last === "title") return ["must not be blank"];
    if (last === "target") return ["must have exactly one of anchor or page"];
    return [FALLBACK];
  }
  // Everything else is about a value: absent means "is required" whatever the library calls it.
  const valueRules = ["invalid_type", "invalid_value", "too_small", "too_big"];
  if (
    valueRules.includes(code) &&
    issue.path.length > 0 &&
    valueAt(data, issue.path) === undefined
  ) {
    return ["is required"];
  }
  switch (code) {
    case "invalid_type": {
      const expected =
        typeof issue.expected === "string" ? EXPECTED_TYPE[issue.expected] : undefined;
      return [expected ?? FALLBACK];
    }
    case "too_big": {
      const max = issue.maximum;
      if (typeof max !== "number" && typeof max !== "bigint") return [FALLBACK];
      if (issue.origin === "string") return [`must be at most ${max} characters`];
      if (issue.origin === "array") return [`must have at most ${max} items`];
      if (issue.origin === "number" || issue.origin === "int") return [`must be at most ${max}`];
      return [FALLBACK];
    }
    case "too_small": {
      const min = issue.minimum;
      if (typeof min !== "number" && typeof min !== "bigint") return [FALLBACK];
      if (issue.origin === "string") {
        return [
          min === 1 && issue.inclusive !== false
            ? "must not be empty"
            : `must be at least ${min} characters`,
        ];
      }
      if (issue.origin === "array") return [`must have at least ${min} items`];
      if (issue.origin === "number" || issue.origin === "int") {
        return [
          issue.inclusive === false ? `must be greater than ${min}` : `must be at least ${min}`,
        ];
      }
      return [FALLBACK];
    }
    case "invalid_value": {
      const values = issue.values;
      if (!Array.isArray(values) || values.length === 0) return [FALLBACK];
      return [
        values.length === 1
          ? `must be ${String(values[0])}`
          : `must be one of ${values.map(String).join(", ")}`,
      ];
    }
    default:
      return [FALLBACK];
  }
}

/**
 * One zod issue as lines `<position>: <our sentence>` (an unrecognized-keys issue is one line per key). Every
 * quoted value is JSON-escaped, so a line never contains a raw newline. `data` is the parsed input, for the ids.
 */
export function describeGraphIssue(issue: GraphIssueLike, data: unknown): string[] {
  const position = positionOf(issue.path);
  return sentenceFor(issue, data).map((sentence) => `${position}: ${sentence}`);
}

// --------------------------------------------------------------------------- //
// Reading the library and the stored graph
// --------------------------------------------------------------------------- //

function loadLibrary(dataDir: string): LibraryStore {
  const paths = libraryPaths(dataDir);
  try {
    return LibraryStore.load(paths);
  } catch (e) {
    const file = JSON.stringify(paths.libraryJson);
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
        "the library has no works",
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
  const file = JSON.stringify(e.file ?? "?");
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
 * All of stdin. The pipe fd may be non-blocking (a dependency can set that when it loads), so "no data yet" is
 * EAGAIN, not an error: wait a little and read again until EOF.
 */
function readStdin(): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.allocUnsafe(1 << 16);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let n: number;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      const code = errnoCode(e);
      if (code === "EAGAIN") {
        Atomics.wait(pause, 0, 0, 5);
        continue;
      }
      if (code === "EOF") break;
      throw e;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function readGraphText(file: string): string {
  try {
    return file === "-" ? readStdin() : readFileSync(file, "utf8");
  } catch (e) {
    throw new ArgumentCliError(
      `cannot read ${file === "-" ? "stdin" : JSON.stringify(file)} (${errnoCode(e)})`
    );
  }
}

interface PutOpts {
  rev?: string;
  replace?: boolean;
}

function runArgumentPut(workId: string, file: string, opts: PutOpts, dataDir: string): void {
  const rev = parseRev(opts.rev);
  requireWork(dataDir, workId);
  const label = file === "-" ? "stdin" : JSON.stringify(file);
  let data: unknown;
  const text = readGraphText(file);
  try {
    data = JSON.parse(text);
  } catch {
    throw new ArgumentCliError(`${label} is not valid JSON`);
  }
  // `work_id` is fixed by the command line: absent in the file → filled in; present → must agree.
  // `rev` in the file is ignored; `--rev` is the one the caller read.
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const fileWork = (data as Record<string, unknown>).work_id;
    if (fileWork !== undefined && fileWork !== workId) {
      throw new ArgumentCliError(
        `work_id in ${label} is ${quote(typeof fileWork === "string" ? fileWork : JSON.stringify(fileWork))}, which does not match work ${quote(workId)}`
      );
    }
    data = { ...(data as Record<string, unknown>), rev, work_id: workId };
  }
  const parsed = ArgumentGraphSchema.safeParse(data);
  if (!parsed.success) {
    const lines = [
      ...new Set(
        parsed.error.issues.flatMap((i) => describeGraphIssue(i as unknown as GraphIssueLike, data))
      ),
    ];
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

/** Doc ids under `output/` that are PDF Docs (unreadable metadata is skipped; this only feeds candidates). */
function pdfDocIds(paths: ReturnType<typeof libraryPaths>): string[] {
  return listDocIds(paths.outputDir).filter((id) => {
    try {
      return readPdfMetadataIfPresent(paths, id) !== null;
    } catch {
      return false;
    }
  });
}

/** The core's fixed messages for a PDF Doc whose files are not what they should be, in our wording. */
const PDF_METADATA_REASONS: Record<string, string> = {
  "invalid output directory": "the output directory is not a directory",
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
      unknownMessage("PDF doc", "there are no PDF docs", docId, pdfDocIds(paths))
    );
  const plainName = docId !== "" && !/[/\\]/.test(docId) && !docId.startsWith(".");
  if (!plainName || !existsSync(paths.outputDir)) throw unknown();
  let metadata: ReturnType<typeof readPdfMetadataIfPresent>;
  try {
    metadata = readPdfMetadataIfPresent(paths, docId);
  } catch (e) {
    throw new ArgumentCliError(`doc ${quote(docId)}: ${describePdfMetadataError(e)}`);
  }
  if (metadata === null) {
    if (existsSync(join(paths.outputDir, docId, `${docId}.json`))) {
      throw new ArgumentCliError(`doc ${quote(docId)} is not a PDF doc`);
    }
    throw unknown();
  }
  let original: string;
  try {
    original = join(realpathSync(paths.outputDir), docId, "original.pdf");
  } catch (e) {
    throw new ArgumentCliError(
      `doc ${quote(docId)}: its files could not be read (${errnoCode(e)})`
    );
  }
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(original);
  } catch {
    throw new ArgumentCliError(`the original PDF of doc ${quote(docId)} is missing`);
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
    .action((workId: string, file: string, opts: PutOpts, cmd: Command) => {
      guarded(() => runArgumentPut(workId, file, opts, resolveDataDir(cmd.optsWithGlobals())));
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
