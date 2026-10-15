#!/usr/bin/env node
// Smoke of a built desktop package (desktop-app ticket 23). NOT part of the four gates: it needs a .deb from the
// packaging steps (docs/engineering.md「桌面包」) and `corepack pnpm -r build` (the npm build it compares versions with).
// Linux only (dpkg-deb, /proc). It never installs anything: the package is unpacked into a temp dir.
//
//   node packages/app/scripts/smoke-desktop-package.mjs (--deb <file.deb> | --appimage <file.AppImage>)
//        [--remove <path,...>] [--label <name>] [--evidence <dir>] [--shell] [--shell-bin <file>] [--keep]
//
//   --appimage the same smoke on an AppImage (desktop-app ticket 26): unpacked with its own `--appimage-extract` (no
//              FUSE, nothing mounted) into the temp dir; its usr/ tree has the deb's layout. Instead of the control
//              file it checks the top-level launcher entry. linuxdeploy rewrites ELF files it bundles (it gave the
//              sidecar's node and keychain .node a RUNPATH in ticket 23): the package's node is compared with the
//              binary the sidecar was assembled with (sidecar-manifest.json `node.binary_sha256`) and the difference
//              is reported, not failed -- the runtime checks below decide whether the rewritten files still work.
//              The shell is started as the unpacked binary (usr/bin), not through AppRun.
//
//   --remove   comma list of paths relative to the package's resource directory (usr/lib/argelanderspace) to delete
//              from the unpacked copy first, for a variant that must fail (e.g. sidecar/app/dist/argelander.sty,
//              sidecar/app/node_modules/@embedpdf/pdfium/dist/pdfium.wasm). Each must lie inside that directory.
//   --shell    also start the unpacked shell (usr/bin/argelanderspace-desktop) on the caller's display and check that
//              it runs the package's own Node and build; needs DISPLAY. Without it the shell is not started and the
//              verdict says so (INCOMPLETE).
//   --shell-bin  with --shell: put this file in place of the unpacked shell binary first -- for the counter-check only
//              (a release shell built WITHOUT the `packaged` feature runs the system `node`, so the smoke must fail).
//
// What it checks: the control file (Package `argelanderspace`, Maintainer `ArgelanderSpace`, Version =
// packages/app/package.json) and the launcher entry's name; the files every resource class
// needs (desktop-package-lib.mjs `sidecarRequiredFiles`); the license check of what is shipped (every package in the
// dependency directory has an allowed license and a text: its own file or a vendored one recorded for that exact
// version; Node's LICENSE); the dependency directory's budget (500 MB of file content); sidecar-manifest.json's record
// that the Node download's signature was verified (not verified: INCOMPLETE); the package's Node is the version the
// manifest names; the package's bin.js is byte for byte packages/app/dist/bin.js (the same build) and its `--version`
// equals the app version and the npm build's `--version`; then smoke-dep-dir.mjs runs the unpacked sidecar IN PLACE
// with the package's Node (page resources, keychain module, PDFium, Copilot, argelander.sty via a CLI ingest, the
// ready line's address), with a recording `node` first on PATH so any use of a system node fails.
//
// Isolation (the smoke-dep-dir convention): children get an env allowlist -- temp HOME / XDG_* / XDG_RUNTIME_DIR,
// DBUS_SESSION_BUS_ADDRESS pointing at a socket that does not exist (the keychain is never reached), PATH = the
// recording node + /usr/bin:/bin, LANG=C.UTF-8; the shell additionally gets DISPLAY / XAUTHORITY. Only synthetic data.
// Nothing outside the temp dir and --evidence is written; the temp dir is removed unless --keep.
//
// Exit: 0 `SMOKE OK` every check ran and passed; 1 `SMOKE FAILED`; 2 `SMOKE INCOMPLETE (…; untested: …)`.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { budgetCheck, smokeVerdict } from "./dep-dir-lib.mjs";
import {
  hostProcess,
  licenseProblems,
  listInstalledPackages,
  nodeSignatureFromManifest,
  parseStrictArgs,
  sidecarRequiredFiles,
} from "./desktop-package-lib.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
let args;
try {
  args = parseStrictArgs(process.argv.slice(2), {
    valued: ["--deb", "--appimage", "--remove", "--label", "--evidence", "--shell-bin"],
    flags: ["--shell", "--keep"],
  });
} catch (e) {
  console.error(`smoke-desktop-package: ${e.message}`);
  process.exit(1);
}
const opt = args.values;
if (!opt["--deb"] === !opt["--appimage"]) {
  console.error(
    "smoke-desktop-package: give one of --deb <file.deb> or --appimage <file.AppImage>"
  );
  process.exit(1);
}
if (opt["--shell-bin"] && !args.flags.has("--shell")) {
  console.error("smoke-desktop-package: --shell-bin needs --shell");
  process.exit(1);
}
const isAppImage = !!opt["--appimage"];
const deb = resolve(opt["--deb"] ?? opt["--appimage"]);
const label = opt["--label"] ?? "desktop-package";
const removeList = (opt["--remove"] ?? "").split(",").filter(Boolean);
const target = `${process.platform}-${process.arch}`;
const appPkg = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8"));
const work = mkdtempSync(join(tmpdir(), "argelander-desktop-smoke-"));
const evidenceDir = resolve(opt["--evidence"] ?? join(work, "evidence"));
mkdirSync(evidenceDir, { recursive: true });

const results = [];
const log = (line) => {
  console.log(line);
  results.push(line);
};
let failures = 0;
const untested = [];
function check(ok, what, detail = "") {
  if (!ok) failures += 1;
  log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? ` -- ${detail}` : ""}`);
}
const children = new Set();
process.on("exit", () => {
  for (const c of children) {
    try {
      process.kill(-c.pid, "SIGKILL");
    } catch {}
  }
  if (args.flags.has("--keep")) console.log(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(1));
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
function du(path) {
  const st = lstatSync(path);
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const e of readdirSync(path)) n += du(join(path, e));
  return n;
}
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
const sizes = { deb_bytes: statSync(deb).size };

// ---- unpack --------------------------------------------------------------------------------------------------------- //
let root = join(work, "root");
let control = {};
if (isAppImage) {
  // The AppImage unpacks itself into ./squashfs-root of its working directory (its runtime, no FUSE needed).
  const x = spawnSync(deb, ["--appimage-extract"], { cwd: work, encoding: "utf8" });
  if (x.error || x.status !== 0) {
    console.error(`--appimage-extract failed: ${x.error?.code ?? x.stderr}`);
    process.exit(1);
  }
  root = join(work, "squashfs-root");
  log(`variant ${label}: ${deb} (AppImage)`);
  const top = readdirSync(root).filter((f) => f.endsWith(".desktop"));
  const entry = top.length === 1 ? readFileSync(join(root, top[0]), "utf8") : "";
  check(
    /^Name=ArgelanderSpace$/m.test(entry) && /^Exec=argelanderspace-desktop/m.test(entry),
    "the AppImage's launcher entry is named ArgelanderSpace and starts the shell",
    top.join(",")
  );
  check(
    deb.split(sep).pop().includes(`_${appPkg.version}_`),
    "the AppImage's file name carries the app package's version (single source)",
    deb.split(sep).pop()
  );
} else {
  const x = spawnSync("dpkg-deb", ["-x", deb, root], { encoding: "utf8" });
  if (x.status !== 0) {
    console.error(`dpkg-deb -x failed: ${x.stderr}`);
    process.exit(1);
  }
  const field = (name) =>
    spawnSync("dpkg-deb", ["-f", deb, name], { encoding: "utf8" }).stdout.trim();
  control = {
    Package: field("Package"),
    Version: field("Version"),
    Maintainer: field("Maintainer"),
    Architecture: field("Architecture"),
    "Installed-Size": field("Installed-Size"),
    Depends: field("Depends"),
  };
  log(`variant ${label}: ${deb} (${control.Package} ${control.Version} ${control.Architecture})`);
  check(
    control.Package === "argelanderspace" && control.Maintainer === "ArgelanderSpace",
    "the package is named argelanderspace, maintainer ArgelanderSpace",
    `Package ${JSON.stringify(control.Package)}, Maintainer ${JSON.stringify(control.Maintainer)}`
  );
  check(
    control.Version === appPkg.version,
    "the package version is the app package's (single source)",
    `${control.Version} vs ${appPkg.version}`
  );
}
const libDirs = existsSync(join(root, "usr/lib")) ? readdirSync(join(root, "usr/lib")) : [];
const productDir = libDirs.find((d) => existsSync(join(root, "usr/lib", d, "sidecar")));
const resources = productDir ? join(root, "usr/lib", productDir) : join(root, "usr/lib/<none>");
check(!!productDir, "the resource directory with sidecar/ is in usr/lib", productDir ?? "none");
const shellBin = join(root, "usr/bin/argelanderspace-desktop");
check(existsSync(shellBin), "the shell binary is usr/bin/argelanderspace-desktop");
const desktopFiles = existsSync(join(root, "usr/share/applications"))
  ? readdirSync(join(root, "usr/share/applications"))
  : [];
const desktopEntry = desktopFiles.length
  ? readFileSync(join(root, "usr/share/applications", desktopFiles[0]), "utf8")
  : "";
if (!isAppImage)
  check(
    desktopFiles.length === 1 &&
      /^Exec=argelanderspace-desktop$/m.test(desktopEntry) &&
      /^Name=ArgelanderSpace$/m.test(desktopEntry),
    "a launcher entry (usr/share/applications) named ArgelanderSpace starts the shell",
    desktopFiles.join(",")
  );
sizes.unpacked_bytes = du(root);

for (const rel of removeList) {
  const p = resolve(resources, rel);
  const r = relative(resources, p);
  if (!r || r.startsWith(`..${sep}`) || r === ".." || resolve(rel) === rel) {
    console.error(
      `--remove ${JSON.stringify(rel)}: must name a path inside the resource directory`
    );
    process.exit(1);
  }
  if (!existsSync(p)) {
    console.error(`--remove ${rel}: not in the package`);
    process.exit(1);
  }
  rmSync(p, { recursive: true, force: true });
  log(`removed ${rel} from the unpacked copy`);
}

// ---- static: required files, licenses, budget --------------------------------------------------------------------- //
const missing = sidecarRequiredFiles(target).filter((f) => !existsSync(join(resources, f)));
check(missing.length === 0, "every required resource file is in the package", missing.join(", "));
const sidecar = join(resources, "sidecar");
const sidecarManifestPath = join(sidecar, "sidecar-manifest.json");
let sidecarManifest = null;
try {
  sidecarManifest = JSON.parse(readFileSync(sidecarManifestPath, "utf8"));
} catch {}
check(!!sidecarManifest, "sidecar/sidecar-manifest.json is there and readable");
const nodeSignature = nodeSignatureFromManifest(sidecarManifest);
if (nodeSignature.verified)
  check(true, "the Node download's signature was verified when assembled", nodeSignature.detail);
else {
  untested.push("the Node download's signature (not verified when the package was assembled)");
  log(`UNTESTED  the Node download's signature: ${nodeSignature.detail}`);
}
const nodeExe = join(sidecar, "node/bin/node");
// A bundler that rewrites the node binary (linuxdeploy's RUNPATH in an AppImage): reported, the runtime checks decide.
const nodeBinarySha = existsSync(nodeExe) ? sha256(nodeExe) : null;
const assembledSha = sidecarManifest?.node?.binary_sha256 ?? null;
if (!assembledSha) log("INFO  the manifest has no node.binary_sha256 (assembled before ticket 26)");
else if (nodeBinarySha === assembledSha)
  log("INFO  the package's node is byte for byte the assembled one");
else
  log(
    "INFO  the package's node DIFFERS from the assembled one (rewritten by the bundler, e.g. a RUNPATH)"
  );
const binJs = join(sidecar, "app/dist/bin.js");
const nodeModules = join(sidecar, "app/node_modules");
const nodeLicense = join(sidecar, "node/LICENSE");
check(
  existsSync(nodeLicense) &&
    /Node\.js is licensed for use as follows/.test(readFileSync(nodeLicense, "utf8")),
  "Node's license text is in the package (sidecar/node/LICENSE)"
);
const manifestPath = join(sidecar, "app/licenses/runtime-licenses.json");
if (existsSync(nodeModules) && existsSync(manifestPath)) {
  const packages = listInstalledPackages(nodeModules, {
    join,
    existsSync,
    readdirSync,
    readFileSync,
  });
  const problems = licenseProblems({
    packages,
    manifest: JSON.parse(readFileSync(manifestPath, "utf8")),
    vendoredSha: (f) => {
      const p = join(sidecar, "app/licenses", f);
      return existsSync(p) ? sha256(p) : null;
    },
  });
  check(
    problems.length === 0,
    `license check of the shipped dependency directory (${packages.length} packages: allowed license and a text each)`,
    problems.slice(0, 10).join("; ")
  );
  const budget = budgetCheck(du(nodeModules));
  sizes.dependency_directory_bytes = budget.bytes;
  check(budget.ok, `dependency directory budget: ${budget.line}`);
} else
  check(
    false,
    "license check of the shipped dependency directory",
    "node_modules or the manifest is missing"
  );
for (const [k, p] of [
  ["node_runtime_bytes", join(sidecar, "node")],
  ["app_dist_bytes", join(sidecar, "app/dist")],
  ["skills_bytes", join(resources, "skills")],
  ["shell_bytes", shellBin],
])
  if (existsSync(p)) sizes[k] = du(p);
const duK = spawnSync("du", ["-sk", root], { encoding: "utf8" }).stdout.split(/\s/)[0];
sizes.unpacked_disk_kib = Number(duK);
sizes.installed_size_kib = Number(control["Installed-Size"] ?? Number.NaN);
log(
  `sizes: ${isAppImage ? "AppImage" : "deb"} ${mb(sizes.deb_bytes)}; unpacked ${mb(sizes.unpacked_bytes)} of file content, ${(sizes.unpacked_disk_kib / 1024).toFixed(1)} MiB on disk here; control Installed-Size ${sizes.installed_size_kib} KiB; node ${mb(sizes.node_runtime_bytes ?? 0)}, app dist ${mb(sizes.app_dist_bytes ?? 0)}, dependency directory ${mb(sizes.dependency_directory_bytes ?? 0)}, skills ${mb(sizes.skills_bytes ?? 0)}, shell ${mb(sizes.shell_bytes ?? 0)}`
);

// ---- isolated environment ------------------------------------------------------------------------------------------- //
const home = join(work, "home");
const runtimeDir = join(work, "runtime");
for (const d of [home, runtimeDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
const pathGuard = join(work, "path-guard");
const pathNodeUsed = join(work, "path-node-used");
mkdirSync(pathGuard);
writeFileSync(
  join(pathGuard, "node"),
  `#!/bin/sh\necho "$0 $*" >> ${JSON.stringify(pathNodeUsed)}\necho "smoke: node from PATH was run" >&2\nexit 1\n`,
  { mode: 0o755 }
);
const env = {
  PATH: `${pathGuard}:/usr/bin:/bin`,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local/share"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_STATE_HOME: join(home, ".local/state"),
  XDG_RUNTIME_DIR: runtimeDir,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(work, "no-such-bus")}`,
  LANG: "C.UTF-8",
  NO_COLOR: "1",
};

// ---- the package's Node and CLI ------------------------------------------------------------------------------------ //
const nodeVersion = existsSync(nodeExe)
  ? spawnSync(nodeExe, ["--version"], { cwd: home, env, encoding: "utf8" }).stdout.trim()
  : "";
check(
  !!sidecarManifest?.node?.version && nodeVersion === `v${sidecarManifest.node.version}`,
  "the package's Node is the release the manifest names",
  `${JSON.stringify(nodeVersion)} vs manifest ${JSON.stringify(sidecarManifest?.node?.version ?? null)}`
);
const npmBinJs = join(appRoot, "dist/bin.js");
const binSha = existsSync(binJs) ? sha256(binJs) : null;
const npmBinSha = existsSync(npmBinJs) ? sha256(npmBinJs) : null;
check(
  !!binSha && binSha === npmBinSha,
  "the package's bin.js is packages/app/dist/bin.js (same build, sha256)",
  `${binSha?.slice(0, 12) ?? "missing"} vs ${npmBinSha?.slice(0, 12) ?? "missing"}`
);
const cliVersion = existsSync(nodeExe)
  ? spawnSync(nodeExe, [binJs, "--version"], { cwd: home, env, encoding: "utf8" })
  : { status: null, stdout: "", stderr: "no node in the package" };
const npmVersion = spawnSync(process.execPath, [npmBinJs, "--version"], {
  cwd: home,
  env: { ...env, PATH: "/usr/bin:/bin" },
  encoding: "utf8",
});
check(
  cliVersion.status === 0 &&
    cliVersion.stdout.trim() === appPkg.version &&
    cliVersion.stdout === npmVersion.stdout,
  "the package's CLI --version equals the app version and the npm build's",
  `package ${JSON.stringify(cliVersion.stdout.trim())} (exit ${cliVersion.status}), npm build ${JSON.stringify(npmVersion.stdout.trim())}, app ${appPkg.version}${cliVersion.status === 0 ? "" : ` ${String(cliVersion.stderr).slice(-200)}`}`
);

// ---- the sidecar in place, with the package's Node (smoke-dep-dir.mjs) -------------------------------------------- //
if (existsSync(nodeExe) && existsSync(binJs)) {
  const s = spawnSync(
    process.execPath,
    [
      join(appRoot, "scripts/smoke-dep-dir.mjs"),
      "--sidecar",
      sidecar,
      "--node",
      nodeExe,
      "--label",
      `${label}-sidecar`,
      "--evidence",
      evidenceDir,
    ],
    { encoding: "utf8", env: { ...process.env, PATH: process.env.PATH ?? "" }, timeout: 600000 }
  );
  const indent = (text, mark) => `${text.trimEnd().replace(/^/gm, mark)}\n`;
  process.stdout.write(indent(s.stdout, "  | "));
  results.push(indent(s.stdout, "  | ").trimEnd());
  if (s.stderr.trim()) process.stdout.write(indent(s.stderr, "  ! "));
  if (s.status === 2) untested.push("part of the sidecar run (see its INCOMPLETE line)");
  check(
    s.status === 0 || s.status === 2,
    "the unpacked sidecar runs with the package's Node (smoke-dep-dir --sidecar)",
    `exit ${s.status}`
  );
} else
  check(false, "the unpacked sidecar runs with the package's Node", "node or bin.js is missing");

// ---- the shell (optional; needs a display) ------------------------------------------------------------------------ //
async function freePort() {
  return await new Promise((r) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => r(port));
    });
  });
}
const portOpen = (port) =>
  new Promise((r) => {
    const s = createServer();
    s.once("error", () => r(true));
    s.listen(port, "127.0.0.1", () => s.close(() => r(false)));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (args.flags.has("--shell")) {
  if (!process.env.DISPLAY) {
    untested.push("the shell (no DISPLAY)");
    log("UNTESTED  the shell: no DISPLAY");
  } else {
    if (opt["--shell-bin"]) {
      copyFileSync(resolve(opt["--shell-bin"]), shellBin);
      log(`replaced the unpacked shell with ${opt["--shell-bin"]} (counter-check)`);
    }
    const port = await freePort();
    mkdirSync(join(env.XDG_CONFIG_HOME, "argelanderspace"), { recursive: true });
    writeFileSync(join(env.XDG_CONFIG_HOME, "argelanderspace/config.toml"), `port = ${port}\n`);
    const shellEnv = { ...env, DISPLAY: process.env.DISPLAY, GDK_BACKEND: "x11" };
    if (process.env.XAUTHORITY) shellEnv.XAUTHORITY = process.env.XAUTHORITY;
    let shellErr = "";
    const shell = spawn(shellBin, [], {
      cwd: home,
      env: shellEnv,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.add(shell);
    shell.stderr.on("data", (d) => (shellErr += d));
    let info = null;
    for (let i = 0; i < 150 && shell.exitCode === null; i += 1) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/host`);
        if (r.ok) {
          info = await r.json();
          break;
        }
      } catch {}
      await sleep(200);
    }
    check(
      info?.mode === "desktop",
      "the unpacked shell started a desktop host on the configured port",
      info
        ? JSON.stringify({ mode: info.mode, project: info.project })
        : `no answer; ${shellErr.slice(-300)}`
    );
    // The host is the shell's child: the one whose executable is the package's Node. WebKit's helper processes are
    // children of the shell too, so the first child is not necessarily the host.
    const kids = readdirSync("/proc")
      .filter((p) => /^\d+$/.test(p))
      .filter((p) => {
        try {
          return (
            readFileSync(`/proc/${p}/stat`, "utf8").split(") ")[1].split(" ")[1] ===
            String(shell.pid)
          );
        } catch {
          return false;
        }
      })
      .map((pid) => {
        let exe = "";
        try {
          exe = readlinkSync(`/proc/${pid}/exe`);
        } catch {}
        return { pid, exe };
      });
    const host = hostProcess(kids, nodeExe);
    const hostPid = host?.pid ?? null;
    let cmd = [];
    try {
      if (hostPid)
        cmd = readFileSync(`/proc/${hostPid}/cmdline`, "utf8").split("\0").filter(Boolean);
    } catch {}
    check(
      !!host && cmd[1] === binJs && cmd[2] === "desktop-host",
      "the shell's host is the package's Node running the package's bin.js",
      JSON.stringify({
        children: kids.map((k) => k.exe.replace(work, "<tmp>")),
        host: hostPid,
        argv: cmd.map((a) => a.replace(work, "<tmp>")),
      })
    );
    if (info) {
      const page = await fetch(`http://127.0.0.1:${port}/`).then(
        async (r) => ({ status: r.status, text: await r.text() }),
        () => ({ status: 0, text: "" })
      );
      check(
        page.status === 200 && /<div id="root"/.test(page.text),
        "the page is served at the host's address"
      );
    }
    // The shell is ended by a signal (as when it is killed); its host, in a process group of its own, then reads the
    // end of its stdin and shuts down by itself (desktop-app ticket 17), within its 10-second limit.
    process.kill(-shell.pid, "SIGTERM");
    for (let i = 0; i < 100 && shell.exitCode === null && shell.signalCode === null; i += 1)
      await sleep(100);
    // No host found means there is nothing to have seen end: hostGone stays false.
    let hostGone = false;
    for (let i = 0; hostPid && i < 150; i += 1) {
      if (!existsSync(`/proc/${hostPid}`)) {
        hostGone = true;
        break;
      }
      await sleep(100);
    }
    const shellEnded = shell.exitCode !== null || shell.signalCode !== null;
    const portFree = !(await portOpen(port));
    check(
      shellEnded && hostGone && portFree,
      "after the shell ends its host ends too and the port is free",
      JSON.stringify({ shell: shell.signalCode ?? shell.exitCode, hostGone, portFree })
    );
    if (existsSync(join(work, "path-node-used")))
      check(
        false,
        "no node from PATH was run by the shell",
        readFileSync(pathNodeUsed, "utf8").slice(0, 200)
      );
    else check(true, "no node from PATH was run by the shell or its host");
  }
} else {
  untested.push("the shell (no --shell)");
  log("UNTESTED  the shell: run with --shell on a display");
}

writeFileSync(
  join(evidenceDir, `${label}-package.json`),
  `${JSON.stringify({ deb: deb.split(sep).pop(), kind: isAppImage ? "appimage" : "deb", node_binary_sha256: nodeBinarySha, node_binary_as_assembled: assembledSha ? nodeBinarySha === assembledSha : null, control, removed: removeList, shell_bin: opt["--shell-bin"] ?? null, node: { version: nodeVersion, signature: nodeSignature }, bin_js_sha256: binSha, sizes }, null, 2)}\n`
);
const verdict = smokeVerdict({ failures, untested, label });
log(`\n${verdict.line}`);
writeFileSync(join(evidenceDir, `${label}-result.txt`), `${results.join("\n")}\n`);
process.exit(verdict.code);
