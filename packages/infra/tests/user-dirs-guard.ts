/**
 * The guard behind test isolation: every user-level directory the product resolves must land inside the throwaway
 * root that `isolate-user-dirs.ts` set up. A failure here means the isolation is off, and the other tests in the
 * package may be reading or writing the real directories of whoever runs them.
 *
 * Each package that resolves user-level directories calls `describeUserDirsGuard` from one test file, handing in the
 * resolver its own tests reach (source or built), so the check covers the module instance those tests use.
 */

import { isAbsolute, relative } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { USER_DIRS_ISOLATION, type UserDirsIsolation } from "./user-dirs-guard-key.js";

function isolation(): UserDirsIsolation | undefined {
  return (globalThis as Record<symbol, unknown>)[USER_DIRS_ISOLATION] as
    | UserDirsIsolation
    | undefined;
}

function inside(root: string, dir: string): boolean {
  const rel = relative(root, dir);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * `resolveDirs` returns the user-level directories by name, resolved the way the product does by default (no injected
 * environment or config). A new kind of user-level directory is guarded by adding it to that record.
 */
export function describeUserDirsGuard(resolveDirs: () => Record<string, string>): void {
  describe("test isolation of user-level directories", () => {
    const saved = { ...process.env };
    afterEach(() => {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    });

    function expectAllInside(): void {
      const root = isolation()?.root;
      expect(root, "isolate-user-dirs.ts did not run before this test file").toBeTypeOf("string");
      const dirs = resolveDirs();
      expect(Object.keys(dirs).length).toBeGreaterThan(0);
      for (const [name, dir] of Object.entries(dirs)) {
        expect(inside(root as string, dir), `${name} directory is outside the isolated root`).toBe(
          true
        );
      }
    }

    test("every resolved directory is inside the isolated root", () => {
      expectAllInside();
    });

    // With the directory variables gone, what is left is the home directory that was already fixed when the
    // resolver was first imported, so that one has to be the isolated one too. (Tests that replace process.env
    // wholesale do not get here: the resolver keeps reading the original object, which still has the variables.)
    test("still inside with only the home directory left to go by", () => {
      const iso = isolation();
      for (const k of iso?.vars ?? []) if (!iso?.homeVars.includes(k)) delete process.env[k];
      expectAllInside();
    });
  });
}
