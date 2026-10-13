/**
 * Optional user config file (decision 23):
 * `$XDG_CONFIG_HOME/argelanderspace/config.toml` (default
 * `~/.config/argelanderspace/config.toml`). Every key is optional.
 *
 * The keys, their types, defaults and grouping are the Settings schema in
 * contracts (`settings-schema.ts`); this file holds no key list of its own.
 * Today's keys, for orientation:
 *
 *   data_dir          string   default "./literatures"; a relative path
 *                              (resolved against the working directory) —
 *                              an absolute one is a config error, so a
 *                              shared file never points at one machine
 *   port              integer  default 1859 (contracts `DEFAULT_PORT`)
 *   openalex_api_key  string   fallback for $OPENALEX_API_KEY
 *   ads_dev_key       string   fallback for $ADS_DEV_KEY (itself a fallback
 *                              for ~/.ads/dev_key); marked deprecated in
 *                              the schema
 *   global_dir        string   global data dir override (ADR 0007);
 *                              absolute
 *   global_cache_dir  string   global cache dir override; absolute
 *   auto_ingest_arxiv boolean  default true — Stage 15: automatically fetch
 *                              & compile the arXiv source when an added work
 *                              has an arXiv id (manual triggers stay on)
 *   log_level         string   default "info"; one of debug, info, warn,
 *                              error — the lowest level `serve` writes to
 *                              the user-level log
 *   contact_email     string   optional; blank means not set
 *   tex_dir           string   optional; an absolute path (in POSIX or in
 *                              Windows writing); blank means not set
 *   [ui]                       language ("zh-CN" | "en"), theme ("dark" |
 *                              "light"), accent (azure | teal | violet |
 *                              amber | neutral), density (compact | regular
 *                              | comfy), labels (boolean)
 *
 * `contact_email`, `tex_dir` and `[ui]` are defined and checked only:
 * nothing reads them yet.
 *
 * This file is the workbench's one configuration source: a command-line flag
 * (`--data-dir`, `--port`) overrides it for a single run, and no environment
 * variable of the workbench's own does (the two key fallbacks above are
 * credentials, handled apart). Unknown keys are ignored (forward
 * compatibility). Key values are never logged or echoed in error messages.
 *
 * Two readings of the same file:
 *
 *   strict   `parseConfigToml` / `loadConfigFile` / `getConfig` — the CLI's
 *            and every existing caller's. The first fault of a known key is
 *            a ConfigError naming the key.
 *   lenient  `readSettingsText` / `readSettingsFile` — for the settings
 *            page. Never throws: a faulty key gets its default, a file that
 *            is not TOML gives every default, and the result lists what is
 *            wrong by key and category. `serve` does not use it yet.
 *
 * Changing the file is `config-edit.ts` (the text) and `config-write.ts`
 * (the file, under a lock).
 *
 * Parsed with smol-toml (full TOML spec; hand-rolling the "flat subset"
 * invites string-escaping edge cases for zero gain).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  evaluateSettings,
  isSettingKey,
  type SETTINGS_UI_ACCENTS,
  type SETTINGS_UI_DENSITIES,
  type SETTINGS_UI_LANGUAGES,
  type SETTINGS_UI_THEMES,
  type SettingKey,
  type SettingsEvaluation,
  type SettingsProblem,
  settingDef,
  TOP_LEVEL_SETTING_KEYS,
} from "@argelanderspace/contracts";
import { parse as parseToml } from "smol-toml";
import type { LogLevel } from "./log/logger.js";

/** The `[ui]` table: how the page looks. Defined and checked here; nothing reads it yet. */
export interface AppUiConfig {
  language?: (typeof SETTINGS_UI_LANGUAGES)[number];
  theme?: (typeof SETTINGS_UI_THEMES)[number];
  accent?: (typeof SETTINGS_UI_ACCENTS)[number];
  density?: (typeof SETTINGS_UI_DENSITIES)[number];
  labels?: boolean;
}

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
  /** As written; a blank string means not set. */
  contact_email?: string;
  /** As written; a blank string means not set. Absolute otherwise. */
  tex_dir?: string;
  ui?: AppUiConfig;
}

/**
 * Every top-level key this build reads from config.toml, in the Settings schema's order. The schema is the one list
 * of key names; this is its top-level part, for `configFileKeys` and the server's start record.
 */
export const CONFIG_KEYS: readonly (keyof AppConfig & (typeof TOP_LEVEL_SETTING_KEYS)[number])[] =
  TOP_LEVEL_SETTING_KEYS;

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

/**
 * Which fault a file with several is reported for, in the strict reading. The order is the one the checks ran in
 * while they were written by hand, so a file reports the fault it always did: the type of each plain string key,
 * then `port`, `auto_ingest_arxiv`, the relative-path rule of `data_dir`, `log_level`; every key added since comes
 * after these, in schema order.
 */
const STRICT_FIRST: ReadonlyArray<[SettingKey, SettingsProblem["reason"] | "*"]> = [
  ["data_dir", "wrong_type"],
  ["openalex_api_key", "wrong_type"],
  ["ads_dev_key", "wrong_type"],
  ["global_dir", "wrong_type"],
  ["global_cache_dir", "wrong_type"],
  ["port", "*"],
  ["auto_ingest_arxiv", "*"],
  ["data_dir", "must_be_relative"],
  ["log_level", "*"],
];

/**
 * Not a fault of the strict reading: whether `global_dir` / `global_cache_dir` is absolute is judged where the
 * directory is resolved (`global-dirs.ts`), by the platform's own rule, and reported there.
 */
function strictIgnores(problem: SettingsProblem): boolean {
  return (
    problem.reason === "must_be_absolute" &&
    (problem.key === "global_dir" || problem.key === "global_cache_dir")
  );
}

function strictRank(problem: SettingsProblem, index: number): number {
  const at = STRICT_FIRST.findIndex(
    ([key, reason]) => key === problem.key && (reason === "*" || reason === problem.reason)
  );
  return at === -1 ? STRICT_FIRST.length + index : at;
}

/** The sentence for a fault: the key and what it must be, never the value. */
function strictSentence(problem: SettingsProblem): string {
  const must = (): string => {
    if (problem.reason === "not_a_table" || !isSettingKey(problem.key)) return "a table";
    if (problem.reason === "must_be_relative") return "a relative path";
    if (problem.reason === "must_be_absolute") return "an absolute path";
    const type = settingDef(problem.key).type;
    switch (type.kind) {
      case "string":
        return "a string";
      case "boolean":
        return "a boolean";
      case "integer":
        return `an integer between ${type.min} and ${type.max}`;
      case "enum":
        return `one of ${type.values.join(", ")}`;
    }
  };
  return `"${problem.key}" must be ${must()}`;
}

/** The values a file sets for the known keys, as written. */
function configOf(doc: Record<string, unknown>, present: readonly SettingKey[]): AppConfig {
  const out: Record<string, unknown> = {};
  for (const key of present) {
    const { table, name } = settingDef(key);
    if (table === null) {
      out[name] = doc[name];
    } else {
      const inner = (out[table] ?? {}) as Record<string, unknown>;
      inner[name] = (doc[table] as Record<string, unknown>)[name];
      out[table] = inner;
    }
  }
  return out as AppConfig;
}

/**
 * Parse config TOML text, strictly: the first fault of a known key throws ConfigError (path + reason, never values).
 * This is the reading of the CLI and of every caller of `getConfig`.
 */
export function parseConfigToml(text: string, path: string = "<config>"): AppConfig {
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text) as Record<string, unknown>;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ConfigError(`invalid TOML in ${path}:\n${msg}`);
  }
  const evaluation = evaluateSettings(doc);
  const faults = evaluation.problems
    .map((problem, index) => ({ problem, index }))
    .filter(({ problem }) => !strictIgnores(problem))
    .sort((a, b) => strictRank(a.problem, a.index) - strictRank(b.problem, b.index));
  const first = faults[0];
  if (first) throw new ConfigError(`${path}: ${strictSentence(first.problem)}`);
  // No fault is left, so every key the file sets passed (or is a global directory, judged later).
  return configOf(doc, evaluation.present);
}

/** What the lenient reading found: the values in effect, where each comes from, and what is wrong with the file. */
export interface SettingsReading extends SettingsEvaluation {
  /**
   * `missing`: no file, every value is its default and nothing is wrong. `read`: the file was parsed. `unparseable`
   * / `unreadable`: nothing could be taken from the file, every value is its default, and `problems` has the one
   * whole-file entry (`key: null`).
   */
  file: "missing" | "read" | "unparseable" | "unreadable";
}

function wholeFile(reason: "unparseable" | "unreadable"): SettingsReading {
  return { ...evaluateSettings({}), problems: [{ key: null, reason }], file: reason };
}

/** Byte order mark. smol-toml refuses it; the lenient reading and the line editor look past it. */
export const BOM = "\uFEFF";

/**
 * Read config TOML text, leniently: nothing throws. A file that is not TOML gives every default and one whole-file
 * problem; a known key that is not acceptable gets its default and a problem naming the key and a category. No
 * problem carries a value or the parser's message (which quotes the file). A leading byte order mark is skipped.
 */
export function readSettingsText(text: string): SettingsReading {
  let doc: unknown;
  try {
    doc = parseToml(text.startsWith(BOM) ? text.slice(1) : text);
  } catch {
    return wholeFile("unparseable");
  }
  return { ...evaluateSettings(doc), file: "read" };
}

/** The lenient reading of the config file. A missing file is all defaults with no problem. */
export function readSettingsFile(path: string = configFilePath()): SettingsReading {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...evaluateSettings({}), file: "missing" };
    }
    return wholeFile("unreadable");
  }
  return readSettingsText(text);
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
 * Which keys the config file has at its top level: the ones this build reads, by name and in schema order, and how
 * many others. The names of the others are the user's own text and are not returned; no value is. A table is one
 * top-level entry among the others, `[ui]` included, and the keys inside a table are neither named nor counted. A
 * file that is missing, unreadable or not TOML has no keys here (loading it is what reports that).
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
