/**
 * Settings over HTTP (desktop-app ticket 10): what the settings page reads and how it changes one key of
 * `config.toml`.
 *
 *   GET /api/settings        the values in effect, where each comes from, what is wrong with the file, the file's
 *                            path, whether the page may change anything, and which keys it cannot change safely
 *   PUT /api/settings/:key   `{ "set": <scalar> }` or `{ "reset": true }`; the answer has the settings as they are
 *                            after the change, or the category of the refusal
 *
 * Reading is the lenient reading of infra (`readSettingsText`): it never throws, a faulty key has its default, and a
 * file that is not TOML gives every default. A change goes through infra's `writeSetting` (lock, line edit, atomic
 * replacement); a refused change leaves the file's bytes as they were.
 *
 * What never leaves this file: the value of a secret key (`redactSettingsValues`: only whether it is set), the value
 * a faulty key has in the file, text of the file, a system error message. What a request carries is not written to
 * any log, and no answer repeats the value that was asked for.
 *
 * Only the keys the schema gives a control (`ui: "edit"`) can be changed here; `writeSetting` itself takes any key.
 * The options of `writeSetting` are built here and nothing of a request reaches them but the key and the change.
 *
 * Also here: the watcher that tells the page when the file changed, and the attributes the served `index.html`
 * carries so that the first paint already has the configured theme.
 */

import { readFileSync, statSync } from "node:fs";
import {
  isSettingKey,
  redactSettingsValues,
  SETTING_KEYS,
  type SettingChangeRefusal,
  type SettingChangeResponse,
  type SettingDef,
  type SettingKey,
  type SettingsFileState,
  type SettingsSnapshot,
  type SettingsValues,
  type SettingValue,
  settingDef,
} from "@argelanderspace/contracts";
import {
  type ConfigChange,
  configFilePath,
  editConfigText,
  readSettingsText,
  type SettingsReading,
  type SettingWriteRefusal,
  writeSetting,
} from "@argelanderspace/infra";
import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** The longest body a change may have; a value is a short scalar. */
export const SETTING_CHANGE_BODY_MAX_BYTES = 4096;

type Guard = (origin: string | undefined) => { body: { detail: string }; status: 403 } | null;

export interface SettingsRouteOptions {
  /** The config file; default `configFilePath()`, resolved at each request. */
  path?: string | undefined;
  /** Called after a change that rewrote the file. */
  written?: (() => void) | undefined;
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

// --------------------------------------------------------------------------- //
// Reading
// --------------------------------------------------------------------------- //

interface FileText {
  state: SettingsFileState;
  /** The file's text; `null` when there is none to look at. */
  text: string | null;
  /** The bytes are not UTF-8: reading goes on with what can be decoded, and no key can be changed. */
  badEncoding: boolean;
}

function readFileText(path: string): FileText {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
    return { state: missing ? "missing" : "unreadable", text: null, badEncoding: false };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { state: "read", text, badEncoding: false };
  } catch {
    return { state: "read", text: bytes.toString("utf-8"), badEncoding: true };
  }
}

/** The lenient reading of the file at `path`, and the text it was made from. */
function readWithText(path: string): { reading: SettingsReading; file: FileText } {
  const file = readFileText(path);
  if (file.text === null) {
    // No text: every default, with the one whole-file problem when the file is there and cannot be read.
    const empty = readSettingsText("");
    return file.state === "missing"
      ? { reading: { ...empty, file: "missing" }, file }
      : {
          reading: {
            ...empty,
            problems: [{ key: null, reason: "unreadable" }],
            file: "unreadable",
          },
          file,
        };
  }
  return { reading: readSettingsText(file.text), file };
}

/** The lenient reading of the config file; never throws. */
export function readSettings(path: string = configFilePath()): SettingsReading {
  return readWithText(path).reading;
}

/**
 * A value the key accepts and does not have now: what a change of the key would write, so that asking the line
 * editor for it shows whether the key can be changed as the file is laid out.
 */
function otherValue(def: SettingDef, current: SettingValue | null): SettingValue {
  const type = def.type;
  switch (type.kind) {
    case "boolean":
      return current !== true;
    case "integer":
      return current === type.min ? type.min + 1 : type.min;
    case "enum":
      return type.values.find((value) => value !== current) ?? type.values[0] ?? "";
    case "string": {
      const sample = type.path === "absolute" ? "/a" : "a";
      return current === sample ? `${sample}a` : sample;
    }
  }
}

/** Why the page cannot change `key` in this text, or `null` when it can: the line editor is asked, nothing is written. */
function refusalFor(
  text: string,
  key: SettingKey,
  current: SettingValue | null
): SettingChangeRefusal | null {
  const changes: ConfigChange[] = [{ reset: true }, { set: otherValue(settingDef(key), current) }];
  for (const change of changes) {
    const edited = editConfigText(text, key, change);
    if (!edited.ok) return edited.reason;
  }
  return null;
}

/** The settings as the page may see them. Never throws. */
export function settingsSnapshot(path: string = configFilePath()): SettingsSnapshot {
  const { reading, file } = readWithText(path);
  const readonly = reading.file === "unparseable" || reading.file === "unreadable";
  const uneditable: Partial<Record<SettingKey, SettingChangeRefusal>> = {};
  if (!readonly) {
    for (const key of SETTING_KEYS) {
      if (settingDef(key).ui !== "edit") continue;
      const refusal = file.badEncoding
        ? "invalid_encoding"
        : refusalFor(file.text ?? "", key, reading.values[key]);
      if (refusal !== null) uneditable[key] = refusal;
    }
  }
  return {
    version: 1,
    path,
    file: reading.file,
    readonly,
    values: redactSettingsValues(reading.values),
    sources: reading.sources,
    problems: reading.problems,
    uneditable,
    legacy: reading.present.filter((key) => settingDef(key).deprecated === true),
  };
}

// --------------------------------------------------------------------------- //
// Changing one key
// --------------------------------------------------------------------------- //

/** A request for something that is not a change of a key the page can change. */
const REQUEST_STATUS: Partial<Record<SettingChangeRefusal, ContentfulStatusCode>> = {
  invalid_request: 400,
  invalid_value: 400,
  unrepresentable_value: 400,
  unknown_key: 404,
  not_editable: 422,
};
/** The file or its directory could not be read or written. */
const FILE_FAILURES = new Set<SettingChangeRefusal>([
  "unreadable",
  "invalid_encoding",
  "not_writable",
  "write_failed",
]);

/** 400 / 404 / 422 for the request, 500 for a file that cannot be read or written, 409 for everything about how the
 * file is written now (and `busy`). */
function statusOf(reason: SettingChangeRefusal): ContentfulStatusCode {
  return REQUEST_STATUS[reason] ?? (FILE_FAILURES.has(reason) ? 500 : 409);
}

/** Exactly `{ set: scalar }` or `{ reset: true }`; anything else is `null`. */
function changeOf(body: unknown): ConfigChange | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1) return null;
  const record = body as Record<string, unknown>;
  if (keys[0] === "reset") return record.reset === true ? { reset: true } : null;
  if (keys[0] !== "set") return null;
  const value = record.set;
  if (typeof value === "number") return Number.isFinite(value) ? { set: value } : null;
  return typeof value === "string" || typeof value === "boolean" ? { set: value } : null;
}

export function mountSettingsRoutes(
  app: Hono,
  guardCsrf: Guard,
  options: SettingsRouteOptions = {}
): void {
  const pathNow = (): string => options.path ?? configFilePath();

  app.get("/api/settings", (c) => c.json(settingsSnapshot(pathNow()), 200, NO_STORE));

  app.put("/api/settings/:key", async (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status, NO_STORE);
    const refuse = (reason: SettingChangeRefusal) =>
      c.json({ ok: false, reason } satisfies SettingChangeResponse, statusOf(reason), NO_STORE);

    const key = c.req.param("key");
    if (!isSettingKey(key)) return refuse("unknown_key");
    if (settingDef(key).ui !== "edit") return refuse("not_editable");

    const declared = Number(c.req.header("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > SETTING_CHANGE_BODY_MAX_BYTES) {
      return refuse("invalid_request");
    }
    let body: unknown;
    try {
      const text = await c.req.text();
      if (Buffer.byteLength(text, "utf-8") > SETTING_CHANGE_BODY_MAX_BYTES) {
        return refuse("invalid_request");
      }
      body = JSON.parse(text);
    } catch {
      return refuse("invalid_request");
    }
    const change = changeOf(body);
    if (change === null) return refuse("invalid_request");

    const path = pathNow();
    // Only the path: nothing a request carries becomes an option of the write.
    const result = await writeSetting(key, change, { path });
    if (!result.ok) return refuse(result.reason satisfies SettingWriteRefusal);
    if (result.changed) {
      try {
        options.written?.();
      } catch {
        /* telling the pages is not part of the change */
      }
    }
    return c.json(
      {
        ok: true,
        changed: result.changed,
        settings: settingsSnapshot(path),
      } satisfies SettingChangeResponse,
      200,
      NO_STORE
    );
  });
}

// --------------------------------------------------------------------------- //
// Watching the file
// --------------------------------------------------------------------------- //

export interface SettingsWatcherOptions {
  /** The config file; default `configFilePath()`, resolved once. */
  path?: string | undefined;
  /** Poll interval in ms (default 1500); tests inject ~50. */
  intervalMs?: number | undefined;
  /** Called once per poll in which the file was found changed, created or removed. */
  onChange: () => void;
}

/**
 * Tells when the config file changed on disk. A poll of the file's own identity (inode, size, modification time in
 * nanoseconds; or "no file"), like the other external-write watcher (watch.ts), not `fs.watch`: the file is replaced
 * by a rename (a new inode each time), its directory need not exist yet, the path may be a symbolic link, and the
 * lock directory and the temporary file that a write puts beside it are of no interest — looking at the one path
 * covers all of these. The first poll only takes the baseline. The server's own write is found too.
 */
export function startSettingsWatcher(options: SettingsWatcherOptions): { stop(): void } {
  const path = options.path ?? configFilePath();
  const identity = (): string => {
    try {
      const { ino, size, mtimeNs } = statSync(path, { bigint: true });
      return `${ino}:${size}:${mtimeNs}`;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
    }
  };
  let last = identity();
  const timer = setInterval(() => {
    const now = identity();
    if (now === last) return;
    last = now;
    try {
      options.onChange();
    } catch {
      /* a failed notification must not stop the watcher */
    }
  }, options.intervalMs ?? 1500);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

// --------------------------------------------------------------------------- //
// The first paint
// --------------------------------------------------------------------------- //

const escapeAttribute = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * The served `index.html` with the configured appearance on its `<html>` element: `lang`, `data-theme`,
 * `data-density`, `data-accent`, `data-labels`, and `data-ui-from="config"` to say where they come from. The theme's
 * colours are CSS rules on `data-theme`, so the very first paint has them, in a browser that has never opened the
 * workbench as well; the page starts from these attributes and not from what a browser stored. A document without an
 * `<html …>` tag is returned as it is. The values are the schema's own choices (or its defaults), never file text.
 */
export function withAppearance(html: string, values: SettingsValues): string {
  const attributes: Record<string, string> = {
    lang: String(values["ui.language"]),
    "data-theme": String(values["ui.theme"]),
    "data-density": String(values["ui.density"]),
    "data-accent": String(values["ui.accent"]),
    "data-labels": String(values["ui.labels"]),
    "data-ui-from": "config",
  };
  return html.replace(/<html\b([^>]*)>/i, (_tag, rest: string) => {
    let kept = rest;
    for (const name of Object.keys(attributes)) {
      kept = kept.replace(new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "gi"), "");
    }
    const added = Object.entries(attributes)
      .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
      .join("");
    return `<html${kept}${added}>`;
  });
}
