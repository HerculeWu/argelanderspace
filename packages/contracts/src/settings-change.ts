/**
 * How a change of one key of `config.toml` is judged (`PUT /api/settings/:key`), as far as that needs no file: the
 * status each refusal is answered with, the stages a change goes through and in which order, and the stages that
 * need nothing but the key and the request — the key, the shape of the change, the value. The stages that need the
 * file or its text (reading it, its encoding, how it is laid out, the self-check, the replacement) are judged by
 * infra (`config-write.ts`, `config-edit.ts`); here they only have their place in the order, so that a stand-in of
 * the endpoint can answer in the same order as the server. Also here: which restart-only keys are pending a restart.
 *
 * Pure data and pure functions: no Node, no platform, no TOML parser. The server's endpoint, infra's writer and line
 * editor, and the web tests' stand-in of the endpoint all call these, each at the place where it judges.
 */

import type { SettingChangeRefusal, SettingChangeRequest } from "./settings-api.js";
import {
  checkSettingValue,
  isSettingKey,
  SETTING_KEYS,
  SETTINGS_SCHEMA,
  type SettingKey,
  type SettingsValues,
} from "./settings-schema.js";

// --------------------------------------------------------------------------- //
// Status codes
// --------------------------------------------------------------------------- //

export type SettingChangeStatus = 400 | 404 | 409 | 422 | 500;

/**
 * The status each refusal is answered with: 400 / 404 / 422 for the request, 409 for how the file is written now
 * (and `busy`), 500 for a file that cannot be read or written.
 */
export const SETTING_CHANGE_STATUS: { readonly [R in SettingChangeRefusal]: SettingChangeStatus } =
  {
    invalid_request: 400,
    invalid_value: 400,
    unrepresentable_value: 400,
    unknown_key: 404,
    not_editable: 422,
    unparseable: 409,
    unsupported_layout: 409,
    duplicate_key: 409,
    dotted_key: 409,
    inline_table: 409,
    multiline_string: 409,
    array_of_tables: 409,
    not_a_scalar: 409,
    table_not_a_table: 409,
    self_check_failed: 409,
    busy: 409,
    unreadable: 500,
    invalid_encoding: 500,
    not_writable: 500,
    write_failed: 500,
  };

export function settingChangeStatus(reason: SettingChangeRefusal): SettingChangeStatus {
  return SETTING_CHANGE_STATUS[reason];
}

// --------------------------------------------------------------------------- //
// Stages
// --------------------------------------------------------------------------- //

/**
 * The stages of a change, in the order they run; the first refusal ends the change.
 *
 *   key      the key (`settingChangeKey`)
 *   request  the body: its size, its encoding and its shape (`settingChangeRequestOf`)
 *   file     finding, locking, reading and decoding the file (infra `writeSetting`)
 *   value    the new value (`settingValueRefusal`), judged once the file is read
 *   text     the line edit of the file's text and its self-check (infra `editConfigText`)
 *   replace  putting the new file in place (infra `writeSetting`)
 *
 * `file`, `text` and `replace` need the file and are judged by infra only.
 */
export const SETTING_CHANGE_STAGES = [
  "key",
  "request",
  "file",
  "value",
  "text",
  "replace",
] as const;
export type SettingChangeStage = (typeof SETTING_CHANGE_STAGES)[number];

/**
 * Which refusals each stage can give. A refusal can come from more than one stage: the lock and the replacement can
 * both answer `busy`, `not_writable` or `write_failed`.
 */
export const SETTING_CHANGE_STAGE_REFUSALS: {
  readonly [S in SettingChangeStage]: readonly SettingChangeRefusal[];
} = {
  key: ["unknown_key", "not_editable"],
  request: ["invalid_request"],
  file: ["unreadable", "not_writable", "write_failed", "busy", "invalid_encoding"],
  value: ["invalid_value", "unrepresentable_value"],
  text: [
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
  ],
  replace: ["not_writable", "write_failed", "busy"],
};

/**
 * The first stage that can give a refusal: where a stand-in that does not model the file's timing puts a refusal it
 * was told to give.
 */
export function settingRefusalStage(reason: SettingChangeRefusal): SettingChangeStage {
  const stage = SETTING_CHANGE_STAGES.find((s) =>
    SETTING_CHANGE_STAGE_REFUSALS[s].includes(reason)
  );
  // Every refusal is in some stage (contracts tests); `replace` is never first for any of them.
  return stage ?? "replace";
}

// --------------------------------------------------------------------------- //
// The stages that need no file
// --------------------------------------------------------------------------- //

/** Why a key cannot be changed: not a key of the schema, or (for the page) a key without a control. */
export type SettingKeyRefusal = "unknown_key" | "not_editable";

/**
 * The key stage. `page`: only the keys the schema gives a control (`ui: "edit"`), as the endpoint allows; `any`: any
 * key of the schema, as the writer and the line editor take.
 */
export function settingChangeKey(
  key: string,
  scope: "any"
): { ok: true; key: SettingKey } | { ok: false; reason: "unknown_key" };
export function settingChangeKey(
  key: string,
  scope: "page"
): { ok: true; key: SettingKey } | { ok: false; reason: SettingKeyRefusal };
export function settingChangeKey(
  key: string,
  scope: "any" | "page"
): { ok: true; key: SettingKey } | { ok: false; reason: SettingKeyRefusal } {
  if (!isSettingKey(key)) return { ok: false, reason: "unknown_key" };
  if (scope === "page" && SETTINGS_SCHEMA[key].ui !== "edit")
    return { ok: false, reason: "not_editable" };
  return { ok: true, key };
}

/**
 * A change, or `null` when it is not one: exactly `{ set: scalar }` or exactly `{ reset: true }`. Minus zero becomes
 * zero (it is written `0` and reads back as zero). A number that is not finite is still a change here — no key
 * takes it, so the value stage refuses it — as the writer and the line editor take it (`invalid_value` for `null`).
 */
export function settingChangeOf(change: unknown): SettingChangeRequest | null {
  if (typeof change !== "object" || change === null || Array.isArray(change)) return null;
  const keys = Object.keys(change);
  if (keys.length !== 1) return null;
  const record = change as Record<string, unknown>;
  if (keys[0] === "reset") return record.reset === true ? { reset: true } : null;
  if (keys[0] !== "set") return null;
  const value = record.set;
  if (typeof value === "number") return { set: value === 0 ? 0 : value };
  return typeof value === "string" || typeof value === "boolean" ? { set: value } : null;
}

/**
 * The shape of a request body (after it was read and parsed as JSON): `settingChangeOf`, and a number must be finite
 * (`{"set":1e999}` parses to Infinity). `null` is `invalid_request`.
 */
export function settingChangeRequestOf(body: unknown): SettingChangeRequest | null {
  const change = settingChangeOf(body);
  if (
    change !== null &&
    "set" in change &&
    typeof change.set === "number" &&
    !Number.isFinite(change.set)
  ) {
    return null;
  }
  return change;
}

/**
 * Whether the line editor can write a string: as a basic string on one line, which holds no control character
 * (U+0000–U+001F, U+007F, the line ending and the tab among them), and as UTF-8, which carries no unpaired
 * surrogate. A string that is not is refused (`unrepresentable_value`), not escaped: no setting takes one.
 */
export function isRepresentableSettingString(value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is looked for
  return !/[\u0000-\u001f\u007f]/.test(value) && !/\p{Cs}/u.test(value);
}

/** Why the new value cannot be written (`invalid_value` before `unrepresentable_value`); `null` when it can. */
export function settingValueRefusal(
  key: SettingKey,
  change: SettingChangeRequest
): "invalid_value" | "unrepresentable_value" | null {
  if (!("set" in change)) return null;
  if (checkSettingValue(key, change.set) !== null) return "invalid_value";
  if (typeof change.set === "string" && !isRepresentableSettingString(change.set)) {
    return "unrepresentable_value";
  }
  return null;
}

// --------------------------------------------------------------------------- //
// The whole order, for a stand-in
// --------------------------------------------------------------------------- //

export type SettingChangeJudgement =
  | { ok: true; key: SettingKey; change: SettingChangeRequest }
  | { ok: false; reason: SettingChangeRefusal; status: SettingChangeStatus };

/**
 * A change of the page judged through every stage in order: the key (for the page), the request, the file, the
 * value, the text, the replacement. A stage that needs no file judges for itself; `given` adds the refusal a stage
 * gives besides (after its own judgement) — for the stages that need the file, the only one they give here. The
 * server does not call this (it judges each stage where it runs, and infra judges the file); it is the order itself,
 * for a stand-in of the endpoint and for the tests that pin it.
 */
export function judgeSettingChange(input: {
  key: string;
  /** The request body as parsed from JSON. */
  body: unknown;
  /** A refusal a stage gives besides its own judgement; nothing lets the change through that stage. */
  given?: Partial<Record<SettingChangeStage, SettingChangeRefusal | null>>;
}): SettingChangeJudgement {
  const refuse = (reason: SettingChangeRefusal): SettingChangeJudgement => ({
    ok: false,
    reason,
    status: settingChangeStatus(reason),
  });
  const given = input.given ?? {};
  let key: SettingKey | null = null;
  let change: SettingChangeRequest | null = null;
  for (const stage of SETTING_CHANGE_STAGES) {
    if (stage === "key") {
      const keyed = settingChangeKey(input.key, "page");
      if (!keyed.ok) return refuse(keyed.reason);
      key = keyed.key;
    } else if (stage === "request") {
      change = settingChangeRequestOf(input.body);
      if (change === null) return refuse("invalid_request");
    } else if (stage === "value" && key !== null && change !== null) {
      const value = settingValueRefusal(key, change);
      if (value !== null) return refuse(value);
    }
    const extra = given[stage];
    if (extra) return refuse(extra);
  }
  if (key === null || change === null)
    throw new Error("unreachable: the key and the request were judged");
  return { ok: true, key, change };
}

// --------------------------------------------------------------------------- //
// Pending a restart
// --------------------------------------------------------------------------- //

const RESTART_KEYS = SETTING_KEYS.filter((key) => SETTINGS_SCHEMA[key].restart);

/**
 * `SettingsSnapshot.restartPending`: the restart-only keys whose value in the file now (`now`) is not the one it had
 * when the server was made (`atStart`), in schema order. A key given on the command line (`fromFlag`) does not take
 * the file's value at a restart either (with the same flag), so it is never pending; and a file that cannot be read
 * (`readonly`) says nothing about what it sets, so nothing is pending then.
 */
export function restartPendingKeys(
  now: SettingsValues,
  atStart: SettingsValues,
  process: { readonly: boolean; fromFlag: readonly SettingKey[] }
): SettingKey[] {
  if (process.readonly) return [];
  return RESTART_KEYS.filter((key) => !process.fromFlag.includes(key) && now[key] !== atStart[key]);
}
