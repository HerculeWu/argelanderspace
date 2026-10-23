/**
 * Taking a Shelf (文献仓) entry into a project, and the Shelf's read-only queries (shelf ticket 04;
 * contracts「文献仓」). A synthetic source project is built with the core's own writers (a LaTeX Doc with an
 * image asset and annotations, a PDF Doc published through `publishPdfDoc`, a text Doc draft, an argument graph and
 * a note), put on an isolated Shelf the way an add does (contracts `shelfDocFileAllowed`), and taken into a second
 * synthetic project through the HTTP routes. No real user data: every directory is a fresh temp directory.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  type Annotation,
  type ArgumentGraph,
  type ShelfAnnotationsResponse,
  type ShelfBibliography,
  type ShelfDocKind,
  type ShelfTakePreview,
  type ShelfTakeResult,
  shelfDocFileAllowed,
  type TexDocIr,
} from "@argelanderspace/contracts";
import {
  annotationsArchiveDir,
  annotationsCurrentPath,
  argumentGraphPath,
  createTextDoc,
  docContentFingerprint,
  type LibraryPaths,
  LibraryStore,
  libraryPaths,
  publishPdfDoc,
  rebuild,
  replaceArgumentGraph,
  saveAnnotationsFile,
} from "@argelanderspace/core";
import { createShelfStore, type ShelfStore } from "@argelanderspace/infra";
import type { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { statusDirFor } from "../src/deps.js";
import { DocMutationRegistry } from "../src/doc-mutations.js";
import { JobRunner } from "../src/jobs.js";
import { AsyncLock } from "../src/lock.js";
import { createShelfTake } from "../src/shelf-take.js";
import { collectBroadcasts, stubPipelines, stubSources } from "./helpers.js";
import { syntheticPdf } from "./pdf-fixture.js";

const DOI = "10.1234/shelf.take";
const LATEX = "latex-shelf-paper";
const PAGES = [
  { width: 612, height: 792, rotation: 0 as const },
  { width: 612, height: 792, rotation: 0 as const },
  { width: 612, height: 792, rotation: 0 as const },
];

// ---- synthetic projects ---------------------------------------------------------------------------------------

function newProject(works: Record<string, unknown>[]): LibraryPaths {
  const paths = libraryPaths(join(mkdtempSync(join(tmpdir(), "shelf-take-")), "data"));
  mkdirSync(paths.outputDir, { recursive: true });
  mkdirSync(paths.libraryDir, { recursive: true });
  writeFileSync(
    paths.libraryJson,
    JSON.stringify(
      { version: 1, project: { name: "Synthetic", short: "S", field: "" }, works },
      null,
      2
    )
  );
  return paths;
}

function latexIr(docId: string, opts: { title: string; doi?: string; text?: string }): TexDocIr {
  return {
    version: 1,
    docId,
    sections: [
      {
        id: "sec-1",
        level: 1,
        number: "1",
        heading: "Introduction",
        blocks: [
          {
            id: "p-1",
            type: "paragraph",
            segments: [{ type: "text", text: opts.text ?? "Hello world" }],
          },
          { id: "fig-1", type: "figure", imgPath: "fig.png" },
        ],
        children: [],
      },
    ],
    refsManifest: [],
    bib: [],
    citationsByBlock: {},
    source: {
      type: "latex",
      origin: "/elsewhere/src",
      main_tex: "main.tex",
      ...(opts.doi ? { doi: opts.doi } : {}),
    },
    meta: { title: opts.title },
  };
}

function annotation(id: string, body: string): Annotation {
  return {
    id,
    target: {
      type: "text",
      block: "p-1",
      container: { type: "content" },
      start: 0,
      end: 5,
      quote: "Hello",
    },
    body,
    created_at: "2026-10-01T10:00:00.000Z",
    updated_at: "2026-10-01T10:00:00.000Z",
  };
}

/** Write a LaTeX Doc (IR + one image asset) and its annotations into a project. */
function writeLatexDoc(
  paths: LibraryPaths,
  docId: string,
  ir: TexDocIr,
  annotations: Annotation[],
  rev = 3
): string {
  const dir = join(paths.outputDir, docId);
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, `${docId}.json`), JSON.stringify(ir));
  writeFileSync(join(dir, "assets", "fig.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  // build products a Shelf entry never carries
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "main.tex"), "\\documentclass{article}");
  const fingerprint = docContentFingerprint(ir, { docDir: dir });
  if (annotations.length > 0)
    saveAnnotationsFile(paths.dataDir, docId, {
      version: 1,
      rev,
      content_fingerprint: fingerprint,
      annotations,
    });
  return fingerprint;
}

function filesOf(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, name.name);
      if (name.isDirectory()) walk(p);
      else out.push(relative(dir, p).split("\\").join("/"));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

/** Every file under a directory with its bytes (to prove "unchanged"). */
function tree(dir: string): Record<string, string> {
  return Object.fromEntries(
    filesOf(dir).map((p) => [p, readFileSync(join(dir, p)).toString("base64")])
  );
}

interface SourceDoc {
  docId: string;
  kind: ShelfDocKind;
  /** The annotations file to carry (whole), or null. */
  annotationsFile: string | null;
}

/** What an add puts on the Shelf (ticket 03's job; done here directly through the store). */
async function addToShelf(
  store: ShelfStore,
  source: LibraryPaths,
  bibliography: ShelfBibliography,
  docs: SourceDoc[],
  extra: { graph?: string | null; note?: string | null } = {}
) {
  const result = await store.put(
    {
      bibliography,
      source: { project: source.dataDir, workId: "doi:x" },
      docs: docs.map((d) => {
        const dir = join(source.outputDir, d.docId);
        return {
          docId: d.docId,
          kind: d.kind,
          files: filesOf(dir)
            .filter((p) => shelfDocFileAllowed(d.kind, d.docId, p))
            .map((p) => ({ path: p, bytes: readFileSync(join(dir, p)) })),
          annotations:
            d.annotationsFile === null
              ? null
              : (() => {
                  const bytes = readFileSync(d.annotationsFile);
                  return {
                    count: (JSON.parse(bytes.toString("utf8")) as { annotations: unknown[] })
                      .annotations.length,
                    bytes,
                  };
                })(),
        };
      }),
      argumentGraph: extra.graph ? readFileSync(extra.graph) : null,
      note: extra.note ?? null,
    },
    { mode: "new" }
  );
  if (!result.ok) throw new Error(`put failed: ${result.reason}`);
  return result.entry;
}

const GRAPH = (workId: string): ArgumentGraph => ({
  version: 1,
  rev: 0,
  work_id: workId,
  arguments: [
    {
      id: "a1",
      title: "Main claim",
      claim: "C",
      grounds: "G",
      warrant: "W",
      backing: "",
      qualifier: "",
      rebuttal: "",
      warrant_implicit: false,
      kind: "end",
      sources: [{ text: "§1", target: { doc_id: LATEX, anchor: "sec-1" } }],
    },
  ],
  edges: [],
});

// ---- the fixture: one source project with everything, a Shelf entry of it -----------------------------------

let shelfDir: string;
let store: ShelfStore;
let source: LibraryPaths;
let pdfDocId: string;
let pdfSha: string;
let textDocId: string;
let latexFingerprint: string;
const BIB: ShelfBibliography = {
  title: "A Shelf Paper",
  authors: ["Argelander", "Bessel"],
  year: 2024,
  doi: DOI,
  abstract: "The abstract.",
  journal: "A&A",
  bibcode: "2024A&A...1A",
};

beforeEach(() => {
  shelfDir = mkdtempSync(join(tmpdir(), "shelf-dir-"));
  store = createShelfStore({ dir: shelfDir, lockStaleMs: 2000 });
  source = newProject([
    { id: `doi:${DOI}`, title: BIB.title, doi: DOI, cite_key: "src2024", doc_ids: [LATEX] },
  ]);
  latexFingerprint = writeLatexDoc(source, LATEX, latexIr(LATEX, { title: BIB.title, doi: DOI }), [
    annotation("a_00000001", "first note"),
    annotation("a_00000002", "second note"),
  ]);
  const pdf = publishPdfDoc(source, {
    workId: `doi:${DOI}`,
    filename: "paper.pdf",
    bytes: syntheticPdf(),
    pages: PAGES,
  });
  pdfDocId = pdf.doc_id;
  pdfSha = pdf.sha256;
  // one PDF annotation in its sidecar
  const sidecar = join(source.outputDir, pdfDocId, "annotations.json");
  const file = JSON.parse(readFileSync(sidecar, "utf8")) as Record<string, unknown>;
  file.rev = 1;
  file.annotations = [
    {
      id: "p_one",
      kind: "document_comment",
      body: "a PDF note",
      created_at: "2026-10-01T10:00:00.000Z",
      updated_at: "2026-10-01T10:00:00.000Z",
    },
  ];
  writeFileSync(sidecar, `${JSON.stringify(file, null, 2)}\n`);
  textDocId = createTextDoc(source, {
    operationId: "op-1",
    workId: `doi:${DOI}`,
  }).docId;
  replaceArgumentGraph(source.dataDir, GRAPH(`doi:${DOI}`));
});

async function standardEntry() {
  return addToShelf(
    store,
    source,
    BIB,
    [
      {
        docId: LATEX,
        kind: "latex",
        annotationsFile: annotationsCurrentPath(source.dataDir, LATEX),
      },
      {
        docId: pdfDocId,
        kind: "pdf",
        annotationsFile: join(source.outputDir, pdfDocId, "annotations.json"),
      },
      { docId: textDocId, kind: "text", annotationsFile: null },
    ],
    { graph: argumentGraphPath(source.dataDir, `doi:${DOI}`), note: "shelf note" }
  );
}

function appFor(paths: LibraryPaths, docMutations?: DocMutationRegistry) {
  const collector = collectBroadcasts();
  const app = createApp({
    paths,
    statusDir: statusDirFor(paths.dataDir),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(paths.dataDir, "jobs") }),
    broadcast: collector.broadcast,
    shelf: store,
    ...(docMutations ? { docMutations } : {}),
  });
  return { app, messages: collector.messages };
}

const take = (app: Hono, entryId: string, body: unknown) =>
  app.request(`/api/shelf/entries/${entryId}/take`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const worksOf = (paths: LibraryPaths) =>
  (JSON.parse(readFileSync(paths.libraryJson, "utf8")) as { works: Record<string, unknown>[] })
    .works;

// ---- tests ----------------------------------------------------------------------------------------------------

describe("taking an entry into a project without that paper", () => {
  test("a new Work with every Doc; the annotations are the current ones, the PDF verifies, nothing archived", async () => {
    const entry = await standardEntry();
    const target = newProject([
      { id: "doi:10.9/other", title: "Other", cite_key: "argelander2024" },
    ]);
    const { app, messages } = appFor(target);

    const res = await take(app, entry.entryId, { rev: entry.rev });
    expect(res.status).toBe(200);
    const result = (await res.json()) as ShelfTakeResult;
    expect(result.work).toMatchObject({ id: `doi:${DOI}`, title: BIB.title, created: true });
    // the target project's cite key rule: the bibcode, as for any new Work with one
    expect(result.work.citeKey).toBe("2024A&A...1A");
    expect(result.docs.taken.map((d) => [d.docId, d.annotations])).toEqual([
      [LATEX, 2],
      [pdfDocId, 1],
      [textDocId, 0],
    ]);
    expect(result.docs.skipped).toEqual([]);
    expect(result.argumentGraph).toBe("written");
    expect(result.note).toBe("written");

    const work = worksOf(target).find((w) => w.id === `doi:${DOI}`) as Record<string, unknown>;
    expect(work.doc_ids).toEqual([LATEX, pdfDocId, textDocId]);
    expect(work.note).toBe("shelf note");
    expect(work.abstract).toBe("The abstract.");
    expect(work.tags).toBeUndefined();
    expect(work.origin).toBe("manual");

    // Doc bytes are the source's; build products were never carried
    expect(readFileSync(join(target.outputDir, LATEX, `${LATEX}.json`))).toEqual(
      readFileSync(join(source.outputDir, LATEX, `${LATEX}.json`))
    );
    expect(filesOf(join(target.outputDir, LATEX))).toEqual(["assets/fig.png", `${LATEX}.json`]);

    // Reader: the LaTeX annotations are current (same fingerprint and rev), no archive is made
    const ann = await app.request(`/api/paper/${LATEX}/annotations?coherent=1`);
    expect(ann.status).toBe(200);
    const coherent = (await ann.json()) as {
      file: { content_fingerprint: string; rev: number; annotations: Annotation[] };
    };
    expect(coherent.file.content_fingerprint).toBe(latexFingerprint);
    expect(coherent.file.rev).toBe(3);
    expect(coherent.file.annotations.map((a) => a.body)).toEqual(["first note", "second note"]);
    expect(existsSync(annotationsArchiveDir(target.dataDir, LATEX))).toBe(false);

    // PDF: the snapshot verifies the original, the annotation copy is there, the reading position is new
    const snap = await app.request(`/api/paper/${pdfDocId}/pdf/snapshot`);
    expect(snap.status).toBe(200);
    const snapshot = (await snap.json()) as {
      annotations: { rev: number; annotations: { id: string }[]; content_sha256: string };
      reading_position: { status: string; file: { rev: number; position: unknown } };
    };
    expect(snapshot.annotations.annotations.map((a) => a.id)).toEqual(["p_one"]);
    expect(snapshot.annotations.content_sha256).toBe(pdfSha);
    expect(snapshot.reading_position).toMatchObject({
      status: "ready",
      file: { rev: 0, position: null },
    });
    const original = await app.request(`/api/paper/${pdfDocId}/pdf`);
    expect(original.status).toBe(200);
    expect(Buffer.from(await original.arrayBuffer())).toEqual(syntheticPdf());

    // text Doc: its source opens
    expect((await app.request(`/api/paper/${textDocId}/source`)).status).toBe(200);

    // the graph names the new Work
    const graph = JSON.parse(
      readFileSync(argumentGraphPath(target.dataDir, `doi:${DOI}`), "utf8")
    ) as ArgumentGraph;
    expect(graph.work_id).toBe(`doi:${DOI}`);
    expect(graph.arguments.map((a) => a.title)).toEqual(["Main claim"]);

    expect(messages.some((m) => m.type === "library.changed")).toBe(true);
    expect(
      messages.some((m) => m.type === "argument-graph.changed" && m.work_id === `doi:${DOI}`)
    ).toBe(true);
    // no staging left behind
    expect(readdirSync(target.outputDir).filter((n) => n.startsWith("."))).toEqual([]);
  });

  test("the next library build makes no extra Work and keeps the Docs with the taken Work", async () => {
    const entry = await standardEntry();
    const target = newProject([{ id: "doi:10.9/other", title: "Other" }]);
    const { app } = appFor(target);
    expect((await take(app, entry.entryId, { rev: entry.rev })).status).toBe(200);
    const before = worksOf(target).length;
    await rebuild(target, { sources: stubSources() });
    const after = LibraryStore.load(target);
    expect(after.works.length).toBe(before);
    const holders = after.works.filter((w) => w.doc_ids.includes(LATEX)).map((w) => w.id);
    expect(holders).toEqual([`doi:${DOI}`]);
    expect(after.get(`doi:${DOI}`)?.doc_ids).toEqual([LATEX, pdfDocId, textDocId]);
  });

  test("annotations and the graph and the note can be left out", async () => {
    const entry = await standardEntry();
    const target = newProject([]);
    const { app } = appFor(target);
    const res = await take(app, entry.entryId, {
      rev: entry.rev,
      excludeAnnotations: { [LATEX]: ["a_00000001"], [pdfDocId]: "all" },
      argumentGraph: false,
      note: false,
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as ShelfTakeResult;
    expect(result.argumentGraph).toBe("not_chosen");
    expect(result.note).toBe("not_chosen");
    const current = JSON.parse(
      readFileSync(annotationsCurrentPath(target.dataDir, LATEX), "utf8")
    ) as { annotations: Annotation[]; content_fingerprint: string };
    expect(current.annotations.map((a) => a.id)).toEqual(["a_00000002"]);
    expect(current.content_fingerprint).toBe(latexFingerprint);
    // a PDF Doc without annotations still gets its sidecar: empty, rev 0, bound to the original
    const sidecar = JSON.parse(
      readFileSync(join(target.outputDir, pdfDocId, "annotations.json"), "utf8")
    ) as Record<string, unknown>;
    expect(sidecar).toEqual({
      version: 1,
      doc_id: pdfDocId,
      content_sha256: pdfSha,
      rev: 0,
      annotations: [],
    });
    expect((await app.request(`/api/paper/${pdfDocId}/pdf/snapshot`)).status).toBe(200);
    expect(existsSync(argumentGraphPath(target.dataDir, `doi:${DOI}`))).toBe(false);
    expect(worksOf(target)[0]?.note).toBeUndefined();
    // an unknown annotation id is refused, nothing written
    const other = newProject([]);
    const bad = await take(appFor(other).app, entry.entryId, {
      rev: entry.rev,
      excludeAnnotations: { [LATEX]: ["a_0000dead"] },
    });
    expect(bad.status).toBe(400);
    expect(filesOf(other.outputDir)).toEqual([]);
  });
});

describe("taking into a project that has the same paper", () => {
  test("merged: blank bibliography fields filled, project fields and the main Doc kept", async () => {
    const entry = await standardEntry();
    const target = newProject([
      {
        id: `doi:${DOI}`,
        title: "Local Title",
        doi: DOI,
        year: 2023,
        cite_key: "mykey",
        tags: ["t1"],
        star: true,
        read: true,
        label: "red",
        note: "local note",
        doc_ids: ["pdf-local"],
        custom_key: "kept",
      },
    ]);
    // the local main Doc
    mkdirSync(join(target.outputDir, "pdf-local"), { recursive: true });
    writeFileSync(join(target.outputDir, "pdf-local", "original.pdf"), "x");
    const { app } = appFor(target);
    const res = await take(app, entry.entryId, { rev: entry.rev });
    expect(res.status).toBe(200);
    const result = (await res.json()) as ShelfTakeResult;
    expect(result.work).toMatchObject({ id: `doi:${DOI}`, created: false, citeKey: "mykey" });
    expect(result.note).toBe("kept_local");
    const work = worksOf(target)[0] as Record<string, unknown>;
    expect(work).toMatchObject({
      title: "Local Title",
      year: 2023,
      cite_key: "mykey",
      tags: ["t1"],
      star: true,
      read: true,
      label: "red",
      note: "local note",
      custom_key: "kept",
      abstract: "The abstract.",
      authors: ["Argelander", "Bessel"],
      journal: "A&A",
      bibcode: "2024A&A...1A",
    });
    expect(work.doc_ids).toEqual(["pdf-local", LATEX, pdfDocId, textDocId]);
    expect(worksOf(target)).toHaveLength(1);
    expect(result.work.filled.sort()).toEqual(["abstract", "authors", "bibcode", "journal"]);
    expect(result.work.title).toBe("Local Title");
    expect(result.mainDoc).toEqual({ before: "pdf-local", after: "pdf-local", changed: false });
  });

  test("a merge fills a blank title, and the answer names the filled title", async () => {
    const entry = await standardEntry();
    const target = newProject([{ id: `doi:${DOI}`, doi: DOI, title: "" }]);
    const result = (await (
      await take(appFor(target).app, entry.entryId, { rev: entry.rev })
    ).json()) as ShelfTakeResult;
    expect(result.work.title).toBe(BIB.title);
    expect(result.work.filled).toContain("title");
    expect(result.mainDoc).toEqual({ before: null, after: LATEX, changed: true });
    expect(worksOf(target)[0]?.title).toBe(BIB.title);
  });

  test("several Works of the project being this paper is refused: merge them first", async () => {
    const entry = await addToShelf(store, source, { ...BIB, arxiv_id: "2401.01234" }, [
      { docId: textDocId, kind: "text", annotationsFile: null },
    ]);
    const target = newProject([
      { id: `doi:${DOI}`, title: "A", doi: DOI },
      { id: "arxiv:2401.01234", title: "B", arxiv_id: "2401.01234v2" },
    ]);
    const before = tree(target.dataDir);
    const res = await take(appFor(target).app, entry.entryId, { rev: entry.rev });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "multiple_works",
      workIds: [`doi:${DOI}`, "arxiv:2401.01234"],
    });
    expect(tree(target.dataDir)).toEqual(before);
  });

  test("a Work without Docs gets the entry's first Doc as its main Doc; an empty note is still not written", async () => {
    const entry = await standardEntry();
    const target = newProject([{ id: `doi:${DOI}`, title: BIB.title, doi: DOI }]);
    const { app } = appFor(target);
    const result = (await (
      await take(app, entry.entryId, { rev: entry.rev })
    ).json()) as ShelfTakeResult;
    expect(result.note).toBe("existing_work");
    expect(worksOf(target)[0]?.doc_ids).toEqual([LATEX, pdfDocId, textDocId]);
    expect(worksOf(target)[0]?.note).toBeUndefined();
    await rebuild(target, { sources: stubSources() });
    expect(LibraryStore.load(target).works.map((w) => w.id)).toEqual([`doi:${DOI}`]);
  });

  test("a LaTeX Doc whose own identity would seed elsewhere gets the Work's identity written in; nothing else changes", async () => {
    // the LaTeX IR has only a title, unlike the project's Work (merged by DOI)
    const lonely = newProject([]);
    const ir = latexIr("latex-title-only", { title: "Some Other Title" });
    (ir.source as Record<string, unknown>).acquired_via = "arxiv_eprint";
    const fingerprint = writeLatexDoc(lonely, "latex-title-only", ir, [
      annotation("a_00000003", "kept"),
    ]);
    const entry = await addToShelf(store, lonely, { ...BIB, doi: DOI }, [
      {
        docId: "latex-title-only",
        kind: "latex",
        annotationsFile: annotationsCurrentPath(lonely.dataDir, "latex-title-only"),
      },
    ]);
    const shelfBefore = tree(shelfDir);
    const target = newProject([{ id: `doi:${DOI}`, title: "Local Title", doi: DOI }]);
    const { app } = appFor(target);
    const result = (await (
      await take(app, entry.entryId, { rev: entry.rev })
    ).json()) as ShelfTakeResult;
    expect(result.docs.taken).toEqual([
      { docId: "latex-title-only", kind: "latex", annotations: 1, stamped: true },
    ]);
    expect(result.docs.skipped).toEqual([]);
    // only source/meta changed: the DOI written in, the sections as they were
    const stored = JSON.parse(
      readFileSync(join(target.outputDir, "latex-title-only", "latex-title-only.json"), "utf8")
    ) as TexDocIr & { source: Record<string, unknown> };
    // the provenance stays what it was (the Doc's Work detail keeps its arXiv / upload label)
    expect(stored.source).toMatchObject({ doi: DOI, acquired_via: "arxiv_eprint" });
    expect(stored.meta.title).toBe("Some Other Title");
    expect(stored.sections).toEqual(ir.sections);
    expect(stored.docId).toBe(ir.docId);
    // the Shelf entry is not changed
    expect(tree(shelfDir)).toEqual(shelfBefore);
    // the annotations are current, nothing archived
    const ann = (await (await app.request("/api/paper/latex-title-only/annotations")).json()) as {
      content_fingerprint: string;
      annotations: Annotation[];
    };
    expect(ann.content_fingerprint).toBe(fingerprint);
    expect(ann.annotations.map((a) => a.body)).toEqual(["kept"]);
    expect(existsSync(annotationsArchiveDir(target.dataDir, "latex-title-only"))).toBe(false);
    // the next build keeps it with that Work and makes no other
    await rebuild(target, { sources: stubSources() });
    const works = LibraryStore.load(target).works;
    expect(works.map((w) => [w.id, w.doc_ids])).toEqual([[`doi:${DOI}`, ["latex-title-only"]]]);
  });

  test("a Doc whose title would fold another local Work into the target is skipped, not folded", async () => {
    // The project has an unrelated Work with the IR's title (no identifiers); the build would bridge it into the
    // taken Work through that title even after the DOI is written in.
    const entry = await addToShelf(store, source, BIB, [
      { docId: LATEX, kind: "latex", annotationsFile: null },
    ]);
    const target = newProject([{ id: "work:a-shelf-paper", title: BIB.title }]);
    const { app } = appFor(target);
    const result = (await (
      await take(app, entry.entryId, { rev: entry.rev })
    ).json()) as ShelfTakeResult;
    expect(result.docs.skipped).toEqual([
      { docId: LATEX, kind: "latex", reason: "seed_conflict", wouldJoin: "work:a-shelf-paper" },
    ]);
    expect(existsSync(join(target.outputDir, LATEX))).toBe(false);
    await rebuild(target, { sources: stubSources() });
    expect(
      LibraryStore.load(target)
        .works.map((w) => w.id)
        .sort()
    ).toEqual([`doi:${DOI}`, "work:a-shelf-paper"]);
  });

  test("a Doc whose id the project has is skipped with its annotations; the local bytes stay", async () => {
    const entry = await standardEntry();
    const target = newProject([{ id: "doi:10.9/local", title: "Local", doc_ids: [LATEX] }]);
    writeLatexDoc(
      target,
      LATEX,
      latexIr(LATEX, { title: "Local", text: "Local text" }),
      [annotation("a_0000000c", "local annotation")],
      7
    );
    const before = {
      output: tree(join(target.outputDir, LATEX)),
      ann: tree(join(target.dataDir, "annotations")),
    };
    const { app } = appFor(target);
    const res = await take(app, entry.entryId, { rev: entry.rev });
    expect(res.status).toBe(200);
    const result = (await res.json()) as ShelfTakeResult;
    expect(result.docs.skipped).toEqual([{ docId: LATEX, kind: "latex", reason: "exists" }]);
    expect(result.docs.taken.map((d) => d.docId)).toEqual([pdfDocId, textDocId]);
    expect(tree(join(target.outputDir, LATEX))).toEqual(before.output);
    expect(tree(join(target.dataDir, "annotations"))).toEqual(before.ann);
    // the local Work keeps the Doc; the new Work does not list it
    expect(worksOf(target).find((w) => w.id === `doi:${DOI}`)?.doc_ids).toEqual([
      pdfDocId,
      textDocId,
    ]);
  });

  test("a non-empty argument graph of the Work is kept; an empty one is written over", async () => {
    const entry = await standardEntry();
    const target = newProject([{ id: `doi:${DOI}`, title: BIB.title, doi: DOI }]);
    const local: ArgumentGraph = {
      ...GRAPH(`doi:${DOI}`),
      arguments: [
        {
          ...(GRAPH("x").arguments[0] as ArgumentGraph["arguments"][number]),
          title: "Local claim",
        },
      ],
    };
    replaceArgumentGraph(target.dataDir, local);
    const file = argumentGraphPath(target.dataDir, `doi:${DOI}`);
    const bytes = readFileSync(file);
    const { app } = appFor(target);
    const result = (await (
      await take(app, entry.entryId, { rev: entry.rev })
    ).json()) as ShelfTakeResult;
    expect(result.argumentGraph).toBe("kept_local");
    expect(readFileSync(file)).toEqual(bytes);

    const second = newProject([{ id: `doi:${DOI}`, title: BIB.title, doi: DOI }]);
    replaceArgumentGraph(second.dataDir, { ...GRAPH(`doi:${DOI}`), arguments: [] });
    replaceArgumentGraph(second.dataDir, { ...GRAPH(`doi:${DOI}`), arguments: [], rev: 1 });
    const r2 = (await (
      await take(appFor(second).app, entry.entryId, { rev: entry.rev })
    ).json()) as ShelfTakeResult;
    expect(r2.argumentGraph).toBe("written");
    const written = JSON.parse(
      readFileSync(argumentGraphPath(second.dataDir, `doi:${DOI}`), "utf8")
    ) as ArgumentGraph;
    expect(written.rev).toBe(3);
    expect(written.arguments).toHaveLength(1);
  });
});

describe("refusals", () => {
  test("a failure while writing removes everything the take added", async () => {
    if (process.getuid?.() === 0) return; // permissions do not stop root
    const entry = await standardEntry();
    const target = newProject([{ id: "doi:10.9/other", title: "Other" }]);
    const before = tree(target.dataDir);
    const { app, messages } = appFor(target);
    chmodSync(target.libraryDir, 0o500);
    try {
      const res = await take(app, entry.entryId, { rev: entry.rev });
      expect(res.status).toBe(500);
      expect(((await res.json()) as { code: string }).code).toBe("write_failed");
    } finally {
      chmodSync(target.libraryDir, 0o700);
    }
    expect(tree(target.dataDir)).toEqual(before);
    // nothing new beside the job runner's own folder: no annotations/, no argument-graphs/
    expect(
      readdirSync(target.dataDir)
        .filter((n) => n !== "jobs")
        .sort()
    ).toEqual(["library", "output"]);
    expect(readdirSync(target.outputDir)).toEqual([]);
    expect(messages.filter((m) => m.type === "library.changed")).toEqual([]);
  });

  test("annotations whose fingerprint is not the copied Doc's are refused; leaving them out lets the take through", async () => {
    const stale = join(mkdtempSync(join(tmpdir(), "shelf-stale-")), "current.json");
    writeFileSync(
      stale,
      JSON.stringify({
        version: 1,
        rev: 0,
        content_fingerprint: "0".repeat(64),
        annotations: [annotation("a_0000000f", "x")],
      })
    );
    const entry = await addToShelf(store, source, BIB, [
      { docId: LATEX, kind: "latex", annotationsFile: stale },
    ]);
    const target = newProject([]);
    const before = tree(target.dataDir);
    const { app } = appFor(target);
    const res = await take(app, entry.entryId, { rev: entry.rev });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      code: "entry_invalid",
      docId: LATEX,
      part: "annotations",
      problem: "stale",
    });
    expect(tree(target.dataDir)).toEqual(before);
    const ok = await take(app, entry.entryId, {
      rev: entry.rev,
      excludeAnnotations: { [LATEX]: "all" },
    });
    expect(ok.status).toBe(200);
    expect(existsSync(annotationsCurrentPath(target.dataDir, LATEX))).toBe(false);
  });

  test("an entry of a future format is listed as needing an update and never taken or rewritten", async () => {
    const id = "f".repeat(32);
    const dir = join(shelfDir, "entries", `${id}.r1`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "entry.json"),
      JSON.stringify({
        format: 2,
        entry_id: id,
        rev: 1,
        bibliography: { title: "From the future" },
      })
    );
    const before = tree(shelfDir);
    const target = newProject([]);
    const { app } = appFor(target);
    const list = (await (await app.request("/api/shelf")).json()) as { entries: unknown[] };
    expect(list.entries).toEqual([
      expect.objectContaining({
        status: "incompatible",
        entryId: id,
        needsUpdate: true,
        title: "From the future",
        format: 2,
      }),
    ]);
    const res = await take(app, id, { rev: 1 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "incompatible", needsUpdate: true });
    expect(tree(shelfDir)).toEqual(before);
    expect(filesOf(target.outputDir)).toEqual([]);
  });

  test("a replaced entry, a missing one, a busy Doc and a bad body are refused without writing", async () => {
    const entry = await standardEntry();
    const replaced = await store.put(
      {
        bibliography: BIB,
        source: { project: source.dataDir, workId: "doi:x" },
        docs: [],
        argumentGraph: null,
        note: null,
      },
      { mode: "replace", targets: [{ entryId: entry.entryId, rev: entry.rev }] }
    );
    expect(replaced.ok).toBe(true);
    const target = newProject([]);
    const registry = new DocMutationRegistry();
    const { app } = appFor(target, registry);
    const stale = await take(app, entry.entryId, { rev: entry.rev });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "changed", currentRev: 2 });
    expect((await take(app, "0".repeat(32), { rev: 1 })).status).toBe(404);
    expect((await take(app, entry.entryId, { nope: true })).status).toBe(400);
    expect((await take(app, "not-an-id", { rev: 1 })).status).toBe(400);

    const busyEntry = await addToShelf(store, source, { ...BIB, doi: "10.1234/another" }, [
      { docId: LATEX, kind: "latex", annotationsFile: null },
    ]);
    registry.pinWriter(LATEX);
    const busy = await take(app, busyEntry.entryId, { rev: busyEntry.rev });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ code: "busy", docId: LATEX });
    expect(filesOf(target.outputDir)).toEqual([]);
    expect(worksOf(target)).toEqual([]);
  });
});

describe("read-only queries", () => {
  test("list, summary and lookup give sizes, kinds and counts, never annotation bodies or the note", async () => {
    const entry = await standardEntry();
    // a damaged entry next to it
    const broken = join(shelfDir, "entries", `${"e".repeat(32)}.r1`);
    mkdirSync(broken, { recursive: true });
    const target = newProject([]);
    const { app } = appFor(target);

    const listRes = await app.request("/api/shelf");
    expect(listRes.status).toBe(200);
    const listText = await listRes.text();
    expect(listText).not.toContain("first note");
    expect(listText).not.toContain("shelf note");
    const list = JSON.parse(listText) as { entries: Record<string, unknown>[] };
    const ok = list.entries.find((e) => e.status === "ok") as Record<string, unknown>;
    expect(ok).toMatchObject({
      entryId: entry.entryId,
      rev: 1,
      title: BIB.title,
      annotations: 3,
      argumentGraph: true,
      note: true,
      identity: { doi: DOI, arxiv: null, openalex: null },
    });
    expect(
      (ok.docs as { kind: string; annotations: number | null }[]).map((d) => [
        d.kind,
        d.annotations,
      ])
    ).toEqual([
      ["latex", 2],
      ["pdf", 1],
      ["text", null],
    ]);
    expect(ok.bytes).toBe(entry.bytes);
    expect(list.entries.find((e) => e.status === "damaged")).toMatchObject({
      problem: "manifest_missing",
    });

    const sumRes = await app.request(`/api/shelf/entries/${entry.entryId}`);
    expect(sumRes.status).toBe(200);
    const sumText = await sumRes.text();
    expect(sumText).not.toContain("second note");
    expect(JSON.parse(sumText)).toMatchObject({
      status: "ok",
      bibliography: { abstract: "The abstract." },
      docs: [{ docId: LATEX }, { docId: pdfDocId }, { docId: textDocId }],
    });
    expect((await app.request(`/api/shelf/entries/${"0".repeat(32)}`)).status).toBe(404);
    expect((await app.request(`/api/shelf/entries/${"e".repeat(32)}`)).status).toBe(200);

    const look = (await (
      await app.request(
        `/api/shelf/lookup?doi=${encodeURIComponent(`https://doi.org/${DOI.toUpperCase()}`)}`
      )
    ).json()) as {
      entries: { entryId: string; matchedOn: string[] }[];
    };
    expect(look.entries).toEqual([
      expect.objectContaining({ entryId: entry.entryId, matchedOn: ["doi"], title: BIB.title }),
    ]);
    expect((await app.request("/api/shelf/lookup")).status).toBe(400);
    // reading the Shelf writes nothing to the project
    expect(filesOf(target.dataDir)).toEqual(["library/library.json"]);
  });

  test("an unreadable Shelf answers 500, not an empty list", async () => {
    if (process.getuid?.() === 0) return;
    await standardEntry();
    const target = newProject([]);
    const { app } = appFor(target);
    chmodSync(join(shelfDir, "entries"), 0o000);
    try {
      const res = await app.request("/api/shelf");
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ code: "shelf_unreadable" });
    } finally {
      chmodSync(join(shelfDir, "entries"), 0o700);
    }
  });
});

describe("preview and plan", () => {
  const preview = (app: Hono, entryId: string, body: unknown) =>
    app.request(`/api/shelf/entries/${entryId}/take/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  test("the preview writes nothing and is what the take then does; a stale digest is refused", async () => {
    const entry = await standardEntry();
    const target = newProject([{ id: "doi:10.9/other", title: "Other", cite_key: "x" }]);
    const before = tree(target.dataDir);
    const { app, messages } = appFor(target);
    const res = await preview(app, entry.entryId, { rev: entry.rev });
    expect(res.status).toBe(200);
    const { plan, planDigest } = (await res.json()) as ShelfTakePreview;
    expect(plan.work).toMatchObject({ id: `doi:${DOI}`, created: true });
    expect(plan.docs.taken.map((d) => d.docId)).toEqual([LATEX, pdfDocId, textDocId]);
    expect(tree(target.dataDir)).toEqual(before);
    expect(messages).toEqual([]);

    // the project changes after the preview: the take bound to it is refused, nothing written
    writeFileSync(
      target.libraryJson,
      JSON.stringify({
        version: 1,
        works: [
          { id: "doi:10.9/other", title: "Other", cite_key: "x" },
          { id: "doi:10.9/new", title: "New", doc_ids: [LATEX] },
        ],
      })
    );
    const changedBefore = tree(target.dataDir);
    const stale = await take(app, entry.entryId, { rev: entry.rev, planDigest });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as {
      code: string;
      plan: ShelfTakeResult;
      planDigest: string;
    };
    expect(body.code).toBe("plan_changed");
    expect(body.plan.docs.skipped).toEqual([{ docId: LATEX, kind: "latex", reason: "linked" }]);
    expect(tree(target.dataDir)).toEqual(changedBefore);

    // with the new digest it goes through, and does what the plan said
    const done = await take(app, entry.entryId, { rev: entry.rev, planDigest: body.planDigest });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual(body.plan);
  });

  test("a take that writes nothing sends no library.changed", async () => {
    const entry = await addToShelf(store, source, BIB, [
      { docId: LATEX, kind: "latex", annotationsFile: null },
    ]);
    const target = newProject([{ id: `doi:${DOI}`, ...BIB, doc_ids: [LATEX] }]);
    mkdirSync(join(target.outputDir, LATEX), { recursive: true });
    const before = tree(target.dataDir);
    const { app, messages } = appFor(target);
    const result = (await (
      await take(app, entry.entryId, { rev: entry.rev })
    ).json()) as ShelfTakeResult;
    expect(result.docs.skipped).toEqual([{ docId: LATEX, kind: "latex", reason: "exists" }]);
    expect(result.work.filled).toEqual([]);
    expect(tree(target.dataDir)).toEqual(before);
    expect(messages.filter((m) => m.type === "library.changed")).toEqual([]);
  });

  test("a skipped Doc's annotations are not checked; an IR naming another Doc is refused", async () => {
    const broken = join(mkdtempSync(join(tmpdir(), "shelf-broken-")), "current.json");
    writeFileSync(
      broken,
      JSON.stringify({
        version: 1,
        rev: 0,
        content_fingerprint: "x",
        annotations: [{ id: "a_bad" }],
      })
    );
    const entry = await addToShelf(
      store,
      source,
      BIB,
      [
        { docId: LATEX, kind: "latex", annotationsFile: null },
        { docId: textDocId, kind: "text", annotationsFile: null },
      ],
      {}
    );
    // the broken copy goes in through the store directly (its count is what the store checks)
    const withBroken = await store.put(
      {
        bibliography: { ...BIB, doi: "10.1234/broken" },
        source: { project: source.dataDir, workId: "doi:x" },
        docs: [
          {
            docId: LATEX,
            kind: "latex",
            files: filesOf(join(source.outputDir, LATEX))
              .filter((p) => shelfDocFileAllowed("latex", LATEX, p))
              .map((p) => ({ path: p, bytes: readFileSync(join(source.outputDir, LATEX, p)) })),
            annotations: { count: 1, bytes: readFileSync(broken) },
          },
        ],
        argumentGraph: null,
        note: null,
      },
      { mode: "new" }
    );
    expect(entry.rev).toBe(1);
    if (!withBroken.ok) throw new Error(withBroken.reason);
    const local = newProject([{ id: "doi:10.9/l", title: "L", doc_ids: [LATEX] }]);
    mkdirSync(join(local.outputDir, LATEX), { recursive: true });
    const ok = await take(appFor(local).app, withBroken.entry.entryId, { rev: 1 });
    expect(ok.status).toBe(200);
    // the same entry into a project without that Doc: now its broken annotations matter
    const bad = await take(appFor(newProject([])).app, withBroken.entry.entryId, { rev: 1 });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({
      code: "entry_invalid",
      docId: LATEX,
      part: "annotations",
    });

    const other = newProject([]);
    writeLatexDoc(
      other,
      "latex-wrong-id",
      latexIr("latex-someone-else", { title: "X", doi: "10.5/x" }),
      []
    );
    const wrong = await addToShelf(store, other, { ...BIB, doi: "10.5/x" }, [
      { docId: "latex-wrong-id", kind: "latex", annotationsFile: null },
    ]);
    const res = await take(appFor(newProject([])).app, wrong.entryId, { rev: wrong.rev });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      code: "entry_invalid",
      docId: "latex-wrong-id",
      problem: "ir_doc_id",
    });
  });

  test("a Doc named like an Object property is taken like any other; old staging leftovers are cleared", async () => {
    const other = newProject([]);
    writeLatexDoc(other, "constructor", latexIr("constructor", { title: "C", doi: "10.5/c" }), []);
    const entry = await addToShelf(store, other, { ...BIB, title: "C", doi: "10.5/c" }, [
      { docId: "constructor", kind: "latex", annotationsFile: null },
    ]);
    const target = newProject([]);
    mkdirSync(join(target.outputDir, ".shelf-take-left-by-a-crash"), { recursive: true });
    const res = await take(appFor(target).app, entry.entryId, { rev: entry.rev });
    expect(res.status).toBe(200);
    expect(readdirSync(target.outputDir)).toEqual(["constructor"]);
  });
});

describe("rollback at each step", () => {
  for (const failAt of ["place_doc", "place_annotations"] as const) {
    test(`a failure at ${failAt} leaves the project byte for byte as it was`, async () => {
      const entry = await standardEntry();
      const target = newProject([{ id: "doi:10.9/other", title: "Other" }]);
      const before = tree(target.dataDir);
      let seen = 0;
      const shelfTake = createShelfTake({
        paths: target,
        store: () => store,
        libraryLock: new AsyncLock(),
        argumentGraphLock: new AsyncLock(),
        docMutations: new DocMutationRegistry(),
        libraryChanged: () => {
          throw new Error("no broadcast expected");
        },
        argumentGraphChanged: () => {
          throw new Error("no broadcast expected");
        },
        hooks: {
          beforeStep: (step) => {
            // place_doc: fail at the second Doc (the first is in place); place_annotations: at the LaTeX Doc's file
            if (step === failAt && ++seen === (failAt === "place_doc" ? 2 : 1))
              throw Object.assign(new Error("injected"), { code: "EIO" });
          },
        },
      });
      const outcome = await shelfTake.take(entry.entryId, { rev: entry.rev });
      expect(outcome).toMatchObject({
        ok: false,
        status: 500,
        body: { code: "write_failed", cleanedUp: true },
      });
      expect(tree(target.dataDir)).toEqual(before);
      expect(readdirSync(target.dataDir).sort()).toEqual(["library", "output"]);
      expect(readdirSync(target.outputDir)).toEqual([]);
    });
  }
});

describe("the annotation list", () => {
  test("each annotation with its place, snippet and body, Doc by Doc", async () => {
    const entry = await standardEntry();
    const { app } = appFor(newProject([]));
    const res = await app.request(`/api/shelf/entries/${entry.entryId}/annotations`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as ShelfAnnotationsResponse;
    expect(list.rev).toBe(entry.rev);
    expect(list.docs.map((d) => [d.docId, d.annotations.length])).toEqual([
      [LATEX, 2],
      [pdfDocId, 1],
      [textDocId, 0],
    ]);
    expect(list.docs[0]?.annotations[0]).toMatchObject({
      id: "a_00000001",
      kind: "text",
      location: { sectionPath: "1 Introduction", number: null, pageIndex: null },
      snippet: "Hello",
      body: "first note",
    });
    expect(list.docs[1]?.annotations[0]).toMatchObject({
      id: "p_one",
      kind: "document_comment",
      location: { pageIndex: null },
      body: "a PDF note",
    });
  });

  test("the summary reads the manifest only; a damaged file shows at the take", async () => {
    const entry = await standardEntry();
    const file = join(
      shelfDir,
      "entries",
      `${entry.entryId}.r${entry.rev}`,
      "docs",
      LATEX,
      "assets",
      "fig.png"
    );
    writeFileSync(file, "tampered");
    const { app } = appFor(newProject([]));
    const summary = await app.request(`/api/shelf/entries/${entry.entryId}`);
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({ status: "ok", entryId: entry.entryId });
    const res = await take(app, entry.entryId, { rev: entry.rev });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "damaged" });
  });
});
