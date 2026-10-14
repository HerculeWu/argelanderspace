/**
 * What the settings endpoints of the server answer (`GET /api/settings`, `PUT /api/settings/:key`) and the message
 * the server sends when the config file changed. Types only, plus the lists the server and the page both need; the
 * keys, their types and defaults are the Settings schema (`settings-schema.ts`).
 *
 * Nothing here carries the value of a secret key, a value the file holds for a faulty key, or text of the file.
 */

import { z } from "zod";
import type {
  RedactedSettingsValues,
  SettingKey,
  SettingsProblem,
  SettingValue,
} from "./settings-schema.js";

/**
 * What the lenient reading of the file found (infra `SettingsReading.file`): no file, a file that was read, a file
 * that is not TOML, a file that could not be read.
 */
export const SETTINGS_FILE_STATES = ["missing", "read", "unparseable", "unreadable"] as const;
export type SettingsFileState = (typeof SETTINGS_FILE_STATES)[number];

/**
 * Why the page cannot change a key although the schema gives it a control. The categories are the line editor's and
 * the file writer's own (infra `CONFIG_EDIT_REFUSALS`, `SETTING_WRITE_REFUSALS`); `not_editable` is the endpoint's,
 * for a key that the schema does not let the page change, and `invalid_request` for a body that is not a change.
 */
export const SETTING_CHANGE_REFUSALS = [
  "invalid_request",
  "not_editable",
  "unknown_key",
  "invalid_value",
  "unrepresentable_value",
  "unparseable",
  "unsupported_layout",
  "duplicate_key",
  "dotted_key",
  "inline_table",
  "multiline_string",
  "array_of_tables",
  "not_a_scalar",
  "table_not_a_table",
  "self_check_failed",
  "busy",
  "unreadable",
  "invalid_encoding",
  "not_writable",
  "write_failed",
] as const;
export type SettingChangeRefusal = (typeof SETTING_CHANGE_REFUSALS)[number];

/**
 * Where one kind of data lives in the running process, as `serve` fixed it at its start (desktop-app ticket 10):
 * `flag` — `--data-dir` (project data only); `file` — the value in config.toml; `default` — the default location.
 * `problem` is what was wrong with the key in the file at the start (or with the whole file: `unparseable`,
 * `unreadable`), whatever the source ended up being; null when nothing was. No path, no value.
 */
export interface StartupLocation {
  source: "flag" | "file" | "default";
  problem: SettingsProblem["reason"] | null;
}

/** The three data locations of the running process (`SettingsSnapshot.startup`). */
export interface StartupLocations {
  /** Project data (`data_dir`, or `--data-dir`). */
  data_dir: StartupLocation;
  /** Global data: Mail accounts, credentials, the user-level log (`global_dir`). */
  global_dir: StartupLocation;
  /** Global cache (`global_cache_dir`). */
  global_cache_dir: StartupLocation;
}

/**
 * A path of the machine that runs the server, and the same path as the page shows it: the server's home directory
 * written as `~` (judged by the server, which knows its home directory; the page does not guess). What is copied is
 * `path`.
 */
export interface ShownPath {
  path: string;
  display: string;
}

/**
 * What the running process uses for the keys that take effect only at a restart (desktop-app ticket 11), fixed when
 * the server was made and unchanged until it stops. Unlike `values` (the file now) and `startup` (where each location
 * came from at the start, with no path), these are the actual port and the actual absolute directories — with
 * `--port` / `--data-dir` applied and a faulty key's default in effect. They hold the user's home and folder names:
 * they are given to the settings page only (this answer is `no-store`) and never written to the user log.
 */
export interface RunningSettings {
  /** The project root: the working directory of the server, against which a relative `data_dir` is resolved. */
  project_root: ShownPath;
  /** The port this server listens on; null when it is not listening (before the listen, after the close). */
  port: number | null;
  /** The project data directory in use (`--data-dir`, or `data_dir` resolved against the working directory). */
  data_dir: ShownPath;
  /** The global data directory in use (Mail accounts, credentials, the user log). */
  global_dir: ShownPath;
  /** The global cache directory in use. */
  global_cache_dir: ShownPath;
  /**
   * The restart-only keys whose value in use was given on the command line (`--port`, `--data-dir`) when `serve`
   * started: the file's value does not apply to this run, nor to a later one started with the same flag. Such a key is
   * never in `restartPending`. Empty for a server not started by `serve`.
   */
  from_flag: RunningFlagKey[];
}

/** The keys a command-line flag of `serve` can give (`--port`, `--data-dir`). */
export type RunningFlagKey = "port" | "data_dir";

/** `GET /api/settings`: the settings as the page may see them. */
export interface SettingsSnapshot {
  version: 1;
  /** The config file, as an absolute path on the machine that runs the server. */
  path: string;
  /** `path` as the page shows it, with the server's home directory written as `~`. */
  pathDisplay: string;
  file: SettingsFileState;
  /**
   * The file is there and nothing could be taken from it (`unparseable`, `unreadable`): every value is its default
   * and the page changes nothing until the file is repaired.
   */
  readonly: boolean;
  /**
   * The value of every key as the file gives it now (the lenient reading, with the default for a key that is not set
   * or is faulty); a secret key has `{ secret: true, set }` and no value. This is the file, not necessarily what the
   * running process uses: a `--port` / `--data-dir` given to `serve`, and a key that takes effect only at a restart
   * (`data_dir`, `port`, `global_dir`, `global_cache_dir`) changed since the start, are not reflected here. Where the
   * process keeps its data is `startup`.
   */
  values: RedactedSettingsValues;
  sources: Record<SettingKey, "default" | "file">;
  /** What is wrong with the file, by key and category; never a value. */
  problems: SettingsProblem[];
  /**
   * The keys with a control that the page cannot change safely as the file is written now, and why. Empty when the
   * file is `readonly` (nothing can be changed then, whatever the key).
   */
  uneditable: Partial<Record<SettingKey, SettingChangeRefusal>>;
  /**
   * The deprecated keys the file still sets. Today only `ads_dev_key`, which no longer has any effect: the ADS token is
   * kept in the credential store (desktop-app ticket 12); the page says so in the ADS token row.
   */
  legacy: SettingKey[];
  /**
   * Where the running process keeps its data, fixed when `serve` started and unchanged until it restarts — unlike
   * `values`, `sources` and `problems`, which are the file as it is now. A file repaired (or broken) while the server
   * runs changes `problems` at once and `startup` only at the next start. Null for a server not started by `serve`
   * (one made by `createServer` alone, in tests). Sources and categories only: no path, no value.
   */
  startup: StartupLocations | null;
  /** What the process actually uses for the restart-only keys (see `RunningSettings`). */
  running: RunningSettings;
  /**
   * The keys that take effect at a restart (`restart: true` in the schema) whose value in the file now differs from
   * the one the file had when the server was made: changed since, so the process still uses the old value (`running`)
   * until it restarts. In schema order. Empty while the file is `readonly` (it cannot be read, so says nothing).
   */
  restartPending: SettingKey[];
}

/** The body of `PUT /api/settings/:key`: set the key, or remove it so that its default applies. */
export type SettingChangeRequest = { set: SettingValue } | { reset: true };

/** The answer of `PUT /api/settings/:key`. A refusal leaves the file's bytes as they were. */
export type SettingChangeResponse =
  | { ok: true; changed: boolean; settings: SettingsSnapshot }
  | { ok: false; reason: SettingChangeRefusal };

/**
 * Sent when the config file changed: `write` right after this server changed a key, `external` when the file was
 * found changed on disk (an editor's save; the server's own write is found this way as well, a moment later). The
 * page reads the settings again; the message carries none.
 */
export const WsSettingsChangedSchema = z.object({
  type: z.literal("settings.changed"),
  cause: z.enum(["write", "external"]),
  /** ISO-8601 timestamp. */
  at: z.string(),
});
export type WsSettingsChanged = z.infer<typeof WsSettingsChangedSchema>;
