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
import { homedir } from "node:os";
import { sep } from "node:path";
import {
  defaultSettings,
  isSettingKey,
  type RunningSettings,
  redactSettingsValues,
  SETTING_KEYS,
  SETTING_VALUE_PROBLEMS,
  SETTINGS_TABLES,
  type SettingChangeRefusal,
  type SettingChangeResponse,
  type SettingDef,
  type SettingKey,
  type SettingsFileState,
  type SettingsProblem,
  type SettingsSnapshot,
  type SettingsValues,
  type SettingValue,
  type ShownPath,
  type StartupLocations,
  settingDef,
} from "@argelanderspace/contracts";
import {
  type ConfigChange,
  configFilePath,
  editConfigText,
  isAbsoluteOnThisPlatform,
  readSettingsText,
  type SettingsReading,
  type SettingWriteRefusal,
  writeSetting,
} from "@argelanderspace/infra";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { readLimited } from "./page-errors.js";
import type { ProtectedRoutes } from "./protected-app.js";

/** The longest body a change may have; a value is a short scalar. */
export const SETTING_CHANGE_BODY_MAX_BYTES = 4096;

export interface SettingsRouteOptions {
  /** The config file; default `configFilePath()`, resolved at each request. */
  path?: string | undefined;
  /** Called after a change that rewrote the file. */
  written?: (() => void) | undefined;
  /** Where the process's data lives, fixed when `serve` started (`SettingsSnapshot.startup`); default null. */
  startup?: StartupLocations | null | undefined;
  /** What the process actually uses for the restart-only keys (`SettingsSnapshot.running`), asked at each answer. */
  running: () => RunningSettings;
  /**
   * The values the file gave when the server was made (`serve`: the reading it started with): a restart-only key whose
   * value in the file differs from this now is `restartPending`.
   */
  atStart: SettingsValues;
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
  return { reading: withPlatformPaths(readSettingsText(file.text)), file };
}

const GLOBAL_DIR_KEYS = ["global_dir", "global_cache_dir"] as const;

/**
 * The schema takes an absolute path in any platform's writing; a global directory must be absolute on this machine
 * (infra `isAbsoluteOnThisPlatform`). A value this machine cannot use is a `must_be_absolute` problem here too, with
 * its default in effect — so the page lists what `serve` reported at its start (desktop-app ticket 10).
 */
function withPlatformPaths(reading: SettingsReading): SettingsReading {
  const defaults = defaultSettings();
  let out = reading;
  for (const key of GLOBAL_DIR_KEYS) {
    const value = out.values[key];
    if (
      out.sources[key] !== "file" ||
      typeof value !== "string" ||
      isAbsoluteOnThisPlatform(value.trim())
    )
      continue;
    out = {
      ...out,
      values: { ...out.values, [key]: defaults[key] },
      sources: { ...out.sources, [key]: "default" },
      problems: [...out.problems, { key, reason: "must_be_absolute" }],
    };
  }
  return out;
}

/**
 * Where the process's data lives, from the reading `serve` started with (`StartupLocations`): the source of each
 * location and what was wrong with its key, or with the whole file, at that moment.
 */
export function startupLocations(
  reading: SettingsReading,
  dataDirGiven: boolean
): StartupLocations {
  const whole = reading.problems.find((problem) => problem.key === null)?.reason ?? null;
  const problem = (key: SettingKey) => reading.problems.find((p) => p.key === key)?.reason ?? whole;
  const source = (key: SettingKey): "file" | "default" =>
    reading.sources[key] === "file" ? "file" : "default";
  // With --data-dir the file's state says nothing about where project data is, except that a data_dir the file
  // does name is not used: only data_dir's own problem is told, not the whole file's.
  const own = (key: SettingKey) => reading.problems.find((p) => p.key === key)?.reason ?? null;
  return {
    data_dir: dataDirGiven
      ? { source: "flag", problem: own("data_dir") }
      : { source: source("data_dir"), problem: problem("data_dir") },
    global_dir: { source: source("global_dir"), problem: problem("global_dir") },
    global_cache_dir: { source: source("global_cache_dir"), problem: problem("global_cache_dir") },
  };
}

/**
 * A path as the page shows it: the home directory of the process (`home`) written as `~`. Only a whole leading
 * component is replaced (`/home/ab` is not the home `/home/a`); anything else is returned as it is.
 */
export function displayPath(path: string, home: string = homedir()): string {
  const base = home.endsWith(sep) ? home.slice(0, -1) : home;
  if (base === "") return path;
  if (path === base) return "~";
  return path.startsWith(base + sep) ? `~${path.slice(base.length)}` : path;
}

/** A path and the way the page shows it. */
export function shownPath(path: string, home: string = homedir()): ShownPath {
  return { path, display: displayPath(path, home) };
}

const RESTART_KEYS = SETTING_KEYS.filter((key) => settingDef(key).restart);

/** The restart-only keys whose value in the file now is not the one it had when the server was made. */
export function restartPending(
  now: SettingsValues,
  atStart: SettingsValues,
  fromFlag: readonly SettingKey[] = []
): SettingKey[] {
  // A key given on the command line does not take the file's value at a restart either (with the same flag).
  return RESTART_KEYS.filter((key) => !fromFlag.includes(key) && now[key] !== atStart[key]);
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
      const sample =
        type.format === "email" ? "a@example.org" : type.path === "absolute" ? "/a" : "a";
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

/** What a snapshot says of the running process (`SettingsRouteOptions`). */
export interface ProcessSettings {
  startup: StartupLocations | null;
  running: () => RunningSettings;
  atStart: SettingsValues;
}

/** The settings as the page may see them. Never throws. */
export function settingsSnapshot(path: string, proc: ProcessSettings): SettingsSnapshot {
  const running = proc.running();
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
    pathDisplay: displayPath(path),
    file: reading.file,
    readonly,
    values: redactSettingsValues(reading.values),
    sources: reading.sources,
    problems: reading.problems,
    uneditable,
    legacy: reading.present.filter((key) => settingDef(key).deprecated === true),
    startup: proc.startup,
    running,
    // A file that cannot be read says nothing about what it sets: nothing is reported as pending then.
    restartPending: readonly ? [] : restartPending(reading.values, proc.atStart, running.from_flag),
  };
}

// --------------------------------------------------------------------------- //
// What is wrong with the file, for the terminal and the start record
// --------------------------------------------------------------------------- //

/** A problem of the file: a key (or the `ui` table, or `null` for the whole file) and a category. Never a value. */
export type ConfigProblem = SettingsProblem;

const PROBLEM_REASONS = [
  ...SETTING_VALUE_PROBLEMS,
  "not_a_table",
  "unparseable",
  "unreadable",
] as const;
/** Who a problem is about, as the start record writes it: a schema key, the `ui` table, or `file` for the whole file. */
const PROBLEM_SUBJECTS = [...SETTING_KEYS, ...SETTINGS_TABLES, "file"] as const;

/**
 * Every `<subject>:<reason>` the start record can write (`config_problems`): a list made here from the schema's keys
 * and the problem categories, so the log writes nothing that is not one of them.
 */
export const CONFIG_PROBLEM_ENTRIES: readonly string[] = PROBLEM_SUBJECTS.flatMap((subject) =>
  PROBLEM_REASONS.map((reason) => `${subject}:${reason}`)
);

/** A problem as the start record writes it: `ui.theme:wrong_type`, `file:unparseable`. */
export function configProblemEntry(problem: ConfigProblem): string {
  return `${problem.key ?? "file"}:${problem.reason}`;
}

const REASON_TEXT: Record<ConfigProblem["reason"], string> = {
  wrong_type: "has the wrong type",
  out_of_range: "is out of range",
  not_one_of: "is not one of its choices",
  must_be_relative: "must be a relative path",
  must_be_absolute: "must be an absolute path",
  must_be_email: "must be an email address",
  not_a_table: "is not a table",
  unparseable: "is not valid TOML",
  unreadable: "could not be read",
};

const LOCATION_NAME = {
  data_dir: "project data",
  global_dir: "global data (Mail, credentials, log)",
  global_cache_dir: "global cache",
} as const;

/** What the terminal says of one location the process uses, from the start's state; null when nothing is to say. */
function locationLine(
  key: keyof StartupLocations,
  at: StartupLocations[keyof StartupLocations]
): string | null {
  if (at.problem === null) return null;
  if (at.source === "flag")
    return `${LOCATION_NAME[key]}: the location given by --data-dir is in use`;
  if (at.source === "default") {
    const where =
      key === "data_dir" ? "the default location ./literatures" : "the default directory";
    // A file that could not be read names nothing that is known here.
    const why =
      at.problem === "unparseable" || at.problem === "unreadable"
        ? "the file could not be read"
        : "not the one the file names";
    return `${LOCATION_NAME[key]}: ${where} is in use, ${why}`;
  }
  return null;
}

/**
 * What `serve` prints to stderr when config.toml has problems: one line for the file, one per problem, by key and
 * category — never a value, never the TOML parser's text — then, from the locations the process has just fixed
 * (`startupLocations`), where its data lives for each location the problems touch.
 */
export function configProblemLines(
  problems: readonly ConfigProblem[],
  context: { path: string; startup: StartupLocations }
): string[] {
  if (problems.length === 0) return [];
  const lines = [
    `warning: ${context.path} has problems; what they concern was not taken from the file:`,
  ];
  for (const problem of problems) {
    if (problem.key === null) {
      lines.push(`  the file ${REASON_TEXT[problem.reason]}: every setting has its default`);
      continue;
    }
    if ((["data_dir", "global_dir", "global_cache_dir"] as const).includes(problem.key as never)) {
      lines.push(`  "${problem.key}" ${REASON_TEXT[problem.reason]}`);
      continue;
    }
    const where = problem.key === "ui" ? "table [ui]" : `"${problem.key}"`;
    lines.push(`  ${where} ${REASON_TEXT[problem.reason]}: its default is in use`);
  }
  const keys = ["data_dir", "global_dir", "global_cache_dir"] as const;
  const locations = keys.flatMap((key) => {
    const line = locationLine(key, context.startup[key]);
    return line === null ? [] : [`  ${line}`];
  });
  lines.push(...locations);
  const restart = keys.some(
    (key) => context.startup[key].problem !== null && context.startup[key].source === "default"
  );
  lines.push(
    restart
      ? "  (the settings page lists them too; fix the file and restart the workbench for the data locations to change)"
      : "  (the settings page lists them too)"
  );
  return lines;
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

export function mountSettingsRoutes(routes: ProtectedRoutes, options: SettingsRouteOptions): void {
  const app = routes.withDefaults({ noStore: true });
  const pathNow = (): string => options.path ?? configFilePath();
  const processSettings: ProcessSettings = {
    startup: options.startup ?? null,
    running: options.running,
    atStart: options.atStart,
  };

  app.get("/api/settings", (c) =>
    c.json(settingsSnapshot(pathNow(), processSettings), 200, NO_STORE)
  );

  app.put("/api/settings/:key", async (c) => {
    const refuse = (reason: SettingChangeRefusal) =>
      c.json({ ok: false, reason } satisfies SettingChangeResponse, statusOf(reason), NO_STORE);

    const key = c.req.param("key");
    if (!isSettingKey(key)) return refuse("unknown_key");
    if (settingDef(key).ui !== "edit") return refuse("not_editable");

    // The limit holds while the body is read (page-errors.ts `readLimited`): reading stops at the first chunk over it.
    let body: unknown;
    try {
      const bytes = await readLimited(c, SETTING_CHANGE_BODY_MAX_BYTES);
      if (bytes === null) return refuse("invalid_request");
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
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
        settings: settingsSnapshot(path, processSettings),
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
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** An attribute of a start tag by name, with or without a value (`data-labels`, `lang="en"`, `lang=en`). */
const attributePattern = (name: string): RegExp =>
  new RegExp(`\\s${name}(?=[\\s=/>]|$)(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?`, "gi");

/**
 * The served `index.html` with the configured appearance on its `<html>` element: `lang`, `data-theme`,
 * `data-density`, `data-accent`, `data-labels`, and `data-ui-from="config"` to say where they come from. The theme's
 * colours are CSS rules on `data-theme`, so the very first paint has them, in a browser that has never opened the
 * workbench as well; the page starts from these attributes and not from what a browser stored.
 *
 * Only the first real `<html …>` start tag is changed — one inside a comment is not a tag — and an attribute of the
 * same name it already has (with a value or without) is taken out first. The values are the schema's own choices
 * (or its defaults), never file text; they are escaped all the same. A document without an `<html …>` tag is
 * returned as it is.
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
  const tags = /<!--[\s\S]*?(?:-->|$)|<html(?=[\s>/])([^>]*)>/gi;
  for (let match = tags.exec(html); match !== null; match = tags.exec(html)) {
    if (match[0].startsWith("<!--")) continue;
    let kept = match[1] ?? "";
    for (const name of Object.keys(attributes)) kept = kept.replace(attributePattern(name), "");
    const selfClosing = /\/\s*$/.test(kept);
    if (selfClosing) kept = kept.replace(/\/\s*$/, "");
    const added = Object.entries(attributes)
      .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
      .join("");
    const tag = `<html${kept.replace(/\s+$/, "")}${added}>`;
    return html.slice(0, match.index) + tag + html.slice(match.index + match[0].length);
  }
  return html;
}
