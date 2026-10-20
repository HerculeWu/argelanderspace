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
import * as infra from "../src/index.js";
import {
  createLogger,
  discardSink,
  f,
  installProcessLogging,
  LOG_KEEP_FILES,
  LOG_MAX_TOTAL_BYTES,
  LOG_SAFE_MESSAGE,
  type LogField,
  type LogFields,
  type LogFieldTable,
  openLogFile,
  pruneLogDir,
  resolveLogDir,
} from "../src/log/index.js";
import { createMemorySink } from "./log-memory-sink.js";

const HOME = "/home/ann";
/**
 * Most tests here name their fields freely, so their events take a field table that does not list its names (any name,
 * any kind). The checks on listed names and kinds are in "what the types refuse", on a table that lists them.
 */
const ANY_FIELDS: LogFieldTable = {};
const EVENTS = { "test.happened": ANY_FIELDS, "test.other": ANY_FIELDS } as const;

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
    log.info(`paper ${title} failed` as never, { doc: f.id("x") } as never);
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
      createLogger({ events: { "Paper failed: title": {} }, sink: createMemorySink() })
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
    expect(() => createLogger({ events: { [runtimeText]: {} }, sink })).toThrow(TypeError);
    // And what got past the types at run time said nothing.
    expect(sink.lines.join("")).not.toContain("something the user wrote");
  });

  // An event's fields are the names its table lists, each made by the constructor listed for it. A name outside the
  // table is refused wherever it comes from: written in the call, in an object built beforehand, spread in from one,
  // or in one branch of a conditional spread; and so is a field of another kind.
  const TYPED = {
    "test.typed": { path: f.path, code: f.id, duration_ms: f.ms, log_file: [f.id, f.oneOf] },
    "test.failed": { error: f.error },
  } as const;

  test("a field name the event's table does not list, or a field of another kind", () => {
    const sink = createMemorySink();
    const log = createLogger({ events: TYPED, sink, home: HOME });
    const flag = sink.lines.length === 0;
    // What the table lists, however it is put together, is accepted.
    log.info("test.typed", { path: f.path("/srv/a"), code: f.id("c1") });
    const built = { path: f.path("/srv/b"), ...(flag ? { code: f.id("c2") } : {}) };
    log.info("test.typed", built);
    log.info("test.typed", { ...built, duration_ms: f.ms(1) });
    const elapsed: LogField<"ms"> | undefined = flag ? f.ms(2) : undefined;
    log.info("test.typed", { duration_ms: elapsed });
    log.info("test.typed", { log_file: flag ? f.id("jobs/x") : f.oneOf(["fixed"], "fixed") });
    log.error("test.failed", { error: f.error(new Error("x")) });
    log.info("test.failed");

    // @ts-expect-error a misspelt name, written in the call
    log.info("test.typed", { pth: f.path("/srv/c") });
    const misspelt = { path: f.path("/srv/d"), pth: f.path("/srv/d") };
    // @ts-expect-error a misspelt name, in an object built beforehand
    log.info("test.typed", misspelt);
    const base = { path: f.path("/srv/e"), cdoe: f.id("c3") };
    // @ts-expect-error a misspelt name, spread in from an object built beforehand
    log.info("test.typed", { ...base, duration_ms: f.ms(3) });
    // @ts-expect-error a misspelt name in one branch of a conditional spread
    log.info("test.typed", { path: f.path("/srv/f"), ...(flag ? { cdoe: f.id("c4") } : {}) });
    // @ts-expect-error a misspelt name in one branch, a listed one in the other
    log.info("test.typed", {
      path: f.path("/srv/f"),
      ...(flag ? { cdoe: f.id("c5") } : { code: f.id("c5") }),
    });
    // @ts-expect-error a name of another event of the same logger
    log.info("test.typed", { error: f.error(new Error("y")) });
    // @ts-expect-error not an event of this logger
    log.info("test.untyped", { path: f.path("/srv/g") });
    // @ts-expect-error a path field made by another constructor
    log.info("test.typed", { path: f.id("/srv/h") });
    // @ts-expect-error a duration made as a plain number
    log.info("test.typed", { duration_ms: f.num(4) });
    // @ts-expect-error a field of a kind neither of its constructors makes
    log.info("test.typed", { log_file: f.path("/srv/i") });
    const unlisted: Record<string, LogField> = { path: f.path("/srv/j") };
    // @ts-expect-error fields whose names are not known
    log.info("test.typed", unlisted);

    // The types add to the run-time checks; they replace none: a name the table does not list is still written when
    // its value is a field, and a value that is not a field is still dropped and counted.
    expect(sink.records().at(-11)).toMatchObject({ event: "test.typed", pth: "/srv/c" });
    expect(sink.records().at(-1)).toMatchObject({ event: "test.typed", path: "/srv/j" });
  });

  test("the process watch takes only events whose table has an error field", () => {
    const log = createLogger({ events: TYPED, sink: discardSink });
    installProcessLogging(log, {
      uncaughtException: "test.failed",
      unhandledRejection: "test.failed",
    })();
    installProcessLogging(log, {
      // @ts-expect-error `test.typed` has no `error` field
      uncaughtException: "test.typed",
      unhandledRejection: "test.failed",
    })();
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
    });
    expect(record).toMatchObject({
      project: "~/research/halos",
      home: "~",
      elsewhere: "/srv/data/literatures",
      sibling: "/home/anna/notes",
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
    expect(recordOf({ p: f.path(7 as never) }).p).toBe("<invalid-path>");
  });

  test("only an absolute path is a path: text, a relative path or a bare name is not written", () => {
    const record = recordOf({
      title: f.path("This is the title of a paper, plainly not a path"),
      relative: f.path("literatures/output"),
      dotted: f.path("./notes/private.md"),
      name: f.path("private-notes.md"),
      sentence: f.path("see /home/ann/secret for the draft"),
      empty: f.path(""),
      posix: f.path("/srv/data"),
      windows: f.path("D:\\data\\lit"),
      windows_slash: f.path("D:/data/lit"),
      unc: f.path("\\\\server\\share\\x"),
      tilde: f.path("~/research"),
      tilde_alone: f.path("~"),
      tilde_name: f.path("~title of something"),
    });
    for (const key of ["title", "relative", "dotted", "name", "sentence", "empty", "tilde_name"]) {
      expect(record[key], key).toBe("<invalid-path>");
    }
    expect(record).toMatchObject({
      posix: "/srv/data",
      windows: "D:\\data\\lit",
      windows_slash: "D:/data/lit",
      unc: "\\\\server\\share\\x",
      tilde: "~/research",
      tilde_alone: "~",
    });
  });

  test("bidi controls and marks cannot reorder what a path shows", () => {
    const marks = [
      0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068,
      0x2069,
    ];
    for (const code of marks) {
      const ch = String.fromCharCode(code);
      const { sink, log } = setup();
      log.info("test.happened", { p: f.path(`/tmp/a${ch}b`) });
      expect(sink.lines[0], code.toString(16)).not.toContain(ch);
      expect(sink.records()[0]?.p).toBe("/tmp/a?b");
    }
  });
});

describe("a path segment that is a Work or Doc id made from a title or a folder name", () => {
  const docHash = (id: string) => recordOf({ d: f.docId(id) }).d as string;
  const workHash = (id: string) => recordOf({ w: f.workId(id) }).w as string;
  const uuid = "3f2b8c1e-9a4d-4e7f-8b21-0c5d6e7f8a9b";

  test("is written as the hash the identifier fields write, with the extension kept", () => {
    const latex = "latex-MyPrivateThesisTitle";
    const upload = "upload-work-attention-is-all-you-need-2017-a1b2c3";
    const { sink, log } = setup();
    log.info("test.happened", {
      ir: f.path(`/srv/lit/output/${latex}/${latex}.json`),
      annot: f.path(`/home/ann/lit/annotations/${latex}/current.json`),
      up: f.path(`/srv/lit/output/${upload}/${upload}.json`),
      temp: f.path(`/srv/lit/output/${upload}/${upload}.json.tmp-${uuid}`),
      last: f.path(`/srv/lit/output/${latex}`),
    });
    const record = sink.records()[0] as Record<string, string>;
    expect(docHash(latex)).toMatch(/^latex-#[0-9a-f]{12}$/);
    expect(docHash(upload)).toMatch(/^upload-#[0-9a-f]{12}$/);
    expect(record).toMatchObject({
      ir: `/srv/lit/output/${docHash(latex)}/${docHash(latex)}.json`,
      annot: `~/lit/annotations/${docHash(latex)}/current.json`,
      up: `/srv/lit/output/${docHash(upload)}/${docHash(upload)}.json`,
      temp: `/srv/lit/output/${docHash(upload)}/${docHash(upload)}.json.tmp-${uuid}`,
      last: `/srv/lit/output/${docHash(latex)}`,
    });
    expect(sink.lines[0]).not.toMatch(/Private|Thesis|attention|you-need/i);
  });

  test("a Work id in a file name is recognized through its URL encoding", () => {
    const id = "work:attention-is-all-you-need-2017";
    const { sink, log } = setup();
    log.info("test.happened", {
      encoded: f.path("/srv/lit/argument-graphs/work%3Aattention-is-all-you-need-2017.json"),
      lower_hex: f.path("/srv/lit/argument-graphs/work%3aattention-is-all-you-need-2017.json"),
      literal: f.path("/srv/lit/argument-graphs/work:attention-is-all-you-need-2017.json"),
      doi_text: f.path("/srv/lit/argument-graphs/doi%3Aa-title-typed-where-a-doi-goes.json"),
    });
    const record = sink.records()[0] as Record<string, string>;
    expect(workHash(id)).toMatch(/^work:#[0-9a-f]{12}$/);
    expect(record.encoded).toBe(`/srv/lit/argument-graphs/${workHash(id)}.json`);
    expect(record.lower_hex).toBe(record.encoded);
    expect(record.literal).toBe(record.encoded);
    expect(record.doi_text).toBe(
      `/srv/lit/argument-graphs/${workHash("doi:a-title-typed-where-a-doi-goes")}.json`
    );
    expect(sink.lines[0]).not.toMatch(/attention|you-need|typed/);
  });

  test("Windows separators, another spelling of the prefix, an unknown extension", () => {
    const { sink, log } = setup();
    log.info("test.happened", {
      win: f.path("C:\\lit\\output\\latex-MyPrivateThesisTitle\\latex-MyPrivateThesisTitle.json"),
      upper: f.path("/srv/lit/output/LaTeX-MyPrivateThesisTitle/x.json"),
      upper_work: f.path("/srv/lit/argument-graphs/WORK%3AMyPrivateThesisTitle.json"),
      // Not an extension the workbench writes: it may be part of the folder's name, so it is hashed with it.
      dotted: f.path("/srv/lit/output/latex-My.PrivateThesisTitle"),
      bad_escape: f.path("/srv/lit/output/latex-MyPrivateThesisTitle%ZZ/x"),
    });
    const record = sink.records()[0] as Record<string, string>;
    const hash = docHash("latex-MyPrivateThesisTitle");
    expect(record.win).toBe(`C:\\lit\\output\\${hash}\\${hash}.json`);
    expect(record.upper).toMatch(/^\/srv\/lit\/output\/doc-#[0-9a-f]{12}\/x\.json$/);
    expect(record.upper_work).toMatch(/^\/srv\/lit\/argument-graphs\/work:#[0-9a-f]{12}\.json$/);
    expect(record.dotted).toBe(`/srv/lit/output/${docHash("latex-My.PrivateThesisTitle")}`);
    expect(record.bad_escape).toMatch(/^\/srv\/lit\/output\/latex-#[0-9a-f]{12}\/x$/);
    expect(sink.lines[0]).not.toMatch(/Private|Thesis/i);
  });

  test("an id that the identifier fields write as it is, and every ordinary folder name, stays as it is", () => {
    const paths = [
      "/srv/lit/output/arxiv-2101.00001/arxiv-2101.00001.json",
      "/srv/lit/output/arxiv-astro-ph-0601001/arxiv-astro-ph-0601001.json",
      `/srv/lit/output/pdf-${uuid}/pdf-${uuid}.json`,
      `/srv/lit/output/text-${uuid}/text-source.json`,
      "/srv/lit/output/upload-arxiv-2603-03522-0f9e8d/upload-arxiv-2603-03522-0f9e8d.json",
      "/srv/lit/output/upload-doi-10-1016-s0370-2693-99-00123-4-a1b2c3/assets/fig.pdf",
      `/srv/lit/jobs/upload-${uuid}.json`,
      "/srv/lit/argument-graphs/doi%3A10%2E1016%2Fs0370-2693%2899%2900123-4.json",
      "/srv/lit/argument-graphs/arxiv%3A2603%2E03522.json",
      "/srv/lit/argument-graphs/openalex%3AW2741809807.json",
      "/srv/app/node_modules/pdf-lib/dist/index.js",
      "/srv/research/latex/workspace/uploads/work/main.tex",
      "/srv/my%20notes/100%/x",
      "C:\\Program Files\\Argelander\\resources\\app.js",
    ];
    for (const path of paths) expect(recordOf({ p: f.path(path) }).p, path).toBe(path);
  });

  test("the same in the path of a system error, in its cause, and in a stack frame", () => {
    const latex = "latex-MyPrivateThesisTitle";
    const file = `/home/ann/lit/output/${latex}/${latex}.json`;
    const system = () =>
      Object.assign(new Error(`EACCES: permission denied, open '${file}'`), {
        code: "EACCES",
        syscall: "open",
        path: file,
      });
    const outer = new Error("could not read the document", { cause: system() });
    outer.stack = `Error: could not read the document\n    at load (${file}:3:4)\n    at async file:///home/ann/lit/output/${latex}/x.js:5:6`;
    const { sink, log } = setup();
    log.error("test.happened", { direct: f.error(system()), outer: f.error(outer) });
    const hash = docHash(latex);
    const written = `~/lit/output/${hash}/${hash}.json`;
    const record = sink.records()[0] as Record<
      string,
      { path?: string; stack: string[]; cause?: { path: string } }
    >;
    expect(record.direct?.path).toBe(written);
    expect(record.outer?.cause?.path).toBe(written);
    expect(record.outer?.stack).toEqual([`${written}:3:4`, `~/lit/output/${hash}/x.js:5:6`]);
    expect(sink.lines[0]).not.toMatch(/Private|Thesis/);
  });
});

describe("an error whose system path is left out (`omitSystemPath`)", () => {
  const file = "/home/ann/papers/PRIVATE Thesis Title/main.tex";
  const system = () =>
    Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), {
      code: "ENOENT",
      syscall: "open",
      path: file,
    });

  test("name, code, system call and stack are written; the path is not — in the error or in any cause", () => {
    const inner = system();
    const middle = new Error("PRIVATE middle", { cause: inner });
    const outer = new TypeError("PRIVATE outer", { cause: middle });
    const { sink, log } = setup();
    log.error("test.happened", {
      direct: f.error(system(), { omitSystemPath: true }),
      outer: f.error(outer, { omitSystemPath: true }),
    });
    const record = sink.records()[0] as Record<string, Record<string, unknown>>;
    expect(Object.keys(record.direct ?? {}).sort()).toEqual(["code", "name", "stack", "syscall"]);
    expect(record.direct).toMatchObject({ name: "Error", code: "ENOENT", syscall: "open" });
    expect(record.direct?.stack).not.toEqual([]);
    const middleCause = record.outer?.cause as { cause: Record<string, unknown> } | undefined;
    const cause = middleCause?.cause ?? {};
    expect(Object.keys(cause).sort()).toEqual(["code", "name", "stack", "syscall"]);
    expect(record.outer).toMatchObject({ name: "TypeError", cause: { name: "Error" } });
    expect(sink.lines[0]).not.toMatch(/PRIVATE|Thesis|papers/);
  });

  test("the option only takes away: without it the same error is written with its path, as before", () => {
    const withPath = recordOf({ error: f.error(system()) }).error as Record<string, unknown>;
    const without = recordOf({ error: f.error(system(), { omitSystemPath: false }) })
      .error as Record<string, unknown>;
    expect(Object.keys(withPath).sort()).toEqual(["code", "name", "path", "stack", "syscall"]);
    expect(Object.keys(without).sort()).toEqual(Object.keys(withPath).sort());
    const less = recordOf({ error: f.error(system(), { omitSystemPath: true }) }).error as Record<
      string,
      unknown
    >;
    for (const key of Object.keys(less)) expect(Object.keys(withPath)).toContain(key);
  });
});

describe("characters that do not show", () => {
  const invisible = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad];

  test("zero-width characters and the soft hyphen are replaced in a path", () => {
    for (const code of invisible) {
      const ch = String.fromCharCode(code);
      const { sink, log } = setup();
      log.info("test.happened", { p: f.path(`/tmp/a${ch}b`) });
      expect(sink.lines[0], code.toString(16)).not.toContain(ch);
      expect(sink.records()[0]?.p, code.toString(16)).toBe("/tmp/a?b");
    }
  });

  test("and in a message that is kept", () => {
    class Kept extends Error {
      static readonly [LOG_SAFE_MESSAGE] = true;
    }
    for (const code of invisible) {
      const ch = String.fromCharCode(code);
      const out = recordOf({ error: f.error(new Kept(`left${ch}right`)) }).error as {
        message: string;
      };
      expect(out.message, code.toString(16)).toBe("left right");
    }
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

  test("schemes without a host keep the scheme alone; an IPv6 host keeps its brackets", () => {
    expect(
      recordOf({
        data: f.url("data:text/plain;base64,U0VDUkVU"),
        blob: f.url("blob:https://example.org/7f3a-SECRET"),
        file: f.url("file:///home/ann/SECRET/notes.txt"),
        v6: f.url("http://[::1]:1859/api/SECRET"),
        imap: f.url("imaps://ann:pw@imap.example.org:993/INBOX"),
      })
    ).toMatchObject({
      data: "data:",
      blob: "blob:",
      file: "file:",
      v6: "http://[::1]:1859",
      imap: "imaps://imap.example.org:993",
    });
  });

  test("text shaped like `word:rest` is not a URL: the word is not written as a scheme", () => {
    const { sink, log } = setup();
    log.info("test.happened", {
      a: f.url("dark.matter:halo mass"),
      b: f.url("Abstract:we study SECRET things"),
      c: f.url("secretword://another.secretword/x"),
      d: f.url(42 as never),
      e: f.url({ toString: () => "https://example.org" } as never),
    });
    expect(sink.records()[0]).toMatchObject({
      a: "<invalid-url>",
      b: "<invalid-url>",
      c: "<invalid-url>",
      d: "<invalid-url>",
      e: "<invalid-url>",
    });
    expect(sink.lines[0]).not.toMatch(/dark|matter|abstract|secret/i);
  });

  test("a host has a length limit", () => {
    const label = "a".repeat(60);
    const long = Array.from({ length: 6 }, () => label).join(".");
    expect(recordOf({ u: f.url(`https://${long}.example.org/x`) }).u).toBe("<invalid-url>");
    const ok = `${label}.${label}.example.org`;
    expect(recordOf({ u: f.url(`https://${ok}/x`) }).u).toBe(`https://${ok}`);
  });
});

describe("Work and Doc identifiers", () => {
  const HASHED_WORK = /^work:#[0-9a-f]{12}$/;

  test("a Work id made of a DOI, an arXiv number or an OpenAlex number is written as it is", () => {
    expect(
      recordOf({
        doi: f.workId("doi:10.1016/s0370-2693(99)00123-4"),
        arxiv: f.workId("arxiv:2603.03522"),
        arxiv_old: f.workId("arxiv:astro-ph/0601001"),
        openalex: f.workId("openalex:W2741809807"),
      })
    ).toMatchObject({
      doi: "doi:10.1016/s0370-2693(99)00123-4",
      arxiv: "arxiv:2603.03522",
      arxiv_old: "arxiv:astro-ph/0601001",
      openalex: "openalex:W2741809807",
    });
  });

  test("an old-style arXiv number is written as it is whatever its archive is called", () => {
    const works = [
      "arxiv:q-bio/0401001",
      "arxiv:q-alg/9701001",
      "arxiv:hep-th/9901001",
      "arxiv:math.ag/0601001",
      "arxiv:cs/0112017",
      "arxiv:alg-geom/9202004",
      "arxiv:funct-an/9301001",
    ];
    for (const id of works) expect(recordOf({ w: f.workId(id) }).w, id).toBe(id);
    const docs = [
      "arxiv-q-bio-0401001",
      "arxiv-q-alg-9701001v2",
      "arxiv-math.AG-0601001",
      "arxiv-cs-0112017",
      "upload-arxiv-q-bio-0401001-a1b2c3",
      "upload-arxiv-q-alg-9701001-a1b2c3",
      "upload-arxiv-math-ag-0601001-a1b2c3",
      "upload-arxiv-cs-0112017-a1b2c3",
    ];
    for (const id of docs) {
      expect(recordOf({ d: f.docId(id) }).d, id).toBe(id);
      expect(recordOf({ d: f.id(id) }).d, id).toBe(id);
    }
    // A real DOI with characters an identifier may not have is hashed: the safe side of the rule.
    expect(
      recordOf({
        w: f.workId("doi:10.1002/(sici)1097-4571(199601)47:1<23::aid-asi3>3.0.co;2-p"),
      }).w
    ).toMatch(HASHED_WORK);
    // Still not an arXiv number: no seven digits where the number goes.
    expect(recordOf({ w: f.workId("arxiv:secret-title/words") }).w).toMatch(HASHED_WORK);
    expect(recordOf({ d: f.docId("arxiv-secret-folder-name") }).d).toMatch(/^doc-#/);
    expect(recordOf({ d: f.docId("upload-arxiv-secret-title-a1b2c3") }).d).toMatch(/^upload-#/);
  });

  test("a Work id made from a title is written as a hash, the same one every time", () => {
    const id = "work:dark-matter-halos-in-the-early-universe-2024";
    const { sink, log } = setup();
    log.info("test.happened", { work: f.workId(id) });
    log.info("test.other", { work: f.workId(id), other: f.workId(`${id}x`) });
    const [first, second] = sink.records() as Array<Record<string, string>>;
    expect(first?.work).toMatch(HASHED_WORK);
    expect(second?.work).toBe(first?.work);
    expect(second?.other).toMatch(HASHED_WORK);
    expect(second?.other).not.toBe(first?.work);
    expect(sink.lines.join("")).not.toMatch(/dark|matter|halos|universe|2024/);
    // Another logger (another run) writes the same thing: nothing about the run goes into the hash.
    const again = createMemorySink();
    createLogger({ events: EVENTS, sink: again, home: "/elsewhere" }).info("test.happened", {
      work: f.workId(id),
    });
    expect(again.records()[0]?.work).toBe(first?.work);
  });

  test("anything that is not one of the three known shapes is hashed, whatever it claims to be", () => {
    const record = recordOf({
      doi_text: f.workId("doi:a-title-typed-where-a-doi-goes"),
      doi_spaces: f.workId("doi:10.1234/with spaces SECRET"),
      arxiv_text: f.workId("arxiv:secret-title-words"),
      openalex_text: f.workId("openalex:secretwords"),
      bare: f.workId("A Title Passed By Mistake"),
      empty: f.workId(""),
      long: f.workId(`doi:10.1234/${"x".repeat(200)}`),
    });
    for (const key of Object.keys(record).filter((k) => !["t", "level", "event"].includes(k))) {
      expect(record[key], key).toMatch(HASHED_WORK);
    }
    expect(recordOf({ w: f.workId(42 as never) }).w).toBe("<invalid-id>");
  });

  test("a Doc id made of an arXiv number or a random number is written as it is", () => {
    const uuid = "3f2b8c1e-9a4d-4e7f-8b21-0c5d6e7f8a9b";
    expect(
      recordOf({
        arxiv: f.docId("arxiv-2501.17225"),
        arxiv_old: f.docId("arxiv-astro-ph-0601001"),
        pdf: f.docId(`pdf-${uuid}`),
        text: f.docId(`text-${uuid}`),
        upload_doi: f.docId("upload-doi-10-1016-s0370-2693-99-00123-4-a1b2c3"),
        upload_arxiv: f.docId("upload-arxiv-2603-03522-0f9e8d"),
        upload_openalex: f.docId("upload-openalex-w2741809807-abcdef"),
      })
    ).toMatchObject({
      arxiv: "arxiv-2501.17225",
      arxiv_old: "arxiv-astro-ph-0601001",
      pdf: `pdf-${uuid}`,
      text: `text-${uuid}`,
      upload_doi: "upload-doi-10-1016-s0370-2693-99-00123-4-a1b2c3",
      upload_arxiv: "upload-arxiv-2603-03522-0f9e8d",
      upload_openalex: "upload-openalex-w2741809807-abcdef",
    });
  });

  test("a Doc id made from a title or a folder name is written as a hash that keeps only the kind", () => {
    const { sink, log } = setup();
    log.info("test.happened", {
      latex: f.docId("latex-my-secret-thesis-draft"),
      upload: f.docId("upload-work-dark-matter-halos-in-the-early-univ-a1b2c3"),
      arxiv_text: f.docId("arxiv-secret-folder-name"),
      pdf_text: f.docId("pdf-secret-file-name"),
      other: f.docId("secret-folder"),
      same: f.docId("latex-my-secret-thesis-draft"),
    });
    const record = sink.records()[0] as Record<string, string>;
    expect(record.latex).toMatch(/^latex-#[0-9a-f]{12}$/);
    expect(record.upload).toMatch(/^upload-#[0-9a-f]{12}$/);
    expect(record.arxiv_text).toMatch(/^doc-#[0-9a-f]{12}$/);
    expect(record.pdf_text).toMatch(/^doc-#[0-9a-f]{12}$/);
    expect(record.other).toMatch(/^doc-#[0-9a-f]{12}$/);
    expect(record.same).toBe(record.latex);
    expect(sink.lines[0]).not.toMatch(/secret|thesis|dark|matter|halos/);
    expect(recordOf({ d: f.docId(null as never) }).d).toBe("<invalid-id>");
  });

  test("the plain identifier field does not write a title-made id either; a job id is still an id", () => {
    const uuid = "3f2b8c1e-9a4d-4e7f-8b21-0c5d6e7f8a9b";
    const { sink, log } = setup();
    log.info("test.happened", {
      work: f.id("work:dark-matter-halos-2024"),
      latex: f.id("latex-my-secret-thesis"),
      upload: f.id("upload-work-dark-matter-halos-a1b2c3"),
      list: f.ids(["work:dark-matter-halos-2024", "arxiv:2603.03522"]),
      job: f.id(`upload-${uuid}`),
      ingest: f.id(`ingest-${uuid}`),
    });
    const record = sink.records()[0] as Record<string, unknown>;
    expect(record.work).toBe(recordOf({ w: f.workId("work:dark-matter-halos-2024") }).w);
    expect(record.latex).toBe(recordOf({ d: f.docId("latex-my-secret-thesis") }).d);
    expect(record.upload).toMatch(/^upload-#[0-9a-f]{12}$/);
    expect(record.list).toEqual([record.work, "arxiv:2603.03522"]);
    expect(record.job).toBe(`upload-${uuid}`);
    expect(record.ingest).toBe(`ingest-${uuid}`);
    expect(sink.lines[0]).not.toMatch(/secret|thesis|dark|matter|halos/);
  });
});

describe("what production code can import", () => {
  test("the memory sink is a test helper, not an export of the package", () => {
    expect("createMemorySink" in infra).toBe(false);
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

  test("a line of the message that looks like a stack frame is not written as one", () => {
    const { sink, log } = setup();
    log.error("test.happened", {
      error: f.error(
        new Error("compile failed\n    at /Dear Bob the secret mail body is here:1:2")
      ),
      type_error: f.error(new TypeError("x\n    at fn (/SECRET/one:3:4)\n    at /SECRET/two:5:6")),
    });
    expect(sink.lines[0]).not.toMatch(/Dear Bob|secret|SECRET/);
    const record = sink.records()[0] as Record<string, { stack: string[] }>;
    // The real frames are still there.
    expect(record.error?.stack.length).toBeGreaterThan(0);
    expect(record.error?.stack[0]).toContain("log.test.ts");
    expect(record.type_error?.stack[0]).toContain("log.test.ts");
  });

  test("the frames survive a class that names itself, an empty message and a Node error code in the first line", () => {
    const here = /log\.test\.ts:\d+:\d+$/;
    const named = recordOf({ error: f.error(new Declared("SECRET\n    at /SECRET/x:1:2")) })
      .error as { stack: string[] };
    expect(named.stack[0]).toMatch(here);
    expect(JSON.stringify(named.stack)).not.toContain("SECRET");
    const empty = recordOf({ error: f.error(new RangeError()) }).error as { stack: string[] };
    expect(empty.stack[0]).toMatch(here);
    let coded: unknown;
    try {
      readFileSync({} as never);
    } catch (e) {
      coded = e;
    }
    const node = recordOf({ error: f.error(coded) }).error as { code: string; stack: string[] };
    expect(node.code).toBe("ERR_INVALID_ARG_TYPE");
    expect(node.stack.length).toBeGreaterThan(0);
  });

  test("a stack whose first line cannot be told from the message is not written at all", () => {
    const secretFrame = "    at /SECRET/frame:1:2";
    // The message was changed after the stack was made: where the old message ends is unknown.
    const changed = new Error(`old message\n${secretFrame}`);
    // The text of the stack, first line included, is made when `stack` is first read (Node 24): reading it here
    // is what fixes "old message" in it, and the change below no longer reaches it.
    expect(changed.stack).toContain("old message");
    changed.message = "new message";
    // The stack was replaced by something that does not start the way V8 starts one.
    const replaced = new Error("m");
    replaced.stack = `whatever\n${secretFrame}`;
    // A name with a line of its own.
    const renamed = new Error("");
    renamed.name = `Odd\n${secretFrame}`;
    Error.captureStackTrace(renamed);
    const notText = new Error("m");
    (notText as { stack: unknown }).stack = [secretFrame];
    const noMessage = new Error("m");
    (noMessage as { message: unknown }).message = { text: "m" };
    for (const error of [changed, replaced, renamed, notText, noMessage]) {
      const { sink, log } = setup();
      log.error("test.happened", { error: f.error(error) });
      expect(sink.lines[0]).not.toContain("SECRET");
      expect(sink.records()[0]).toMatchObject({ error: { stack: [] } });
      expect((sink.records()[0] as { error: { stack: unknown[] } }).error.stack).toHaveLength(0);
    }
  });

  test("a kept message loses bidi controls", () => {
    const out = recordOf({ error: f.error(new Declared("left\u202eright\u2066x\u200f")) })
      .error as { message: string };
    expect(out.message).toBe("left right x ");
  });

  test("a system error's path follows the path rule", () => {
    const relative = Object.assign(new Error("ENOENT"), {
      code: "ENOENT",
      syscall: "open",
      path: "private notes/SECRET.md",
    });
    const out = recordOf({ error: f.error(relative) }).error as Record<string, unknown>;
    expect(out.path).toBe("<invalid-path>");
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

  test("a code that has the shape of a title-made id is written the way the identifier field writes it", () => {
    const codes = [
      "work:my-private-title-2020",
      "latex-my-private-title",
      "upload-work-my-private-title-a1b2c3",
    ];
    for (const code of codes) {
      const { sink, log } = setup();
      log.error("test.happened", {
        error: f.error(Object.assign(new Error("m"), { code })),
        same: f.id(code),
      });
      const record = sink.records()[0] as { error: { code: string }; same: string };
      expect(sink.lines[0], code).not.toMatch(/private|title/);
      expect(record.error.code, code).toBe(record.same);
      expect(record.error.code, code).toMatch(/^(?:work:|latex-|upload-)#[0-9a-f]{12}$/);
    }
    const plain = Object.assign(new Error("m"), { code: "ERR_MODULE_NOT_FOUND" });
    expect(recordOf({ error: f.error(plain) }).error).toMatchObject({
      code: "ERR_MODULE_NOT_FOUND",
    });
    const numeric = Object.assign(new Error("m"), { code: 11 });
    expect(recordOf({ error: f.error(numeric) }).error).toMatchObject({ code: 11 });
  });

  test("a frame without a function name is a frame, awaited or not; a line without a place is none", () => {
    const error = new Error("m");
    error.stack = [
      "Error: m",
      "    at async /home/ann/app/dist/anonymous.js:5:6",
      "    at async file:///home/ann/app/dist/module.js:7:8",
      "    at async C:\\app\\dist\\win.js:9:10",
      "    at new Foo (/home/ann/app/dist/foo.js:1:2)",
      "    at async Promise.all (index 0)",
      "    at <anonymous>",
      "    at async secretName (/home/ann/app/dist/named.js:3:4)",
      "    at async node:internal/process/task_queues:95:5",
    ].join("\n");
    const { sink, log } = setup();
    log.error("test.happened", { error: f.error(error) });
    expect((sink.records()[0] as { error: { stack: string[] } }).error.stack).toEqual([
      "~/app/dist/anonymous.js:5:6",
      "~/app/dist/module.js:7:8",
      "C:\\app\\dist\\win.js:9:10",
      "~/app/dist/foo.js:1:2",
      "~/app/dist/named.js:3:4",
      "node:internal/process/task_queues:95:5",
    ]);
    expect(sink.lines[0]).not.toMatch(/async|Foo|secretName|Promise|anonymous>/);
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

  test("the default limits are 20 files and 50 MB", () => {
    expect(LOG_KEEP_FILES).toBe(20);
    expect(LOG_MAX_TOTAL_BYTES).toBe(50 * 1024 * 1024);
    // And the default is what a run without options stops at.
    const dir = tmp();
    const file = openLogFile({ dir, process: "serve", now: at(1), pid: 1 });
    const mib = "x".repeat(1024 * 1024 - 1);
    for (let i = 0; i < 52; i++) file.write(mib);
    file.close();
    const size = statSync(file.path as string).size;
    expect(size).toBeLessThanOrEqual(50 * 1024 * 1024);
    expect(size).toBeGreaterThan(49 * 1024 * 1024);
  });

  test("a run that reaches the size limit writes one last record saying so, and then nothing", () => {
    const dir = tmp();
    const file = openLogFile({ dir, process: "serve", now: at(1), pid: 1, maxTotalBytes: 300 });
    const line = JSON.stringify({ event: "test.happened", pad: "x".repeat(40) });
    for (let i = 0; i < 50; i++) file.write(line);
    // A record small enough to fit in what is left is not written either: the file ends at the marker.
    file.write("{}");
    file.close();
    const text = readFileSync(file.path as string, "utf8");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(300);
    const lines = text.trimEnd().split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.slice(0, -1).every((l) => l === line)).toBe(true);
    const last = JSON.parse(lines.at(-1) as string) as Record<string, unknown>;
    expect(last).toEqual({ t: expect.any(String), level: "warn", event: "log.truncated" });
    expect(last.t).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  test("a file is only ever created: a name that is taken, or a symbolic link left there, is not written to", () => {
    const dir = tmp();
    const name = "20261013T080100000Z-serve-4242.jsonl";
    const target = join(tmp(), "victim.txt");
    writeFileSync(target, "someone else's file\n");
    symlinkSync(target, join(dir, name));
    const file = openLogFile({ dir, process: "serve", now: at(1), pid: 4242 });
    file.write("{}");
    file.close();
    expect(readFileSync(target, "utf8")).toBe("someone else's file\n");
    expect(file.path).not.toBe(join(dir, name));
    expect(file.path).toBe(join(dir, "20261013T080100000Z-serve-4242-1.jsonl"));
    expect(readFileSync(file.path as string, "utf8")).toBe("{}\n");

    // An existing regular file of the same name is not appended to.
    const dir2 = tmp();
    writeFileSync(join(dir2, name), "earlier\n");
    const second = openLogFile({ dir: dir2, process: "serve", now: at(1), pid: 4242 });
    second.write("{}");
    second.close();
    expect(readFileSync(join(dir2, name), "utf8")).toBe("earlier\n");
    expect(second.path).toBe(join(dir2, "20261013T080100000Z-serve-4242-1.jsonl"));

    // Every candidate name taken: no file, no throw.
    const dir3 = tmp();
    writeFileSync(join(dir3, name), "");
    for (let n = 1; n <= 8; n++)
      writeFileSync(join(dir3, name.replace(".jsonl", `-${n}.jsonl`)), "");
    const before = readdirSync(dir3).sort();
    const third = openLogFile({ dir: dir3, process: "serve", now: at(1), pid: 4242 });
    expect(third.path).toBeNull();
    expect(() => third.write("{}")).not.toThrow();
    third.close();
    expect(readdirSync(dir3).sort()).toEqual(before);
  });

  test("a file with a numbered name is tidied like any other", () => {
    const dir = tmp();
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(dir, `20261013T080${i}00000Z-serve-1-1.jsonl`), "{}\n");
    }
    pruneLogDir(dir, { keepFiles: 2 });
    expect(readdirSync(dir).sort()).toEqual([
      "20261013T080200000Z-serve-1-1.jsonl",
      "20261013T080300000Z-serve-1-1.jsonl",
    ]);
  });

  test("this run's file is never tidied away", () => {
    const dir = tmp();
    const file = openLogFile({ dir, process: "serve", now: at(1), pid: 1, maxTotalBytes: 100 });
    file.close();
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
