// The published binary prints the app package's version (desktop-app ticket 16: the version has one source,
// packages/app/package.json, written into the CLI at build time and inlined into dist/bin.js). Needs the build.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

test("the bundled CLI's --version is the app package's version", () => {
  const bin = join(appRoot, "dist", "bin.js");
  assert.ok(existsSync(bin), "dist/bin.js is missing: build the app package first");
  const { version } = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8"));
  // A throwaway home: --version reads and writes nothing, and must not reach the user's directories if it did.
  const home = mkdtempSync(join(tmpdir(), "aspace-app-version-"));
  try {
    mkdirSync(join(home, "runtime"), { mode: 0o700 });
    const r = spawnSync(process.execPath, [bin, "--version"], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        XDG_CACHE_HOME: join(home, ".cache"),
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(home, "no-session-bus")}`,
        XDG_RUNTIME_DIR: join(home, "runtime"),
      },
    });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, `${version}\n`, ""]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
