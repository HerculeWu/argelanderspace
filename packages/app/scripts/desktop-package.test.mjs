// Pure rules of the desktop package (desktop-app ticket 23): the Node runtime's download and checksum, the sidecar's
// required files, the license texts the package must carry, and the strict argument parsing of its scripts. The
// assembly (desktop-sidecar.mjs) and the smoke (smoke-desktop-package.mjs) are run by hand; see their headers.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PROD_LICENSE_ALLOWED, WITH_LICENSE_ALLOWED } from "../../../scripts/license-allowlist.mjs";
import {
  DESKTOP_NODE_VERSION,
  evalLicense,
  hostProcess,
  keyringNativeFile,
  licenseProblems,
  listInstalledPackages,
  nodeDist,
  nodeSignatureFromManifest,
  nodeSignaturePlan,
  parseStrictArgs,
  RUNTIME_LICENSE_ALLOWED,
  shaFromShasums,
  sidecarRequiredFiles,
  vendoredLicense,
  verifyNodeSignature,
} from "./desktop-package-lib.mjs";

test("the Node download names follow nodejs.org/dist for each target", () => {
  assert.deepEqual(nodeDist("24.15.0", "linux-x64"), {
    base: "node-v24.15.0-linux-x64",
    file: "node-v24.15.0-linux-x64.tar.xz",
    url: "https://nodejs.org/dist/v24.15.0/node-v24.15.0-linux-x64.tar.xz",
    shasumsUrl: "https://nodejs.org/dist/v24.15.0/SHASUMS256.txt",
    signatureUrl: "https://nodejs.org/dist/v24.15.0/SHASUMS256.txt.sig",
    binary: "bin/node",
  });
  assert.equal(nodeDist("24.15.0", "darwin-arm64").file, "node-v24.15.0-darwin-arm64.tar.xz");
  assert.equal(nodeDist("24.15.0", "win32-x64").file, "node-v24.15.0-win-x64.zip");
  assert.equal(nodeDist("24.15.0", "win32-x64").binary, "node.exe");
  assert.throws(() => nodeDist("24", "linux-x64"), /x\.y\.z/);
  assert.throws(() => nodeDist("24.15.0", "linux-ia32"), /unknown target/);
});

test("the checksum is read from SHASUMS256.txt for exactly that file", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  const text = `${a}  node-v24.15.0-linux-x64.tar.gz\n${b}  node-v24.15.0-linux-x64.tar.xz\n`;
  assert.equal(shaFromShasums(text, "node-v24.15.0-linux-x64.tar.xz"), b);
  assert.throws(() => shaFromShasums(text, "node-v24.15.0-linux-x64"), /no checksum/);
  assert.throws(
    () =>
      shaFromShasums(
        `${text}${a}  node-v24.15.0-linux-x64.tar.xz\n`,
        "node-v24.15.0-linux-x64.tar.xz"
      ),
    /more than one/
  );
  assert.throws(() => shaFromShasums(`xyz  f\n`, "f"), /no checksum/);
});

test("the sidecar's required files name what the four resource classes need", () => {
  const files = sidecarRequiredFiles("linux-x64");
  for (const f of [
    "sidecar/node/bin/node",
    "sidecar/node/LICENSE",
    "sidecar/app/package.json",
    "sidecar/app/LICENSE",
    "sidecar/app/dist/bin.js",
    "sidecar/app/dist/argelander.sty",
    "sidecar/app/dist/web/index.html",
    "sidecar/app/node_modules/@embedpdf/pdfium/dist/pdfium.wasm",
    "sidecar/app/node_modules/@napi-rs/keyring-linux-x64-gnu/keyring.linux-x64-gnu.node",
    "sidecar/app/THIRD-PARTY-RUNTIME-NOTICES.txt",
    "skills/README.md",
  ])
    assert.ok(files.includes(f), f);
  assert.ok(sidecarRequiredFiles("win32-x64").includes("sidecar/node/node.exe"));
  assert.equal(
    keyringNativeFile("darwin-arm64"),
    "@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node"
  );
  assert.equal(
    keyringNativeFile("win32-x64"),
    "@napi-rs/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node"
  );
});

test("SPDX expressions: OR takes an allowed branch, AND needs both, WITH and unknown ids are not allowed", () => {
  const ok = (e) => evalLicense(e, RUNTIME_LICENSE_ALLOWED);
  assert.equal(ok("MIT"), true);
  assert.equal(ok("(MIT OR GPL-3.0)"), true);
  assert.equal(ok("MIT AND GPL-3.0"), false);
  assert.equal(ok("(MIT AND (Apache-2.0 OR GPL-2.0))"), true);
  assert.equal(ok("GPL-2.0 WITH Classpath-exception-2.0"), false);
  assert.equal(ok("SEE LICENSE IN LICENSE"), false);
  assert.equal(ok(""), false);
  assert.equal(ok(undefined), false);
});

const MANIFEST = {
  files: { "x-LICENSE": { sha256: "1".repeat(64) } },
  packages: [{ package: "nofile", version: "1.0.0", license: "MIT", file: "x-LICENSE" }],
};

test("a vendored text is found only for the exact name and version", () => {
  assert.equal(vendoredLicense(MANIFEST, "nofile", "1.0.0")?.file, "x-LICENSE");
  assert.equal(vendoredLicense(MANIFEST, "nofile", "1.0.1"), null);
  assert.equal(vendoredLicense(MANIFEST, "other", "1.0.0"), null);
});

test("license problems: a package with neither its own file nor a vendored text, a changed vendored file, a license outside the list", () => {
  const sha = (f) => (f === "x-LICENSE" ? "1".repeat(64) : null);
  const base = [
    { name: "own", version: "1.0.0", license: "MIT", licenseFiles: ["LICENSE"] },
    { name: "nofile", version: "1.0.0", license: "MIT", licenseFiles: [] },
  ];
  assert.deepEqual(licenseProblems({ packages: base, manifest: MANIFEST, vendoredSha: sha }), []);
  assert.deepEqual(
    licenseProblems({
      packages: [...base, { name: "bare", version: "2.0.0", license: "ISC", licenseFiles: [] }],
      manifest: MANIFEST,
      vendoredSha: sha,
    }),
    ["bare@2.0.0: no license text (no license file and no vendored text for this version)"]
  );
  assert.deepEqual(
    licenseProblems({ packages: base, manifest: MANIFEST, vendoredSha: () => "2".repeat(64) }),
    ["nofile@1.0.0: vendored text x-LICENSE is missing or differs from its recorded sha256"]
  );
  assert.deepEqual(
    licenseProblems({
      packages: [{ name: "gpl", version: "1.0.0", license: "GPL-3.0", licenseFiles: ["COPYING"] }],
      manifest: MANIFEST,
      vendoredSha: sha,
    }),
    ['gpl@1.0.0: license "GPL-3.0" is not in the allowed list']
  );
  // The vendored entry must name the same license the package declares.
  assert.deepEqual(
    licenseProblems({
      packages: [{ name: "nofile", version: "1.0.0", license: "Apache-2.0", licenseFiles: [] }],
      manifest: MANIFEST,
      vendoredSha: sha,
    }),
    ['nofile@1.0.0: vendored text is for "MIT", the package declares "Apache-2.0"']
  );
});

test("the repository's vendored runtime licenses are complete and unchanged", () => {
  const dir = new URL("../licenses/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("runtime-licenses.json", dir), "utf8"));
  for (const [file, { sha256 }] of Object.entries(manifest.files))
    assert.equal(
      createHash("sha256")
        .update(readFileSync(new URL(file, dir)))
        .digest("hex"),
      sha256,
      file
    );
  for (const p of manifest.packages) assert.ok(manifest.files[p.file], `${p.package}: ${p.file}`);
  // The 17 packages of ticket 22's report (linux-x64) all have a text.
  for (const id of [
    "@aws-sdk/credential-provider-http@3.972.74",
    "@aws-sdk/credential-provider-login@3.972.79",
    "@aws-sdk/nested-clients@3.997.46",
    "@earendil-works/chord@1.0.0",
    "@earendil-works/pi-agent-core@1.0.0",
    "@earendil-works/pi-ai@1.0.0",
    "@earendil-works/pi-codemode@1.0.0",
    "@earendil-works/pi-coding-agent@1.0.0",
    "@earendil-works/pi-mcp@1.0.0",
    "@earendil-works/pi-telemetry@1.0.0",
    "@earendil-works/pi-tui@1.0.0",
    "@napi-rs/keyring-linux-x64-gnu@2.1.0",
    "data-uri-to-buffer@4.0.1",
    "is-reference@3.0.3",
    "locate-character@3.0.0",
    "proxy-agent-negotiate@1.1.0",
    "standardwebhooks@1.1.1",
  ]) {
    const at = id.lastIndexOf("@");
    assert.ok(vendoredLicense(manifest, id.slice(0, at), id.slice(at + 1)), id);
  }
});

test("strict arguments: unknown, repeated, missing or empty values stop the script", () => {
  const spec = { valued: ["--deb", "--remove"], flags: ["--keep"] };
  assert.deepEqual(parseStrictArgs(["--deb", "a.deb", "--keep"], spec), {
    values: { "--deb": "a.deb" },
    flags: new Set(["--keep"]),
  });
  assert.throws(() => parseStrictArgs(["--deb"], spec), /--deb/);
  assert.throws(() => parseStrictArgs(["--deb", ""], spec), /--deb/);
  assert.throws(() => parseStrictArgs(["--deb", "--keep"], spec), /--deb/);
  assert.throws(() => parseStrictArgs(["--deb", "a", "--deb", "b"], spec), /twice/);
  assert.throws(() => parseStrictArgs(["--keep", "--keep"], spec), /twice/);
  assert.throws(() => parseStrictArgs(["--remove x"], spec), /unknown/);
  assert.throws(() => parseStrictArgs(["stray"], spec), /unknown/);
});

test("installed packages are listed with their license files, scoped and nested ones too", () => {
  const tree = {
    "/nm": ["a", "@s", ".bin"],
    "/nm/a": ["package.json", "LICENSE.md", "index.js", "node_modules"],
    "/nm/a/node_modules": ["b"],
    "/nm/a/node_modules/b": ["package.json"],
    "/nm/@s": ["c"],
    "/nm/@s/c": ["package.json", "COPYING"],
  };
  const json = {
    "/nm/a/package.json": { name: "a", version: "1.0.0", license: "MIT" },
    "/nm/a/node_modules/b/package.json": { name: "b", version: "2.0.0", license: { type: "ISC" } },
    "/nm/@s/c/package.json": { name: "@s/c", version: "3.0.0", license: "Apache-2.0" },
  };
  const fs = {
    join: (...p) => p.join("/"),
    existsSync: (p) => p in tree || p in json,
    readdirSync: (p) => tree[p],
    readFileSync: (p) => JSON.stringify(json[p]),
  };
  assert.deepEqual(
    listInstalledPackages("/nm", fs).map(({ name, version, license, licenseFiles }) => [
      name,
      version,
      license,
      licenseFiles,
    ]),
    [
      ["a", "1.0.0", "MIT", ["LICENSE.md"]],
      ["b", "2.0.0", "ISC", []],
      ["@s/c", "3.0.0", "Apache-2.0", ["COPYING"]],
    ]
  );
});

test("the desktop package's Node version is pinned in the repository (a 24.x release)", () => {
  assert.match(DESKTOP_NODE_VERSION, /^24\.\d+\.\d+$/);
  assert.equal(nodeDist(DESKTOP_NODE_VERSION, "linux-x64").file.startsWith("node-v24."), true);
});

test("the Node signature must be verified unless the unsafe skip is given explicitly, and not both", () => {
  assert.throws(() => nodeSignaturePlan({}), /--node-keyring/);
  assert.throws(
    () => nodeSignaturePlan({ keyring: undefined, insecureSkip: false }),
    /--node-keyring/
  );
  assert.deepEqual(nodeSignaturePlan({ keyring: "/k/pubring.kbx" }), {
    verify: true,
    keyring: "/k/pubring.kbx",
  });
  assert.deepEqual(nodeSignaturePlan({ insecureSkip: true }), { verify: false });
  assert.throws(
    () => nodeSignaturePlan({ keyring: "/k/pubring.kbx", insecureSkip: true }),
    /not both/
  );
});

test("a failed signature check removes the cached checksum list and its signature", () => {
  const removed = [];
  const calls = [];
  const bad = () => {
    calls.push("gpgv");
    return { status: 1, stderr: "gpgv: BAD signature" };
  };
  assert.throws(
    () =>
      verifyNodeSignature({
        keyring: "/k",
        shasums: "/c/SHASUMS256.txt",
        signature: "/c/SHASUMS256.txt.sig",
        run: bad,
        remove: (f) => removed.push(f),
      }),
    /did not verify/
  );
  assert.deepEqual(calls, ["gpgv"]);
  assert.deepEqual(removed.sort(), ["/c/SHASUMS256.txt", "/c/SHASUMS256.txt.sig"]);

  const args = [];
  const good = (cmd, argv) => {
    args.push([cmd, ...argv]);
    return { status: 0, stderr: 'gpgv: Good signature from "Some Releaser <r@example.org>"' };
  };
  const removedOk = [];
  const ok = verifyNodeSignature({
    keyring: "/k",
    shasums: "/c/S",
    signature: "/c/S.sig",
    run: good,
    remove: (f) => removedOk.push(f),
  });
  assert.deepEqual(args, [["gpgv", "--keyring", "/k", "/c/S.sig", "/c/S"]]);
  assert.deepEqual(removedOk, []);
  assert.equal(ok.verified, true);
  assert.match(ok.detail, /Some Releaser/);
});

test("a gpgv that cannot be run is not a bad signature: it says so and keeps the cache", () => {
  const removed = [];
  const missing = () => ({
    status: null,
    stderr: undefined,
    error: Object.assign(new Error("spawn gpgv ENOENT"), { code: "ENOENT" }),
  });
  assert.throws(
    () =>
      verifyNodeSignature({
        keyring: "/k",
        shasums: "/c/S",
        signature: "/c/S.sig",
        run: missing,
        remove: (f) => removed.push(f),
      }),
    /gpgv could not be run \(ENOENT\)/
  );
  assert.deepEqual(removed, []);
});

test("the smoke reads the signature state from the sidecar manifest: only an explicit true counts", () => {
  const verified = { node: { signature: { verified: true, detail: "gpgv: good signature" } } };
  assert.deepEqual(nodeSignatureFromManifest(verified), {
    verified: true,
    detail: "gpgv: good signature",
  });
  assert.equal(
    nodeSignatureFromManifest({ node: { signature: { verified: false, detail: "skipped" } } })
      .verified,
    false
  );
  assert.equal(
    nodeSignatureFromManifest({ node: { signature: { verified: "yes" } } }).verified,
    false
  );
  // The first round's string form, or no record at all, is not a verification.
  assert.equal(
    nodeSignatureFromManifest({ node: { shasums_signature: "verified with gpgv" } }).verified,
    false
  );
  assert.equal(nodeSignatureFromManifest(null).verified, false);
});

test("the shell's host is the child running the package's node, not whichever child comes first", () => {
  const node = "/tmp/x/usr/lib/argelanderspace/sidecar/node/bin/node";
  const kids = [
    { pid: "11", exe: "/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitNetworkProcess" },
    { pid: "12", exe: node },
    { pid: "13", exe: "" },
  ];
  assert.equal(hostProcess(kids, node)?.pid, "12");
  assert.equal(hostProcess(kids.slice(0, 1), node), null);
  assert.equal(hostProcess([], node), null);
  assert.equal(hostProcess([...kids, { pid: "14", exe: node }], node), null);
});

test("one license allowlist: the desktop package's check uses the production list of scripts/license-scan.mjs", () => {
  assert.equal(RUNTIME_LICENSE_ALLOWED, PROD_LICENSE_ALLOWED);
  assert.equal(evalLicense("MIT", PROD_LICENSE_ALLOWED, WITH_LICENSE_ALLOWED), true);
  const scan = readFileSync(new URL("../../../scripts/license-scan.mjs", import.meta.url), "utf8");
  assert.match(scan, /from "\.\/license-allowlist\.mjs"/);
  assert.doesNotMatch(scan, /new Set\(\[\s*"MIT"/);
});
