/**
 * The complete latexmk log of a failed compile, kept as a file of the project (desktop-app ticket 08).
 *
 * `compileTex` clears latexmk's run state after a failed run — the .log with it — so that a stable cache cannot
 * deadlock (compile.ts, `clearLatexmkRunState`). Before each such clearing the attempt's log is appended here; when
 * the whole compile has failed the collected file is moved to where the caller asked for it, and when the compile
 * succeeded after all (another engine, or the clean fallback) it is thrown away. The clearing itself is untouched.
 *
 * The file holds lines of the user's source, so it is not part of the user-level log: whoever asked for it decides
 * where it lives and how many are kept. A caller that asks for none (every CLI command) gets none, and nothing
 * here runs. Keeping the log never changes the compile: every failure in this file is swallowed.
 *
 * The text is the one `compileTex` has already read from the workspace for its error excerpt; nothing more is read
 * from where the (possibly sandboxed) engine could write, and the file is written by this process outside it.
 */
import { promises as fs } from "node:fs";
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
  log: string;
}

/** Each attempt's log is kept whole up to this size; a longer one keeps its two ends. */
export const TEX_FAILURE_LOG_ATTEMPT_MAX_BYTES = 16 * 1024 * 1024;
export const TEX_MISSING_FILES_MAX = 32;

function bounded(log: string): string {
  const bytes = Buffer.from(log, "utf8");
  if (bytes.length <= TEX_FAILURE_LOG_ATTEMPT_MAX_BYTES) return log;
  const half = TEX_FAILURE_LOG_ATTEMPT_MAX_BYTES / 2;
  const cut = bytes.length - 2 * half;
  return (
    bytes.subarray(0, half).toString("utf8") +
    `\n%% argelanderspace: ${cut} bytes left out here\n` +
    bytes.subarray(bytes.length - half).toString("utf8")
  );
}

/**
 * The file names a TeX log reports as missing, in the order they appear, each once. A name is whatever stands
 * between the quotes: not trusted, not checked here.
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
  return found;
}

/** Collects the logs of the failed attempts of one `compileTex` call. */
export class TexFailureCapture {
  private readonly partial: string;
  private started = false;
  private broken = false;

  constructor(private readonly hook: TexFailureLogHook) {
    this.partial = `${hook.file}.partial`;
  }

  /** Called before the attempt's run state is cleared. */
  async add(attempt: TexFailedAttempt): Promise<void> {
    if (this.broken) return;
    try {
      if (!this.started) {
        // A leftover (or anything else of that name, a link included) is removed, never written through.
        await fs.rm(this.partial, { force: true, recursive: true });
        this.started = true;
      }
      const header =
        `%% argelanderspace: latexmk attempt — engine ${attempt.engine}, ` +
        `${attempt.instrumented ? "instrumented" : "clean"}, ` +
        `${attempt.timedOut ? "timed out" : `exit code ${attempt.exitCode ?? "none"}`}\n`;
      const body =
        attempt.log === "" ? "%% argelanderspace: no log was written\n" : bounded(attempt.log);
      const handle = await fs.open(this.partial, "a", 0o600);
      try {
        await handle.appendFile(`${header}${body}${body.endsWith("\n") ? "" : "\n"}`, "utf8");
      } finally {
        await handle.close();
      }
    } catch {
      this.broken = true;
    }
  }

  /** The compile did not fail, or ended by being cancelled: nothing is kept. */
  async discard(): Promise<void> {
    await fs.rm(this.partial, { force: true, recursive: true }).catch(() => {});
  }

  /** The compile failed; `failure` is null when latexmk never ran (nothing to keep, nobody to tell). */
  async finish(failure: Omit<TexCompileFailure, "logSaved"> | null): Promise<void> {
    if (failure === null || !this.started) {
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
