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
import { posix, win32 } from "node:path";
import envPaths from "env-paths";
import { type AppConfig, ConfigError, getConfig } from "./config.js";

export interface GlobalDirs {
  dataDir: string;
  cacheDir: string;
}

export interface GlobalDirsOptions {
  env?: NodeJS.ProcessEnv;
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
 * source only, never the value.
 */
function pick(
  envName: string,
  envValue: string | undefined,
  configKey: string,
  configValue: string | undefined
): string | undefined {
  const fromEnv = envValue?.trim();
  if (fromEnv) {
    if (!isAbsolutePath(fromEnv)) throw new ConfigError(`${envName} must be an absolute path`);
    return fromEnv;
  }
  const fromConfig = configValue?.trim();
  if (!fromConfig) return undefined;
  if (!isAbsolutePath(fromConfig)) throw new ConfigError(`"${configKey}" must be an absolute path`);
  return fromConfig;
}

export function resolveGlobalDirs(opts: GlobalDirsOptions = {}): GlobalDirs {
  const env = opts.env ?? process.env;
  const config = opts.config ?? getConfig();
  const defaults = envPaths("argelanderspace", { suffix: "" });
  return {
    dataDir:
      pick(
        "ARGELANDERSPACE_GLOBAL_DIR",
        env.ARGELANDERSPACE_GLOBAL_DIR,
        "global_dir",
        config.global_dir
      ) ?? defaults.data,
    cacheDir:
      pick(
        "ARGELANDERSPACE_GLOBAL_CACHE_DIR",
        env.ARGELANDERSPACE_GLOBAL_CACHE_DIR,
        "global_cache_dir",
        config.global_cache_dir
      ) ?? defaults.cache,
  };
}

/** Resolve and create both directories (idempotent). */
export function ensureGlobalDirs(opts: GlobalDirsOptions = {}): GlobalDirs {
  const dirs = resolveGlobalDirs(opts);
  mkdirSync(dirs.dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(dirs.cacheDir, { recursive: true, mode: 0o700 });
  return dirs;
}
