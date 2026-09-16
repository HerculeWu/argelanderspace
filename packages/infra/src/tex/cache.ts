/** Opt-in, caller-owned DERIVED workspace. Ingest keeps its fresh-workspace default. */
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createTexWorkspace, type TexWorkspace, TexWorkspaceError } from "./workspace.js";

export async function writeTexFileIfChanged(
  path: string,
  value: string | Uint8Array
): Promise<void> {
  const bytes = Buffer.from(value);
  try {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new TexWorkspaceError("unsafe-source", `not a regular cache file: ${path}`);
    if ((await fs.readFile(path)).equals(bytes)) return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, bytes);
}

/** Sync only managed source files, preserving unchanged mtimes and compiler intermediates. */
export async function createCachedTexWorkspace(
  srcDir: string,
  cacheDir: string
): Promise<TexWorkspace> {
  const root = resolve(cacheDir);
  const source = await fs.realpath(srcDir);
  if (root === source || root.startsWith(source + sep) || source.startsWith(root + sep)) {
    throw new TexWorkspaceError("unsafe-source", "compile cache must be disjoint from source");
  }
  const copy = await createTexWorkspace(srcDir); // existing symlink/size/containment guards
  try {
    await fs.mkdir(root, { recursive: true });
    if ((await fs.realpath(root)) !== root)
      throw new TexWorkspaceError("unsafe-source", "cache directory may not be a symlink");
    const manifest = join(root, ".argelander-source-files.json");
    let previous: string[] = [];
    try {
      const stat = await fs.lstat(manifest);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new TexWorkspaceError("unsafe-source", "unsafe cache manifest file");
      const parsed: unknown = JSON.parse(await fs.readFile(manifest, "utf8"));
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) previous = parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const from = join(dir, entry.name);
        const rel = relative(copy.dir, from);
        const to = join(root, rel);
        if (entry.isDirectory()) {
          await fs.mkdir(to, { recursive: true });
          if ((await fs.realpath(to)) !== to)
            throw new TexWorkspaceError("unsafe-source", `cache contains a symlink: ${rel}`);
          await walk(from);
        } else {
          files.push(rel);
          await writeTexFileIfChanged(to, await fs.readFile(from));
        }
      }
    };
    await walk(copy.dir);
    for (const rel of previous) {
      if (isAbsolute(rel) || rel.split(/[\\/]/).includes("..") || rel === "")
        throw new TexWorkspaceError("unsafe-source", "unsafe cache manifest");
      if (!files.includes(rel)) {
        const target = join(root, rel);
        const parent = await fs.realpath(dirname(target)).catch((err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") return null;
          throw err;
        });
        if (parent === null) continue;
        if (parent !== dirname(target))
          throw new TexWorkspaceError("unsafe-source", `symlink in stale cache path: ${rel}`);
        await fs.rm(target, { force: true });
      }
    }
    await writeTexFileIfChanged(manifest, JSON.stringify(files.sort()));
    return { dir: root, cleanup: async () => {} };
  } finally {
    await copy.cleanup();
  }
}
