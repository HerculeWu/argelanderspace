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
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  type Argument,
  type ArgumentGraph,
  ArgumentGraphSchema,
  type ArgumentSource,
} from "@argelanderspace/contracts";
import {
  libraryPaths,
  loadArgumentGraph,
  readPdfMetadataIfPresent,
  replaceArgumentGraph,
} from "@argelanderspace/core";
import type { Command } from "commander";
import { listDocIds, loadWork, unknownMsg } from "./agent.js";
import { fail, resolveDataDir, withDataDir } from "./common.js";

/** At most this many validation issues are listed; the rest are counted. */
const MAX_REPORTED_ISSUES = 100;

// --------------------------------------------------------------------------- //
// Frozen key order
// --------------------------------------------------------------------------- //

function orderedSource(s: ArgumentSource): Record<string, unknown> {
  const out: Record<string, unknown> = { text: s.text };
  if (s.target !== undefined) {
    const t: Record<string, unknown> = { doc_id: s.target.doc_id };
    if (s.target.anchor !== undefined) t.anchor = s.target.anchor;
    if (s.target.page !== undefined) t.page = s.target.page;
    out.target = t;
  }
  return out;
}

function orderedArgument(a: Argument): Record<string, unknown> {
  return {
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
}

/**
 * The frozen shape of `argument get`: `version, rev, work_id, arguments, edges`; an argument is
 * `id, title, claim, grounds, warrant, backing, qualifier, rebuttal, warrant_implicit, kind, sources`; a
 * source `text, target`; a target `doc_id` then `anchor` or `page`; an edge `from, to, role`.
 */
export function orderedGraph(g: ArgumentGraph): Record<string, unknown> {
  return {
    version: g.version,
    rev: g.rev,
    work_id: g.work_id,
    arguments: g.arguments.map(orderedArgument),
    edges: g.edges.map((e) => ({ from: e.from, to: e.to, role: e.role })),
  };
}

// --------------------------------------------------------------------------- //
// argument get / put
// --------------------------------------------------------------------------- //

function runArgumentGet(workId: string, dataDir: string): void {
  loadWork(libraryPaths(dataDir), workId); // actionable error on unknown id
  const graph = loadArgumentGraph(dataDir, workId); // missing file → empty graph at rev 0; unreadable → throws
  console.log(JSON.stringify(orderedGraph(graph), null, 2));
}

function parseRev(raw: string): number {
  if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`--rev must be a non-negative integer, got "${raw}"`);
  }
  return Number(raw);
}

function readGraphText(file: string): string {
  try {
    return readFileSync(file === "-" ? 0 : file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "unknown error";
    throw new Error(`cannot read ${file === "-" ? "stdin" : `"${file}"`} (${code})`);
  }
}

interface PutOpts {
  rev: string;
  replace?: boolean;
}

function runArgumentPut(workId: string, file: string, opts: PutOpts, dataDir: string): void {
  const rev = parseRev(opts.rev);
  loadWork(libraryPaths(dataDir), workId);
  const label = file === "-" ? "stdin" : `"${file}"`;
  let data: unknown;
  try {
    data = JSON.parse(readGraphText(file));
  } catch (e) {
    if (e instanceof SyntaxError) throw new Error(`${label} is not valid JSON`);
    throw e;
  }
  // `work_id` is fixed by the command line: absent in the file → filled in; present → must agree.
  // `rev` in the file is ignored; `--rev` is the one the caller read.
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const fileWork = (data as Record<string, unknown>).work_id;
    if (fileWork !== undefined && fileWork !== workId) {
      throw new Error(
        `work_id in ${label} (${JSON.stringify(fileWork)}) does not match the work given (${JSON.stringify(workId)})`
      );
    }
    data = { ...(data as Record<string, unknown>), rev, work_id: workId };
  }
  const parsed = ArgumentGraphSchema.safeParse(data);
  if (!parsed.success) {
    const lines = [
      ...new Set(parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)),
    ];
    const shown = lines.slice(0, MAX_REPORTED_ISSUES).map((l) => `  ${l}`);
    if (lines.length > shown.length) shown.push(`  … ${lines.length - shown.length} more`);
    throw new Error(
      `${label} is not a valid argument graph (${lines.length} issue${lines.length === 1 ? "" : "s"}); nothing was written\n${shown.join("\n")}`
    );
  }
  const graph = parsed.data;

  const current = loadArgumentGraph(dataDir, workId); // an unreadable stored graph is never overwritten
  const mismatch = (stored: number): Error =>
    new Error(
      `rev mismatch: the stored graph of work "${workId}" is at rev ${stored}, --rev ${rev} was given; ` +
        "run `argument get` again and rebase your changes; nothing was written"
    );
  if (current.rev !== rev) throw mismatch(current.rev);
  if (current.arguments.length > 0 && opts.replace !== true) {
    throw new Error(
      `work "${workId}" already has a graph with ${current.arguments.length} argument${current.arguments.length === 1 ? "" : "s"}; ` +
        "pass --replace to replace it; nothing was written"
    );
  }
  const outcome = replaceArgumentGraph(dataDir, graph);
  if ("conflictRev" in outcome) throw mismatch(outcome.conflictRev);
  console.log(JSON.stringify({ work_id: workId, rev: outcome.saved.rev }));
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

function runPdfPath(docId: string, dataDir: string): void {
  const paths = libraryPaths(dataDir);
  const unknown = (): Error => new Error(unknownMsg("PDF doc", docId, pdfDocIds(paths)));
  const plainName = docId !== "" && !/[/\\]/.test(docId) && !docId.startsWith(".");
  if (!plainName || !existsSync(paths.outputDir)) throw unknown();
  let metadata: ReturnType<typeof readPdfMetadataIfPresent>;
  try {
    metadata = readPdfMetadataIfPresent(paths, docId);
  } catch (e) {
    throw new Error(`doc "${docId}": ${e instanceof Error ? e.message : String(e)}`);
  }
  if (metadata === null) {
    if (existsSync(join(paths.outputDir, docId, `${docId}.json`))) {
      throw new Error(`doc "${docId}" is not a PDF doc`);
    }
    throw unknown();
  }
  const original = join(realpathSync(paths.outputDir), docId, "original.pdf");
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(original);
  } catch {
    throw new Error(`the original PDF of doc "${docId}" is missing`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`the original PDF of doc "${docId}" is not a regular file`);
  }
  console.log(original);
}

// --------------------------------------------------------------------------- //
// Registration
// --------------------------------------------------------------------------- //

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
      try {
        runArgumentGet(workId, resolveDataDir(cmd.optsWithGlobals()));
      } catch (e) {
        fail(e);
      }
    });

  withDataDir(argument.command("put"))
    .description(
      'Replace the work\'s whole argument graph from a JSON file ("-" reads stdin). ' +
        "--rev must be the rev `argument get` printed; a work that already has arguments also needs " +
        "--replace. The file's own rev is ignored; its work_id may be left out but must match if present."
    )
    .argument("<workId>", "library work id (see `search`)")
    .argument("<file>", 'JSON file with the whole graph, or "-" for stdin')
    .requiredOption("--rev <n>", "the rev of the graph you read (0 when the work has none)")
    .option("--replace", "allow replacing a graph that already has arguments")
    .action((workId: string, file: string, opts: PutOpts, cmd: Command) => {
      try {
        runArgumentPut(workId, file, opts, resolveDataDir(cmd.optsWithGlobals()));
      } catch (e) {
        fail(e);
      }
    });

  withDataDir(program.command("pdf-path"))
    .description(
      "Print the absolute path of a PDF doc's original file (read-only; the PDF itself is not read)."
    )
    .argument("<docId>", "PDF doc id (pdf-…, see `search` doc_ids)")
    .action((docId: string, _opts: { dataDir?: string }, cmd: Command) => {
      try {
        runPdfPath(docId, resolveDataDir(cmd.optsWithGlobals()));
      } catch (e) {
        fail(e);
      }
    });
}
