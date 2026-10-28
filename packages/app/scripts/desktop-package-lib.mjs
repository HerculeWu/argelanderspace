// Pure rules of the desktop package (desktop-app ticket 23), tested by desktop-package.test.mjs (part of the app
// package's `test`). Used by desktop-sidecar.mjs (assembles the sidecar the Tauri bundle carries), dep-dir.mjs (the
// vendored license texts in its notices) and smoke-desktop-package.mjs (unpacks a built package and runs it).
import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import {
  PROD_LICENSE_ALLOWED,
  SHELL_CRATE_LICENSE_ALLOWED,
  WITH_LICENSE_ALLOWED,
} from "../../../scripts/license-allowlist.mjs";

/**
 * The Node release the desktop package carries (official nodejs.org build). Change it HERE to move the package to
 * another Node 24 release (desktop-sidecar.mjs `--node-version` overrides it for one run); the version is the one
 * the repository's tests ran on when it was set.
 */
export const DESKTOP_NODE_VERSION = "24.15.0";

const NODE_DIST = "https://nodejs.org/dist";

const NODE_TARGETS = {
  "linux-x64": { os: "linux", arch: "x64", ext: "tar.xz", binary: "bin/node" },
  "linux-arm64": { os: "linux", arch: "arm64", ext: "tar.xz", binary: "bin/node" },
  "darwin-arm64": { os: "darwin", arch: "arm64", ext: "tar.xz", binary: "bin/node" },
  "darwin-x64": { os: "darwin", arch: "x64", ext: "tar.xz", binary: "bin/node" },
  "win32-x64": { os: "win", arch: "x64", ext: "zip", binary: "node.exe" },
};

/** The official Node release archive for a target: where it is, its checksum list and that list's signature. */
export function nodeDist(version, target) {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(`the Node version must be x.y.z, got ${JSON.stringify(version)}`);
  const t = NODE_TARGETS[target];
  if (!t)
    throw new Error(`unknown target ${target} (one of ${Object.keys(NODE_TARGETS).join(", ")})`);
  const base = `node-v${version}-${t.os}-${t.arch}`;
  const dir = `${NODE_DIST}/v${version}`;
  return {
    base,
    file: `${base}.${t.ext}`,
    url: `${dir}/${base}.${t.ext}`,
    shasumsUrl: `${dir}/SHASUMS256.txt`,
    signatureUrl: `${dir}/SHASUMS256.txt.sig`,
    binary: t.binary,
  };
}

/**
 * Whether this run verifies the signature of Node's SHASUMS256.txt. Verifying is the default and needs a keyring;
 * skipping must be asked for explicitly (`--insecure-skip-node-signature`), and the manifest then says so.
 */
export function nodeSignaturePlan({ keyring, insecureSkip } = {}) {
  if (keyring && insecureSkip)
    throw new Error("give --node-keyring or --insecure-skip-node-signature, not both");
  if (keyring) return { verify: true, keyring };
  if (insecureSkip) return { verify: false };
  throw new Error(
    "the signature of Node's SHASUMS256.txt must be verified: give --node-keyring <pubring.kbx> " +
      "(gpg/pubring.kbx of github.com/nodejs/release-keys), or, unsafe, --insecure-skip-node-signature"
  );
}

/**
 * Checks the signature of SHASUMS256.txt with `gpgv` (only the given keyring; never the user's own). On failure the
 * cached SHASUMS256.txt and its signature are removed (`remove(path)`), so that a later run downloads them again
 * instead of reusing a list that did not verify. `run(cmd, argv, {cwd})` returns {status, stderr, error}. A gpgv that cannot
 * be run says so and leaves the cache alone: a missing tool is not a bad signature.
 */
export function verifyNodeSignature({ keyring, shasums, signature, run, remove }) {
  // gpgv takes a keyring name with a colon for a URL ("invalid key resource URL" for D:\..., Git for Windows' gpgv):
  // the keyring is named relative to its own directory, which is gpgv's working directory (desktop-app ticket 30).
  const g = run(
    "gpgv",
    ["--keyring", `./${basename(keyring)}`, resolve(signature), resolve(shasums)],
    { cwd: dirname(resolve(keyring)) }
  );
  if (g.error)
    throw new Error(
      `gpgv could not be run (${g.error.code ?? g.error.name}); install it (Debian/Ubuntu: gpgv) or name the insecure skip`
    );
  if (g.status !== 0) {
    remove(shasums);
    remove(signature);
    throw new Error(
      `the signature of SHASUMS256.txt did not verify against ${keyring} (removed the cached list and signature): ${String(
        g.stderr ?? ""
      )
        .trim()
        .slice(-400)}`
    );
  }
  const by = /Good signature from "([^"]+)"/.exec(g.stderr ?? "")?.[1] ?? "a key in the keyring";
  return { verified: true, detail: `gpgv: good signature from ${by}` };
}

/** The Node signature state an assembled sidecar records (sidecar-manifest.json): only `verified: true` counts. */
export function nodeSignatureFromManifest(manifest) {
  const s = manifest?.node?.signature;
  return {
    verified: s?.verified === true,
    detail: typeof s?.detail === "string" ? s.detail : "no signature record in the manifest",
  };
}

/**
 * The shell's host among its child processes ([{pid, exe}]): the one whose executable is the package's Node. None,
 * or more than one, is null (the smoke then cannot say which process is the host).
 */
export function hostProcess(children, nodeExe) {
  const hits = children.filter((c) => c.exe === nodeExe);
  return hits.length === 1 ? hits[0] : null;
}

/** The sha256 SHASUMS256.txt gives for exactly `file` (one line, `<64 hex>  <file>`). */
export function shaFromShasums(text, file) {
  const hits = text
    .split(/\r?\n/)
    .map((line) => /^([0-9a-f]{64}) {2}(\S+)$/.exec(line))
    .filter((m) => m && m[2] === file);
  if (hits.length === 0) throw new Error(`SHASUMS256.txt has no checksum for ${file}`);
  if (hits.length > 1) throw new Error(`SHASUMS256.txt has more than one checksum for ${file}`);
  return hits[0][1];
}

const KEYRING = {
  "linux-x64": "linux-x64-gnu",
  "linux-arm64": "linux-arm64-gnu",
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "win32-x64": "win32-x64-msvc",
};

/** The keychain module's platform package for a target (its own npm package, one native file). */
export function keyringPackage(target) {
  const k = KEYRING[target];
  if (!k) throw new Error(`unknown target ${target}`);
  return `@napi-rs/keyring-${k}`;
}

/** The keychain module's native file for a target, relative to node_modules. */
export function keyringNativeFile(target) {
  return `${keyringPackage(target)}/keyring.${KEYRING[target]}.node`;
}

/**
 * The license notices of the Rust crates linked into the shell (desktop-app ticket 26), written by shell-notices.mjs
 * into the resource directory next to sidecar/ and skills/ (tauri.package.conf.json maps it).
 */
export const SHELL_NOTICES_FILE = "THIRD-PARTY-SHELL-NOTICES.txt";

/**
 * The tutorial sample in the resource directory (in-app-tutorial ticket 27): desktop-sidecar.mjs copies the repository's
 * tutorial-sample/ here, unpacked, and tauri.package.conf.json maps it; infra `bundledTutorialDir` finds it from the
 * packaged CLI entry (`<resources>/sidecar/app/dist/bin.js` → `<resources>/tutorial`).
 *
 * Kept here, not imported from infra: this module holds pure rules and imports no build output, and infra does not
 * export the name (it is a literal inside `bundledTutorialDir`). desktop-package.test.mjs checks that infra's
 * `bundledTutorialDir` finds the sample at exactly this resource directory.
 */
export const TUTORIAL_RESOURCE_DIR = "tutorial";

/**
 * The files a sidecar must have, relative to the bundle's resource directory: the Node runtime and its license; the
 * app's build (CLI bundle, PDFium worker, page resources, argelander.sty, notices) with its package.json (version, module type) and
 * license; PDFium's WASM and the keychain module's native file in the dependency directory with its notices; the skills;
 * the shell's crate notices; the tutorial sample's marker (what bundledTutorialDir looks for) and its notice.
 */
export function sidecarRequiredFiles(target) {
  const node = nodeDist("0.0.0", target).binary;
  return [
    `sidecar/node/${node}`,
    "sidecar/node/LICENSE",
    "sidecar/app/package.json",
    "sidecar/app/LICENSE",
    "sidecar/app/dist/bin.js",
    "sidecar/app/dist/argelander.sty",
    "sidecar/app/dist/pdfium-worker.js",
    "sidecar/app/dist/web/index.html",
    "sidecar/app/dist/THIRD-PARTY-BUNDLED-NOTICES.txt",
    "sidecar/app/dist/THIRD-PARTY-EDITOR-NOTICES.txt",
    "sidecar/app/dist/THIRD-PARTY-EMBEDPDF-NOTICES.txt",
    "sidecar/app/dist/THIRD-PARTY-MAIL-NOTICES.txt",
    "sidecar/app/dist/THIRD_PARTY_LICENSES.md",
    "sidecar/app/node_modules/@embedpdf/pdfium/dist/pdfium.wasm",
    `sidecar/app/node_modules/${keyringNativeFile(target)}`,
    "sidecar/app/THIRD-PARTY-RUNTIME-NOTICES.txt",
    "sidecar/app/licenses/runtime-licenses.json",
    "sidecar/sidecar-manifest.json",
    "skills/README.md",
    SHELL_NOTICES_FILE,
    `${TUTORIAL_RESOURCE_DIR}/argelanderspace-tutorial.json`,
    `${TUTORIAL_RESOURCE_DIR}/NOTICE.md`,
  ];
}

/** The required files (sidecarRequiredFiles) not under `root`; `exists` is the file system's existsSync. */
export function missingRequiredFiles(root, target, exists) {
  return sidecarRequiredFiles(target).filter((f) => !exists(`${root}/${f}`));
}

/**
 * Entries of the resource directory's tutorial/ that are a library cache (`literatures/library/cache` and anything
 * below it), as `tutorial/...` paths; the assembly and the package smoke fail on any. A library cache holds source data
 * (ADS API terms forbid redistributing anything obtained from ADS); the sample carries none since 2026-10-21, and the
 * npm package's pack-contents rule refuses it the same way (in-app-tutorial tickets 16, 27). `list` is
 * `(dir) => readdirSync(dir, { recursive: true })`; no tutorial/ at all is the required-files check's to report.
 */
export function tutorialCacheEntries(root, list) {
  let entries;
  try {
    entries = list(`${root}/${TUTORIAL_RESOURCE_DIR}`);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .map((e) => String(e).replaceAll("\\", "/"))
    .filter((e) => /(^|\/)literatures\/library\/cache(\/|$)/.test(e))
    .map((e) => `${TUTORIAL_RESOURCE_DIR}/${e}`);
}

/**
 * The cpSync filter for packages/app/dist → sidecar/app/dist: everything but dist/tutorial and dist/skills (the npm
 * build's copies of the sample, ticket 16, and of the skills, project-intake ticket 12). The desktop package carries
 * each once, at the resource directory's tutorial/ and skills/, which is where bundledTutorialDir and bundledSkillsDir
 * look in the packaged layout; a second copy under dist/ would only be dead weight.
 */
export function sidecarAppDistFilter(distRoot) {
  const slash = (p) => p.replaceAll("\\", "/");
  const root = slash(distRoot).replace(/\/+$/, "");
  const skips = [TUTORIAL_RESOURCE_DIR, "skills"].map((d) => `${root}/${d}`);
  return (src) => {
    const p = slash(src);
    return !skips.some((skip) => p === skip || p.startsWith(`${skip}/`));
  };
}

/**
 * The licenses accepted in the desktop package's runtime dependency directory: the production allowlist that
 * scripts/license-scan.mjs also uses (one list, scripts/license-allowlist.mjs; that scan runs on the lockfile's
 * closure, this check on what is shipped).
 */
export const RUNTIME_LICENSE_ALLOWED = PROD_LICENSE_ALLOWED;

/**
 * Whether an SPDX expression is acceptable: OR takes any allowed branch, AND needs all; `X WITH e` only when the
 * whole phrase is in `withAllowed` (empty by default); unparsable: no.
 */
export function evalLicense(expr, allowed, withAllowed = new Set()) {
  if (typeof expr !== "string" || !expr.trim()) return false;
  const tokens = expr.match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const atom = () => {
    const t = tokens[i++];
    if (t === "(") {
      const v = or();
      if (tokens[i++] !== ")") throw new Error("unbalanced");
      return v;
    }
    if (!t || t === ")" || /^(AND|OR|WITH)$/i.test(t)) throw new Error("unexpected");
    if (/^WITH$/i.test(tokens[i] ?? "")) {
      const exception = tokens[i + 1];
      i += 2;
      if (!exception || exception === "(" || exception === ")")
        throw new Error("missing exception");
      return withAllowed.has(`${t} WITH ${exception}`);
    }
    return allowed.has(t);
  };
  const and = () => {
    let v = atom();
    while (/^AND$/i.test(tokens[i] ?? "")) {
      i += 1;
      v = atom() && v;
    }
    return v;
  };
  const or = () => {
    let v = and();
    while (/^OR$/i.test(tokens[i] ?? "")) {
      i += 1;
      v = and() || v;
    }
    return v;
  };
  try {
    const v = or();
    return i === tokens.length ? v : false;
  } catch {
    return false;
  }
}

/** The vendored license entry (packages/app/licenses/runtime-licenses.json) for exactly name@version, or null. */
export function vendoredLicense(manifest, name, version) {
  return manifest.packages.find((p) => p.package === name && p.version === version) ?? null;
}

/**
 * What is wrong with the licenses of the shipped packages. `packages`: [{name, version, license, licenseFiles}] as
 * found in the dependency directory; `vendoredSha(file)`: the sha256 of a vendored file as shipped, or null when it is
 * not there. Each package needs an allowed license and a text: its own license file, or a vendored text recorded for
 * that exact version, present and unchanged, for the same license.
 */
export function licenseProblems({ packages, manifest, vendoredSha }) {
  const problems = [];
  for (const p of packages) {
    const id = `${p.name}@${p.version}`;
    if (!evalLicense(p.license, RUNTIME_LICENSE_ALLOWED, WITH_LICENSE_ALLOWED))
      problems.push(
        `${id}: license ${JSON.stringify(p.license ?? null)} is not in the allowed list`
      );
    if (p.licenseFiles.length > 0) continue;
    const v = vendoredLicense(manifest, p.name, p.version);
    if (!v) {
      problems.push(
        `${id}: no license text (no license file and no vendored text for this version)`
      );
      continue;
    }
    if (v.license !== p.license)
      problems.push(
        `${id}: vendored text is for ${JSON.stringify(v.license)}, the package declares ${JSON.stringify(p.license)}`
      );
    if (vendoredSha(v.file) !== manifest.files[v.file]?.sha256)
      problems.push(
        `${id}: vendored text ${v.file} is missing or differs from its recorded sha256`
      );
  }
  return problems;
}

/**
 * Strict command-line parsing: every argument is a known flag or a known option with a non-empty value that does not
 * look like an option, and none is given twice. A mistyped option must stop a smoke, not quietly run an unbroken one.
 */
export function parseStrictArgs(argv, { valued = [], flags = [] }) {
  const values = {};
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (seen.has(a)) throw new Error(`argument ${a} given twice`);
    if (flags.includes(a)) {
      seen.add(a);
      continue;
    }
    if (!valued.includes(a)) throw new Error(`unknown argument ${JSON.stringify(a)}`);
    const v = argv[i + 1];
    if (v === undefined || v === "" || v.startsWith("--"))
      throw new Error(`argument ${a} needs a value`);
    seen.add(a);
    values[a] = v;
    i += 1;
  }
  return { values, flags: new Set([...seen].filter((a) => flags.includes(a))) };
}

/** A file name that is a license text (the same rule as dep-dir.mjs's notices). */
export const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;

/**
 * Every installed package under a node_modules directory (scoped ones, and nested node_modules), as
 * {dir, name, version, license, licenseFiles}. `fs` gives readdirSync / existsSync / readFileSync, and `join`.
 */
export function listInstalledPackages(root, fs) {
  const found = [];
  const visitModules = (modulesDir) => {
    if (!fs.existsSync(modulesDir)) return;
    for (const entry of fs.readdirSync(modulesDir)) {
      if (entry.startsWith(".")) continue;
      const p = fs.join(modulesDir, entry);
      if (entry.startsWith("@")) for (const sub of fs.readdirSync(p)) visitPackage(fs.join(p, sub));
      else visitPackage(p);
    }
  };
  const visitPackage = (dir) => {
    const pj = fs.join(dir, "package.json");
    if (!fs.existsSync(pj)) return;
    const pkg = JSON.parse(fs.readFileSync(pj, "utf8"));
    found.push({
      dir,
      name: pkg.name,
      version: pkg.version,
      license: typeof pkg.license === "string" ? pkg.license : pkg.license?.type,
      licenseFiles: fs.readdirSync(dir).filter((f) => LICENSE_FILE.test(f)),
    });
    visitModules(fs.join(dir, "node_modules"));
  };
  visitModules(root);
  return found;
}

// ---- desktop-app ticket 26: the release workflow ------------------------------------------------------------------- //

/**
 * The keyring the Node download's signature is checked with: gpg/pubring.kbx of github.com/nodejs/release-keys at one
 * commit, and that file's sha256. Pinned here (fetch-node-keyring.mjs downloads it and refuses other bytes), so that the
 * keys a release trusts change only by a commit to this repository. 481637f8 is the commit ticket 23 verified Node
 * 24.15.0 with ("Good signature"); move both values together, after checking the new commit's keys.
 */
export const NODE_RELEASE_KEYS = {
  commit: "481637f813e912c4aa3622d7964ab426c97b8e8d",
  sha256: "610b8d249da3d5733f5a128def2dd0294dbbf5b5713e6ca2529db8db419dee00",
  url: "https://raw.githubusercontent.com/nodejs/release-keys/481637f813e912c4aa3622d7964ab426c97b8e8d/gpg/pubring.kbx",
};

/** Null when the keyring's bytes have the pinned sha256, otherwise what is wrong. */
export function keyringProblem(bytes, expectedSha256 = NODE_RELEASE_KEYS.sha256) {
  const actual = createHash("sha256").update(bytes).digest("hex");
  return actual === expectedSha256
    ? null
    : `the keyring's sha256 is ${actual}, the pinned one is ${expectedSha256}`;
}

/** The tag a release of this version is made from: `v` and the app package's version (the single source, ticket 16). */
export function releaseTagFor(version) {
  return `v${version}`;
}

/**
 * Null when the git ref is the release tag of `version`, otherwise why not. Accepts `refs/tags/<tag>` (GITHUB_REF) or a
 * bare tag name; a branch ref or an empty one is not a tag.
 */
export function releaseTagProblem(ref, version) {
  const isTag = !!ref && (!ref.startsWith("refs/") || ref.startsWith("refs/tags/"));
  if (!isTag) return `${JSON.stringify(ref)} is not a tag`;
  const tag = ref.replace(/^refs\/tags\//, "");
  return tag === releaseTagFor(version)
    ? null
    : `the tag ${JSON.stringify(tag)} does not match the app package's version ${version} (expected ${releaseTagFor(version)})`;
}

const RUST_TRIPLES = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
};

/** The Rust target triple the shell is built for on a desktop target. */
export function rustTargetTriple(target) {
  const t = RUST_TRIPLES[target];
  if (!t) throw new Error(`unknown target ${target}`);
  return t;
}

/**
 * How the two files the sidecar takes from Node's archive (the binary and LICENSE) are unpacked into `work`: tar for a
 * .tar.xz; a .zip with System32's tar on Windows (bsdtar reads zip) and with unzip elsewhere (GNU tar does not).
 */
export function nodeExtractCommand(dist, archive, work, platform, systemRoot = "C:\\Windows") {
  const entries = [`${dist.base}/${dist.binary}`, `${dist.base}/LICENSE`];
  if (!dist.file.endsWith(".zip"))
    return { cmd: "tar", args: ["-xJf", archive, "-C", work, ...entries] };
  // By its full path: on a runner Git for Windows puts its GNU tar (which reads no zip) earlier on PATH.
  if (platform === "win32")
    return {
      cmd: `${systemRoot.replace(/\\+$/, "")}\\System32\\tar.exe`,
      args: ["-xf", archive, "-C", work, ...entries],
    };
  return { cmd: "unzip", args: ["-q", archive, ...entries, "-d", work] };
}

/**
 * The crates linked into the shell, from `cargo metadata --filter-platform <triple> --features packaged`: everything
 * reachable from the root by normal (not build-only, not dev-only) dependency edges, each once, sorted. Proc-macro
 * crates reached that way are included (they generate code into the binary): declaring more is safer than fewer.
 */
export function linkedCrates(metadata) {
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
  const packages = new Map(metadata.packages.map((p) => [p.id, p]));
  const root = metadata.resolve.root;
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length > 0) {
    const node = nodes.get(queue.pop());
    for (const dep of node?.deps ?? []) {
      if (!dep.dep_kinds.some((k) => k.kind === null)) continue;
      if (seen.has(dep.pkg)) continue;
      seen.add(dep.pkg);
      queue.push(dep.pkg);
    }
  }
  seen.delete(root);
  return [...seen]
    .map((id) => packages.get(id))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** A crate's license field as an SPDX expression: cargo's old `A/B` form means `A OR B`. */
export function cargoLicenseExpression(license) {
  if (typeof license !== "string") return null;
  return license.replace(/\s*\/\s*/g, " OR ");
}

/** A crate's own license file (LICENSE*, LICENCE*, COPYING*, UNLICENSE*). Stricter than LICENSE_FILE: no NOTICE. */
const CRATE_LICENSE_FILE = /^(licen[cs]e|copying|unlicense)([._-]|$)/i;
/** A crate's NOTICE file: shipped with its license, but not a license text by itself. */
const CRATE_NOTICE_FILE = /^notice([._-]|$)/i;

/** Which of a crate's file names are its license texts and which its notices, each sorted. */
export function crateLicenseFiles(names) {
  const sorted = [...names].sort();
  return {
    license: sorted.filter((f) => CRATE_LICENSE_FILE.test(f)),
    notice: sorted.filter((f) => CRATE_NOTICE_FILE.test(f)),
  };
}

/** Whether an SPDX expression names `id` anywhere (any branch). */
function namesLicense(expr, id) {
  return (expr?.match(/[^\s()]+/g) ?? []).includes(id);
}

/**
 * The notices of the shell's crates and what is wrong with them. `crates`: [{name, version, license, repository?,
 * vcs?: {sha1, path}, texts: [{file, text}], notices: [{file, text}]}] where texts are the crate's own license files
 * (`crateLicenseFiles`) and notices its NOTICE files. `vendored`: {manifest, vendoredText(file)} — the crate license
 * manifest (packages/desktop/licenses/crate-licenses.json) and the text of one of its files as shipped, or null.
 *
 * Each crate needs a license on the crate allowlist (scripts/license-allowlist.mjs `SHELL_CRATE_LICENSE_ALLOWED`) and a
 * text: its own license files, or else the vendored texts recorded for exactly its name and version, for the same
 * license and unchanged (sha256). An MPL-2.0 crate's notice also says where its source code is (MPL-2.0 §3.2): its
 * crates.io release and, when known, its repository at the commit it was published from. Nothing is guessed or left
 * out silently.
 */
export function shellNotices(crates, vendored) {
  const problems = [];
  const parts = [];
  for (const c of crates) {
    const id = `${c.name}@${c.version}`;
    const expr = cargoLicenseExpression(c.license);
    if (!evalLicense(expr, SHELL_CRATE_LICENSE_ALLOWED, WITH_LICENSE_ALLOWED))
      problems.push(`${id}: license ${JSON.stringify(expr)} is not in the allowed list`);
    let texts = c.texts.map((t) => ({ label: t.file, text: t.text }));
    if (texts.length === 0) {
      const entry = vendored.manifest.crates.find(
        (v) => v.crate === c.name && v.version === c.version
      );
      if (!entry) {
        problems.push(
          `${id}: no license text (the crate ships no license file and none is vendored)`
        );
      } else {
        if (entry.license !== expr)
          problems.push(
            `${id}: vendored text is for ${JSON.stringify(entry.license)}, the crate declares ${JSON.stringify(expr)}`
          );
        texts = entry.files.map((file) => {
          const text = vendored.vendoredText(file);
          const recorded = vendored.manifest.files[file];
          const sha = text === null ? null : createHash("sha256").update(text).digest("hex");
          if (!recorded || sha !== recorded.sha256)
            problems.push(
              `${id}: vendored text ${file} is missing or differs from its recorded sha256`
            );
          return {
            label: `${file} (vendored; from ${recorded?.source ?? "?"})`,
            text: text ?? "",
          };
        });
      }
    }
    const source = namesLicense(expr, "MPL-2.0")
      ? `Source code: https://crates.io/crates/${c.name}/${c.version} (the published crate: ` +
        `https://static.crates.io/crates/${c.name}/${c.name}-${c.version}.crate)` +
        (c.repository
          ? `; repository ${c.repository}${c.vcs?.sha1 ? ` at commit ${c.vcs.sha1}` : ""}`
          : "") +
        "\n"
      : "";
    const all = [...texts, ...(c.notices ?? []).map((t) => ({ label: t.file, text: t.text }))];
    parts.push(
      `===== ${id} =====\nLicense: ${expr}\n${source}${all.map((t) => `-- ${t.label} --\n${t.text.trimEnd()}`).join("\n\n")}`
    );
  }
  const text =
    "Third-party Rust crates linked into the desktop shell (upstream text; not relicensed by this project).\n\n" +
    `${parts.join("\n\n")}\n`;
  return { problems, text };
}

/** The versions of `name` in pnpm-lock.yaml's `packages:` section (before `snapshots:`), sorted. */
export function lockfileVersions(lockText, name) {
  const section = lockText.split(/^snapshots:/m)[0].split(/^packages:/m)[1] ?? "";
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const re = new RegExp(`^ {2}'?${escaped}@([^'(:\\s]+)'?:`, "gm");
  return [...section.matchAll(re)].map((m) => m[1]).sort();
}

/**
 * What a release run for `target` can tell before it builds anything (release-preflight.mjs): the target's keychain
 * package, in every version the lockfile has, needs a vendored license text (it ships none of its own), or the
 * package's license check fails after a long build. Empty when nothing is wrong.
 */
export function preflightProblems({ target, lockText, manifest }) {
  const name = keyringPackage(target);
  const versions = lockfileVersions(lockText, name);
  if (versions.length === 0) return [`${name} is not in pnpm-lock.yaml`];
  return versions
    .filter((v) => !vendoredLicense(manifest, name, v))
    .map(
      (v) =>
        `${name}@${v} has no vendored license text in packages/app/licenses/runtime-licenses.json (it ships no license file)`
    );
}
