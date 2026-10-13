/**
 * What `writeSetting` does when the file, or its lock, changes hands between its reading of the file and the moment
 * the new file is put in place. The window is entered through `beforeReplace`, the step `writeSetting` runs right
 * before its last look at the lock and the file; the lock's own "you no longer hold this" notice is taken from the
 * options `writeSetting` hands to proper-lockfile.
 */

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const lockCalls = vi.hoisted(() => [] as Array<{ onCompromised?: (err: Error) => void }>);
vi.mock("proper-lockfile", async (importOriginal) => {
  const actual = (await importOriginal()) as { default: Record<string, unknown> };
  const real = actual.default as {
    lock: (file: string, options: Record<string, unknown>) => Promise<() => Promise<void>>;
  };
  return {
    default: {
      ...real,
      lock: (file: string, options: Record<string, unknown>) => {
        lockCalls.push(options as { onCompromised?: (err: Error) => void });
        return real.lock(file, options);
      },
    },
  };
});

const { writeSetting } = await import("../src/config-write.js");

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aspace-cfgrace-"));
  path = join(dir, "config.toml");
  lockCalls.length = 0;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
const text = (): string => readFileSync(path, "utf-8");
/** What is beside the config file once a write is over: nothing — no lock, no temporary file. */
const beside = (): string[] => readdirSync(dir).filter((name) => name !== "config.toml");
const START = '# mine\ndata_dir = "lit" # here\nport = 1859\n\n[ui]\ntheme = "dark"\n';

describe("writeSetting: the lock is judged stale while the write is under way", () => {
  /** What proper-lockfile does when it finds the lock is no longer this process's. */
  const loseTheLock = (): void => {
    const notice = lockCalls.at(-1)?.onCompromised;
    if (!notice) throw new Error("writeSetting gave proper-lockfile no onCompromised");
    notice(
      Object.assign(new Error("Unable to update lock within the stale threshold"), {
        code: "ECOMPROMISED",
      })
    );
  };

  test("the file is not replaced: another writer's change stays, and this writer is told `busy`", async () => {
    writeFileSync(path, START);
    const before = statSync(path, { bigint: true });
    let inWindow = 0;
    const got = await writeSetting(
      "port",
      { set: 1900 },
      {
        path,
        beforeReplace: async () => {
          inWindow++;
          // This writer was stopped for longer than the lock lasts; the lock was taken over.
          expect(() => loseTheLock()).not.toThrow();
        },
      }
    );
    expect(got).toEqual({ ok: false, reason: "busy" });
    expect(inWindow).toBe(1);
    expect(text()).toBe(START);
    const after = statSync(path, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(beside()).toEqual([]);
  });

  test("the reproduction: B wrote another key while A was stopped; A does not write over it", async () => {
    writeFileSync(path, START);
    const afterB = START.replace('theme = "dark"', 'theme = "light"');
    const a = await writeSetting(
      "port",
      { set: 1900 },
      {
        path,
        beforeReplace: async () => {
          // B took the stale lock over, wrote `ui.theme` and finished: the file is B's, of the same size or not.
          const temporary = join(dir, "b.tmp");
          writeFileSync(temporary, afterB);
          renameSync(temporary, path);
          loseTheLock();
        },
      }
    );
    expect(a).toEqual({ ok: false, reason: "busy" });
    expect(text()).toBe(afterB);
    expect(beside()).toEqual([]);
    // told so, A's caller tries again and both changes are there
    expect(await writeSetting("port", { set: 1900 }, { path })).toEqual({
      ok: true,
      changed: true,
    });
    expect(text()).toBe(afterB.replace("1859", "1900"));
  });

  test("the notice does not throw, with or without a write under way", async () => {
    writeFileSync(path, START);
    expect(await writeSetting("port", { set: 1900 }, { path })).toEqual({
      ok: true,
      changed: true,
    });
    // after the write is over (proper-lockfile's timer can still fire then)
    expect(() => loseTheLock()).not.toThrow();
    // and the next write is not affected by the last one's notice
    expect(await writeSetting("port", { set: 1901 }, { path })).toEqual({
      ok: true,
      changed: true,
    });
    expect(text()).toBe(START.replace("1859", "1901"));
  });

  test("a notice that comes when nothing is to be written changes nothing", async () => {
    writeFileSync(path, START);
    // nothing to change: there is no replacement, so there is no window
    let ran = 0;
    expect(
      await writeSetting("port", { set: 1859 }, { path, beforeReplace: async () => void ran++ })
    ).toEqual({ ok: true, changed: false });
    expect(ran).toBe(0);
  });
});

describe("writeSetting: the file is saved by something that does not take the lock", () => {
  test("an editor saves another key in the window: the write starts over on the editor's text", async () => {
    writeFileSync(path, START);
    chmodSync(path, 0o640);
    const saved = START.replace("# mine\n", "# mine, edited\n").replace('"dark"', '"light"');
    const attempts: number[] = [];
    const got = await writeSetting(
      "port",
      { set: 1900 },
      {
        path,
        beforeReplace: async () => {
          attempts.push(attempts.length);
          if (attempts.length === 1) writeFileSync(path, saved);
        },
      }
    );
    expect(got).toEqual({ ok: true, changed: true });
    expect(attempts).toEqual([0, 1]);
    expect(text()).toBe(saved.replace("1859", "1900"));
    expect(statSync(path).mode & 0o7777).toBe(0o640);
    expect(beside()).toEqual([]);
  });

  test("an editor that saves by replacing the file (a new inode, the same size and time) is seen too", async () => {
    writeFileSync(path, START);
    // a time a save can be given again exactly: whole seconds
    const when = new Date("2026-01-02T03:04:05Z");
    utimesSync(path, when, when);
    const read = statSync(path, { bigint: true });
    const saved = START.replace('"dark"', '"teal"'); // the same number of bytes
    expect(Buffer.byteLength(saved)).toBe(Buffer.byteLength(START));
    let first = true;
    const got = await writeSetting(
      "port",
      { set: 1900 },
      {
        path,
        beforeReplace: async () => {
          if (!first) return;
          first = false;
          const temporary = join(dir, "editor-save");
          writeFileSync(temporary, saved);
          utimesSync(temporary, when, when);
          renameSync(temporary, path);
          // only the inode tells the two files apart
          const now = statSync(path, { bigint: true });
          expect(now.mtimeNs).toBe(read.mtimeNs);
          expect(now.size).toBe(read.size);
          expect(now.ino).not.toBe(read.ino);
        },
      }
    );
    expect(got).toEqual({ ok: true, changed: true });
    expect(text()).toBe(saved.replace("1859", "1900"));
    expect(beside()).toEqual([]);
  });

  test("the same size, written in place: the time of the write gives it away", async () => {
    writeFileSync(path, START);
    const saved = START.replace('"dark"', '"teal"');
    let first = true;
    const got = await writeSetting(
      "port",
      { set: 1900 },
      {
        path,
        beforeReplace: async () => {
          if (!first) return;
          first = false;
          writeFileSync(path, saved);
          const later = new Date(Date.now() + 5_000);
          utimesSync(path, later, later);
        },
      }
    );
    expect(got).toEqual({ ok: true, changed: true });
    expect(text()).toBe(saved.replace("1859", "1900"));
  });

  test("written in place with another size and the time put back: the size gives it away", async () => {
    writeFileSync(path, START);
    // a time a save can be given again exactly: whole seconds
    const when = new Date("2026-01-02T03:04:05Z");
    utimesSync(path, when, when);
    const read = statSync(path, { bigint: true });
    const saved = `${START}# one more line\n`;
    let first = true;
    const got = await writeSetting(
      "port",
      { set: 1900 },
      {
        path,
        beforeReplace: async () => {
          if (!first) return;
          first = false;
          writeFileSync(path, saved);
          utimesSync(path, when, when);
          // only the size tells the two states apart
          const now = statSync(path, { bigint: true });
          expect(now.ino).toBe(read.ino);
          expect(now.mtimeNs).toBe(read.mtimeNs);
          expect(now.size).not.toBe(read.size);
        },
      }
    );
    expect(got).toEqual({ ok: true, changed: true });
    expect(text()).toBe(saved.replace("1859", "1900"));
    expect(beside()).toEqual([]);
  });

  test("the editor set the very key being written: the later writer, this one, has its value there", async () => {
    writeFileSync(path, START);
    let first = true;
    const got = await writeSetting(
      "port",
      { set: 1900 },
      {
        path,
        beforeReplace: async () => {
          if (first)
            writeFileSync(path, START.replace("1859", "1900").replace("# mine", "# theirs"));
          first = false;
        },
      }
    );
    // the editor's text already says what was asked: nothing is written the second time round
    expect(got).toEqual({ ok: true, changed: false });
    expect(text()).toBe(START.replace("1859", "1900").replace("# mine", "# theirs"));
    expect(beside()).toEqual([]);
  });

  test("the file did not exist when it was read and is there before the replacement", async () => {
    let first = true;
    const got = await writeSetting(
      "port",
      { set: 1900 },
      {
        path,
        beforeReplace: async () => {
          if (first) writeFileSync(path, '# just made\ndata_dir = "lit"\n');
          first = false;
        },
      }
    );
    expect(got).toEqual({ ok: true, changed: true });
    expect(text()).toBe('# just made\ndata_dir = "lit"\nport = 1900\n');
    expect(beside()).toEqual([]);
  });

  test("the file was there when it was read and is gone before the replacement: written anew", async () => {
    writeFileSync(path, START);
    let first = true;
    const got = await writeSetting(
      "port",
      { set: 1900 },
      {
        path,
        beforeReplace: async () => {
          if (first) rmSync(path);
          first = false;
        },
      }
    );
    expect(got).toEqual({ ok: true, changed: true });
    expect(text()).toBe("port = 1900\n");
    expect(beside()).toEqual([]);
  });

  test("what the editor saved cannot be edited: the refusal is the editor's text's, and the text stays", async () => {
    writeFileSync(path, START);
    const broken = "port = \n";
    const got = await writeSetting(
      "port",
      { set: 1900 },
      { path, beforeReplace: async () => writeFileSync(path, broken) }
    );
    expect(got).toEqual({ ok: false, reason: "unparseable" });
    expect(text()).toBe(broken);
    expect(beside()).toEqual([]);
  });

  test("a file that is saved again every time: three tries, then `busy`, and the last save stays", async () => {
    writeFileSync(path, START);
    let saves = 0;
    const got = await writeSetting(
      "port",
      { set: 1900 },
      {
        path,
        beforeReplace: async () => {
          saves++;
          // another size every time: the save is seen whatever the file system's time stamps can tell apart
          writeFileSync(path, `${START}# save ${"!".repeat(saves)}\n`);
        },
      }
    );
    expect(got).toEqual({ ok: false, reason: "busy" });
    expect(saves).toBe(3);
    expect(text()).toBe(`${START}# save !!!\n`);
    expect(beside()).toEqual([]);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test("a save on the first two tries only: the third goes through", async () => {
    writeFileSync(path, START);
    let tries = 0;
    const got = await writeSetting(
      "port",
      { set: 1900 },
      {
        path,
        beforeReplace: async () => {
          tries++;
          if (tries < 3) writeFileSync(path, `${START}# save ${"!".repeat(tries)}\n`);
        },
      }
    );
    expect(got).toEqual({ ok: true, changed: true });
    expect(tries).toBe(3);
    expect(text()).toBe(`${START.replace("1859", "1900")}# save !!\n`);
  });

  test("a step that fails leaves the file and no temporary file", async () => {
    writeFileSync(path, START);
    const got = await writeSetting(
      "port",
      { set: 1900 },
      {
        path,
        beforeReplace: async () => {
          throw new Error(`boom at ${path}`);
        },
      }
    );
    expect(got).toEqual({ ok: false, reason: "write_failed" });
    expect(text()).toBe(START);
    expect(beside()).toEqual([]);
  });
});

describe("writeSetting: the config path is a symbolic link that comes to lead elsewhere", () => {
  let targetDir: string;
  let target: string;
  beforeEach(() => {
    targetDir = mkdtempSync(join(tmpdir(), "aspace-cfgrace-"));
    target = join(targetDir, "real.toml");
    writeFileSync(target, START);
    symlinkSync(target, path);
  });
  afterEach(() => {
    rmSync(targetDir, { recursive: true, force: true });
  });

  test("an editor replaces the link by a plain file: nothing is replaced, and the answer is `busy`, not written", async () => {
    const saved = `${START}# the editor's\n`;
    const got = await writeSetting(
      "port",
      { set: 1900 },
      {
        path,
        beforeReplace: async () => {
          const temporary = join(dir, "editor-save");
          writeFileSync(temporary, saved);
          renameSync(temporary, path);
        },
      }
    );
    expect(got).toEqual({ ok: false, reason: "busy" });
    expect(text()).toBe(saved);
    // the file the link led to is as it was, with nothing left beside it
    expect(readFileSync(target, "utf-8")).toBe(START);
    expect(readdirSync(targetDir)).toEqual(["real.toml"]);
    // asked again, the change is written where the path leads now
    expect(await writeSetting("port", { set: 1900 }, { path })).toEqual({
      ok: true,
      changed: true,
    });
    expect(text()).toBe(saved.replace("1859", "1900"));
  });

  test("the link is pointed at another file: the same", async () => {
    const other = join(targetDir, "other.toml");
    writeFileSync(other, "port = 1\n");
    const got = await writeSetting(
      "port",
      { set: 1900 },
      {
        path,
        beforeReplace: async () => {
          unlinkSync(path);
          symlinkSync(other, path);
        },
      }
    );
    expect(got).toEqual({ ok: false, reason: "busy" });
    expect(readFileSync(target, "utf-8")).toBe(START);
    expect(readFileSync(other, "utf-8")).toBe("port = 1\n");
    expect(readdirSync(targetDir).sort()).toEqual(["other.toml", "real.toml"]);
  });

  test("a link that still leads to the same file is written through as before", async () => {
    expect(await writeSetting("port", { set: 1900 }, { path })).toEqual({
      ok: true,
      changed: true,
    });
    expect(readFileSync(target, "utf-8")).toBe(START.replace("1859", "1900"));
    expect(readdirSync(targetDir)).toEqual(["real.toml"]);
  });
});
