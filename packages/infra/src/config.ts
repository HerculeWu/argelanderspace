/**
 * Optional user config file (decision 23):
 * `$XDG_CONFIG_HOME/argelanderspace/config.toml` (default
 * `~/.config/argelanderspace/config.toml`). Flat TOML subset — every key is
 * optional:
 *
 *   data_dir          string   default "./literatures"
 *   port              integer  default 8000
 *   mineru_api_key    string   fallback for $MINERU_API_KEY
 *   openalex_api_key  string   fallback for $OPENALEX_API_KEY
 *   ads_dev_key       string   fallback for $ADS_DEV_KEY (itself a fallback
 *                              for ~/.ads/dev_key)
 *
 * Precedence everywhere: CLI flag > env var > config file > default. Unknown
 * keys are ignored (forward compatibility); a known key with the wrong type
 * is an error. Key values are never logged or echoed in error messages.
 *
 * Parsed with smol-toml (full TOML spec; hand-rolling the "flat subset"
 * invites string-escaping edge cases for zero gain).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

/** The config object; property names mirror the TOML keys verbatim. */
export interface AppConfig {
  data_dir?: string;
  port?: number;
  mineru_api_key?: string;
  openalex_api_key?: string;
  ads_dev_key?: string;
}

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

const STRING_KEYS = ["data_dir", "mineru_api_key", "openalex_api_key", "ads_dev_key"] as const;

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
 * The process config, read fresh from disk on each call (a tiny sync read at
 * client-construction time — not worth a cache + invalidation hook). Tests
 * pin hermeticity by pointing `$XDG_CONFIG_HOME` at a tmp dir.
 */
export function getConfig(): AppConfig {
  return loadConfigFile();
}
