/**
 * Vitest setup file: points the user's home directory, and the operating system's own per-user directory variables,
 * at a throwaway directory, so nothing a test resolves by default (global data, global cache, config.toml, key
 * files) is the real one of whoever runs the tests. Shared by every package whose tests can reach such a directory;
 * `user-dirs-guard.ts` asserts that it worked.
 *
 * It must run before any module that fixes the home directory when it is imported (env-paths does), so it is listed
 * first in `setupFiles` and imports nothing but Node built-ins and vitest. Anything else a package's setup needs
 * goes in a later setup file.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { USER_DIRS_ISOLATION, type UserDirsIsolation } from "./user-dirs-guard-key.js";

const root = mkdtempSync(join(tmpdir(), "argelander-test-home-"));
const home = join(root, "home");
mkdirSync(home);

const homeVars = { HOME: home, USERPROFILE: home };
// Set whatever the platform: each one is read only where it applies, and the values are the platform's own defaults
// below the home directory, so a test that later keeps nothing but HOME resolves the same places.
const vars: Record<string, string> = {
  ...homeVars,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
};
Object.assign(process.env, vars);
// The workbench's own variables outrank the directories above, so whatever the shell running the tests exported
// must not survive into them; tests that exercise one of these variables pass it explicitly.
for (const k of Object.keys(process.env)) {
  if (k.startsWith("ARGELANDERSPACE_")) delete process.env[k];
}

const isolation: UserDirsIsolation = {
  root,
  vars: Object.keys(vars),
  homeVars: Object.keys(homeVars),
};
(globalThis as Record<symbol, unknown>)[USER_DIRS_ISOLATION] = isolation;

afterAll(() => rmSync(root, { recursive: true, force: true }));
