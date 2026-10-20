/**
 * The two chains every reader of config.toml shares (architecture-deepening ticket 10): `serve` and the desktop host
 * after their lenient reading, the CLI after its strict one. Neither reads a file — the reading, and what a faulty
 * value means, stay with the reader (hard contract 「产品与执行边界」 item 2: the CLI refuses an absolute `data_dir`,
 * `serve` and the host fall back to the default and name the key). No environment variable takes part.
 */

import { resolve } from "node:path";
import { DEFAULT_DATA_DIR, DEFAULT_PORT } from "@argelanderspace/contracts";
import type { AppConfig } from "./config.js";

/**
 * The project data directory: `override` (`--data-dir`, which may be absolute) > config `data_dir` (relative only)
 * > `./literatures`, resolved against the process's working directory, never searched upwards.
 */
export function dataDirOf(config: AppConfig, override?: string): string {
  return resolve(override ?? config.data_dir ?? DEFAULT_DATA_DIR);
}

/**
 * The configured port: config `port` > `DEFAULT_PORT`. What deep links point at and what the host tries first; never
 * the port a server happens to be bound to.
 */
export function portOf(config: AppConfig): number {
  return config.port ?? DEFAULT_PORT;
}
