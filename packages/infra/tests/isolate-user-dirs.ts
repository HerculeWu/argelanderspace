/**
 * Vitest setup file: points the user's home directory, and the operating system's own per-user directory variables,
 * at a throwaway directory, so nothing a test resolves by default (global data, global cache, config.toml, key
 * files) is the real one of whoever runs the tests. Shared by every package whose tests can reach such a directory;
 * `user-dirs-guard.ts` asserts that it worked.
 *
 * It must run before any module that fixes the home directory when it is imported (env-paths does), so it is listed
 * first in `setupFiles` and imports no product module. Anything else a package's setup needs goes in a later setup
 * file. It relies on Vitest's default forks pool: in a worker thread, writing process.env does not reach the real
 * environment that os.homedir() reads (the guard fails there).
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

// The OS keychain (desktop-app ticket 12): the credential store reaches it over the user's D-Bus session bus (Secret
// Service). A test that reaches a store's default backend, and every child process a test spawns with a copy of this
// environment, must find no bus: a bus address that leads nowhere, no X11 / Wayland display through which libdbus
// could discover the user's bus, and a runtime directory (where `$XDG_RUNTIME_DIR/bus` would be looked for) inside
// the throwaway root. The keychain then reads as unavailable, which the store reports as such.
const runtimeDir = join(root, "runtime");
mkdirSync(runtimeDir, { mode: 0o700 });
process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${join(root, "no-session-bus")}`;
process.env.XDG_RUNTIME_DIR = runtimeDir;
delete process.env.DISPLAY;
delete process.env.WAYLAND_DISPLAY;
delete process.env.DBUS_SYSTEM_BUS_ADDRESS;

const isolation: UserDirsIsolation = {
  root,
  vars: Object.keys(vars),
  homeVars: Object.keys(homeVars),
};
(globalThis as Record<symbol, unknown>)[USER_DIRS_ISOLATION] = isolation;

afterAll(() => rmSync(root, { recursive: true, force: true }));
