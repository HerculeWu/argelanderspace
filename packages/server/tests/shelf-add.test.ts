/**
 * Adding to the Shelf (shelf ticket 03): `POST /api/shelf/entries` (add; replace after the confirmation handshake)
 * and `DELETE /api/shelf/entries/:entryId?rev=` (contracts「文献仓」, docs/library.md「文献仓」).
 *
 * Hermetic: a throwaway project data dir, the Shelf store pointed at a throwaway directory (never the global data
 * directory), Hono `app.request`. Every test that must leave the project alone compares a byte digest of the whole
 * dataDir before and after; every refusal also checks that the Shelf has no entry.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type {
  AnnotationsFile,
  ShelfAddPreviewResponse,
  ShelfAddResponse,
  ShelfReplaceImpact,
  TexDocIr,
  WsServerMessage,
} from "@argelanderspace/contracts";
import {
  annotationsCurrentPath,
  argumentGraphPath,
  emptyWork,
  type LibraryPaths,
  LibraryStore,
  libraryPaths,
  publishPdfDoc,
} from "@argelanderspace/core";
import { createShelfStore, type ShelfStore } from "@argelanderspace/infra";
import type { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { createAnnotationAccess } from "../src/annotations-access.js";
import { createApp } from "../src/app.js";
import { statusDirFor } from "../src/deps.js";
import { DocMutationRegistry } from "../src/doc-mutations.js";
import { JobRunner } from "../src/jobs.js";
import { AsyncLock } from "../src/lock.js";
import { createShelfWriter } from "../src/shelf-add.js";
import { collectBroadcasts, makeDataDir, stubPipelines, stubSources } from "./helpers.js";
import { syntheticPdf } from "./pdf-fixture.js";

const W_A = "doi:10.1234/shelf-a";
const W_PLAIN = "work:no-identifiers-2020";
const LATEX = "paper-a";

let dataDir: string;
let paths: LibraryPaths;
let shelfDir: string;
let shelf: ShelfStore;
let app: Hono;
let messages: WsServerMessage[];
let docMutations: DocMutationRegistry;
let pdfDoc: string;

function mkIr(paragraph = "Hello world", imgPath?: string): TexDocIr {
  return {
    version: 1,
    docId: LATEX,
    sections: [
      {
        id: "sec-1",
        level: 1,
        number: "1",
        heading: "Introduction",
        blocks: [
          { id: "p-1", type: "paragraph", segments: [{ type: "text", text: paragraph }] },
          ...(imgPath ? [{ id: "fig-1", type: "figure" as const, imgPath, caption: [] }] : []),
        ],
        children: [],
      },
    ],
    refsManifest: [],
    bib: [],
    citationsByBlock: {},
    source: { type: "latex", origin: "/tmp/src", main_tex: "main.tex" },
    meta: { title: "Paper A" },
  } as TexDocIr;
}

const latexDir = () => join(dataDir, "output", LATEX);
const writeIr = (ir: TexDocIr) =>
  writeFileSync(join(latexDir(), `${LATEX}.json`), JSON.stringify(ir));

function makeApp(store: ShelfStore = shelf): Hono {
  return createApp({
    paths,
    statusDir: statusDirFor(dataDir),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(dataDir, "jobs") }),
    broadcast: (m) => messages.push(m),
    docMutations,
    shelf: store,
  });
}

beforeEach(() => {
  dataDir = makeDataDir();
  paths = libraryPaths(dataDir);
  shelfDir = join(mkdtempSync(join(tmpdir(), "aspace-shelf-")), "shelf");
  shelf = createShelfStore({ dir: shelfDir });
  messages = collectBroadcasts().messages;
  docMutations = new DocMutationRegistry();

  // The LaTeX Doc: its reading text and assets, plus src/ and build/ that the Shelf leaves out.
  mkdirSync(join(latexDir(), "assets"), { recursive: true });
  mkdirSync(join(latexDir(), "src"), { recursive: true });
  mkdirSync(join(latexDir(), "build"), { recursive: true });
  writeIr(mkIr());
  writeFileSync(join(latexDir(), "assets", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(latexDir(), "src", "main.tex"), "\\documentclass{article}");
  writeFileSync(join(latexDir(), "build", "main.aux"), "aux");

  const a = emptyWork(W_A);
  Object.assign(a, {
    title: "Shelf Paper A",
    authors: ["Doe", "Roe"],
    year: 2021,
    doi: "10.1234/shelf-a",
    cite_key: "doe2021",
    tags: ["mine"],
    star: true,
    read: true,
    label: "red",
    note: "a note of this project",
    origin: "manual",
    added_at: "2026-01-01T00:00:00Z",
    doc_ids: [LATEX],
  });
  const plain = emptyWork(W_PLAIN);
  Object.assign(plain, { title: "No identifiers", year: 2020 });
  new LibraryStore([a, plain]).save(paths);

  pdfDoc = publishPdfDoc(paths, {
    workId: W_A,
    bytes: syntheticPdf(),
    filename: "a.pdf",
    pages: [
      { width: 360, height: 480, rotation: 0 },
      { width: 400, height: 240, rotation: 90 },
      { width: 280, height: 280, rotation: 0 },
    ],
  }).doc_id;
  // Two PDF annotations, one with a key the application does not know.
  const sidecar = join(paths.outputDir, pdfDoc, "annotations.json");
  const file = JSON.parse(readFileSync(sidecar, "utf8")) as Record<string, unknown>;
  const at = "2026-09-24T12:00:00.000Z";
  file.annotations = [
    {
      id: "p-keep",
      kind: "document_comment",
      body: "keep",
      created_at: at,
      updated_at: at,
      extra: 1,
    },
    {
      id: "p-drop",
      kind: "page_comment",
      page_index: 0,
      body: "drop",
      created_at: at,
      updated_at: at,
    },
  ];
  writeFileSync(sidecar, `${JSON.stringify(file, null, 2)}\n`);

  app = makeApp();
});

const call = (method: string, path: string, body?: unknown, target: Hono = app) =>
  target.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const add = (body: unknown, target: Hono = app) => call("POST", "/api/shelf/entries", body, target);

const ANNOTATION = (id: string) => ({
  id,
  target: {
    type: "text" as const,
    block: "p-1",
    container: { type: "content" as const },
    start: 0,
    end: 5,
    quote: "Hello",
  },
  body: `note ${id}`,
  created_at: "2026-09-10T10:00:00.000Z",
  updated_at: "2026-09-10T10:00:00.000Z",
});

/** Two annotations on the LaTeX Doc through the page's own PUT. */
async function annotateLatex(): Promise<AnnotationsFile> {
  const current = (await (
    await call("GET", `/api/paper/${LATEX}/annotations`)
  ).json()) as AnnotationsFile;
  const res = await call("PUT", `/api/paper/${LATEX}/annotations`, {
    ...current,
    annotations: [ANNOTATION("a_0123abcd"), ANNOTATION("a_4567cdef")],
  });
  expect(res.status).toBe(200);
  return (await res.json()) as AnnotationsFile;
}

/** path → sha256 of every file under the dataDir, and every directory. */
function digest(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const rel = relative(root, p);
      if (statSync(p).isDirectory()) {
        out[`${rel}/`] = "dir";
        walk(p);
      } else out[rel] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(root);
  return out;
}

const shelfEntries = () =>
  existsSync(join(shelfDir, "entries")) ? readdirSync(join(shelfDir, "entries")) : [];
const shelfChanged = () => messages.filter((m) => m.type === "shelf.changed");
const archiveOf = (docId: string) => {
  const dir = join(dataDir, "annotations", docId, "archive");
  return existsSync(dir) ? readdirSync(dir) : [];
};

const body = (over: Record<string, unknown> = {}) => ({
  workId: W_A,
  docs: [
    { docId: LATEX, annotationIds: [] },
    { docId: pdfDoc, annotationIds: [] },
  ],
  argumentGraph: false,
  note: false,
  ...over,
});

async function readEntry(entryId: string) {
  const read = await shelf.read(entryId);
  if (read.status !== "ok") throw new Error(`entry ${entryId}: ${read.status}`);
  return read;
}

async function textDoc(): Promise<string> {
  const created = await call("POST", "/api/library/text-docs", {
    workId: W_A,
    operationId: `op-${Math.random().toString(16).slice(2)}`,
  });
  expect(created.status).toBe(201);
  return ((await created.json()) as { description: { doc_id: string } }).description.doc_id;
}

describe("adding a Work", () => {
  test("copies the chosen Docs byte for byte, only the chosen annotations, the graph and the note; the project is untouched", async () => {
    await annotateLatex();
    const graph = await call("PUT", `/api/works/${encodeURIComponent(W_A)}/argument-graph`, {
      version: 1,
      rev: 0,
      work_id: W_A,
      arguments: [{ id: "arg-1", title: "Main claim" }],
      edges: [],
    });
    expect(graph.status).toBe(200);
    // The text Doc: generated, annotated, and a draft that was never generated.
    const text = await textDoc();
    expect(
      (
        await call("PUT", `/api/paper/${text}/source`, {
          expectedRev: 0,
          markdown: "# T\n\nFirst para.\n",
        })
      ).status
    ).toBe(200);
    expect(
      (
        await call("POST", `/api/paper/${text}/source/generate`, {
          sourceRev: 1,
          operationId: `gen-${Math.random().toString(16).slice(2)}`,
        })
      ).status
    ).toBe(200);
    const draft = await textDoc();
    const before = digest(dataDir);

    const res = await add(
      body({
        docs: [
          { docId: draft, annotationIds: [] },
          { docId: pdfDoc, annotationIds: ["p-keep"] },
          { docId: LATEX, annotationIds: ["a_0123abcd"] },
          { docId: text, annotationIds: [] },
        ],
        argumentGraph: true,
        note: true,
      })
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as ShelfAddResponse;
    expect(out.replaced).toEqual([]);
    expect(out.notCarried).toEqual([]);
    expect(out.archived).toEqual([]);
    expect(out.carried).toEqual({
      docs: [
        { docId: LATEX, kind: "latex", annotations: 1 },
        { docId: pdfDoc, kind: "pdf", annotations: 1 },
        { docId: text, kind: "text", annotations: 0 },
        { docId: draft, kind: "text", annotations: 0 },
      ],
      argumentGraph: true,
      note: true,
    });
    expect(digest(dataDir)).toEqual(before);

    const entry = await readEntry(out.entry.entryId);
    expect(entry.entry.rev).toBe(1);
    const m = entry.entry.manifest;
    // The Work's order (its main Doc first), whatever order the request named them in.
    expect(m.docs.map((d) => d.doc_id)).toEqual([LATEX, pdfDoc, text, draft]);
    expect(m.identity).toEqual({ doi: "10.1234/shelf-a", arxiv: null, openalex: null });
    expect(m.bibliography).toMatchObject({
      title: "Shelf Paper A",
      authors: ["Doe", "Roe"],
      year: 2021,
    });
    for (const key of [
      "id",
      "doc_ids",
      "cite_key",
      "tags",
      "label",
      "read",
      "star",
      "note",
      "added_at",
      "origin",
      "acquisition",
    ])
      expect(m.bibliography).not.toHaveProperty(key);
    expect(m.source).toEqual({ project: process.cwd(), work_id: W_A });
    expect(entry.note).toBe("a note of this project");
    expect(entry.argumentGraph?.equals(readFileSync(argumentGraphPath(dataDir, W_A)))).toBe(true);

    const files = (docId: string) =>
      Object.fromEntries(
        (entry.docs.find((d) => d.docId === docId)?.files ?? []).map((f) => [f.path, f.bytes])
      );
    // LaTeX: the reading text and assets/, never src/ or build/; bytes as in the project.
    const latex = files(LATEX);
    expect(Object.keys(latex).sort()).toEqual(["assets/logo.png", `${LATEX}.json`].sort());
    expect(latex[`${LATEX}.json`]?.equals(readFileSync(join(latexDir(), `${LATEX}.json`)))).toBe(
      true
    );
    // PDF: metadata and the original; no reading position, the sidecar only as the annotation copy.
    const pdf = files(pdfDoc);
    expect(Object.keys(pdf).sort()).toEqual([`${pdfDoc}.json`, "original.pdf"].sort());
    expect(
      pdf["original.pdf"]?.equals(readFileSync(join(paths.outputDir, pdfDoc, "original.pdf")))
    ).toBe(true);
    // Text: the source, the generated reading text; the draft has its source only.
    expect(Object.keys(files(text)).sort()).toEqual([`${text}.json`, "text-source.json"].sort());
    expect(Object.keys(files(draft))).toEqual(["text-source.json"]);

    // Only the chosen annotations, every key of them as stored.
    const latexCopy = JSON.parse(
      entry.docs.find((d) => d.docId === LATEX)?.annotations?.bytes.toString("utf8") ?? "null"
    ) as AnnotationsFile;
    const stored = JSON.parse(
      readFileSync(annotationsCurrentPath(dataDir, LATEX), "utf8")
    ) as AnnotationsFile;
    expect(latexCopy.annotations.map((a) => a.id)).toEqual(["a_0123abcd"]);
    expect(latexCopy.content_fingerprint).toBe(stored.content_fingerprint);
    const pdfCopy = JSON.parse(
      entry.docs.find((d) => d.docId === pdfDoc)?.annotations?.bytes.toString("utf8") ?? "null"
    ) as { doc_id: string; annotations: Record<string, unknown>[] };
    expect(pdfCopy.doc_id).toBe(pdfDoc);
    expect(pdfCopy.annotations).toEqual([expect.objectContaining({ id: "p-keep", extra: 1 })]);
    expect(entry.docs.find((d) => d.docId === text)?.annotations).toBeNull();

    expect(shelfChanged()).toEqual([
      expect.objectContaining({
        type: "shelf.changed",
        cause: "add",
        entry_id: out.entry.entryId,
        rev: 1,
      }),
    ]);
  });

  test("by default: no annotations, no graph, no note; stale annotations are not even looked at (nothing archived)", async () => {
    await annotateLatex();
    writeIr(mkIr("Rewritten text")); // the annotations are now of older content
    const before = digest(dataDir);
    const res = await add(body());
    expect(res.status).toBe(200);
    expect(digest(dataDir)).toEqual(before);
    expect(archiveOf(LATEX)).toEqual([]);
    const out = (await res.json()) as ShelfAddResponse;
    const entry = await readEntry(out.entry.entryId);
    expect(entry.docs.map((d) => d.annotations)).toEqual([null, null]);
    expect(entry.argumentGraph).toBeNull();
    expect(entry.note).toBeNull();
    expect(entry.entry.manifest.argument_graph).toBeNull();
  });

  test("a Work with no Doc chosen goes in with its bibliography only", async () => {
    const res = await add(body({ docs: [] }));
    expect(res.status).toBe(200);
    const out = (await res.json()) as ShelfAddResponse;
    expect((await readEntry(out.entry.entryId)).entry.manifest.docs).toEqual([]);
  });
});

describe("the annotations' three states", () => {
  test("same fingerprint: the chosen current annotations go in and nothing is archived", async () => {
    await annotateLatex();
    messages.length = 0;
    const before = digest(dataDir);
    const res = await add(
      body({ docs: [{ docId: LATEX, annotationIds: ["a_0123abcd", "a_4567cdef"] }] })
    );
    expect(res.status).toBe(200);
    expect(digest(dataDir)).toEqual(before);
    const out = (await res.json()) as ShelfAddResponse;
    expect(out.carried.docs).toEqual([{ docId: LATEX, kind: "latex", annotations: 2 }]);
    expect(messages.filter((m) => m.type === "annotation.changed")).toEqual([]);
  });

  test("different fingerprint: the access path archives as always, only the new current goes (none), the chosen ids are reported", async () => {
    await annotateLatex();
    writeIr(mkIr("Rewritten text"));
    messages.length = 0;
    const before = digest(dataDir);
    const res = await add(body({ docs: [{ docId: LATEX, annotationIds: ["a_0123abcd"] }] }));
    expect(res.status).toBe(200);
    const out = (await res.json()) as ShelfAddResponse;
    expect(out.carried.docs).toEqual([{ docId: LATEX, kind: "latex", annotations: 0 }]);
    expect(out.notCarried).toEqual([{ docId: LATEX, annotationIds: ["a_0123abcd"] }]);
    expect(out.archived).toEqual([{ docId: LATEX, count: 2 }]);
    expect((await readEntry(out.entry.entryId)).docs[0]?.annotations).toBeNull();
    // the archive happened (and only under annotations/<doc>/); every other byte is as it was
    expect(archiveOf(LATEX)).toHaveLength(1);
    const after = digest(dataDir);
    const outside = (d: Record<string, string>) =>
      Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith(`annotations/${LATEX}/`)));
    expect(outside(after)).toEqual(outside(before));
    const current = JSON.parse(
      readFileSync(annotationsCurrentPath(dataDir, LATEX), "utf8")
    ) as AnnotationsFile;
    expect(current.annotations).toEqual([]);
    expect(messages.filter((m) => m.type === "annotation.changed")).toEqual([
      expect.objectContaining({ doc_id: LATEX, cause: "invalidate" }),
    ]);
  });

  test("cannot compute (an asset the text declares is missing): refused, the Shelf and the annotations untouched", async () => {
    await annotateLatex();
    writeIr(mkIr("Hello world", "missing.png"));
    const before = digest(dataDir);
    for (const annotationIds of [[], ["a_0123abcd"]]) {
      const res = await add(body({ docs: [{ docId: LATEX, annotationIds }] }));
      expect(res.status).toBe(500);
      const answer = (await res.json()) as Record<string, unknown>;
      expect(answer).toMatchObject({ code: "item_unreadable", problem: "asset_mismatch" });
      expect(answer.item).toEqual({ kind: "doc", docId: LATEX, path: "assets/missing.png" });
    }
    expect(digest(dataDir)).toEqual(before);
    expect(archiveOf(LATEX)).toEqual([]);
    expect(shelfEntries()).toEqual([]);
    expect(shelfChanged()).toEqual([]);
  });

  test("cannot compute (the annotations file is damaged): refused, never reset", async () => {
    await annotateLatex();
    writeFileSync(annotationsCurrentPath(dataDir, LATEX), "{ not json");
    const before = digest(dataDir);
    const res = await add(body({ docs: [{ docId: LATEX, annotationIds: ["a_0123abcd"] }] }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      code: "item_unreadable",
      item: { kind: "annotations", docId: LATEX },
      problem: "annotations_invalid",
    });
    expect(digest(dataDir)).toEqual(before);
    expect(shelfEntries()).toEqual([]);
  });

  test("a damaged reading text is refused", async () => {
    writeFileSync(join(latexDir(), `${LATEX}.json`), "{ broken");
    const before = digest(dataDir);
    const res = await add(body({ docs: [{ docId: LATEX, annotationIds: [] }] }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      item: { kind: "doc", docId: LATEX },
      problem: "invalid",
    });
    expect(digest(dataDir)).toEqual(before);
    expect(shelfEntries()).toEqual([]);
  });
});

describe("a PDF Doc that does not verify, a busy Doc: nothing is written anywhere", () => {
  const refusedWith = async (
    expected: Record<string, unknown>,
    docs = [{ docId: pdfDoc, annotationIds: ["p-keep"] }]
  ) => {
    await annotateLatex();
    writeIr(mkIr("Rewritten text")); // stale: an ensure would archive
    const before = digest(dataDir);
    const res = await add(
      body({ docs: [{ docId: LATEX, annotationIds: ["a_0123abcd"] }, ...docs] })
    );
    expect(await res.json()).toMatchObject(expected);
    expect(digest(dataDir)).toEqual(before);
    expect(archiveOf(LATEX)).toEqual([]);
    expect(shelfEntries()).toEqual([]);
    expect(shelfChanged()).toEqual([]);
    return res.status;
  };

  test("a damaged sidecar", async () => {
    writeFileSync(join(paths.outputDir, pdfDoc, "annotations.json"), "[]");
    expect(
      await refusedWith({
        code: "item_unreadable",
        item: { kind: "annotations", docId: pdfDoc, path: "annotations.json" },
        problem: "annotations_invalid",
      })
    ).toBe(500);
  });

  test("a sidecar bound to another original", async () => {
    const sidecar = join(paths.outputDir, pdfDoc, "annotations.json");
    const file = JSON.parse(readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    file.content_sha256 = "0".repeat(64);
    writeFileSync(sidecar, JSON.stringify(file));
    expect(
      await refusedWith({
        item: { kind: "annotations", docId: pdfDoc, path: "annotations.json" },
        problem: "annotations_invalid",
      })
    ).toBe(500);
  });

  test("a missing original", async () => {
    rmSync(join(paths.outputDir, pdfDoc, "original.pdf"));
    expect(
      await refusedWith({
        item: { kind: "doc", docId: pdfDoc, path: "original.pdf" },
        problem: "incomplete",
      })
    ).toBe(500);
  });

  test("an original whose bytes changed", async () => {
    writeFileSync(join(paths.outputDir, pdfDoc, "original.pdf"), Buffer.from("%PDF-1.4 other"));
    expect(
      await refusedWith({
        item: { kind: "doc", docId: pdfDoc, path: "original.pdf" },
        problem: "content_changed",
      })
    ).toBe(500);
  });

  test("a Doc folder that is gone", async () => {
    rmSync(join(paths.outputDir, pdfDoc), { recursive: true });
    expect(await refusedWith({ item: { kind: "doc", docId: pdfDoc }, problem: "missing" })).toBe(
      500
    );
  });

  test("a Doc being written (pinned) or deleted: 409 doc_busy", async () => {
    docMutations.pinWriter(pdfDoc);
    expect(await refusedWith({ code: "doc_busy", docId: pdfDoc })).toBe(409);
    docMutations.unpinWriter(pdfDoc);
    expect(docMutations.tryBeginDelete(pdfDoc)).toBe(true);
    messages.length = 0;
    const res = await add(body());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "doc_busy", docId: pdfDoc });
    expect(shelfEntries()).toEqual([]);
  });
});

describe("the request", () => {
  test("a Doc the Work does not list, an unknown Work, a body that is not a request", async () => {
    const before = digest(dataDir);
    const notListed = await add(body({ docs: [{ docId: "arxiv-2501.17225", annotationIds: [] }] }));
    expect(notListed.status).toBe(409);
    expect(await notListed.json()).toMatchObject({
      code: "doc_not_in_work",
      docId: "arxiv-2501.17225",
    });
    const unknown = await add(body({ workId: "doi:10.9/none" }));
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ code: "work_not_found" });
    for (const bad of [
      null,
      { workId: W_A },
      body({ extra: 1 }),
      body({
        docs: [
          { docId: LATEX, annotationIds: [] },
          { docId: LATEX, annotationIds: [] },
        ],
      }),
      body({ docs: [{ docId: "../x", annotationIds: [] }] }),
    ]) {
      const res = await add(bad);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "invalid_request" });
    }
    expect(digest(dataDir)).toEqual(before);
    expect(shelfEntries()).toEqual([]);
  });

  test("the store is busy (another workbench holds the lock): 503, nothing written", async () => {
    const busy: ShelfStore = { ...shelf, put: async () => ({ ok: false, reason: "busy" }) };
    const res = await add(body(), makeApp(busy));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "shelf_busy" });
    expect(shelfChanged()).toEqual([]);
  });
});

describe("replacing the same paper", () => {
  const firstAdd = async () => {
    const res = await add(body());
    expect(res.status).toBe(200);
    return (await res.json()) as ShelfAddResponse;
  };
  const askedImpact = async (over: Record<string, unknown> = {}) => {
    const res = await add(body(over));
    expect(res.status).toBe(409);
    const answer = (await res.json()) as { code: string; impact: ShelfReplaceImpact };
    expect(answer.code).toBe("confirmation_required");
    return answer.impact;
  };

  test("asks first (with what goes), then replaces only with the impact brought back unchanged", async () => {
    const first = await firstAdd();
    const entriesAfterFirst = shelfEntries();
    await annotateLatex();
    const impact = await askedImpact({ docs: [{ docId: LATEX, annotationIds: ["a_0123abcd"] }] });
    expect(impact).toEqual({
      entries: [
        {
          entryId: first.entry.entryId,
          rev: 1,
          title: "Shelf Paper A",
          addedAt: expect.any(String),
          sourceProject: process.cwd(),
          docs: [
            {
              docId: LATEX,
              kind: "latex",
              bytes:
                statSync(join(latexDir(), `${LATEX}.json`)).size +
                statSync(join(latexDir(), "assets", "logo.png")).size,
            },
            {
              docId: pdfDoc,
              kind: "pdf",
              bytes:
                statSync(join(paths.outputDir, pdfDoc, `${pdfDoc}.json`)).size +
                statSync(join(paths.outputDir, pdfDoc, "original.pdf")).size,
            },
          ],
          annotations: 0,
          argumentGraph: false,
          note: false,
        },
      ],
    });
    expect(shelfEntries()).toEqual(entriesAfterFirst);

    const res = await add(
      body({ docs: [{ docId: LATEX, annotationIds: ["a_0123abcd"] }], confirm: impact })
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as ShelfAddResponse;
    expect(out.entry).toEqual({ entryId: first.entry.entryId, rev: 2 });
    expect(out.replaced).toEqual([{ entryId: first.entry.entryId, rev: 1 }]);
    const listed = await shelf.list();
    expect(listed.map((i) => [i.entryId, i.rev])).toEqual([[first.entry.entryId, 2]]);
    const entry = await readEntry(first.entry.entryId);
    expect(entry.entry.manifest.docs.map((d) => [d.doc_id, d.annotations?.count ?? 0])).toEqual([
      [LATEX, 1],
    ]);
    expect(shelfChanged()).toEqual([
      expect.objectContaining({ cause: "add", entry_id: first.entry.entryId, rev: 1, removed: [] }),
      expect.objectContaining({
        cause: "replace",
        entry_id: first.entry.entryId,
        rev: 2,
        removed: [{ entry_id: first.entry.entryId, rev: 1 }],
      }),
    ]);
  });

  test("asking reads nothing of the project: stale annotations are not archived before the person confirmed", async () => {
    await firstAdd();
    await annotateLatex();
    writeIr(mkIr("Rewritten text"));
    const before = digest(dataDir);
    await askedImpact({ docs: [{ docId: LATEX, annotationIds: ["a_0123abcd"] }] });
    expect(digest(dataDir)).toEqual(before);
    expect(archiveOf(LATEX)).toEqual([]);
  });

  test("a confirmation that is not what the Shelf holds now is refused, with the fresh impact", async () => {
    const first = await firstAdd();
    const impact = await askedImpact();
    // tampered: any value differs
    const tampered = { entries: [{ ...impact.entries[0], annotations: 5 }] } as ShelfReplaceImpact;
    const t = await add(body({ confirm: tampered }));
    expect(t.status).toBe(409);
    expect(await t.json()).toMatchObject({ code: "confirmation_changed", impact });

    // the entry was replaced meanwhile (another tab confirmed first)
    expect((await add(body({ confirm: impact }))).status).toBe(200);
    const stale = await add(body({ note: true, confirm: impact }));
    expect(stale.status).toBe(409);
    const answer = (await stale.json()) as { code: string; impact: ShelfReplaceImpact };
    expect(answer.code).toBe("confirmation_changed");
    expect(answer.impact.entries.map((e) => [e.entryId, e.rev])).toEqual([
      [first.entry.entryId, 2],
    ]);
    const entry = await readEntry(first.entry.entryId);
    expect(entry.entry.rev).toBe(2);
    expect(entry.note).toBeNull(); // the refused request wrote nothing

    // the entry was deleted meanwhile: nothing to replace any more, still refused, no impact
    expect((await call("DELETE", `/api/shelf/entries/${first.entry.entryId}?rev=2`)).status).toBe(
      200
    );
    const gone = await add(body({ confirm: answer.impact }));
    expect(gone.status).toBe(409);
    const goneAnswer = (await gone.json()) as Record<string, unknown>;
    expect(goneAnswer.code).toBe("confirmation_changed");
    expect(goneAnswer).not.toHaveProperty("impact");
    expect(shelfEntries()).toEqual([]);
  });

  test("the same paper under two entries (one by DOI, one by arXiv id): both are named, both go", async () => {
    const base = { authors: [], year: 2021 };
    const putEntry = async (bib: Record<string, unknown>) => {
      const r = await shelf.put(
        {
          bibliography: { ...base, ...bib } as never,
          source: { project: "/elsewhere", workId: "w" },
          docs: [],
          argumentGraph: null,
          note: null,
        },
        { mode: "new" }
      );
      if (!r.ok) throw new Error(r.reason);
      return r.entry.entryId;
    };
    const byDoi = await putEntry({ title: "By DOI", doi: "10.1234/shelf-a" });
    const byArxiv = await putEntry({ title: "By arXiv", arxiv_id: "2401.01234" });
    const store = LibraryStore.load(paths);
    const work = store.get(W_A);
    if (!work) throw new Error("no work");
    work.arxiv_id = "2401.01234v2";
    store.save(paths);

    const impact = await askedImpact();
    expect(impact.entries.map((e) => e.entryId).sort()).toEqual([byDoi, byArxiv].sort());
    // only one of them confirmed: refused
    const partial = await add(body({ confirm: { entries: [impact.entries[0]] } }));
    expect(partial.status).toBe(409);
    expect(await partial.json()).toMatchObject({ code: "confirmation_changed" });
    const res = await add(body({ confirm: impact }));
    expect(res.status).toBe(200);
    const out = (await res.json()) as ShelfAddResponse;
    expect(out.entry).toEqual({ entryId: impact.entries[0]?.entryId, rev: 2 });
    expect((await shelf.list()).map((i) => i.entryId)).toEqual([impact.entries[0]?.entryId]);
    // the notification names both entries that went: the first kept its id at rev 2, the other is removed
    const replaced = shelfChanged().find((m) => (m as { cause: string }).cause === "replace") as
      | { removed: { entry_id: string; rev: number }[] }
      | undefined;
    expect(replaced?.removed).toEqual(
      impact.entries.map((e) => ({ entry_id: e.entryId, rev: e.rev }))
    );
  });

  test("a Work without DOI, arXiv or OpenAlex id is never the same paper: each add is a new entry", async () => {
    const plain = { workId: W_PLAIN, docs: [], argumentGraph: false, note: false };
    const one = await add(plain);
    const two = await add(plain);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(await shelf.list()).toHaveLength(2);
  });
});

describe("deleting an entry", () => {
  test("at the rev the page showed; a later rev, an unknown entry or a bad rev are refused", async () => {
    const res = await add(body());
    const { entry } = (await res.json()) as ShelfAddResponse;
    const before = digest(dataDir);

    const wrongRev = await call("DELETE", `/api/shelf/entries/${entry.entryId}?rev=2`);
    expect(wrongRev.status).toBe(409);
    expect(await wrongRev.json()).toMatchObject({ code: "rev_mismatch", currentRev: 1 });
    for (const rev of ["", "0", "-1", "1.5", "abc", "01"]) {
      const bad = await call("DELETE", `/api/shelf/entries/${entry.entryId}?rev=${rev}`);
      expect([rev, bad.status]).toEqual([rev, 400]);
    }
    expect((await call("DELETE", `/api/shelf/entries/${entry.entryId}`)).status).toBe(400);
    const unknown = await call("DELETE", `/api/shelf/entries/${"0".repeat(32)}?rev=1`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ code: "not_found" });
    expect(await shelf.list()).toHaveLength(1);

    const ok = await call("DELETE", `/api/shelf/entries/${entry.entryId}?rev=1`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ deleted: { entryId: entry.entryId, rev: 1 } });
    expect(await shelf.list()).toEqual([]);
    expect(digest(dataDir)).toEqual(before); // the project's copies are not the Shelf's
    expect(shelfChanged()).toEqual([
      expect.objectContaining({ cause: "add", removed: [] }),
      expect.objectContaining({
        cause: "delete",
        entry_id: entry.entryId,
        rev: 1,
        removed: [{ entry_id: entry.entryId, rev: 1 }],
      }),
    ]);
  });
});

describe("review round: the kind of a Doc, write failures of the access path, carried assets", () => {
  const refusedAll = async (docs: { docId: string; annotationIds: string[] }[]) => {
    const before = digest(dataDir);
    const res = await add(body({ docs }));
    const answer = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(500);
    expect(digest(dataDir)).toEqual(before);
    expect(shelfEntries()).toEqual([]);
    expect(shelfChanged()).toEqual([]);
    return answer;
  };

  test("a text Doc whose source is a link, a folder or gone is refused by its id, never carried as a LaTeX Doc", async () => {
    const text = await textDoc();
    const source = join(paths.outputDir, text, "text-source.json");
    const copy = join(paths.outputDir, "elsewhere-source.json");
    writeFileSync(copy, readFileSync(source));

    rmSync(source);
    symlinkSync(copy, source);
    expect(await refusedAll([{ docId: text, annotationIds: [] }])).toMatchObject({
      item: { kind: "doc", docId: text, path: "text-source.json" },
      problem: "not_a_regular_file",
    });

    rmSync(source);
    mkdirSync(source);
    expect(await refusedAll([{ docId: text, annotationIds: [] }])).toMatchObject({
      item: { kind: "doc", docId: text, path: "text-source.json" },
      problem: "not_a_regular_file",
    });

    rmSync(source, { recursive: true });
    expect(await refusedAll([{ docId: text, annotationIds: [] }])).toMatchObject({
      item: { kind: "doc", docId: text, path: "text-source.json" },
      problem: "incomplete",
    });
  });

  test("the older annotations cannot be archived: their own problem, the annotations left as they were", async () => {
    await annotateLatex();
    writeIr(mkIr("Rewritten text"));
    mkdirSync(join(dataDir, "annotations", LATEX), { recursive: true });
    writeFileSync(join(dataDir, "annotations", LATEX, "archive"), "not a directory");
    const answer = await refusedAll([{ docId: LATEX, annotationIds: ["a_0123abcd"] }]);
    expect(answer).toMatchObject({
      code: "item_unreadable",
      item: { kind: "annotations", docId: LATEX },
      problem: "annotations_archive_failed",
    });
  });

  test("archived but the new current cannot be created: said as it is (the project changed by the archive)", async () => {
    await annotateLatex();
    writeIr(mkIr("Rewritten text"));
    const current = annotationsCurrentPath(dataDir, LATEX);
    const before = readFileSync(current);
    mkdirSync(`${current}.tmp`);
    const res = await add(body({ docs: [{ docId: LATEX, annotationIds: ["a_0123abcd"] }] }));
    expect(res.status).toBe(500);
    const answer = (await res.json()) as { detail: string };
    expect(answer).toMatchObject({
      code: "item_unreadable",
      item: { kind: "annotations", docId: LATEX },
      problem: "annotations_new_current_failed",
    });
    expect(answer.detail).toMatch(/archived/);
    expect((answer as unknown as { archived: unknown }).archived).toEqual([
      { docId: LATEX, count: 2 },
    ]);
    expect(answer.detail).not.toMatch(/nothing was (written|changed)\b(?! to the Shelf)/);
    expect(archiveOf(LATEX)).toHaveLength(1);
    expect(
      readFileSync(join(dataDir, "annotations", LATEX, "archive", archiveOf(LATEX)[0] ?? ""))
    ).toEqual(before);
    expect(shelfEntries()).toEqual([]);
  });

  test("an image the reading text declares outside assets/ cannot go: refused, not carried without it", async () => {
    mkdirSync(join(latexDir(), "mineru"), { recursive: true });
    writeFileSync(join(latexDir(), "mineru", "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeIr(mkIr("Hello world", "mineru/pic.png"));
    expect(await refusedAll([{ docId: LATEX, annotationIds: [] }])).toMatchObject({
      item: { kind: "doc", docId: LATEX, path: "mineru/pic.png" },
      problem: "asset_outside_carried",
    });
  });

  test("a programming error of the store is not reported as a failed write; a system error of its write is", async () => {
    const bug: ShelfStore = {
      ...shelf,
      put: async () => {
        throw new TypeError("a bug");
      },
    };
    const res = await add(body(), makeApp(bug));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("shelf_write_failed");

    const full: ShelfStore = {
      ...shelf,
      put: async () => {
        throw Object.assign(new Error("no space"), { code: "ENOSPC" });
      },
    };
    const res2 = await add(body(), makeApp(full));
    expect(res2.status).toBe(500);
    expect(await res2.json()).toMatchObject({ code: "shelf_write_failed" });

    const deleteBug: ShelfStore = {
      ...shelf,
      delete: async () => {
        throw new TypeError("a bug");
      },
    };
    const del = await call(
      "DELETE",
      `/api/shelf/entries/${"0".repeat(32)}?rev=1`,
      undefined,
      makeApp(deleteBug)
    );
    expect(del.status).toBe(500);
    expect(await del.text()).not.toContain("shelf_write_failed");
  });
});

describe("preview: what an add would do now, read only", () => {
  const preview = (b: unknown, target: Hono = app) =>
    call("POST", "/api/shelf/entries/preview", b, target);

  test("nothing of the same paper: impact null, the counts that would go; nothing written, nothing archived", async () => {
    await annotateLatex();
    const before = digest(dataDir);
    const res = await preview(
      body({
        docs: [
          { docId: LATEX, annotationIds: ["a_0123abcd", "a_99999999"] },
          { docId: pdfDoc, annotationIds: ["p-keep"] },
        ],
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      impact: null,
      carried: {
        docs: [
          { docId: LATEX, kind: "latex", annotations: 1 },
          { docId: pdfDoc, kind: "pdf", annotations: 1 },
        ],
        argumentGraph: false,
        note: false,
      },
      notCarried: [{ docId: LATEX, annotationIds: ["a_99999999"] }],
      wouldArchive: [],
    });
    expect(digest(dataDir)).toEqual(before);
    expect(shelfEntries()).toEqual([]);
    expect(shelfChanged()).toEqual([]);
  });

  test("stale annotations are estimated as not carried and are not archived", async () => {
    await annotateLatex();
    writeIr(mkIr("Rewritten text"));
    messages.length = 0;
    const before = digest(dataDir);
    const res = await preview(body({ docs: [{ docId: LATEX, annotationIds: ["a_0123abcd"] }] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      carried: { docs: [{ docId: LATEX, kind: "latex", annotations: 0 }] },
      notCarried: [{ docId: LATEX, annotationIds: ["a_0123abcd"] }],
      // the add's access path would move this older batch to the archive: said per Doc, with its size (票 07 B1)
      wouldArchive: [{ docId: LATEX, count: 2 }],
    });
    expect(digest(dataDir)).toEqual(before);
    expect(archiveOf(LATEX)).toEqual([]);
    expect(messages).toEqual([]);
    // and the add then archives exactly that
    const added = await add(body({ docs: [{ docId: LATEX, annotationIds: ["a_0123abcd"] }] }));
    expect(((await added.json()) as ShelfAddResponse).archived).toEqual([
      { docId: LATEX, count: 2 },
    ]);
  });

  test("no annotations file is not an archive, and a Doc with nothing chosen is not looked at: wouldArchive stays empty", async () => {
    const none = await preview(body({ docs: [{ docId: LATEX, annotationIds: ["a_0123abcd"] }] }));
    expect(await none.json()).toMatchObject({
      notCarried: [{ docId: LATEX, annotationIds: ["a_0123abcd"] }],
      wouldArchive: [],
    });
    // stale but no annotation chosen: the add does not ensure it, so nothing would be archived
    await annotateLatex();
    writeIr(mkIr("Rewritten text"));
    const unchosen = await preview(body());
    expect(await unchosen.json()).toMatchObject({ notCarried: [], wouldArchive: [] });
  });

  test("an in-process expectation (the Copilot card): an add whose carried or archived differ from it writes nothing to the Shelf", async () => {
    await annotateLatex();
    const writer = createShelfWriter({
      paths,
      projectRoot: dataDir,
      annotations: createAnnotationAccess({
        paths,
        lock: new AsyncLock(),
        docMutations,
        onChanged: () => {},
      }),
      store: () => shelf,
      onChanged: () => {},
    });
    const request = body({ docs: [{ docId: LATEX, annotationIds: ["a_0123abcd"] }] });
    const shown = (await writer.preview(request)).body as unknown as ShelfAddPreviewResponse;
    expect(shown.carried.docs).toEqual([{ docId: LATEX, kind: "latex", annotations: 1 }]);
    // an annotation went away between the card and the add: what would go in is not what was shown
    const current = (await (
      await call("GET", `/api/paper/${LATEX}/annotations`)
    ).json()) as AnnotationsFile;
    expect(
      (
        await call("PUT", `/api/paper/${LATEX}/annotations`, {
          ...current,
          annotations: [ANNOTATION("a_4567cdef")],
        })
      ).status
    ).toBe(200);
    const refused = await writer.add(request, { expect: shown });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "carried_changed", archived: [] });
    expect(shelfEntries()).toEqual([]);
    // the same expectation, still true: the add goes through
    const again = (await writer.preview(request)).body as unknown as ShelfAddPreviewResponse;
    const ok = await writer.add(request, { expect: again });
    expect(ok.status).toBe(200);
    expect(shelfEntries()).toHaveLength(1);
  });

  test("with the same paper on the Shelf: the impact the add would ask to confirm", async () => {
    expect((await add(body())).status).toBe(200);
    const res = await preview(body());
    expect(res.status).toBe(200);
    const shown = ((await res.json()) as { impact: ShelfReplaceImpact }).impact;
    const asked = await add(body());
    expect(asked.status).toBe(409);
    expect(((await asked.json()) as { impact: ShelfReplaceImpact }).impact).toEqual(shown);
  });

  test("the same refusals as the add (busy, a bad Doc), and no confirm field", async () => {
    docMutations.pinWriter(pdfDoc);
    const busy = await preview(body());
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ code: "doc_busy", docId: pdfDoc });
    docMutations.unpinWriter(pdfDoc);
    rmSync(join(paths.outputDir, pdfDoc, "original.pdf"));
    const bad = await preview(body());
    expect(bad.status).toBe(500);
    expect(await bad.json()).toMatchObject({
      item: { kind: "doc", docId: pdfDoc, path: "original.pdf" },
    });
    const withConfirm = await preview(body({ confirm: { entries: [] } }));
    expect(withConfirm.status).toBe(400);
    expect(shelfEntries()).toEqual([]);
  });
});

describe("an add that stops after the access path archived: it says so", () => {
  const B = "paper-b";
  beforeEach(() => {
    const dir = join(dataDir, "output", B);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${B}.json`), JSON.stringify({ ...mkIr("Paper B text"), docId: B }));
    const store = LibraryStore.load(paths);
    const work = store.get(W_A);
    if (!work) throw new Error("no work");
    work.doc_ids = [...work.doc_ids, B];
    store.save(paths);
  });

  test("A's stale annotations archived, B's annotations file damaged: refused, with what was archived", async () => {
    await annotateLatex();
    writeIr(mkIr("Rewritten text"));
    mkdirSync(join(dataDir, "annotations", B), { recursive: true });
    writeFileSync(annotationsCurrentPath(dataDir, B), "{ broken");
    const res = await add(
      body({
        docs: [
          { docId: LATEX, annotationIds: ["a_0123abcd"] },
          { docId: B, annotationIds: ["a_00000001"] },
        ],
      })
    );
    expect(res.status).toBe(500);
    const answer = (await res.json()) as { detail: string } & Record<string, unknown>;
    expect(answer).toMatchObject({
      code: "item_unreadable",
      item: { kind: "annotations", docId: B },
      problem: "annotations_invalid",
      archived: [{ docId: LATEX, count: 2 }],
    });
    expect(answer.detail).toMatch(new RegExp(`archived.*${LATEX}`));
    expect(archiveOf(LATEX)).toHaveLength(1);
    expect(shelfEntries()).toEqual([]);
  });

  test("the Shelf refuses after the archive (busy): the refusal carries it too", async () => {
    await annotateLatex();
    writeIr(mkIr("Rewritten text"));
    const busy: ShelfStore = { ...shelf, put: async () => ({ ok: false, reason: "busy" }) };
    const res = await add(
      body({ docs: [{ docId: LATEX, annotationIds: ["a_0123abcd"] }] }),
      makeApp(busy)
    );
    expect(res.status).toBe(503);
    const answer = (await res.json()) as { detail: string } & Record<string, unknown>;
    expect(answer).toMatchObject({ code: "shelf_busy", archived: [{ docId: LATEX, count: 2 }] });
    expect(answer.detail).toMatch(/archived/);
  });

  test("nothing archived: the refusal says an empty list and no archive sentence", async () => {
    mkdirSync(join(dataDir, "annotations", B), { recursive: true });
    writeFileSync(annotationsCurrentPath(dataDir, B), "{ broken");
    const res = await add(body({ docs: [{ docId: B, annotationIds: ["a_00000001"] }] }));
    const answer = (await res.json()) as { detail: string } & Record<string, unknown>;
    expect(answer.archived).toEqual([]);
    expect(answer.detail).not.toMatch(/archived/);
  });
});

describe("the lock lost after the new entry is in place", () => {
  test("shelf.changed and the answer name only the targets that are really gone", async () => {
    const putEntry = async (bib: Record<string, unknown>) => {
      const r = await shelf.put(
        {
          bibliography: { authors: [], year: 2021, ...bib } as never,
          source: { project: "/elsewhere", workId: "w" },
          docs: [],
          argumentGraph: null,
          note: null,
        },
        { mode: "new" }
      );
      if (!r.ok) throw new Error(r.reason);
      return r.entry.entryId;
    };
    const byDoi = await putEntry({ title: "By DOI", doi: "10.1234/shelf-a" });
    const byArxiv = await putEntry({ title: "By arXiv", arxiv_id: "2401.01234" });
    const store = LibraryStore.load(paths);
    const work = store.get(W_A);
    if (!work) throw new Error("no work");
    work.arxiv_id = "2401.01234";
    store.save(paths);
    const asked = await add(body());
    const { impact } = (await asked.json()) as { impact: ShelfReplaceImpact };
    const first = impact.entries[0]?.entryId as string;
    const other = first === byDoi ? byArxiv : byDoi;
    // The store: the new entry landed as rev 2 of the first target, then the lock was lost before the other went.
    const lost: ShelfStore = {
      ...shelf,
      put: async () => ({ ok: false, reason: "lock_lost", written: { entryId: first, rev: 2 } }),
      list: async () =>
        (await shelf.list()).map((i) => (i.entryId === first ? { ...i, rev: 2 } : i)),
    };
    messages.length = 0;
    const res = await add(body({ confirm: impact }), makeApp(lost));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      code: "lock_lost",
      written: { entryId: first, rev: 2 },
      removed: [{ entryId: first, rev: 1 }],
    });
    expect(shelfChanged()).toEqual([
      expect.objectContaining({
        cause: "replace",
        entry_id: first,
        rev: 2,
        removed: [{ entry_id: first, rev: 1 }],
      }),
    ]);
    expect(other).not.toBe(first);
  });
});

describe("GET /api/shelf/add-candidates/:workId (the add dialog's read-only list, ticket 05)", () => {
  const candidates = (workId: string) =>
    call("GET", `/api/shelf/add-candidates/${encodeURIComponent(workId)}`);
  type Answer = {
    workId: string;
    docs: {
      docId: string;
      kind: string;
      bytes: number | null;
      annotations: { state: string; list?: { id: string }[] };
    }[];
  };

  test("current annotations, Doc kinds and carried bytes; nothing written, archived or announced", async () => {
    await annotateLatex();
    messages.length = 0;
    const before = digest(dataDir);
    const res = await candidates(W_A);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const answer = (await res.json()) as Answer;
    expect(answer.workId).toBe(W_A);
    expect(answer.docs.map((d) => [d.docId, d.kind, d.annotations.state])).toEqual([
      [LATEX, "latex", "current"],
      [pdfDoc, "pdf", "pdf"],
    ]);
    expect(answer.docs[0]?.annotations.list?.map((a) => a.id)).toEqual([
      "a_0123abcd",
      "a_4567cdef",
    ]);
    // the files the Shelf would carry: the reading text and assets/, not src/ or build/
    expect(answer.docs[0]?.bytes).toBe(
      statSync(join(latexDir(), `${LATEX}.json`)).size +
        statSync(join(latexDir(), "assets", "logo.png")).size
    );
    expect(answer.docs[1]?.bytes).toBe(
      statSync(join(paths.outputDir, pdfDoc, `${pdfDoc}.json`)).size +
        statSync(join(paths.outputDir, pdfDoc, "original.pdf")).size
    );
    expect(digest(dataDir)).toEqual(before);
    expect(messages).toEqual([]);
  });

  test("annotations of older content are stale and NOT archived (no ensure)", async () => {
    await annotateLatex();
    writeIr(mkIr("Different content"));
    messages.length = 0;
    const before = digest(dataDir);
    const answer = (await (await candidates(W_A)).json()) as Answer;
    expect(answer.docs.find((d) => d.docId === LATEX)?.annotations).toEqual({ state: "stale" });
    expect(digest(dataDir)).toEqual(before);
    expect(archiveOf(LATEX)).toEqual([]);
    expect(messages).toEqual([]);
  });

  test("a damaged annotations file is unreadable (not reset); a busy Doc is busy; an unknown Work is 404", async () => {
    await annotateLatex();
    writeFileSync(annotationsCurrentPath(dataDir, LATEX), "{ broken");
    const before = digest(dataDir);
    const damaged = (await (await candidates(W_A)).json()) as Answer;
    expect(damaged.docs[0]?.annotations).toEqual({ state: "unreadable", code: "corrupt_store" });
    expect(digest(dataDir)).toEqual(before);
    docMutations.pinWriter(LATEX);
    const busy = (await (await candidates(W_A)).json()) as Answer;
    expect(busy.docs[0]?.annotations.state).toBe("busy");
    docMutations.unpinWriter(LATEX);
    const res = await candidates("doi:10.0/none");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "work_not_found" });
  });
});
