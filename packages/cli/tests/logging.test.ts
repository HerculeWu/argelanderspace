/**
 * The user-level log and the built CLI (desktop-app ticket 06): only `serve` writes one. Every other command runs
 * and ends without creating a file anywhere — no log file, no log directory — and `serve` still prints its three
 * lines, exactly, while its log goes to the log directory. An error no route handled is printed on `serve`'s
 * terminal as it always was; the log file gets the same failure without the error's words.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = join(PKG, "dist", "bin.js");
const DOC_ID = "arxiv-2501.17225";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A throwaway home with a project in it; the child's per-user directories all sit below the home. */
function world(): { root: string; dataDir: string; logDir: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "aspace-cli-log-"));
  roots.push(root);
  const dataDir = join(root, "project", "literatures");
  const docDir = join(dataDir, "output", DOC_ID);
  mkdirSync(docDir, { recursive: true });
  copyFileSync(
    join(REPO_ROOT, "tests", "golden", "tex", `${DOC_ID}.json`),
    join(docDir, `${DOC_ID}.json`)
  );
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    XDG_CONFIG_HOME: join(root, ".config"),
    XDG_DATA_HOME: join(root, ".local", "share"),
    XDG_CACHE_HOME: join(root, ".cache"),
  };
  return { root, dataDir, logDir: join(root, ".local", "share", "argelanderspace", "logs"), env };
}

/** Every file and directory below `dir`, relative, sorted. */
function tree(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = join(prefix, entry.name);
    out.push(entry.isDirectory() ? `${rel}/` : rel);
    if (entry.isDirectory()) out.push(...tree(join(dir, entry.name), rel));
  }
  return out.sort();
}

describe("short-running commands", () => {
  test("write no log: nothing is created anywhere below the home directory", () => {
    const { root, dataDir, env } = world();
    const before = tree(root);
    const runs: Array<{ args: string[]; status: number }> = [
      { args: ["list"], status: 0 },
      { args: ["read", DOC_ID], status: 0 },
      { args: ["annot", DOC_ID], status: 0 },
      { args: ["read", "no-such-doc"], status: 1 },
      { args: ["argument", "get", "no-such-work"], status: 1 },
      { args: ["pdf-path", DOC_ID], status: 1 },
      { args: ["--help"], status: 0 },
    ];
    for (const run of runs) {
      const r = spawnSync(process.execPath, [BIN, "--data-dir", dataDir, ...run.args], {
        env,
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(r.status, run.args.join(" ")).toBe(run.status);
      expect(tree(root), run.args.join(" ")).toEqual(before);
    }
  }, 120_000);

  test("their output is what it was: no annotations is silence, an unknown doc is the same one error", () => {
    const { dataDir, env } = world();
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [BIN, "--data-dir", dataDir, ...args], { env, encoding: "utf8" });
    const annot = run("annot", DOC_ID);
    expect([annot.status, annot.stdout, annot.stderr]).toEqual([0, "", ""]);
    const pdf = run("pdf-path", DOC_ID);
    expect([pdf.status, pdf.stdout, pdf.stderr]).toEqual([
      1,
      "",
      `error: doc "${DOC_ID}" is not a PDF doc\n`,
    ]);
  }, 60_000);
});

describe("serve", () => {
  test("prints exactly its three lines and writes its log to the log directory", async () => {
    const { root, dataDir, logDir, env } = world();
    mkdirSync(join(root, ".config", "argelanderspace"), { recursive: true });
    writeFileSync(
      join(root, ".config", "argelanderspace", "config.toml"),
      'openalex_api_key = "VALUE-MARKER"\n'
    );
    // GET /api/plans has no error handling of its own: this file makes it fail.
    mkdirSync(join(root, "project", "status"), { recursive: true });
    writeFileSync(join(root, "project", "status", "plans.json"), "{ PLAN-MARKER");

    const child = spawn(process.execPath, [BIN, "serve", "--data-dir", dataDir, "--port", "0"], {
      env,
      cwd: join(root, "project"),
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
    const exited = new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code))
    );
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no start lines; got: ${stdout}${stderr}`)),
          20_000
        );
        child.stdout.on("data", () => {
          const m = /listening on http:\/\/127\.0\.0\.1:(\d+)\n[\s\S]*web dist: .*\n/.exec(stdout);
          if (m) {
            clearTimeout(timer);
            resolve(Number.parseInt(m[1] as string, 10));
          }
        });
      });
      // A request that succeeds: the terminal shows the three start lines and nothing else.
      expect((await fetch(`http://127.0.0.1:${port}/api/papers`)).status).toBe(200);
      const startLines =
        `ArgelanderSpace server listening on http://127.0.0.1:${port}\n` +
        `  data dir: ${dataDir}\n` +
        "  web dist: (none — API only)\n";
      expect(stdout).toBe(startLines);
      expect(stderr).toBe("");

      const failed = await fetch(`http://127.0.0.1:${port}/api/plans`);
      expect(failed.status).toBe(500);
      expect(failed.headers.get("content-type")).toBe("text/plain; charset=UTF-8");
      expect(await failed.text()).toBe("Internal Server Error");
      // An error no route handled is printed whole on the terminal, as it was before there was a log …
      for (let i = 0; i < 100 && !stderr.includes("\n    at "); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(stderr).toContain("plans store:");
      expect(stderr).toContain(join(root, "project", "status", "plans.json"));
      expect(stderr).toMatch(/\n {4}at /);
      expect(stdout).toBe(startLines);

      const files = readdirSync(logDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(new RegExp(`^\\d{8}T\\d{9}Z-serve-${child.pid}\\.jsonl$`));
      const text = readFileSync(join(logDir, files[0] as string), "utf8");
      const records = text
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records).toMatchObject([
        {
          level: "info",
          event: "server.started",
          version: "0.1.0",
          mode: "browser",
          port,
          project_root: "~/project",
          data_dir: "~/project/literatures",
          config_keys: ["openalex_api_key"],
          config_unknown_keys: 0,
          log_level: "info",
        },
        {
          level: "error",
          event: "request.failed",
          method: "GET",
          route: "/api/plans",
          status: 500,
        },
      ]);
      // … and the log file has the failure without any of those words.
      const failure = records[1]?.error as { name: string; message?: string; stack: string[] };
      expect(failure.name).toBe("Error");
      expect(failure.message).toBeUndefined();
      expect(failure.stack.length).toBeGreaterThan(0);
      expect(text).not.toContain("MARKER");
      expect(text).not.toContain("plans store");
      expect(text).not.toContain(root);
    } finally {
      child.kill("SIGTERM");
    }
    expect(await exited).toBe(0);
  }, 60_000);
});

describe("what kills a long-running process", () => {
  const FIXTURE = join(PKG, "tests", "fixtures", "crash.mjs");

  function crash(kind: string, mode: "log" | "plain") {
    const w = world();
    const r = spawnSync(process.execPath, [FIXTURE, kind, mode], {
      env: w.env,
      encoding: "utf8",
      timeout: 30_000,
    });
    return { ...w, status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
  }

  function recordsIn(logDir: string): { records: Array<Record<string, unknown>>; text: string } {
    const files = readdirSync(logDir);
    expect(files).toHaveLength(1);
    const text = readFileSync(join(logDir, files[0] as string), "utf8");
    return {
      text,
      records: text
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    };
  }

  test.each([
    ["throw", "process.uncaught_exception", "Error"],
    ["reject", "process.unhandled_rejection", "TypeError"],
  ])(
    "%s: the log has the record, and the process ends exactly as it does without a log",
    (kind, event, name) => {
      const plain = crash(kind, "plain");
      const logged = crash(kind, "log");
      // Node's own ending, untouched: same exit code, same text on the terminal.
      expect(plain.status).toBe(1);
      expect(plain.stderr).toContain("CRASH-MARKER");
      expect([logged.status, logged.signal, logged.stdout, logged.stderr]).toEqual([
        plain.status,
        plain.signal,
        plain.stdout,
        plain.stderr,
      ]);

      const { records, text } = recordsIn(logged.logDir);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ level: "error", event, error: { name } });
      const stack = (records[0]?.error as { stack: string[] } | undefined)?.stack ?? [];
      expect(stack[0]).toMatch(/crash\.mjs:\d+:\d+$/);
      // The terminal shows the message (it always did); the log does not.
      expect(text).not.toContain("CRASH-MARKER");
      // The run without a log made no log directory.
      expect(tree(plain.root).some((entry) => entry.includes("argelanderspace"))).toBe(false);
    },
    60_000
  );

  test("a rejection with something that is not an error ends the same way and is recorded by its kind", () => {
    const plain = crash("reject-value", "plain");
    const logged = crash("reject-value", "log");
    expect(plain.status).toBe(1);
    expect([logged.status, logged.signal, logged.stdout, logged.stderr]).toEqual([
      plain.status,
      plain.signal,
      plain.stdout,
      plain.stderr,
    ]);
    const { records, text } = recordsIn(logged.logDir);
    expect(records).toMatchObject([{ event: "process.unhandled_rejection" }]);
    expect(text).not.toContain("CRASH-MARKER");
  }, 60_000);
});
