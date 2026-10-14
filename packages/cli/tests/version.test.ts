/**
 * The version has one source (desktop-app ticket 16): the app package's `version` (packages/app/package.json, the
 * published `argelanderspace`). `scripts/app-version.mjs` writes it into the CLI's source at build time
 * (`src/generated/app-version.ts`, not tracked), and every place that shows a version takes it from there: the
 * built CLI's `--version`, the `server.started` record of `serve`, and the environment report of a diagnostic bundle.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
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
import { extractZip } from "@argelanderspace/infra";
import { afterEach, describe, expect, test } from "vitest";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(PKG, "dist", "bin.js");
const SCRIPT = join(PKG, "scripts", "app-version.mjs");
const APP_PACKAGE_JSON = fileURLToPath(new URL("../../app/package.json", import.meta.url));
const appVersion = (): string =>
  (JSON.parse(readFileSync(APP_PACKAGE_JSON, "utf8")) as { version: string }).version;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** A throwaway home with an empty project in it; no way to the user's session bus (docs/engineering.md). */
function world(): { root: string; dataDir: string; logDir: string; env: NodeJS.ProcessEnv } {
  const root = tempRoot("aspace-cli-version-");
  const dataDir = join(root, "project", "literatures");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(root, "runtime"), { mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    XDG_CONFIG_HOME: join(root, ".config"),
    XDG_DATA_HOME: join(root, ".local", "share"),
    XDG_CACHE_HOME: join(root, ".cache"),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(root, "no-session-bus")}`,
    XDG_RUNTIME_DIR: join(root, "runtime"),
  };
  return { root, dataDir, logDir: join(root, ".local", "share", "argelanderspace", "logs"), env };
}

describe("the app package's version is the only one", () => {
  test("the built CLI's --version, the serve start record and the diagnostics report all show it", async () => {
    const version = appVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    const { root, dataDir, logDir, env } = world();

    // --version: exactly the version and a line break, as commander prints it (frozen format).
    const printed = spawnSync(process.execPath, [BIN, "--version"], { env, encoding: "utf8" });
    expect([printed.status, printed.stdout, printed.stderr]).toEqual([0, `${version}\n`, ""]);

    const child = spawn(process.execPath, [BIN, "serve", "--data-dir", dataDir, "--port", "0"], {
      env,
      cwd: join(root, "project"),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.resume();
    const exited = new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code))
    );
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no start lines; got: ${stdout}`)), 20_000);
        child.stdout.on("data", () => {
          const m = /listening on http:\/\/127\.0\.0\.1:(\d+)\n/.exec(stdout);
          if (m) {
            clearTimeout(timer);
            resolve(Number.parseInt(m[1] as string, 10));
          }
        });
      });

      // The start record.
      const files = readdirSync(logDir);
      expect(files).toHaveLength(1);
      const records = readFileSync(join(logDir, files[0] as string), "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const started = records.filter((record) => record.event === "server.started");
      expect(started).toHaveLength(1);
      expect(started[0]?.version).toBe(version);

      // The environment report of a diagnostic bundle.
      const res = await fetch(`http://127.0.0.1:${port}/api/diagnostics/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(200);
      const out = join(root, "bundle");
      extractZip(new Uint8Array(await res.arrayBuffer()), out);
      const report = JSON.parse(readFileSync(join(out, "environment-report.json"), "utf8")) as {
        app: { version: unknown };
      };
      expect(report.app.version).toBe(version);
    } finally {
      child.kill("SIGTERM");
    }
    expect(await exited).toBe(0);
  }, 60_000);
});

describe("scripts/app-version.mjs", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

  test("writes whatever version the app package has: change it there, rebuild, and the CLI follows", () => {
    const root = tempRoot("aspace-app-version-");
    const pkg = join(root, "package.json");
    const out = join(root, "generated", "app-version.ts");
    for (const version of ["9.8.7", "10.0.0-rc.1"]) {
      writeFileSync(pkg, JSON.stringify({ name: "argelanderspace", version }));
      const r = run("--package", pkg, "--out", out);
      expect([r.status, r.stderr]).toEqual([0, ""]);
      const text = readFileSync(out, "utf8");
      expect(text).toContain(`export const APP_VERSION = ${JSON.stringify(version)};\n`);
      // Exactly one version in the module: the generated one.
      expect(text.match(/\d+\.\d+\.\d+/g)).toEqual([version.replace(/-.*/, "")]);
    }
  });

  test("a package without a usable version is a build error and writes nothing", () => {
    const root = tempRoot("aspace-app-version-");
    const pkg = join(root, "package.json");
    const out = join(root, "app-version.ts");
    for (const body of [
      JSON.stringify({ name: "argelanderspace" }),
      JSON.stringify({ name: "argelanderspace", version: "" }),
      JSON.stringify({ name: "argelanderspace", version: "1.0" }),
      JSON.stringify({ name: "argelanderspace", version: 1 }),
      JSON.stringify({ name: "argelanderspace", version: '1.0.0"; evil()' }),
      "{ not json",
    ]) {
      writeFileSync(pkg, body);
      const r = run("--package", pkg, "--out", out);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/^app-version: /);
      expect(existsSync(out)).toBe(false);
    }
    const missing = run("--package", join(root, "absent.json"), "--out", out);
    expect(missing.status).toBe(1);
    expect(existsSync(out)).toBe(false);
  });

  test("by default it reads the app package of this repository", () => {
    // The module the build generated (pretest builds) holds the app package's version.
    const text = readFileSync(join(PKG, "src", "generated", "app-version.ts"), "utf8");
    expect(text).toContain(`export const APP_VERSION = ${JSON.stringify(appVersion())};\n`);
  });
});
