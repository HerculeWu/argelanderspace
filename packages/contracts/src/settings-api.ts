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

/** `GET /api/settings`: the settings as the page may see them. */
export interface SettingsSnapshot {
  version: 1;
  /** The config file, as an absolute path on the machine that runs the server. */
  path: string;
  file: SettingsFileState;
  /**
   * The file is there and nothing could be taken from it (`unparseable`, `unreadable`): every value is its default
   * and the page changes nothing until the file is repaired.
   */
  readonly: boolean;
  /** The value in effect for every key; a secret key has `{ secret: true, set }` and no value. */
  values: RedactedSettingsValues;
  sources: Record<SettingKey, "default" | "file">;
  /** What is wrong with the file, by key and category; never a value. */
  problems: SettingsProblem[];
  /**
   * The keys with a control that the page cannot change safely as the file is written now, and why. Empty when the
   * file is `readonly` (nothing can be changed then, whatever the key).
   */
  uneditable: Partial<Record<SettingKey, SettingChangeRefusal>>;
  /** The deprecated keys the file still sets (`ads_dev_key`): they no longer do anything. */
  legacy: SettingKey[];
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
