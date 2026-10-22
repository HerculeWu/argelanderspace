/**
 * Shared CLI helpers: the `--data-dir` resolution chain (decisions 3 + 23),
 * the per-command `--data-dir` option, the error printer, and `realpathOr`. Extracted from
 * `program.ts` so the agent subcommands (`agent.ts`) share the exact same
 * chain without an import cycle; `program.ts` re-exports `resolveDataDir`.
 */

import { realpathSync } from "node:fs";
import { type AppConfig, dataDirOf, getConfig } from "@argelanderspace/infra";
import type { Command } from "commander";

/**
 * `--data-dir` > config file `data_dir` (decision 23; relative only) > ./literatures, resolved against the working
 * directory (same chain as the server's). No environment variable takes part.
 */
export function resolveDataDir(
  opts: { dataDir?: string | undefined },
  config: AppConfig = getConfig()
): string {
  return dataDirOf(config, opts.dataDir);
}

/** Help text of every `--data-dir` option. */
export const DATA_DIR_HELP = "data directory (default ./literatures, or data_dir in config.toml)";

/** Allow `--data-dir` after the subcommand as well as before it. */
export function withDataDir(cmd: Command): Command {
  return cmd.option("--data-dir <dir>", DATA_DIR_HELP);
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Print `error: <msg>` like the Python CLI and fail the process (no stack). */
export function fail(e: unknown): void {
  console.error(`error: ${errorMessage(e)}`);
  process.exitCode = 1;
}

/** The path with its symbolic links resolved; the path itself when that fails. */
export function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
