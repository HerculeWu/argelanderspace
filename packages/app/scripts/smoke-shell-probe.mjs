#!/usr/bin/env node
// The shell's page guard on a real webview (desktop-app ticket 30; ticket 20's probe, on any platform): starts a TEST
// build of the shell (`--features smoke-probe,packaged`, placed where it finds the package's resources) with a home,
// configuration and data of its own, and reads what its probe reports from the page.
//
//   node packages/app/scripts/smoke-shell-probe.mjs --shell <executable> [--evidence <dir>] [--label <name>]
//
// Checks, in this order:
//   1. guarded run: the shell starts its host (the page answers `/api/host` in desktop mode), the page loads, and the
//      page sees nothing of Tauri (`__TAURI__`, `__TAURI_INTERNALS__`, `ipc`, no Tauri-named globals, no WebKit `ipc`
//      message handler, no entry to call); the window title is not changed by the attempted calls;
//   2. single instance: a second start of the shell ends by itself and leaves the first running;
//   3. quit: the probe's `menu quit` ends the shell, its host, and frees the port;
//   4. counter-check (`ARGELANDERSPACE_SHELL_PROBE_KEEP_ENTRIES=1`): with Tauri's entry points left in, the same probe
//      sees them (so the guarded run's "undefined" is not the probe's blindness) and the call is still refused (no
//      capability): the title stays.
// Exit: 0 `SMOKE OK`; 1 `SMOKE FAILED`. Nothing of the user's is read or written: every directory is a fresh temporary
// one (HOME, USERPROFILE, APPDATA, LOCALAPPDATA and the XDG directories point into it).
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i += 1) {
  if (["--shell", "--evidence", "--label"].includes(argv[i]) && argv[i + 1] !== undefined) {
    opt[argv[i]] = argv[i + 1];
    i += 1;
  } else {
    console.error(`smoke-shell-probe: unknown argument ${argv[i]}`);
    process.exit(64);
  }
}
if (!opt["--shell"]) {
  console.error("smoke-shell-probe: --shell <executable> is required");
  process.exit(64);
}
const shellBin = resolve(opt["--shell"]);
const label = opt["--label"] ?? process.platform;
const evidence = opt["--evidence"] ? resolve(opt["--evidence"]) : null;
if (evidence) mkdirSync(evidence, { recursive: true });

const results = [];
const log = (line) => {
  console.log(line);
  if (evidence) appendFileSync(join(evidence, `shell-probe-${label}.txt`), `${line}\n`);
};
const check = (ok, what, detail = "") => {
  results.push({ ok, what });
  log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const work = mkdtempSync(join(tmpdir(), "aspace-shell-probe-"));
const children = new Set();
const cleanup = () => {
  for (const c of children) {
    try {
      if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    } catch {}
  }
};
process.on("exit", cleanup);

function isolatedEnv(dir, port) {
  const home = join(dir, "home");
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("ARGELANDERSPACE_")) delete env[k];
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_RUNTIME_DIR: join(dir, "run"),
  });
  for (const d of [
    env.APPDATA,
    env.LOCALAPPDATA,
    env.XDG_DATA_HOME,
    env.XDG_STATE_HOME,
    env.XDG_CACHE_HOME,
  ])
    mkdirSync(d, { recursive: true });
  mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(join(env.XDG_CONFIG_HOME, "argelanderspace"), { recursive: true });
  writeFileSync(join(env.XDG_CONFIG_HOME, "argelanderspace", "config.toml"), `port = ${port}\n`);
  return { env, home };
}

function startShell(env, cwd) {
  const shell = spawn(shellBin, [], { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
  children.add(shell);
  shell.stderrText = "";
  shell.stderr.on("data", (d) => {
    shell.stderrText += d;
  });
  return shell;
}

async function waitHost(port, shell) {
  for (let i = 0; i < 300 && shell.exitCode === null; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/host`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(200);
  }
  return null;
}

const readLines = (file) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return { unparsed: l };
          }
        })
    : [];

async function waitProbe(file, shell) {
  for (let i = 0; i < 300 && shell.exitCode === null; i += 1) {
    const page = readLines(file).find((l) => typeof l.page === "string");
    if (page) {
      let seen = null;
      try {
        seen = JSON.parse(page.page);
      } catch {
        seen = { unparsed: page.page };
      }
      return { seen, windowTitle: page.windowTitle };
    }
    await sleep(200);
  }
  return null;
}

async function waitExit(child, ms) {
  for (let i = 0; i < ms / 100 && child.exitCode === null && child.signalCode === null; i += 1)
    await sleep(100);
  return child.exitCode !== null || child.signalCode !== null;
}

async function run(name, { keepEntries }) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  const port = await freePort();
  const { env, home } = isolatedEnv(dir, port);
  const probeFile = join(dir, "probe.jsonl");
  const controlFile = join(dir, "control.txt");
  writeFileSync(controlFile, "");
  env.ARGELANDERSPACE_SHELL_PROBE = probeFile;
  env.ARGELANDERSPACE_SHELL_PROBE_CONTROL = controlFile;
  if (keepEntries) env.ARGELANDERSPACE_SHELL_PROBE_KEEP_ENTRIES = "1";
  log(`--- ${name}: starting ${shellBin} (port ${port})`);
  const shell = startShell(env, home);
  const host = await waitHost(port, shell);
  check(
    host?.mode === "desktop",
    `${name}: the shell started a desktop host on the configured port`,
    host
      ? JSON.stringify({ mode: host.mode })
      : `no answer; exit ${shell.exitCode}; ${shell.stderrText.slice(-400)}`
  );
  const probe = host ? await waitProbe(probeFile, shell) : null;
  if (evidence && existsSync(probeFile))
    writeFileSync(join(evidence, `shell-probe-${label}-${name}.jsonl`), readFileSync(probeFile));
  const seen = probe?.seen ?? {};
  log(
    `${name}: page saw ${JSON.stringify(seen)}; window title ${JSON.stringify(probe?.windowTitle)}`
  );
  check(
    !!probe && !seen.error && !seen.unparsed,
    `${name}: the probe ran in the loaded page`,
    seen.error ?? seen.unparsed ?? ""
  );
  check(
    typeof seen.href === "string" && seen.href.startsWith(`http://127.0.0.1:${port}/`),
    `${name}: the window shows the host's page`,
    String(seen.href)
  );
  check(
    Array.isArray(seen.dataUi) && seen.dataUi.length > 0,
    `${name}: the page rendered (data-ui elements)`,
    JSON.stringify(seen.dataUi ?? null)
  );
  check(
    probe?.windowTitle !== "PROBE",
    `${name}: the attempted Tauri calls did not change the window title`,
    JSON.stringify(probe?.windowTitle)
  );
  check(
    !/^2\d\d /.test(String(seen.ipcFetch)),
    `${name}: a bare ipc:// call is not answered with success`,
    String(seen.ipcFetch)
  );
  check(
    !/^2\d\d /.test(String(seen.ipcHttpFetch)),
    `${name}: a bare http://ipc.localhost call is not answered with success`,
    String(seen.ipcHttpFetch)
  );
  if (keepEntries) {
    check(
      seen.internals === "object",
      `${name}: with the entries left in, the probe sees __TAURI_INTERNALS__ (the probe is not blind)`,
      String(seen.internals)
    );
    check(
      String(seen.invoke).startsWith("rejected"),
      `${name}: with the entries left in, the call is refused (no capability)`,
      String(seen.invoke)
    );
  } else {
    check(
      seen.tauri === "undefined" && seen.internals === "undefined" && seen.ipc === "undefined",
      `${name}: __TAURI__, __TAURI_INTERNALS__ and ipc are undefined in the page`,
      JSON.stringify({ tauri: seen.tauri, internals: seen.internals, ipc: seen.ipc })
    );
    check(
      Array.isArray(seen.names) && seen.names.length === 0,
      `${name}: no Tauri-named globals`,
      JSON.stringify(seen.names)
    );
    check(
      seen.webkitIpcHandler === false,
      `${name}: no WebKit ipc message handler`,
      String(seen.webkitIpcHandler)
    );
    check(seen.invoke === "no entry", `${name}: no entry to call Tauri`, String(seen.invoke));
    // Single instance: a second start ends by itself and the first keeps running.
    const second = startShell(env, home);
    const secondEnded = await waitExit(second, 20000);
    check(
      secondEnded && second.exitCode === 0 && shell.exitCode === null,
      `${name}: a second start hands over to the running shell and ends`,
      JSON.stringify({
        second: second.exitCode ?? second.signalCode ?? "running",
        first: shell.exitCode ?? "running",
      })
    );
  }
  // Quit through the menu item (as Ctrl/Cmd+Q).
  appendFileSync(controlFile, "menu quit\n");
  const ended = await waitExit(shell, 30000);
  let free = false;
  for (let i = 0; i < 100 && !free; i += 1) {
    free = !(await portOpen(port));
    if (!free) await sleep(100);
  }
  check(
    ended && free,
    `${name}: "quit" ends the shell and its host, and frees the port`,
    JSON.stringify({ shell: shell.exitCode ?? shell.signalCode ?? "running", portFree: free })
  );
  if (shell.stderrText && evidence)
    writeFileSync(
      join(evidence, `shell-probe-${label}-${name}-stderr.txt`),
      shell.stderrText.slice(-20000)
    );
  cleanup();
}

try {
  await run("guarded", { keepEntries: false });
  await run("entries-kept", { keepEntries: true });
} finally {
  cleanup();
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  } catch {}
}
const failed = results.filter((r) => !r.ok);
log(
  failed.length === 0
    ? `SMOKE OK (${results.length} checks)`
    : `SMOKE FAILED (${failed.length} of ${results.length})`
);
process.exit(failed.length === 0 ? 0 : 1);
