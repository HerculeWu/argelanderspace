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
 * import. `ensureGlobalDirs` creates the directories on demand with mode 0700
 * (they may hold credentials).
 *
 * A long-running server fixes the two directories once, when it starts
 * (`pinGlobalDirs`, desktop-app ticket 10): from then on, while it runs, a call
 * without `config` gets those, whatever the file says now — the directories
 * take effect at a restart, and a file broken while the server runs neither
 * moves the global data nor fails a request. A command pins nothing and reads
 * the file, strictly, at every call.
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

/**
 * Absolute-ness follows the detected platform's path rules, not the host's. The settings schema accepts an absolute
 * path in any platform's writing; this is whether this machine can use it as a global directory.
 */
export function isAbsoluteOnThisPlatform(p: string): boolean {
  return isAbsolutePath(p);
}

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

/** The directories pinned by running servers, the latest last; see `pinGlobalDirs`. */
const pins: { dirs: GlobalDirs }[] = [];

/**
 * Fix the global directories for this process: until the returned release is called, `resolveGlobalDirs()` and
 * `ensureGlobalDirs()` without `config` give these. The server pins at its start and releases when it closes; when
 * several servers of one process pin (tests), the latest pin still held applies. Releasing twice is harmless.
 */
export function pinGlobalDirs(dirs: GlobalDirs): () => void {
  const pin = { dirs: { ...dirs } };
  pins.push(pin);
  return () => {
    const at = pins.indexOf(pin);
    if (at >= 0) pins.splice(at, 1);
  };
}

/** The directories pinned now, or null when no server of this process holds a pin. */
export function pinnedGlobalDirs(): GlobalDirs | null {
  const pin = pins[pins.length - 1];
  return pin ? { ...pin.dirs } : null;
}

/** The global-directory keys whose value this platform cannot use. */
export type GlobalDirKey = "global_dir" | "global_cache_dir";

/**
 * The directories from a config that was read leniently: a key whose value is not an absolute path on this platform
 * gets the default, and is named in `faulty`. Never throws. For the server's start (`pinGlobalDirs`).
 */
export function resolveGlobalDirsLeniently(config: AppConfig): {
  dirs: GlobalDirs;
  faulty: GlobalDirKey[];
} {
  const defaults = envPaths("argelanderspace", { suffix: "" });
  const faulty: GlobalDirKey[] = [];
  const one = (key: GlobalDirKey, value: string | undefined, fallback: string): string => {
    try {
      return pick(key, value) ?? fallback;
    } catch {
      faulty.push(key);
      return fallback;
    }
  };
  return {
    dirs: {
      dataDir: one("global_dir", config.global_dir, defaults.data),
      cacheDir: one("global_cache_dir", config.global_cache_dir, defaults.cache),
    },
    faulty,
  };
}

export function resolveGlobalDirs(opts: GlobalDirsOptions = {}): GlobalDirs {
  if (opts.config === undefined) {
    const pinned = pinnedGlobalDirs();
    if (pinned) return pinned;
  }
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
