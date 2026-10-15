// Pure rules of the desktop package (desktop-app ticket 23), tested by desktop-package.test.mjs (part of the app
// package's `test`). Used by desktop-sidecar.mjs (assembles the sidecar the Tauri bundle carries), dep-dir.mjs (the
// vendored license texts in its notices) and smoke-desktop-package.mjs (unpacks a built package and runs it).
import { PROD_LICENSE_ALLOWED, WITH_LICENSE_ALLOWED } from "../../../scripts/license-allowlist.mjs";

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
 * instead of reusing a list that did not verify. `run(cmd, argv)` returns {status, stderr}.
 */
export function verifyNodeSignature({ keyring, shasums, signature, run, remove }) {
  const g = run("gpgv", ["--keyring", keyring, signature, shasums]);
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

/** The keychain module's native file for a target, relative to node_modules. */
export function keyringNativeFile(target) {
  const k = KEYRING[target];
  if (!k) throw new Error(`unknown target ${target}`);
  return `@napi-rs/keyring-${k}/keyring.${k}.node`;
}

/**
 * The files a sidecar must have, relative to the bundle's resource directory: the Node runtime and its license; the
 * app's build (CLI bundle, page resources, argelander.sty, notices) with its package.json (version, module type) and
 * license; PDFium's WASM and the keychain module's native file in the dependency directory with its notices; the skills.
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
  ];
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
