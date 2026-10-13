/**
 * Changing a key of the config file on disk: what the file's bytes are afterwards, what is left beside it, and
 * what two processes do to each other. Every file is in a fresh temporary directory.
 */

import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { configFilePath, readSettingsFile } from "../src/config.js";
import { type SettingWriteResult, writeSetting } from "../src/config-write.js";

const ROOT = process.getuid?.() === 0;
let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aspace-cfgwrite-"));
  path = join(dir, "config.toml");
});

const put = (text: string | Buffer, mode = 0o644): void => {
  writeFileSync(path, text);
  chmodSync(path, mode);
};
const bytes = (file = path): string => readFileSync(file).toString("latin1");
const modeOf = (file: string): number => statSync(file).mode & 0o7777;

describe("writeSetting: one process", () => {
  test("changes the one line and leaves nothing beside the file", async () => {
    put(
      '# mine\r\ndata_dir = "lit" # here\r\nport = 1859\r\n\r\n[ui]\r\ntheme = "dark"\r\n',
      0o640
    );
    expect(await writeSetting("port", { set: 1900 }, { path })).toEqual({
      ok: true,
      changed: true,
    });
    expect(await writeSetting("ui.theme", { set: "light" }, { path })).toEqual({
      ok: true,
      changed: true,
    });
    expect(readFileSync(path, "utf-8")).toBe(
      '# mine\r\ndata_dir = "lit" # here\r\nport = 1900\r\n\r\n[ui]\r\ntheme = "light"\r\n'
    );
    expect(readdirSync(dir)).toEqual(["config.toml"]);
    // the permission bits are the file's own, not the default
    expect(modeOf(path)).toBe(0o640);
  });

  test("the bytes of a file with a byte order mark and non-ASCII text come back exactly", async () => {
    const original = Buffer.from('﻿# 文献库 — é\r\ndata_dir = "文献"\r\nport = 1\r\n', "utf-8");
    put(original);
    expect(await writeSetting("port", { set: 2 }, { path })).toEqual({ ok: true, changed: true });
    const expected = Buffer.from('﻿# 文献库 — é\r\ndata_dir = "文献"\r\nport = 2\r\n', "utf-8");
    expect(readFileSync(path).equals(expected)).toBe(true);
  });

  test("a missing file is created, with its directory, readable by the user only", async () => {
    const nested = join(dir, "a", "argelanderspace", "config.toml");
    expect(await writeSetting("ui.theme", { set: "light" }, { path: nested })).toEqual({
      ok: true,
      changed: true,
    });
    expect(readFileSync(nested, "utf-8")).toBe('[ui]\ntheme = "light"\n');
    expect(modeOf(nested)).toBe(0o600);
    expect(modeOf(join(dir, "a", "argelanderspace"))).toBe(0o700);
    expect(readdirSync(join(dir, "a", "argelanderspace"))).toEqual(["config.toml"]);
  });

  test("restoring a default in a missing file creates nothing", async () => {
    const nested = join(dir, "a", "config.toml");
    expect(await writeSetting("port", { reset: true }, { path: nested })).toEqual({
      ok: true,
      changed: false,
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  test("nothing to change: the file is not replaced", async () => {
    put("port = 0x10 # hex\n");
    const before = statSync(path, { bigint: true });
    expect(await writeSetting("port", { set: 16 }, { path })).toEqual({ ok: true, changed: false });
    expect(await writeSetting("data_dir", { reset: true }, { path })).toEqual({
      ok: true,
      changed: false,
    });
    const after = statSync(path, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(bytes()).toBe("port = 0x10 # hex\n");
    expect(readdirSync(dir)).toEqual(["config.toml"]);
  });

  test("the default path is the user's config file (here: the test's own)", async () => {
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;
    try {
      expect(await writeSetting("log_level", { set: "debug" })).toEqual({
        ok: true,
        changed: true,
      });
      expect(configFilePath()).toBe(join(dir, "argelanderspace", "config.toml"));
      expect(readFileSync(configFilePath(), "utf-8")).toBe('log_level = "debug"\n');
      expect(readSettingsFile().values.log_level).toBe("debug");
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
    }
  });

  test("a lock left behind by a process that died is taken over", async () => {
    put("port = 1\n");
    mkdirSync(`${path}.lock`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.lock`, old, old);
    expect(await writeSetting("port", { set: 2 }, { path })).toEqual({ ok: true, changed: true });
    expect(bytes()).toBe("port = 2\n");
    expect(readdirSync(dir)).toEqual(["config.toml"]);
  });
});

describe("writeSetting: refusals leave the file's bytes alone", () => {
  const refused = async (
    key: string,
    change: Parameters<typeof writeSetting>[1],
    options: Parameters<typeof writeSetting>[2] = { path }
  ): Promise<string> => {
    const got = await writeSetting(key, change, options);
    if (got.ok) throw new Error("not refused");
    // a category and nothing else: no path, no message
    expect(Object.keys(got)).toEqual(["ok", "reason"]);
    expect(JSON.stringify(got)).not.toContain(dir);
    return got.reason;
  };

  test("what the line editor refuses", async () => {
    const cases: Array<[string, string, Parameters<typeof writeSetting>[1], string]> = [
      ['ui.theme = "dark"\n', "ui.theme", { set: "light" }, "dotted_key"],
      ['ui = { theme = "dark" }\n', "ui.theme", { set: "light" }, "inline_table"],
      ['data_dir = """\nlit"""\n', "data_dir", { set: "x" }, "multiline_string"],
      ["port = 1\nport = 2\n", "port", { set: 3 }, "duplicate_key"],
      ['[[ui]]\ntheme = "dark"\n', "ui.theme", { reset: true }, "array_of_tables"],
      ["port = \n", "port", { set: 3 }, "unparseable"],
      ["port = 1\n", "port", { set: 70000 }, "invalid_value"],
      ["port = 1\n", "nope", { set: 1 }, "unknown_key"],
      ["port = 1\n", "contact_email", { set: "a\nb" }, "unrepresentable_value"],
    ];
    for (const [text, key, change, reason] of cases) {
      put(text);
      expect(await refused(key, change), text).toBe(reason);
      expect(bytes()).toBe(text);
      expect(readdirSync(dir)).toEqual(["config.toml"]);
    }
  });

  test("a change that is not a change is an invalid value, whether or not the file is there", async () => {
    const shapes = [
      {},
      null,
      undefined,
      { set: 1, reset: true },
      { reset: false },
      { set: null },
      7,
    ];
    for (const change of shapes as unknown as Array<Parameters<typeof writeSetting>[1]>) {
      put("port = 1\n");
      expect(await refused("port", change), JSON.stringify(change)).toBe("invalid_value");
      expect(bytes()).toBe("port = 1\n");
      expect(readdirSync(dir)).toEqual(["config.toml"]);
      const missing = join(dir, "sub", "config.toml");
      expect(await refused("port", change, { path: missing })).toBe("invalid_value");
      expect(existsSync(join(dir, "sub"))).toBe(false);
    }
    // the key is looked at first, as in the line editor
    expect(await refused("nope", {} as never)).toBe("unknown_key");
  });

  test("minus zero is written as zero", async () => {
    put("port = 1\n");
    expect(await writeSetting("port", { set: -0 }, { path })).toEqual({ ok: true, changed: true });
    expect(bytes()).toBe("port = 0\n");
    expect(await writeSetting("port", { set: -0 }, { path })).toEqual({ ok: true, changed: false });
  });

  test("a file that is not UTF-8", async () => {
    const latin = Buffer.from([
      0x23, 0x20, 0xe9, 0x0a, 0x70, 0x6f, 0x72, 0x74, 0x20, 0x3d, 0x20, 0x31, 0x0a,
    ]);
    put(latin);
    expect(await refused("port", { set: 2 })).toBe("invalid_encoding");
    expect(readFileSync(path).equals(latin)).toBe(true);
  });

  test("a path that is a directory, or under a file", async () => {
    mkdirSync(path);
    expect(await refused("port", { set: 2 })).toBe("unreadable");
    const under = join(dir, "plain-file", "config.toml");
    writeFileSync(join(dir, "plain-file"), "x");
    expect(await refused("port", { set: 2 }, { path: under })).toBe("unreadable");
    expect(readFileSync(join(dir, "plain-file"), "utf-8")).toBe("x");
  });

  test.skipIf(ROOT)(
    "a file the user may not write, in a directory that would allow replacing it",
    async () => {
      put("port = 1\n", 0o444);
      expect(await refused("port", { set: 2 })).toBe("not_writable");
      expect(bytes()).toBe("port = 1\n");
      expect(modeOf(path)).toBe(0o444);
      expect(readdirSync(dir)).toEqual(["config.toml"]);
    }
  );

  test.skipIf(ROOT)("a file the user may not read", async () => {
    put("port = 1\n", 0o200);
    expect(await refused("port", { set: 2 })).toBe("unreadable");
    chmodSync(path, 0o600);
    expect(bytes()).toBe("port = 1\n");
  });

  test.skipIf(ROOT)("a directory that does not allow writing", async () => {
    put("port = 1\n");
    chmodSync(dir, 0o555);
    try {
      expect(await refused("port", { set: 2 })).toBe("not_writable");
      expect(await refused("port", { set: 2 }, { path: join(dir, "sub", "config.toml") })).toBe(
        "not_writable"
      );
      expect(bytes()).toBe("port = 1\n");
      expect(readdirSync(dir)).toEqual(["config.toml"]);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  test("a failure while the new file is put in place: the old file is whole and no temporary file stays", async () => {
    const original = '# keep\nport = 1 # c\n[ui]\ntheme = "dark"\n';
    put(original, 0o640);
    const seen: string[] = [];
    const failing = async (from: string, to: string): Promise<void> => {
      // the new content is complete in the temporary file, beside the target, before the old file is touched
      seen.push(readFileSync(from, "utf-8"));
      expect(to).toBe(path);
      expect(bytes()).toBe(original);
      throw Object.assign(new Error(`EIO: i/o error, rename '${from}' -> '${to}'`), {
        code: "EIO",
      });
    };
    expect(await refused("port", { set: 2 }, { path, rename: failing })).toBe("write_failed");
    expect(seen).toEqual([original.replace("port = 1", "port = 2")]);
    expect(bytes()).toBe(original);
    expect(modeOf(path)).toBe(0o640);
    expect(readdirSync(dir)).toEqual(["config.toml"]);
    // a failure that is a refusal of permission is reported as such
    const denied = async (): Promise<void> => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    expect(await refused("port", { set: 2 }, { path, rename: denied })).toBe("not_writable");
    expect(bytes()).toBe(original);
    // and the next write goes through
    expect(await writeSetting("port", { set: 2 }, { path })).toEqual({ ok: true, changed: true });
    expect(bytes()).toBe(original.replace("port = 1", "port = 2"));
  });
});

describe("writeSetting: a config file that is a symbolic link", () => {
  test("the file it points at is changed and the link stays a link", async () => {
    const real = join(dir, "dotfiles");
    mkdirSync(real);
    writeFileSync(join(real, "argelander.toml"), "# shared\nport = 1\n");
    symlinkSync(join(real, "argelander.toml"), path);
    expect(await writeSetting("port", { set: 2 }, { path })).toEqual({ ok: true, changed: true });
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path)).toBe(join(real, "argelander.toml"));
    expect(readFileSync(join(real, "argelander.toml"), "utf-8")).toBe("# shared\nport = 2\n");
    expect(readdirSync(real)).toEqual(["argelander.toml"]);
    expect(readdirSync(dir).sort()).toEqual(["config.toml", "dotfiles"]);
  });

  test("a link that points nowhere is refused and left alone", async () => {
    symlinkSync(join(dir, "gone.toml"), path);
    expect(await writeSetting("port", { set: 2 }, { path })).toEqual({
      ok: false,
      reason: "unreadable",
    });
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(existsSync(join(dir, "gone.toml"))).toBe(false);
  });
});

// --------------------------------------------------------------------------- //
// Two processes: real child processes, each running writeSetting once
// --------------------------------------------------------------------------- //

const WORKER = fileURLToPath(new URL("./config-write-worker.mjs", import.meta.url));

function child(
  key: string,
  value: unknown | "--reset",
  umask?: string
): Promise<SettingWriteResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      process.execPath,
      ["--no-warnings", WORKER, path, key, value === "--reset" ? "--reset" : JSON.stringify(value)],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: umask === undefined ? process.env : { ...process.env, ASPACE_TEST_UMASK: umask },
      }
    );
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => {
      out += d;
    });
    p.stderr.on("data", (d) => {
      err += d;
    });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) reject(new Error(`worker exited ${code}: ${err}`));
      else resolve(JSON.parse(out) as SettingWriteResult);
    });
  });
}

describe("writeSetting: two processes", () => {
  const START = '# mine\ndata_dir = "lit" # here\nport = 1859\n\n[ui]\ntheme = "dark"\n';

  test("one after the other, different keys: both changes are there", async () => {
    put(START);
    expect(await child("port", 1900)).toEqual({ ok: true, changed: true });
    expect(await child("ui.theme", "light")).toEqual({ ok: true, changed: true });
    expect(bytes()).toBe('# mine\ndata_dir = "lit" # here\nport = 1900\n\n[ui]\ntheme = "light"\n');
    expect(readdirSync(dir)).toEqual(["config.toml"]);
  }, 30_000);

  test("one after the other, the same key: the later one's value stays", async () => {
    put(START);
    expect(await child("port", 1900)).toEqual({ ok: true, changed: true });
    expect(await child("port", 1901)).toEqual({ ok: true, changed: true });
    expect(bytes()).toBe(START.replace("1859", "1901"));
    expect(await child("port", "--reset")).toEqual({ ok: true, changed: true });
    expect(bytes()).toBe(START.replace("port = 1859\n", ""));
  }, 30_000);

  test("a process whose file-creation mask clears bits the file has: the file keeps its bits", async () => {
    // A new file is made with the mask applied, so without setting the bits again 0664 would come back as 0600.
    for (const mode of [0o664, 0o666, 0o640, 0o600]) {
      put(START, mode);
      expect(await child("port", 1900, "077")).toEqual({ ok: true, changed: true });
      expect(modeOf(path), mode.toString(8)).toBe(mode);
      expect(bytes()).toBe(START.replace("1859", "1900"));
    }
    expect(readdirSync(dir)).toEqual(["config.toml"]);
  }, 30_000);

  test("at the same time, different keys: every change is there", async () => {
    put(START);
    const results = await Promise.all([
      child("port", 1900),
      child("ui.theme", "light"),
      child("log_level", "debug"),
      child("ui.labels", false),
      child("auto_ingest_arxiv", false),
      child("ui.density", "compact"),
      child("contact_email", "reader@example.org"),
      child("data_dir", "papers"),
    ]);
    for (const result of results) expect(result).toEqual({ ok: true, changed: true });
    const got = readSettingsFile(path);
    expect(got.problems).toEqual([]);
    expect(got.values).toMatchObject({
      port: 1900,
      "ui.theme": "light",
      log_level: "debug",
      "ui.labels": false,
      auto_ingest_arxiv: false,
      "ui.density": "compact",
      contact_email: "reader@example.org",
      data_dir: "papers",
    });
    // the comments are still there, and nothing is left beside the file
    expect(readFileSync(path, "utf-8")).toContain("# mine\n");
    expect(readFileSync(path, "utf-8")).toContain('data_dir = "papers" # here\n');
    expect(readdirSync(dir)).toEqual(["config.toml"]);
  }, 60_000);

  test("at the same time, the same key: one of the values stays and the file is whole", async () => {
    put(START);
    const results = await Promise.all([1901, 1902, 1903, 1904].map((port) => child("port", port)));
    for (const result of results) expect(result).toEqual({ ok: true, changed: true });
    const text = readFileSync(path, "utf-8");
    expect(text).toMatch(
      /^# mine\ndata_dir = "lit" # here\nport = 190[1-4]\n\n\[ui\]\ntheme = "dark"\n$/
    );
  }, 60_000);

  test("a writer waits for the lock another process holds, then sees that process's change", async () => {
    put(START);
    const release = await lockfile.lock(path, { realpath: false });
    const waiting = child("ui.theme", "light");
    let done = false;
    void waiting.then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 700));
    expect(done).toBe(false);
    expect(bytes()).toBe(START);
    // what the lock holder writes before letting go is what the waiting writer edits
    writeFileSync(path, START.replace("1859", "1900"));
    await release();
    expect(await waiting).toEqual({ ok: true, changed: true });
    expect(bytes()).toBe('# mine\ndata_dir = "lit" # here\nport = 1900\n\n[ui]\ntheme = "light"\n');
  }, 30_000);

  test("a lock that is never let go: the writer gives up and says so", async () => {
    put(START);
    const release = await lockfile.lock(path, { realpath: false });
    try {
      expect(await writeSetting("port", { set: 2 }, { path })).toEqual({
        ok: false,
        reason: "busy",
      });
      expect(bytes()).toBe(START);
    } finally {
      await release();
    }
  }, 30_000);
});

afterEach(() => {
  // leave nothing unwritable behind for the temp cleaner
  try {
    chmodSync(dir, 0o755);
  } catch {
    /* already gone */
  }
});
