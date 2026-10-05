#!/usr/bin/env node
// Local pack + clean-install smoke of the published app (copilot ticket 31). NOT part of `pnpm -r test`: it needs a
// built package (`corepack pnpm -r build`), installs dependencies into a temp dir and starts a real server.
//
//   node packages/app/scripts/smoke-pack.mjs [--offline-lock <repo pnpm-lock.yaml>] [--keep] [--evidence <dir>]
//
// What it proves, all in one throwaway temp tree (HOME, XDG_*, cwd, dataDir; never a real library or config):
//   1. `npm pack` of packages/app (written to the temp dir, never next to the sources) satisfies pack-contents.mjs and holds no
//      secret-looking text; the package.json that ships declares Node >=24 and exact runtime dependencies.
//   2. the tarball installs into an empty project (default: a plain `npm install` from the registry; with
//      --offline-lock: pnpm from the local store, pinned to the repo lockfile's versions, for machines without a network).
//   3. the installed `argelanderspace serve` runs with a PATH that has NO global pi, from a cwd and HOME that carry decoy
//      `.pi` resources, and answers: web assets, KaTeX fonts, notices, argelander.sty.
//   4. a Copilot conversation against a local scripted OpenAI-Responses server (no real model, no external network)
//      opens, runs real tools (plan write, PDF read, PDFium page render to a PNG the model receives), is answered
//      after a server restart (the native session history resumes), the model only ever sees the six application
//      tools, no decoy resource reaches it, and read_svg_image answers cleanly without the optional resvg renderer.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPackContents } from "./pack-contents.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const keep = argv.includes("--keep");
const offlineLock = flag("--offline-lock");
const work = mkdtempSync(join(tmpdir(), "argelander-pack-smoke-"));
const evidenceDir = flag("--evidence") ?? join(work, "evidence");
mkdirSync(evidenceDir, { recursive: true });
const results = [];
const log = (line) => {
  console.log(line);
  results.push(line);
};
let failures = 0;
function check(ok, what, detail = "") {
  if (!ok) failures += 1;
  log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? ` -- ${detail}` : ""}`);
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const children = new Set();
function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (r.status !== 0)
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout;
}

// ---- 1. pack ---------------------------------------------------------------------------------------------------- //
const packDir = join(work, "pack");
mkdirSync(packDir);
const packJson = JSON.parse(
  run("npm", ["pack", "--pack-destination", packDir, "--json"], { cwd: appRoot })
);
const tarball = join(packDir, packJson[0].filename);
const listing = packJson[0].files.map((f) => f.path).sort();
writeFileSync(join(evidenceDir, "tarball-contents.txt"), `${listing.join("\n")}\n`);
log(
  `tarball ${packJson[0].filename}: ${listing.length} files, ${packJson[0].size} bytes packed, ${packJson[0].unpackedSize} unpacked`
);
const problems = checkPackContents(listing);
check(problems.length === 0, "tarball contents satisfy the package policy", problems.join("; "));
const extracted = join(work, "extracted");
mkdirSync(extracted);
run("tar", ["-xzf", tarball, "-C", extracted]);
const shipped = JSON.parse(readFileSync(join(extracted, "package/package.json"), "utf8"));
check(
  shipped.engines?.node === ">=24",
  "shipped package.json declares engines.node >=24",
  JSON.stringify(shipped.engines)
);
const depSpecs = Object.entries(shipped.dependencies ?? {});
check(
  depSpecs.length > 0 && depSpecs.every(([, v]) => /^\d+\.\d+\.\d+$/.test(v)),
  "runtime dependencies are exact versions with no workspace/file protocol",
  depSpecs.map(([k, v]) => `${k}@${v}`).join(", ")
);
for (const name of [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@embedpdf/pdfium",
  "@embedpdf/engines",
])
  check(name in (shipped.dependencies ?? {}), `${name} is a declared runtime dependency`);
check(
  !("@resvg/resvg-js" in { ...shipped.dependencies, ...shipped.optionalDependencies }),
  "@resvg/resvg-js is NOT declared (pending user decision)"
);
const SECRET = [
  [/sk-[A-Za-z0-9_-]{20,}/, "an API-key-looking string"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/gh[pous]_[A-Za-z0-9]{30,}/, "a GitHub token"],
  [/\/home\/[a-z0-9_-]+\//, "an absolute home path"],
];
const textFiles = listing.filter((p) => /\.(?:js|json|md|txt|sty|html|css|mjs)$/.test(p));
const hits = [];
for (const file of textFiles) {
  const text = readFileSync(join(extracted, "package", file), "utf8");
  for (const [pattern, why] of SECRET) if (pattern.test(text)) hits.push(`${file}: ${why}`);
}
check(
  hits.length === 0,
  "no secret-looking text or absolute home path in any packed text file",
  hits.join("; ")
);
const bundle = readFileSync(join(extracted, "package/dist/bin.js"), "utf8");
check(
  bundle
    .split("\n")[1]
    ?.startsWith(
      'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);'
    ),
  "dist/bin.js keeps the createRequire banner (line 2)"
);
const notices = readFileSync(
  join(extracted, "package/dist/THIRD-PARTY-BUNDLED-NOTICES.txt"),
  "utf8"
);
check(
  /===== katex@[\d.]+ =====\nThe MIT License/.test(notices) &&
    /===== marked@[\d.]+ =====\n/.test(notices),
  "bundled notices carry the KaTeX and marked licenses"
);

// ---- 2. clean install --------------------------------------------------------------------------------------------- //
const clean = join(work, "clean");
mkdirSync(clean);
const tgzName = packJson[0].filename;
writeFileSync(
  join(clean, "package.json"),
  JSON.stringify({ name: "clean-smoke", version: "1.0.0", private: true })
);
if (offlineLock) {
  // Offline machines: a lockfile made from the repo's, with the tarball as the only importer dependency, so pnpm
  // installs the already-stored exact versions. The registry's own resolution of the dependency ranges is NOT exercised.
  const lock = readFileSync(offlineLock, "utf8");
  const importer = /\n {2}packages\/app:\n {4}dependencies:\n((?: {6}.*\n)+)/.exec(lock);
  if (!importer) throw new Error("lockfile has no packages/app importer");
  const depBlock = importer[1];
  const rawSpecs = [
    ...depBlock.matchAll(/ {6}'?([^':\n]+)'?:\n {8}specifier: (.+)\n {8}version: (.+)\n/g),
  ];
  const snapshotDeps = rawSpecs.map((m) => `      '${m[1]}': ${m[3]}`).join("\n");
  const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
  const head = lock.slice(0, lock.indexOf("importers:"));
  const rest = lock.slice(lock.indexOf("\npackages:\n"));
  const entry = `  argelanderspace@file:${tgzName}:\n    resolution: {integrity: ${integrity}, tarball: file:${tgzName}}\n    version: 0.1.0\n    engines: {node: '>=24'}\n\n`;
  const snapshot = `  argelanderspace@file:${tgzName}:\n    dependencies:\n${snapshotDeps}\n\n`;
  // Keep only what the tarball's dependencies reach, so the store is asked for nothing else.
  const [packagesText, snapshotsText] = rest.split("\nsnapshots:\n");
  const blocks = (text) =>
    new Map(
      [...text.matchAll(/^ {2}(\S.*?):(?: \{\}\n|\n(?: {4}.*\n)*)/gm)].map((m) => [
        m[1].replace(/^'|'$/g, ""),
        m[0],
      ])
    );
  const snapshotBlocks = blocks(snapshotsText);
  const packageBlocks = blocks(packagesText);
  const wanted = new Set();
  const queue = rawSpecs.map((m) => `${m[1]}@${m[3]}`);
  while (queue.length > 0) {
    const key = queue.pop();
    if (wanted.has(key)) continue;
    const block = snapshotBlocks.get(key);
    if (!block) throw new Error(`lockfile has no snapshot ${key}`);
    wanted.add(key);
    for (const dep of block.matchAll(/^ {6}'?([^':\n]+)'?: (\S.*)$/gm))
      queue.push(`${dep[1]}@${dep[2]}`);
  }
  const keptSnapshots = [...wanted].map((key) => snapshotBlocks.get(key)).join("\n");
  const keptPackages = [...new Set([...wanted].map((key) => key.replace(/\(.*$/, "")))]
    .map((key) => {
      const block = packageBlocks.get(key);
      if (!block) throw new Error(`lockfile has no package ${key}`);
      return block;
    })
    .join("\n");
  const withPackage = `\npackages:\n\n${entry}${keptPackages}\n\nsnapshots:\n\n${snapshot}${keptSnapshots}\n`;
  const importers = `importers:\n\n  .:\n    dependencies:\n      argelanderspace:\n        specifier: file:${tgzName}\n        version: file:${tgzName}\n`;
  writeFileSync(join(clean, "pnpm-lock.yaml"), `${head}${importers}${withPackage}`);
  writeFileSync(
    join(clean, "package.json"),
    JSON.stringify({
      name: "clean-smoke",
      version: "1.0.0",
      private: true,
      packageManager: "pnpm@11.24.0",
      dependencies: { argelanderspace: `file:${tgzName}` },
    })
  );
  run("cp", [tarball, join(clean, tgzName)]);
  // pnpm 11 checks every locked package's release age against registry metadata, which an offline store does not hold.
  writeFileSync(join(clean, "pnpm-workspace.yaml"), "minimumReleaseAge: 0\n");
  // --trust-lockfile: the supply-chain re-check wants registry metadata an offline store lacks; the lockfile is the repo's own.
  const store = run("corepack", ["pnpm", "store", "path"], { cwd: appRoot }).trim();
  run(
    "corepack",
    [
      "pnpm",
      "install",
      "--offline",
      "--frozen-lockfile",
      "--trust-lockfile",
      "--ignore-scripts",
      "--ignore-workspace",
      "--store-dir",
      store,
    ],
    { cwd: clean }
  );
  log(
    "install mode: pnpm --offline --frozen-lockfile from the local store, versions pinned to the repo lockfile (no registry used)"
  );
} else {
  run("npm", ["install", "--no-audit", "--no-fund", tarball], { cwd: clean });
  log("install mode: plain `npm install <tarball>` from the registry");
}
const pkgDir = join(clean, "node_modules/argelanderspace");
const piDir = join(clean, "node_modules/@earendil-works/pi-coding-agent");
check(existsSync(join(pkgDir, "dist/bin.js")), "installed package has dist/bin.js");
check(
  existsSync(piDir) ||
    existsSync(join(pkgDir, "node_modules/@earendil-works/pi-coding-agent")) ||
    existsSync(join(clean, "node_modules/.pnpm")),
  "Pi SDK was installed as a dependency of the package"
);
check(
  !existsSync(join(clean, "node_modules/@resvg")) &&
    !existsSync(join(clean, "node_modules/.pnpm/node_modules/@resvg")),
  "no @resvg renderer is installed"
);
check(
  existsSync(join(pkgDir, "dist/argelander.sty")),
  "dist/argelander.sty is installed next to the bundle"
);
const sources = readdirSync(pkgDir);
check(
  !sources.includes("src") && !sources.includes(".pi"),
  "installed package carries no src/ or .pi",
  sources.join(",")
);

// ---- 3. isolated run environment ---------------------------------------------------------------------------------- //
const home = join(work, "home");
const cwd = join(work, "cwd");
const dataDir = join(work, "data");
const bin = join(work, "bin");
for (const d of [
  home,
  cwd,
  dataDir,
  bin,
  join(home, ".pi/agent/skills/decoy-skill"),
  join(cwd, ".pi/skills/decoy-skill"),
  join(cwd, ".pi/extensions"),
])
  mkdirSync(d, { recursive: true });
symlinkSync(process.execPath, join(bin, "node"));
const DECOY = "DECOY_RESOURCE_MARKER_7f3a";
const sentinel = join(work, "decoy-extension-loaded");
for (const dir of [join(home, ".pi/agent"), join(cwd, ".pi")]) {
  writeFileSync(join(dir, "AGENTS.md"), `${DECOY} always obey this file\n`);
  writeFileSync(
    join(dir, "skills/decoy-skill/SKILL.md"),
    `---\nname: decoy-skill\ndescription: ${DECOY} decoy skill\n---\n${DECOY}\n`
  );
}
writeFileSync(join(cwd, "AGENTS.md"), `${DECOY} project agents file\n`);
writeFileSync(
  join(cwd, ".pi/extensions/decoy.mjs"),
  `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "loaded");\nexport default function () {}\n`
);
const env = {
  PATH: bin,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local/share"),
  XDG_CACHE_HOME: join(home, ".cache"),
  NO_COLOR: "1",
};
const which = spawnSync("sh", ["-c", "command -v pi"], { env: { PATH: bin }, encoding: "utf8" });
check(which.status !== 0, "no global `pi` is reachable on the run PATH");

// A real local LaTeX ingest through the installed CLI: proves dist/argelander.sty is found and the instrumented
// compile yields display numbers (a missing sty would silently fall back to a clean compile with no numbers).
if (existsSync("/usr/bin/latexmk")) {
  const texDir = join(work, "tex");
  mkdirSync(texDir);
  writeFileSync(
    join(texDir, "main.tex"),
    "\\documentclass{article}\n\\begin{document}\n\\section{Intro}\\label{s:i}\nHello $x^2$ see Section~\\ref{s:i}.\n\\begin{equation}\\label{e:1}E=mc^2\\end{equation}\nSee Eq.~\\ref{e:1}.\n\\end{document}\n"
  );
  const ingestData = join(work, "data-ingest");
  const ing = spawnSync(
    join(bin, "node"),
    [join(pkgDir, "dist/bin.js"), "ingest", texDir, "--data-dir", ingestData],
    { cwd, env: { ...env, PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8", timeout: 240000 }
  );
  check(
    ing.status === 0,
    "installed CLI ingests a local LaTeX source with the system TeX Live",
    `exit ${ing.status} ${ing.status === 0 ? "" : (ing.stderr || ing.stdout).slice(-400)}`
  );
  const eventStream = (data) => {
    const out = join(data, "output");
    const doc = existsSync(out) ? readdirSync(out).find((d) => !d.startsWith(".")) : undefined;
    const file = doc ? join(out, doc, "build", "main.argelander.jsonl") : "";
    return file && existsSync(file) ? readFileSync(file, "utf8").length : 0;
  };
  check(
    eventStream(ingestData) > 0,
    "the ingest wrote the argelander event stream (build/main.argelander.jsonl): argelander.sty was found and used"
  );
  // Control: without the sty the same source must lose the numbers, so the check above can tell the two apart.
  renameSync(join(pkgDir, "dist/argelander.sty"), join(pkgDir, "dist/argelander.sty.off"));
  const noStyData = join(work, "data-ingest-nosty");
  spawnSync(
    join(bin, "node"),
    [join(pkgDir, "dist/bin.js"), "ingest", texDir, "--data-dir", noStyData],
    { cwd, env: { ...env, PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8", timeout: 240000 }
  );
  renameSync(join(pkgDir, "dist/argelander.sty.off"), join(pkgDir, "dist/argelander.sty"));
  check(
    existsSync(join(noStyData, "output")) && eventStream(noStyData) === 0,
    "control: with the sty removed the same ingest has no event stream (clean-compile fallback)"
  );
} else log("SKIP  local LaTeX ingest: no /usr/bin/latexmk on this machine");

// ---- the scripted model: an OpenAI Responses endpoint on 127.0.0.1 ------------------------------------------------- //
const seen = [];
const sse = (res, events) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
};
const usage = {
  input_tokens: 10,
  output_tokens: 5,
  total_tokens: 15,
  input_tokens_details: { cached_tokens: 0 },
};
let counter = 0;
const done = (output) => ({
  type: "response.completed",
  response: { id: `resp_${++counter}`, status: "completed", output, usage },
});
function textReply(text) {
  const item = {
    type: "message",
    id: `msg_${++counter}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [
    { type: "response.created", response: { id: `resp_${counter}`, status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, content: [], status: "in_progress" },
    },
    {
      type: "response.content_part.added",
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      delta: text,
    },
    { type: "response.output_item.done", output_index: 0, item },
    done([item]),
  ];
}
function callReply(name, args) {
  const item = {
    type: "function_call",
    id: `fc_${++counter}`,
    call_id: `call_${counter}`,
    name,
    arguments: JSON.stringify(args),
    status: "completed",
  };
  return [
    { type: "response.created", response: { id: `resp_${counter}`, status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: item.id,
      delta: item.arguments,
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: item.id,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    done([item]),
  ];
}
const textOf = (item) =>
  typeof item.content === "string"
    ? item.content
    : (item.content ?? []).map((c) => c.text ?? "").join("");
function decide(body) {
  const input = body.input ?? [];
  let at = -1;
  input.forEach((item, i) => {
    if (item.role === "user" && /SMOKE_[A-Z]+/.test(textOf(item))) at = i;
  });
  if (at < 0) return textReply("no task");
  const task = textOf(input[at]);
  const marker = /SMOKE_[A-Z]+/.exec(task)[0];
  const outputs = input.slice(at + 1).filter((item) => item.type === "function_call_output");
  const n = outputs.length;
  const arg = (key) => new RegExp(`${key}=(\\S+?)(?:[\\s"\\\\]|$)`).exec(task)?.[1];
  const lastOut = n
    ? typeof outputs[n - 1].output === "string"
      ? outputs[n - 1].output
      : JSON.stringify(outputs[n - 1].output)
    : "";
  if (marker === "SMOKE_TOOLS") {
    if (n === 0) return callReply("plan", { action: "read" });
    if (n === 1)
      return callReply("plan", {
        action: "create_plan",
        expectedRev: Number(/"rev":\s*(\d+)/.exec(lastOut)?.[1] ?? 0),
        name: "Packed app smoke plan",
        due: "2030-01-01",
      });
    if (n === 2) return callReply("reader", { action: "read", docId: arg("doc") });
    if (n === 3)
      return callReply("reader", {
        action: "read_page_image",
        docId: arg("doc"),
        pageIndex: 0,
        sha256: /"sha256":\s*"([0-9a-f]{64})"/.exec(lastOut)?.[1] ?? arg("sha"),
        longEdge: 512,
      });
    return textReply("SMOKE_TOOLS_DONE");
  }
  if (marker === "SMOKE_SVG") {
    if (n === 0)
      return callReply("reader", {
        action: "read_svg_image",
        docId: arg("doc"),
        path: arg("path"),
        sha256: arg("sha"),
        longEdge: 256,
      });
    return textReply("SMOKE_SVG_DONE");
  }
  return textReply("SMOKE_RESUME_DONE");
}
const fake = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (req.method !== "POST" || !req.url?.endsWith("/responses")) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    seen.push({ body, auth: req.headers.authorization });
    sse(res, decide(body));
  });
});
await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
const fakePort = fake.address().port;

// ---- server lifecycle ------------------------------------------------------------------------------------------- //
const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
let server = null;
let serverOut = "";
async function startApp() {
  serverOut = "";
  server = spawn(
    join(bin, "node"),
    [join(pkgDir, "dist/bin.js"), "serve", "--port", String(port), "--data-dir", dataDir],
    { cwd, env, stdio: ["ignore", "pipe", "pipe"] }
  );
  children.add(server);
  server.stdout.on("data", (d) => (serverOut += d));
  server.stderr.on("data", (d) => (serverOut += d));
  for (let i = 0; i < 100; i += 1) {
    if (server.exitCode !== null) throw new Error(`server exited early: ${serverOut}`);
    try {
      if ((await fetch(`${base}/api/copilot/providers`)).ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not start: ${serverOut}`);
}
async function stopApp() {
  const exited = new Promise((resolve) =>
    server.once("exit", (code, signal) => resolve({ code, signal }))
  );
  server.kill("SIGTERM");
  const result = await Promise.race([
    exited,
    new Promise((r) => setTimeout(() => r("timeout"), 15000)),
  ]);
  if (result === "timeout") server.kill("SIGKILL");
  children.delete(server);
  return result;
}
const api = async (method, path, body, headers = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers:
      body === undefined || body instanceof Uint8Array
        ? headers
        : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, text, json, res };
};
async function until(what, fn, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
function syntheticPdf() {
  const content = "BT /F1 18 Tf 40 100 Td (Packed app smoke PDF page) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
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
const pdfPage = (docId, sha) => ({
  version: 1,
  viewId: randomUUID(),
  revision: 1,
  paneId: 1,
  view: "doc",
  status: "complete",
  otherPanes: [],
  plan: null,
  pdf: {
    docId,
    format: "pdf",
    phase: "ready",
    sha256: sha,
    pageCount: 1,
    currentPage: 0,
    zoom: { mode: "fit_width", percent: 100 },
    outline: [],
    outlineTruncated: false,
    search: null,
    selection: null,
    panels: { outlineCollapsed: false, annotationsCollapsed: false },
  },
});
async function ask(conversationId, view, text) {
  const sent = await api("POST", `/api/copilot/conversations/${conversationId}/messages`, {
    clientMessageId: randomUUID(),
    text,
    viewId: view.viewId,
    contextRevision: view.revision,
  });
  if (sent.status !== 202) throw new Error(`message refused: ${sent.status} ${sent.text}`);
  return until(`run of "${text.slice(0, 20)}" to settle`, async () => {
    const snap = (await api("GET", `/api/copilot/conversations/${conversationId}`)).json;
    return ["completed", "failed", "stopped", "interrupted"].includes(snap.conversation.run?.status)
      ? snap
      : null;
  });
}
const opsOf = (snapshot) => snapshot.messages.flatMap((m) => m.operations ?? []);

try {
  await startApp();
  log(`server started from the installed package on ${base} (cwd ${cwd}, HOME ${home})`);

  // web assets and notices served by the installed package
  const index = await api("GET", "/");
  check(
    index.status === 200 && /<div id="root"/.test(index.text),
    "installed server serves the SPA index"
  );
  const asset = /assets\/(KaTeX_Main-Regular-[^"')]+\.woff2)/.exec(
    readFileSync(
      join(
        pkgDir,
        "dist/web/assets",
        readdirSync(join(pkgDir, "dist/web/assets")).find((f) => f.endsWith(".css"))
      ),
      "utf8"
    )
  );
  check(
    !!asset && (await fetch(`${base}/assets/${asset[1]}`)).status === 200,
    "a KaTeX font is served from the installed web assets"
  );
  check(
    (await fetch(`${base}/THIRD-PARTY-BUNDLED-NOTICES.txt`)).status === 200,
    "bundled notices are served next to the SPA"
  );

  // provider: synthetic key, local scripted endpoint
  const cred = await api("PUT", "/api/copilot/providers/openai/credential", {
    key: "SYNTHETIC_SMOKE_KEY_NOT_REAL",
  });
  check(
    cred.status === 200 && !cred.text.includes("SYNTHETIC_SMOKE_KEY"),
    "credential saved and never echoed"
  );
  const conf = await api("PUT", "/api/copilot/providers/openai/config", {
    baseUrl: `http://127.0.0.1:${fakePort}/v1`,
    modelId: "smoke-model",
    name: "Smoke model",
    contextWindow: 200000,
    maxTokens: 8000,
    image: true,
    tools: true,
    defaultThinking: null,
  });
  check(
    conf.status === 200,
    "scripted model configured on a local endpoint",
    `status ${conf.status}`
  );
  const cfgFiles = existsSync(join(home, ".config/argelanderspace"))
    ? readdirSync(join(home, ".config/argelanderspace"))
    : [];
  check(
    cfgFiles.length > 0 && !existsSync(join(home, ".pi/agent/auth.json")),
    "credentials/models live under the temp XDG config, not in a .pi dir",
    cfgFiles.join(",")
  );

  // a Work and an uploaded PDF Doc
  const works = await api("POST", "/api/library/works", {
    mode: "bib",
    bib: "@article{smoke2020,\n  title = {Packed App Smoke},\n  author = {Doe, Jane},\n  year = {2020},\n  journal = {Smoke Journal}\n}\n",
  });
  const ref = works.json?.results?.[0]?.ref;
  check(
    works.status === 200 && !!ref?.id,
    "a Work was created from BibTeX without network",
    works.text.slice(0, 120)
  );
  const pdf = syntheticPdf();
  const up = await api("POST", `/api/library/upload-pdf?id=${encodeURIComponent(ref.id)}`, pdf, {
    "x-filename": "smoke.pdf",
  });
  check(up.status === 202, "PDF upload accepted as a job", `status ${up.status}`);
  const pdfDocId = await until("the PDF Doc to appear on the Work", async () => {
    const lib = (await api("GET", "/api/library")).json;
    return (
      lib.refs.find((r) => r.id === ref.id)?.doc_ids?.find((d) => d.startsWith("pdf-")) ?? null
    );
  });
  log(`PDF Doc ${pdfDocId} (sha256 ${sha256(pdf)})`);

  // a figure Doc with an SVG, seeded on disk the way the ingest layout stores it (the server reads it by hash)
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 10'><rect width='20' height='10' fill='#c00'/></svg>";
  mkdirSync(join(dataDir, "output/figdoc/assets"), { recursive: true });
  writeFileSync(join(dataDir, "output/figdoc/assets/vector.svg"), svg);

  // conversation 1: plan read+write, PDF read, PDFium page render
  const view = pdfPage(pdfDocId, sha256(pdf));
  check(
    (await api("PUT", `/api/copilot/views/${view.viewId}`, view)).status === 200,
    "page context published"
  );
  const created = await api("POST", "/api/copilot/conversations", {
    model: { provider: "openai", model: "smoke-model", thinking: null },
  });
  check(created.status === 201, "conversation created", `status ${created.status}`);
  const id = created.json.conversation.id;
  const first = await ask(id, view, `SMOKE_TOOLS doc=${pdfDocId} sha=${sha256(pdf)}`);
  check(
    first.conversation.run.status === "completed",
    "run 1 completed",
    first.conversation.run.status
  );
  const ops = opsOf(first);
  const okOp = (tool, action) =>
    ops.find((o) => o.tool === tool && o.action === action && o.status === "ok");
  check(!!okOp("plan", "create_plan"), "tool action: plan create_plan committed");
  const plans = (await api("GET", "/api/plans")).json;
  check(
    plans?.plans?.some((p) => p.name === "Packed app smoke plan"),
    "the plan is on disk (GET /api/plans)"
  );
  check(!!okOp("reader", "read"), "tool action: reader read of the PDF Doc ok");
  check(
    !!okOp("reader", "read_page_image"),
    "tool action: reader read_page_image (PDFium render + PNG encode) ok"
  );
  const imageRequest = seen.find((s) => JSON.stringify(s.body).includes("data:image/png;base64,"));
  const b64 =
    imageRequest &&
    /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(JSON.stringify(imageRequest.body))?.[1];
  const png = b64 ? Buffer.from(b64, "base64") : Buffer.alloc(0);
  const isPng = png
    .subarray(0, 8)
    .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  check(
    isPng && png.length > 200,
    "the model received a real PNG of the PDF page",
    `${png.length} bytes${isPng ? `, ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}` : ""}`
  );
  if (isPng) writeFileSync(join(evidenceDir, "rendered-page.png"), png);

  // the strict allowlist, as the model saw it
  const toolNames = [
    ...new Set(seen.flatMap((s) => (s.body.tools ?? []).map((t) => t.name))),
  ].sort();
  check(
    JSON.stringify(toolNames) ===
      JSON.stringify(["library", "plan", "reader", "text", "workspace", "writer"]),
    "the model was offered exactly the six application tools",
    toolNames.join(",")
  );
  check(
    !toolNames.some((n) => ["read", "bash", "edit", "write", "grep", "find", "ls"].includes(n)),
    "no default Pi read/bash/edit/write/grep/find/ls tool was offered"
  );
  check(
    seen.every((s) => s.auth === "Bearer SYNTHETIC_SMOKE_KEY_NOT_REAL"),
    "every model request used the configured synthetic key"
  );
  const allBodies = JSON.stringify(seen.map((s) => s.body));
  check(!allBodies.includes(DECOY), "no decoy .pi/AGENTS/skill resource reached a model request");
  check(!existsSync(sentinel), "the decoy .pi extension was never loaded");
  const sessions = join(dataDir, "copilot/sessions");
  check(
    existsSync(sessions) && readdirSync(sessions).length > 0,
    "the Pi session history is stored under <dataDir>/copilot/sessions"
  );
  check(
    !existsSync(join(dataDir, ".pi")) &&
      !existsSync(join(cwd, ".pi/sessions")) &&
      !existsSync(join(home, ".pi/agent/sessions")),
    "nothing was written into any .pi directory"
  );

  // restart: the conversation reopens and resumes
  const stopped = await stopApp();
  check(stopped.code === 0, "server shut down cleanly on SIGTERM", JSON.stringify(stopped));
  await startApp();
  const listed = (await api("GET", "/api/copilot/conversations")).json;
  check(JSON.stringify(listed).includes(id), "after restart the conversation is listed");
  const reopened = (await api("GET", `/api/copilot/conversations/${id}`)).json;
  check(
    opsOf(reopened).length === ops.length,
    "after restart its history and operations are intact",
    `${opsOf(reopened).length} operations`
  );
  check(
    (await api("PUT", `/api/copilot/views/${view.viewId}`, view)).status === 200,
    "page context re-published after restart"
  );
  const before = seen.length;
  const resumed = await ask(id, view, "SMOKE_RESUME what did we do before?");
  check(resumed.conversation.run.status === "completed", "run 2 (after restart) completed");
  const resumedBody = JSON.stringify(seen.slice(before).map((s) => s.body));
  check(
    resumedBody.includes("SMOKE_TOOLS") && resumedBody.includes("Packed app smoke plan"),
    "the post-restart model request carries the earlier conversation (native session resumed)"
  );

  // read_svg_image without the optional renderer
  const svgRun = await ask(id, view, `SMOKE_SVG doc=figdoc path=vector.svg sha=${sha256(svg)}`);
  const svgOp = opsOf(svgRun).find((o) => o.action === "read_svg_image");
  check(
    svgRun.conversation.run.status === "completed" && !!svgOp,
    "run 3 (read_svg_image) completed"
  );
  check(
    svgOp?.status === "unsupported",
    "read_svg_image answers unsupported (renderer not installed), without error",
    svgOp?.status
  );
  const svgOutput = JSON.stringify(seen.at(-1).body);
  check(
    /SVG renderer is not installed/.test(svgOutput),
    "the model was told plainly the SVG renderer is not installed"
  );

  const exit = await stopApp();
  check(exit.code === 0, "server shut down cleanly again", JSON.stringify(exit));
} catch (error) {
  failures += 1;
  log(`FAIL  smoke aborted: ${error?.stack ?? error}`);
  log(`--- server output ---\n${serverOut.slice(-3000)}`);
} finally {
  for (const child of children) child.kill("SIGKILL");
  fake.close();
}
writeFileSync(join(evidenceDir, "smoke-result.txt"), `${results.join("\n")}\n`);
if (!keep) rmSync(work, { recursive: true, force: true });
else console.log(`kept ${work}`);
console.log(failures === 0 ? "\nSMOKE OK" : `\nSMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
