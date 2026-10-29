/**
 * The reading and annotation operations of the catalog (release-0.2 ticket 07), on real files: the in-process runtime
 * of a CLI command, the running workbench's operation route and the Copilot `reader` tool answer the same, the
 * annotation writes keep the contract's three-state fingerprint rules (same: normal; different: the access path
 * archives; cannot be computed: a system error that touches nothing), and a read never writes.
 */
import {
  chmodSync,
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
import { join, relative } from "node:path";
import { OPERATION_CATALOG, type TexDocIr } from "@argelanderspace/contracts";
import { docContentFingerprint, libraryPaths, publishPdfDoc } from "@argelanderspace/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createAnnotationAccess } from "../src/annotations-access.js";
import { createReaderTool } from "../src/copilot-reader-tool.js";
import { DocMutationRegistry } from "../src/doc-mutations.js";
import {
  createLocalOperationRuntime,
  createServer,
  newWorkbenchToken,
  type RunningServer,
  runCatalogOperation,
  runOnWorkbench,
} from "../src/index.js";
import { AsyncLock } from "../src/lock.js";
import { createPdfAccess } from "../src/pdf-access.js";
import { probePdf } from "../src/pdfium-probe.js";
import { runReadSvgImage } from "../src/reader-operations.js";
import { createReaderOps } from "../src/reader-ops-deps.js";
import { TextDocService } from "../src/text-docs.js";
import { isolatedGlobalDirs, stubSources } from "./helpers.js";
import { syntheticPdf } from "./pdf-fixture.js";

/** An answer as JSON: the tests look at the parts they care about. */
// biome-ignore lint/suspicious/noExplicitAny: a parsed JSON answer of any shape
type Answer = Record<string, any>;
const DOC = "read-doc";
const W1 = "doi:10.1000/w1";
// a 1x1 PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);

let root: string;
let dataDir: string;
const servers: RunningServer[] = [];
const paths = () => libraryPaths(dataDir);
const docDir = () => join(dataDir, "output", DOC);
const irFile = () => join(docDir(), `${DOC}.json`);
const annDir = () => join(dataDir, "annotations", DOC);
const currentFile = () => join(annDir(), "current.json");

function docIr(text = "A paragraph of the synthetic paper."): TexDocIr {
  return {
    version: 1,
    docId: DOC,
    title: "A Synthetic Reader Paper",
    sections: [
      {
        id: "sec-1",
        level: 1,
        number: "1",
        heading: "Introduction",
        blocks: [
          { id: "p-1", type: "paragraph", segments: [{ type: "text", text }] },
          {
            id: "fig-1",
            type: "figure",
            imgPath: "plot.png",
            captionSegments: [{ type: "text", text: "Plot." }],
          },
        ],
        children: [],
      },
    ],
    refsManifest: [],
    bib: [],
    citationsByBlock: {},
    source: { type: "latex", origin: "x", main_tex: "main.tex" },
    meta: { title: "A Synthetic Reader Paper" },
  } as unknown as TexDocIr;
}

function writeDoc(ir: TexDocIr = docIr()) {
  mkdirSync(join(docDir(), "assets"), { recursive: true });
  writeFileSync(irFile(), JSON.stringify(ir));
  writeFileSync(join(docDir(), "assets", "plot.png"), PNG);
}
const fingerprintNow = () =>
  docContentFingerprint(JSON.parse(readFileSync(irFile(), "utf8")), { docDir: docDir() });
const NOTE = {
  id: "a_0000aaaa",
  target: { type: "document" as const },
  body: "  my exact note bytes  ",
  created_at: "2026-09-10T10:00:00.000Z",
  updated_at: "2026-09-10T10:00:00.000Z",
};
function writeCurrent(fingerprint: string, annotations: object[] = [NOTE], rev = 2) {
  mkdirSync(annDir(), { recursive: true });
  writeFileSync(
    currentFile(),
    `${JSON.stringify({ version: 1, rev, content_fingerprint: fingerprint, annotations }, null, 2)}\n`
  );
}

/** Every file under the user's data, with its bytes; `keep` selects what to look at. */
function tree(dir = dataDir): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    if (!existsSync(current)) return;
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) {
        out.push(`${relative(dir, full)}/`);
        walk(full);
      } else out.push(`${relative(dir, full)} ${readFileSync(full).toString("base64")}`);
    }
  };
  walk(dir);
  return out;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "reader-ops-"));
  dataDir = join(root, "data");
  mkdirSync(join(dataDir, "library"), { recursive: true });
  writeFileSync(
    paths().libraryJson,
    JSON.stringify({
      version: 1,
      project: { name: "Synthetic", short: "S", field: "" },
      works: [
        {
          id: W1,
          title: "Work number 1",
          authors: ["Author1"],
          year: 2001,
          venue: "MNRAS",
          type: "article",
          doi: "10.1000/w1",
          cite_key: "author1",
          doc_ids: [DOC],
        },
      ],
    })
  );
  writeDoc();
});
afterEach(async () => {
  for (const srv of servers.splice(0)) await srv.close().catch(() => {});
  try {
    chmodSync(annDir(), 0o755);
  } catch {
    // the directory may not exist
  }
  rmSync(root, { recursive: true, force: true });
});

const schemaOf = (id: string) => {
  const op = OPERATION_CATALOG.find((entry) => entry.id === id);
  if (!op) throw new Error(id);
  return op.result;
};
const local = () => createLocalOperationRuntime(paths());
const run = async (id: string, params: Record<string, unknown>) => {
  const answer = await runCatalogOperation(local(), id as never, params);
  expect(schemaOf(id).safeParse(answer).success, JSON.stringify(answer).slice(0, 300)).toBe(true);
  return answer as Answer;
};

async function startWorkbench() {
  const token = newWorkbenchToken();
  const srv = createServer({
    globalDirs: isolatedGlobalDirs(),
    dataDir,
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    deps: { makeSources: () => stubSources() },
    operationToken: token,
  });
  servers.push(srv);
  const port = await srv.ready();
  return async (id: string, params: Record<string, unknown>) => {
    const answer = await runOnWorkbench({ port, token }, { id, params });
    expect(answer.status).toBe(200);
    return answer.body as Answer;
  };
}

/** The Copilot `reader` tool over the same data seam, run as the model would. */
function copilotReader() {
  const lock = new AsyncLock();
  const docMutations = new DocMutationRegistry();
  const none = () => {};
  const annotationAccess = createAnnotationAccess({
    paths: paths(),
    lock,
    docMutations,
    onChanged: none,
  });
  const pdfAccess = createPdfAccess({
    paths: paths(),
    docMutations,
    lock,
    onChanged: none,
    readingPositionLock: new AsyncLock(),
    onReadingPositionChanged: none,
  });
  const tool = createReaderTool({
    conversationId: "c1",
    reader: createReaderOps({ paths: paths(), annotationAccess, pdfAccess, docMutations }),
    viewAction: async () => ({ status: "displayed" }),
    admitting: () => true,
  });
  return async (action: string, params: Record<string, unknown>) => {
    const result = await tool.execute(
      "call-1",
      { action, ...params },
      undefined,
      undefined,
      undefined as never
    );
    const part = result.content[0];
    return JSON.parse(part && part.type === "text" ? part.text : "{}") as Answer;
  };
}

/** Clock and random parts of an answer or of a file, so that two runs of one scenario compare equal. */
const normalize = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<time>")
    .replace(/a_[0-9a-f]{8}/g, "<id>")
    .replace(/\\n/g, " ");

// ---- the same answer from every entrance ------------------------------------------------------------- //

test("the in-process run, the running workbench and the Copilot tool give the same answers and leave the same files", async () => {
  const scenario = async (
    call: (id: string, action: string, params: Record<string, unknown>) => Promise<Answer>
  ) => {
    const answers: unknown[] = [];
    const reading = await call("reader.read", "read", { docId: DOC });
    answers.push(reading);
    const epoch = reading.reading.epoch;
    const created = await call("reader.create_annotation", "create_annotation", {
      docId: DOC,
      fingerprint: epoch.fingerprint,
      rev: epoch.annotationsRev,
      target: { type: "structure", id: "p-1" },
      body: "first note",
    });
    answers.push(created);
    const again = await call("reader.update_annotation", "update_annotation", {
      docId: DOC,
      fingerprint: epoch.fingerprint,
      rev: created.epoch.annotationsRev,
      annotationId: created.annotation.id,
      expectedUpdatedAt: created.annotation.updated_at,
      body: "first note, edited",
    });
    answers.push(again);
    // the same bytes: nothing is written
    answers.push(
      await call("reader.update_annotation", "update_annotation", {
        docId: DOC,
        fingerprint: epoch.fingerprint,
        rev: again.epoch.annotationsRev,
        annotationId: created.annotation.id,
        expectedUpdatedAt: again.annotation.updated_at,
        body: "first note, edited",
      })
    );
    // a revision that is no longer current writes nothing
    answers.push(
      await call("reader.delete_annotation", "delete_annotation", {
        docId: DOC,
        fingerprint: epoch.fingerprint,
        rev: epoch.annotationsRev,
        annotationId: created.annotation.id,
        expectedUpdatedAt: again.annotation.updated_at,
      })
    );
    answers.push(
      await call("reader.delete_annotation", "delete_annotation", {
        docId: DOC,
        fingerprint: epoch.fingerprint,
        rev: again.epoch.annotationsRev,
        annotationId: created.annotation.id,
        expectedUpdatedAt: again.annotation.updated_at,
      })
    );
    answers.push(
      await call("reader.create_annotation", "create_annotation", {
        docId: "no-such-doc",
        fingerprint: epoch.fingerprint,
        rev: 0,
        target: { type: "document" },
        body: "x",
      })
    );
    return answers;
  };

  const results: Record<string, { answers: unknown[]; files: string[] }> = {};
  // 1. in this process
  results.local = {
    answers: await scenario((id, _action, params) => run(id, params)),
    files: tree(),
  };
  // 2. a running workbench (a fresh data folder: the same Doc, the same start)
  rmSync(join(dataDir, "annotations"), { recursive: true, force: true });
  const viaWorkbench = await startWorkbench();
  results.workbench = {
    answers: await scenario((id, _action, params) => viaWorkbench(id, params)),
    files: tree().filter((line) => !/^(workbench\.json|jobs\/)/.test(line)),
  };
  // 3. the Copilot tool
  rmSync(join(dataDir, "annotations"), { recursive: true, force: true });
  const copilot = copilotReader();
  results.copilot = {
    answers: await scenario((_id, action, params) => copilot(action, params)),
    files: tree().filter((line) => !/^(workbench\.json|jobs\/)/.test(line)),
  };
  const local_ = normalize(results.local?.answers);
  expect(normalize(results.workbench?.answers)).toBe(local_);
  expect(normalize(results.copilot?.answers)).toBe(local_);
  expect(normalize(results.workbench?.files)).toBe(normalize(results.local?.files));
  expect(normalize(results.copilot?.files)).toBe(normalize(results.local?.files));
  // and the answers are what they should be
  const [, created, edited, noop, stale, deleted, missing] = (
    results.local as { answers: Answer[] }
  ).answers;
  expect(created).toMatchObject({ ok: true, status: "ok", epoch: { annotationsRev: 1 } });
  expect(edited).toMatchObject({ ok: true, status: "ok", epoch: { annotationsRev: 2 } });
  expect(noop).toMatchObject({ ok: true, status: "noop" });
  expect(stale).toMatchObject({ ok: false, status: "conflict", reason: "rev_mismatch" });
  expect(deleted).toMatchObject({ ok: true, status: "ok", epoch: { annotationsRev: 3 } });
  expect(missing).toMatchObject({ ok: false, status: "not_found" });
});

// ---- the three states of the content fingerprint ----------------------------------------------------- //

const WRITE = (extra: Record<string, unknown> = {}) => ({
  docId: DOC,
  fingerprint: "fingerprint" in extra ? extra.fingerprint : fingerprintNow(),
  rev: 2,
  target: { type: "document" },
  body: "new note",
  ...extra,
});

async function entrances(): Promise<
  [string, (id: string, params: Record<string, unknown>) => Promise<Answer>][]
> {
  const viaWorkbench = await startWorkbench();
  return [
    ["in this process", run],
    ["running workbench", viaWorkbench],
  ];
}

test("1. same fingerprint: the write is normal, on both paths", async () => {
  for (const [name, call] of await entrances()) {
    writeCurrent(fingerprintNow());
    const answer = await call("reader.create_annotation", WRITE());
    expect(answer, name).toMatchObject({ ok: true, status: "ok", epoch: { annotationsRev: 3 } });
    const stored = JSON.parse(readFileSync(currentFile(), "utf8"));
    expect(stored.annotations.map((a: { body: string }) => a.body)).toEqual([
      "  my exact note bytes  ",
      "new note",
    ]);
    expect(existsSync(join(annDir(), "archive")), name).toBe(false);
  }
});

test("2. different fingerprint: the access path archives the old batch and starts an empty current; reading does not", async () => {
  for (const [name, call] of await entrances()) {
    rmSync(annDir(), { recursive: true, force: true });
    writeDoc(docIr("A different paragraph: the content was replaced."));
    const oldFingerprint = "f".repeat(64);
    writeCurrent(oldFingerprint);
    const before = tree();
    // a read only leaves the stale annotations out: it never archives, and not a byte changes
    const reading = await call("reader.read", { docId: DOC });
    expect(reading, name).toMatchObject({ ok: true, status: "ok" });
    expect(reading.reading.annotations ?? []).toEqual([]);
    expect(tree(), name).toEqual(before);
    // the write finds the epoch is not the one it was planned against: conflict, and the archive happened on the way
    const answer = await call("reader.create_annotation", WRITE({ fingerprint: oldFingerprint }));
    expect(answer, name).toMatchObject({
      ok: false,
      status: "conflict",
      reason: "document_changed",
      archivedOlder: 1,
    });
    const archive = readdirSync(join(annDir(), "archive"));
    expect(archive, name).toHaveLength(1);
    const archived = JSON.parse(
      readFileSync(join(annDir(), "archive", archive[0] as string), "utf8")
    );
    expect(archived.annotations).toEqual([NOTE]);
    const current = JSON.parse(readFileSync(currentFile(), "utf8"));
    expect(current).toMatchObject({ content_fingerprint: fingerprintNow(), annotations: [] });
  }
});

test("3. cannot be computed: a system error, never a mismatch; the user's data is untouched", async () => {
  const cases: [string, () => void, RegExp?][] = [
    ["IR is not JSON", () => writeFileSync(irFile(), "{ not json")],
    ["IR does not fit the schema", () => writeFileSync(irFile(), JSON.stringify({ version: 1 }))],
    ["current.json is damaged", () => writeFileSync(currentFile(), "{ damaged")],
    [
      "the IR declares an image whose file is gone",
      () => rmSync(join(docDir(), "assets", "plot.png")),
    ],
  ];
  for (const [name, call] of await entrances()) {
    for (const [what, damage] of cases) {
      rmSync(annDir(), { recursive: true, force: true });
      writeDoc();
      const fp = fingerprintNow();
      writeCurrent(fp);
      damage();
      const before = tree();
      for (const write of [
        () => call("reader.create_annotation", WRITE({ fingerprint: fp })),
        () =>
          call("reader.delete_annotation", {
            docId: DOC,
            fingerprint: fp,
            rev: 2,
            annotationId: NOTE.id,
            expectedUpdatedAt: NOTE.updated_at,
          }),
      ]) {
        const answer = await write();
        expect(answer, `${name}: ${what}`).toMatchObject({ ok: false, status: "error" });
        expect(answer.detail).toMatch(/nothing was changed|could not be read|damaged/);
        expect(answer.status).not.toBe("conflict");
        // no archive, no new current, no rewrite
        expect(tree(), `${name}: ${what}`).toEqual(before);
      }
      // a read reports the same system error and writes nothing either
      const reading = await call("reader.read", { docId: DOC });
      expect(reading, `${name}: ${what}`).toMatchObject({ ok: false, status: "error" });
      expect(tree()).toEqual(before);
    }
  }
});

test("3b. a Doc that is not there is not_found and nothing is created", async () => {
  for (const [name, call] of await entrances()) {
    const before = tree();
    expect(
      await call("reader.create_annotation", WRITE({ docId: "no-such-doc" })),
      name
    ).toMatchObject({
      ok: false,
      status: "not_found",
    });
    expect(await call("reader.read", { docId: "no-such-doc" }), name).toMatchObject({
      ok: false,
      status: "not_found",
    });
    expect(tree(), name).toEqual(before);
  }
});

test("3c. an archive that cannot be written leaves the saved annotations exactly as they were", async () => {
  if (process.getuid?.() === 0) return; // root ignores directory permissions
  for (const [name, call] of await entrances()) {
    rmSync(annDir(), { recursive: true, force: true });
    writeDoc(docIr("Content replaced again, differently."));
    writeCurrent("e".repeat(64));
    chmodSync(annDir(), 0o555);
    const before = tree();
    const answer = await call("reader.create_annotation", WRITE({ fingerprint: "e".repeat(64) }));
    chmodSync(annDir(), 0o755);
    expect(answer, name).toMatchObject({ ok: false, status: "error" });
    expect(tree(), name).toEqual(before);
  }
});

// ---- Doc kinds and the reads ------------------------------------------------------------------------- //

test("a PDF Doc refuses the LaTeX writes and a LaTeX Doc refuses the PDF writes, both without touching anything", async () => {
  const bytes = syntheticPdf({ pageCount: 3 });
  const probed = await probePdf(bytes);
  const metadata = publishPdfDoc(paths(), {
    workId: W1,
    filename: "synthetic.pdf",
    bytes,
    pages: probed.pages,
  });
  const before = tree();
  const latexOnPdf = await run("reader.create_annotation", WRITE({ docId: metadata.doc_id }));
  expect(latexOnPdf).toMatchObject({ ok: false, status: "unsupported" });
  const pdfOnLatex = await run("reader.create_pdf_annotation", {
    docId: DOC,
    sha256: metadata.sha256,
    rev: 0,
    kind: "document_comment",
    body: "x",
  });
  expect(pdfOnLatex).toMatchObject({ ok: false });
  expect(tree()).toEqual(before);
});

test("PDF workbench annotations: read, create, update, delete, with the original's SHA-256 and the revision checked; the page image is a PNG", async () => {
  const bytes = syntheticPdf({ pageCount: 3 });
  const probed = await probePdf(bytes);
  const metadata = publishPdfDoc(paths(), {
    workId: W1,
    filename: "synthetic.pdf",
    bytes,
    pages: probed.pages,
  });
  const pdf = metadata.doc_id;
  const original = readFileSync(join(dataDir, "output", pdf, "original.pdf"));
  for (const [name, call] of await entrances()) {
    const reading = await call("reader.read", { docId: pdf });
    expect(reading, name).toMatchObject({ ok: true, status: "ok" });
    expect(reading.reading.sha256).toBe(metadata.sha256);
    const rev = reading.reading.annotationsRev as number;
    const created = await call("reader.create_pdf_annotation", {
      docId: pdf,
      sha256: metadata.sha256,
      rev,
      kind: "page_comment",
      pageIndex: 0,
      body: "page note",
    });
    expect(created, name).toMatchObject({
      ok: true,
      status: "ok",
      epoch: { annotationsRev: rev + 1 },
    });
    // a stale revision, a different original: nothing is written
    const sidecarBefore = tree();
    expect(
      await call("reader.create_pdf_annotation", {
        docId: pdf,
        sha256: metadata.sha256,
        rev,
        kind: "document_comment",
        body: "stale",
      }),
      name
    ).toMatchObject({ ok: false, status: "conflict", reason: "rev_mismatch" });
    expect(
      await call("reader.create_pdf_annotation", {
        docId: pdf,
        sha256: "b".repeat(64),
        rev: rev + 1,
        kind: "document_comment",
        body: "other original",
      }),
      name
    ).toMatchObject({ ok: false, status: "conflict", reason: "document_changed" });
    expect(tree(), name).toEqual(sidecarBefore);
    const updated = await call("reader.update_pdf_annotation", {
      docId: pdf,
      sha256: metadata.sha256,
      rev: rev + 1,
      annotationId: created.annotation.id,
      expectedUpdatedAt: created.annotation.updated_at,
      body: "page note, edited",
    });
    expect(updated, name).toMatchObject({ ok: true, status: "ok" });
    const deleted = await call("reader.delete_pdf_annotation", {
      docId: pdf,
      sha256: metadata.sha256,
      rev: updated.epoch.annotationsRev,
      annotationId: created.annotation.id,
      expectedUpdatedAt: updated.annotation.updated_at,
    });
    expect(deleted, name).toMatchObject({ ok: true, status: "ok" });
    // the PDF is never changed
    expect(readFileSync(join(dataDir, "output", pdf, "original.pdf")).equals(original)).toBe(true);
    // a page picture: base64 of a PNG, the original's SHA-256 checked
    const image = await call("reader.read_page_image", {
      docId: pdf,
      pageIndex: 0,
      sha256: metadata.sha256,
      longEdge: 256,
    });
    expect(image, name).toMatchObject({
      ok: true,
      status: "ok",
      page: { pageIndex: 0, pageCount: 3 },
    });
    expect(Buffer.from(image.data, "base64").subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(
      await call("reader.read_page_image", { docId: pdf, pageIndex: 0, sha256: "c".repeat(64) }),
      name
    ).toMatchObject({ ok: false, status: "conflict" });
    expect(
      await call("reader.read_page_image", {
        docId: pdf,
        pageIndex: 99,
        sha256: metadata.sha256,
      }),
      name
    ).toMatchObject({ ok: false });
  }
});

test("a LaTeX picture is read hash-checked as base64; an SVG renderer that is not there is said, not guessed", async () => {
  writeCurrent(fingerprintNow());
  for (const [name, call] of await entrances()) {
    const reading = await call("reader.read", { docId: DOC });
    const figure = (reading.reading.entries as { asset?: { path: string; sha256: string } }[]).find(
      (entry) => entry.asset
    );
    expect(figure?.asset, name).toBeDefined();
    const { path, sha256 } = (figure as { asset: { path: string; sha256: string } }).asset;
    const picture = await call("reader.read_image", { docId: DOC, path, sha256 });
    expect(picture, name).toMatchObject({
      ok: true,
      status: "ok",
      image: { mediaType: "image/png", width: 1, height: 1 },
      sha256,
    });
    expect(Buffer.from(picture.data, "base64").equals(PNG)).toBe(true);
    expect(
      await call("reader.read_image", { docId: DOC, path, sha256: "d".repeat(64) }),
      name
    ).toMatchObject({
      ok: false,
      status: "conflict",
    });
    expect(
      await call("reader.read_image", { docId: DOC, path: "../x", sha256 }),
      name
    ).toMatchObject({
      ok: false,
    });
    // a PNG is not an SVG
    expect(await call("reader.read_svg_image", { docId: DOC, path, sha256 }), name).toMatchObject({
      ok: false,
    });
  }
  const none = createReaderOps({
    paths: paths(),
    annotationAccess: createAnnotationAccess({
      paths: paths(),
      lock: new AsyncLock(),
      docMutations: new DocMutationRegistry(),
      onChanged: () => {},
    }),
    pdfAccess: createPdfAccess({
      paths: paths(),
      docMutations: new DocMutationRegistry(),
      lock: new AsyncLock(),
      onChanged: () => {},
      readingPositionLock: new AsyncLock(),
      onReadingPositionChanged: () => {},
    }),
    docMutations: new DocMutationRegistry(),
  });
  const reading = await run("reader.read", { docId: DOC });
  const asset = (reading.reading.entries as { asset?: { path: string; sha256: string } }[]).find(
    (entry) => entry.asset
  )?.asset as { path: string; sha256: string };
  expect(await runReadSvgImage(none, { docId: DOC, ...asset }, null)).toMatchObject({ ok: false });
});

test("reading a Doc in parts: from and version select a later part, a changed version is a conflict", async () => {
  writeCurrent(fingerprintNow());
  const whole = await run("reader.read", { docId: DOC });
  expect(whole.batch).toMatchObject({ status: "complete", from: 0 });
  const total = whole.batch.total as number;
  const beyond = await run("reader.read", { docId: DOC, from: total + 1 });
  expect(beyond).toMatchObject({ ok: false, status: "invalid" });
  const noVersion = await run("reader.read", { docId: DOC, from: 1 });
  expect(noVersion).toMatchObject({ ok: false, status: "invalid" });
  const rest = await run("reader.read", { docId: DOC, from: 1, version: whole.batch.version });
  expect(rest).toMatchObject({ ok: true, batch: { from: 1, status: "complete" } });
  const other = await run("reader.read", { docId: DOC, from: 1, version: "stale" });
  expect(other).toMatchObject({ ok: false, status: "conflict", reason: "version_changed" });
});

test("a text Doc's source is read as saved, whole or in parts, and the reading's annotations take the LaTeX writes", async () => {
  const service = new TextDocService({
    paths: paths(),
    libraryLock: new AsyncLock(),
    annotationLock: new AsyncLock(),
    docMutations: new DocMutationRegistry(),
    broadcast: () => {},
    libraryChanged: () => {},
  });
  const created = await service.create({ workId: W1, operationId: "op-read-source-1" });
  if (!created.ok) throw new Error(`create failed: ${JSON.stringify(created)}`);
  const docId = created.value.description.doc_id;
  const saved = await service.save(docId, {
    expectedRev: created.value.source.rev,
    markdown: "# Title\n\nSome text of the source.\n",
  });
  if (!saved.ok) throw new Error("save failed");
  const before = tree();
  for (const [name, call] of await entrances()) {
    const answer = await call("text.read_source", { docId });
    expect(answer, name).toMatchObject({
      ok: true,
      status: "ok",
      docId,
      rev: saved.value.rev,
      markdown: "# Title\n\nSome text of the source.\n",
    });
    expect(
      await call("text.read_source", { docId, from: 9, version: answer.version }),
      name
    ).toMatchObject({ ok: true, markdown: "Some text of the source.\n" });
    expect(await call("text.read_source", { docId, from: 9 }), name).toMatchObject({
      ok: false,
      status: "conflict",
    });
    expect(await call("text.read_source", { docId: "nope" }), name).toMatchObject({
      ok: false,
      status: "not_found",
    });
  }
  expect(tree().filter((line) => !/^(workbench\.json|jobs\/)/.test(line))).toEqual(before);
});
