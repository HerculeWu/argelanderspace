/**
 * Small filesystem/path helpers shared by the LaTeX pipeline modules, mirroring
 * the exact `pathlib` semantics the Python originals rely on (lossy UTF-8 reads,
 * `with_suffix`, sorted globs, `is_relative_to` containment).
 */

import { type Dirent, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative } from "node:path";

/** `Path.read_text("utf-8", errors="replace")`. */
export function readTextLossy(p: string): string {
  return new TextDecoder("utf-8").decode(readFileSync(p));
}

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `Path(p).with_suffix(suffix)`: replace the last extension (or append). */
export function withSuffix(p: string, suffix: string): string {
  const base = basename(p);
  const ext = extname(base);
  return ext
    ? join(p.slice(0, p.length - base.length), base.slice(0, -ext.length) + suffix)
    : p + suffix;
}

/** Non-recursive `Path(dir).glob("*.ext")`, sorted by code point like Python's `sorted()`. */
export function globExt(dir: string, ext: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(ext) && isFile(join(dir, n)))
    .sort()
    .map((n) => join(dir, n));
}

/** Recursive `Path(root).rglob("*.ext")`, sorted by code point. */
export function rglobExt(root: string, ext: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith(ext)) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/** Recursive file list (`Path.rglob("*")` filtered to files, directory order). */
export function rglobFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) out.push(p);
    }
  };
  walk(root);
  return out;
}

/**
 * `p.resolve().is_relative_to(base.resolve())` — resolve() follows symlinks, so
 * this is a realpath containment check. False when either path cannot resolve.
 */
export function withinTree(base: string, p: string): boolean {
  try {
    const rel = relative(realpathSync(base), realpathSync(p));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  } catch {
    return false;
  }
}
