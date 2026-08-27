/**
 * Shared CLI helpers: the `--data-dir` resolution chain (decisions 3 + 23),
 * the per-command `--data-dir` option, and the error printer. Extracted from
 * `program.ts` so the agent subcommands (`agent.ts`) share the exact same
 * chain without an import cycle; `program.ts` re-exports `resolveDataDir`.
 */

import { resolve } from "node:path";
import { type AppConfig, getConfig } from "@argelanderspace/infra";
import type { Command } from "commander";

/** flag > env > config file (decision 23) > ./data (same chain as the server's). */
export function resolveDataDir(
  opts: { dataDir?: string | undefined },
  env: NodeJS.ProcessEnv = process.env,
  config: AppConfig = getConfig()
): string {
  return resolve(opts.dataDir ?? env.ARGELANDERSPACE_DATA_DIR ?? config.data_dir ?? "./data");
}

/** Allow `--data-dir` after the subcommand as well as before it. */
export function withDataDir(cmd: Command): Command {
  return cmd.option(
    "--data-dir <dir>",
    "data directory (default ./data; env ARGELANDERSPACE_DATA_DIR)"
  );
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Print `error: <msg>` like the Python CLI and fail the process (no stack). */
export function fail(e: unknown): void {
  console.error(`error: ${errorMessage(e)}`);
  process.exitCode = 1;
}
