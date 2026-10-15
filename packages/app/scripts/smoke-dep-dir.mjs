#!/usr/bin/env node
// Smoke of a generated dependency directory (desktop-app ticket 22). NOT part of `pnpm -r test`: it needs a built app
// (`corepack pnpm -r build`) and a directory from dep-dir.mjs, and starts a real desktop host.
//
//   node packages/app/scripts/smoke-dep-dir.mjs --deps <dep-dir.mjs --out dir> [--remove <path,...>] [--label <name>]
//        [--evidence <dir>] [--keep]
//
//   --remove  comma list of paths relative to node_modules to delete from the COPY before running (to make a variant
//             that should fail, e.g. a whole font package, or this platform's own keyring binary).
//
// It lays out a sidecar the way the desktop package will (`<tmp>/sidecar/app/dist` = packages/app/dist,
// `<tmp>/sidecar/app/node_modules` = a copy of the dependency directory), then starts `bin.js desktop-host --project
// <empty temp folder>` with this Node and an env allowlist: temp HOME / XDG_* / XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS
// pointing at a socket that does not exist (the real keychain is never reached), PATH=/usr/bin:/bin (TeX only; the
// repo's node_modules are never on any lookup path: the sidecar lives in the temp dir). A loader hook records every
// module file Node loads, so the evidence shows which dependency files the run really touched.
//
// Paths exercised: the host's ready line and the SPA; the keychain probe (GET /api/environment: `no_module` means the
// native module did not load, `no_bus` means it loaded and only the session bus is missing); a PDF upload (PDFium probe
// in the server), its text layer and a page render, with a PDF whose CJK text uses a NON-embedded font (the case a
// font fallback would serve); a Copilot run against a scripted local OpenAI-Responses endpoint (Pi SDK, provider, a
// reader tool that renders the PDF page); a LaTeX ingest through the CLI of the same sidecar (argelander.sty).
// Nothing is written outside the temp dir (and the evidence dir); the temp dir is removed unless --keep.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const depsArg = flag("--deps");
if (!depsArg) throw new Error("--deps <directory made by dep-dir.mjs> is required");
const depsDir = existsSync(join(resolve(depsArg), "node_modules"))
  ? join(resolve(depsArg), "node_modules")
  : resolve(depsArg);
const label = flag("--label") ?? "run";
const removeList = (flag("--remove") ?? "").split(",").filter(Boolean);
const keep = argv.includes("--keep");
const work = mkdtempSync(join(tmpdir(), "argelander-dep-dir-smoke-"));
const evidenceDir = resolve(flag("--evidence") ?? join(work, "evidence"));
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
const children = new Set();
process.on("exit", () => {
  for (const child of children) child.kill("SIGKILL");
  if (keep) console.log(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(1));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// ---- sidecar layout ---------------------------------------------------------------------------------------------- //
const sidecar = join(work, "sidecar/app");
cpSync(join(appRoot, "dist"), join(sidecar, "dist"), { recursive: true });
cpSync(depsDir, join(sidecar, "node_modules"), { recursive: true, verbatimSymlinks: true });
for (const rel of removeList) {
  const p = join(sidecar, "node_modules", rel);
  if (!existsSync(p)) throw new Error(`--remove ${rel}: not in the dependency directory`);
  rmSync(p, { recursive: true, force: true });
}
log(
  `variant ${label}: deps ${depsDir}${removeList.length ? `, removed ${removeList.join(", ")}` : ""}`
);
const binJs = join(sidecar, "dist/bin.js");

// ---- isolated environment ---------------------------------------------------------------------------------------- //
const home = join(work, "home");
const runtimeDir = join(work, "runtime");
const project = join(work, "project");
for (const d of [home, runtimeDir, project]) mkdirSync(d, { recursive: true, mode: 0o700 });
const env = {
  PATH: "/usr/bin:/bin",
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
// Records every module Node loads (ESM and require), so the evidence shows which dependency files were used.
const traceFile = join(work, "modules.txt");
const hook = join(work, "trace-hook.mjs");
writeFileSync(
  hook,
  `import { registerHooks } from "node:module";\nimport { appendFileSync } from "node:fs";\nregisterHooks({ load(url, context, next) { appendFileSync(${JSON.stringify(traceFile)}, url + "\\n"); return next(url, context); } });\n`
);
const nodeArgs = ["--import", pathToFileURL(hook).href];
const mark = (phase) => appendFileSync(traceFile, `# ${phase}\n`);

// ---- the scripted model ------------------------------------------------------------------------------------------ //
const seen = [];
let counter = 0;
const usage = {
  input_tokens: 10,
  output_tokens: 5,
  total_tokens: 15,
  input_tokens_details: { cached_tokens: 0 },
};
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
  const task = input
    .filter((i) => i.role === "user")
    .map(textOf)
    .find((t) => t.includes("SMOKE_PDF"));
  if (!task) return textReply("no task");
  const outputs = input.filter((i) => i.type === "function_call_output");
  const arg = (key) => new RegExp(`${key}=(\\S+?)(?:[\\s"\\\\]|$)`).exec(task)?.[1];
  if (outputs.length === 0)
    return callReply("reader", {
      action: "read_page_image",
      docId: arg("doc"),
      pageIndex: 0,
      sha256: arg("sha"),
      longEdge: 512,
    });
  return textReply("SMOKE_PDF_DONE");
}
const fake = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (req.method !== "POST" || !req.url?.endsWith("/responses"))
      return void res.writeHead(404).end();
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    seen.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const e of decide(body)) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.end();
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const fakePort = fake.address().port;

// ---- the host ---------------------------------------------------------------------------------------------------- //
let host = null;
let base = "";
let hostErr = "";
const lines = [];
async function startHost() {
  mark("host start");
  host = spawn(process.execPath, [...nodeArgs, binJs, "desktop-host", "--project", project], {
    cwd: home,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(host);
  let buf = "";
  host.stdout.on("data", (d) => {
    buf += d;
    let i = buf.indexOf("\n");
    while (i >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        lines.push(JSON.parse(line));
      } catch {
        lines.push({ type: "unparsed", line });
      }
      i = buf.indexOf("\n");
    }
  });
  host.stderr.on("data", (d) => (hostErr += d));
  const exited = new Promise((r) => host.once("exit", (code) => r(code)));
  for (let i = 0; i < 300; i += 1) {
    const ready = lines.find((l) => l.type === "ready");
    if (ready) {
      base = `http://127.0.0.1:${ready.port}`;
      return ready;
    }
    if (host.exitCode !== null || lines.some((l) => l.type === "failed")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
  return null;
}
const ours = () => {
  if (!host || host.exitCode !== null) throw new Error("the smoke host is not running");
  if (!base) throw new Error("no ready line from the smoke host");
};
async function api(method, path, body, headers = {}) {
  ours();
  const res = await fetch(`${base}${path}`, {
    method,
    headers:
      body === undefined || body instanceof Uint8Array
        ? headers
        : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try {
    json = JSON.parse(buf.toString("utf8"));
  } catch {}
  return { status: res.status, buf, text: buf.toString("utf8"), json };
}
/** The server's job list, as the /ws hello message carries it. */
async function jobsSnapshot() {
  ours();
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve([]), 3000);
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.type === "hello") {
          clearTimeout(timer);
          resolve(msg.jobs ?? []);
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        resolve([]);
      };
    });
  } finally {
    ws.close();
  }
}
async function until(what, fn, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

// A one-page PDF: Latin text in Helvetica (a standard font) and CJK text "中文测试" in a Type0 font whose CID font
// /STSong-Light is NOT embedded (Adobe-GB1, UniGB-UCS2-H) — the case where a font fallback would supply the glyphs.
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
const pdfView = (docId, sha) => ({
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
const observed = { label, removed: removeList };

try {
  const ready = await startHost();
  check(
    !!ready,
    "the desktop host started from the sidecar and wrote its ready line",
    ready ? `port ${ready.port}` : hostErr.slice(-600).replace(/\s+/g, " ")
  );
  observed.started = !!ready;
  if (!ready) throw new Error("host did not start");
  const index = await api("GET", "/");
  check(
    index.status === 200 && /<div id="root"/.test(index.text),
    "the SPA is served from sidecar/app/dist/web"
  );
  // Before ANY write: a fresh temp instance (empty library in the temp project).
  const lib = await api("GET", "/api/library");
  if (lib.status !== 200 || lib.json?.refs?.length !== 0)
    throw new Error("not the fresh temp instance; aborting before any write");

  mark("keychain");
  const envReport = await api("GET", "/api/environment");
  observed.keychain = envReport.json?.keychain;
  check(
    envReport.json?.keychain?.reason === "no_bus",
    "keychain module loads (probe reaches the bus check; the bus is absent on purpose, so state unavailable/no_bus)",
    JSON.stringify(envReport.json?.keychain)
  );

  mark("pdf");
  const works = await api("POST", "/api/library/works", {
    mode: "bib",
    bib: "@article{depsmoke2026,\n  title = {Dependency Directory Smoke},\n  author = {Doe, Jane},\n  year = {2026},\n  journal = {Smoke}\n}\n",
  });
  const ref = works.json?.results?.[0]?.ref;
  check(works.status === 200 && !!ref?.id, "a Work was created from BibTeX");
  const pdf = cjkPdf();
  const up = await api("POST", `/api/library/upload-pdf?id=${encodeURIComponent(ref.id)}`, pdf, {
    "x-filename": "cjk.pdf",
  });
  let docId = null;
  if (up.status === 202) {
    docId = await until(
      "the PDF upload job to settle",
      async () => {
        const l = (await api("GET", "/api/library")).json;
        const found = l.refs
          .find((r) => r.id === ref.id)
          ?.doc_ids?.find((d) => d.startsWith("pdf-"));
        if (found) return found;
        const failed = (await jobsSnapshot()).find(
          (j) => j.status === "failed" || j.status === "error"
        );
        return failed
          ? `FAILED: job ${failed.status}: ${String(failed.error ?? "").slice(0, 300)}`
          : null;
      },
      60000
    ).catch((e) => `FAILED:${e.message}`);
  }
  const uploaded = !!docId && !docId.startsWith("FAILED");
  observed.upload = uploaded ? "ok" : (docId ?? `status ${up.status}`);
  check(
    uploaded,
    "PDF upload: PDFium probe accepted the CJK PDF and the Doc was published",
    uploaded ? docId : `${up.status} ${docId ?? up.text.slice(0, 200)}`
  );
  if (uploaded) {
    const sha = sha256(pdf);
    const pages = await api("GET", `/api/paper/${docId}/pdf/pages?first=0&last=0&hash=${sha}`);
    const pageText = JSON.stringify(pages.json?.pages ?? "");
    observed.textLayer = {
      status: pages.status,
      cjk: pageText.includes("中文测试"),
      latin: pageText.includes("Dependency smoke"),
    };
    writeFileSync(join(evidenceDir, `${label}-pages.json`), pages.text);
    check(
      pages.status === 200 && observed.textLayer.cjk && observed.textLayer.latin,
      "text layer has the Latin line and the CJK text 中文测试",
      JSON.stringify(observed.textLayer)
    );
    const img = await api("GET", `/api/paper/${docId}/pdf/pages/0/image?hash=${sha}&edge=600`);
    const isPng = img.buf
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    observed.render = {
      status: img.status,
      png: isPng,
      bytes: img.buf.length,
      sha256: isPng ? sha256(img.buf) : null,
    };
    if (isPng) writeFileSync(join(evidenceDir, `${label}-page0.png`), img.buf);
    check(
      img.status === 200 && isPng,
      "PDFium renders page 0 to a PNG",
      JSON.stringify(observed.render)
    );

    mark("copilot");
    const cred = await api("PUT", "/api/copilot/providers/openai/credential", {
      key: "SYNTHETIC_DEP_SMOKE_KEY_NOT_REAL",
    });
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
      cred.status === 200 && conf.status === 200,
      "scripted model configured (synthetic key, local endpoint)",
      `${cred.status}/${conf.status}`
    );
    const view = pdfView(docId, sha);
    await api("PUT", `/api/copilot/views/${view.viewId}`, view);
    const created = await api("POST", "/api/copilot/conversations", {
      model: { provider: "openai", model: "smoke-model", thinking: null },
    });
    const cid = created.json?.conversation?.id;
    const sent = cid
      ? await api("POST", `/api/copilot/conversations/${cid}/messages`, {
          clientMessageId: randomUUID(),
          text: `SMOKE_PDF doc=${docId} sha=${sha}`,
          viewId: view.viewId,
          contextRevision: view.revision,
        })
      : { status: 0 };
    let snap = null;
    if (sent.status === 202)
      snap = await until("the Copilot run to settle", async () => {
        const s = (await api("GET", `/api/copilot/conversations/${cid}`)).json;
        return ["completed", "failed", "stopped", "interrupted"].includes(
          s?.conversation?.run?.status
        )
          ? s
          : null;
      }).catch(() => null);
    const ops = (snap?.messages ?? []).flatMap((m) => m.operations ?? []);
    const renderOp = ops.find((o) => o.tool === "reader" && o.action === "read_page_image");
    observed.copilot = {
      created: created.status,
      sent: sent.status,
      run: snap?.conversation?.run?.status ?? null,
      readPageImage: renderOp?.status ?? null,
      modelRequests: seen.length,
    };
    check(
      snap?.conversation?.run?.status === "completed" &&
        renderOp?.status === "ok" &&
        seen.length >= 2,
      "Copilot run (Pi SDK session, OpenAI Responses provider, reader read_page_image via PDFium) completed",
      JSON.stringify(observed.copilot)
    );
  }

  // Native addons bypass the loader hook: read which .node files the host has mapped (Linux).
  if (existsSync(`/proc/${host.pid}/maps`))
    observed.loadedNative = [
      ...new Set(
        readFileSync(`/proc/${host.pid}/maps`, "utf8")
          .split("\n")
          .map((l) => l.split(/\s+/).slice(5).join(" "))
          .filter((f) => f.startsWith(join(sidecar, "node_modules")) && f.endsWith(".node"))
          .map((f) => f.slice(join(sidecar, "node_modules").length + 1))
      ),
    ];
  mark("quit");
  host.stdin.write(`${JSON.stringify({ type: "quit" })}\n`);
  const code = await Promise.race([
    new Promise((r) => host.once("exit", r)),
    new Promise((r) => setTimeout(() => r("timeout"), 15000)),
  ]);
  check(code === 0, "the host stopped on quit", String(code));
} catch (error) {
  failures += 1;
  log(`FAIL  smoke aborted: ${error?.message ?? error}`);
  log(`--- host stderr (tail) ---\n${hostErr.slice(-1500)}`);
} finally {
  for (const child of children) child.kill("SIGKILL");
  fake.close();
}

// LaTeX ingest through the CLI of the same sidecar (proves argelander.sty; also loads the bundle's static imports).
if (existsSync("/usr/bin/latexmk")) {
  mark("ingest");
  const texDir = join(work, "tex");
  mkdirSync(texDir);
  writeFileSync(
    join(texDir, "main.tex"),
    "\\documentclass{article}\n\\begin{document}\n\\section{Intro}\\label{s:i}\nHello $x^2$ see Section~\\ref{s:i}.\n\\begin{equation}\\label{e:1}E=mc^2\\end{equation}\n\\end{document}\n"
  );
  const dataDir = join(work, "ingest-data");
  const ing = spawnSync(
    process.execPath,
    [...nodeArgs, binJs, "ingest", texDir, "--data-dir", dataDir],
    { cwd: home, env, encoding: "utf8", timeout: 240000 }
  );
  const outDir = join(dataDir, "output");
  const doc = existsSync(outDir) ? readdirSync(outDir).find((d) => !d.startsWith(".")) : undefined;
  const events = doc ? join(outDir, doc, "build", "main.argelander.jsonl") : "";
  observed.ingest = { exit: ing.status, eventStream: !!events && existsSync(events) };
  check(
    ing.status === 0 && observed.ingest.eventStream,
    "CLI ingest of a LaTeX source wrote the argelander event stream",
    JSON.stringify(observed.ingest) + (ing.status === 0 ? "" : ` ${(ing.stderr || "").slice(-300)}`)
  );
} else log("SKIP  LaTeX ingest: /usr/bin/latexmk not found");

// Which dependency files were loaded, by phase.
const trace = existsSync(traceFile) ? readFileSync(traceFile, "utf8").split("\n") : [];
const nmUrl = pathToFileURL(join(sidecar, "node_modules")).href;
let phase = "";
const byPhase = {};
for (const line of trace) {
  if (line.startsWith("# ")) phase = line.slice(2);
  else if (line.startsWith(nmUrl)) {
    const rel = line.slice(nmUrl.length + 1);
    const pkg = rel.startsWith("@") ? rel.split("/").slice(0, 2).join("/") : rel.split("/")[0];
    byPhase[phase] ??= new Set();
    byPhase[phase].add(pkg);
  }
}
observed.loadedPackages = Object.fromEntries(
  Object.entries(byPhase).map(([p, s]) => [p, [...s].sort()])
);
const all = new Set(Object.values(byPhase).flatMap((s) => [...s]));
observed.loadedEsbuild = [...all].filter((p) => p === "esbuild" || p.startsWith("@esbuild/"));
observed.loadedFontManifests = [...all].filter((p) => p.startsWith("@embedpdf/fonts-"));
log(
  `loaded dependency packages: ${all.size}; esbuild: ${observed.loadedEsbuild.join(",") || "none"}; font manifests: ${observed.loadedFontManifests.length}; native files mapped by the host: ${observed.loadedNative ? observed.loadedNative.join(",") || "none" : "not read"}`
);
writeFileSync(
  join(evidenceDir, `${label}-modules.txt`),
  trace.map((l) => l.replace(pathToFileURL(work).href, "<tmp>")).join("\n")
);
writeFileSync(
  join(evidenceDir, `${label}-observed.json`),
  `${JSON.stringify(observed, null, 2)}\n`
);
writeFileSync(join(evidenceDir, `${label}-result.txt`), `${results.join("\n")}\n`);
console.log(failures === 0 ? `\nSMOKE OK (${label})` : `\nSMOKE FAILED (${label}, ${failures})`);
process.exit(failures === 0 ? 0 : 1);
