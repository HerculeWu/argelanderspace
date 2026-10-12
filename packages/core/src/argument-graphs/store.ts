/**
 * The argument-graph store (ADR 0009): one file per Work,
 * `<dataDir>/argument-graphs/<encoded work id>.json`. Not part of
 * `library.json`, not a Doc, not tied to any content fingerprint.
 *
 * Same write discipline as the plan store: pretty JSON (2 spaces), persisted
 * `rev` optimistic lock, same-directory tmp file + rename. Writes assume the
 * server serializes mutations per process; a cross-process concurrent write
 * of one graph is unsupported (contracts, I013's boundary) and there is no file
 * lock.
 *
 * Failure semantics: a missing file is the empty graph at rev 0. A file that
 * is not valid JSON, fails the schema, claims another Work, or carries a
 * version this build does not know is a SYSTEM error ({@link ArgumentGraphFileError}),
 * never "no graph": it may be the user's only copy, so it is neither reset nor
 * overwritten (a replace on top of it throws too).
 *
 * File names: a Work id holds `:` and `/` (`doi:10.1051/0004-6361/…`), so the
 * id is percent-encoded byte-wise; every byte outside `[A-Za-z0-9_-]` becomes
 * `%XX` (upper-case hex of the UTF-8 byte, `.` included so no name is `.`, `..`
 * or hidden). The mapping is injective and reversible.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type ArgumentGraph, ArgumentGraphSchema } from "@argelanderspace/contracts";

export const ARGUMENT_GRAPH_DIR = "argument-graphs";

/** Longest file name we accept (most filesystems cap a name at 255 bytes). */
const MAX_FILE_NAME = 240;

export class ArgumentGraphFileError extends Error {
  constructor(
    readonly kind: "corrupt" | "future_version" | "wrong_work" | "unsafe_id",
    message: string
  ) {
    super(message);
    this.name = "ArgumentGraphFileError";
  }
}

export function argumentGraphDir(dataDir: string): string {
  return join(dataDir, ARGUMENT_GRAPH_DIR);
}

/**
 * Work id → file stem (without `.json`). Throws `unsafe_id` for an empty id,
 * one that is not well-formed Unicode (a lone surrogate would encode to U+FFFD
 * and collide with another id), or one whose file name would exceed 240 bytes.
 */
export function encodeWorkIdForFile(workId: string): string {
  if (workId === "") throw new ArgumentGraphFileError("unsafe_id", "argument graph: empty work id");
  if (/\p{Surrogate}/u.test(workId)) {
    // with the u flag only a LONE surrogate is a match (pairs are one code point)
    throw new ArgumentGraphFileError(
      "unsafe_id",
      "argument graph: work id is not well-formed Unicode"
    );
  }
  let out = "";
  for (const byte of Buffer.from(workId, "utf8")) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9_-]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  if (out.length + ".json".length > MAX_FILE_NAME) {
    throw new ArgumentGraphFileError(
      "unsafe_id",
      "argument graph: work id too long for a file name"
    );
  }
  return out;
}

/** Inverse of {@link encodeWorkIdForFile}; `null` if `stem` is not a name this store would write. */
export function decodeWorkIdFromFile(stem: string): string | null {
  if (stem === "" || /[^A-Za-z0-9_%-]/.test(stem)) return null;
  const bytes: number[] = [];
  for (let i = 0; i < stem.length; i++) {
    const ch = stem.charAt(i);
    if (ch === "%") {
      const hex = stem.slice(i + 1, i + 3);
      if (!/^[0-9A-F]{2}$/.test(hex)) return null;
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(ch.charCodeAt(0));
    }
  }
  const decoded = Buffer.from(bytes).toString("utf8");
  // Only canonical names count (rejects invalid UTF-8 and over-escaped letters).
  try {
    return encodeWorkIdForFile(decoded) === stem ? decoded : null;
  } catch {
    return null;
  }
}

export function argumentGraphPath(dataDir: string, workId: string): string {
  return join(argumentGraphDir(dataDir), `${encodeWorkIdForFile(workId)}.json`);
}

/** Work ids that currently have a graph file (undecodable names are skipped). */
export function listArgumentGraphWorkIds(dataDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(argumentGraphDir(dataDir));
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = decodeWorkIdFromFile(name.slice(0, -".json".length));
    if (id !== null) ids.push(id);
  }
  return ids.sort();
}

/** The graph of a Work that has none: rev 0, nothing in it. */
export function emptyArgumentGraph(workId: string): ArgumentGraph {
  return { version: 1, rev: 0, work_id: workId, arguments: [], edges: [] };
}

function formatIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
}

/**
 * Read a Work's graph. Missing file → the empty graph (rev 0). Anything
 * unreadable throws {@link ArgumentGraphFileError}; nothing is rewritten.
 */
export function loadArgumentGraph(dataDir: string, workId: string): ArgumentGraph {
  const file = argumentGraphPath(dataDir, workId);
  if (!existsSync(file)) return emptyArgumentGraph(workId);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new ArgumentGraphFileError(
      "corrupt",
      `argument graph: ${file} could not be read: ${(err as Error).message}`
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new ArgumentGraphFileError(
      "corrupt",
      `argument graph: ${file} is not valid JSON: ${(err as Error).message}`
    );
  }
  const version = (data as { version?: unknown } | null)?.version;
  if (typeof version === "number" && version > 1) {
    throw new ArgumentGraphFileError(
      "future_version",
      `argument graph: ${file} has version ${version}; this build only reads version 1`
    );
  }
  const result = ArgumentGraphSchema.safeParse(data);
  if (!result.success) {
    throw new ArgumentGraphFileError(
      "corrupt",
      `argument graph: ${file} failed schema validation: ${formatIssues(result.error)}`
    );
  }
  if (result.data.work_id !== workId) {
    throw new ArgumentGraphFileError(
      "wrong_work",
      `argument graph: ${file} belongs to work ${JSON.stringify(result.data.work_id)}`
    );
  }
  return result.data;
}

export type ReplaceArgumentGraphOutcome = { saved: ArgumentGraph } | { conflictRev: number };

/**
 * Whole-graph replace with the rev optimistic lock: `graph.rev` must equal the
 * stored rev (0 for a missing file), the save persists `rev + 1`. A mismatch
 * returns `{conflictRev}` and writes nothing. A corrupt / future-version
 * stored file throws before anything is written. `graph` must already be
 * schema-valid (the caller parsed it); it is re-validated here as a gate.
 */
export function replaceArgumentGraph(
  dataDir: string,
  graph: ArgumentGraph
): ReplaceArgumentGraphOutcome {
  const current = loadArgumentGraph(dataDir, graph.work_id);
  if (graph.rev !== current.rev) return { conflictRev: current.rev };
  const out: ArgumentGraph = { ...graph, rev: graph.rev + 1 };
  const result = ArgumentGraphSchema.safeParse(out);
  if (!result.success) {
    throw new Error(
      `argument graph: refusing to write an invalid graph: ${formatIssues(result.error)}`
    );
  }
  const file = argumentGraphPath(dataDir, graph.work_id);
  mkdirSync(argumentGraphDir(dataDir), { recursive: true });
  const tmp = file.replace(/\.json$/, ".json.tmp");
  writeFileSync(tmp, JSON.stringify(result.data, null, 2), "utf8");
  renameSync(tmp, file);
  return { saved: result.data };
}
