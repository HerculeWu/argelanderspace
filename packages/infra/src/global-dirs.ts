/**
 * Global data and global cache directories (ADR 0007). Per-user, shared by
 * every project; never derived from dataDir and never holds project data.
 *
 * Precedence per directory: env var > config.toml key > env-paths OS default
 * (name `argelanderspace`, no suffix):
 *
 *   data   $ARGELANDERSPACE_GLOBAL_DIR        global_dir
 *   cache  $ARGELANDERSPACE_GLOBAL_CACHE_DIR  global_cache_dir
 *
 * Resolving never touches the filesystem (it reads config.toml when no
 * `config` is passed); OS defaults come from env-paths, which fixes homedir at
 * import, so `opts.env` cannot redirect HOME/XDG_*. `ensureGlobalDirs` creates
 * the directories on demand with mode 0700 (they may hold credentials).
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import envPaths from "env-paths";
import { type AppConfig, getConfig } from "./config.js";

export interface GlobalDirs {
  dataDir: string;
  cacheDir: string;
}

export interface GlobalDirsOptions {
  env?: NodeJS.ProcessEnv;
  config?: AppConfig;
}

function pick(envValue: string | undefined, configValue: string | undefined): string | undefined {
  const fromEnv = envValue?.trim();
  if (fromEnv) return resolve(fromEnv);
  const fromConfig = configValue?.trim();
  return fromConfig ? resolve(fromConfig) : undefined;
}

export function resolveGlobalDirs(opts: GlobalDirsOptions = {}): GlobalDirs {
  const env = opts.env ?? process.env;
  const config = opts.config ?? getConfig();
  const defaults = envPaths("argelanderspace", { suffix: "" });
  return {
    dataDir: pick(env.ARGELANDERSPACE_GLOBAL_DIR, config.global_dir) ?? defaults.data,
    cacheDir: pick(env.ARGELANDERSPACE_GLOBAL_CACHE_DIR, config.global_cache_dir) ?? defaults.cache,
  };
}

/** Resolve and create both directories (idempotent). */
export function ensureGlobalDirs(opts: GlobalDirsOptions = {}): GlobalDirs {
  const dirs = resolveGlobalDirs(opts);
  mkdirSync(dirs.dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(dirs.cacheDir, { recursive: true, mode: 0o700 });
  return dirs;
}
