// Pure rules of the desktop dependency directory (desktop-app ticket 22): the lockfile subset and the pruning decisions.
// The generator itself (dep-dir.mjs) installs from the pnpm store and is run by hand; see its header.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  expectedPlatformPackages,
  foreignPrebuild,
  matchesTarget,
  PRUNE_CATEGORIES,
  pruneAction,
  subsetLockfile,
} from "./dep-dir-lib.mjs";

const LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    devDependencies:
      typescript:
        specifier: ~5.9.3
        version: 5.9.3

  packages/app:
    dependencies:
      '@scope/a':
        specifier: 1.0.0
        version: 1.0.0(peer@2.0.0)
      b:
        specifier: 3.0.0
        version: 3.0.0
    devDependencies:
      tsup:
        specifier: ^8.5.1
        version: 8.5.1

  packages/web:
    dependencies:
      unrelated:
        specifier: 1.0.0
        version: 1.0.0

packages:

  '@scope/a@1.0.0':
    resolution: {integrity: sha512-a}
    peerDependencies:
      peer: '>=1'

  b@3.0.0:
    resolution: {integrity: sha512-b}

  c@4.0.0:
    resolution: {integrity: sha512-c}

  c-darwin-arm64@4.0.0:
    resolution: {integrity: sha512-cd}
    cpu: [arm64]
    os: [darwin]

  c-linux-x64@4.0.0:
    resolution: {integrity: sha512-cl}
    cpu: [x64]
    os: [linux]
    libc: [glibc]

  peer@2.0.0:
    resolution: {integrity: sha512-p}

  tsup@8.5.1:
    resolution: {integrity: sha512-t}

  typescript@5.9.3:
    resolution: {integrity: sha512-ts}

  unrelated@1.0.0:
    resolution: {integrity: sha512-u}

snapshots:

  '@scope/a@1.0.0(peer@2.0.0)':
    dependencies:
      c: 4.0.0
      peer: 2.0.0

  b@3.0.0: {}

  c-darwin-arm64@4.0.0:
    optional: true

  c-linux-x64@4.0.0:
    optional: true

  c@4.0.0:
    optionalDependencies:
      c-darwin-arm64: 4.0.0
      c-linux-x64: 4.0.0

  peer@2.0.0: {}

  tsup@8.5.1: {}

  typescript@5.9.3: {}

  unrelated@1.0.0: {}
`;

test("the lockfile subset keeps exactly the app's production closure, as the root importer", () => {
  const { lockfile, dependencies } = subsetLockfile(LOCK, "packages/app");
  assert.deepEqual(dependencies, { "@scope/a": "1.0.0", b: "3.0.0" });
  assert.match(lockfile, /^lockfileVersion: '9.0'\n/);
  assert.match(
    lockfile,
    /importers:\n\n {2}\.:\n {4}dependencies:\n {6}'@scope\/a':\n {8}specifier: 1\.0\.0\n {8}version: 1\.0\.0\(peer@2\.0\.0\)\n {6}b:\n/
  );
  for (const kept of [
    "'@scope/a@1.0.0':",
    "b@3.0.0:",
    "c@4.0.0:",
    "c-linux-x64@4.0.0:",
    "peer@2.0.0:",
  ])
    assert.ok(lockfile.includes(`\n  ${kept}`), `keeps ${kept}`);
  // optional platform packages stay in the subset (pnpm picks the target's own from them)
  assert.match(
    lockfile,
    /c@4\.0\.0:\n {4}optionalDependencies:\n {6}c-darwin-arm64: 4\.0\.0\n {6}c-linux-x64: 4\.0\.0/
  );
  for (const dropped of [
    "tsup@",
    "typescript@",
    "unrelated@",
    "packages/app",
    "packages/web",
    "devDependencies",
  ])
    assert.ok(!lockfile.includes(dropped), `drops ${dropped}`);
});

test("the lockfile subset fails loudly when the importer or a snapshot is missing", () => {
  assert.throws(() => subsetLockfile(LOCK, "packages/nope"), /no packages\/nope importer/);
  assert.throws(
    () => subsetLockfile(LOCK.replace("  b@3.0.0: {}\n", ""), "packages/app"),
    /no snapshot b@3\.0\.0/
  );
});

test("matchesTarget follows npm's os/cpu/libc fields, including negations", () => {
  const linux = { platform: "linux", arch: "x64", libc: "glibc" };
  assert.equal(matchesTarget({}, linux), true);
  assert.equal(matchesTarget({ os: ["linux"], cpu: ["x64"], libc: ["glibc"] }, linux), true);
  assert.equal(matchesTarget({ os: ["linux"], cpu: ["x64"], libc: ["musl"] }, linux), false);
  assert.equal(matchesTarget({ os: ["darwin"] }, linux), false);
  assert.equal(matchesTarget({ cpu: ["arm64"] }, linux), false);
  assert.equal(matchesTarget({ os: ["!win32"] }, linux), true);
  assert.equal(matchesTarget({ os: ["!linux"] }, linux), false);
  // libc only constrains Linux
  assert.equal(
    matchesTarget({ os: ["darwin"], libc: ["glibc"] }, { platform: "darwin", arch: "arm64" }),
    true
  );
});

test("pruneAction names what to remove for each candidate, and nothing else", () => {
  const target = { platform: "linux", arch: "x64", libc: "glibc" };
  assert.deepEqual(PRUNE_CATEGORIES, ["fonts", "foreign", "esbuild"]);
  // fonts: only the font files; the package's JS manifest stays (engines imports it statically)
  assert.deepEqual(pruneAction({ name: "@embedpdf/fonts-sc" }, target), {
    category: "fonts",
    remove: "fonts",
  });
  assert.deepEqual(pruneAction({ name: "@embedpdf/fonts-latin" }, target), {
    category: "fonts",
    remove: "fonts",
  });
  assert.equal(pruneAction({ name: "@embedpdf/engines" }, target), null);
  assert.equal(pruneAction({ name: "@embedpdf/pdfium" }, target), null);
  assert.deepEqual(pruneAction({ name: "esbuild" }, target), { category: "esbuild", remove: "." });
  assert.deepEqual(pruneAction({ name: "@esbuild/linux-x64" }, target), {
    category: "esbuild",
    remove: ".",
  });
  assert.equal(pruneAction({ name: "esbuild-wasm" }, target), null);
  assert.deepEqual(
    pruneAction({ name: "@napi-rs/keyring-darwin-arm64", os: ["darwin"], cpu: ["arm64"] }, target),
    { category: "foreign", remove: "." }
  );
  assert.equal(
    pruneAction(
      { name: "@napi-rs/keyring-linux-x64-gnu", os: ["linux"], cpu: ["x64"], libc: ["glibc"] },
      target
    ),
    null
  );
  assert.equal(pruneAction({ name: "@napi-rs/keyring" }, target), null);
});

test("foreignPrebuild picks another platform's prebuilds directory inside a package", () => {
  const linux = { platform: "linux", arch: "x64", libc: "glibc" };
  const mac = { platform: "darwin", arch: "arm64" };
  assert.equal(foreignPrebuild("native/darwin/prebuilds/darwin-arm64", linux), true);
  assert.equal(foreignPrebuild("native/win32/prebuilds/win32-x64", linux), true);
  assert.equal(foreignPrebuild("native/linux/prebuilds/linux-arm64", linux), true);
  assert.equal(foreignPrebuild("native/linux/prebuilds/linux-x64", linux), false);
  assert.equal(foreignPrebuild("prebuilds/linux-x64-glibc", linux), false);
  assert.equal(foreignPrebuild("prebuilds/linux-x64-musl", linux), true);
  assert.equal(foreignPrebuild("native/darwin/prebuilds/darwin-arm64", mac), false);
  assert.equal(foreignPrebuild("native/darwin/prebuilds/darwin-x64", mac), true);
  // only a directory directly under `prebuilds` with a platform-arch name counts
  assert.equal(foreignPrebuild("native/darwin", linux), false);
  assert.equal(foreignPrebuild("prebuilds", linux), false);
  assert.equal(foreignPrebuild("lib/darwin-arm64", linux), false);
  assert.equal(foreignPrebuild("prebuilds/common", linux), false);
});

test("expectedPlatformPackages lists the lockfile's platform packages that the target must get", () => {
  const { lockfile } = subsetLockfile(LOCK, "packages/app");
  assert.deepEqual(
    expectedPlatformPackages(lockfile, { platform: "linux", arch: "x64", libc: "glibc" }),
    ["c-linux-x64@4.0.0"]
  );
  assert.deepEqual(expectedPlatformPackages(lockfile, { platform: "darwin", arch: "arm64" }), [
    "c-darwin-arm64@4.0.0",
  ]);
  assert.deepEqual(
    expectedPlatformPackages(lockfile, { platform: "linux", arch: "x64", libc: "musl" }),
    []
  );
  assert.deepEqual(expectedPlatformPackages(lockfile, { platform: "win32", arch: "x64" }), []);
});
