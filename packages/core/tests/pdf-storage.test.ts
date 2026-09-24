import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rebuild } from "../src/library/build.js";
import { seedFromOutput } from "../src/library/seed.js";
import { emptyWork, type LibraryPaths, LibraryStore } from "../src/library/store.js";
import { publishPdfDoc, readVerifiedPdf } from "../src/pdf-storage.js";

const dirs: string[] = [];
const nodeFs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
function failRenameTo(targetPath: string, action: () => void): void {
  const originalRename = nodeFs.renameSync;
  nodeFs.renameSync = ((source, target) => {
    if (target === targetPath) throw new Error("injected rename failure");
    return originalRename(source, target);
  }) as typeof nodeFs.renameSync;
  syncBuiltinESMExports();
  try {
    action();
  } finally {
    nodeFs.renameSync = originalRename;
    syncBuiltinESMExports();
  }
}
function publish(paths: LibraryPaths, docId: string, workId: string, bytes: Buffer) {
  return publishPdfDoc(paths, {
    docId,
    workId,
    filename: "paper.pdf",
    bytes,
    pages: [{ width: 612, height: 792, rotation: 0 }],
  });
}
function project(): LibraryPaths {
  const root = mkdtempSync(join(tmpdir(), "pdf-storage-"));
  dirs.push(root);
  const paths = {
    dataDir: root,
    outputDir: join(root, "output"),
    libraryDir: join(root, "library"),
    libraryJson: join(root, "library", "library.json"),
    libraryBib: join(root, "library", "library.bib"),
    cacheDir: join(root, "library", "cache"),
    graphJson: join(root, "library", "graph.json"),
  } as LibraryPaths;
  const store = new LibraryStore([emptyWork("work:1")]);
  store.save(paths);
  return paths;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("PDF Doc publication", () => {
  it("publishes the original bytes with bound empty user files", () => {
    const paths = project();
    const bytes = Buffer.from("synthetic verified pdf");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const bibBefore = readFileSync(paths.libraryBib);
    const doc = publishPdfDoc(paths, {
      docId: "pdf-12345678-1234-4234-8234-123456789abc",
      workId: "work:1",
      filename: "paper.pdf",
      bytes,
      pages: [{ width: 612, height: 792, rotation: 0 }],
    });
    expect(doc.sha256).toBe(sha256);
    expect(readFileSync(paths.libraryBib)).toEqual(bibBefore);
    expect(readVerifiedPdf(paths, doc.doc_id)).toEqual(bytes);
    const rebuilt = seedFromOutput(LibraryStore.load(paths), paths.outputDir);
    expect(rebuilt.works.map((work) => work.id)).toEqual(["work:1"]);
    expect(rebuilt.get("work:1")?.doc_ids).toEqual([doc.doc_id]);
    const dir = join(paths.outputDir, doc.doc_id);
    expect(JSON.parse(readFileSync(join(dir, "annotations.json"), "utf8"))).toMatchObject({
      doc_id: doc.doc_id,
      content_sha256: sha256,
      rev: 0,
      annotations: [],
    });
    expect(JSON.parse(readFileSync(join(dir, "reading-position.json"), "utf8"))).toMatchObject({
      doc_id: doc.doc_id,
      content_sha256: sha256,
      rev: 0,
      position: null,
    });
    writeFileSync(
      join(dir, `${doc.doc_id}.json`),
      JSON.stringify({
        version: 1,
        docId: doc.doc_id,
        meta: { title: "Never seed a PDF by title" },
      })
    );
    const rebuiltWithDamagedPdfMetadata = seedFromOutput(LibraryStore.load(paths), paths.outputDir);
    expect(rebuiltWithDamagedPdfMetadata.works.map((work) => work.id)).toEqual(["work:1"]);
    expect(rebuiltWithDamagedPdfMetadata.get("work:1")?.doc_ids).toEqual([doc.doc_id]);
  });

  it("preserves independent PDFs through Work identity merge and Library rebuild", async () => {
    const paths = project();
    const firstWorkId = "doi:10.4242/shared-pdf-identity";
    const secondWorkId = "arxiv:2609.00001";
    const sharedTitle = "Shared PDF Work identity";
    const firstWork = {
      ...emptyWork(firstWorkId),
      doi: "10.4242/shared-pdf-identity",
      title: sharedTitle,
    };
    const secondWork = { ...emptyWork(secondWorkId), arxiv_id: "2609.00001", title: sharedTitle };
    const store = new LibraryStore([firstWork, secondWork]);
    store.save(paths);
    const sameBytes = Buffer.from("same PDF bytes in different Works");
    const firstPdf = publish(
      paths,
      "pdf-72345678-1234-4234-8234-123456789abc",
      firstWorkId,
      sameBytes
    );
    const secondPdf = publish(
      paths,
      "pdf-82345678-1234-4234-8234-123456789abc",
      secondWorkId,
      sameBytes
    );
    expect(secondPdf.doc_id).not.toBe(firstPdf.doc_id);
    expect(statSync(join(paths.outputDir, firstPdf.doc_id, "original.pdf")).ino).not.toBe(
      statSync(join(paths.outputDir, secondPdf.doc_id, "original.pdf")).ino
    );

    const merge = LibraryStore.load(paths);
    const survivor = merge.upsert({
      ...emptyWork("merge-bridge"),
      doi: "10.4242/shared-pdf-identity",
      arxiv_id: "2609.00001",
      title: sharedTitle,
    });
    expect(survivor.id).toBe(firstWorkId);
    merge.saveJson(paths);
    const sources = {
      ads: {
        status: "no-token" as const,
        resolve: async () => null,
        exportBibtex: async () => null,
      },
      crossref: { resolve: async () => null },
      oa: { resolve: async () => null },
    };
    await rebuild(paths, { sources });
    const rebuilt = LibraryStore.load(paths);
    expect(rebuilt.works.map((work) => work.id)).toEqual([firstWorkId]);
    expect(rebuilt.get(firstWorkId)?.doc_ids).toEqual([firstPdf.doc_id, secondPdf.doc_id]);
    expect(readVerifiedPdf(paths, firstPdf.doc_id)).toEqual(sameBytes);
    expect(readVerifiedPdf(paths, secondPdf.doc_id)).toEqual(sameBytes);
  });

  it("preserves an existing Doc and removes staging when the publication rename fails", () => {
    const paths = project();
    const originalBytes = Buffer.from("original user PDF");
    const original = publish(
      paths,
      "pdf-32345678-1234-4234-8234-123456789abc",
      "work:1",
      originalBytes
    );
    const oldLibrary = readFileSync(paths.libraryJson);
    const oldAnnotation = readFileSync(join(paths.outputDir, original.doc_id, "annotations.json"));
    const candidateId = "pdf-42345678-1234-4234-8234-123456789abc";
    const candidateDir = join(paths.outputDir, candidateId);
    failRenameTo(candidateDir, () => {
      expect(() => publish(paths, candidateId, "work:1", Buffer.from("new PDF"))).toThrow(
        /injected rename failure/
      );
    });
    expect(existsSync(candidateDir)).toBe(false);
    expect(readdirSync(paths.outputDir).some((name) => name.startsWith(".pdf-stage-"))).toBe(false);
    expect(readFileSync(paths.libraryJson)).toEqual(oldLibrary);
    expect(readFileSync(join(paths.outputDir, original.doc_id, "original.pdf"))).toEqual(
      originalBytes
    );
    expect(readFileSync(join(paths.outputDir, original.doc_id, "annotations.json"))).toEqual(
      oldAnnotation
    );
    expect(LibraryStore.load(paths).get("work:1")?.doc_ids).toEqual([original.doc_id]);
  });

  it("keeps Library and prior user files when the Library JSON rename fails after staging", () => {
    const paths = project();
    const originalBytes = Buffer.from("original user PDF");
    const original = publish(
      paths,
      "pdf-52345678-1234-4234-8234-123456789abc",
      "work:1",
      originalBytes
    );
    const oldLibrary = readFileSync(paths.libraryJson);
    const oldBib = readFileSync(paths.libraryBib);
    const oldAnnotation = readFileSync(join(paths.outputDir, original.doc_id, "annotations.json"));
    const candidateId = "pdf-62345678-1234-4234-8234-123456789abc";
    failRenameTo(paths.libraryJson, () => {
      expect(() =>
        publish(paths, candidateId, "work:1", Buffer.from("unattached candidate"))
      ).toThrow(/injected rename failure/);
    });
    const candidateDir = join(paths.outputDir, candidateId);
    expect(existsSync(join(candidateDir, "original.pdf"))).toBe(true);
    expect(readFileSync(paths.libraryJson)).toEqual(oldLibrary);
    expect(existsSync(`${paths.libraryJson}.tmp`)).toBe(false);
    expect(readFileSync(paths.libraryBib)).toEqual(oldBib);
    expect(readFileSync(join(paths.outputDir, original.doc_id, "original.pdf"))).toEqual(
      originalBytes
    );
    expect(readFileSync(join(paths.outputDir, original.doc_id, "annotations.json"))).toEqual(
      oldAnnotation
    );
    const afterBuild = seedFromOutput(LibraryStore.load(paths), paths.outputDir);
    expect(afterBuild.get("work:1")?.doc_ids).toEqual([original.doc_id]);
  });

  it("fails closed when published bytes no longer match the pinned hash", () => {
    const paths = project();
    const bytes = Buffer.from("original");
    const doc = publishPdfDoc(paths, {
      docId: "pdf-22345678-1234-4234-8234-123456789abc",
      workId: "work:1",
      filename: "paper.pdf",
      bytes,
      pages: [{ width: 612, height: 792, rotation: 0 }],
    });
    const path = join(paths.outputDir, doc.doc_id, "original.pdf");
    const original = readFileSync(path);
    // The binding is checked against bytes on disk; tests mutate only an isolated temp project.
    writeFileSync(path, "different");
    expect(() => readVerifiedPdf(paths, doc.doc_id)).toThrow(/content changed/);
    expect(readFileSync(join(paths.outputDir, doc.doc_id, `${doc.doc_id}.json`), "utf8")).toContain(
      doc.sha256
    );
    expect(original.toString()).toBe("original");
  });
});
