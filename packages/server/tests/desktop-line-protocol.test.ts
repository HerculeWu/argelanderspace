/**
 * The line protocol between the desktop host and its shell, against the corpus both sides' tests read
 * (`fixtures/desktop-line-protocol.json`; the shell's side is `packages/desktop/src/protocol.rs` and `supervisor.rs`,
 * run by `cargo test`). Here, the host's side: the corpus's constants are the host's; every kind, event and value of
 * the host's tables has a record; each line the host writes has the shape of its record (the values a test run decides
 * — port, paths, ids — aside, as the record's `vary` names them; compared as JSON values); each line the shell may
 * write, fed to the host through its input, is recorded or rejected as its record says.
 *
 * The host's own rules stay in its own tests: what the values in its lines are (`desktop-host.test.ts`), that no text
 * of a line reaches the log and that the server's own record names are not the shell's to write (same file), the
 * menu's ids and labels (`desktop-menu.test.ts`), shutting down and switching (`desktop-host`, `desktop-switch`,
 * `desktop-welcome`). Everything below the home directory is the throwaway one of the isolation setup.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { PassThrough } from "node:stream";
import {
  DEFAULT_UI_LANGUAGE,
  HOST_REQUEST_KINDS,
  SETTINGS_LOG_LEVELS,
  SETTINGS_UI_LANGUAGES,
} from "@argelanderspace/contracts";
import {
  __setWriterSandboxForTests,
  configFilePath,
  DEFAULT_LOG_LEVEL,
  recordRecentProject,
  resolveRecentProjectsPath,
} from "@argelanderspace/infra";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { USER_DIRS_ISOLATION } from "../../infra/tests/user-dirs-guard-key.js";
import {
  type DesktopHost,
  HOST_LINE_MAX_BYTES,
  HOST_MENU_LABEL_MAX,
  HOST_MENU_RECENT_MAX,
  HOST_STOP_REASONS,
  type HostOutLine,
  MENU_REQUESTS,
  projectUnavailableLine,
  REJECT_REASONS,
  runDesktopHost,
} from "../src/desktop-host.js";
import { SHELL_EVENTS } from "../src/shell-events.js";

// ---- the corpus ----------------------------------------------------------------------------------------------- //

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Fields = Record<string, Json>;

interface ToShellRecord {
  id: string;
  note: string;
  /** A line today's host writes (`host` says how this test makes it write one); otherwise only the shell reads it. */
  valid: boolean;
  line?: Json;
  raw?: string;
  host?: string;
  /** The keys whose values the test run decides (compared by kind only); `recent[].id` is the `id` of each entry. */
  vary?: string[];
  /** What the shell makes of the line (checked by `cargo test`). */
  shell: Json;
}

interface ToHostRecord {
  id: string;
  note: string;
  /** A line the shell writes; otherwise one it does not (a rejection, or a placeholder of the host's). */
  valid: boolean;
  line?: Json;
  raw?: string;
  vary?: string[];
  /** The record the line leads to (its first), or the reason it is rejected for. */
  host: { record: Fields } | { rejected: string };
  /** How the shell writes the line (checked by `cargo test`); null for a line it does not write. */
  shell: { writer: string; args: Json[] } | { event: string; level: string; words: Fields } | null;
  /** A value of the host's table the shell never gives. */
  shellEmits?: false;
}

interface Corpus {
  version: 1;
  constants: {
    lineMaxBytes: number;
    logLevels: string[];
    defaultLogLevel: string;
    menuRecentMax: number;
    menuLabelMaxChars: number;
    languages: Record<string, string>;
    defaultLanguage: string;
    stopReasons: string[];
    requestKinds: string[];
    menuRequests: string[];
    rejectReasons: string[];
    shellLineRejectReasons: string[];
  };
  toShell: ToShellRecord[];
  toHost: ToHostRecord[];
}

const corpus = JSON.parse(
  readFileSync(new URL("./fixtures/desktop-line-protocol.json", import.meta.url), "utf8")
) as Corpus;

/** The shell's events as the host's table has them, without its literal types (the table's shape is not this test's). */
const TABLE = SHELL_EVENTS as unknown as Record<
  string,
  {
    level: string;
    fields: Record<string, string | readonly string[]>;
    warnWhen?: { field: string; value: string };
  }
>;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const lineOf = (record: { line?: Json; raw?: string }): string =>
  record.raw ?? JSON.stringify(record.line);
const fieldsOf = (record: ToHostRecord): Fields =>
  isObject(record.line) && isObject(record.line.fields) ? (record.line.fields as Fields) : {};
const shellEventRecords = corpus.toHost.filter(
  (r): r is ToHostRecord & { shell: { event: string; level: string; words: Fields } } =>
    r.valid && r.shell !== null && "event" in r.shell
);

/** Every type of line the host writes: the type checker holds this to `HostOutLine`, so a new one must be listed. */
const HOST_LINE_TYPES: Record<HostOutLine["type"], true> = {
  ready: true,
  request: true,
  menu: true,
  stopping: true,
  stopped: true,
  failed: true,
};

describe("the corpus's constants are the host's", () => {
  test("limits, levels, languages, stop reasons, request kinds, menu requests, rejection reasons", () => {
    const c = corpus.constants;
    expect(corpus.version).toBe(1);
    expect(c.lineMaxBytes).toBe(HOST_LINE_MAX_BYTES);
    expect(c.logLevels).toEqual([...SETTINGS_LOG_LEVELS]);
    expect(c.defaultLogLevel).toBe(DEFAULT_LOG_LEVEL);
    expect(c.menuRecentMax).toBe(HOST_MENU_RECENT_MAX);
    expect(c.menuLabelMaxChars).toBe(HOST_MENU_LABEL_MAX);
    expect(Object.keys(c.languages)).toEqual([...SETTINGS_UI_LANGUAGES]);
    expect(c.defaultLanguage).toBe(DEFAULT_UI_LANGUAGE);
    expect(c.stopReasons).toEqual([...HOST_STOP_REASONS]);
    expect(c.requestKinds).toEqual([...HOST_REQUEST_KINDS]);
    expect(c.menuRequests).toEqual([...MENU_REQUESTS]);
    expect(c.rejectReasons).toEqual([...REJECT_REASONS]);
    expect(c.shellLineRejectReasons).toEqual(TABLE["shell.line_rejected"]?.fields.reason);
  });
});

describe("the corpus has a record of everything in the host's tables", () => {
  const validToShell = corpus.toShell.filter((r) => r.valid);
  const shellLines = validToShell.map((r) => r.line as Record<string, Json>);
  const validToHost = corpus.toHost.filter((r) => r.valid);

  test("ids are unique; each record has its line and the results of both sides", () => {
    const ids = [...corpus.toShell, ...corpus.toHost].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of [...corpus.toShell, ...corpus.toHost]) {
      expect([r.id, (r.line === undefined) !== (r.raw === undefined)]).toEqual([r.id, true]);
    }
    for (const r of validToShell) expect([r.id, typeof r.host]).toEqual([r.id, "string"]);
    for (const r of corpus.toHost)
      expect([r.id, r.valid === (r.shell !== null)]).toEqual([r.id, true]);
  });

  test("every type of line the host writes, every request kind and stop reason, both ways of each", () => {
    for (const type of Object.keys(HOST_LINE_TYPES))
      expect([type, shellLines.some((l) => l.type === type)]).toEqual([type, true]);
    for (const kind of HOST_REQUEST_KINDS)
      expect([kind, shellLines.some((l) => l.type === "request" && l.kind === kind)]).toEqual([
        kind,
        true,
      ]);
    for (const reason of HOST_STOP_REASONS)
      expect([
        reason,
        shellLines.some((l) => l.type === "stopping" && l.reason === reason),
      ]).toEqual([reason, true]);
    const has = (check: (l: Record<string, Json>) => boolean) => shellLines.some(check);
    expect(has((l) => l.type === "ready" && l.project === null)).toBe(true);
    expect(has((l) => l.type === "ready" && typeof l.project === "string")).toBe(true);
    expect(has((l) => l.type === "stopped" && l.next === undefined)).toBe(true);
    expect(has((l) => l.type === "stopped" && typeof l.next === "string")).toBe(true);
    for (const stage of ["start", "project"])
      expect([stage, has((l) => l.type === "failed" && l.stage === stage)]).toEqual([stage, true]);
  });

  test("every menu item the shell sends, and every reason a line is rejected for", () => {
    const menuItems = validToHost
      .map((r) => r.line as Record<string, Json>)
      .filter((l) => l.type === "menu")
      .map((l) => l.item);
    expect(menuItems).toEqual([...MENU_REQUESTS, "open_recent"]);
    const rejected = corpus.toHost.flatMap((r) => ("rejected" in r.host ? [r.host.rejected] : []));
    // A line too long is made from the limit by each side, not stored.
    expect(new Set([...rejected, "too_long"])).toEqual(new Set(REJECT_REASONS));
  });

  test("every shell event, each of its fields and each value of its tables; level and words as the table says", () => {
    for (const [event, spec] of Object.entries(TABLE)) {
      const records = shellEventRecords.filter((r) => r.shell.event === event);
      expect([event, records.length > 0]).toEqual([event, true]);
      const names = new Set(records.flatMap((r) => Object.keys(fieldsOf(r))));
      expect([event, [...names].sort()]).toEqual([event, Object.keys(spec.fields).sort()]);
      for (const [field, kind] of Object.entries(spec.fields)) {
        if (typeof kind === "string") continue;
        for (const value of kind)
          expect([event, field, value, records.some((r) => fieldsOf(r)[field] === value)]).toEqual([
            event,
            field,
            value,
            true,
          ]);
      }
    }
    for (const r of shellEventRecords) {
      const event = (r.line as Record<string, Json>).event;
      const spec = TABLE[r.shell.event];
      expect([r.id, event, spec !== undefined]).toEqual([r.id, r.shell.event, true]);
      if (spec === undefined) continue;
      const fields = fieldsOf(r);
      // The words are the fields written from one of the table's lists, and nothing else.
      const words = Object.fromEntries(
        Object.entries(fields).filter(([name]) => Array.isArray(spec.fields[name]))
      );
      expect([r.id, r.shell.words]).toEqual([r.id, words]);
      // Each of them one of its list's values: a value the shell gives and the table lacks is not a valid line.
      for (const [name, value] of Object.entries(words)) {
        const list = spec.fields[name] as readonly string[];
        expect([r.id, name, value, list.includes(value as string)]).toEqual([
          r.id,
          name,
          value,
          true,
        ]);
      }
      // The host writes such a line as it is, at the level both sides give it.
      const warns =
        spec.warnWhen !== undefined && fields[spec.warnWhen.field] === spec.warnWhen.value;
      const level = spec.level === "warn" || warns ? "warn" : "info";
      expect([r.id, r.shell.level]).toEqual([r.id, level]);
      expect([r.id, r.host]).toEqual([
        r.id,
        { record: { event: r.shell.event, level, ...fields } },
      ]);
    }
  });
});

// ---- the host, run ------------------------------------------------------------------------------------------- //

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const KEYCHAIN = async () => ({ state: "unavailable" as const, reason: "no_bus" as const });
const cwd = process.cwd();
const roots: string[] = [];
const closers: Array<() => Promise<unknown>> = [];

/** `path`, once it is seen to lie below the throwaway home of this test run; anything else is refused. */
function isolated(path: string): string {
  const isolation = (globalThis as Record<symbol, unknown>)[USER_DIRS_ISOLATION] as
    | { root: string }
    | undefined;
  if (!isolation) throw new Error("isolate-user-dirs.ts did not run");
  const rel = relative(isolation.root, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("a per-user path of this test run is outside its throwaway home");
  }
  return path;
}

function folder(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `aspace-line-${name}-`));
  roots.push(root);
  return realpathSync(root);
}

function writeConfig(text: string): void {
  const file = isolated(configFilePath());
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

const logDir = () => join(process.env.XDG_DATA_HOME ?? "", "argelanderspace", "logs");
const listLogs = () => (existsSync(logDir()) ? readdirSync(logDir()) : []);
type LogRecord = Record<string, unknown>;

interface Running {
  host: DesktopHost;
  input: PassThrough;
  lines: HostOutLine[];
  /** The next line of this type not taken yet (one already written included). */
  next<T extends HostOutLine["type"]>(type: T): Promise<Extract<HostOutLine, { type: T }>>;
  url: string;
  /** This host's log, as it is on disk now. */
  log(): LogRecord[];
}

/** A host in a project folder of its own (or, from the recent list, in the welcome state), its config written first. */
async function startHost(config: string, opts: { fromRecent?: boolean } = {}): Promise<Running> {
  writeConfig(config);
  // The recent list is the test's own when it chooses from it; otherwise none (the earlier hosts' projects are not).
  if (!opts.fromRecent) rmSync(isolated(resolveRecentProjectsPath()), { force: true });
  process.chdir(folder("project"));
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: HostOutLine[] = [];
  const taken = new Set<number>();
  let rest = "";
  output.on("data", (chunk: Buffer) => {
    rest += chunk.toString("utf8");
    let nl = rest.indexOf("\n");
    while (nl !== -1) {
      lines.push(JSON.parse(rest.slice(0, nl)) as HostOutLine);
      rest = rest.slice(nl + 1);
      nl = rest.indexOf("\n");
    }
  });
  const next = async <T extends HostOutLine["type"]>(type: T) => {
    for (let i = 0; i < 400; i++) {
      const index = lines.findIndex((line, n) => line.type === type && !taken.has(n));
      if (index !== -1) {
        taken.add(index);
        return lines[index] as Extract<HostOutLine, { type: T }>;
      }
      await sleep(10);
    }
    throw new Error(`no ${type} line; got ${JSON.stringify(lines)}`);
  };
  const before = new Set(listLogs());
  const host = await runDesktopHost({
    input,
    output,
    version: "9.9.9-test",
    keychainProbe: KEYCHAIN,
    webDist: join(process.cwd(), "web"),
    skillsDir: join(process.cwd(), "skills"),
    ...(opts.fromRecent ? { fromRecent: true } : {}),
  });
  closers.push(() => host.stop());
  const ready = await next("ready");
  const mine = listLogs().filter((name) => !before.has(name));
  expect(mine).toHaveLength(1);
  const log = () =>
    readFileSync(join(logDir(), mine[0] ?? "missing"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LogRecord);
  return { host, input, lines, next, url: ready.url.replace(/\/$/, ""), log };
}

/** The records written after the first `count`, once there are any (each line of the shell leads to one at least). */
async function recordsAfter(h: Running, count: number): Promise<LogRecord[]> {
  for (let i = 0; i < 300; i++) {
    const log = h.log();
    if (log.length > count) return log.slice(count);
    await sleep(10);
  }
  return [];
}

/** A request line of `kind` asked through the host interface, as the page asks; resolved once it is recorded. */
async function askRequest(h: Running, kind: string): Promise<HostOutLine> {
  const count = h.log().length;
  const res = await fetch(`${h.url}/api/host/requests/${kind}`, {
    method: "POST",
    headers: { Origin: h.url },
  });
  expect([kind, res.status]).toEqual([kind, 202]);
  const line = await h.next("request");
  await recordsAfter(h, count);
  return line;
}

/** What one line of the shell led to: its first record (without the time), and whether the host wrote a line. */
interface Outcome {
  record: LogRecord | undefined;
  wroteLine: boolean;
}

/** Feeds the line through the host's input and waits for its record. */
async function feed(h: Running, text: string): Promise<Outcome> {
  const count = h.log().length;
  const lineCount = h.lines.length;
  h.input.write(`${text}\n`);
  const [first] = await recordsAfter(h, count);
  const { t: _t, ...record } = first ?? { t: null };
  return {
    record: first === undefined ? undefined : record,
    wroteLine: h.lines.length > lineCount,
  };
}

/** The record's line with the values of `vary` replaced by this run's (the host's own pick id, its menu id). */
function withVary(record: ToHostRecord, values: Record<string, Json>): string {
  if (!isObject(record.line)) return lineOf(record);
  const line: Record<string, Json> = { ...(record.line as Record<string, Json>) };
  for (const key of record.vary ?? []) {
    const value = values[key];
    if (value === undefined) throw new Error(`${record.id}: no value for ${key}`);
    line[key] = value;
  }
  return JSON.stringify(line);
}

/** Where the line of `actual` differs from the record's: by kind only at the keys of `vary`, else by value. */
function shapeDiff(actual: unknown, expected: unknown, vary: readonly string[], at = ""): string[] {
  const kind = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
  const where = at === "" ? "<line>" : at;
  if (vary.includes(at))
    return kind(actual) === kind(expected)
      ? []
      : [`${where}: a ${kind(actual)}, not a ${kind(expected)}`];
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length)
      return [`${where}: ${JSON.stringify(actual)} instead of ${JSON.stringify(expected)}`];
    return expected.flatMap((e, i) => shapeDiff(actual[i], e, vary, `${at}[]`));
  }
  if (isObject(expected)) {
    if (!isObject(actual)) return [`${where}: ${JSON.stringify(actual)} instead of an object`];
    const keys = [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort();
    return keys.flatMap((key) => {
      const path = at === "" ? key : `${at}.${key}`;
      if (!Object.hasOwn(actual, key)) return [`${path}: missing`];
      if (!Object.hasOwn(expected, key)) return [`${path}: not in the corpus`];
      return shapeDiff(actual[key], expected[key], vary, path);
    });
  }
  return Object.is(actual, expected)
    ? []
    : [`${where}: ${JSON.stringify(actual)} instead of ${JSON.stringify(expected)}`];
}

/** The lines the host wrote, by how they were made (a record's `host`). */
const written = new Map<string, unknown>();
/** What each line of the shell led to, by the record's id. */
const outcomes = new Map<string, Outcome>();

beforeAll(async () => {
  __setWriterSandboxForTests(false);
  const fed = new Set<string>();
  const run = async (h: Running, record: ToHostRecord, values: Record<string, Json> = {}) => {
    fed.add(record.id);
    outcomes.set(record.id, await feed(h, withVary(record, values)));
  };
  const byId = (id: string) => {
    const record = corpus.toHost.find((r) => r.id === id);
    if (record === undefined) throw new Error(`no record ${id}`);
    return record;
  };

  // A project open, the default config: its ready and menu lines, each request kind; then every line of the shell
  // but those that leave (open a recent project) or quit, then the quit line.
  const h1 = await startHost("port = 0\n");
  written.set("ready:project", h1.lines[0]);
  written.set("menu:project", await h1.next("menu"));
  for (const kind of HOST_REQUEST_KINDS) written.set(`request:${kind}`, await askRequest(h1, kind));
  for (const record of corpus.toHost) {
    if (record.id === "quit" || record.id === "menu-open-recent") continue;
    const values: Record<string, Json> = {};
    if (record.vary?.includes("id")) {
      // The answer to a folder request the host made just now.
      const ask = await askRequest(h1, "pick_folder");
      values.id = (ask as { id: string }).id;
    }
    await run(h1, record, values);
  }
  // Too long: made from the limit (a quit line, padded, that must not quit).
  const long = JSON.stringify({ type: "quit", pad: "" });
  outcomes.set(
    "too-long",
    await feed(
      h1,
      long.replace('""', `"${"x".repeat(corpus.constants.lineMaxBytes - long.length + 1)}"`)
    )
  );
  await run(h1, byId("quit"));
  written.set("stopping:quit", await h1.next("stopping"));
  written.set("stopped:quit", await h1.next("stopped"));
  await h1.host.stopped;

  // English and the warn level in config.toml; the shell goes away (the end of the host's input).
  const h2 = await startHost('port = 0\nlog_level = "warn"\n[ui]\nlanguage = "en"\n');
  written.set("ready:en-warn", h2.lines[0]);
  written.set("menu:en-warn", await h2.next("menu"));
  h2.input.end();
  written.set("stopping:input_closed", await h2.next("stopping"));
  await h2.host.stopped;

  // The welcome state: the last project's folder is gone, an older one is there; the menu opens the older one.
  const recentFile = isolated(resolveRecentProjectsPath());
  rmSync(recentFile, { force: true });
  recordRecentProject(recentFile, folder("alpha"), new Date("2026-01-01T00:00:00Z"));
  recordRecentProject(recentFile, join(folder("parent"), "gone"), new Date("2026-01-02T00:00:00Z"));
  const h3 = await startHost("port = 0\n", { fromRecent: true });
  written.set("ready:welcome", h3.lines[0]);
  const menu = await h3.next("menu");
  written.set("menu:welcome", menu);
  const there = menu.recent.find((entry) => entry.enabled);
  await run(h3, byId("menu-open-recent"), { id: there?.id ?? "none" });
  written.set("stopping:switch", await h3.next("stopping"));
  written.set("stopped:switch", await h3.next("stopped"));
  await h3.host.stopped;

  // The configured port held by another program: the host listens on another; stopped as on a signal.
  const other: Server = createHttpServer((_req, res) => res.end("not the workbench"));
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise<void>((r) => other.close(() => r())));
  const h4 = await startHost(`port = ${(other.address() as { port: number }).port}\n`);
  written.set("ready:fallback", h4.lines[0]);
  await h4.host.stop("signal");
  written.set("stopping:signal", await h4.next("stopping"));

  const h5 = await startHost("port = 0\n");
  await h5.host.stop("output_closed");
  written.set("stopping:output_closed", await h5.next("stopping"));

  // A server that cannot start: its data directory cannot be made (a file stands where it would be).
  writeConfig("port = 0\n");
  process.chdir(folder("project"));
  writeFileSync(join(process.cwd(), "literatures"), "not a folder");
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  await expect(
    runDesktopHost({ input: new PassThrough(), output, keychainProbe: KEYCHAIN })
  ).rejects.toBeDefined();
  written.set("failed:start", JSON.parse(text.split("\n")[0] ?? "null"));
  written.set("failed:project", projectUnavailableLine());

  const notFed = corpus.toHost.filter((r) => !fed.has(r.id)).map((r) => r.id);
  if (notFed.length > 0) throw new Error(`not fed to a host: ${notFed.join(", ")}`);
}, 120_000);

afterAll(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => {});
  process.chdir(cwd);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  rmSync(isolated(configFilePath()), { force: true });
  rmSync(isolated(resolveRecentProjectsPath()), { force: true });
  __setWriterSandboxForTests(null);
});

describe("each line the host writes has the shape of its record", () => {
  test.each(corpus.toShell.filter((r) => r.valid).map((r) => [r.id, r] as const))(
    "%s",
    (_id, record) => {
      const line = written.get(record.host ?? "");
      expect(line, `the host wrote no line as ${record.host}`).toBeDefined();
      expect(shapeDiff(line, record.line, record.vary ?? [])).toEqual([]);
    }
  );

  test("every line the host was made to write is a record's", () => {
    const used = new Set(corpus.toShell.map((r) => r.host));
    expect([...written.keys()].filter((how) => !used.has(how))).toEqual([]);
  });
});

describe("each line of the shell is recorded, or rejected, as its record says", () => {
  test.each(corpus.toHost.map((r) => [r.id, r] as const))("%s", (_id, record) => {
    const outcome = outcomes.get(record.id);
    expect(outcome).toBeDefined();
    if ("rejected" in record.host) {
      expect(outcome?.record).toEqual({
        level: "warn",
        event: "desktop.protocol_rejected",
        reason: record.host.rejected,
      });
      // Not acted on: no line to the shell.
      expect(outcome?.wroteLine).toBe(false);
    } else {
      expect(outcome?.record).toEqual(record.host.record);
    }
  });

  test("a line longer than the limit (made from it) is rejected whole, not acted on", () => {
    expect(outcomes.get("too-long")).toEqual({
      record: { level: "warn", event: "desktop.protocol_rejected", reason: "too_long" },
      wroteLine: false,
    });
  });
});
