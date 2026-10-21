/**
 * `argelanderspace tutorial` (in-app-tutorial ticket 26; spec §2 「浏览器形态命令」, §6): the built CLI as a child process
 * in a throwaway home (HOME / XDG_* / a session bus that leads nowhere), its output compared exactly with the
 * messages of the copy's section 8.
 *
 * The CLI finds the bundled sample beside its entry (`dist/tutorial`, infra `bundledTutorialDir`). The package's own
 * `dist/` has none, so the tests run a copy of it: `<install>/dist/` (the built files) with `<install>/node_modules`
 * linked to the package's, and the repository's `tutorial-sample/` copied once into `<install>/dist/tutorial`; a second
 * install without it is "this installation does not include the tutorial sample".
 *
 * `--reset` asks on a terminal: the child runs under util-linux `script`, which gives it a pseudo-terminal; the answer
 * is typed once the question is on the screen, and Ctrl-C through the same terminal stops the server.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const SAMPLE = fileURLToPath(new URL("../../../tutorial-sample", import.meta.url));
const MARKER = "argelanderspace-tutorial.json";
const BUNDLED_SAMPLE = (
  JSON.parse(readFileSync(join(SAMPLE, MARKER), "utf8")) as { sample: number }
).sample;

let installs: string;
let BIN: string;
let BIN_WITHOUT_SAMPLE: string;
const roots: string[] = [];

/** A copy of the built package at `<dir>/dist`, resolving its dependencies through the package's node_modules. */
function install(dir: string, withSample: boolean): string {
  mkdirSync(dir, { recursive: true });
  cpSync(join(PKG, "dist"), join(dir, "dist"), { recursive: true });
  symlinkSync(join(PKG, "node_modules"), join(dir, "node_modules"));
  if (withSample) cpSync(SAMPLE, join(dir, "dist", "tutorial"), { recursive: true });
  return join(dir, "dist", "bin.js");
}

beforeAll(() => {
  installs = mkdtempSync(join(tmpdir(), "aspace-cli-tutorial-install-"));
  BIN = install(join(installs, "with-sample"), true);
  BIN_WITHOUT_SAMPLE = install(join(installs, "without-sample"), false);
}, 120_000);

afterAll(() => {
  for (const root of [installs, ...roots]) rmSync(root, { recursive: true, force: true });
});

interface World {
  root: string;
  home: string;
  env: NodeJS.ProcessEnv;
  /** Where `tutorial.json` is in this home. */
  progressFile: string;
  /** The default tutorial folder in this home. */
  defaultDir: string;
}

function world(): World {
  const root = mkdtempSync(join(tmpdir(), "aspace-cli-tutorial-"));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(join(root, "runtime"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "cwd"));
  mkdirSync(home);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(root, "no-session-bus")}`,
    XDG_RUNTIME_DIR: join(root, "runtime"),
  };
  return {
    root,
    home,
    env,
    progressFile: join(home, ".local", "share", "argelanderspace", "tutorial.json"),
    defaultDir: join(home, "ArgelanderSpace-Tutorial"),
  };
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** A run that ends by itself (a refusal); stdin is not a terminal. */
function run(w: World, args: string[], bin = BIN): RunResult {
  const r = spawnSync(process.execPath, [bin, "tutorial", ...args], {
    env: w.env,
    cwd: join(w.root, "cwd"),
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

interface Running {
  port: number;
  stdout: () => string;
  stderr: () => string;
  /** SIGTERM; resolves with the exit code. */
  stop: () => Promise<number | null>;
}

const LISTEN = /listening on http:\/\/127\.0\.0\.1:(\d+)\n[\s\S]*web dist: .*\n/;

async function waitForListen(child: ChildProcess, out: () => string): Promise<number> {
  return new Promise<number>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error(`no listen line; got: ${out()}`)),
      30_000
    );
    const check = () => {
      const m = LISTEN.exec(out());
      if (m) {
        clearTimeout(timer);
        resolvePromise(Number.parseInt(m[1] as string, 10));
      }
    };
    child.stdout?.on("data", check);
    child.on("exit", (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`exited ${String(code)} before listening; got: ${out()}`));
    });
  });
}

/** A run that starts the server (stdin is not a terminal); resolves once it listens. */
async function start(w: World, args: string[]): Promise<Running> {
  const child = spawn(process.execPath, [BIN, "tutorial", ...args], {
    env: w.env,
    cwd: join(w.root, "cwd"),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => {
    stdout += d.toString();
  });
  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const exited = new Promise<number | null>((resolvePromise) =>
    child.on("exit", (code) => resolvePromise(code))
  );
  const stop = (): Promise<number | null> => {
    child.kill("SIGTERM");
    return exited;
  };
  try {
    const port = await waitForListen(child, () => stdout + stderr);
    return { port, stdout: () => stdout, stderr: () => stderr, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}

function startLines(port: number, dir: string): string {
  return (
    `ArgelanderSpace server listening on http://127.0.0.1:${port}\n` +
    `  data dir: ${join(dir, "literatures")}\n`
  );
}

async function getJson(port: number, path: string): Promise<unknown> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  expect(r.status).toBe(200);
  return r.json();
}

interface TutorialAnswer {
  progress: { project: { path: string } | null; position: string | null; steps: object } | null;
  project: { path: string; state: string } | null;
  sample: { bundled: number | null; project: number | null };
}

/** Every file and directory below `dir`, relative, sorted, files with their size (to prove nothing changed). */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        out.push(`${r}/`);
        walk(join(d, e.name), r);
      } else {
        out.push(`${r} ${statSync(join(d, e.name)).size}`);
      }
    }
  };
  walk(dir, "");
  return out.sort();
}

/** A tutorial folder as an earlier run left it (a copy of the sample), with `sample` in its marker. */
function tutorialFolder(dir: string, sample = BUNDLED_SAMPLE): string {
  cpSync(SAMPLE, dir, { recursive: true });
  writeFileSync(join(dir, MARKER), `${JSON.stringify({ version: 1, sample }, null, 2)}\n`);
  return dir;
}

function progressBoundTo(path: string) {
  return {
    version: 1,
    project: { path },
    startedAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-02T10:00:00.000Z",
    position: "library.add-bibtex",
    steps: { "prepare.welcome": { state: "done", at: "2026-10-01T10:00:00.000Z" } },
    appVersion: "0.1.0",
  };
}

function writeProgress(w: World, progress: object): void {
  mkdirSync(join(w.progressFile, ".."), { recursive: true });
  writeFileSync(w.progressFile, `${JSON.stringify(progress, null, 2)}\n`);
}

function readProgress(w: World): ReturnType<typeof progressBoundTo> {
  return JSON.parse(readFileSync(w.progressFile, "utf8")) as ReturnType<typeof progressBoundTo>;
}

describe("where the tutorial folder is", () => {
  test("first run: ~/ArgelanderSpace-Tutorial is made from the sample, bound, and served", async () => {
    const w = world();
    const srv = await start(w, ["--port", "0"]);
    try {
      expect(srv.stdout()).toMatch(
        new RegExp(
          `^${escapeRe(`tutorial folder: ${w.defaultDir} (created from the bundled sample)\n`)}${escapeRe(
            startLines(srv.port, w.defaultDir)
          )}  web dist: .*\n$`
        )
      );
      expect(srv.stderr()).toBe("");
      const tutorial = (await getJson(srv.port, "/api/tutorial")) as TutorialAnswer;
      expect(tutorial.project).toEqual({ path: w.defaultDir, state: "ready" });
      expect(tutorial.progress?.project).toEqual({ path: w.defaultDir });
      expect(tutorial.progress?.position).toBeNull();
      expect(tutorial.progress?.steps).toEqual({});
      expect(tutorial.sample).toEqual({ bundled: BUNDLED_SAMPLE, project: BUNDLED_SAMPLE });
      const library = (await getJson(srv.port, "/api/library")) as { refs: unknown[] };
      expect(library.refs).toHaveLength(5);
      const settings = (await getJson(srv.port, "/api/settings")) as {
        running: { project_root: { path: string } | null };
      };
      expect(settings.running.project_root?.path).toBe(w.defaultDir);
    } finally {
      expect(await srv.stop()).toBe(0);
    }
    // The copy is the sample's files (the server may add files of its own beside them).
    const copied = snapshot(w.defaultDir);
    for (const entry of snapshot(SAMPLE)) expect(copied).toContain(entry);
  }, 120_000);

  test("the bound folder, when it is there with its marker, comes before the default", async () => {
    const w = world();
    const bound = tutorialFolder(join(w.root, "elsewhere"));
    const progress = progressBoundTo(bound);
    writeProgress(w, progress);
    const srv = await start(w, ["--port", "0"]);
    try {
      expect(srv.stdout()).toMatch(
        new RegExp(
          `^${escapeRe(`tutorial folder: ${bound} (resuming)\n${startLines(srv.port, bound)}`)}`
        )
      );
      const tutorial = (await getJson(srv.port, "/api/tutorial")) as TutorialAnswer;
      expect(tutorial.project).toEqual({ path: bound, state: "ready" });
    } finally {
      expect(await srv.stop()).toBe(0);
    }
    // Resuming keeps the progress as it was.
    expect(readProgress(w)).toEqual(progress);
    expect(existsSync(w.defaultDir)).toBe(false);
  }, 120_000);

  test("a bound folder that is gone or has no marker falls back to the default (a new binding)", async () => {
    for (const make of [
      () => {},
      (dir: string) => {
        mkdirSync(dir);
        writeFileSync(join(dir, "notes.txt"), "not a tutorial");
      },
    ]) {
      const w = world();
      const bound = join(w.root, "elsewhere");
      make(bound);
      writeProgress(w, progressBoundTo(bound));
      const srv = await start(w, ["--port", "0"]);
      try {
        expect(srv.stdout()).toMatch(
          new RegExp(
            `^${escapeRe(`tutorial folder: ${w.defaultDir} (created from the bundled sample)\n`)}`
          )
        );
        const tutorial = (await getJson(srv.port, "/api/tutorial")) as TutorialAnswer;
        expect(tutorial.project).toEqual({ path: w.defaultDir, state: "ready" });
        expect(tutorial.progress?.position).toBeNull();
        expect(tutorial.progress?.steps).toEqual({});
      } finally {
        expect(await srv.stop()).toBe(0);
      }
    }
  }, 240_000);
});

describe("--dir", () => {
  test("a folder that is not there is made, filled from the sample and bound, over an earlier binding", async () => {
    const w = world();
    const bound = tutorialFolder(join(w.root, "elsewhere"));
    writeProgress(w, progressBoundTo(bound));
    const dir = join(w.root, "chosen", "tutorial");
    const srv = await start(w, ["--dir", dir, "--port", "0"]);
    try {
      expect(srv.stdout()).toMatch(
        new RegExp(
          `^${escapeRe(`tutorial folder: ${dir} (created from the bundled sample)\n${startLines(srv.port, dir)}`)}`
        )
      );
      const tutorial = (await getJson(srv.port, "/api/tutorial")) as TutorialAnswer;
      expect(tutorial.project).toEqual({ path: dir, state: "ready" });
      expect(tutorial.progress?.steps).toEqual({});
    } finally {
      expect(await srv.stop()).toBe(0);
    }
    const progress = readProgress(w);
    expect(progress.project).toEqual({ path: dir });
    expect(progress.position).toBeNull();
  }, 120_000);

  test("a relative --dir is the caller's; an empty folder is filled like a missing one", async () => {
    const w = world();
    mkdirSync(join(w.root, "cwd", "empty"));
    const dir = join(w.root, "cwd", "empty");
    const srv = await start(w, ["--dir", "empty", "--port", "0"]);
    try {
      expect(srv.stdout()).toMatch(
        new RegExp(`^${escapeRe(`tutorial folder: ${dir} (created from the bundled sample)\n`)}`)
      );
    } finally {
      expect(await srv.stop()).toBe(0);
    }
    expect(JSON.parse(readFileSync(join(dir, MARKER), "utf8"))).toEqual({
      version: 1,
      sample: BUNDLED_SAMPLE,
    });
  }, 120_000);

  test("a tutorial folder is resumed: nothing is copied over what the person wrote", async () => {
    const w = world();
    const dir = tutorialFolder(join(w.root, "mine"));
    writeFileSync(join(dir, "written-in-the-tutorial.txt"), "kept");
    const progress = progressBoundTo(dir);
    writeProgress(w, progress);
    const srv = await start(w, ["--dir", dir, "--port", "0"]);
    try {
      expect(srv.stdout()).toMatch(
        new RegExp(
          `^${escapeRe(`tutorial folder: ${dir} (resuming)\n${startLines(srv.port, dir)}`)}`
        )
      );
    } finally {
      expect(await srv.stop()).toBe(0);
    }
    expect(readFileSync(join(dir, "written-in-the-tutorial.txt"), "utf8")).toBe("kept");
    expect(readProgress(w)).toEqual(progress);
  }, 120_000);

  test("resuming a tutorial folder bound nowhere binds it, with no progress", async () => {
    const w = world();
    const dir = tutorialFolder(join(w.root, "mine"));
    const srv = await start(w, ["--dir", dir, "--port", "0"]);
    try {
      expect(srv.stdout()).toMatch(
        new RegExp(`^${escapeRe(`tutorial folder: ${dir} (resuming)\n`)}`)
      );
      const tutorial = (await getJson(srv.port, "/api/tutorial")) as TutorialAnswer;
      expect(tutorial.project).toEqual({ path: dir, state: "ready" });
      expect(tutorial.progress?.steps).toEqual({});
    } finally {
      expect(await srv.stop()).toBe(0);
    }
  }, 120_000);

  test("a non-empty folder without the marker is refused, and nothing is written anywhere", () => {
    const w = world();
    const dir = join(w.root, "papers");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "notes.txt"), "mine");
    writeFileSync(join(dir, "sub", "draft.tex"), "\\section{x}");
    const before = snapshot(w.root);
    const r = run(w, ["--dir", dir, "--port", "0"]);
    expect(r).toEqual({
      status: 1,
      stdout: "",
      stderr: `error: ${dir} exists, is not empty and is not a tutorial folder; pick another --dir\n`,
    });
    expect(snapshot(w.root)).toEqual(before);
  });

  test("the default folder, taken by something else, is refused the same way", () => {
    const w = world();
    mkdirSync(w.defaultDir);
    writeFileSync(join(w.defaultDir, "notes.txt"), "mine");
    const before = snapshot(w.root);
    const r = run(w, ["--port", "0"]);
    expect(r).toEqual({
      status: 1,
      stdout: "",
      stderr: `error: ${w.defaultDir} exists, is not empty and is not a tutorial folder; pick another --dir\n`,
    });
    expect(snapshot(w.root)).toEqual(before);
  });
});

describe("an older sample", () => {
  test("a note follows the resuming line, then the server starts as usual", async () => {
    const w = world();
    const dir = tutorialFolder(join(w.root, "old"), BUNDLED_SAMPLE - 1);
    const srv = await start(w, ["--dir", dir, "--port", "0"]);
    try {
      expect(srv.stdout()).toMatch(
        new RegExp(
          `^${escapeRe(
            `tutorial folder: ${dir} (resuming)\n` +
              "note: this tutorial folder was created from an older sample and may not load correctly; " +
              "run with --reset to start over\n" +
              startLines(srv.port, dir)
          )}`
        )
      );
      const tutorial = (await getJson(srv.port, "/api/tutorial")) as TutorialAnswer;
      expect(tutorial.sample).toEqual({ bundled: BUNDLED_SAMPLE, project: BUNDLED_SAMPLE - 1 });
    } finally {
      expect(await srv.stop()).toBe(0);
    }
    expect(JSON.parse(readFileSync(join(dir, MARKER), "utf8"))).toEqual({
      version: 1,
      sample: BUNDLED_SAMPLE - 1,
    });
  }, 120_000);
});

/** `tutorial` under a pseudo-terminal (util-linux `script`); the terminal's output, with "\r\n" made "\n". */
function onTerminal(w: World, args: string[]) {
  // exec: the shell `script` starts is replaced by the CLI, so the terminal's Ctrl-C reaches the CLI alone.
  const command = `exec ${[process.execPath, BIN, "tutorial", ...args].map(shellQuote).join(" ")}`;
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    env: w.env,
    cwd: join(w.root, "cwd"),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d: Buffer) => {
    out += d.toString().replace(/\r\n/g, "\n");
  });
  const exited = new Promise<number | null>((resolvePromise) =>
    child.on("exit", (code) => resolvePromise(code))
  );
  const waitFor = (text: string) =>
    new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(
        () => rejectPromise(new Error(`waited for ${text}; got: ${out}`)),
        30_000
      );
      const check = () => {
        if (out.includes(text)) {
          clearTimeout(timer);
          resolvePromise();
        }
      };
      child.stdout.on("data", check);
      check();
    });
  return {
    output: () => out,
    type: (text: string) => child.stdin.write(text),
    waitFor,
    exited,
    child,
  };
}

const haveScript = spawnSync("script", ["--version"], { stdio: "ignore" }).status === 0;

describe("--reset", () => {
  const question = (dir: string) =>
    `This will empty ${dir} and copy the sample again. Annotations, arguments, tasks and manuscripts you wrote in ` +
    "the tutorial will be deleted. Continue? [y/N] ";

  test.skipIf(!haveScript)(
    "on a terminal, y empties the folder, copies the sample, clears the progress, and starts",
    async () => {
      const w = world();
      const dir = tutorialFolder(join(w.root, "mine"), BUNDLED_SAMPLE - 1);
      writeFileSync(join(dir, "written-in-the-tutorial.txt"), "goes");
      writeProgress(w, progressBoundTo(dir));
      const term = onTerminal(w, ["--dir", dir, "--port", "0", "--reset"]);
      try {
        await term.waitFor("[y/N] ");
        expect(term.output()).toBe(question(dir));
        term.type("y\n");
        await term.waitFor("web dist: ");
        const m = /listening on http:\/\/127\.0\.0\.1:(\d+)\n/.exec(term.output());
        const port = Number.parseInt(m?.[1] as string, 10);
        expect(term.output()).toMatch(
          new RegExp(
            `^${escapeRe(
              `${question(dir)}y\ntutorial folder: ${dir} (created from the bundled sample)\n${startLines(port, dir)}`
            )}`
          )
        );
        const tutorial = (await getJson(port, "/api/tutorial")) as TutorialAnswer;
        expect(tutorial.project).toEqual({ path: dir, state: "ready" });
        expect(tutorial.sample).toEqual({ bundled: BUNDLED_SAMPLE, project: BUNDLED_SAMPLE });
        expect(tutorial.progress?.position).toBeNull();
        expect(tutorial.progress?.steps).toEqual({});
        expect(existsSync(join(dir, "written-in-the-tutorial.txt"))).toBe(false);
      } finally {
        term.type("\x03");
      }
      expect(await term.exited).toBe(0);
    },
    120_000
  );

  test.skipIf(!haveScript)(
    "on a terminal, N (or just Enter) changes nothing",
    async () => {
      for (const answer of ["N\n", "\n"]) {
        const w = world();
        const dir = tutorialFolder(join(w.root, "mine"));
        writeFileSync(join(dir, "written-in-the-tutorial.txt"), "stays");
        writeProgress(w, progressBoundTo(dir));
        const before = snapshot(w.root);
        const term = onTerminal(w, ["--dir", dir, "--reset"]);
        await term.waitFor("[y/N] ");
        term.type(answer);
        expect(await term.exited).toBe(0);
        expect(term.output()).toBe(`${question(dir)}${answer}cancelled; nothing was changed\n`);
        expect(snapshot(w.root)).toEqual(before);
      }
    },
    120_000
  );

  test("without a terminal it is refused, and nothing changes", () => {
    const w = world();
    const dir = tutorialFolder(join(w.root, "mine"));
    writeProgress(w, progressBoundTo(dir));
    const before = snapshot(w.root);
    const r = run(w, ["--dir", dir, "--reset"]);
    expect(r).toEqual({
      status: 1,
      stdout: "",
      stderr: "error: --reset needs an interactive terminal to confirm\n",
    });
    expect(snapshot(w.root)).toEqual(before);
  });

  test("never empties a folder without the marker: the same refusal as without --reset", () => {
    const w = world();
    const dir = join(w.root, "papers");
    mkdirSync(dir);
    writeFileSync(join(dir, "notes.txt"), "mine");
    const before = snapshot(w.root);
    const r = run(w, ["--dir", dir, "--reset"]);
    expect(r).toEqual({
      status: 1,
      stdout: "",
      stderr: `error: ${dir} exists, is not empty and is not a tutorial folder; pick another --dir\n`,
    });
    expect(snapshot(w.root)).toEqual(before);
  });
});

describe("refusals before anything is written", () => {
  test("an installation without the sample", () => {
    const w = world();
    const before = snapshot(w.root);
    const r = run(w, ["--port", "0"], BIN_WITHOUT_SAMPLE);
    expect(r).toEqual({
      status: 1,
      stdout: "",
      stderr: "error: this installation does not include the tutorial sample\n",
    });
    expect(snapshot(w.root)).toEqual(before);
  });

  test("--data-dir is not taken", () => {
    const w = world();
    for (const args of [
      ["tutorial", "--data-dir", join(w.root, "data")],
      ["--data-dir", join(w.root, "data"), "tutorial"],
    ]) {
      const r = spawnSync(process.execPath, [BIN, ...args], {
        env: w.env,
        cwd: join(w.root, "cwd"),
        encoding: "utf8",
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toBe("error: unknown option '--data-dir'\n");
      expect(existsSync(w.defaultDir)).toBe(false);
    }
  });
});

describe("the port", () => {
  test("a port in use is serve's error; there is no other port tried", async () => {
    const w = world();
    const busy = createNetServer();
    await new Promise<void>((resolvePromise) => busy.listen(0, "127.0.0.1", resolvePromise));
    const port = (busy.address() as { port: number }).port;
    try {
      const r = run(w, ["--port", String(port)]);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe(`tutorial folder: ${w.defaultDir} (created from the bundled sample)\n`);
      expect(r.stderr).toBe(`error: listen EADDRINUSE: address already in use 127.0.0.1:${port}\n`);
    } finally {
      await new Promise<void>((resolvePromise) => busy.close(() => resolvePromise()));
    }
  }, 120_000);

  test("without --port it is config.toml's port", async () => {
    const w = world();
    const probe = createNetServer();
    await new Promise<void>((resolvePromise) => probe.listen(0, "127.0.0.1", resolvePromise));
    const free = (probe.address() as { port: number }).port;
    await new Promise<void>((resolvePromise) => probe.close(() => resolvePromise()));
    mkdirSync(join(w.home, ".config", "argelanderspace"), { recursive: true });
    writeFileSync(join(w.home, ".config", "argelanderspace", "config.toml"), `port = ${free}\n`);
    const srv = await start(w, []);
    try {
      expect(srv.port).toBe(free);
    } finally {
      expect(await srv.stop()).toBe(0);
    }
  }, 120_000);
});

describe("help", () => {
  test("the program's help lists the command; its own help says what it does", () => {
    const w = world();
    const help = spawnSync(process.execPath, [BIN, "--help"], { env: w.env, encoding: "utf8" });
    expect(help.stdout).toMatch(/\n {2}tutorial \[options\] +\S/);
    const own = spawnSync(process.execPath, [BIN, "tutorial", "--help"], {
      env: w.env,
      encoding: "utf8",
    });
    expect(own.status).toBe(0);
    const text = own.stdout.replace(/\s+/g, " ");
    expect(text).toContain("Usage: argelanderspace tutorial [options]");
    expect(text).toContain("--dir <dir>");
    expect(text).toContain("--port <n>");
    expect(text).toContain("--reset");
    expect(text).not.toContain("--data-dir");
  });
});

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
