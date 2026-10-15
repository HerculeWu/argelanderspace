// Pure rules of the desktop dependency directory (desktop-app ticket 22): the lockfile subset and the pruning decisions.
// The generator itself (dep-dir.mjs) installs from the pnpm store and is run by hand; see its header.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  budgetCheck,
  corepackCommand,
  corepackHome,
  DEP_DIR_BUDGET_BYTES,
  expectedPlatformPackages,
  findTool,
  foreignPrebuild,
  matchesTarget,
  PRUNE_CATEGORIES,
  pnpmVersion,
  pruneAction,
  removalPath,
  runErrorCategory,
  smokeVerdict,
  subsetLockfile,
  toolEnv,
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

test("the budget is 500 MB of file content per platform, and a directory over it is reported as over", () => {
  assert.equal(DEP_DIR_BUDGET_BYTES, 500_000_000);
  const under = budgetCheck(184_626_807);
  assert.equal(under.ok, true);
  assert.equal(under.budget, 500_000_000);
  assert.match(under.line, /184\.6 MB of file content, budget 500\.0 MB: within/);
  assert.equal(budgetCheck(500_000_000).ok, true);
  const over = budgetCheck(500_000_001);
  assert.equal(over.ok, false);
  assert.match(over.line, /OVER BUDGET/);
  assert.equal(budgetCheck(300_000_000, 200_000_000).ok, false);
  assert.throws(() => budgetCheck(1, 0), /budget/);
});

test("pnpmVersion reads the pinned pnpm from packageManager, with or without a hash", () => {
  assert.equal(pnpmVersion('{"packageManager": "pnpm@11.24.0"}'), "11.24.0");
  assert.equal(pnpmVersion('{"packageManager": "pnpm@11.24.0+sha512.abc"}'), "11.24.0");
  assert.throws(() => pnpmVersion('{"packageManager": "yarn@4.0.0"}'), /pnpm/);
  assert.throws(() => pnpmVersion("{}"), /packageManager/);
});

test("corepackHome follows corepack's own default on each platform", () => {
  assert.equal(corepackHome({ COREPACK_HOME: "/c" }, "/home/u", "linux"), "/c");
  assert.equal(corepackHome({}, "/home/u", "linux"), "/home/u/.cache/node/corepack");
  assert.equal(corepackHome({ XDG_CACHE_HOME: "/x" }, "/home/u", "darwin"), "/x/node/corepack");
  assert.equal(
    corepackHome({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "C:\\Users\\u", "win32"),
    "C:\\Users\\u\\AppData\\Local\\node\\corepack"
  );
  assert.equal(
    corepackHome({}, "C:\\Users\\u", "win32"),
    "C:\\Users\\u\\AppData\\Local\\node\\corepack"
  );
});

test("findTool looks a tool up on PATH, with PATHEXT on Windows", () => {
  const files = new Set(["/opt/a/latexmk", "/usr/bin/corepack", "C:\\node\\corepack.CMD"]);
  const exists = (f) => files.has(f);
  assert.equal(
    findTool("latexmk", { path: "/usr/bin:/opt/a", platform: "linux", exists }),
    "/opt/a/latexmk"
  );
  assert.equal(findTool("pi", { path: "/usr/bin:/opt/a", platform: "linux", exists }), undefined);
  assert.equal(findTool("x", { path: "", platform: "linux", exists }), undefined);
  assert.equal(
    findTool("corepack", {
      path: "C:\\Windows;C:\\node",
      platform: "win32",
      pathext: ".EXE;.CMD",
      exists,
    }),
    "C:\\node\\corepack.CMD"
  );
});

test("corepackCommand runs corepack's JS with this node on Windows (a .cmd needs a shell), the shim elsewhere", () => {
  assert.deepEqual(
    corepackCommand({ platform: "linux", corepack: "/w/bin/corepack", execPath: "/n/node" }),
    { command: "/w/bin/corepack", args: [] }
  );
  assert.deepEqual(
    corepackCommand({
      platform: "win32",
      corepack: "C:\\Program Files\\nodejs\\corepack.cmd",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
    }),
    {
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\Program Files\\nodejs\\node_modules\\corepack\\dist\\corepack.js"],
    }
  );
});

test("toolEnv is an allowlist: shim PATH, temp home, empty npm configs, the real corepack home", () => {
  const real = {
    PATH: "/home/u/.nvm/versions/node/v24/bin:/usr/bin:/bin",
    HOME: "/home/u",
    SECRET_TOKEN: "x",
    npm_config_registry: "https://example.invalid",
    XDG_CACHE_HOME: "/home/u/.xc",
  };
  const env = toolEnv({
    platform: "linux",
    env: real,
    realHome: "/home/u",
    work: "/w",
    bin: "/w/bin",
  });
  assert.equal(env.PATH, "/w/bin:/usr/bin:/bin");
  assert.equal(env.HOME, "/w/home");
  assert.equal(env.XDG_CONFIG_HOME, "/w/home/.config");
  assert.equal(env.npm_config_userconfig, "/w/empty-user-npmrc");
  assert.equal(env.npm_config_globalconfig, "/w/empty-global-npmrc");
  assert.equal(env.COREPACK_HOME, "/home/u/.xc/node/corepack");
  assert.equal(env.SECRET_TOKEN, undefined);
  assert.equal(env.npm_config_registry, undefined);
  assert.ok(!env.PATH.includes(".nvm"), "never the whole node bin directory");
  assert.equal(env.SystemRoot, undefined);

  const win = toolEnv({
    platform: "win32",
    env: {
      Path: "C:\\nodejs;C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
      USERPROFILE: "C:\\Users\\u",
    },
    realHome: "C:\\Users\\u",
    work: "C:\\t\\w",
    bin: "C:\\t\\w\\bin",
  });
  assert.equal(win.PATH, "C:\\t\\w\\bin;C:\\Windows\\System32;C:\\Windows");
  assert.equal(win.SystemRoot, "C:\\Windows");
  assert.equal(win.PATHEXT, ".COM;.EXE;.BAT;.CMD");
  assert.equal(win.USERPROFILE, "C:\\t\\w\\home");
  assert.equal(win.LOCALAPPDATA, "C:\\t\\w\\home\\AppData\\Local");
  assert.equal(win.COREPACK_HOME, "C:\\Users\\u\\AppData\\Local\\node\\corepack");
  assert.ok(!win.PATH.includes("nodejs"));
});

test("removalPath keeps --remove inside node_modules", () => {
  assert.equal(removalPath("/s/node_modules", "openai"), "/s/node_modules/openai");
  assert.equal(
    removalPath("/s/node_modules", "@embedpdf/fonts-sc/fonts"),
    "/s/node_modules/@embedpdf/fonts-sc/fonts"
  );
  for (const bad of ["../dist", "openai/../../dist", "/etc", ".", "", "a/../.."])
    assert.throws(() => removalPath("/s/node_modules", bad), /inside node_modules/, bad);
});

test("runErrorCategory keeps only the run's error code, never a message", () => {
  assert.deepEqual(runErrorCategory(null), { code: null });
  assert.deepEqual(runErrorCategory("unavailable"), { code: "unavailable" });
  assert.deepEqual(runErrorCategory("provider_capacity"), { code: "provider_capacity" });
  assert.deepEqual(runErrorCategory("401 Unauthorized key=sk-SECRET"), { code: "other" });
  assert.deepEqual(runErrorCategory("Cannot find package 'openai' imported from /tmp/x"), {
    code: "other",
  });
});

test("smokeVerdict never says OK when a path went untested", () => {
  assert.deepEqual(smokeVerdict({ failures: 0, untested: [], label: "c" }), {
    line: "SMOKE OK (c)",
    code: 0,
  });
  assert.deepEqual(smokeVerdict({ failures: 2, untested: ["ingest"], label: "c" }), {
    line: "SMOKE FAILED (c, 2)",
    code: 1,
  });
  const incomplete = smokeVerdict({ failures: 0, untested: ["LaTeX ingest"], label: "c" });
  assert.equal(incomplete.code, 2);
  assert.match(incomplete.line, /^SMOKE INCOMPLETE \(c; untested: LaTeX ingest\)$/);
});
