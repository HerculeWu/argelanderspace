// Filesystem walk shared by dep-dir.mjs (what to prune) and smoke-dep-dir.mjs (what to watch), so both see the same
// packages: hoisted and nested copies alike (dep-dir-lib.mjs stays free of I/O).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Every installed package directory (hoisted and nested), with its package.json. */
export function installedPackages(root) {
  const found = [];
  const visitModules = (modulesDir) => {
    if (!existsSync(modulesDir)) return;
    for (const entry of readdirSync(modulesDir)) {
      if (entry.startsWith(".")) continue;
      const p = join(modulesDir, entry);
      if (entry.startsWith("@")) {
        for (const sub of readdirSync(p)) visitPackage(join(p, sub));
      } else visitPackage(p);
    }
  };
  const visitPackage = (dir) => {
    const pj = join(dir, "package.json");
    if (!existsSync(pj)) return;
    found.push({ dir, pkg: JSON.parse(readFileSync(pj, "utf8")) });
    visitModules(join(dir, "node_modules"));
  };
  visitModules(root);
  return found;
}
