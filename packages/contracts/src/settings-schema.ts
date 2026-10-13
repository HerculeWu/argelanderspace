/**
 * The schema of Settings: every key the workbench knows in `config.toml`, in one table. What reads the file (infra's
 * strict and lenient readers), what edits it (infra's line editor) and what shows it (the settings page) all take
 * the keys, their types, their defaults and their grouping from here; no second list of key names is kept anywhere.
 *
 * Pure data and pure functions: nothing here touches a file, a platform or a TOML parser, so the web runtime can
 * import it. A value is checked as the thing a TOML parser returned for the key.
 */

import { DEFAULT_PORT } from "./config-defaults.js";

/** The groups of the settings page, in the order the page lists them. */
export const SETTINGS_GROUPS = [
  "appearance",
  "project",
  "services",
  "tex",
  "copilot",
  "mail",
  "cli",
  "diagnostics",
  "advanced",
] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

/** The TOML tables a key can sit in, besides the top level. */
export const SETTINGS_TABLES = ["ui"] as const;
export type SettingsTable = (typeof SETTINGS_TABLES)[number];

/** A value a setting can have. A key that is not set has `null`. */
export type SettingValue = string | number | boolean;

export type SettingType =
  /**
   * `path` restricts the string to a relative or an absolute path; a path counts as absolute when it is absolute in
   * POSIX or in Windows writing, whichever machine reads the file. `blankIsUnset` means an empty or whitespace-only
   * string is the same as leaving the key out.
   */
  | { kind: "string"; path?: "relative" | "absolute"; blankIsUnset?: boolean }
  | { kind: "integer"; min: number; max: number }
  | { kind: "boolean" }
  | { kind: "enum"; values: readonly string[] };

/**
 * How the settings page presents a key: `edit` has a control, `readonly` is shown but can only be changed in the
 * file, `none` is not shown.
 */
export type SettingUi = "edit" | "readonly" | "none";

export interface SettingDef {
  /** `null` for a top-level key, else the table the key sits in. */
  table: SettingsTable | null;
  /** The key as written in the file, inside its table. */
  name: string;
  type: SettingType;
  /** The value in effect when the file does not set the key; `null` when the key is simply absent by default. */
  default: SettingValue | null;
  group: SettingsGroup;
  ui: SettingUi;
  /** Whether a running workbench must be restarted before a change takes effect. */
  restart: boolean;
  /** Still a known key, but the workbench no longer wants it in the file. */
  deprecated?: true;
  /**
   * The value is a credential. It is never given to the page or put in a report: `redactSettingsValues` replaces it
   * with whether it is set. Only the keys that carry this mark are secret.
   */
  secret?: true;
}

const def = <const D extends SettingDef>(d: D): D => d;

/** The levels of the user log, lowest first. */
export const SETTINGS_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export const SETTINGS_UI_LANGUAGES = ["zh-CN", "en"] as const;
export const SETTINGS_UI_THEMES = ["dark", "light"] as const;
export const SETTINGS_UI_ACCENTS = ["azure", "teal", "violet", "amber", "neutral"] as const;
export const SETTINGS_UI_DENSITIES = ["compact", "regular", "comfy"] as const;

/**
 * Every known key. The property name is the key's identifier: the bare name for a top-level key, `table.name` for a
 * key in a table. The order of the top-level keys is the order they are reported in (`CONFIG_KEYS` in infra).
 */
export const SETTINGS_SCHEMA = {
  // `""` is relative and resolves to the working directory, and `"~/lit"` is a folder literally named `~`: the
  // check is only "not absolute".
  data_dir: def({
    table: null,
    name: "data_dir",
    type: { kind: "string", path: "relative" },
    default: "./literatures",
    group: "project",
    ui: "edit",
    restart: true,
  }),
  port: def({
    table: null,
    name: "port",
    type: { kind: "integer", min: 0, max: 65535 },
    default: DEFAULT_PORT,
    group: "advanced",
    ui: "edit",
    restart: true,
  }),
  // A credential that still lives in the file; it has no control on the page.
  openalex_api_key: def({
    table: null,
    name: "openalex_api_key",
    type: { kind: "string" },
    default: null,
    group: "services",
    ui: "none",
    restart: false,
    secret: true,
  }),
  ads_dev_key: def({
    table: null,
    name: "ads_dev_key",
    type: { kind: "string" },
    default: null,
    group: "services",
    ui: "none",
    restart: false,
    deprecated: true,
    secret: true,
  }),
  global_dir: def({
    table: null,
    name: "global_dir",
    type: { kind: "string", path: "absolute", blankIsUnset: true },
    default: null,
    group: "advanced",
    ui: "readonly",
    restart: true,
  }),
  global_cache_dir: def({
    table: null,
    name: "global_cache_dir",
    type: { kind: "string", path: "absolute", blankIsUnset: true },
    default: null,
    group: "advanced",
    ui: "readonly",
    restart: true,
  }),
  auto_ingest_arxiv: def({
    table: null,
    name: "auto_ingest_arxiv",
    type: { kind: "boolean" },
    default: true,
    group: "project",
    ui: "edit",
    restart: false,
  }),
  log_level: def({
    table: null,
    name: "log_level",
    type: { kind: "enum", values: SETTINGS_LOG_LEVELS },
    default: "info",
    group: "diagnostics",
    ui: "edit",
    restart: false,
  }),
  contact_email: def({
    table: null,
    name: "contact_email",
    type: { kind: "string", blankIsUnset: true },
    default: null,
    group: "services",
    ui: "edit",
    restart: false,
  }),
  tex_dir: def({
    table: null,
    name: "tex_dir",
    type: { kind: "string", path: "absolute", blankIsUnset: true },
    default: null,
    group: "tex",
    ui: "edit",
    restart: false,
  }),
  "ui.language": def({
    table: "ui",
    name: "language",
    type: { kind: "enum", values: SETTINGS_UI_LANGUAGES },
    default: "zh-CN",
    group: "appearance",
    ui: "edit",
    restart: false,
  }),
  "ui.theme": def({
    table: "ui",
    name: "theme",
    type: { kind: "enum", values: SETTINGS_UI_THEMES },
    default: "dark",
    group: "appearance",
    ui: "edit",
    restart: false,
  }),
  "ui.accent": def({
    table: "ui",
    name: "accent",
    type: { kind: "enum", values: SETTINGS_UI_ACCENTS },
    default: "azure",
    group: "appearance",
    ui: "edit",
    restart: false,
  }),
  "ui.density": def({
    table: "ui",
    name: "density",
    type: { kind: "enum", values: SETTINGS_UI_DENSITIES },
    default: "regular",
    group: "appearance",
    ui: "edit",
    restart: false,
  }),
  "ui.labels": def({
    table: "ui",
    name: "labels",
    type: { kind: "boolean" },
    default: true,
    group: "appearance",
    ui: "edit",
    restart: false,
  }),
} as const satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTINGS_SCHEMA;

/** Every known key, in schema order. */
export const SETTING_KEYS = Object.keys(SETTINGS_SCHEMA) as SettingKey[];

type TopLevelKeyOf<K extends SettingKey> = K extends unknown
  ? (typeof SETTINGS_SCHEMA)[K]["table"] extends null
    ? K
    : never
  : never;
/** A known key that sits at the top level of the file. */
export type TopLevelSettingKey = TopLevelKeyOf<SettingKey>;

/** The known top-level keys, in schema order. */
export const TOP_LEVEL_SETTING_KEYS = SETTING_KEYS.filter(
  (key) => SETTINGS_SCHEMA[key].table === null
) as TopLevelSettingKey[];

export function isSettingKey(value: unknown): value is SettingKey {
  return typeof value === "string" && Object.hasOwn(SETTINGS_SCHEMA, value);
}

export function settingDef(key: SettingKey): SettingDef {
  return SETTINGS_SCHEMA[key];
}

/**
 * Why a value is not acceptable for its key. A category only: it never carries the value.
 *
 *   wrong_type        not the TOML type the key takes
 *   out_of_range      an integer outside the key's range
 *   not_one_of        a string that is none of the key's choices
 *   must_be_relative  an absolute path where a relative one is required
 *   must_be_absolute  a relative path where an absolute one is required
 */
export const SETTING_VALUE_PROBLEMS = [
  "wrong_type",
  "out_of_range",
  "not_one_of",
  "must_be_relative",
  "must_be_absolute",
] as const;
export type SettingValueProblem = (typeof SETTING_VALUE_PROBLEMS)[number];

/**
 * Whether a path is absolute in POSIX writing (`/x`) or in Windows writing (`\x`, `C:\x`, `C:/x`, `\\host\share`).
 * Gives what `posix.isAbsolute(p) || win32.isAbsolute(p)` of `node:path` gives, without `node:path`.
 */
export function isAbsoluteOnAnyPlatform(path: string): boolean {
  return /^(?:[/\\]|[A-Za-z]:[/\\])/.test(path);
}

function isBlank(value: string): boolean {
  return value.trim() === "";
}

/** Check a value read from the file against its key; `null` means it is acceptable. */
export function checkSettingValue(key: SettingKey, value: unknown): SettingValueProblem | null {
  const type: SettingType = SETTINGS_SCHEMA[key].type;
  switch (type.kind) {
    case "boolean":
      return typeof value === "boolean" ? null : "wrong_type";
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return "wrong_type";
      return value < type.min || value > type.max ? "out_of_range" : null;
    case "enum":
      if (typeof value !== "string") return "wrong_type";
      return type.values.includes(value) ? null : "not_one_of";
    case "string":
      if (typeof value !== "string") return "wrong_type";
      if (type.blankIsUnset && isBlank(value)) return null;
      if (type.path === "relative" && isAbsoluteOnAnyPlatform(value)) return "must_be_relative";
      if (type.path === "absolute" && !isAbsoluteOnAnyPlatform(value)) return "must_be_absolute";
      return null;
  }
}

/** The value of every key: what is in effect. `null` is a key that is not set and has no default. */
export type SettingsValues = Record<SettingKey, SettingValue | null>;

/** The schema's defaults, a fresh object each call. */
export function defaultSettings(): SettingsValues {
  const out = {} as SettingsValues;
  for (const key of SETTING_KEYS) out[key] = SETTINGS_SCHEMA[key].default;
  return out;
}

type SecretKeyOf<K extends SettingKey> = K extends unknown
  ? (typeof SETTINGS_SCHEMA)[K] extends { secret: true }
    ? K
    : never
  : never;
/** A key whose value is a credential. */
export type SecretSettingKey = SecretKeyOf<SettingKey>;

/** The keys the schema marks `secret`, in schema order. */
export const SECRET_SETTING_KEYS = SETTING_KEYS.filter(
  (key) => (SETTINGS_SCHEMA[key] as SettingDef).secret === true
) as SecretSettingKey[];

export function isSecretSetting(key: SettingKey): key is SecretSettingKey {
  return (SETTINGS_SCHEMA[key] as SettingDef).secret === true;
}

/** What is said about a secret key in place of its value: only whether it has one. */
export interface RedactedSetting {
  secret: true;
  /** `false` when the key is not set, or is set to an empty or whitespace-only string. */
  set: boolean;
}

/** `SettingsValues` as it may be given to the page or put in a report. */
export type RedactedSettingsValues = {
  [K in SettingKey]: K extends SecretSettingKey ? RedactedSetting : SettingValue | null;
};

/**
 * The values as they may leave the process that read the file: every key of the schema, in schema order; a secret
 * key has `{ secret: true, set }` and no value, every other key has its value unchanged. A fresh object; the input
 * is not changed. `evaluateSettings` itself still returns the secret values, for the code that uses them.
 */
export function redactSettingsValues(values: SettingsValues): RedactedSettingsValues {
  const out: Record<string, SettingValue | null | RedactedSetting> = {};
  for (const key of SETTING_KEYS) {
    const value = values[key];
    if (isSecretSetting(key)) {
      const set =
        typeof value === "string" ? !isBlank(value) : value !== null && value !== undefined;
      out[key] = { secret: true, set };
    } else {
      out[key] = value;
    }
  }
  return out as RedactedSettingsValues;
}

/**
 * What is wrong with the file, by key. `key` is a known key, or a table name when the table itself is not a table,
 * or `null` for the whole file. Never a value, and never the name of a key this build does not know.
 */
export interface SettingsProblem {
  key: SettingKey | SettingsTable | null;
  reason: SettingValueProblem | "not_a_table" | "unparseable" | "unreadable";
}

export interface SettingsEvaluation {
  /** The value in effect for every key: the file's where it is acceptable, else the default. */
  values: SettingsValues;
  /** Where each value in `values` comes from. A key with a problem is `default`. */
  sources: Record<SettingKey, "default" | "file">;
  /** In schema order; a table that is not a table comes where its first key would. */
  problems: SettingsProblem[];
  /** The known keys the file sets, acceptable or not, in schema order. */
  present: SettingKey[];
}

function isPlainTable(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

/**
 * Read the known keys out of a parsed TOML document. Nothing throws: a key whose value is not acceptable gets its
 * default and an entry in `problems`. Unknown keys and unknown tables are ignored.
 */
export function evaluateSettings(doc: unknown): SettingsEvaluation {
  const root: Record<string, unknown> = isPlainTable(doc) ? doc : {};
  const values = defaultSettings();
  const sources = {} as Record<SettingKey, "default" | "file">;
  const problems: SettingsProblem[] = [];
  const present: SettingKey[] = [];
  const badTables = new Set<SettingsTable>();
  for (const key of SETTING_KEYS) {
    sources[key] = "default";
    const { table, name, type }: SettingDef = SETTINGS_SCHEMA[key];
    let holder = root;
    if (table !== null) {
      if (!Object.hasOwn(root, table)) continue;
      const inner = root[table];
      if (!isPlainTable(inner)) {
        if (!badTables.has(table)) problems.push({ key: table, reason: "not_a_table" });
        badTables.add(table);
        continue;
      }
      holder = inner;
    }
    if (!Object.hasOwn(holder, name)) continue;
    const value = holder[name];
    present.push(key);
    const problem = checkSettingValue(key, value);
    if (problem !== null) {
      problems.push({ key, reason: problem });
      continue;
    }
    if (type.kind === "string" && type.blankIsUnset && isBlank(value as string)) continue;
    values[key] = value as SettingValue;
    sources[key] = "file";
  }
  return { values, sources, problems, present };
}
