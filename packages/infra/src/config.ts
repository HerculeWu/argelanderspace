/**
 * Optional user config file (decision 23):
 * `$XDG_CONFIG_HOME/argelanderspace/config.toml` (default
 * `~/.config/argelanderspace/config.toml`). Flat TOML subset — every key is
 * optional:
 *
 *   data_dir          string   default "./literatures"; a relative path
 *                              (resolved against the working directory) —
 *                              an absolute one is a config error, so a
 *                              shared file never points at one machine
 *   port              integer  default 1859 (contracts `DEFAULT_PORT`)
 *   openalex_api_key  string   fallback for $OPENALEX_API_KEY
 *   ads_dev_key       string   fallback for $ADS_DEV_KEY (itself a fallback
 *                              for ~/.ads/dev_key)
 *   global_dir        string   global data dir override (ADR 0007);
 *                              absolute
 *   global_cache_dir  string   global cache dir override; absolute
 *   auto_ingest_arxiv boolean  default true — Stage 15: automatically fetch
 *                              & compile the arXiv source when an added work
 *                              has an arXiv id (hidden setting; the web UI
 *                              exposes no toggle; manual triggers stay on)
 *   log_level         string   default "info"; one of debug, info, warn,
 *                              error — the lowest level `serve` writes to
 *                              the user-level log
 *
 * This file is the workbench's one configuration source: a command-line flag
 * (`--data-dir`, `--port`) overrides it for a single run, and no environment
 * variable of the workbench's own does (the two key fallbacks above are
 * credentials, handled apart). Unknown keys are ignored (forward
 * compatibility); a known key with the wrong type is an error. Key values
 * are never logged or echoed in error messages.
 *
 * Parsed with smol-toml (full TOML spec; hand-rolling the "flat subset"
 * invites string-escaping edge cases for zero gain).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { parse as parseToml } from "smol-toml";
import { isLogLevel, LOG_LEVELS, type LogLevel } from "./log/logger.js";

/** The config object; property names mirror the TOML keys verbatim. */
export interface AppConfig {
  data_dir?: string;
  port?: number;
  openalex_api_key?: string;
  ads_dev_key?: string;
  /** Global data dir override (ADR 0007); must be absolute. */
  global_dir?: string;
  /** Global cache dir override; must be absolute. */
  global_cache_dir?: string;
  auto_ingest_arxiv?: boolean;
  /** The lowest level written to the user-level log; unset means `info`. */
  log_level?: LogLevel;
}

/** Every key this build reads from config.toml. */
export const CONFIG_KEYS = [
  "data_dir",
  "port",
  "openalex_api_key",
  "ads_dev_key",
  "global_dir",
  "global_cache_dir",
  "auto_ingest_arxiv",
  "log_level",
] as const satisfies readonly (keyof AppConfig)[];

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** `$XDG_CONFIG_HOME/argelanderspace/config.toml`, else under `~/.config`. */
export function configFilePath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg ? xdg : join(home, ".config"), "argelanderspace", "config.toml");
}

const STRING_KEYS = [
  "data_dir",
  "openalex_api_key",
  "ads_dev_key",
  "global_dir",
  "global_cache_dir",
] as const;

/** Parse config TOML text; throws ConfigError (path + reason, never values). */
export function parseConfigToml(text: string, path: string = "<config>"): AppConfig {
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text) as Record<string, unknown>;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ConfigError(`invalid TOML in ${path}:\n${msg}`);
  }
  const out: AppConfig = {};
  for (const key of STRING_KEYS) {
    const value = doc[key];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw new ConfigError(`${path}: "${key}" must be a string`);
    }
    out[key] = value;
  }
  const port = doc.port;
  if (port !== undefined) {
    if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) {
      throw new ConfigError(`${path}: "port" must be an integer between 0 and 65535`);
    }
    out.port = port;
  }
  const autoIngestArxiv = doc.auto_ingest_arxiv;
  if (autoIngestArxiv !== undefined) {
    if (typeof autoIngestArxiv !== "boolean") {
      throw new ConfigError(`${path}: "auto_ingest_arxiv" must be a boolean`);
    }
    out.auto_ingest_arxiv = autoIngestArxiv;
  }
  // The project's data sits at a relative path below the project root; an absolute one would tie the file to one
  // machine. `--data-dir` is the way to point a single run anywhere. Absolute in either platform's writing counts
  // (the file is meant to be shared across machines), and the check comes after the type checks above so that a
  // file with several faults still reports the one it always did.
  if (
    out.data_dir !== undefined &&
    (posix.isAbsolute(out.data_dir) || win32.isAbsolute(out.data_dir))
  ) {
    throw new ConfigError(`${path}: "data_dir" must be a relative path`);
  }
  // Checked last, for the same reason: the faults that were reported before this key existed still come first.
  const logLevel = doc.log_level;
  if (logLevel !== undefined) {
    if (!isLogLevel(logLevel)) {
      throw new ConfigError(`${path}: "log_level" must be one of ${LOG_LEVELS.join(", ")}`);
    }
    out.log_level = logLevel;
  }
  return out;
}

/**
 * Load the config file; a missing file is `{}`. Malformed TOML or an
 * unreadable file is a loud ConfigError (it would otherwise silently
 * misconfigure every key fallback).
 */
export function loadConfigFile(path: string = configFilePath()): AppConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ConfigError(`cannot read config file ${path}: ${(e as Error).message}`);
  }
  return parseConfigToml(text, path);
}

/**
 * Which keys the config file has at its top level: the ones this build reads, by name, and how many others. The
 * names of the others are the user's own text and are not returned; no value is. A file that is missing, unreadable
 * or not TOML has no keys here (loading it is what reports that).
 */
export function configFileKeys(path: string = configFilePath()): {
  known: Array<(typeof CONFIG_KEYS)[number]>;
  unknown: number;
} {
  let present: string[];
  try {
    present = Object.keys(parseToml(readFileSync(path, "utf-8")));
  } catch {
    return { known: [], unknown: 0 };
  }
  const known = CONFIG_KEYS.filter((key) => present.includes(key));
  return { known, unknown: present.length - known.length };
}

/**
 * The process config, read fresh from disk on each call (a tiny sync read at
 * client-construction time — not worth a cache + invalidation hook). Tests
 * pin hermeticity by pointing `$XDG_CONFIG_HOME` at a tmp dir.
 */
export function getConfig(): AppConfig {
  return loadConfigFile();
}
