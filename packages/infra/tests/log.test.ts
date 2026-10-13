/**
 * The log module, through its own interface: records go to an injected sink (memory) or to files in a temporary
 * directory, and the tests read what came out. What must hold is that a record cannot say more than its field kinds
 * allow, whatever the caller passes.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  createLogger,
  createMemorySink,
  discardSink,
  f,
  LOG_SAFE_MESSAGE,
  type LogFields,
  openLogFile,
  pruneLogDir,
  resolveLogDir,
} from "../src/log/index.js";

const HOME = "/home/ann";
const EVENTS = ["test.happened", "test.other"] as const;

function setup(level?: "debug" | "info" | "warn" | "error") {
  const sink = createMemorySink();
  const log = createLogger({
    events: EVENTS,
    sink,
    home: HOME,
    now: () => new Date("2026-10-13T08:00:00.000Z"),
    ...(level ? { level } : {}),
  });
  return { sink, log };
}

/** The one record a single `info` call with these fields produces. */
function recordOf(fields: LogFields) {
  const { sink, log } = setup();
  log.info("test.happened", fields);
  expect(sink.lines).toHaveLength(1);
  return sink.records()[0] as Record<string, unknown>;
}

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "aspace-log-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* already gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("a record", () => {
  test("is one JSON line: time, level, event, then the fields", () => {
    const { sink, log } = setup();
    log.warn("test.happened", { status: f.num(503), doc: f.id("arxiv-2501.17225") });
    expect(sink.lines).toEqual([
      '{"t":"2026-10-13T08:00:00.000Z","level":"warn","event":"test.happened","status":503,"doc":"arxiv-2501.17225"}',
    ]);
  });

  test("below the level is not written; the level can change while running", () => {
    const { sink, log } = setup();
    log.debug("test.happened");
    expect(sink.lines).toHaveLength(0);
    expect(log.level()).toBe("info");
    log.setLevel("debug");
    log.debug("test.happened");
    expect(sink.lines).toHaveLength(1);
    log.setLevel("error");
    log.warn("test.happened");
    log.error("test.other");
    expect(sink.records().map((r) => r.event)).toEqual(["test.happened", "test.other"]);
    // Not a level: ignored.
    log.setLevel("verbose" as never);
    expect(log.level()).toBe("error");
  });

  test("an event name outside the catalog is not written as given", () => {
    const { sink, log } = setup();
    const title = "A Study of Something Private";
    log.info(`paper ${title} failed` as never, { doc: f.id("x") });
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).not.toContain("Private");
    expect(sink.records()[0]).toEqual({
      t: "2026-10-13T08:00:00.000Z",
      level: "error",
      event: "log.rejected",
    });
  });

  test("a catalog entry that is not a dotted lower-case name is refused when the logger is made", () => {
    expect(() =>
      createLogger({ events: ["Paper failed: title"] as const, sink: createMemorySink() })
    ).toThrow(TypeError);
  });

  test("a field that was not made by a field constructor is dropped and counted", () => {
    const record = recordOf({
      doc: f.id("d1"),
      note: "the body of a private note" as never,
      nested: { text: "private" } as never,
      "Bad Name": f.num(1),
      level: f.num(2),
      missing: undefined,
    });
    expect(record).toEqual({
      t: "2026-10-13T08:00:00.000Z",
      level: "info",
      event: "test.happened",
      doc: "d1",
      dropped_fields: 4,
    });
  });

  test("a sink that throws does not reach the caller", () => {
    const log = createLogger({
      events: EVENTS,
      sink: {
        write() {
          throw new Error("disk full");
        },
      },
    });
    expect(() => log.error("test.happened", { n: f.num(1) })).not.toThrow();
  });

  test("the discarding sink is never asked to write", () => {
    const log = createLogger({ events: EVENTS, sink: discardSink });
    expect(() => log.error("test.happened", { error: f.error(new Error("x")) })).not.toThrow();
  });
});

describe("what the types refuse", () => {
  test("text as a field, an event outside the catalog, a catalog that is not literals", () => {
    const { sink, log } = setup();
    const runtimeText: string = "built from something the user wrote";
    // @ts-expect-error a string is not a field
    log.info("test.happened", { note: runtimeText });
    // @ts-expect-error neither is a number or an object
    log.info("test.happened", { n: 1, o: { text: runtimeText } });
    // @ts-expect-error not an event of this logger
    log.info("test.unknown");
    // @ts-expect-error an event name cannot be a runtime string
    log.info(runtimeText);
    // @ts-expect-error a catalog of plain strings is not a catalog
    expect(() => createLogger({ events: [runtimeText], sink })).toThrow(TypeError);
    // And what got past the types at run time said nothing.
    expect(sink.lines.join("")).not.toContain("something the user wrote");
  });
});

describe("identifiers and enum values", () => {
  test("an identifier is a short token; text with spaces, an address or other scripts is not written", () => {
    expect(
      recordOf({
        a: f.id("arxiv:2603.03522"),
        b: f.id("10.1016/S0370-2693(99)00123-4"),
        c: f.id("acc-0123456789ab"),
        d: f.id("v24.1.0"),
      })
    ).toMatchObject({
      a: "arxiv:2603.03522",
      b: "10.1016/S0370-2693(99)00123-4",
      c: "acc-0123456789ab",
      d: "v24.1.0",
    });
    const record = recordOf({
      title: f.id("Dark matter halos in the early universe"),
      address: f.id("someone@example.org"),
      chinese: f.id("暗物质晕"),
      long: f.id("x".repeat(129)),
      empty: f.id(""),
      quoted: f.id('a"b'),
      newline: f.id("a\nb"),
      not_string: f.id(42 as never),
    });
    for (const key of [
      "title",
      "address",
      "chinese",
      "long",
      "empty",
      "quoted",
      "newline",
      "not_string",
    ]) {
      expect(record[key], key).toBe("<invalid-id>");
    }
  });

  test("a list of identifiers is checked item by item and capped", () => {
    const record = recordOf({
      ids: f.ids(["a", "has space", "b"]),
      many: f.ids(Array.from({ length: 100 }, (_, i) => `id-${i}`)),
      not_list: f.ids("abc" as never),
    });
    expect(record.ids).toEqual(["a", "<invalid-id>", "b"]);
    expect(record.many).toHaveLength(64);
    expect(record.not_list).toBe("<invalid>");
  });

  test("an enum value is written only when it is one of the listed values", () => {
    const METHODS = ["GET", "POST"] as const;
    const record = recordOf({
      method: f.oneOf(METHODS, "POST"),
      other: f.oneOf(METHODS, "a sentence from somewhere"),
      keys: f.someOf(["port", "data_dir"], ["port", "my secret key name", "data_dir"]),
    });
    expect(record.method).toBe("POST");
    expect(record.other).toBe("<invalid-enum>");
    expect(record.keys).toEqual(["port", "<invalid-enum>", "data_dir"]);
  });

  test("numbers and durations are finite numbers or null", () => {
    const record = recordOf({
      a: f.num(12),
      b: f.num(Number.NaN),
      c: f.num("12" as never),
      d: f.ms(12.3456),
      e: f.ms(-1),
      g: f.ms(Number.POSITIVE_INFINITY),
    });
    expect(record).toMatchObject({ a: 12, b: null, c: null, d: 12.3, e: null, g: null });
  });
});

describe("paths", () => {
  test("the home directory is written as ~", () => {
    const record = recordOf({
      project: f.path("/home/ann/research/halos"),
      home: f.path("/home/ann"),
      elsewhere: f.path("/srv/data/literatures"),
      sibling: f.path("/home/anna/notes"),
      relative: f.path("literatures/output"),
    });
    expect(record).toMatchObject({
      project: "~/research/halos",
      home: "~",
      elsewhere: "/srv/data/literatures",
      sibling: "/home/anna/notes",
      relative: "literatures/output",
    });
  });

  test("a Windows home directory is replaced in either separator spelling", () => {
    const sink = createMemorySink();
    const log = createLogger({ events: EVENTS, sink, home: "C:\\Users\\ann" });
    log.info("test.happened", {
      a: f.path("C:\\Users\\ann\\research"),
      b: f.path("C:/Users/ann/research"),
    });
    expect(sink.records()[0]).toMatchObject({ a: "~\\research", b: "~/research" });
  });

  test("a home directory reached through a symbolic link is replaced under its real name too", () => {
    const root = tmp();
    const real = join(root, "real-home");
    mkdirSync(real);
    const link = join(root, "home-link");
    // The link is the configured home; files report the real path.
    symlinkSync(real, link);
    const sink = createMemorySink();
    const log = createLogger({ events: EVENTS, sink, home: link });
    log.info("test.happened", { a: f.path(join(real, "x")), b: f.path(join(link, "y")) });
    expect(sink.records()[0]).toMatchObject({ a: "~/x", b: "~/y" });
  });

  test("control characters cannot break the line, and a path has a length limit", () => {
    const { sink, log } = setup();
    log.info("test.happened", { p: f.path(`/tmp/a\nb\u0000c/${"x".repeat(2000)}`) });
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).not.toContain("\n");
    const p = sink.records()[0]?.p as string;
    expect(p.startsWith("/tmp/a?b?c/")).toBe(true);
    expect(p.length).toBe(1025);
    expect(recordOf({ p: f.path(7 as never) }).p).toBe("<invalid>");
  });
});

describe("URLs", () => {
  test("only the scheme and host are written", () => {
    const record = recordOf({
      ads: f.url(
        "https://api.adsabs.harvard.edu/v1/search/query?q=title%3A%22secret+topic%22&fl=bibcode"
      ),
      userinfo: f.url("https://ann:hunter2@example.org:8443/inbox/private?token=abc#frag"),
      object: f.url(new URL("http://127.0.0.1:1859/api/paper/some-doc")),
      mail: f.url("mailto:someone@example.org"),
      bad: f.url("not a url with private words"),
    });
    expect(record).toMatchObject({
      ads: "https://api.adsabs.harvard.edu",
      userinfo: "https://example.org:8443",
      object: "http://127.0.0.1:1859",
      mail: "mailto:",
      bad: "<invalid-url>",
    });
  });
});

describe("errors", () => {
  class Declared extends Error {
    static readonly [LOG_SAFE_MESSAGE] = true;
    constructor(message: string) {
      super(message);
      this.name = "Declared";
    }
  }
  class Inheriting extends Declared {
    constructor(message: string) {
      super(message);
      this.name = "Inheriting";
    }
  }

  test("the message of an error that does not declare it safe is not written — built-in errors included", () => {
    const secret = "SECRET-BODY-7f3a";
    for (const error of [
      new Error(`could not parse ${secret}`),
      new TypeError(`Cannot read properties of undefined (reading '${secret}')`),
      new RangeError(secret),
      (() => {
        try {
          JSON.parse(`{"note": ${secret}`);
        } catch (e) {
          return e as Error;
        }
        throw new Error("unreachable");
      })(),
    ]) {
      const { sink, log } = setup();
      log.error("test.happened", { error: f.error(error) });
      expect(sink.lines[0]).not.toContain("SECRET");
      const out = sink.records()[0]?.error as Record<string, unknown>;
      expect(out.name).toBe(error.name);
      expect(out.message).toBeUndefined();
      expect(Array.isArray(out.stack)).toBe(true);
    }
  });

  test("the message of a class that declares it safe is kept; a subclass has to declare it itself", () => {
    const kept = recordOf({ error: f.error(new Declared("the rev does not match")) })
      .error as Record<string, unknown>;
    expect(kept.name).toBe("Declared");
    expect(kept.message).toBe("the rev does not match");
    const dropped = recordOf({ error: f.error(new Inheriting("SECRET-9")) });
    expect(JSON.stringify(dropped)).not.toContain("SECRET");
  });

  test("a kept message still has the home directory replaced, no line breaks and a length limit", () => {
    const out = recordOf({
      error: f.error(new Declared(`cannot use /home/ann/x\nsecond line ${"y".repeat(600)}`)),
    }).error as { message: string };
    expect(out.message.startsWith("cannot use ~/x second line yyy")).toBe(true);
    expect(out.message.length).toBe(501);
  });

  test("the stack is file:line:column per frame: no first line, no function names, no home directory", () => {
    const error = new Error("SECRET-MSG multi\n    line message");
    error.stack = [
      "Error: SECRET-MSG multi",
      "    line message",
      "    at secretFunctionName (/home/ann/app/dist/bin.js:10:5)",
      "    at async Object.handler (file:///home/ann/app/dist/routes.js:20:7)",
      "    at /home/ann/app/dist/plain.js:3:1",
      "    at new Thing (node:internal/process/task_queues:95:5)",
      "    at Array.map (<anonymous>)",
      "    at something without a location",
    ].join("\n");
    const out = recordOf({ error: f.error(error) }).error as { stack: string[] };
    expect(out.stack).toEqual([
      "~/app/dist/bin.js:10:5",
      "~/app/dist/routes.js:20:7",
      "~/app/dist/plain.js:3:1",
      "node:internal/process/task_queues:95:5",
    ]);
  });

  test("a real stack points at this file, with nothing of the message in it", () => {
    const here = fileURLToPath(import.meta.url);
    const sink = createMemorySink();
    const log = createLogger({ events: EVENTS, sink, home: "/nonexistent-home" });
    log.error("test.happened", { error: f.error(new Error("SECRET-REAL")) });
    const out = sink.records()[0]?.error as { stack: string[] };
    expect(out.stack.length).toBeGreaterThan(0);
    expect(out.stack[0]).toMatch(
      new RegExp(`^${here.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\d+:\\d+$`)
    );
    expect(sink.lines[0]).not.toContain("SECRET");
  });

  test("code, system call and path of a system error are kept; the path loses the home directory", () => {
    const error = Object.assign(
      new Error("ENOENT: no such file or directory, open '/home/ann/s/x'"),
      {
        code: "ENOENT",
        syscall: "open",
        path: "/home/ann/s/x",
        errno: -2,
      }
    );
    const out = recordOf({ error: f.error(error) }).error as Record<string, unknown>;
    expect(out).toMatchObject({ name: "Error", code: "ENOENT", syscall: "open", path: "~/s/x" });
    expect(out.message).toBeUndefined();
    // `path` on an error that is not a system error may be a request path with a query: not written.
    const other = Object.assign(new Error("m"), { path: "/search?q=SECRET-QUERY" });
    expect(JSON.stringify(recordOf({ error: f.error(other) }))).not.toContain("SECRET");
  });

  test("a name or code that is not a plain token is not written", () => {
    const error = Object.assign(new Error("m"), { code: "a code with SECRET words" });
    error.name = "A name with SECRET words";
    const { sink, log } = setup();
    log.error("test.happened", { error: f.error(error) });
    expect(sink.lines[0]).not.toContain("SECRET");
    expect(sink.records()[0]).toMatchObject({ error: { name: "Error" } });
  });

  test("a cause is recorded the same way; a thrown non-error only by its kind", () => {
    const error = new Error("outer SECRET", { cause: new TypeError("inner SECRET") });
    const { sink, log } = setup();
    log.error("test.happened", { error: f.error(error), thrown: f.error("a SECRET string") });
    expect(sink.lines[0]).not.toContain("SECRET");
    const record = sink.records()[0] as { error: { cause: { name: string } }; thrown: unknown };
    expect(record.error.cause.name).toBe("TypeError");
    expect(record.thrown).toEqual({ name: "NonError", thrown: "string" });
  });
});

describe("log files", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 13, 8, minute, 0, 0));

  test("each run opens its own file in the directory, one JSON record per line", () => {
    const dir = join(tmp(), "global", "logs");
    const file = openLogFile({ dir, process: "serve", now: at(1), pid: 4242 });
    expect(file.path).toBe(join(dir, "20261013T080100000Z-serve-4242.jsonl"));
    const log = createLogger({ events: EVENTS, sink: file });
    log.info("test.happened", { n: f.num(1) });
    log.info("test.other");
    file.close();
    const lines = readFileSync(file.path as string, "utf8").split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("");
    expect(JSON.parse(lines[0] as string)).toMatchObject({ event: "test.happened", n: 1 });
    expect(JSON.parse(lines[1] as string)).toMatchObject({ event: "test.other" });
    if (process.platform !== "win32") {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(file.path as string).mode & 0o777).toBe(0o600);
    }
    // A second run does not touch the first one's file.
    const second = openLogFile({ dir, process: "serve", now: at(2), pid: 4243 });
    second.close();
    expect(readdirSync(dir).sort()).toEqual([
      "20261013T080100000Z-serve-4242.jsonl",
      "20261013T080200000Z-serve-4243.jsonl",
    ]);
  });

  test("opening keeps the newest 20 files, this run's included", () => {
    const dir = tmp();
    for (let i = 0; i < 25; i++) openLogFile({ dir, process: "serve", now: at(i), pid: 1 }).close();
    // Each open tidied as it went; make the excess again by hand to see one open remove it.
    for (let i = 30; i < 36; i++) {
      writeFileSync(join(dir, `20261013T08${i}00000Z-serve-1.jsonl`), "{}\n");
    }
    writeFileSync(join(dir, "notes.txt"), "not a log file");
    const file = openLogFile({ dir, process: "serve", now: at(40), pid: 1 });
    file.close();
    const names = readdirSync(dir)
      .filter((n) => n.endsWith(".jsonl"))
      .sort();
    expect(names).toHaveLength(20);
    expect(names.at(-1)).toBe("20261013T084000000Z-serve-1.jsonl");
    // The 19 newest older ones stay: minutes 35..30 and 24..12.
    expect(names[0]).toBe("20261013T081200000Z-serve-1.jsonl");
    expect(readdirSync(dir)).toContain("notes.txt");
  });

  test("opening keeps only as many of the newest files as fit in the total size", () => {
    const dir = tmp();
    const kb = "x".repeat(1023);
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, `20261013T080${i}00000Z-serve-1.jsonl`), `${kb}\n`);
    }
    // 5 files of 1 KiB and a limit of 2.5 KiB: the new (empty) file and the two newest old ones fit.
    const file = openLogFile({ dir, process: "serve", now: at(9), pid: 1, maxTotalBytes: 2560 });
    file.close();
    expect(readdirSync(dir).sort()).toEqual([
      "20261013T080300000Z-serve-1.jsonl",
      "20261013T080400000Z-serve-1.jsonl",
      "20261013T080900000Z-serve-1.jsonl",
    ]);
  });

  test("the count limit and the size limit each apply on their own", () => {
    const dir = tmp();
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(dir, `20261013T080${i}00000Z-serve-1.jsonl`), "x".repeat(100));
    }
    pruneLogDir(dir, { keepFiles: 4, maxTotalBytes: 1_000_000 });
    expect(readdirSync(dir)).toHaveLength(4);
    pruneLogDir(dir, { keepFiles: 100, maxTotalBytes: 250 });
    expect(readdirSync(dir).sort()).toEqual([
      "20261013T080400000Z-serve-1.jsonl",
      "20261013T080500000Z-serve-1.jsonl",
    ]);
  });

  test("this run's file is never tidied away, and one run stops growing at the total size", () => {
    const dir = tmp();
    const file = openLogFile({ dir, process: "serve", now: at(1), pid: 1, maxTotalBytes: 100 });
    for (let i = 0; i < 50; i++) file.write("0123456789");
    file.close();
    expect(statSync(file.path as string).size).toBe(99);
    // A newer start by another process, with this one's file larger than the limit: it is the other one's to keep.
    pruneLogDir(dir, { maxTotalBytes: 10, current: "20261013T080100000Z-serve-1.jsonl" });
    expect(readdirSync(dir)).toEqual(["20261013T080100000Z-serve-1.jsonl"]);
  });

  test("a directory that cannot be made costs the records, not the caller", () => {
    const root = tmp();
    writeFileSync(join(root, "blocker"), "a file where the directory should be");
    const file = openLogFile({ dir: join(root, "blocker", "logs"), process: "serve" });
    expect(file.path).toBeNull();
    const log = createLogger({ events: EVENTS, sink: file });
    expect(() => log.error("test.happened", { n: f.num(1) })).not.toThrow();
    expect(() => file.close()).not.toThrow();
    expect(() => pruneLogDir(join(root, "nowhere"))).not.toThrow();
  });

  test("a file that goes away while the process runs costs the records, not the caller", () => {
    const dir = tmp();
    const file = openLogFile({ dir, process: "serve", now: at(1), pid: 1 });
    file.close();
    expect(() => file.write("{}")).not.toThrow();
  });

  test("the log directory is `logs` below the global data directory", () => {
    expect(resolveLogDir({ config: { global_dir: "/srv/global" } })).toBe(
      join("/srv/global", "logs")
    );
  });
});
