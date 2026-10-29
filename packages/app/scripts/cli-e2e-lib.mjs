// CLI end-to-end smoke (release-0.2 ticket 15; spec 「验收」 and Q6(a)). Like smoke-pack.mjs it is NOT part of
// `pnpm -r test`: it spawns the real bundle (`<package>/dist/bin.js`, the packed-and-installed one when called from
// smoke-pack.mjs) as child processes and starts real workbenches. Entry points: smoke-pack.mjs (section 7, on the
// clean install) and smoke-cli.mjs (the same checks on the repository's own packages/app/dist).
//
// What it proves, on isolated data only (a temp HOME/XDG, a copy of the packaged tutorial sample as the data
// directory, a synthetic PDF and a synthetic .bib; nothing of the real HOME, credential store or library is read):
//   1. Every catalog command (the 35 of OPERATION_CATALOG, derived by the same `operationCliPath` the CLI uses) is run
//      on the two paths: no workbench running (the operation runs in the command's own process) and a workbench
//      running for the data directory (the command is handed to it). A confirmation card is decided over the page
//      interface (`POST /api/external-requests/:id/decision`, with the Origin a page sends): approve, deny, Ctrl-C
//      (exit 130, the card is withdrawn) and the workbench exiting under a waiting command (exit 4). Navigation goes
//      to a scripted page on `/ws` that names itself and answers `workbench.navigate`. A coverage check fails when a
//      catalog command did not run on both paths.
//   2. The 16 commands that exist since before the catalog (`ingest`, `library build`, `acquire`, `serve`, `tutorial`,
//      `search`, `read`, `show`, `ref`, `note`, `label`, `list`, `annot`, `argument get`, `argument put`, `pdf-path`)
//      run once each, plus `agent-plugin`.
//   3. Every command the six bundled operation guides (and their README) tell an agent to run is extracted with the
//      CLI's own `extractSkillCommands` (the drift test's module), its placeholders are filled from the fixture, and it
//      is run for real on a separate data copy, no workbench running. A command passes when it was dispatched to its
//      handler: no usage error, no stack trace, an exit code the CLI documents. Operation-level answers such as
//      `not_found`, `conflict` or `workbench_required` are answers, and are listed in the output.
//
// Network: none. Every child gets `--import <netblock.mjs>`, which replaces `fetch` for anything but loopback with a
// refusal that is logged. So ADS (no token is saved in the isolated store: `no_token` is answered before any request)
// and arXiv/Crossref operations are exercised up to the point where they would leave the machine and are reported as
// "network blocked". The success answers of those operations are covered by the server tests with stubbed HTTP
// (server `discovery-operations.test.ts`, `library-operations.test.ts`).
//
// The caller supplies `check(ok, what, detail)` and `log(line)`; this module reads and writes nothing outside `work`.

import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { extractSkillCommands, operationCliPath } from "../../cli/dist/index.js";
import { OPERATION_CATALOG } from "../../contracts/dist/index.js";

const WORK = "doi:10.1051/0004-6361/202039949"; // the sample's Work with a LaTeX Doc and an argument graph
const DOC = "arxiv-2103.12080";
const WORK_PDF = "doi:10.1051/0004-6361/201834608"; // gets the synthetic PDF Doc
const WORK_PDF2 = "doi:10.1051/0004-6361/201834622"; // gets a second one (the delete-doc target)
const WORK_NOARXIV_DOC = "doi:10.1051/0004-6361/202244243"; // no Doc: the arXiv acquisitions
const BIBCODE = "2021A&A...652A.100J"; // well-formed, only ever sent to a blocked network
const CATALOG_GROUPS = new Set(OPERATION_CATALOG.map((op) => operationCliPath(op)[0]));
const CATALOG_PATHS = OPERATION_CATALOG.map((op) => operationCliPath(op).join(" "));

/** A synthetic one-page PDF; `tag` makes the bytes differ so two Works do not share one file. */
export function syntheticPdf(tag = "Packed app smoke PDF page") {
  const content = `BT /F1 18 Tf 40 100 Td (${tag}) Tj ET`;
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

const NETBLOCK = `// Written by cli-e2e-lib.mjs: every network request but loopback is refused and logged (one host per line).
import { appendFileSync } from "node:fs";
const real = globalThis.fetch;
globalThis.fetch = async function blockedFetch(input, init) {
  const text = typeof input === "string" ? input : (input?.url ?? String(input));
  let host = "";
  try { host = new URL(text).hostname; } catch { /* relative or malformed: refused as well */ }
  if (host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1") return real(input, init);
  try { appendFileSync(process.env.E2E_NET_LOG, host + "\\n"); } catch { /* the log is evidence, not the block */ }
  const cause = Object.assign(new Error("getaddrinfo ENOTFOUND " + host), { code: "ENOTFOUND" });
  throw new TypeError("fetch failed", { cause });
};
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
/** Commander's own refusals of a command line (not an operation's answer). */
const USAGE_ERROR =
  /^error: (unknown option|unknown command|missing required argument|too many arguments|option '[^']*' argument missing|required option)/m;
const STACK_TRACE = /\n\s+at .*\(.*:\d+:\d+\)|TypeError|ReferenceError|SyntaxError: /;

/**
 * @param {object} o
 * @param {string} o.node      the node binary
 * @param {string} o.binJs     the bundle to test (`<package>/dist/bin.js`)
 * @param {string} o.tutorialDir  the package's tutorial sample (copied, never used in place)
 * @param {string} o.skillsDir    the package's dist/skills (the guides to run)
 * @param {string} o.work      a temp directory this run owns
 * @param {string|undefined} o.evidenceDir  where the per-command table (cli-e2e-commands.txt) is written
 * @param {string} o.pathEnv   PATH for the children (node must be reachable; TeX Live only when `texPath` is set)
 * @param {string|undefined} o.texPath  PATH that also holds latexmk and friends, or undefined (then `ingest` is skipped)
 * @param {(ok: boolean, what: string, detail?: string) => void} o.check
 * @param {(line: string) => void} o.log
 */
export async function runCliE2E(o) {
  const { node, binJs, work } = o;
  // The four tracks (stopped, running, pre-catalog, guides) use separate data copies and run at the same time; each
  // buffers its lines and they are printed track by track, so the output reads in order.
  const buffers = new AsyncLocalStorage();
  const check = (ok, what, detail = "") => {
    const lines = buffers.getStore();
    if (lines) lines.push({ ok, what, detail });
    else o.check(ok, what, detail);
  };
  const log = (line) => {
    const lines = buffers.getStore();
    if (lines) lines.push({ line });
    else o.log(line);
  };
  const track = async (fn) => {
    const lines = [];
    try {
      await buffers.run(lines, fn);
    } catch (error) {
      lines.push({ ok: false, what: "track aborted", detail: String(error?.stack ?? error) });
    }
    return lines;
  };
  const flush = (lines) => {
    for (const l of lines)
      if ("line" in l) o.log(l.line);
      else o.check(l.ok, l.what, l.detail);
  };
  const root = join(work, "cli-e2e");
  mkdirSync(root, { recursive: true });
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const netBlock = join(root, "netblock.mjs");
  writeFileSync(netBlock, NETBLOCK);
  const netLog = join(root, "network-attempts.log");
  writeFileSync(netLog, "");
  const baseEnv = (path = o.pathEnv) => ({
    PATH: path,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_RUNTIME_DIR: join(home, "runtime"),
    // no session bus: the credential store finds no keychain, so no real secret service is ever asked
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(home, "no-session-bus")}`,
    NODE_OPTIONS: `--import ${netBlock}`,
    E2E_NET_LOG: netLog,
    NO_COLOR: "1",
  });
  mkdirSync(join(home, "runtime"), { recursive: true, mode: 0o700 });

  // ---- process helpers ----
  const live = new Set();
  const start = (argv, { dataDir, env = baseEnv(), input } = {}) => {
    const args = dataDir ? [binJs, ...argv, "--data-dir", dataDir] : [binJs, ...argv];
    const child = spawn(node, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
    live.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end(input ?? "");
    const done = new Promise((resolve) =>
      child.once("close", (code, signal) => {
        live.delete(child);
        resolve({ code: code ?? (signal ? 128 : 1), signal, stdout, stderr });
      })
    );
    return { child, done, out: () => stdout + stderr };
  };
  const timed = async (run, ms, what) => {
    const timer = setTimeout(() => run.child.kill("SIGKILL"), ms);
    const r = await run.done;
    clearTimeout(timer);
    if (r.signal === "SIGKILL") r.stderr += `\n(e2e: killed after ${ms} ms: ${what})`;
    return r;
  };
  const cli = async (argv, opts = {}) => {
    const r = await timed(start(argv, opts), opts.timeout ?? 120000, argv.join(" "));
    r.json = parseJson(r.stdout);
    return r;
  };
  try {
    return await body();
  } finally {
    for (const child of live) child.kill("SIGKILL");
  }

  async function body() {
    // ---- fixtures: two copies of the sample (one per path) and one for the guides ----
    const makeData = (name) => {
      const dir = join(root, name);
      cpSync(o.tutorialDir, dir, { recursive: true });
      return join(dir, "literatures");
    };
    const dataStopped = makeData("data-stopped");
    const dataRunning = makeData("data-running");
    const dataGuides = makeData("data-guides");
    const dataLegacy = makeData("data-legacy");
    const files = join(root, "files");
    mkdirSync(files, { recursive: true });
    const pdfs = ["a", "b", "g"].map((t) => {
      const p = join(files, `${t}.pdf`);
      writeFileSync(p, syntheticPdf(`E2E synthetic PDF ${t}`));
      return p;
    });
    const bibText =
      "@article{e2e2020,\n  title = {An E2E Synthetic Paper},\n  author = {Tester, T.},\n  year = {2020},\n  journal = {Synthetic Journal},\n  doi = {10.9999/e2e.2020}\n}\n";
    const bibFile = join(files, "e2e.bib");
    writeFileSync(bibFile, bibText);
    const texDir = join(files, "tex");
    mkdirSync(texDir, { recursive: true });
    writeFileSync(
      join(texDir, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\n\\section{Intro}\\label{s:i}\nHello $x^2$ see Section~\\ref{s:i}.\n\\begin{equation}\\label{e:1}E=mc^2\\end{equation}\nSee Eq.~\\ref{e:1}.\n\\end{document}\n"
    );
    const jsonFile = (name, value) => {
      const p = join(files, name);
      writeFileSync(p, JSON.stringify(value));
      return p;
    };

    // ---- result bookkeeping ----
    const covered = new Map(); // "mode|command" -> count
    const table = []; // evidence lines
    const keyOf = (argv) => (CATALOG_GROUPS.has(argv[0]) ? argv.slice(0, 2).join(" ") : argv[0]);
    const mark = (mode, argv, r) => {
      const key = `${mode}|${keyOf(argv)}`;
      covered.set(key, (covered.get(key) ?? 0) + 1);
      const status = r.json?.status ?? (r.json?.ok === true ? "ok" : "-");
      table.push(
        `${mode.padEnd(8)} ${String(r.code).padStart(3)} ${String(status).padEnd(20)} ${argv.join(" ").replace(/\s+/g, " ").slice(0, 110)}`
      );
    };
    const expect = (what, r, spec) => {
      const codes = Array.isArray(spec.code) ? spec.code : [spec.code];
      const statuses =
        spec.status === undefined ? null : Array.isArray(spec.status) ? spec.status : [spec.status];
      const problems = [];
      if (!codes.includes(r.code)) problems.push(`exit ${r.code}, wanted ${codes.join("|")}`);
      if (statuses && !statuses.includes(r.json?.status))
        problems.push(`status ${r.json?.status}, wanted ${statuses.join("|")}`);
      if (spec.reason && r.json?.reason !== spec.reason)
        problems.push(`reason ${r.json?.reason}, wanted ${spec.reason}`);
      if (spec.stderr && !spec.stderr.test(r.stderr)) problems.push(`stderr lacks ${spec.stderr}`);
      if (STACK_TRACE.test(r.stderr)) problems.push("stderr holds a stack trace");
      check(
        problems.length === 0,
        what,
        problems.length
          ? `${problems.join("; ")} :: ${(r.stdout || r.stderr).replace(/\s+/g, " ").slice(0, 300)}`
          : `exit ${r.code}${r.json?.status ? ` ${r.json.status}` : ""}`
      );
      return r;
    };

    // ---- the workbench of the "running" path ----
    let wb = null;
    const startWorkbench = async (dataDir) => {
      const run = start(["serve", "--port", "0"], { dataDir });
      let port = 0;
      for (let i = 0; i < 300 && !port; i++) {
        if (run.child.exitCode !== null) throw new Error(`the workbench exited: ${run.out()}`);
        const url = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(run.out());
        const dir = /data dir: (.+)/.exec(run.out());
        if (url && dir?.[1]?.trim() === dataDir) port = Number(url[1]);
        else await sleep(100);
      }
      if (!port) throw new Error(`the workbench printed no listen line: ${run.out()}`);
      for (let i = 0; i < 100 && !existsSync(join(dataDir, "workbench.json")); i++) await sleep(50);
      const base = `http://127.0.0.1:${port}`;
      const api = async (path, init) => {
        const res = await fetch(`${base}${path}`, init);
        return { status: res.status, json: parseJson(await res.text()) };
      };
      const cards = async () => (await api("/api/external-requests")).json?.requests ?? [];
      const waitCard = async (state = "pending") => {
        for (let i = 0; i < 400; i++) {
          const c = (await cards())[0];
          if (c?.state === state) return c;
          await sleep(25);
        }
        throw new Error(`no confirmation card reached ${state}`);
      };
      // a person at the page: a browser sends its own Origin on a POST
      const decide = (id, decision) =>
        api(`/api/external-requests/${id}/decision`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: base },
          body: JSON.stringify({ decision }),
        });
      const decideNoOrigin = (id) =>
        api(`/api/external-requests/${id}/decision`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "approve" }),
        });
      const stop = async () => {
        run.child.kill("SIGTERM");
        const r = await Promise.race([run.done, sleep(20000).then(() => null)]);
        if (!r) run.child.kill("SIGKILL");
        return r;
      };
      return { run, port, base, api, cards, waitCard, decide, decideNoOrigin, stop };
    };
    // a page: names itself on /ws and answers each workbench.navigate (the page's own answer is what the CLI waits for)
    const openPage = async (port, id) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const targets = [];
      ws.addEventListener("message", (event) => {
        const msg = parseJson(String(event.data));
        if (msg?.type !== "workbench.navigate") return;
        targets.push(msg.target);
        ws.send(
          JSON.stringify({ type: "window.navigated", windowId: id, navId: msg.navId, ok: true })
        );
      });
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error("the page socket failed")));
      });
      ws.send(JSON.stringify({ type: "window.active", windowId: id }));
      await sleep(100);
      return { targets, close: () => ws.close() };
    };

    // ---- the catalog scenario, once per path ----
    /** Argument draft the catalog accepts. */
    const draft = (title) => ({ title, claim: `claim of ${title}`, grounds: "g", warrant: "w" });
    const ctxOf = {};
    async function catalogScenario(mode, dataDir) {
      const running = mode === "running";
      const tag = (s) => `[${mode}] ${s}`;
      const c = async (argv, what, spec, opts = {}) => {
        const r = await cli(argv, { dataDir, ...opts });
        mark(mode, argv, r);
        expect(tag(what), r, spec);
        return r;
      };
      const wbRequired = { code: 1, status: "workbench_required" };

      // library: reads, writes without a card
      await c(["library", "read"], "library read lists the Library", { code: 0 });
      await c(["library", "read", "--query", "tidal", "--limit", "2"], "library read --query", {
        code: 0,
      });
      await c(["library", "read", "--ref-id", WORK], "library read --ref-id one Work in full", {
        code: 0,
      });
      await c(["library", "read-jobs"], "library read-jobs", { code: 0 });
      const bib = await c(
        ["library", "import-works", "--mode", "bib", "--text", bibText],
        "library import-works --mode bib (no network)",
        { code: 0 }
      );
      const bibWork = bib.json?.results?.[0]?.ref?.id;
      check(typeof bibWork === "string", tag("the bib import named the new Work"), String(bibWork));
      const ident = await c(
        ["library", "import-works", "--mode", "identifier", "--text", "arXiv:2607.17040"],
        "library import-works --mode identifier: the arXiv/Crossref lookups are blocked, the Work is still created from the identifier",
        { code: [0, 1] }
      );
      check(
        ident.json !== null && ident.json.ok !== undefined,
        tag("the identifier import answered with a result object"),
        String(ident.stdout).replace(/\s+/g, " ").slice(0, 160)
      );
      await c(
        ["library", "import-works", "--mode", "bibcode", "--text", BIBCODE],
        "library import-works --mode bibcode needs ADS and says so offline",
        { code: [0, 1] }
      );
      await c(
        [
          "library",
          "set-main-doc",
          "--ref-id",
          WORK,
          "--doc-id",
          DOC,
          "--expected-main-doc-id",
          DOC,
        ],
        "library set-main-doc (already main)",
        { code: 0 }
      );
      await c(
        [
          "library",
          "set-main-doc",
          "--ref-id",
          WORK,
          "--doc-id",
          "no-such-doc",
          "--expected-main-doc-id",
          DOC,
        ],
        "library set-main-doc of a Doc that is not the Work's is an answer, not a crash",
        { code: 1 }
      );
      const pdfA = await c(
        ["library", "attach-local-pdf", "--ref-id", WORK_PDF, "--path", pdfs[0]],
        "library attach-local-pdf (A)",
        { code: 0, status: "ok" }
      );
      const pdfB = await c(
        ["library", "attach-local-pdf", "--ref-id", WORK_PDF2, "--path", pdfs[1]],
        "library attach-local-pdf (B)",
        { code: 0, status: "ok" }
      );
      const PDF = pdfA.json?.docId;
      const PDF2 = pdfB.json?.docId;
      await c(
        ["library", "attach-local-pdf", "--ref-id", WORK_PDF, "--path", "relative.pdf"],
        "library attach-local-pdf with a relative path is refused",
        { code: 1 }
      );
      await c(
        ["library", "list-ads-libraries"],
        "library list-ads-libraries: no token saved, nothing sent",
        { code: 1, reason: "no_token" }
      );
      await c(
        ["library", "read-ads-library", "--library-id", "e2e-library"],
        "library read-ads-library: no token saved, nothing sent",
        { code: 1, reason: "no_token" }
      );
      await c(
        ["library", "acquire-arxiv-pdf", "--ref-id", WORK_NOARXIV_DOC],
        "library acquire-arxiv-pdf: the arXiv request is blocked and reported",
        { code: 1 }
      );
      await c(
        ["library", "attach-arxiv", "--ref-id", WORK_NOARXIV_DOC],
        "library attach-arxiv (new Doc, no card): the arXiv request is blocked and reported",
        { code: 1 }
      );
      await c(
        ["library", "read-jobs", "--ref-id", WORK_PDF],
        "library read-jobs --ref-id shows the finished upload",
        { code: 0 }
      );

      // discovery (ADS)
      await c(
        ["discovery", "search-ads", "--query", "abs:tidal", "--limit", "3"],
        "discovery search-ads: no token saved, nothing sent",
        { code: 1, reason: "no_token" }
      );
      await c(
        ["discovery", "explore", "--bibcode", BIBCODE],
        "discovery explore: no token saved, nothing sent",
        { code: 1 }
      );

      // reader / text / annotations on the LaTeX Doc
      const rd = await c(["reader", "read", "--doc-id", DOC], "reader read (LaTeX Doc)", {
        code: 0,
        status: "ok",
      });
      const fp = rd.json?.reading?.epoch?.fingerprint;
      const rev0 = rd.json?.reading?.epoch?.annotationsRev;
      const fig = rd.json?.reading?.entries?.find((e) => e.kind === "figure" && e.asset)?.asset;
      check(
        typeof fp === "string" && Number.isInteger(rev0) && fig,
        tag("the reading gave a fingerprint, a revision and a figure asset"),
        JSON.stringify(rd.json?.reading?.epoch)
      );
      await c(
        ["reader", "read-image", "--doc-id", DOC, "--path", fig.path, "--sha256", fig.sha256],
        "reader read-image of an SVG asset is refused (only PNG/JPEG/WebP)",
        { code: 1 }
      );
      await c(
        ["reader", "read-svg-image", "--doc-id", DOC, "--path", fig.path, "--sha256", fig.sha256],
        "reader read-svg-image (renders, or says the optional renderer is missing)",
        { code: [0, 1], status: ["ok", "unsupported"] }
      );
      await c(
        ["text", "read-source", "--doc-id", DOC],
        "text read-source of a LaTeX Doc is an answer (it is not a text Doc)",
        { code: 1 }
      );
      const made = await c(
        [
          "annotation",
          "create",
          "--doc-id",
          DOC,
          "--fingerprint",
          fp,
          "--rev",
          String(rev0),
          "--target",
          '{"type":"document"}',
          "--body",
          "e2e note",
        ],
        "annotation create",
        { code: 0, status: "ok" }
      );
      const annId = made.json?.annotation?.id;
      const rev1 = made.json?.epoch?.annotationsRev;
      await c(
        [
          "annotation",
          "create",
          "--doc-id",
          DOC,
          "--fingerprint",
          fp,
          "--rev",
          String(rev0),
          "--target",
          '{"type":"document"}',
          "--body",
          "stale",
        ],
        "annotation create with a stale rev is a conflict",
        { code: 1, status: "conflict" }
      );
      const upd = await c(
        [
          "annotation",
          "update",
          "--doc-id",
          DOC,
          "--fingerprint",
          fp,
          "--rev",
          String(rev1),
          "--annotation-id",
          annId,
          "--expected-updated-at",
          made.json?.annotation?.updated_at,
          "--body",
          "e2e note, changed",
        ],
        "annotation update",
        { code: 0, status: "ok" }
      );
      await c(
        [
          "annotation",
          "delete",
          "--doc-id",
          DOC,
          "--fingerprint",
          fp,
          "--rev",
          String(upd.json?.epoch?.annotationsRev),
          "--annotation-id",
          annId,
          "--expected-updated-at",
          upd.json?.annotation?.updated_at,
        ],
        "annotation delete",
        { code: 0, status: "ok" }
      );

      // PDF Doc
      const prd = await c(["reader", "read", "--doc-id", PDF], "reader read (PDF Doc)", {
        code: 0,
        status: "ok",
      });
      const sha = prd.json?.reading?.sha256;
      const prev = prd.json?.reading?.annotationsRev;
      await c(
        ["reader", "read-page-image", "--doc-id", PDF, "--page-index", "0", "--sha256", sha],
        "reader read-page-image",
        { code: 0, status: "ok" }
      );
      const pmade = await c(
        [
          "annotation",
          "create-pdf",
          "--doc-id",
          PDF,
          "--sha256",
          sha,
          "--rev",
          String(prev),
          "--kind",
          "page_comment",
          "--page-index",
          "0",
          "--body",
          "e2e pdf note",
        ],
        "annotation create-pdf",
        { code: 0, status: "ok" }
      );
      const pAnn = pmade.json?.annotation;
      const pupd = await c(
        [
          "annotation",
          "update-pdf",
          "--doc-id",
          PDF,
          "--sha256",
          sha,
          "--rev",
          String(pmade.json?.epoch?.annotationsRev),
          "--annotation-id",
          pAnn?.id,
          "--expected-updated-at",
          pAnn?.updated_at,
          "--body",
          "e2e pdf note, changed",
        ],
        "annotation update-pdf",
        { code: 0, status: "ok" }
      );
      await c(
        [
          "annotation",
          "delete-pdf",
          "--doc-id",
          PDF,
          "--sha256",
          sha,
          "--rev",
          String(pupd.json?.epoch?.annotationsRev),
          "--annotation-id",
          pAnn?.id,
          "--expected-updated-at",
          pupd.json?.annotation?.updated_at,
        ],
        "annotation delete-pdf",
        { code: 0, status: "ok" }
      );

      // argument graph on the new Work (empty graph: no card), then the Work with a graph (cards)
      const ag = await c(
        ["argument", "read", "--work-id", bibWork],
        "argument read (empty graph, rev 0)",
        { code: 0, status: "ok" }
      );
      let rev = ag.json?.rev ?? 0;
      const step = async (what, argv) => {
        const r = await c(argv, what, { code: 0, status: "ok" });
        rev = r.json?.rev ?? rev;
        return r;
      };
      await step("argument create (a)", [
        "argument",
        "create",
        "--json",
        jsonFile(`${mode}-c1.json`, {
          workId: bibWork,
          expectedRev: rev,
          id: "a",
          argument: draft("A"),
        }),
      ]);
      await step("argument create (b)", [
        "argument",
        "create",
        "--json",
        jsonFile(`${mode}-c2.json`, {
          workId: bibWork,
          expectedRev: rev,
          id: "b",
          argument: draft("B"),
        }),
      ]);
      await step("argument add-edge", [
        "argument",
        "add-edge",
        "--work-id",
        bibWork,
        "--expected-rev",
        String(rev),
        "--from",
        "a",
        "--to",
        "b",
        "--role",
        "grounds",
      ]);
      await step("argument update", [
        "argument",
        "update",
        "--json",
        jsonFile(`${mode}-u.json`, {
          workId: bibWork,
          expectedRev: rev,
          id: "a",
          patch: { claim: "claim of A, changed" },
        }),
      ]);
      await step("argument remove-edge", [
        "argument",
        "remove-edge",
        "--work-id",
        bibWork,
        "--expected-rev",
        String(rev),
        "--from",
        "a",
        "--to",
        "b",
        "--role",
        "grounds",
      ]);
      const del = await step("argument delete (b)", [
        "argument",
        "delete",
        "--work-id",
        bibWork,
        "--expected-rev",
        String(rev),
        "--id",
        "b",
      ]);
      if (running)
        await step("argument undo-delete (the workbench remembers the delete)", [
          "argument",
          "undo-delete",
          "--work-id",
          bibWork,
          "--expected-rev",
          String(del.json?.rev),
          "--id",
          "b",
        ]);
      else
        await c(
          [
            "argument",
            "undo-delete",
            "--work-id",
            bibWork,
            "--expected-rev",
            String(del.json?.rev),
            "--id",
            "b",
          ],
          "argument undo-delete has no memory in a one-shot process: not_found",
          { code: 1, status: "not_found" }
        );
      await c(["argument", "read", "--work-id", bibWork], "argument read (after the edits)", {
        code: 0,
        status: "ok",
      });
      const wholeGraph = (await cli(["argument", "get", WORK], { dataDir })).json;
      check(
        Array.isArray(wholeGraph?.arguments) && wholeGraph.arguments.length > 0,
        tag("the sample Work has an argument graph to replace"),
        String(wholeGraph?.arguments?.length)
      );
      const newGraph = (id) => ({ arguments: [{ id, ...draft(id) }], edges: [] });
      const replaceParams = (expectedRev, id) =>
        jsonFile(`${mode}-r-${id}.json`, { workId: WORK, expectedRev, graph: newGraph(id) });

      // cards: delete-doc, attach-arxiv (refresh), argument replace / clear
      const sampleHash = () =>
        JSON.stringify(
          parseJson(
            readFileSync(
              join(
                dataDir,
                "argument-graphs",
                `${encodeURIComponent(WORK).replace(/\./g, "%2E")}.json`
              ),
              "utf8"
            )
          )
        );
      if (!running) {
        const before = sampleHash();
        await c(
          ["library", "delete-doc", "--doc-id", PDF2],
          "library delete-doc without a workbench: workbench_required",
          wbRequired
        );
        check(
          existsSync(join(dataDir, "output", PDF2)),
          tag("delete-doc without a workbench deleted nothing")
        );
        await c(
          ["library", "attach-arxiv", "--ref-id", WORK],
          "library attach-arxiv refreshing an arXiv Doc without a workbench: workbench_required",
          wbRequired
        );
        await c(
          ["argument", "replace", "--json", replaceParams(wholeGraph.rev, "z")],
          "argument replace of a graph with arguments without a workbench: workbench_required",
          wbRequired
        );
        await c(
          ["argument", "clear", "--work-id", WORK, "--expected-rev", String(wholeGraph.rev)],
          "argument clear of a graph with arguments without a workbench: workbench_required",
          wbRequired
        );
        check(sampleHash() === before, tag("nothing was written to the sample Work's graph"));
        for (const [argv, what] of [
          [["open", "doc", "--doc-id", DOC, "--anchor", "sec-2"], "open doc"],
          [["open", "work", "--ref-id", WORK], "open work"],
          [["open", "argument-graph", "--work-id", WORK], "open argument-graph"],
        ])
          await c(
            argv,
            `${what} without a workbench: workbench_required, nothing started`,
            wbRequired
          );
        check(
          !existsSync(join(dataDir, "workbench.json")),
          tag("no workbench was started by the open commands")
        );
        return;
      }

      // -- running: the cards, every outcome --
      const DELETE = ["library", "delete-doc", "--doc-id", PDF2];
      let pending = start(DELETE, { dataDir });
      let card = await wb.waitCard();
      check(
        /library delete-doc/.test(card.client?.commandLine ?? ""),
        tag("the card shows the waiting command line"),
        card.client?.commandLine
      );
      check(
        (await wb.decideNoOrigin(card.id)).status === 403,
        tag("a decision without an Origin header is refused (403)")
      );
      await sleep(300);
      check(
        existsSync(join(dataDir, "output", PDF2)),
        tag("the waiting delete-doc has deleted nothing")
      );
      await wb.decide(card.id, "deny");
      let r = await pending.done;
      r.json = parseJson(r.stdout);
      mark(mode, DELETE, r);
      expect(tag("delete-doc denied on the card: exit 3, denied"), r, {
        code: 3,
        status: "denied",
      });
      check(existsSync(join(dataDir, "output", PDF2)), tag("a denied delete-doc deleted nothing"));

      pending = start(DELETE, { dataDir });
      card = await wb.waitCard();
      pending.child.kill("SIGINT");
      r = await pending.done;
      r.json = parseJson(r.stdout);
      mark(mode, DELETE, r);
      expect(tag("delete-doc interrupted by Ctrl-C: exit 130"), r, {
        code: 130,
        stderr: /interrupted/,
      });
      card = await wb.waitCard("withdrawn");
      check(
        (await wb.decide(card.id, "approve")).status === 409,
        tag("the withdrawn card can no longer be approved (409)")
      );
      await wb.api(`/api/external-requests/${card.id}/dismiss`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: wb.base },
        body: "{}",
      });
      check(
        existsSync(join(dataDir, "output", PDF2)),
        tag("a Ctrl-C'd delete-doc deleted nothing")
      );

      pending = start(DELETE, { dataDir });
      card = await wb.waitCard();
      check(
        (await wb.decide(card.id, "approve")).status === 200,
        tag("the card was approved over the page interface")
      );
      r = await pending.done;
      r.json = parseJson(r.stdout);
      mark(mode, DELETE, r);
      expect(tag("delete-doc approved: exit 0, ok"), r, { code: 0, status: "ok" });
      check(
        !existsSync(join(dataDir, "output", PDF2)),
        tag("the approved delete-doc removed the Doc")
      );

      // attach-arxiv refreshing the sample's arXiv Doc: a card (deny); the blocked network is not reached
      const REFRESH = ["library", "attach-arxiv", "--ref-id", WORK];
      pending = start(REFRESH, { dataDir });
      card = await wb.waitCard();
      await wb.decide(card.id, "deny");
      r = await pending.done;
      r.json = parseJson(r.stdout);
      mark(mode, REFRESH, r);
      expect(tag("attach-arxiv refreshing an arXiv Doc: card denied, exit 3"), r, {
        code: 3,
        status: "denied",
      });

      // argument replace / clear
      const REPLACE = (id, expectedRev) => [
        "argument",
        "replace",
        "--json",
        replaceParams(expectedRev, id),
      ];
      pending = start(REPLACE("z", wholeGraph.rev), { dataDir });
      card = await wb.waitCard();
      await wb.decide(card.id, "deny");
      r = await pending.done;
      r.json = parseJson(r.stdout);
      mark(mode, REPLACE("z", 0), r);
      expect(tag("argument replace denied: exit 3"), r, { code: 3, status: "denied" });
      pending = start(REPLACE("z2", wholeGraph.rev), { dataDir });
      card = await wb.waitCard();
      await wb.decide(card.id, "approve");
      r = await pending.done;
      r.json = parseJson(r.stdout);
      mark(mode, REPLACE("z2", 0), r);
      expect(tag("argument replace approved: exit 0"), r, { code: 0, status: "ok" });
      const afterReplace = (await cli(["argument", "get", WORK], { dataDir })).json;
      check(
        afterReplace?.arguments?.length === 1 && afterReplace.arguments[0].id === "z2",
        tag("the approved replace wrote the new graph"),
        JSON.stringify(afterReplace?.arguments?.map((a) => a.id))
      );
      const CLEAR = [
        "argument",
        "clear",
        "--work-id",
        WORK,
        "--expected-rev",
        String(afterReplace?.rev),
      ];
      pending = start(CLEAR, { dataDir });
      card = await wb.waitCard();
      await wb.decide(card.id, "deny");
      r = await pending.done;
      r.json = parseJson(r.stdout);
      mark(mode, CLEAR, r);
      expect(tag("argument clear denied: exit 3"), r, { code: 3, status: "denied" });
      pending = start(CLEAR, { dataDir });
      card = await wb.waitCard();
      await wb.decide(card.id, "approve");
      r = await pending.done;
      r.json = parseJson(r.stdout);
      mark(mode, CLEAR, r);
      expect(tag("argument clear approved: exit 0"), r, { code: 0, status: "ok" });

      // navigation: no window, then a scripted page
      for (const [argv, what] of [
        [["open", "doc", "--doc-id", DOC], "open doc"],
        [["open", "work", "--ref-id", WORK], "open work"],
        [["open", "argument-graph", "--work-id", WORK], "open argument-graph"],
      ])
        await c(argv, `${what} with a workbench but no page: no_window`, {
          code: 1,
          status: "no_window",
        });
      const page = await openPage(wb.port, "e2e-window-1");
      await c(
        ["open", "doc", "--doc-id", DOC, "--anchor", "sec-2"],
        "open doc reaches the most recently active window",
        { code: 0, status: "ok" }
      );
      await c(["open", "work", "--ref-id", WORK], "open work reaches the window", {
        code: 0,
        status: "ok",
      });
      await c(
        ["open", "argument-graph", "--work-id", WORK],
        "open argument-graph reaches the window",
        { code: 0, status: "ok" }
      );
      check(
        page.targets.map((t) => t.op).join(",") ===
          "workspace.open_doc,library.open_work,argument.open",
        tag("the page received the three navigation targets in order"),
        JSON.stringify(page.targets.map((t) => t.op))
      );
      await c(
        ["open", "work", "--ref-id", "no-such-work"],
        "open work of a Work that is not in the Library: not_found",
        { code: 1, status: "not_found" }
      );
      page.close();

      // the workbench exits under a waiting command: exit 4. Done last, it ends the workbench.
      const LAST = ["library", "delete-doc", "--doc-id", PDF];
      pending = start(LAST, { dataDir });
      await wb.waitCard();
      await wb.stop();
      wb = null;
      r = await timed(pending, 30000, "delete-doc waiting while the workbench exits");
      r.json = parseJson(r.stdout);
      mark(mode, LAST, r);
      expect(tag("delete-doc while the workbench exits: exit 4, interrupted"), r, {
        code: 4,
        stderr: /interrupted/,
      });
      check(
        existsSync(join(dataDir, "output", PDF)),
        tag("nothing was deleted when the workbench went away")
      );
      check(
        !existsSync(join(dataDir, "workbench.json")),
        tag("the exited workbench revoked its instance record")
      );
      ctxOf.running = { PDF };
    }

    const legacyTrack = async () => {
      log("== cli e2e: the 16 pre-catalog commands and agent-plugin ==");
      await legacyScenario();
    };
    const guidesTrack = async () => {
      log("== cli e2e: every command in the bundled operation guides, run for real ==");
      await runGuides();
    };
    const stoppedTrack = async () => {
      log("== cli e2e: catalog commands, no workbench running ==");
      await catalogScenario("stopped", dataStopped);
    };
    const runningTrack = async () => {
      log("== cli e2e: catalog commands, workbench running ==");
      wb = await startWorkbench(dataRunning);
      check(true, "a workbench is running for the second data directory", `port ${wb.port}`);
      try {
        await catalogScenario("running", dataRunning);
      } finally {
        if (wb) await wb.stop();
      }
    };
    const finished = await Promise.all(
      [stoppedTrack, runningTrack, legacyTrack, guidesTrack].map(track)
    );
    for (const lines of finished) flush(lines);

    // every catalog command ran on both paths
    for (const path of CATALOG_PATHS) {
      for (const mode of ["stopped", "running"])
        check(
          covered.has(`${mode}|${path}`),
          `coverage: \`${path}\` ran with the workbench ${mode === "running" ? "running" : "not running"}`
        );
    }

    // ---- evidence ----
    const attempts = readFileSync(netLog, "utf8").split("\n").filter(Boolean);
    const hosts = [...new Set(attempts)].sort();
    log(
      `network: ${attempts.length} request(s) to non-loopback hosts were refused by the block (${hosts.join(", ") || "none"}); none left the machine`
    );
    table.sort();
    writeFileSync(join(root, "cli-e2e-table.txt"), `${table.join("\n")}\n`);
    if (o.evidenceDir)
      writeFileSync(join(o.evidenceDir, "cli-e2e-commands.txt"), `${table.join("\n")}\n`);
    return { table, networkAttempts: attempts.length, hosts };

    async function legacyScenario() {
      // ---- the commands that exist since before the catalog (+ agent-plugin) ----
      const L = async (argv, what, spec, opts = {}) => {
        const r = await cli(argv, { dataDir: dataLegacy, ...opts });
        mark("legacy", argv, r);
        expect(`[legacy] ${what}`, r, spec);
        return r;
      };
      const textOf = (r) => r.stdout;
      if (o.texPath) {
        const ing = await L(
          ["ingest", texDir],
          "ingest a local LaTeX source (TeX Live)",
          { code: 0 },
          { env: baseEnv(o.texPath), timeout: 240000 }
        );
        const m = /doc[: ]+([\w.-]+)/i.exec(textOf(ing));
        check(
          existsSync(join(dataLegacy, "output")) &&
            readdirSync(join(dataLegacy, "output")).length >= 2,
          "[legacy] the ingest wrote its Doc under output/",
          String(m?.[1])
        );
        await L(
          ["ingest", "--figure-dpi", "300", "--no-assets", texDir],
          "ingest --figure-dpi 300 is accepted and ignored",
          { code: 0 },
          { env: baseEnv(o.texPath), timeout: 240000 }
        );
      } else {
        log("SKIP  [legacy] ingest: latexmk is not on PATH (TeX Live is a prerequisite of ingest)");
        mark("legacy", ["ingest"], { code: "-", json: { status: "skipped (no TeX Live)" } });
        covered.set("legacy|ingest", 1);
      }
      await L(["library", "build", "--offline"], "library build --offline", { code: 0 });
      const acq = await L(
        ["acquire", bibFile, "--offline", "--dry-run"],
        "acquire --offline --dry-run prints the plan",
        { code: 0 }
      );
      check(/acquisition plan/.test(acq.stdout), "[legacy] acquire printed the acquisition plan");
      const search = await L(["search"], "search lists the Works as JSON lines", { code: 0 });
      check(
        search.stdout
          .trim()
          .split("\n")
          .every((l) => parseJson(l)?.id),
        "[legacy] every search line is a JSON object with an id"
      );
      const listed = await L(["list"], "list", { code: 0 });
      check(/library: works=\d+/.test(listed.stdout), "[legacy] list prints the overview");
      const rdm = await L(["read", DOC, "--section", "sec-2"], "read --section", { code: 0 });
      check(rdm.stdout.length > 100, "[legacy] read printed markdown");
      const mani = await L(["read", DOC, "--manifest", "refs"], "read --manifest refs", {
        code: 0,
      });
      check(
        mani.stdout.split("\n").some((l) => parseJson(l)?.kind === "figure"),
        "[legacy] the refs manifest lists the figures"
      );
      await L(["read", DOC, "--manifest", "bib"], "read --manifest bib", { code: 0 });
      await L(["show", DOC, "fig-1"], "show a float", { code: 0 });
      const refOut = await L(["ref", DOC, "ref-1"], "ref shows a bibliography entry", { code: 0 });
      check(
        parseJson(refOut.stdout)?.id === "ref-1" || /ref-1/.test(refOut.stdout),
        "[legacy] ref printed the entry ref-1"
      );
      await L(["annot", DOC], "annot lists the annotations", { code: 0 });
      await L(["note", WORK, "an e2e note"], "note sets the note", { code: 0 });
      const noteBack = await L(["note", WORK], "note without text prints it", { code: 0 });
      check(
        noteBack.json?.note === "an e2e note" || /an e2e note/.test(noteBack.stdout),
        "[legacy] the note reads back"
      );
      await L(["label", WORK, "--star", "true", "--tags", "e2e,synthetic"], "label", { code: 0 });
      const g = await L(["argument", "get", WORK], "argument get", { code: 0 });
      const gFile = join(files, "legacy-graph.json");
      writeFileSync(gFile, g.stdout);
      await L(
        ["argument", "put", WORK, gFile, "--rev", String(g.json?.rev), "--replace"],
        "argument put --replace",
        { code: 0 }
      );
      const att = await L(
        ["library", "attach-local-pdf", "--ref-id", WORK_PDF, "--path", pdfs[2]],
        "library attach-local-pdf (for pdf-path)",
        { code: 0 }
      );
      const pp = await L(["pdf-path", att.json?.docId], "pdf-path prints the original file", {
        code: 0,
      });
      check(
        pp.stdout.trim().endsWith("original.pdf") && existsSync(pp.stdout.trim()),
        "[legacy] pdf-path names an existing original.pdf"
      );
      const ap = await cli(["agent-plugin"], {});
      mark("legacy", ["agent-plugin"], ap);
      expect("[legacy] agent-plugin prints the plugin path and the two Claude Code commands", ap, {
        code: 0,
      });
      check(
        /\/plugin marketplace add .+\n/.test(ap.stdout) &&
          /\/plugin install argelanderspace@argelanderspace-local/.test(ap.stdout),
        "[legacy] agent-plugin names both commands"
      );

      // serve and tutorial: long running, started on port 0, stopped by SIGTERM
      const longRun = async (argv, what, listen, opts = {}) => {
        const run = start(argv, opts);
        let up = false;
        for (let i = 0; i < 300 && !up; i++) {
          if (run.child.exitCode !== null) break;
          up = listen.test(run.out());
          if (!up) await sleep(100);
        }
        run.child.kill("SIGTERM");
        const r = await Promise.race([run.done, sleep(20000).then(() => null)]);
        if (!r) run.child.kill("SIGKILL");
        mark("legacy", argv, { code: r?.code ?? "-", json: null });
        check(
          up && r?.code === 0,
          `[legacy] ${what}`,
          up ? `exit ${r?.code}` : `never listened: ${run.out().slice(0, 300)}`
        );
      };
      await longRun(
        ["serve", "--port", "0"],
        "serve boots on port 0 and shuts down on SIGTERM",
        /listening on http:\/\/127\.0\.0\.1:\d+/,
        { dataDir: dataLegacy }
      );
      covered.set("legacy|serve", 1);
      const tutorialDir = join(root, "tutorial-folder");
      await longRun(
        ["tutorial", "--dir", tutorialDir, "--port", "0"],
        "tutorial sets up its folder, serves it and prints the address",
        /http:\/\/(127\.0\.0\.1|localhost):\d+/,
        {}
      );
      check(
        existsSync(join(tutorialDir, "literatures")),
        "[legacy] tutorial copied the sample into --dir"
      );
      covered.set("legacy|tutorial", 1);
      for (const name of [
        "ingest",
        "library build",
        "acquire",
        "serve",
        "tutorial",
        "search",
        "read",
        "show",
        "ref",
        "note",
        "label",
        "list",
        "annot",
        "argument get",
        "argument put",
        "pdf-path",
      ]) {
        const key = ["library build", "argument get", "argument put"].includes(name)
          ? name.split(" ")[0]
          : name;
        check(
          [...covered.keys()].some(
            (k) =>
              k.startsWith("legacy|") &&
              (k === `legacy|${name}` || k === `legacy|${key}` || k.startsWith(`legacy|${name}`))
          ),
          `coverage: pre-catalog command \`${name}\` ran`
        );
      }
    }

    async function runGuides() {
      const data = dataGuides;
      // fixture facts of the guides' own data copy
      const pdfDoc = (
        await cli(["library", "attach-local-pdf", "--ref-id", WORK_PDF, "--path", pdfs[0]], {
          dataDir: data,
        })
      ).json?.docId;
      const pdfSha = (await cli(["reader", "read", "--doc-id", pdfDoc], { dataDir: data })).json
        ?.reading?.sha256;
      const fig = (
        await cli(["reader", "read", "--doc-id", DOC], { dataDir: data })
      ).json?.reading?.entries?.find((e) => e.kind === "figure" && e.asset)?.asset;
      const refKey = "ref-1"; // a bibliography entry of the sample Doc (`read --manifest bib` lists ref-1 .. ref-100)
      // live state, read again before each command that depends on it (an earlier guide command may have changed it)
      const state = async (parts) => {
        const [rd, prd, ag] = await Promise.all([
          parts.includes("tex")
            ? cli(["reader", "read", "--doc-id", DOC], { dataDir: data })
            : null,
          parts.includes("pdf")
            ? cli(["reader", "read", "--doc-id", pdfDoc], { dataDir: data })
            : null,
          parts.includes("graph") ? cli(["argument", "get", WORK], { dataDir: data }) : null,
        ]);
        return {
          fp: rd?.json?.reading?.epoch?.fingerprint,
          rev: rd?.json?.reading?.epoch?.annotationsRev ?? 0,
          prev: prd?.json?.reading?.annotationsRev ?? 0,
          graphRev: ag?.json?.rev ?? 0,
          ids: (ag?.json?.arguments ?? []).map((a) => a.id),
          graph: ag?.json,
        };
      };
      // an annotation to update or delete: made fresh, since an earlier guide command may have deleted it
      const freshAnnotation = async (pdf) => {
        const s = await state([pdf ? "pdf" : "tex"]);
        const create = pdf
          ? [
              "annotation",
              "create-pdf",
              "--doc-id",
              pdfDoc,
              "--sha256",
              pdfSha,
              "--rev",
              String(s.prev),
              "--kind",
              "page_comment",
              "--page-index",
              "0",
              "--body",
              "e2e guide fixture",
            ]
          : [
              "annotation",
              "create",
              "--doc-id",
              DOC,
              "--fingerprint",
              s.fp,
              "--rev",
              String(s.rev),
              "--target",
              '{"type":"document"}',
              "--body",
              "e2e guide fixture",
            ];
        const r = await cli(create, { dataDir: data });
        return { id: r.json?.annotation?.id, updatedAt: r.json?.annotation?.updated_at };
      };
      // two argument ids to point at
      const withArguments = async () => {
        let s = await state(["graph"]);
        for (const id of ["g1", "g2"].filter((x) => !s.ids.includes(x))) {
          await cli(
            [
              "argument",
              "create",
              "--json",
              jsonFile("guide-fixture.json", {
                workId: WORK,
                expectedRev: s.graphRev,
                id,
                argument: draft(id),
              }),
            ],
            { dataDir: data }
          );
          s = await state(["graph"]);
        }
        return s;
      };
      let jsonCount = 0;
      /** The --json file a guide command stands for. */
      const paramsFile = (sub, s) => {
        jsonCount += 1;
        const params =
          sub === "create"
            ? {
                workId: WORK,
                expectedRev: s.graphRev,
                id: `g-json-${jsonCount}`,
                argument: draft("J"),
              }
            : sub === "update"
              ? {
                  workId: WORK,
                  expectedRev: s.graphRev,
                  id: s.ids[0],
                  patch: { claim: "changed by a guide command" },
                }
              : {
                  workId: WORK,
                  expectedRev: s.graphRev,
                  graph: { arguments: [{ id: "q", ...draft("Q") }], edges: [] },
                };
        return jsonFile(`guide-${sub}-${jsonCount}.json`, params);
      };

      const isPlaceholderToken = (t) => /^<.*>$/.test(t) || /^[A-Z][A-Z0-9_]*$/.test(t);
      const fillArgv = async (argv) => {
        const first = argv[0];
        const sub = CATALOG_GROUPS.has(first) ? (argv[1] ?? "") : "";
        const isPdf = sub === "read-page-image" || sub.endsWith("-pdf");
        const ann =
          first === "annotation" && /^(update|delete)/.test(sub)
            ? await freshAnnotation(sub.endsWith("-pdf"))
            : null;
        const s =
          first === "annotation"
            ? await state([isPdf ? "pdf" : "tex"])
            : first === "argument"
              ? await withArguments()
              : null;
        const byFlag = {
          "--ref-id": WORK,
          "--work-id": WORK,
          "--doc-id": isPdf ? pdfDoc : DOC,
          "--expected-main-doc-id": DOC,
          "--library-id": "e2e-library",
          "--bibcode": BIBCODE,
          "--query": first === "discovery" ? "abs:tidal" : "tidal",
          "--anchor": "sec-2",
          "--path": sub === "attach-local-pdf" ? pdfs[0] : (fig?.path ?? "x.svg"),
          "--sha256": isPdf ? pdfSha : (fig?.sha256 ?? "0".repeat(64)),
          "--sha": pdfSha,
          "--fingerprint": s?.fp ?? "0".repeat(64),
          "--rev": String(first === "annotation" ? (isPdf ? s.prev : s.rev) : (s?.graphRev ?? 0)),
          "--annotation-id": ann?.id ?? "a_none",
          "--expected-updated-at": ann?.updatedAt ?? "2026-01-01T00:00:00.000Z",
          "--expected-rev": String(s?.graphRev ?? 0),
          "--id": s?.ids?.[0] ?? "g1",
          "--from": s?.ids?.[0] ?? "g1",
          "--to": s?.ids?.[1] ?? "g2",
          "--text": "e2e synthetic text",
          "--label": "red",
          "--read": "true",
          "--star": "true",
          "--tags": "e2e,synthetic",
          "--section": "sec-2",
          "--dir": join(root, "guide-tutorial"),
          "--port": "0",
        };
        const byName = {
          docId: first === "pdf-path" ? pdfDoc : DOC,
          doc_id: DOC,
          workId: WORK,
          work_id: WORK,
          WORK_ID: WORK,
          floatId: "fig-1",
          secId: "sec-2",
          refIdOrKey: refKey,
          source: texDir,
          bib: bibFile,
          "the note text": "e2e synthetic note",
          "confirmed text": "e2e synthetic note",
          "doi, arXiv id or title": "tidal",
          "arXiv id, DOI or title word": "tidal",
        };
        const out = [];
        for (let i = 0; i < argv.length; i++) {
          const t = argv[i];
          const flag = argv[i - 1]?.startsWith("--") ? argv[i - 1] : null;
          if (t === "--json" && (i === argv.length - 1 || argv[i + 1].startsWith("--"))) {
            out.push(t, paramsFile(sub, s));
            continue;
          }
          if (t === "$(cat /tmp/batch.bib)") out.push(bibText);
          else if (t === "/tmp/replace.json") out.push(paramsFile("replace", s));
          else if (flag === "--json" && isPlaceholderToken(t)) out.push(paramsFile(sub, s));
          else if (first === "argument" && sub === "put" && /^<file\|->$/.test(t)) {
            const f = join(files, "guide-put.json");
            writeFileSync(f, JSON.stringify(s.graph));
            out.push(f);
          } else if (t.startsWith("arXiv:") && t.includes("<")) out.push("arXiv:2607.17040");
          else if (!isPlaceholderToken(t)) out.push(t);
          else if (flag && flag in byFlag) out.push(byFlag[flag]);
          else if (t.replace(/^<|>$/g, "") in byName) out.push(byName[t.replace(/^<|>$/g, "")]);
          else if (/^<(absolute path|up to 200 bibcodes)/.test(t))
            out.push(t.startsWith("<abs") ? pdfs[0] : "2019A&A...621L...2R");
          else if (flag === "--text" || t === "<text>") out.push("e2e synthetic text");
          else if (t === "<ADS query>") out.push("abs:tidal");
          else if (t === "<bibcode>") out.push(BIBCODE);
          else if (t === "<anchor>") out.push("sec-2");
          else
            throw new Error(
              `no fixture value for the guide placeholder ${t} (after ${flag ?? argv[0]})`
            );
        }
        return out;
      };

      // gather and expand the commands
      const skillFiles = [
        "README.md",
        ...readdirSync(o.skillsDir)
          .filter((d) => statSync(join(o.skillsDir, d)).isDirectory())
          .sort()
          .map((d) => `${d}/SKILL.md`),
      ];
      const seen = new Map();
      for (const f of skillFiles) {
        for (const cmd of extractSkillCommands(readFileSync(join(o.skillsDir, f), "utf8"))) {
          const variants = [];
          if (cmd.argv[0] === "<group>") {
            // the README's help lines: every real group, every real command
            if (cmd.argv[1] === "--help")
              for (const g of CATALOG_GROUPS) variants.push([g, "--help"]);
            else for (const p of CATALOG_PATHS) variants.push([...p.split(" "), "--help"]);
          } else {
            // `refs|bib` style choices: one variant per alternative
            let list = [cmd.argv];
            cmd.argv.forEach((tok, i) => {
              if (!tok.startsWith("-") && /^[\w-]+(\|[\w-]+)+$/.test(tok))
                list = list.flatMap((a) =>
                  tok.split("|").map((alt) => a.map((x, j) => (j === i ? alt : x)))
                );
            });
            variants.push(...list);
          }
          for (const v of variants) {
            const key = JSON.stringify(v);
            if (!seen.has(key)) seen.set(key, { argv: v, where: `${f.split("/")[0]}:${cmd.line}` });
          }
        }
      }
      log(
        `guides: ${seen.size} distinct commands from ${skillFiles.length} files (the README and six guides) to run`
      );
      check(
        seen.size > 100,
        "the guides yield their commands (not an empty extraction)",
        String(seen.size)
      );
      const bare = [];
      for (const { argv, where } of seen.values()) {
        const label = `guides: ${where} \`${argv.join(" ")}\``;
        let filled;
        try {
          filled = await fillArgv(argv);
        } catch (e) {
          check(false, label, String(e.message));
          continue;
        }
        const first = filled[0];
        if (first === "serve" || first === "tutorial") {
          // long running: port 0 whatever the guide wrote (never the default 1859), stopped once it prints its address
          if (!filled.includes("--port")) filled.push("--port", "0");
          const run = start(first === "serve" ? [...filled, "--data-dir", data] : filled);
          let up = false;
          for (let i = 0; i < 300 && !up; i++) {
            if (run.child.exitCode !== null) break;
            up =
              /listening on http:\/\/127\.0\.0\.1:\d+|http:\/\/(127\.0\.0\.1|localhost):\d+/.test(
                run.out()
              );
            if (!up) await sleep(100);
          }
          run.child.kill("SIGTERM");
          const r = await Promise.race([run.done, sleep(20000).then(() => null)]);
          if (!r) run.child.kill("SIGKILL");
          mark("guides", filled, { code: r?.code ?? "-", json: null });
          check(
            up,
            `${label} starts and prints its address`,
            up ? `exit ${r?.code}` : run.out().slice(0, 200)
          );
          continue;
        }
        if (first === "ingest" && !o.texPath) {
          log(`SKIP  ${label}: latexmk is not on PATH`);
          continue;
        }
        const helpOnly =
          filled.includes("--help") ||
          (filled.length === 1 && (first === "library" || CATALOG_GROUPS.has(first)));
        const r = await cli(filled, {
          dataDir: helpOnly || first === "agent-plugin" ? undefined : data,
          env: first === "ingest" ? baseEnv(o.texPath) : baseEnv(),
          timeout: first === "ingest" ? 240000 : 120000,
        });
        mark("guides", filled, r);
        const problems = [];
        if (USAGE_ERROR.test(r.stderr))
          problems.push(`usage error: ${r.stderr.trim().split("\n")[0]}`);
        if (STACK_TRACE.test(r.stderr)) problems.push("stack trace on stderr");
        if (r.stderr.includes("(e2e: killed")) problems.push("timed out");
        if (helpOnly) {
          if (!/Usage:/.test(r.stdout + r.stderr)) problems.push("no usage text");
        } else if (CATALOG_GROUPS.has(first) && r.code === 2 && r.json?.status === "unsupported") {
          // a guide that only names a command (`argument undo-delete`, no options) is answered with what it needs
          if (filled.length === 2) bare.push(filled.join(" "));
          else problems.push(`parameters refused: ${r.json.detail}`);
        } else if (![0, 1].includes(r.code)) problems.push(`exit ${r.code}`);
        const shown = r.json?.status ?? (r.code === 0 ? "ok" : "-");
        check(
          problems.length === 0,
          label,
          problems.length
            ? `${problems.join("; ")} :: ${(r.stdout || r.stderr).replace(/\s+/g, " ").slice(0, 240)}`
            : `exit ${r.code} ${shown}`
        );
      }
      log(
        `guides: ${seen.size} distinct commands run. Bare mentions of a command name (no options), answered with the parameters they need: ${bare.join("; ") || "none"}`
      );
    }
  }
}
