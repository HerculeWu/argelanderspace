/**
 * Vitest setup file: every temporary directory a test file creates with `mkdtemp` / `mkdtempSync` (fs, fs.promises)
 * under the operating system's temp directory is removed again when that file's tests have finished. Tests build their
 * fixtures with `mkdtempSync(join(tmpdir(), "aspace-…"))` in dozens of places and, before this, none of them cleaned
 * up: a day of full runs filled /tmp with tens of thousands of directories (web-test-flake ticket 06).
 *
 * The registration lives here, at the one seam every such call goes through, instead of in each helper, so a new
 * test's directory is covered without remembering to do anything. Only directories directly created below
 * `os.tmpdir()` are registered; one a test made elsewhere (a path it chose itself) stays the test's own business.
 * Removal runs in an `afterAll` of the worker, after the file's own hooks, and ignores a directory that is already
 * gone or cannot be removed. Child processes a test spawns are finished by then (the tests stop what they start in
 * their own hooks); a straggler writing into a removed directory fails in that child, not in the suite. What a
 * straggler re-creates after that is swept by `global-temp-dir.ts` at the end of the run.
 *
 * It registers every such directory the process creates, product code's own `mkdtemp` calls included (the Writer
 * workspace, the numbering compute, acquisition). That removal is housekeeping, not a check: it can hide a product
 * leak, so whether the product removes its own temporary directory is still asserted inside the test that exercises it
 * (see environment.test.ts, which looks for what is left after the call).
 *
 * Shared like `isolate-user-dirs.ts`; listed in `setupFiles` of every package whose tests make temporary directories.
 * It imports no product module.
 */

import fs, { rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterAll } from "vitest";

const made = new Set<string>();

function register(dir: string): string {
  try {
    if (resolve(dirname(dir)) === resolve(tmpdir())) made.add(dir);
    // Nested creation (mkdtemp under a registered root) is cleaned with the root.
  } catch {
    /* registration never breaks the call it observes */
  }
  return dir;
}

const original = {
  sync: fs.mkdtempSync,
  callback: fs.mkdtemp,
  promise: fs.promises.mkdtemp,
};

// The three overloads return a string for the default encoding; a "buffer" encoding is not used by any test and is
// passed through unregistered.
fs.mkdtempSync = ((...args: Parameters<typeof original.sync>) => {
  const dir = (original.sync as (...a: unknown[]) => string | Buffer)(...args);
  return typeof dir === "string" ? register(dir) : dir;
}) as typeof fs.mkdtempSync;

fs.mkdtemp = ((...args: unknown[]) => {
  const last = args[args.length - 1];
  if (typeof last !== "function") return (original.callback as (...a: unknown[]) => void)(...args);
  const done = last as (err: Error | null, dir?: string) => void;
  const wrapped = (err: Error | null, dir?: string): void => {
    if (!err && typeof dir === "string") register(dir);
    done(err, dir);
  };
  return (original.callback as (...a: unknown[]) => void)(...args.slice(0, -1), wrapped);
}) as typeof fs.mkdtemp;

fs.promises.mkdtemp = (async (...args: Parameters<typeof original.promise>) => {
  const dir = await (original.promise as (...a: unknown[]) => Promise<string | Buffer>)(...args);
  return typeof dir === "string" ? register(dir) : dir;
}) as typeof fs.promises.mkdtemp;

// Named imports (`import { mkdtempSync } from "node:fs"`) bind to the ESM view of the built-in; refresh it.
syncBuiltinESMExports();

function remove(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* a directory still in use by a straggler is left to the operating system */
  }
}

afterAll(() => {
  for (const dir of made) remove(dir);
  made.clear();
});
