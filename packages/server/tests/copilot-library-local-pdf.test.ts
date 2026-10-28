/**
 * `library` action `attach_local_pdf` (project intake ticket 01, contracts "项目迁入"): a PDF at a local absolute path
 * becomes a Doc of an existing Work through the Files tab upload's own server path.
 *
 * Two layers, both on real seams and synthetic data in a temporary directory (the repo's own `literatures/` is never
 * touched): the tool over a real `createAcquisition` (real serial JobRunner under `<data>/jobs`, real PDFium parse,
 * real library lock, real DocMutationRegistry) for the behaviour and every failure; and a real CopilotHost over
 * `createApp` with a config file for the permission wiring and the shared route. Only the model is scripted.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type {
  ConversationSnapshot,
  CopilotFileToolsSetting,
  CopilotOperation,
  PageContext,
} from "@argelanderspace/contracts";
import { DOCUMENT_BUSY } from "@argelanderspace/contracts";
import { type LibraryPaths, LibraryStore, libraryPaths, plansPath } from "@argelanderspace/core";
import { createLogger } from "@argelanderspace/infra";
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMemorySink } from "../../infra/tests/log-memory-sink.js";
import { createAcquisition } from "../src/acquisition.js";
import { createApp } from "../src/app.js";
import { CopilotHost } from "../src/copilot.js";
import { createLibraryTool } from "../src/copilot-library-tool.js";
import { DocMutationRegistry } from "../src/doc-mutations.js";
import { JobRunner } from "../src/jobs.js";
import { AsyncLock } from "../src/lock.js";
import { SERVER_LOG_EVENTS } from "../src/log.js";
import { jobLogger } from "../src/log-observers.js";
import { ProviderSettings } from "../src/providers.js";
import { stubPipelines, stubSources } from "./helpers.js";
import { syntheticPdf } from "./pdf-fixture.js";

const FIXTURES = new URL("./fixtures/pdf/", import.meta.url);
const VALID = readFileSync(new URL("scanned-no-text.pdf", FIXTURES));
const TRUNCATED = readFileSync(new URL("truncated.pdf", FIXTURES));
const ENCRYPTED = readFileSync(new URL("password-required.pdf", FIXTURES));
const W_A = "doi:10.1000/a";
const W_B = "doi:10.1000/b";

const work = (id: string, extra: object = {}) => ({
  id,
  title: `Work ${id}`,
  authors: ["Author"],
  year: 2026,
  venue: "MNRAS",
  type: "article",
  doi: id.slice(4),
  cite_key: id.replace(/[^a-z0-9]/gi, ""),
  doc_ids: [],
  ...extra,
});
const seed = () => ({ version: 1, works: [work(W_A), work(W_B)] });

let root: string;
let source: string;
let paths: LibraryPaths;
let permission: CopilotFileToolsSetting | undefined;
let runner: JobRunner;
let registry: DocMutationRegistry;
let changes: string[];
let acquisition: ReturnType<typeof createAcquisition>;
let logged: ReturnType<typeof createMemorySink>;
let tool: ReturnType<typeof createLibraryTool>;

function build() {
  logged = createMemorySink();
  const log = createLogger({ events: SERVER_LOG_EVENTS, sink: logged });
  runner = new JobRunner({ dir: join(paths.dataDir, "jobs"), observe: jobLogger(log) });
  registry = new DocMutationRegistry();
  const libraryLock = new AsyncLock();
  acquisition = createAcquisition({
    paths,
    runner,
    libraryLock,
    annotationLock: new AsyncLock(),
    docMutations: registry,
    libraryChanged: (cause) => changes.push(cause),
    lockedRebuild: async () => ({ works: 0 }) as never,
    pipelines: stubPipelines(),
    makeSources: () => stubSources(),
    fetchArxivPdf: async () => VALID,
    autoIngestArxiv: () => false,
    pdfOwners: (docId) => LibraryStore.load(paths).works.filter((w) => w.doc_ids.includes(docId)),
    log,
  });
  runner.onEvent = (type, job) => acquisition.onJobEvent(type, job);
  tool = createLibraryTool({
    library: {
      paths,
      libraryLock,
      onChanged: () => changes.push("patch"),
      readPayload: async () => {
        throw new Error("unused");
      },
      acquisition,
    },
    viewAction: async () => ({ ok: true }) as never,
    admitting: () => true,
    ...(permission === undefined ? {} : { fileToolsPermission: () => permission }),
  } as never);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "local-pdf-"));
  source = join(root, "source");
  mkdirSync(source, { recursive: true });
  paths = libraryPaths(join(root, "data"));
  mkdirSync(paths.libraryDir, { recursive: true });
  mkdirSync(paths.outputDir, { recursive: true });
  writeFileSync(paths.libraryJson, JSON.stringify(seed(), null, 2));
  changes = [];
  permission = "ask";
  build();
});
afterEach(async () => {
  await Promise.all(
    runner
      .list()
      .filter((job) => job.status === "queued" || job.status === "running")
      .map((job) => runner.waitFor(job.id))
  );
  rmSync(root, { recursive: true, force: true });
});

type Result = Record<string, unknown> & { ok: boolean; status: string; reason?: string };
async function attach(args: Record<string, unknown>, id = randomUUID()) {
  const result = await tool.execute(
    id,
    { action: "attach_local_pdf", ...args } as never,
    undefined as never,
    undefined as never,
    undefined as never
  );
  const first = result.content[0];
  return {
    payload: JSON.parse(first && first.type === "text" ? first.text : "{}") as Result,
    details: result.details as CopilotOperation,
  };
}
const put = (name: string, bytes: Buffer = VALID) => {
  const path = join(source, name);
  writeFileSync(path, bytes);
  return path;
};

/** Every file and directory under a folder, relative, sorted, with the bytes' length for files. */
function listing(dir: string, skip: (rel: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const rel = relative(dir, full);
      if (skip(rel)) continue;
      const stat = statSync(full);
      out.push(stat.isDirectory() ? `${rel}/` : `${rel} ${stat.size}`);
      if (stat.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out;
}
const dataListing = () => listing(paths.dataDir);
/** The data folder without the job records, for refusals the shared upload job itself reaches. */
const dataWithoutJobs = () =>
  listing(paths.dataDir, (rel) => rel === "jobs" || rel.startsWith("jobs/"));
const libraryBytes = () => readFileSync(paths.libraryJson, "utf8");
const docDirs = () => readdirSync(paths.outputDir).filter((name) => name.startsWith("pdf-"));
const workDocs = (id: string) => LibraryStore.load(paths).get(id)?.doc_ids ?? [];

// ---- success -------------------------------------------------------------------------------------------- //

test("attaching a local PDF runs the upload's job and makes a complete PDF Doc; the source file is not touched", async () => {
  const path = put("Smith 2020 (final).pdf");
  const past = new Date("2020-01-02T03:04:05Z");
  utimesSync(path, past, past);
  const before = { bytes: readFileSync(path), stat: statSync(path), dir: listing(source) };

  const { payload, details } = await attach({ refId: W_A, path });

  expect(payload).toMatchObject({
    ok: true,
    status: "ok",
    job: { status: "done", format: "pdf", workId: W_A },
    object: { kind: "work", id: W_A },
    source: { filename: "Smith 2020 (final).pdf", bytes: VALID.length },
  });
  const docId = payload.docId as string;
  expect(docId).toMatch(/^pdf-[0-9a-f-]{36}$/);
  expect(details).toMatchObject({
    tool: "library",
    action: "attach_local_pdf",
    status: "ok",
    docId,
    job: { status: "done" },
    object: { kind: "work", id: W_A },
  });
  // The upload job is the application's own: one upload job with the page upload's payload.
  expect(runner.list()).toHaveLength(1);
  expect(runner.list()[0]).toMatchObject({
    kind: "upload",
    status: "done",
    payload: { workId: W_A, docId, format: "pdf" },
  });
  // Original, metadata, empty annotations and a null reading position, as for a page upload.
  const dir = join(paths.outputDir, docId);
  expect(readdirSync(dir).sort()).toEqual(
    ["annotations.json", `${docId}.json`, "original.pdf", "reading-position.json"].sort()
  );
  expect(readFileSync(join(dir, "original.pdf")).equals(VALID)).toBe(true);
  const metadata = JSON.parse(readFileSync(join(dir, `${docId}.json`), "utf8"));
  expect(metadata).toMatchObject({
    format: "pdf",
    doc_id: docId,
    original_filename: "Smith 2020 (final).pdf",
    acquired_via: "user_pdf_upload",
    byte_length: VALID.length,
    page_count: 1,
  });
  expect(JSON.parse(readFileSync(join(dir, "annotations.json"), "utf8"))).toMatchObject({
    doc_id: docId,
    rev: 0,
    annotations: [],
    content_sha256: metadata.sha256,
  });
  expect(JSON.parse(readFileSync(join(dir, "reading-position.json"), "utf8"))).toMatchObject({
    doc_id: docId,
    rev: 0,
    position: null,
    content_sha256: metadata.sha256,
  });
  // Attached to the Work as main; library.changed went out once with the upload's own cause.
  expect(workDocs(W_A)).toEqual([docId]);
  expect(workDocs(W_B)).toEqual([]);
  expect(changes).toEqual(["upload"]);
  // The source is byte-for-byte and mtime unchanged, and nothing was added next to it.
  expect(readFileSync(path).equals(before.bytes)).toBe(true);
  expect(statSync(path).mtimeMs).toBe(before.stat.mtimeMs);
  expect(statSync(path).size).toBe(before.stat.size);
  expect(listing(source)).toEqual(before.dir);
});

test("auto runs the same way as ask, with no confirmation (the tool has no confirmation port)", async () => {
  permission = "auto";
  build();
  const { payload } = await attach({ refId: W_A, path: put("a.pdf") });
  expect(payload).toMatchObject({ ok: true, status: "ok" });
});

test("a second attach of the same bytes to the same Work reuses the Doc: noop, nothing created, no broadcast", async () => {
  const first = await attach({ refId: W_A, path: put("a.pdf") });
  changes.length = 0;
  const again = await attach({ refId: W_A, path: put("copy-of-a.pdf") });
  expect(again.payload).toMatchObject({
    ok: true,
    status: "noop",
    docId: first.payload.docId,
  });
  expect(docDirs()).toEqual([first.payload.docId]);
  expect(workDocs(W_A)).toEqual([first.payload.docId]);
  expect(changes).toEqual([]);
});

test("the same bytes on another Work are a new Doc with its own files", async () => {
  const path = put("a.pdf");
  const first = await attach({ refId: W_A, path });
  const second = await attach({ refId: W_B, path });
  expect(second.payload).toMatchObject({ ok: true, status: "ok" });
  expect(second.payload.docId).not.toBe(first.payload.docId);
  expect(docDirs().sort()).toEqual([first.payload.docId, second.payload.docId].sort());
  expect(workDocs(W_A)).toEqual([first.payload.docId]);
  expect(workDocs(W_B)).toEqual([second.payload.docId]);
});

test("a different PDF on a Work that has one is appended; the main Doc stays", async () => {
  const first = await attach({ refId: W_A, path: put("a.pdf") });
  const other = Buffer.concat([VALID, Buffer.from("\n% second\n")]);
  const second = await attach({ refId: W_A, path: put("b.pdf", other) });
  expect(second.payload).toMatchObject({ ok: true, status: "ok" });
  expect(workDocs(W_A)).toEqual([first.payload.docId, second.payload.docId]);
});

test("a symbolic link to a regular PDF is read through; the Doc records the name it was given", async () => {
  const real = put("real.pdf");
  const link = join(source, "link.pdf");
  symlinkSync(real, link);
  const { payload } = await attach({ refId: W_A, path: link });
  expect(payload).toMatchObject({ ok: true, status: "ok", source: { filename: "link.pdf" } });
});

test("the job's progress and a resource warning are the upload's: a 25 MiB file warns", async () => {
  // Valid PDF bytes padded after %%EOF to 26 MiB: PDFium accepts trailing data, the size is what the warning reads.
  const padded = Buffer.concat([VALID, Buffer.alloc(26 * 1024 * 1024, 0x20)]);
  const { payload } = await attach({ refId: W_A, path: put("big.pdf", padded) });
  expect(payload).toMatchObject({ ok: true, resourceWarning: true });
});

// ---- failures: nothing is written ------------------------------------------------------------------------ //

/** A refusal before the job is queued: the whole data folder is exactly as it was, and no broadcast went out. */
async function refusedBeforeAnyJob(args: Record<string, unknown>, wanted: object) {
  const before = { data: dataListing(), library: libraryBytes() };
  const { payload, details } = await attach(args);
  expect(payload).toMatchObject({ ok: false, ...wanted });
  expect(typeof payload.detail).toBe("string");
  expect(details.status).toBe(payload.status);
  expect(dataListing()).toEqual(before.data);
  expect(libraryBytes()).toBe(before.library);
  expect(runner.list()).toEqual([]);
  expect(changes).toEqual([]);
  return payload;
}

test("a relative path, a missing file and a missing Work write nothing and name the reason", async () => {
  const path = put("a.pdf");
  await refusedBeforeAnyJob(
    { refId: W_A, path: "a.pdf" },
    { status: "rejected", reason: "path_not_absolute" }
  );
  await refusedBeforeAnyJob(
    { refId: W_A, path: "~/a.pdf" },
    { status: "rejected", reason: "path_not_absolute" }
  );
  await refusedBeforeAnyJob(
    { refId: W_A, path: join(source, "missing.pdf") },
    { status: "not_found", reason: "source_not_found" }
  );
  await refusedBeforeAnyJob(
    { refId: W_A, path: join(source, "missing-dir", "a.pdf") },
    { status: "not_found", reason: "source_not_found" }
  );
  await refusedBeforeAnyJob(
    { refId: "doi:10.9999/none", path },
    { status: "not_found", reason: "work_not_found" }
  );
});

test("a directory, a link to a directory, a device and a pipe are refused as not regular files", async () => {
  const dir = join(source, "folder");
  mkdirSync(dir);
  const linkToDir = join(source, "dirlink");
  symlinkSync(dir, linkToDir);
  const linkToDevice = join(source, "devlink");
  symlinkSync("/dev/null", linkToDevice);
  const pipe = join(source, "pipe.pdf");
  execFileSync("mkfifo", [pipe]);
  for (const path of [dir, linkToDir, "/dev/null", linkToDevice, pipe])
    await refusedBeforeAnyJob(
      { refId: W_A, path },
      { status: "rejected", reason: "not_regular_file" }
    );
  // The pipe was never opened (an open for reading would have blocked), the folder was left alone.
  expect(readdirSync(dir)).toEqual([]);
});

test("an empty file and a file over 50 MiB are refused; the big one is not read into memory", async () => {
  await refusedBeforeAnyJob(
    { refId: W_A, path: put("empty.pdf", Buffer.alloc(0)) },
    { status: "rejected", reason: "empty" }
  );
  const big = put("big.pdf", Buffer.alloc(0));
  truncateSync(big, 50 * 1024 * 1024 + 1);
  await refusedBeforeAnyJob({ refId: W_A, path: big }, { status: "rejected", reason: "too_large" });
  expect(statSync(big).size).toBe(50 * 1024 * 1024 + 1);
});

test.skipIf(process.getuid?.() === 0)(
  "an unreadable file is an error with the reason, not a crash",
  async () => {
    const path = put("locked.pdf");
    chmodSync(path, 0o000);
    try {
      await refusedBeforeAnyJob({ refId: W_A, path }, { status: "error", reason: "unreadable" });
    } finally {
      chmodSync(path, 0o600);
    }
  }
);

test("a Doc being written or deleted makes the attach busy: nothing is queued or written", async () => {
  const first = await attach({ refId: W_A, path: put("a.pdf") });
  const docId = first.payload.docId as string;
  changes.length = 0;
  const before = { data: dataListing(), library: libraryBytes(), jobs: runner.list().length };
  registry.pinWriter(docId);
  const { payload } = await attach({ refId: W_A, path: put("again.pdf") });
  registry.unpinWriter(docId);
  expect(payload).toMatchObject({ ok: false, status: "rejected", reason: "busy" });
  expect(dataListing()).toEqual(before.data);
  expect(libraryBytes()).toBe(before.library);
  expect(runner.list()).toHaveLength(before.jobs);
  expect(changes).toEqual([]);
});

/** The shared upload job fails with `error`: the tool runs over a port whose upload start submits such a job. */
async function failedInsideTheJob(error: string) {
  const failing = {
    ...acquisition,
    startPdfUpload: () => ({
      kind: "queued" as const,
      job: runner.submit(
        "upload",
        async () => {
          throw new Error(error);
        },
        { format: "pdf", workId: W_A }
      ),
    }),
  };
  const libraryLock = new AsyncLock();
  const direct = createLibraryTool({
    library: {
      paths,
      libraryLock,
      onChanged: () => {},
      readPayload: async () => {
        throw new Error("unused");
      },
      acquisition: failing,
    },
    viewAction: async () => ({ ok: true }) as never,
    admitting: () => true,
    fileToolsPermission: () => "ask",
  } as never);
  const result = await direct.execute(
    randomUUID(),
    { action: "attach_local_pdf", refId: W_A, path: put("x.pdf") } as never,
    undefined as never,
    undefined as never,
    undefined as never
  );
  const first = result.content[0];
  return JSON.parse(first && first.type === "text" ? first.text : "{}") as Result;
}

test("a DOCUMENT_BUSY raised inside the upload job is reported as busy, with the busy sentence", async () => {
  const payload = await failedInsideTheJob(DOCUMENT_BUSY);
  expect(payload).toMatchObject({ ok: false, reason: "busy" });
  expect(String(payload.detail)).toContain("became busy");
  expect(String(payload.detail)).not.toContain(DOCUMENT_BUSY);
});

test("any other job failure is job_failed with this action's own fixed sentence, not the raw error", async () => {
  const payload = await failedInsideTheJob("EACCES: /secret/path/leak.pdf could not be written");
  expect(payload).toMatchObject({ ok: false, status: "error", reason: "job_failed" });
  expect(String(payload.detail)).toContain("the upload task failed; nothing was attached");
  // The sentence is the action's own; the job view beside it is the existing job record, not this action's text.
  expect(String(payload.detail)).not.toContain("/secret/path");
  expect(String(payload.detail)).not.toContain("EACCES");
});

/** A refusal PDFium's trusted parse reaches inside the shared upload job: no Doc, no library change, no spool left. */
async function refusedByTheUploadJob(bytes: Buffer, reason: string) {
  const before = {
    data: dataWithoutJobs(),
    library: libraryBytes(),
    docs: docDirs(),
    changes: changes.length,
  };
  const { payload, details } = await attach({ refId: W_A, path: put(`${reason}.pdf`, bytes) });
  expect(payload).toMatchObject({ ok: false, status: "error", reason });
  expect(details.status).toBe("error");
  expect(payload.detail).toMatch(/nothing was attached/);
  expect(dataWithoutJobs()).toEqual(before.data);
  expect(libraryBytes()).toBe(before.library);
  expect(docDirs()).toEqual(before.docs);
  expect(changes).toHaveLength(before.changes);
  // What the job leaves is its failed record only (as a failed page upload does), and not its spool file.
  const jobId = (payload.job as { id: string }).id;
  expect(runner.list().find((job) => job.id === jobId)).toMatchObject({ status: "failed" });
  expect(readdirSync(join(paths.dataDir, "jobs", "spool"))).toEqual([]);
  // The error text reaches the model as the category and the fixed sentence, never the file's bytes.
  expect(JSON.stringify(payload)).not.toContain("%PDF");
}

test("files PDFium refuses (not a PDF, truncated, password-protected, over 100 pages) fail inside the upload's job", async () => {
  await refusedByTheUploadJob(
    Buffer.from("this is plainly not a pdf file, just text\n"),
    "not_a_pdf"
  );
  await refusedByTheUploadJob(TRUNCATED, "not_a_pdf");
  await refusedByTheUploadJob(ENCRYPTED, "encrypted");
  await refusedByTheUploadJob(syntheticPdf({ pageCount: 101 }), "page_limit");
});

// ---- the permission -------------------------------------------------------------------------------------- //

test("with the file permission off, or unknown, the action is refused before the file is looked at", async () => {
  const path = put("a.pdf");
  for (const setting of ["off", undefined] as const) {
    permission = setting;
    build();
    const before = dataListing();
    const { payload, details } = await attach({ refId: W_A, path });
    expect(payload).toMatchObject({ ok: false, status: "rejected", reason: "file_tools_off" });
    expect(details).toMatchObject({ action: "attach_local_pdf", status: "rejected" });
    expect(dataListing()).toEqual(before);
    expect(runner.list()).toEqual([]);
  }
  expect(workDocs(W_A)).toEqual([]);
});

test("the permission is read at every call: turning it off after a first attach refuses the next", async () => {
  expect((await attach({ refId: W_A, path: put("a.pdf") })).payload.ok).toBe(true);
  permission = "off";
  expect((await attach({ refId: W_B, path: put("b.pdf") })).payload).toMatchObject({
    ok: false,
    reason: "file_tools_off",
  });
  expect(workDocs(W_B)).toEqual([]);
});

// ---- parameters and the user log ------------------------------------------------------------------------- //

test("only refId and path are accepted; extra fields and a missing path are refused as unsupported", async () => {
  const path = put("a.pdf");
  for (const args of [
    { refId: W_A },
    { path },
    { refId: W_A, path, docId: "x" },
    { refId: W_A, path: "" },
  ]) {
    const { payload } = await attach(args);
    expect(payload).toMatchObject({ ok: false, status: "unsupported" });
  }
  expect(runner.list()).toEqual([]);
  expect(docDirs()).toEqual([]);
});

test("the user log never carries the path or the file name", async () => {
  const path = put("Secret Draft Name.pdf");
  await attach({ refId: W_A, path });
  await attach({ refId: W_A, path: join(source, "missing.pdf") });
  await refusedByTheUploadJob(TRUNCATED, "not_a_pdf");
  const text = logged.lines.join("\n");
  expect(text).toContain("job.failed");
  for (const secret of [root, source, "Secret Draft Name", "missing.pdf", "truncated"])
    expect(text).not.toContain(secret);
});

// ---- the real host: the permission wiring and the shared route -------------------------------------------- //

type Step = (context: TranscriptContext) => { text?: string; call?: Record<string, unknown> };
const choice = { provider: "openai", model: "gpt-4.1", thinking: null };
const VIEW = randomUUID();

test("through a real Copilot host: config.toml's copilot_file_tools decides, and the page's upload route is the same path", async () => {
  const originalEnv = process.env;
  const project = join(root, "project");
  const dataDir = join(project, "literatures");
  const statusDir = join(root, "status");
  const globalDir = join(root, "global");
  const cacheDir = join(root, "cache-global");
  const configPath = join(root, "cfg", "config.toml");
  for (const dir of [dataDir, statusDir, globalDir, cacheDir, join(root, "cfg")])
    mkdirSync(dir, { recursive: true });
  writeFileSync(plansPath(statusDir), JSON.stringify({ version: 1, rev: 1, plans: [] }));
  const hostPaths = libraryPaths(dataDir);
  mkdirSync(hostPaths.libraryDir, { recursive: true });
  writeFileSync(hostPaths.libraryJson, JSON.stringify(seed(), null, 2));
  const setPermission = (value: string) =>
    writeFileSync(
      configPath,
      `copilot_file_tools = "${value}"\nglobal_dir = ${JSON.stringify(globalDir)}\nglobal_cache_dir = ${JSON.stringify(cacheDir)}\n`
    );
  process.env = { PATH: originalEnv.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "xdg") };
  vi.stubGlobal("fetch", () => {
    throw new Error("unexpected external fetch");
  });
  const script: Step[] = [];
  const seen: TranscriptContext[] = [];
  const settings = new ProviderSettings();
  await settings.credential("openai", "SYNTHETIC_COPILOT_KEY");
  (await settings.getRuntime()).registerProvider("openai", {
    api: "openai-responses",
    streamSimple(model: Model<Api>, context: TranscriptContext) {
      seen.push(structuredClone(context));
      const index = seen.length;
      const out = script[index - 1]?.(context) ?? { text: "done" };
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content: out.call
          ? [
              {
                type: "toolCall",
                id: `call_${index}`,
                name: "library",
                arguments: out.call as never,
              },
            ]
          : [{ type: "text", text: out.text ?? "done" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: out.call ? "toolUse" : "stop",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      });
      return stream;
    },
  });
  const hostRunner = new JobRunner({ dir: join(root, "host-jobs") });
  const host = new CopilotHost(dataDir, settings, () => {});
  const broadcasts: { type: string }[] = [];
  const app = createApp({
    paths: hostPaths,
    statusDir,
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: hostRunner,
    providerSettings: settings,
    copilot: host,
    configPath,
    projectRoot: project,
    broadcast: (message) => broadcasts.push(message as { type: string }),
  });
  const request = (path: string, method = "GET", body?: unknown) =>
    app.request(`/api/copilot${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const pageContext: PageContext = {
    version: 1,
    viewId: VIEW,
    revision: 1,
    paneId: 1,
    view: "plan",
    status: "complete",
    otherPanes: [],
    plan: {
      rev: 1,
      mode: "list",
      selectedPlanId: null,
      saveState: "saved",
      groups: [],
      detail: null,
      plans: [],
    },
  };
  const lastPayload = (context: TranscriptContext) => {
    const last = context.messages.filter((m) => m.role === "toolResult").at(-1);
    if (last?.role !== "toolResult") throw new Error("no tool result yet");
    const part = last.content[0];
    return JSON.parse(part && part.type === "text" ? part.text : "{}") as Result;
  };
  const converse = async (call: Record<string, unknown>) => {
    script.length = 0;
    script.push(
      () => ({ call }),
      () => ({ text: "done" })
    );
    seen.length = 0;
    const created = (await (
      await request("/conversations", "POST", { model: choice })
    ).json()) as ConversationSnapshot;
    const id = created.conversation.id;
    expect((await request(`/views/${VIEW}`, "PUT", pageContext)).status).toBe(200);
    expect(
      (
        await request(`/conversations/${id}/messages`, "POST", {
          clientMessageId: randomUUID(),
          text: "attach it",
          viewId: VIEW,
          contextRevision: 1,
        })
      ).status
    ).toBe(202);
    await vi.waitFor(
      async () =>
        expect(["completed", "failed", "stopped"]).toContain(
          (await host.snapshot(id)).conversation.run?.status
        ),
      { timeout: 15_000 }
    );
    return { id, payload: lastPayload(seen[1] as TranscriptContext) };
  };
  try {
    const path = put("host.pdf");
    // off: refused, nothing written.
    setPermission("off");
    // The conversation's own files (copilot/) are written as it runs; the Library is what must not change.
    const libraryFiles = () =>
      listing(dataDir, (rel) => rel === "copilot" || rel.startsWith("copilot/"));
    const dataBefore = libraryFiles();
    expect(
      (await converse({ action: "attach_local_pdf", refId: W_A, path })).payload
    ).toMatchObject({
      ok: false,
      reason: "file_tools_off",
    });
    expect(libraryFiles()).toEqual(dataBefore);
    // ask: it runs, with no confirmation card.
    setPermission("ask");
    const ran = await converse({ action: "attach_local_pdf", refId: W_A, path });
    const attached = ran.payload;
    expect(attached).toMatchObject({ ok: true, status: "ok", source: { filename: "host.pdf" } });
    expect((await host.snapshot(ran.id)).confirmations).toEqual([]);
    expect(LibraryStore.load(hostPaths).get(W_A)?.doc_ids).toEqual([attached.docId]);
    expect(broadcasts.filter((m) => m.type === "library.changed")).toHaveLength(1);
    // The page's own route, with the same bytes on the same Work, finds the Doc the tool made (one shared path).
    const upload = await app.request(`/api/library/upload-pdf?id=${encodeURIComponent(W_A)}`, {
      method: "POST",
      headers: { "x-filename": "page-upload.pdf" },
      body: VALID,
    });
    expect(upload.status).toBe(202);
    const { job } = (await upload.json()) as { job: { id: string } };
    const finished = await hostRunner.waitFor(job.id);
    expect(finished).toMatchObject({
      status: "done",
      result: { status: "exists", doc: { doc_id: attached.docId } },
    });
    expect(readdirSync(hostPaths.outputDir).filter((name) => name.startsWith("pdf-"))).toEqual([
      attached.docId,
    ]);
    expect(LibraryStore.load(hostPaths).get(W_A)?.doc_ids).toEqual([attached.docId]);
    // auto behaves like ask.
    setPermission("auto");
    const second = await converse({
      action: "attach_local_pdf",
      refId: W_B,
      path: put("host-b.pdf", Buffer.concat([VALID, Buffer.from("\n%b\n")])),
    });
    expect(second.payload).toMatchObject({ ok: true, status: "ok" });
  } finally {
    await host.close().catch(() => {});
    process.env = originalEnv;
    vi.unstubAllGlobals();
  }
});
