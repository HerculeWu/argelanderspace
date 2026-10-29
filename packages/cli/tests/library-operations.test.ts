/**
 * The CLI commands derived from the Library domain of the operation catalog (release-0.2 ticket 06):
 * `library import-works | attach-local-pdf | list-ads-libraries | read-ads-library | acquire-arxiv-pdf | attach-arxiv |
 * read-jobs`. The real `bin.js` as a child process, on synthetic data in a temporary directory.
 *
 * Without a workbench the command runs in its own process (real PDFium, real library lock, jobs waited for); with one
 * it is handed to it (a real workbench in this process, offline stubs for ADS and arXiv). `attach-arxiv` replacing a
 * Doc's text is the confirmation operation: approved (0), denied (3), Ctrl-C (130) and no workbench (1).
 *
 * Not run as a child process: `list-ads-libraries`, `read-ads-library` and `acquire-arxiv-pdf` without a workbench, since
 * a child would read this machine's real credential store or reach arXiv; their in-process path is covered in the server
 * package (`library-operations.test.ts`) with injected token, stubs and network.
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LibraryStore, libraryPaths } from "@argelanderspace/core";
import { resolveGlobalDirsLeniently } from "@argelanderspace/infra";
import {
  createServer,
  newWorkbenchToken,
  type RunningServer,
  registerWorkbench,
} from "@argelanderspace/server";
import { afterEach, expect, test } from "vitest";
import { stubPipelines, stubSources } from "../../server/tests/helpers.js";

/** An answer as the tests read it: the fields they look at are named where they are used. */
type Answer = Record<string, unknown> & {
  docId?: string;
  entries?: { bibcode: string; status: string }[];
};

const PKG = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(PKG, "dist", "bin.js");
const PDF = join(PKG, "..", "server", "tests", "fixtures", "pdf", "scanned-no-text.pdf");
const W_DOCLESS = "arxiv:2603.00001";
const W_REFRESH = "arxiv:2603.00002";
const W_NOARXIV = "doi:10.1000/noarxiv";
const REFRESH_DOC = "arxiv-2603.00002";
const roots: string[] = [];
const closers: (() => unknown)[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const close of closers.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const work = (id: string, extra: object = {}) => ({
  id,
  title: `Work ${id}`,
  authors: ["Author"],
  year: 2026,
  venue: "arXiv",
  type: "article",
  ...(id.startsWith("arxiv:") ? { arxiv_id: id.slice(6) } : { doi: id.slice(4) }),
  cite_key: id.replace(/[^a-z0-9]/gi, ""),
  doc_ids: [],
  ...extra,
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "aspace-cli-lib-"));
  roots.push(root);
  const dataDir = join(root, "data");
  const paths = libraryPaths(dataDir);
  mkdirSync(paths.libraryDir, { recursive: true });
  writeFileSync(
    paths.libraryJson,
    JSON.stringify({
      version: 1,
      project: { name: "Synthetic", short: "S", field: "" },
      works: [work(W_DOCLESS), work(W_REFRESH, { doc_ids: [REFRESH_DOC] }), work(W_NOARXIV)],
    })
  );
  const docDir = join(paths.outputDir, REFRESH_DOC);
  mkdirSync(docDir, { recursive: true });
  writeFileSync(
    join(docDir, `${REFRESH_DOC}.json`),
    JSON.stringify({
      version: 1,
      docId: REFRESH_DOC,
      sections: [],
      refsManifest: [],
      bib: [],
      citationsByBlock: {},
      source: { type: "latex", origin: "/tmp/src", main_tex: "main.tex", arxiv_id: "2603.00002" },
      meta: { title: "Existing arXiv Doc" },
    })
  );
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "xdg") };
  const start = (args: string[]) => {
    const child = spawn(process.execPath, [BIN, ...args, "--data-dir", dataDir], { env });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    const done = new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) =>
      child.on("close", (status) => resolve({ status, stdout, stderr }))
    );
    return { child, done };
  };
  const run = (args: string[]) => start(args).done;
  return { root, dataDir, paths, start, run };
}

function fileCount(dir: string): number {
  let count = 0;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    count += statSync(full).isDirectory() ? fileCount(full) : 1;
  }
  return count;
}
const docsOf = (dataDir: string, id: string) =>
  LibraryStore.load(libraryPaths(dataDir)).get(id)?.doc_ids;
const json = (text: string) => JSON.parse(text) as Answer;

async function startWorkbench(dataDir: string) {
  const token = newWorkbenchToken();
  const srv: RunningServer = createServer({
    globalDirs: resolveGlobalDirsLeniently({}).dirs,
    dataDir,
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    operationToken: token,
    deps: {
      makeSources: () => stubSources(),
      pipelines: stubPipelines(),
      fetchArxivPdf: async () => readFileSync(PDF),
      makeAdsLibraries: () => ({
        list: async () => ({
          ok: true,
          total: 1,
          libraries: [{ id: "lib_1", name: "Thesis", numDocuments: 2 }],
          truncated: false,
        }),
        readWindow: async (_id, offset) => ({
          ok: true,
          library: { id: "lib_1", name: "Thesis", numDocuments: 2 },
          total: 2,
          offset,
          bibcodes: ["2021MNRAS.0001....B", "2021MNRAS.0002....B"],
        }),
      }),
    },
  });
  closers.push(() => srv.close().catch(() => {}));
  const port = await srv.ready();
  const registration = await registerWorkbench(dataDir, { port, token });
  closers.push(() => registration.revoke());
  const api = `http://127.0.0.1:${port}/api/external-requests`;
  const list = async () =>
    (
      (await (await fetch(api)).json()) as {
        requests: { id: string; state: string; card: { action: string } }[];
      }
    ).requests;
  const waitFor = async (state: string) => {
    for (let i = 0; i < 400; i++) {
      const requests = await list();
      if (requests[0]?.state === state) return requests[0];
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`no request reached ${state}`);
  };
  const decide = (id: string, decision: "approve" | "deny") =>
    fetch(`${api}/${id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ decision }),
    });
  return { srv, waitFor, decide };
}

const BIB = `@article{synth2026,\n  author = {Doe, Jane},\n  title = {A synthetic import},\n  journal = {MNRAS},\n  year = {2026},\n  doi = {10.1000/synth}\n}`;

test("the catalog's Library operations are CLI commands under `library`; interface actions and save-candidate are not", {
  timeout: 120_000,
}, async () => {
  const { run } = setup();
  const help = await run(["library", "--help"]);
  expect(help.status).toBe(0);
  for (const name of [
    "import-works",
    "attach-local-pdf",
    "list-ads-libraries",
    "read-ads-library",
    "acquire-arxiv-pdf",
    "attach-arxiv",
    "read-jobs",
    "read",
    "set-main-doc",
    "delete-doc",
    "build",
  ])
    expect(help.stdout, name).toContain(name);
  for (const ui of [
    "filter-library",
    "select-work",
    "set-detail-tab",
    "set-sidebar",
    "set-temp-label",
    "save-candidate",
  ])
    expect(help.stdout, ui).not.toContain(ui);
  const imp = await run(["library", "import-works", "--help"]);
  for (const flag of ["--mode <identifier|bibcode|bib>", "--text", "--batch", "--json"])
    expect(imp.stdout).toContain(flag);
  const attach = await run(["library", "attach-arxiv", "--help"]);
  expect(attach.stdout).toMatch(/confirmation/);
});

test("bad parameters exit 2 with unsupported before anything runs or is read", {
  timeout: 120_000,
}, async () => {
  const { run, dataDir } = setup();
  const before = fileCount(dataDir);
  for (const args of [
    ["library", "import-works"],
    ["library", "import-works", "--mode", "bib", "--text", "x", "--batch"],
    ["library", "import-works", "--mode", "bibcode", "--text", " ; , "],
    ["library", "attach-local-pdf"],
    ["library", "attach-local-pdf", "--ref-id", W_DOCLESS],
    ["library", "read-ads-library"],
    ["library", "read-ads-library", "--library-id", "lib_1", "--limit", "201"],
    ["library", "acquire-arxiv-pdf"],
    ["library", "attach-arxiv", "--ref-id", W_DOCLESS, "--json", "-"],
    ["library", "read-jobs", "--limit", "51"],
  ]) {
    const result = await run(args);
    expect(result.status, args.join(" ")).toBe(2);
    expect(json(result.stdout), args.join(" ")).toMatchObject({ ok: false, status: "unsupported" });
  }
  expect(fileCount(dataDir)).toBe(before);
});

test("without a workbench: read-jobs reads without creating anything; import-works and attach-local-pdf run in the command and it exits when the job is done", {
  timeout: 120_000,
}, async () => {
  const { run, dataDir, root } = setup();
  const before = fileCount(dataDir);
  const jobs = await run(["library", "read-jobs"]);
  expect(jobs.status).toBe(0);
  expect(json(jobs.stdout)).toEqual({ ok: true, jobs: [], total: 0 });
  expect(fileCount(dataDir)).toBe(before);

  const imported = await run(["library", "import-works", "--mode", "bib", "--text", BIB]);
  expect(imported.status).toBe(0);
  expect(json(imported.stdout)).toMatchObject({ ok: true, status: "ok", mode: "bib", created: 1 });
  expect(docsOf(dataDir, "doi:10.1000/synth")).toEqual([]);
  const params = join(root, "params.json");
  writeFileSync(params, JSON.stringify({ mode: "bib", text: BIB }));
  const again = await run(["library", "import-works", "--json", params]);
  expect(again.status).toBe(0);
  expect(json(again.stdout)).toMatchObject({ ok: true, status: "noop", existing: 1 });

  const file = join(root, "paper.pdf");
  copyFileSync(PDF, file);
  const attached = await run([
    "library",
    "attach-local-pdf",
    "--ref-id",
    W_DOCLESS,
    "--path",
    file,
  ]);
  expect(attached.status).toBe(0);
  const answer = json(attached.stdout);
  expect(answer).toMatchObject({
    ok: true,
    status: "ok",
    job: { status: "done" },
    source: { filename: "paper.pdf" },
  });
  expect(docsOf(dataDir, W_DOCLESS)).toEqual([answer.docId]);
  // The job record the command left is read-only visible afterwards.
  const after = await run(["library", "read-jobs", "--ref-id", W_DOCLESS]);
  expect(json(after.stdout)).toMatchObject({ ok: true, total: 1, jobs: [{ status: "done" }] });

  const relative = await run([
    "library",
    "attach-local-pdf",
    "--ref-id",
    W_NOARXIV,
    "--path",
    "paper.pdf",
  ]);
  expect(relative.status).toBe(1);
  expect(json(relative.stdout)).toMatchObject({
    ok: false,
    status: "rejected",
    reason: "path_not_absolute",
  });
  const missing = await run([
    "library",
    "attach-local-pdf",
    "--ref-id",
    W_NOARXIV,
    "--path",
    join(root, "nope.pdf"),
  ]);
  expect(missing.status).toBe(1);
  expect(json(missing.stdout)).toMatchObject({
    ok: false,
    status: "not_found",
    reason: "source_not_found",
  });
  expect(docsOf(dataDir, W_NOARXIV)).toEqual([]);
  // Answers about the work itself need no network either.
  const noArxiv = await run(["library", "acquire-arxiv-pdf", "--ref-id", W_NOARXIV]);
  expect(noArxiv.status).toBe(1);
  expect(json(noArxiv.stdout)).toMatchObject({ ok: false, status: "rejected" });
});

test("without a workbench attach-arxiv that would replace a Doc's text is refused (exit 1) and changes nothing", {
  timeout: 90_000,
}, async () => {
  const { run, dataDir, paths } = setup();
  const irBefore = readFileSync(join(paths.outputDir, REFRESH_DOC, `${REFRESH_DOC}.json`), "utf8");
  const result = await run(["library", "attach-arxiv", "--ref-id", W_REFRESH]);
  expect(result.status).toBe(1);
  expect(json(result.stdout)).toMatchObject({ ok: false, status: "workbench_required" });
  expect(json(result.stdout).detail).toMatch(/open ArgelanderSpace/);
  expect(readFileSync(join(paths.outputDir, REFRESH_DOC, `${REFRESH_DOC}.json`), "utf8")).toBe(
    irBefore
  );
  expect(existsSync(join(dataDir, "jobs"))).toBe(false); // refused before any runner was made
  // The same command on a Work that only gets a new Doc needs no workbench (it runs in the process).
  const added = await run(["library", "attach-arxiv", "--ref-id", W_DOCLESS]);
  expect(added.status).toBe(0);
  expect(json(added.stdout)).toMatchObject({ ok: true, status: "ok", docId: "arxiv-2603.00001" });
  expect(docsOf(dataDir, W_DOCLESS)).toEqual(["arxiv-2603.00001"]);
});

test("with a running workbench the commands go through it: ADS libraries, a local PDF, and the card for replacing a Doc", {
  timeout: 120_000,
}, async () => {
  const { run, start, dataDir, root, paths } = setup();
  const wb = await startWorkbench(dataDir);
  const listed = await run(["library", "list-ads-libraries"]);
  expect(listed.status).toBe(0);
  expect(json(listed.stdout)).toMatchObject({ ok: true, total: 1, libraries: [{ id: "lib_1" }] });
  const window = await run([
    "library",
    "read-ads-library",
    "--library-id",
    "lib_1",
    "--limit",
    "2",
  ]);
  expect(json(window.stdout)).toMatchObject({
    ok: true,
    total: 2,
    bibcodes: ["2021MNRAS.0001....B", "2021MNRAS.0002....B"],
  });

  const file = join(root, "paper.pdf");
  copyFileSync(PDF, file);
  const attached = await run([
    "library",
    "attach-local-pdf",
    "--ref-id",
    W_NOARXIV,
    "--path",
    file,
  ]);
  expect(attached.status).toBe(0);
  expect(json(attached.stdout)).toMatchObject({ ok: true, job: { status: "done" } });
  expect(docsOf(dataDir, W_NOARXIV)).toHaveLength(1);

  const irPath = join(paths.outputDir, REFRESH_DOC, `${REFRESH_DOC}.json`);
  const irBefore = readFileSync(irPath, "utf8");
  const refresh = ["library", "attach-arxiv", "--ref-id", W_REFRESH];

  // Denied: exit 3, nothing replaced.
  const denied = start(refresh);
  const first = await wb.waitFor("pending");
  expect(first.card.action).toBe("refresh_arxiv_source");
  await wb.decide(first.id, "deny");
  const deniedResult = await denied.done;
  expect(deniedResult.status).toBe(3);
  expect(json(deniedResult.stdout)).toMatchObject({ ok: false, status: "denied" });
  expect(readFileSync(irPath, "utf8")).toBe(irBefore);

  // Ctrl-C while the card waits: exit 130, the card is withdrawn.
  const withdrawn = start(refresh);
  await wb.waitFor("pending");
  withdrawn.child.kill("SIGINT");
  const withdrawnResult = await withdrawn.done;
  expect(withdrawnResult.status).toBe(130);
  expect(withdrawnResult.stderr).toMatch(/withdrawn/);
  expect(readFileSync(irPath, "utf8")).toBe(irBefore);
  await wb.waitFor("withdrawn");
});

test("with a running workbench an approved attach-arxiv replaces the text and the command exits 0 with the job's end", {
  timeout: 120_000,
}, async () => {
  const { start, dataDir, paths } = setup();
  const wb = await startWorkbench(dataDir);
  const irPath = join(paths.outputDir, REFRESH_DOC, `${REFRESH_DOC}.json`);
  const cli = start(["library", "attach-arxiv", "--ref-id", W_REFRESH]);
  const request = await wb.waitFor("pending");
  expect((await wb.decide(request.id, "approve")).status).toBe(200);
  const result = await cli.done;
  expect(result.status).toBe(0);
  expect(json(result.stdout)).toMatchObject({
    ok: true,
    status: "ok",
    docId: REFRESH_DOC,
    job: { status: "done" },
  });
  expect(readFileSync(irPath, "utf8")).toContain("Stub arXiv");
  expect(docsOf(dataDir, W_REFRESH)).toEqual([REFRESH_DOC]);
});
