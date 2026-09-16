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

import { spawn } from "node:child_process";

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
  opts: { cwd?: string; timeoutMs: number; env?: Record<string, string>; signal?: AbortSignal }
): Promise<TexProcResult> {
  opts.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      // additive merge (Stage 10: writer numbering compile needs TEXINPUTS);
      // existing callers pass no env and get the parent's unchanged.
      ...(opts.env !== undefined ? { env: { ...process.env, ...opts.env } } : {}),
    });

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
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", kill);
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
