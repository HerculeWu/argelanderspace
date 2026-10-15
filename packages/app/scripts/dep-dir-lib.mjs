// Pure rules of the desktop dependency directory (desktop-app ticket 22). Used by dep-dir.mjs; tested by
// dep-dir.test.mjs (part of `pnpm --filter argelanderspace test`). No I/O here.

/** The three kinds of package the generator may remove, in the order the ticket names them. */
export const PRUNE_CATEGORIES = ["fonts", "foreign", "esbuild"];

/**
 * The part of the repo lockfile that the app package's production dependencies reach, rewritten so that those
 * dependencies are the root importer (`.`) of a standalone project. Optional platform packages stay listed: pnpm
 * installs only the ones that match the target (`supportedArchitectures`). Throws when the importer or any reached
 * entry is missing, so a stale lockfile never yields a silently partial directory.
 */
export function subsetLockfile(lockText, importer) {
  const escaped = importer.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const found = new RegExp(`\\n {2}${escaped}:\\n {4}dependencies:\\n((?: {6}.*\\n)+)`).exec(
    lockText
  );
  if (!found) throw new Error(`lockfile has no ${importer} importer with dependencies`);
  const depBlock = found[1];
  const specs = [
    ...depBlock.matchAll(/ {6}'?([^':\n]+)'?:\n {8}specifier: (.+)\n {8}version: (.+)\n/g),
  ];
  const dependencies = Object.fromEntries(specs.map((m) => [m[1], m[2]]));
  const head = lockText.slice(0, lockText.indexOf("importers:"));
  const rest = lockText.slice(lockText.indexOf("\npackages:\n"));
  const [packagesText, snapshotsText] = rest.split("\nsnapshots:\n");
  const blocks = (text) =>
    new Map(
      [...text.matchAll(/^ {2}(\S.*?):(?: \{\}\n|\n(?: {4}.*\n)*)/gm)].map((m) => [
        m[1].replace(/^'|'$/g, ""),
        m[0],
      ])
    );
  const snapshotBlocks = blocks(snapshotsText ?? "");
  const packageBlocks = blocks(packagesText);
  const wanted = new Set();
  const queue = specs.map((m) => `${m[1]}@${m[3]}`);
  while (queue.length > 0) {
    const key = queue.pop();
    if (wanted.has(key)) continue;
    const block = snapshotBlocks.get(key);
    if (!block) throw new Error(`lockfile has no snapshot ${key}`);
    wanted.add(key);
    for (const dep of block.matchAll(/^ {6}'?([^':\n]+)'?: (\S.*)$/gm))
      queue.push(`${dep[1]}@${dep[2]}`);
  }
  const sortedWanted = [...wanted].sort();
  const keptSnapshots = sortedWanted.map((key) => snapshotBlocks.get(key)).join("\n");
  const keptPackages = [...new Set(sortedWanted.map((key) => key.replace(/\(.*$/, "")))]
    .sort()
    .map((key) => {
      const block = packageBlocks.get(key);
      if (!block) throw new Error(`lockfile has no package ${key}`);
      return block;
    })
    .join("\n");
  const importers = `importers:\n\n  .:\n    dependencies:\n${depBlock}`;
  const lockfile = `${head}${importers}\npackages:\n\n${keptPackages}\nsnapshots:\n\n${keptSnapshots}`;
  return { lockfile, dependencies, packages: sortedWanted.length };
}

/** npm's `os` / `cpu` / `libc` semantics: a list of allowed values, or of `!value` exclusions. */
function listAllows(list, value) {
  if (!Array.isArray(list) || list.length === 0) return true;
  const negated = list.filter((v) => v.startsWith("!"));
  if (negated.includes(`!${value}`)) return false;
  const positive = list.filter((v) => !v.startsWith("!"));
  return positive.length === 0 || positive.includes(value);
}

/** Whether a package.json's platform fields admit the target `{platform, arch, libc}` (libc only on Linux). */
export function matchesTarget(pkg, target) {
  return (
    listAllows(pkg.os, target.platform) &&
    listAllows(pkg.cpu, target.arch) &&
    (target.platform !== "linux" || !target.libc || listAllows(pkg.libc, target.libc))
  );
}

/**
 * What to remove of an installed package, or null when it is not a candidate:
 *   fonts   - the font files (`fonts/`) of the PDF engine's font packages (`@embedpdf/fonts-*`). The package itself
 *             stays: `@embedpdf/engines/pdfium` imports each one's JS manifest statically, so removing the whole
 *             package breaks loading the engine (ticket 22 smoke).
 *   foreign - a whole package whose os/cpu/libc fields exclude the target (another platform's native file)
 *   esbuild - esbuild and its platform binaries, the whole package
 * `remove` is relative to the package directory ("." is the package itself).
 */
export function pruneAction(pkg, target) {
  const name = pkg.name ?? "";
  if (/^@embedpdf\/fonts-/.test(name)) return { category: "fonts", remove: "fonts" };
  if (name === "esbuild" || name.startsWith("@esbuild/"))
    return { category: "esbuild", remove: "." };
  if (!matchesTarget(pkg, target)) return { category: "foreign", remove: "." };
  return null;
}

const OSES = [
  "aix",
  "android",
  "darwin",
  "freebsd",
  "linux",
  "netbsd",
  "openbsd",
  "sunos",
  "win32",
];
const ARCHES = ["arm", "arm64", "ia32", "loong64", "mips64el", "ppc64", "riscv64", "s390x", "x64"];

/**
 * Whether a directory inside a package (path relative to the package, `/`-separated) holds another platform's
 * prebuilt native files: a `prebuilds/<os>-<arch>[-<libc>]` directory (the prebuildify layout, e.g. pi-tui's
 * `native/darwin/prebuilds/darwin-arm64`) that is not the target's.
 */
export function foreignPrebuild(relDir, target) {
  const parts = relDir.split("/");
  if (parts.length < 2 || parts.at(-2) !== "prebuilds") return false;
  const m = /^([a-z0-9]+)-([a-z0-9]+)(?:-([a-z]+))?$/.exec(parts.at(-1));
  if (!m || !OSES.includes(m[1]) || !ARCHES.includes(m[2])) return false;
  if (m[1] !== target.platform || m[2] !== target.arch) return true;
  const libc = m[3] === "gnu" ? "glibc" : m[3];
  return target.platform === "linux" && !!libc && !!target.libc && libc !== target.libc;
}

/**
 * The lockfile's packages that carry os/cpu/libc fields and admit the target (`name@version`, sorted): the target's
 * own native packages. An offline install whose store lacks one of them silently skips it (it is optional), so the
 * generator checks that every one of these was installed.
 */
export function expectedPlatformPackages(lockText, target) {
  const packagesText = lockText.slice(
    lockText.indexOf("\npackages:\n"),
    lockText.indexOf("\nsnapshots:\n")
  );
  const field = (block, key) => {
    const m = new RegExp(`\\n {4}${key}: \\[([^\\]]*)\\]`).exec(block);
    return m ? m[1].split(",").map((v) => v.trim().replace(/^'|'$/g, "")) : undefined;
  };
  const found = [];
  for (const m of packagesText.matchAll(/^ {2}(\S.*?):\n((?: {4}.*\n)*)/gm)) {
    const block = `\n${m[2]}`;
    const pkg = { os: field(block, "os"), cpu: field(block, "cpu"), libc: field(block, "libc") };
    if (!pkg.os && !pkg.cpu && !pkg.libc) continue;
    if (matchesTarget(pkg, target)) found.push(m[1].replace(/^'|'$/g, ""));
  }
  return found.sort();
}
