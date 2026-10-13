/**
 * Global data and global cache directories (ADR 0007). Per-user, shared by
 * every project; never derived from dataDir and never holds project data.
 *
 * Precedence per directory: config.toml key > env-paths OS default (name
 * `argelanderspace`, no suffix):
 *
 *   data   global_dir
 *   cache  global_cache_dir
 *
 * Resolving never touches the filesystem (it reads config.toml when no
 * `config` is passed); OS defaults come from env-paths, which fixes homedir at
 * import. `ensureGlobalDirs` creates
 * the directories on demand with mode 0700 (they may hold credentials).
 */

import { mkdirSync } from "node:fs";
import { posix, win32 } from "node:path";
import envPaths from "env-paths";
import { type AppConfig, ConfigError, getConfig } from "./config.js";

export interface GlobalDirs {
  dataDir: string;
  cacheDir: string;
}

export interface GlobalDirsOptions {
  config?: AppConfig;
}

/** Absolute-ness follows the detected platform's path rules, not the host's. */
function isAbsolutePath(p: string): boolean {
  if (process.platform !== "win32") return posix.isAbsolute(p);
  // "\\data" is rooted but drive-relative; require a drive letter or UNC prefix.
  return win32.isAbsolute(p) && /^([a-zA-Z]:|[\\/]{2})/.test(p);
}

/**
 * Overrides must be absolute: a relative one would resolve per working
 * directory and split "one global dir" across projects. Errors name the
 * key only, never the value.
 */
function pick(configKey: string, configValue: string | undefined): string | undefined {
  const fromConfig = configValue?.trim();
  if (!fromConfig) return undefined;
  if (!isAbsolutePath(fromConfig)) throw new ConfigError(`"${configKey}" must be an absolute path`);
  return fromConfig;
}

export function resolveGlobalDirs(opts: GlobalDirsOptions = {}): GlobalDirs {
  const config = opts.config ?? getConfig();
  const defaults = envPaths("argelanderspace", { suffix: "" });
  return {
    dataDir: pick("global_dir", config.global_dir) ?? defaults.data,
    cacheDir: pick("global_cache_dir", config.global_cache_dir) ?? defaults.cache,
  };
}

/** Resolve and create both directories (idempotent). */
export function ensureGlobalDirs(opts: GlobalDirsOptions = {}): GlobalDirs {
  const dirs = resolveGlobalDirs(opts);
  mkdirSync(dirs.dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(dirs.cacheDir, { recursive: true, mode: 0o700 });
  return dirs;
}
