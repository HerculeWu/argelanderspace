/**
 * Locating external executables on PATH (`shutil.which`) and running them
 * synchronously with captured output (`subprocess.run(..., capture_output)`).
 * Used by the pandoc adapter and the Ghostscript EPS rasterizer.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/** `shutil.which(name)`: first executable named `name` on PATH, else null. */
export function findOnPath(
  name: string,
  pathEnv: string | undefined = process.env.PATH
): string | null {
  if (isAbsolute(name) || name.includes("/")) {
    try {
      accessSync(name, constants.X_OK);
      return name;
    } catch {
      return null;
    }
  }
  for (const dir of (pathEnv ?? "").split(delimiter)) {
    if (!dir) continue;
    const cand = join(dir, name);
    try {
      accessSync(cand, constants.X_OK);
      return cand;
    } catch {
      // not here — keep looking
    }
  }
  return null;
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  /** Set when the process could not be run to completion (timeout/kill). */
  error?: Error;
}

/**
 * `subprocess.run(argv, input=..., capture_output=True, text=True,
 * timeout=...)`. `timeout` is in seconds like Python's. stdout is captured
 * with a large buffer (pandoc ASTs run to tens of MB).
 */
export function runCapture(
  argv: readonly string[],
  opts: { cwd?: string; stdin?: string; timeout?: number } = {}
): RunResult {
  const proc = spawnSync(argv[0] ?? "", argv.slice(1), {
    cwd: opts.cwd,
    input: opts.stdin,
    encoding: "utf-8",
    timeout: opts.timeout !== undefined ? opts.timeout * 1000 : undefined,
    maxBuffer: 512 * 1024 * 1024,
  });
  return {
    status: typeof proc.status === "number" ? proc.status : -1,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
    error: proc.error,
  };
}
