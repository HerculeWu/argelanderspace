/**
 * Where the complete latexmk log of a failed compile is kept, and what the user-level log says of the failure
 * (desktop-app ticket 08). infra `tex/failure-log.ts` writes the file before `compileTex` clears latexmk's run
 * state; this file names the place, prunes it, and writes the record.
 *
 * The kept log is a file of the project — it quotes the source — and is not part of the user-level log:
 *   - a failed ingest job: `<dataDir>/jobs/<job id>.compile.log`, beside the job's record (a failed ingest has no
 *     Doc directory). The newest {@link INGEST_FAILURE_LOGS_KEPT} of a project are kept. While a job compiles, the
 *     log is collected in `<job id>.compile.log.partial`; one left behind by a run that was killed is removed when
 *     the server next starts, or by the pruning once it is older than any compile can run;
 *   - a Writer render: `<dataDir>/manuscripts/<manuscript id>/build/compile-failure.log`, the log of the last
 *     render if that render failed (each failure replaces it; a render that succeeds removes it).
 *
 * The record (`tex.compile_failed`) carries no line of the log and no message: which job or manuscript, the
 * engine, the exit code, what was missing, and where the kept log is, relative to the project data directory.
 * What was missing comes out of the log, which is text the document controls:
 *   - a file of the kind a TeX distribution ships — judged by its extension, {@link TEX_DISTRIBUTION_EXTENSIONS} —
 *     is recorded by name, and only if the name has the shape of a plain file name;
 *   - anything else (a figure, a `.tex`, a `.bib`) is the user's own file: only its extension is recorded, and only
 *     when it is one of {@link USER_FILE_EXTENSIONS}; otherwise `other`, or `none` when there is no extension.
 */

import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { JobKindSchema, ManuscriptIdSchema } from "@argelanderspace/contracts";
import {
  f,
  type LogField,
  type TexCompileFailure,
  type TexFailureLogHook,
} from "@argelanderspace/infra";
import { type ServerLog, silentLog } from "./log.js";

export const INGEST_FAILURE_LOGS_KEPT = 20;
/**
 * How old (by its last write) a collecting file must be before the pruning of a running server removes it. A
 * compile appends to the file after each failed latexmk attempt, an attempt ends at its timeout (two minutes by
 * default) and jobs run one at a time — an hour without a write means nothing is collecting into it.
 */
export const INGEST_PARTIAL_STALE_MS = 60 * 60 * 1000;
const INGEST_LOG_SUFFIX = ".compile.log";
export const WRITER_FAILURE_LOG_NAME = "compile-failure.log";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const JOB_ID = new RegExp(`^(?:${JobKindSchema.options.join("|")})-${UUID}$`);
const INGEST_LOG_NAME = new RegExp(
  `^(?:${JobKindSchema.options.join("|")})-${UUID}${INGEST_LOG_SUFFIX.replaceAll(".", "\\.")}$`
);

const INGEST_PARTIAL_NAME = new RegExp(
  `^(?:${JobKindSchema.options.join("|")})-${UUID}${INGEST_LOG_SUFFIX.replaceAll(".", "\\.")}\\.partial$`
);

/** `<dataDir>/jobs/<job id>.compile.log`. */
export function ingestFailureLogPath(jobsDir: string, jobId: string): string {
  return join(jobsDir, `${jobId}${INGEST_LOG_SUFFIX}`);
}

/** `<dataDir>/manuscripts/<id>/build/compile-failure.log`. */
export function writerFailureLogPath(buildDir: string): string {
  return join(buildDir, WRITER_FAILURE_LOG_NAME);
}

/**
 * A render that succeeded: the log of the failure before it is not the last render's any more and is removed (a
 * manuscript long since fixed keeps no failure log). A plain file only; what cannot be removed stays, and the
 * render is not affected.
 */
export function removeWriterFailureLog(buildDir: string): void {
  try {
    rmSync(writerFailureLogPath(buildDir), { force: true });
  } catch {
    /* the render succeeded all the same */
  }
}

/**
 * Keeps the newest {@link INGEST_FAILURE_LOGS_KEPT} ingest failure logs of a project (by modification time, then by
 * name) and removes the rest, and removes collecting files nothing has written to for
 * {@link INGEST_PARTIAL_STALE_MS}. Only files named like one are looked at; nothing else in the jobs directory is
 * touched.
 */
export function pruneIngestFailureLogs(jobsDir: string, keep = INGEST_FAILURE_LOGS_KEPT): void {
  const logs: Array<{ name: string; mtimeMs: number }> = [];
  for (const entry of readdirSync(jobsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !INGEST_LOG_NAME.test(entry.name)) continue;
    try {
      logs.push({ name: entry.name, mtimeMs: statSync(join(jobsDir, entry.name)).mtimeMs });
    } catch {
      /* gone meanwhile */
    }
  }
  logs.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1));
  for (const old of logs.slice(Math.max(0, keep))) rmSync(join(jobsDir, old.name), { force: true });
  sweepIngestPartials(jobsDir, INGEST_PARTIAL_STALE_MS);
}

/**
 * Removes the collecting files (`<job id>.compile.log.partial`) of ingest jobs that were not written to for
 * `olderThanMs` — all of them by default, which is right only when no job of this directory is running (a server
 * that is starting). Plain files named like one only; never throws.
 */
export function sweepIngestPartials(jobsDir: string, olderThanMs = 0): void {
  try {
    const now = Date.now();
    for (const entry of readdirSync(jobsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !INGEST_PARTIAL_NAME.test(entry.name)) continue;
      try {
        const file = join(jobsDir, entry.name);
        if (olderThanMs > 0 && now - statSync(file).mtimeMs < olderThanMs) continue;
        rmSync(file, { force: true });
      } catch {
        /* gone meanwhile, or not removable: left for the next time */
      }
    }
  } catch {
    /* no jobs directory yet */
  }
}

// --------------------------------------------------------------------------- //
// What was missing
// --------------------------------------------------------------------------- //

/**
 * The extensions of files a TeX distribution ships and a document asks for by name: packages and classes and their
 * option, definition and configuration files, font definitions and metrics, bibliography styles, babel and
 * biblatex language and style files. A missing file with one of these is recorded by name.
 */
export const TEX_DISTRIBUTION_EXTENSIONS = [
  "sty",
  "cls",
  "clo",
  "def",
  "cfg",
  "fd",
  "tfm",
  "vf",
  "enc",
  "map",
  "bst",
  "ldf",
  "bbx",
  "cbx",
  "lbx",
] as const;

/** The extensions a missing file of the user's own is recorded by; the name is never recorded. */
export const USER_FILE_EXTENSIONS = [
  "tex",
  "ltx",
  "bib",
  "bbl",
  "aux",
  "toc",
  "ind",
  "gls",
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "eps",
  "ps",
  "svg",
  "gif",
  "tif",
  "tiff",
  "bmp",
  "pgf",
  "tikz",
  "csv",
  "dat",
  "txt",
  "otf",
  "ttf",
  "other",
  "none",
] as const;

// A plain file name: letters, digits and `._+-`, no separator, no space; short.
const PLAIN_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const EXTENSION = /\.([A-Za-z0-9]{1,8})$/;

export interface MissingTexFiles {
  /** Distribution-kind files by name (`nosuch.sty`), at most 16. */
  names: string[];
  /** The extensions of the other missing files, each once. */
  otherExtensions: string[];
}

export function classifyMissingTexFiles(missing: readonly unknown[]): MissingTexFiles {
  const names: string[] = [];
  const otherExtensions: string[] = [];
  const note = (ext: string): void => {
    if (!otherExtensions.includes(ext)) otherExtensions.push(ext);
  };
  for (const raw of missing) {
    if (typeof raw !== "string") continue;
    const ext = EXTENSION.exec(raw)?.[1]?.toLowerCase();
    if (ext !== undefined && (TEX_DISTRIBUTION_EXTENSIONS as readonly string[]).includes(ext)) {
      // A distribution-kind name that is not a plain file name (it has a directory, a space, other characters) is
      // not recorded at all: not by name, and its extension says nothing the name list does not.
      if (PLAIN_FILE_NAME.test(raw) && !names.includes(raw) && names.length < 16) names.push(raw);
      continue;
    }
    if (ext === undefined) note("none");
    else note((USER_FILE_EXTENSIONS as readonly string[]).includes(ext) ? ext : "other");
  }
  return { names, otherExtensions };
}

// --------------------------------------------------------------------------- //
// The record
// --------------------------------------------------------------------------- //

const ENGINES = ["pdflatex", "xelatex"] as const;
const KINDS = ["compile-error", "compile-timeout", "unsupported-build"] as const;
const SOURCES = ["ingest", "writer"] as const;
const YES_NO = ["yes", "no"] as const;

/**
 * The place of a Writer's kept log, relative to the project data directory. A manuscript id has an underscore, which
 * an identifier field does not take, so the path is written as this fixed text and the id's random part goes in
 * the `manuscript` field beside it.
 */
const WRITER_LOG_FILES = [`manuscripts/m_<manuscript>/build/${WRITER_FAILURE_LOG_NAME}`] as const;

function record(
  log: ServerLog,
  failure: TexCompileFailure,
  who: Record<string, LogField>,
  /** Set when the log was kept: where, relative to the project data directory. */
  logFile: LogField | undefined
): void {
  const missing = classifyMissingTexFiles(failure.missingFiles);
  log.warn("tex.compile_failed", {
    ...who,
    kind: f.oneOf(KINDS, failure.kind),
    engine: f.oneOf(ENGINES, failure.engine),
    ...(typeof failure.exitCode === "number" ? { exit_code: f.num(failure.exitCode) } : {}),
    timed_out: f.oneOf(YES_NO, failure.timedOut ? "yes" : "no"),
    ...(missing.names.length > 0 ? { missing_tex_files: f.ids(missing.names) } : {}),
    ...(missing.otherExtensions.length > 0
      ? { missing_other_files: f.someOf(USER_FILE_EXTENSIONS, missing.otherExtensions) }
      : {}),
    ...(failure.logSaved && logFile !== undefined ? { log_file: logFile } : {}),
  });
}

/**
 * The keeper for one ingest job: the log goes beside the job's record, older ones are pruned, the failure is
 * recorded. A job id of another shape than the runner's (`<kind>-<uuid>`) gets no keeper.
 */
export function ingestFailureLog(
  jobsDir: string,
  jobId: string,
  log: ServerLog = silentLog
): TexFailureLogHook | undefined {
  if (!JOB_ID.test(jobId)) return undefined;
  return {
    file: ingestFailureLogPath(jobsDir, jobId),
    onFailure: (failure) => {
      try {
        if (failure.logSaved) pruneIngestFailureLogs(jobsDir);
      } catch {
        /* pruning is best effort */
      }
      // The path is `jobs/` (written here) and the job id, whose shape — a kind and a random uuid — was checked above.
      record(
        log,
        failure,
        { source: f.oneOf(SOURCES, "ingest"), job: f.id(jobId) },
        f.id(`jobs/${jobId}${INGEST_LOG_SUFFIX}`)
      );
    },
  };
}

/** The record of a failed Writer render; the file itself is asked for by `computeWriterNumbering`. */
export function logWriterCompileFailure(
  log: ServerLog,
  manuscriptId: string,
  failure: TexCompileFailure
): void {
  // A manuscript id is `m_<8 hex digits>` (core `newManuscriptId`): random, nothing of the title in it. The digits
  // are what is recorded; an id of another shape is not.
  const known = ManuscriptIdSchema.safeParse(manuscriptId).success;
  record(
    log,
    failure,
    {
      source: f.oneOf(SOURCES, "writer"),
      manuscript: f.id(known ? manuscriptId.slice(2) : "unrecognized"),
    },
    known ? f.oneOf(WRITER_LOG_FILES, WRITER_LOG_FILES[0]) : undefined
  );
}
