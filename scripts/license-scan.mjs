#!/usr/bin/env node
// Offline, read-only license scan of pnpm-lock.yaml (Mail ticket 10; method in docs/engineering.md).
// Reads the lockfile for the dependency closure and each installed package's package.json for its
// license field. Never touches the network and writes nothing. Run after `corepack pnpm install`.
//   node scripts/license-scan.mjs [--list] [--root <dir>]
// Exit codes: 0 clean; 1 findings (forbidden license or version, license outside the production
// allowlist, unreadable license, or a package that is neither installed nor a lockfile-declared
// platform-optional binary); 2 lockfile or node_modules/.pnpm missing (nothing was checked).
// Copying code from a forbidden project cannot be found here; that is a review matter.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROD_LICENSE_ALLOWED, WITH_LICENSE_ALLOWED } from "./license-allowlist.mjs";

const args = process.argv.slice(2);
const rootArg = args.indexOf("--root");
const root =
  rootArg >= 0 ? resolve(args[rootArg + 1]) : fileURLToPath(new URL("..", import.meta.url));
const listAll = args.includes("--list");

// Production allowlist and allowed `WITH` phrases: shared with the desktop package's license check.
const PROD_ALLOWED = PROD_LICENSE_ALLOWED;
const WITH_ALLOWED = WITH_LICENSE_ALLOWED;
// Dev closure: denylist. Anything outside PROD_ALLOWED that is not forbidden is listed for a human.
const FORBIDDEN =
  /(^|[^A-Z])(A?GPL|LGPL|EUPL|SSPL|BUSL|CC-BY-NC|Elastic|Commons-Clause|PolyForm|UNLICENSED|SEE LICENSE|Proprietary|Commercial)/i;
// Versions that were published under a forbidden license (spec: imapflow 1.0.28-1.0.63 AGPL,
// nodemailer 3.x EUPL). Checked for every package in the lockfile, production and dev.
const BANNED_VERSIONS = [
  {
    name: "imapflow",
    why: "1.0.28-1.0.63 were AGPL",
    test: (v) => within(v, [1, 0, 28], [1, 0, 63]),
  },
  { name: "nodemailer", why: "3.x was EUPL", test: (v) => semver(v)?.[0] === 3 },
];
function semver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function within(v, lo, hi) {
  const s = semver(v);
  if (!s) return false;
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  return cmp(s, lo) >= 0 && cmp(s, hi) <= 0;
}

// ---- SPDX expression evaluation: OR < AND < WITH, parentheses; null when unparsable ------------
function evalExpr(expr, pred) {
  const tokens = expr.match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  function parseOr() {
    let ok = parseAnd();
    while (peek()?.toUpperCase() === "OR") {
      i++;
      const r = parseAnd();
      ok = ok || r;
    }
    return ok;
  }
  function parseAnd() {
    let ok = parseAtom();
    while (peek()?.toUpperCase() === "AND") {
      i++;
      const r = parseAtom();
      ok = ok && r;
    }
    return ok;
  }
  function parseAtom() {
    const t = tokens[i++];
    if (t === undefined) throw new Error("unexpected end");
    if (t === "(") {
      const ok = parseOr();
      if (tokens[i++] !== ")") throw new Error("missing )");
      return ok;
    }
    if (t === ")" || ["AND", "OR", "WITH"].includes(t.toUpperCase())) throw new Error("unexpected");
    if (peek()?.toUpperCase() === "WITH") {
      i++;
      const exception = tokens[i++];
      if (exception === undefined) throw new Error("missing exception");
      return WITH_ALLOWED.has(`${t} WITH ${exception}`);
    }
    return pred(t);
  }
  try {
    const ok = parseOr();
    return i === tokens.length ? ok : null;
  } catch {
    return null;
  }
}
const isMulti = (lic) => /\sOR\s/i.test(lic);

// ---- lockfile -----------------------------------------------------------------------------------
const lockFile = join(root, "pnpm-lock.yaml");
const store = join(root, "node_modules", ".pnpm");
if (!existsSync(lockFile) || !existsSync(store)) {
  console.error(
    `${!existsSync(lockFile) ? "pnpm-lock.yaml" : "node_modules/.pnpm"} missing under ${root}: ` +
      "nothing was checked (run `corepack pnpm install` first)"
  );
  process.exit(2);
}
const lock = readFileSync(lockFile, "utf8").split("\n");
const stripPeers = (spec) => spec.replace(/\(.*$/, "");
const unquote = (s) => s.replace(/:$/, "").replace(/^'|'$/g, "");
// `name: version`, or the pnpm v9 alias form `alias: realname@version`; null for link:/file: refs.
function resolveRef(name, value) {
  const v = stripPeers(value.trim());
  if (/^(link|file|workspace):/.test(v)) return null;
  const alias = /^(@?[^@\s]+)@(.+)$/.exec(v);
  return alias ? `${alias[1]}@${alias[2]}` : `${name}@${v}`;
}
function idOfKey(key) {
  const k = stripPeers(unquote(`${key}:`));
  const i = k.lastIndexOf("@");
  return `${k.slice(0, i)}@${k.slice(i + 1)}`;
}

const prodRoots = new Set();
const devRoots = new Set();
const platformDeclared = new Set(); // packages: entries with os/cpu/libc
const optionalSnapshots = new Set(); // snapshots: entries with `optional: true`
const edges = new Map(); // peer variants of one name@version merge into one entry
let section = "";
let group = "";
let curName = "";
let cur = null;
for (const line of lock) {
  if (/^\S/.test(line)) section = line.replace(":", "").trim();
  if (section === "importers") {
    const g = /^ {4}(dependencies|devDependencies|optionalDependencies):$/.exec(line);
    const n = /^ {6}(\S.*):$/.exec(line);
    const v = /^ {8}version: (.+)$/.exec(line);
    if (g) group = g[1];
    else if (n) curName = unquote(n[1]);
    else if (v && group) {
      const id = resolveRef(curName, v[1]);
      if (id) (group === "devDependencies" ? devRoots : prodRoots).add(id);
    }
  } else if (section === "packages") {
    const k = /^ {2}(\S.*?):$/.exec(line);
    if (k) cur = idOfKey(k[1]);
    else if (cur && /^ {4}(os|cpu|libc):/.test(line)) platformDeclared.add(cur);
  } else if (section === "snapshots") {
    const k = /^ {2}(\S.*?):( \{\})?$/.exec(line);
    const d = /^ {6}(\S.*?): (\S+)$/.exec(line);
    if (k) {
      cur = idOfKey(k[1]);
      if (!edges.has(cur)) edges.set(cur, new Set());
    } else if (cur && /^ {4}optional: true$/.test(line)) optionalSnapshots.add(cur);
    else if (d && cur) {
      const id = resolveRef(unquote(`${d[1]}:`), d[2]);
      if (id) edges.get(cur).add(id);
    }
  }
}
function closure(roots) {
  const seen = new Set();
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of edges.get(id) ?? []) stack.push(e);
  }
  return seen;
}
const prod = closure(prodRoots);
const dev = new Set([...closure(devRoots)].filter((id) => !prod.has(id)));
// Only a lockfile-declared optional platform binary may be missing from node_modules.
const platformOptional = (id) => optionalSnapshots.has(id) && platformDeclared.has(id);

// ---- installed package metadata, indexed by real name@version ------------------------------------
const installed = new Map();
for (const dir of readdirSync(store)) {
  const nm = join(store, dir, "node_modules");
  if (!existsSync(nm)) continue;
  for (const ent of readdirSync(nm)) {
    const entries = ent.startsWith("@")
      ? readdirSync(join(nm, ent)).map((s) => `${ent}/${s}`)
      : [ent];
    for (const entry of entries) {
      const file = join(nm, entry, "package.json");
      if (!existsSync(file)) continue;
      try {
        const pkg = JSON.parse(readFileSync(file, "utf8"));
        if (pkg.name && pkg.version) installed.set(`${pkg.name}@${pkg.version}`, pkg);
      } catch {
        // unreadable metadata surfaces as "not installed" -> unknown below
      }
    }
  }
}
function licenseOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return `(${pkg.licenses.map((l) => l.type ?? l).join(" OR ")})`;
  return null;
}

function report(label, ids, strict) {
  const dist = new Map();
  const skipped = [];
  const bad = [];
  const unknown = [];
  const review = [];
  const choices = [];
  const rows = [];
  for (const id of [...ids].sort()) {
    const at = id.lastIndexOf("@");
    const name = id.slice(0, at);
    const version = id.slice(at + 1);
    for (const b of BANNED_VERSIONS)
      if (b.name === name && b.test(version)) bad.push(`${id} (forbidden version: ${b.why})`);
    const pkg = installed.get(id);
    if (!pkg) {
      if (platformOptional(id)) skipped.push(id);
      else
        unknown.push(`${id} (not installed and not a lockfile-declared optional platform package)`);
      continue;
    }
    const lic = licenseOf(pkg);
    rows.push(`${id}\t${lic ?? "?"}`);
    if (!lic) {
      unknown.push(`${id} (no license field)`);
      continue;
    }
    dist.set(lic, (dist.get(lic) ?? 0) + 1);
    const allowed = evalExpr(lic, (t) => PROD_ALLOWED.has(t));
    const notForbidden = evalExpr(lic, (t) => !FORBIDDEN.test(t));
    if (allowed === null) unknown.push(`${id} (unparsable license: ${lic})`);
    else if (allowed) {
      if (isMulti(lic)) choices.push(`${id}: ${lic}`);
    } else if (strict) unknown.push(`${id} (outside the production allowlist: ${lic})`);
    else if (!notForbidden) bad.push(`${id} (${lic})`);
    else review.push(`${id}: ${lic}`);
  }
  console.log(
    `\n== ${label}: ${ids.size} in lockfile, ${ids.size - skipped.length} inspected, ` +
      `${skipped.length} platform-optional not installed ==`
  );
  for (const [l, n] of [...dist].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(4)}  ${l}`);
  const block = (title, items) =>
    items.length && console.log(`  ${title}:\n    ${items.join("\n    ")}`);
  block("multi-license (an allowed alternative exists; record the choice)", choices);
  block("outside the production allowlist, not forbidden (human review)", review);
  block(
    "platform-optional, not installed (lockfile: optional + os/cpu/libc; license NOT inspected)",
    skipped
  );
  block("UNKNOWN (review by hand)", unknown);
  block("FORBIDDEN", bad);
  if (listAll) console.log(rows.map((r) => `  ${r}`).join("\n"));
  return bad.length + unknown.length;
}

console.log(
  "Forbidden: GPL, AGPL, LGPL, EUPL-only, SSPL, BUSL, non-commercial, source-available/commercial, " +
    "UNLICENSED, SEE LICENSE IN; imapflow 1.0.28-1.0.63; nodemailer 3.x."
);
const pFail = report("production closure (every workspace package's dependencies)", prod, true);
const dFail = report("dev-only closure", dev, false);
console.log(
  pFail + dFail > 0
    ? `\nRESULT: ${pFail} production and ${dFail} dev finding(s) need review`
    : "\nRESULT: no forbidden, unknown or non-allowlisted license"
);
process.exit(pFail + dFail > 0 ? 1 : 0);
