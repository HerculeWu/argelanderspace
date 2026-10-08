// Reproducible tests for scripts/license-scan.mjs (Mail ticket 10): each case builds a tiny pnpm-lock.yaml and a
// fake node_modules/.pnpm in a temp dir and runs the real script on it with --root. Offline, nothing outside the
// temp dir is touched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scan = fileURLToPath(new URL("../../../scripts/license-scan.mjs", import.meta.url));

/**
 * deps / devDeps: { name: version } roots of one importer.
 * snapshots: { "name@ver" or "name@ver(peer)": { deps: {name: ref}, optional: bool } }
 * platform: ids that get os/cpu in `packages:`.
 * installed: [{ name, version, license }] written under node_modules/.pnpm.
 */
function fixture({
  deps = {},
  devDeps = {},
  snapshots = {},
  platform = [],
  installed = [],
  pnpm = true,
}) {
  const dir = mkdtempSync(join(tmpdir(), "license-scan-"));
  const group = (title, map) =>
    Object.keys(map).length
      ? `    ${title}:\n${Object.entries(map)
          .map(([n, v]) => `      '${n}':\n        specifier: '*'\n        version: ${v}`)
          .join("\n")}\n`
      : "";
  let text = "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n";
  text += group("dependencies", deps) + group("devDependencies", devDeps);
  text += "\npackages:\n\n";
  for (const key of Object.keys(snapshots)) {
    const id = key.replace(/\(.*$/, "");
    text += `  ${id}:\n    resolution: {integrity: sha512-x}\n`;
    if (platform.includes(id)) text += "    cpu: [arm64]\n    os: [darwin]\n";
    text += "\n";
  }
  text += "snapshots:\n\n";
  for (const [key, s] of Object.entries(snapshots)) {
    text += `  ${key}:\n`;
    if (s.optional) text += "    optional: true\n";
    if (s.deps)
      text += `    dependencies:\n${Object.entries(s.deps)
        .map(([n, v]) => `      ${n}: ${v}`)
        .join("\n")}\n`;
    text += "\n";
  }
  writeFileSync(join(dir, "pnpm-lock.yaml"), text);
  if (pnpm) {
    for (const p of installed) {
      const pkgDir = join(
        dir,
        "node_modules",
        ".pnpm",
        `${p.name.replace("/", "+")}@${p.version}`,
        "node_modules",
        p.name
      );
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({ name: p.name, version: p.version, license: p.license })
      );
    }
    mkdirSync(join(dir, "node_modules", ".pnpm"), { recursive: true });
  }
  return dir;
}

function run(opts) {
  const dir = fixture(opts);
  try {
    const r = spawnSync(process.execPath, [scan, "--root", dir], { encoding: "utf8" });
    return { code: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const one = (name, version, license) => ({
  deps: { [name]: version },
  snapshots: { [`${name}@${version}`]: {} },
  installed: [{ name, version, license }],
});

test("a permissive installed dependency passes", () => {
  assert.equal(run(one("good", "1.0.0", "MIT")).code, 0);
});

test("a GPL-only installed dependency fails", () => {
  const r = run(one("gpl-only-newdep", "1.0.0", "GPL-3.0-only"));
  assert.equal(r.code, 1);
  assert.match(r.out, /outside the production allowlist|FORBIDDEN/);
});

test("a dependency missing from node_modules that is not a declared platform binary is unknown (exit 1)", () => {
  const r = run({
    deps: { "gpl-only-newdep": "1.0.0" },
    snapshots: { "gpl-only-newdep@1.0.0": {} },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /gpl-only-newdep@1\.0\.0 \(not installed/);
});

test("optional alone does not exempt a missing package; optional with os/cpu does", () => {
  const optionalOnly = run({
    deps: { bin: "1.0.0" },
    snapshots: { "bin@1.0.0": { optional: true } },
  });
  assert.equal(optionalOnly.code, 1);
  const platformBinary = run({
    deps: { bin: "1.0.0" },
    snapshots: { "bin@1.0.0": { optional: true } },
    platform: ["bin@1.0.0"],
  });
  assert.equal(platformBinary.code, 0);
  assert.match(platformBinary.out, /bin@1\.0\.0/);
  const platformNotOptional = run({
    deps: { bin: "1.0.0" },
    snapshots: { "bin@1.0.0": {} },
    platform: ["bin@1.0.0"],
  });
  assert.equal(platformNotOptional.code, 1);
});

test("banned versions fail in production and dev closures; the fixed lines pass", () => {
  assert.equal(run(one("imapflow", "1.0.30", "MIT")).code, 1);
  assert.equal(run(one("imapflow", "1.0.27", "MIT")).code, 0);
  assert.equal(run(one("imapflow", "1.0.64", "MIT")).code, 0);
  assert.equal(run(one("imapflow", "2.2.7", "MIT")).code, 0);
  assert.equal(run(one("nodemailer", "3.1.0", "MIT")).code, 1);
  assert.equal(run(one("nodemailer", "10.0.15", "MIT-0")).code, 0);
  const dev = {
    devDeps: { imapflow: "1.0.40" },
    snapshots: { "imapflow@1.0.40": {} },
    installed: [{ name: "imapflow", version: "1.0.40", license: "MIT" }],
  };
  const r = run(dev);
  assert.equal(r.code, 1);
  assert.match(r.out, /forbidden version/);
});

test("SPDX precedence and parentheses", () => {
  const code = (lic) => run(one("p", "1.0.0", lic)).code;
  assert.equal(code("MIT AND GPL-3.0-only"), 1);
  assert.equal(code("(MIT OR GPL-3.0-only) AND ISC"), 0);
  assert.equal(code("(GPL-3.0-only OR AGPL-3.0-only) AND ISC"), 1);
  assert.equal(code("GPL-3.0-only OR MIT AND ISC"), 0);
  assert.equal(code("MIT AND GPL-3.0-only OR ISC"), 0);
  assert.equal(code("(MIT OR EUPL-1.1+)"), 0);
  assert.equal(code("EUPL-1.1+"), 1);
  assert.equal(code("(MIT"), 1);
});

test("WITH exceptions are unknown, and the production list is an allowlist while dev is a denylist", () => {
  assert.equal(run(one("p", "1.0.0", "Apache-2.0 WITH LLVM-exception")).code, 1);
  assert.equal(run(one("p", "1.0.0", "WTFPL")).code, 1);
  const dev = {
    devDeps: { d: "1.0.0" },
    snapshots: { "d@1.0.0": {} },
    installed: [{ name: "d", version: "1.0.0", license: "MPL-2.0" }],
  };
  const r = run(dev);
  assert.equal(r.code, 0);
  assert.match(r.out, /human review[\s\S]*d@1\.0\.0: MPL-2\.0/);
  assert.equal(
    run({ ...dev, installed: [{ name: "d", version: "1.0.0", license: "AGPL-3.0-only" }] }).code,
    1
  );
});

test("an aliased dependency resolves to the real package", () => {
  const r = run({
    deps: { host: "1.0.0" },
    snapshots: {
      "host@1.0.0": { deps: { aliasname: "gpl-real@2.0.0" } },
      "gpl-real@2.0.0": {},
    },
    installed: [
      { name: "host", version: "1.0.0", license: "MIT" },
      { name: "gpl-real", version: "2.0.0", license: "GPL-3.0-only" },
    ],
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /gpl-real@2\.0\.0/);
});

test("peer variants of one name@version merge their dependency edges", () => {
  const r = run({
    deps: { host: "1.0.0(peer@1.0.0)" },
    snapshots: {
      "host@1.0.0(peer@1.0.0)": { deps: { a: "1.0.0" } },
      "host@1.0.0(peer@2.0.0)": { deps: { b: "1.0.0" } },
      "a@1.0.0": {},
      "b@1.0.0": {},
    },
    installed: [
      { name: "host", version: "1.0.0", license: "MIT" },
      { name: "a", version: "1.0.0", license: "MIT" },
      { name: "b", version: "1.0.0", license: "GPL-3.0-only" },
    ],
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /b@1\.0\.0/);
});

test("a missing node_modules/.pnpm exits 2 without checking anything", () => {
  const r = run({ ...one("good", "1.0.0", "MIT"), pnpm: false });
  assert.equal(r.code, 2);
});
