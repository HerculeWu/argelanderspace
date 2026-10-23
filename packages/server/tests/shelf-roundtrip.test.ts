/**
 * The whole Shelf (文献仓) round trip for PDF and text Docs (shelf-followups ticket 02; contracts「文献仓」,
 * docs/library.md「文献仓」): project A is built through its own HTTP routes where they exist (PDF annotations and
 * reading position, the text Doc's source, image asset, generated reading text and annotations), added with
 * `POST /api/shelf/entries`, and taken into project B with `POST /api/shelf/entries/:id/take`. Only the PDF Doc itself
 * is placed with core `publishPdfDoc` (an upload would need the PDFium probe; what it publishes is the same).
 *
 * Hermetic: both projects and the Shelf are fresh temp directories; no real user data, no global data directory.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  type AnnotationsFile,
  buildStructureTarget,
  type ShelfAddResponse,
  type ShelfTakeResult,
  type TextAssetAdded,
  type TextDocIr,
} from "@argelanderspace/contracts";
import {
  annotationsArchiveDir,
  annotationsCurrentPath,
  emptyWork,
  type LibraryPaths,
  LibraryStore,
  libraryPaths,
  publishPdfDoc,
  rebuild,
} from "@argelanderspace/core";
import { createShelfStore, type ShelfStore } from "@argelanderspace/infra";
import type { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { statusDirFor } from "../src/deps.js";
import { JobRunner } from "../src/jobs.js";
import { collectBroadcasts, stubPipelines, stubSources } from "./helpers.js";
import { syntheticPdf } from "./pdf-fixture.js";

const DOI = "10.1234/shelf.roundtrip";
const WORK = `doi:${DOI}`;
const PAGES = [
  { width: 612, height: 792, rotation: 0 as const },
  { width: 612, height: 792, rotation: 0 as const },
];

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(13);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    len,
    Buffer.from("IHDR"),
    ihdr,
    Buffer.alloc(4),
    Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
  ]);
}

/** A synthetic project with the given Works (nothing else). */
function newProject(works: ReturnType<typeof emptyWork>[]): LibraryPaths {
  const paths = libraryPaths(join(mkdtempSync(join(tmpdir(), "shelf-roundtrip-")), "data"));
  mkdirSync(paths.outputDir, { recursive: true });
  mkdirSync(paths.libraryDir, { recursive: true });
  new LibraryStore(works).save(paths);
  return paths;
}

function appFor(paths: LibraryPaths, shelf: ShelfStore): Hono {
  return createApp({
    paths,
    statusDir: statusDirFor(paths.dataDir),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(paths.dataDir, "jobs") }),
    broadcast: collectBroadcasts().broadcast,
    shelf,
  });
}

const call = (app: Hono, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** path → sha256 of every file under a directory. */
function digest(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(root, p).split("\\").join("/")] = sha(readFileSync(p));
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

const worksOf = (paths: LibraryPaths) =>
  (JSON.parse(readFileSync(paths.libraryJson, "utf8")) as { works: Record<string, unknown>[] })
    .works;

// ---- project A ------------------------------------------------------------------------------------------------

let shelfDir: string;
let shelf: ShelfStore;
let source: LibraryPaths;
let appA: Hono;
let pdfDoc: string;
let pdfSha: string;
let textDoc: string;
let imageName: string;
let image: Buffer;

beforeEach(async () => {
  shelfDir = join(mkdtempSync(join(tmpdir(), "shelf-roundtrip-shelf-")), "shelf");
  shelf = createShelfStore({ dir: shelfDir, lockStaleMs: 2000 });
  const work = emptyWork(WORK);
  Object.assign(work, {
    title: "A Round Trip Paper",
    authors: ["Argelander"],
    year: 2025,
    doi: DOI,
    cite_key: "argelander2025",
    origin: "manual",
    added_at: "2026-01-01T00:00:00Z",
  });
  source = newProject([work]);
  appA = appFor(source, shelf);

  // The PDF Doc: published as an upload publishes it, then annotated and read through its own routes.
  const pdf = publishPdfDoc(source, {
    workId: WORK,
    filename: "paper.pdf",
    bytes: syntheticPdf(),
    pages: PAGES,
  });
  pdfDoc = pdf.doc_id;
  pdfSha = pdf.sha256;
  const snap = (await (await call(appA, "GET", `/api/paper/${pdfDoc}/pdf/snapshot`)).json()) as {
    annotations: Record<string, unknown>;
    reading_position: { file: Record<string, unknown> };
  };
  const at = "2026-10-01T10:00:00.000Z";
  const savedAnn = await call(appA, "PUT", `/api/paper/${pdfDoc}/pdf/annotations`, {
    ...snap.annotations,
    annotations: [
      { id: "p-doc", kind: "document_comment", body: "a PDF note", created_at: at, updated_at: at },
      {
        id: "p-page",
        kind: "page_comment",
        page_index: 1,
        body: "page two",
        created_at: at,
        updated_at: at,
      },
    ],
  });
  expect(savedAnn.status).toBe(200);
  const savedPos = await call(appA, "PUT", `/api/paper/${pdfDoc}/pdf/reading-position`, {
    ...snap.reading_position.file,
    position: { page_index: 1, x: 0.5, y: 0.25 },
  });
  expect(savedPos.status).toBe(200);
  expect(((await savedPos.json()) as { rev: number }).rev).toBe(1);

  // The text Doc: a source with an image asset, generated, with one annotation on the figure.
  const created = await call(appA, "POST", "/api/library/text-docs", {
    workId: WORK,
    operationId: "op-roundtrip",
  });
  expect(created.status).toBe(201);
  textDoc = ((await created.json()) as { description: { doc_id: string } }).description.doc_id;
  image = png(40, 30);
  const uploaded = await appA.request(
    `/api/paper/${textDoc}/source/assets?expectedRev=0&filename=profile.png`,
    { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: image }
  );
  expect(uploaded.status).toBe(201);
  const added = (await uploaded.json()) as TextAssetAdded;
  imageName = added.asset.name;
  const F = "```";
  const markdown = [
    "# Results",
    "",
    "The profile is in [ref: fig-profile | Figure 1].",
    "",
    `${F}argelander-block`,
    JSON.stringify({ id: "fig-profile", number: "1", label: "Figure 1", caption: "A profile." }),
    F,
    `![Profile](assets/${imageName})`,
    "",
  ].join("\n");
  expect(
    (
      await call(appA, "PUT", `/api/paper/${textDoc}/source`, {
        expectedRev: added.source.rev,
        markdown,
      })
    ).status
  ).toBe(200);
  expect(
    (
      await call(appA, "POST", `/api/paper/${textDoc}/source/generate`, {
        sourceRev: added.source.rev + 1,
        operationId: "gen-roundtrip",
      })
    ).status
  ).toBe(200);
  const ir = JSON.parse(
    readFileSync(join(source.outputDir, textDoc, `${textDoc}.json`), "utf8")
  ) as TextDocIr;
  const figure = ir.sections.flatMap((s) => s.blocks).find((b) => b.id === "fig-profile");
  expect(figure).toBeDefined();
  const current = (await (
    await call(appA, "GET", `/api/paper/${textDoc}/annotations`)
  ).json()) as AnnotationsFile;
  const savedText = await call(appA, "PUT", `/api/paper/${textDoc}/annotations`, {
    ...current,
    annotations: [
      {
        id: "a_0000f001",
        target: buildStructureTarget(figure as never),
        body: "check the axes",
        created_at: at,
        updated_at: at,
      },
    ],
  });
  expect(savedText.status).toBe(200);
});

const addAll = async (pdfAnnotations: string[]) => {
  const res = await call(appA, "POST", "/api/shelf/entries", {
    workId: WORK,
    docs: [
      { docId: pdfDoc, annotationIds: pdfAnnotations },
      { docId: textDoc, annotationIds: ["a_0000f001"] },
    ],
    argumentGraph: false,
    note: false,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ShelfAddResponse;
};

const takeInto = async (target: LibraryPaths, added: ShelfAddResponse) => {
  const appB = appFor(target, shelf);
  const res = await call(appB, "POST", `/api/shelf/entries/${added.entry.entryId}/take`, {
    rev: added.entry.rev,
  });
  expect(res.status).toBe(200);
  return { appB, result: (await res.json()) as ShelfTakeResult };
};

/** The files of a Doc the Shelf carries (never the PDF's reading position or annotation sidecar). */
const carriedFiles = (paths: LibraryPaths, docId: string) => {
  const all = digest(join(paths.outputDir, docId));
  delete all["reading-position.json"];
  delete all["annotations.json"];
  return all;
};

// ---- tests ----------------------------------------------------------------------------------------------------

describe("a PDF Doc and a text Doc go onto the Shelf over HTTP and come back into another project over HTTP", () => {
  test("ids and bytes unchanged; the PDF verifies with its annotations and a new reading position; the text Doc's annotations are current; no extra Work on rebuild", async () => {
    const sourceBefore = digest(source.dataDir);
    const sourceTextAnn = JSON.parse(
      readFileSync(annotationsCurrentPath(source.dataDir, textDoc), "utf8")
    ) as AnnotationsFile;

    const added = await addAll(["p-doc", "p-page"]);
    expect(added.archived).toEqual([]);
    expect(added.notCarried).toEqual([]);
    expect(added.carried.docs).toEqual([
      { docId: pdfDoc, kind: "pdf", annotations: 2 },
      { docId: textDoc, kind: "text", annotations: 1 },
    ]);
    // adding changes nothing in project A
    expect(digest(source.dataDir)).toEqual(sourceBefore);

    const target = newProject([]);
    const { appB, result } = await takeInto(target, added);
    expect(result.work).toMatchObject({ id: WORK, created: true });
    expect(result.docs.skipped).toEqual([]);
    expect(result.docs.taken.map((d) => [d.docId, d.kind, d.annotations])).toEqual([
      [pdfDoc, "pdf", 2],
      [textDoc, "text", 1],
    ]);
    const work = worksOf(target).find((w) => w.id === WORK);
    expect(work?.doc_ids).toEqual([pdfDoc, textDoc]);

    // Doc ids and the carried bytes are the source's
    expect(carriedFiles(target, pdfDoc)).toEqual(carriedFiles(source, pdfDoc));
    expect(Object.keys(carriedFiles(target, pdfDoc)).sort()).toEqual(
      [`${pdfDoc}.json`, "original.pdf"].sort()
    );
    expect(digest(join(target.outputDir, textDoc))).toEqual(
      digest(join(source.outputDir, textDoc))
    );
    expect(Object.keys(digest(join(target.outputDir, textDoc))).sort()).toEqual(
      [`${textDoc}.json`, "text-source.json", `assets/${imageName}`].sort()
    );
    expect(sha(readFileSync(join(target.outputDir, pdfDoc, "original.pdf")))).toBe(pdfSha);

    // PDF: the snapshot verifies the original and the sidecar binding; the reading position is new (rev 0, null)
    const snap = await appB.request(`/api/paper/${pdfDoc}/pdf/snapshot`);
    expect(snap.status).toBe(200);
    const snapshot = (await snap.json()) as {
      annotations: {
        doc_id: string;
        content_sha256: string;
        annotations: { id: string; body: string }[];
      };
      reading_position: { status: string; file: { rev: number; position: unknown } };
    };
    expect(snapshot.annotations.doc_id).toBe(pdfDoc);
    expect(snapshot.annotations.content_sha256).toBe(pdfSha);
    expect(snapshot.annotations.annotations.map((a) => [a.id, a.body])).toEqual([
      ["p-doc", "a PDF note"],
      ["p-page", "page two"],
    ]);
    expect(snapshot.reading_position).toMatchObject({
      status: "ready",
      file: { rev: 0, position: null },
    });
    const original = await appB.request(`/api/paper/${pdfDoc}/pdf`);
    expect(original.status).toBe(200);
    expect(sha(Buffer.from(await original.arrayBuffer()))).toBe(pdfSha);

    // text Doc: the annotations are current (same fingerprint and rev), nothing archived; the image serves
    const ann = await appB.request(`/api/paper/${textDoc}/annotations?coherent=1`);
    expect(ann.status).toBe(200);
    const coherent = (await ann.json()) as { file: AnnotationsFile };
    expect(coherent.file.content_fingerprint).toBe(sourceTextAnn.content_fingerprint);
    expect(coherent.file.rev).toBe(sourceTextAnn.rev);
    expect(coherent.file.annotations.map((a) => [a.id, a.body])).toEqual([
      ["a_0000f001", "check the axes"],
    ]);
    expect(existsSync(annotationsArchiveDir(target.dataDir, textDoc))).toBe(false);
    // the same annotation file as in project A (the add re-serializes the chosen ones; the take writes the
    // Shelf copy's bytes as they are)
    expect(
      JSON.parse(readFileSync(annotationsCurrentPath(target.dataDir, textDoc), "utf8"))
    ).toEqual(sourceTextAnn);
    const onShelf = await shelf.read(added.entry.entryId);
    if (onShelf.status !== "ok") throw new Error(`entry: ${onShelf.status}`);
    const copy = onShelf.docs.find((d) => d.docId === textDoc)?.annotations?.bytes;
    expect(copy && readFileSync(annotationsCurrentPath(target.dataDir, textDoc)).equals(copy)).toBe(
      true
    );
    const served = await appB.request(`/images/${textDoc}/${imageName}`);
    expect(served.status).toBe(200);
    expect(Buffer.from(await served.arrayBuffer())).toEqual(image);
    expect((await appB.request(`/api/paper/${textDoc}/source`)).status).toBe(200);

    // the next library build makes no extra Work and keeps both Docs with the taken one
    const worksBefore = worksOf(target).length;
    await rebuild(target, { sources: stubSources() });
    const rebuilt = LibraryStore.load(target);
    expect(rebuilt.works.length).toBe(worksBefore);
    expect(rebuilt.get(WORK)?.doc_ids).toEqual([pdfDoc, textDoc]);
    // and the annotations are still current after it
    const again = (await (
      await appB.request(`/api/paper/${textDoc}/annotations?coherent=1`)
    ).json()) as { file: AnnotationsFile };
    expect(again.file.content_fingerprint).toBe(sourceTextAnn.content_fingerprint);
    expect(existsSync(annotationsArchiveDir(target.dataDir, textDoc))).toBe(false);
    expect((await appB.request(`/api/paper/${pdfDoc}/pdf/snapshot`)).status).toBe(200);
  });

  test("a PDF added without its annotations comes back with a new empty sidecar bound to the original", async () => {
    const added = await addAll([]);
    expect(added.carried.docs[0]).toEqual({ docId: pdfDoc, kind: "pdf", annotations: 0 });

    const target = newProject([]);
    const { appB, result } = await takeInto(target, added);
    expect(result.docs.taken.find((d) => d.docId === pdfDoc)?.annotations).toBe(0);

    const sidecar = JSON.parse(
      readFileSync(join(target.outputDir, pdfDoc, "annotations.json"), "utf8")
    ) as Record<string, unknown>;
    expect(sidecar).toEqual({
      version: 1,
      doc_id: pdfDoc,
      content_sha256: pdfSha,
      rev: 0,
      annotations: [],
    });
    const snap = await appB.request(`/api/paper/${pdfDoc}/pdf/snapshot`);
    expect(snap.status).toBe(200);
    const snapshot = (await snap.json()) as {
      annotations: { rev: number; annotations: unknown[] };
      reading_position: { status: string; file: { rev: number; position: unknown } };
    };
    expect(snapshot.annotations).toMatchObject({ rev: 0, annotations: [] });
    expect(snapshot.reading_position).toMatchObject({
      status: "ready",
      file: { rev: 0, position: null },
    });
    // project A's sidecar still has both annotations
    const kept = JSON.parse(
      readFileSync(join(source.outputDir, pdfDoc, "annotations.json"), "utf8")
    ) as { annotations: { id: string }[] };
    expect(kept.annotations.map((a) => a.id)).toEqual(["p-doc", "p-page"]);
  });
});
