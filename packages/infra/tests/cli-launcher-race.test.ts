/**
 * The command-line tool's launcher (desktop-app ticket 24): a fresh install that finds something at the name when it
 * links the new file there looks again, and when that something has gone by then, it places the file once more instead
 * of reporting someone else's file. `linkSync` is replaced here to fail once with EEXIST, as if a file had been there
 * for an instant.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const link = vi.hoisted(() => ({ failNext: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    linkSync: (existing: string, target: string) => {
      if (link.failNext > 0) {
        link.failNext--;
        throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
      }
      real.linkSync(existing, target);
    },
  };
});

const { CLI_LAUNCHER_MARK, installCliLauncher } = await import("../src/cli-launcher.js");

const made: string[] = [];
afterEach(() => {
  link.failNext = 0;
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), "cli-launcher-race-"));
  made.push(root);
  mkdirSync(join(root, "home"));
  return join(root, "home");
}

describe("a fresh install racing with a file that comes and goes", () => {
  test("gone again when looked at: placed once more, installed", () => {
    const home = tempHome();
    link.failNext = 1;
    const result = installCliLauncher(
      { node: "/opt/a/node", cli: "/opt/a/bin.js" },
      { platform: "linux", home, env: { PATH: "/usr/bin" } }
    );
    expect(result.outcome).toBe("installed");
    expect(readFileSync(join(home, ".local", "bin", "argelanderspace"), "utf8")).toContain(
      CLI_LAUNCHER_MARK
    );
  });

  test("still in the way the second time: nothing written, reported as it is", () => {
    const home = tempHome();
    link.failNext = 2;
    const result = installCliLauncher(
      { node: "/opt/a/node", cli: "/opt/a/bin.js" },
      { platform: "linux", home, env: { PATH: "/usr/bin" } }
    );
    expect(result.outcome).toBe("foreign");
  });
});
