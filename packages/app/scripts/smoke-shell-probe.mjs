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
//   2b. CJK in the shell's page (desktop-app ticket 28, handed to ticket 30): the guarded run starts in a fresh project
//      (the only entry of a fresh recent list); a one-page PDF whose CJK text uses a NON-embedded font is uploaded, the
//      page goes to its Reader (`/doc/<id>`), and the rendered page image is read in the page: ink on the Latin line
//      and on the CJK text. The CJK glyphs come only from the font fallback, whose fonts the page's PDFium worker
//      fetches from the local server (`/api/pdf-fonts/`; ticket 28's tests pin that the page hands the engine no
//      other source); without it the CJK area is blank. The worker's own fetches are not visible to the page, so the
//      route itself is only checked to answer from outside.
//   4. counter-check (`ARGELANDERSPACE_SHELL_PROBE_KEEP_ENTRIES=1`): with Tauri's entry points left in, the same probe
//      sees them (so the guarded run's "undefined" is not the probe's blindness) and the call is still refused (no
//      capability): the title stays.
// Exit: 0 `SMOKE OK`; 1 `SMOKE FAILED`. Nothing of the user's is read or written: every directory is a fresh temporary
// one (HOME, USERPROFILE, APPDATA, LOCALAPPDATA and the XDG directories point into it).
import { spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const argv = process.argv.slice(2);
const opt = {};
const flags = new Set();
for (let i = 0; i < argv.length; i += 1) {
  if (["--shell", "--evidence", "--label"].includes(argv[i]) && argv[i + 1] !== undefined) {
    opt[argv[i]] = argv[i + 1];
    i += 1;
  } else if (argv[i] === "--stand-in-host") {
    flags.add(argv[i]);
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

// --stand-in-host: the shell's packaged launcher finds, next to it, a stand-in instead of the package's host: this
// machine's Node (copied to sidecar/node/) running a small script (sidecar/app/dist/bin.js) that serves one page with
// a data-ui element and `/api/host`, and speaks just enough of the line protocol (a `ready` line; ends on `quit` or
// at the end of its input). It tests the shell alone (its page guard, single instance, quit) where the workspace
// cannot be built; the project and the CJK check are left out. Removed again at the end.
const standIn = flags.has("--stand-in-host");
const STAND_IN_HOST = `
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
const port = Number(process.env.ASPACE_STAND_IN_PORT);
const logDir = join(process.env.XDG_STATE_HOME || process.cwd(), "stand-in-logs");
mkdirSync(logDir, { recursive: true });
const page = '<!doctype html><html><head><meta charset="utf-8"><title>ArgelanderSpace</title></head>' +
  '<body><div id="root"><main data-ui="stand-in-host">stand-in host</main></div></body></html>';
const server = createServer((req, res) => {
  if (req.url === "/api/host") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ mode: "desktop", project: "none", standIn: true }));
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
});
const end = () => server.close(() => process.exit(0));
server.listen(port, "127.0.0.1", () => {
  const ready = { type: "ready", url: "http://127.0.0.1:" + port + "/", port, configuredPort: port,
    portFallback: false, portOccupant: null, project: null, logDir, language: "en" };
  process.stdout.write(JSON.stringify(ready) + String.fromCharCode(10));
});
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => { if (line.includes('"quit"')) end(); });
lines.on("close", end);
`;
const placed = [];
if (standIn) {
  const side = join(dirname(shellBin), "sidecar");
  if (existsSync(side)) {
    console.error(`smoke-shell-probe: ${side} is there already: not replaced`);
    process.exit(64);
  }
  const nodeDir = process.platform === "win32" ? join(side, "node") : join(side, "node", "bin");
  mkdirSync(nodeDir, { recursive: true });
  copyFileSync(process.execPath, join(nodeDir, process.platform === "win32" ? "node.exe" : "node"));
  if (process.platform !== "win32") chmodSync(join(nodeDir, "node"), 0o755);
  mkdirSync(join(side, "app", "dist"), { recursive: true });
  writeFileSync(join(side, "app", "dist", "bin.js"), STAND_IN_HOST);
  // ESM without a package.json "type": the .js must be read as a module.
  writeFileSync(join(side, "app", "package.json"), '{"type":"module"}\n');
  placed.push(side);
}

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
const runDirs = [];
const children = new Set();
const cleanup = () => {
  for (const c of children) {
    try {
      if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    } catch {}
  }
};
process.on("exit", cleanup);

function isolatedEnv(dir, port, project = null) {
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
    // The single-instance socket's folder (Unix): short, as a socket's path is at most 104 bytes on macOS (the
    // temporary folder there is long). On Windows the pipe is named after USERNAME: a name of the smoke's own.
    XDG_RUNTIME_DIR: process.platform === "win32" ? join(dir, "run") : mkdtempSync("/tmp/asp-"),
  });
  if (process.platform === "win32") env.USERNAME = `aspace-smoke-${process.pid}-${port}`;
  runDirs.push(env.XDG_RUNTIME_DIR);
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
  // The global data directory in the temporary tree too (its recent list names the project to start in).
  const global = join(dir, "global");
  mkdirSync(global, { recursive: true });
  writeFileSync(
    join(env.XDG_CONFIG_HOME, "argelanderspace", "config.toml"),
    `port = ${port}\nglobal_dir = '${global}'\n`
  );
  if (project) {
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(global, "recent-projects.json"),
      `${JSON.stringify({ version: 1, projects: [{ path: project, openedAt: new Date().toISOString() }] })}\n`
    );
  }
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

// The PDF of smoke-dep-dir.mjs (ticket 28): Latin in Helvetica, "中文测试" in /STSong-Light, NOT embedded.
function cjkPdf() {
  const content =
    "BT /F1 16 Tf 20 150 Td (Dependency smoke Latin line) Tj ET\nBT /F2 24 Tf 20 100 Td <4E2D65876D4B8BD5> Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [7 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /FontDescriptor 8 0 R >>",
    "<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

async function api(port, method, path, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (Buffer.isBuffer(body)) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, init);
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, text, json };
  } catch (e) {
    return { status: 0, text: String(e), json: null };
  }
}

// Runs a script in the shell's page through the probe's control file; its answer (the n-th `js` line) or null.
async function pageJs(controlFile, probeFile, n, script, shell, ms = 60000) {
  appendFileSync(controlFile, `js ${script.replace(/\n/g, " ")}\n`);
  for (let i = 0; i < ms / 200 && shell.exitCode === null; i += 1) {
    const answers = readLines(probeFile).filter((l) => "js" in l);
    if (answers.length > n) return answers[n].js;
    await sleep(200);
  }
  return null;
}

// In the page: waits for the Reader's first page image, then counts dark pixels where each line's ink falls (as
// fractions of the 300x200 pt page: the Latin line around 34-54 pt from the top, the CJK text around 76-106 pt).
const READER_INK = `
for (let i = 0; i < 300; i++) {
  const el = document.querySelector('[data-ui="pdf-page-content"] img, [data-ui="pdf-page-content"] canvas');
  if (el && (el.tagName === "CANVAS" || (el.complete && el.naturalWidth > 0))) break;
  await new Promise((r) => setTimeout(r, 200));
}
await new Promise((r) => setTimeout(r, 2000));
const el = document.querySelector('[data-ui="pdf-page-content"] img, [data-ui="pdf-page-content"] canvas');
if (!el) return JSON.stringify({ error: "no page image", href: location.href, dataUi: [...new Set([...document.querySelectorAll("[data-ui]")].map((e) => e.dataset.ui))].slice(0, 40) });
const w = el.tagName === "CANVAS" ? el.width : el.naturalWidth;
const h = el.tagName === "CANVAS" ? el.height : el.naturalHeight;
const c = document.createElement("canvas");
c.width = w;
c.height = h;
const g = c.getContext("2d");
g.drawImage(el, 0, 0, w, h);
const d = g.getImageData(0, 0, w, h).data;
const ink = (x0, x1, y0, y1) => {
  let n = 0, all = 0;
  for (let y = Math.floor(y0 * h); y < Math.ceil(y1 * h); y++)
    for (let x = Math.floor(x0 * w); x < Math.ceil(x1 * w); x++) {
      const k = (y * w + x) * 4;
      all++;
      if (d[k + 3] > 0 && d[k] + d[k + 1] + d[k + 2] < 384) n++;
    }
  return { dark: n, of: all };
};
return JSON.stringify({ href: location.href, tag: el.tagName, w, h, latin: ink(0.06, 0.8, 0.17, 0.27), cjk: ink(0.06, 0.4, 0.37, 0.54) });
`;

// The host's jobs as its WebSocket's hello message lists them (smoke-dep-dir.mjs does the same); [] when none came.
async function jobs(port) {
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    return await new Promise((done) => {
      const timer = setTimeout(() => done([]), 3000);
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.type === "hello") {
          clearTimeout(timer);
          ws.close();
          done(
            (msg.jobs ?? []).map((j) => ({
              kind: j.kind,
              status: j.status,
              error: String(j.error ?? "").slice(0, 300),
            }))
          );
        }
      };
      ws.onerror = () => done([]);
    });
  } catch {
    return [];
  }
}

async function cjkInPage(name, port, controlFile, probeFile, shell) {
  const host = await api(port, "GET", "/api/host");
  check(
    host.json?.project === "open",
    `${name}: the host opened the project of the recent list`,
    JSON.stringify(host.json?.project ?? null)
  );
  const works = await api(port, "POST", "/api/library/works", {
    mode: "bib",
    bib: "@article{shellcjk2026,\n  title = {Shell CJK Smoke},\n  author = {Doe, Jane},\n  year = {2026},\n  journal = {Smoke}\n}\n",
  });
  const ref = works.json?.results?.[0]?.ref;
  const up = ref?.id
    ? await api(
        port,
        "POST",
        `/api/library/upload-pdf?id=${encodeURIComponent(ref.id)}`,
        cjkPdf(),
        { "x-filename": "cjk.pdf" }
      )
    : { status: 0 };
  let docId = null;
  // Up to three minutes: the upload job runs PDFium on the PDF first (slow on a busy runner).
  for (let i = 0; i < 900 && up.status === 202 && !docId; i += 1) {
    const lib = await api(port, "GET", "/api/library");
    docId =
      lib.json?.refs?.find((r) => r.id === ref.id)?.doc_ids?.find((d) => d.startsWith("pdf-")) ??
      null;
    if (!docId) await sleep(200);
  }
  check(
    !!docId,
    `${name}: the CJK PDF was uploaded into the project`,
    docId ?? `works ${works.status}, upload ${up.status}; jobs ${JSON.stringify(await jobs(port))}`
  );
  const font = await fetch(
    `http://127.0.0.1:${port}/api/pdf-fonts/sc/1.0.0/NotoSansHans-Regular.otf`
  ).then(
    async (r) => ({
      status: r.status,
      otf:
        Buffer.from(await r.arrayBuffer())
          .subarray(0, 4)
          .toString("latin1") === "OTTO",
    }),
    () => ({ status: 0, otf: false })
  );
  check(
    font.status === 200 && font.otf,
    `${name}: the host answers the page's CJK font route`,
    JSON.stringify(font)
  );
  if (!docId) return;
  const went = await pageJs(
    controlFile,
    probeFile,
    0,
    `setTimeout(() => { location.href = "/doc/${encodeURIComponent(docId)}"; }, 100); return "going";`,
    shell
  );
  check(
    went === "going",
    `${name}: the page was sent to the Reader of the PDF`,
    JSON.stringify(went)
  );
  await sleep(1500);
  const answer = await pageJs(controlFile, probeFile, 1, READER_INK, shell, 90000);
  let seen = null;
  try {
    seen = JSON.parse(answer);
  } catch {
    seen = { unparsed: answer };
  }
  log(`${name}: the Reader's page image ${JSON.stringify(seen)}`);
  const share = (r) => (r?.of ? r.dark / r.of : 0);
  check(
    share(seen?.latin) > 0.005,
    `${name}: the shell's page renders the Latin line of the PDF`,
    JSON.stringify(seen?.latin ?? seen)
  );
  check(
    share(seen?.cjk) > 0.005,
    `${name}: the shell's page renders the non-embedded CJK text (the PDF engine's font fallback, fonts from the local server)`,
    JSON.stringify(seen?.cjk ?? seen)
  );
}

async function waitExit(child, ms) {
  for (let i = 0; i < ms / 100 && child.exitCode === null && child.signalCode === null; i += 1)
    await sleep(100);
  return child.exitCode !== null || child.signalCode !== null;
}

async function run(name, { keepEntries, cjk }) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  const port = await freePort();
  const { env, home } = isolatedEnv(dir, port, cjk ? join(dir, "project") : null);
  const probeFile = join(dir, "probe.jsonl");
  const controlFile = join(dir, "control.txt");
  writeFileSync(controlFile, "");
  env.ARGELANDERSPACE_SHELL_PROBE = probeFile;
  env.ARGELANDERSPACE_SHELL_PROBE_CONTROL = controlFile;
  if (keepEntries) env.ARGELANDERSPACE_SHELL_PROBE_KEEP_ENTRIES = "1";
  if (standIn) env.ASPACE_STAND_IN_PORT = String(port);
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
  if (cjk && host) await cjkInPage(name, port, controlFile, probeFile, shell);
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
  await run("guarded", { keepEntries: false, cjk: !standIn });
  await run("entries-kept", { keepEntries: true, cjk: false });
} finally {
  cleanup();
  for (const d of [work, ...runDirs, ...placed]) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5 });
    } catch {}
  }
}
const failed = results.filter((r) => !r.ok);
log(
  failed.length === 0
    ? `SMOKE OK (${results.length} checks)`
    : `SMOKE FAILED (${failed.length} of ${results.length})`
);
process.exit(failed.length === 0 ? 0 : 1);
