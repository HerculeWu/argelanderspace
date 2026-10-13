/**
 * Minimal async process runner with timeout for the TeX toolchain.
 *
 * Unlike `lib/proc.ts` (`spawnSync`, used by the pandoc adapter), the TeX
 * runs take tens of seconds, so they must not block the event loop. The
 * child is spawned detached (own process group) so a timeout SIGKILL takes
 * the whole group down — latexmk otherwise orphans its engine children.
 *
 * `opts.env` (Stage 10 writer numbering compile) is merged over `process.env`
 * so callers can add e.g. TEXINPUTS without rebuilding the environment.
 */

import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { type ExternalObserver, type ExternalProgram, reportProgram } from "../lib/observe.js";

export interface TexProcResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export function runTexProcess(
  cmd: string,
  args: readonly string[],
  opts: {
    cwd?: string;
    timeoutMs: number;
    env?: Record<string, string>;
    /** Use `env` as the whole environment instead of merging it over the parent (a scrubbed child). */
    replaceEnv?: boolean;
    /** Bytes written to a fourth pipe (fd 3) of the child (bwrap `--args 3`), so they appear in no command line. */
    fdInput?: Buffer;
    signal?: AbortSignal;
    /**
     * Who is told how the run ended (lib/observe.ts): the program by its name from the fixed list — `cmd` may be the
     * sandbox's path — its exit code and how long it took. Never the arguments.
     */
    observe?: {
      observer: ExternalObserver | undefined;
      program: ExternalProgram;
      sandboxed?: boolean;
    };
  }
): Promise<TexProcResult> {
  opts.signal?.throwIfAborted();
  const watched = opts.observe?.observer === undefined ? undefined : opts.observe;
  const started = watched ? performance.now() : 0;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: opts.fdInput ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      detached: true,
      // additive merge (Stage 10: writer numbering compile needs TEXINPUTS);
      // existing callers pass no env and get the parent's unchanged.
      ...(opts.env !== undefined
        ? { env: opts.replaceEnv ? { ...opts.env } : { ...process.env, ...opts.env } }
        : {}),
    }) as unknown as ChildProcessByStdio<null, Readable, Readable>;

    if (opts.fdInput)
      (child.stdio[3] as unknown as import("node:stream").Writable).end(opts.fdInput);
    let timedOut = false;
    const kill = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    opts.signal?.addEventListener("abort", kill, { once: true });
    if (opts.signal?.aborted) kill();

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => stdout.push(d));
    child.stderr.on("data", (d: Buffer) => stderr.push(d));
    child.on("error", (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", kill);
      if (watched)
        reportProgram(watched.observer, {
          program: watched.program,
          sandboxed: watched.sandboxed === true,
          exitCode: null,
          signal: null,
          timedOut,
          durationMs: performance.now() - started,
          error: err,
        });
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", kill);
      if (watched)
        reportProgram(watched.observer, {
          program: watched.program,
          sandboxed: watched.sandboxed === true,
          exitCode: code,
          signal,
          timedOut,
          durationMs: performance.now() - started,
        });
      resolve({
        code,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}
