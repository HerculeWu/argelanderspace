/**
 * The complete latexmk log of a failed compile, kept as a file of the project (desktop-app ticket 08).
 *
 * `compileTex` clears latexmk's run state after a failed run — the .log with it — so that a stable cache cannot
 * deadlock (compile.ts, `clearLatexmkRunState`). Before each such clearing what the attempt wrote is appended here;
 * when the whole compile has failed the collected file is moved to where the caller asked for it, and when the
 * compile succeeded after all (another engine, or the clean fallback) it is thrown away. The clearing itself is
 * untouched.
 *
 * An attempt's part of the file is, each under a marker line of its own: the engine's log (`<jobname>.log`), the
 * bibliography program's log (`<jobname>.blg`, bibtex's or biber's — the clearing removes it too, and an error of
 * that stage is nowhere else), and what latexmk itself printed to its standard output and standard error (which
 * rule it ran, which command failed).
 *
 * The file holds lines of the user's source, so it is not part of the user-level log: whoever asked for it decides
 * where it lives and how many are kept. A caller that asks for none (every CLI command) gets none, and nothing
 * here runs. Keeping the log never changes the compile: every failure in this file is swallowed.
 *
 * The engine's log is the text `compileTex` has already read from the workspace for its error excerpt. The .blg is
 * the one more file read from where the (possibly sandboxed) engine could write: only as a plain file, never
 * through a link ({@link readTexSideLog}). The kept file is written by this process outside the workspace.
 */
import { constants, promises as fs } from "node:fs";
import type { TexEngine } from "@argelanderspace/core";

/** What is known of the failed run whose error `compileTex` returned. */
export interface TexCompileFailure {
  kind: "compile-error" | "compile-timeout" | "unsupported-build";
  engine: TexEngine;
  /** Null when latexmk was killed (a timeout) or ended on a signal. */
  exitCode: number | null;
  timedOut: boolean;
  /**
   * The files the log says could not be found. These are strings cut out of the log — text the document controls —
   * and are handed on as they are: the receiver decides what it may keep of them.
   */
  missingFiles: string[];
  /** Whether the complete log is now at the path the caller asked for. */
  logSaved: boolean;
}

export interface TexFailureLogHook {
  /** Absolute path the complete log of a failed compile is written to, replacing what was there. */
  file: string;
  /** Told once per failed compile in which latexmk ran, after the file is in place. May not throw (it is swallowed). */
  onFailure?: (failure: TexCompileFailure) => void | Promise<void>;
}

/** One failed latexmk run, as `compileTex` saw it. */
export interface TexFailedAttempt {
  engine: TexEngine;
  instrumented: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** The engine's log, `<jobname>.log`; empty when none was written. */
  log: string;
  /** The bibliography program's log, `<jobname>.blg`; empty when there is none. */
  bibLog: string;
  /** What latexmk printed. */
  stdout: string;
  stderr: string;
}

/**
 * What one attempt may take of the kept file, its marker lines aside. The three smaller parts — the .blg, latexmk's
 * standard output, its standard error — each keep at most {@link TEX_FAILURE_LOG_PART_MAX_BYTES}; the engine's log
 * keeps what is left of this limit after them (so never less than 13 MiB). A part that is longer keeps its two ends,
 * with a line between them saying how many bytes were left out.
 */
export const TEX_FAILURE_LOG_ATTEMPT_MAX_BYTES = 16 * 1024 * 1024;
export const TEX_FAILURE_LOG_PART_MAX_BYTES = 1024 * 1024;
export const TEX_MISSING_FILES_MAX = 32;

function bounded(text: string, limit: number): { text: string; bytes: number } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return { text, bytes: bytes.length };
  const head = Math.ceil(limit / 2);
  const tail = limit - head;
  return {
    text:
      bytes.subarray(0, head).toString("utf8") +
      `\n%% argelanderspace: ${bytes.length - limit} bytes left out here\n` +
      bytes.subarray(bytes.length - tail).toString("utf8"),
    bytes: limit,
  };
}

const ended = (text: string): string => (text.endsWith("\n") ? text : `${text}\n`);

/**
 * The text of a log the bibliography program wrote into the compile workspace, or "" when there is none. Read only
 * when it is a plain file — a link is not followed — and, when it is longer than a part of the kept file may be,
 * only its two ends are read.
 */
export async function readTexSideLog(file: string): Promise<string> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) return "";
    if (stat.size <= TEX_FAILURE_LOG_PART_MAX_BYTES) return await handle.readFile("utf8");
    const end = TEX_FAILURE_LOG_PART_MAX_BYTES / 4;
    const head = Buffer.alloc(end);
    const tail = Buffer.alloc(end);
    await handle.read(head, 0, end, 0);
    await handle.read(tail, 0, end, stat.size - end);
    return (
      head.toString("utf8") +
      `\n%% argelanderspace: ${stat.size - 2 * end} bytes left out here\n` +
      tail.toString("utf8")
    );
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * The file names a failed run reports as missing, in the order they appear, each once: in the engine's log, in the
 * bibliography program's log, in what latexmk printed. A name is whatever stands between the quotes (or, for
 * bibtex, up to the end of the line): not trusted, not checked here.
 */
export function missingFilesFromTexLog(log: string): string[] {
  const found: string[] = [];
  const add = (name: string | undefined): void => {
    if (name === undefined || name === "" || found.includes(name)) return;
    if (found.length < TEX_MISSING_FILES_MAX) found.push(name);
  };
  // `! LaTeX Error: File `x.sty' not found.`, `! Package pdftex.def Error: File `fig.pdf' not found`,
  // `LaTeX Warning: File `fig' not found on input line 3.`, `! I can't find file `chapter'.`
  const quoted = /(?:File [`']([^`'\n]+)' not found|! I can't find file [`']([^`'\n]+)')/g;
  for (const m of log.matchAll(quoted)) add(m[1] ?? m[2]);
  // `! Font \x=nosuchfont not loadable: Metric (TFM) file not found.`
  const font =
    /! Font [^=\n]*=([^\s=]+)(?: at \S+| scaled \d+)? not loadable: Metric \(TFM\) file/g;
  for (const m of log.matchAll(font)) add(`${m[1]}.tfm`);
  // bibtex (.blg): `I couldn't open style file nosuch.bst`, `I couldn't open database file refs.bib`;
  // biber (.blg): `ERROR - Cannot find 'refs.bib'!`
  const bibliography =
    /(?:^I couldn't open (?:style|database) file ([^\n]+)$|ERROR - Cannot find '([^'\n]+)'!)/gm;
  for (const m of log.matchAll(bibliography)) add((m[1] ?? m[2])?.trim());
  return found;
}

/** Collects the logs of the failed attempts of one `compileTex` call. */
export class TexFailureCapture {
  private readonly partial: string;
  /** A failed attempt was handed in (whether or not it could be written). */
  private seen = false;
  /** The collecting file is this capture's own: what stood there was removed. */
  private started = false;
  private broken = false;

  constructor(private readonly hook: TexFailureLogHook) {
    this.partial = `${hook.file}.partial`;
  }

  /** Called before the attempt's run state is cleared. */
  async add(attempt: TexFailedAttempt): Promise<void> {
    this.seen = true;
    if (this.broken) return;
    try {
      if (!this.started) {
        // A leftover (a file or a link of that name) is removed, never written through. A directory there is not
        // ours: it is left alone with what is in it, the removal fails, and no log is kept.
        await fs.rm(this.partial, { force: true });
        this.started = true;
      }
      const header =
        `%% argelanderspace: latexmk attempt — engine ${attempt.engine}, ` +
        `${attempt.instrumented ? "instrumented" : "clean"}, ` +
        `${attempt.timedOut ? "timed out" : `exit code ${attempt.exitCode ?? "none"}`}\n`;
      // The smaller parts first take what they hold; the engine's log has the rest of the attempt's limit.
      let rest = TEX_FAILURE_LOG_ATTEMPT_MAX_BYTES;
      const parts: string[] = [];
      for (const [title, text] of [
        ["bibliography log (.blg)", attempt.bibLog],
        ["latexmk's standard output", attempt.stdout],
        ["latexmk's standard error", attempt.stderr],
      ] as const) {
        if (text === "") continue;
        const kept = bounded(text, TEX_FAILURE_LOG_PART_MAX_BYTES);
        rest -= kept.bytes;
        parts.push(`%% argelanderspace: ${title} of this attempt\n${ended(kept.text)}`);
      }
      const body =
        attempt.log === ""
          ? "%% argelanderspace: no log was written\n"
          : ended(bounded(attempt.log, rest).text);
      const handle = await fs.open(this.partial, "a", 0o600);
      try {
        await handle.appendFile(`${header}${body}${parts.join("")}`, "utf8");
      } finally {
        await handle.close();
      }
    } catch {
      this.broken = true;
    }
  }

  /** The compile did not fail, or ended by being cancelled: nothing is kept. */
  async discard(): Promise<void> {
    // Only what `add` may have written: a file (or a link) of that name, never a directory.
    if (!this.started) return;
    await fs.rm(this.partial, { force: true }).catch(() => {});
  }

  /** The compile failed; `failure` is null when latexmk never ran (nothing to keep, nobody to tell). */
  async finish(failure: Omit<TexCompileFailure, "logSaved"> | null): Promise<void> {
    if (failure === null || !this.seen) {
      await this.discard();
      return;
    }
    let logSaved = false;
    if (!this.broken) {
      try {
        await fs.rename(this.partial, this.hook.file);
        logSaved = true;
      } catch {
        await this.discard();
      }
    } else await this.discard();
    try {
      await this.hook.onFailure?.({ ...failure, logSaved });
    } catch {
      /* keeping the log never changes the compile */
    }
  }
}
