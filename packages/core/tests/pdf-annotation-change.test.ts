import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PdfAnnotationsFile } from "@argelanderspace/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { emptyWork, type LibraryPaths, LibraryStore } from "../src/library/store.js";
import {
  commitPdfAnnotationChange,
  PdfAnnotationValidationError,
  publishPdfDoc,
  readPdfAnnotationsFile,
} from "../src/pdf-storage.js";

// copilot ticket 21: the narrow, expected-state change the Copilot's PDF annotation writes commit through.
const dirs: string[] = [];
function project() {
  const root = mkdtempSync(join(tmpdir(), "pdf-change-"));
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
  new LibraryStore([emptyWork("work:1")]).save(paths);
  const bytes = Buffer.from("synthetic verified pdf");
  const metadata = publishPdfDoc(paths, {
    docId: "pdf-1",
    workId: "work:1",
    filename: "paper.pdf",
    bytes,
    pages: [{ width: 612, height: 792, rotation: 0 }],
  });
  const file = join(paths.outputDir, "pdf-1", "annotations.json");
  return {
    paths,
    sha: metadata.sha256,
    file,
    original: join(paths.outputDir, "pdf-1", "original.pdf"),
  };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const at = "2026-10-05T10:00:00.000Z";
const note = (id: string) => ({
  id,
  kind: "document_comment" as const,
  body: id,
  created_at: at,
  updated_at: at,
});
const add = () => (current: PdfAnnotationsFile) => ({
  next: [...current.annotations, note(`n${current.annotations.length}`)],
});

describe("commitPdfAnnotationChange", () => {
  it("writes the next list as a new revision and keeps every key it does not know", () => {
    const { paths, sha, file } = project();
    const stored = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...stored, x_unknown: { keep: true } }, null, 2));
    const result = commitPdfAnnotationChange(paths, "pdf-1", { sha256: sha, rev: 0 }, add());
    expect(result.kind).toBe("saved");
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.rev).toBe(1);
    expect(onDisk.x_unknown).toEqual({ keep: true });
    expect(onDisk.annotations.map((a: { id: string }) => a.id)).toEqual(["n0"]);
    expect(readPdfAnnotationsFile(paths, "pdf-1").rev).toBe(1);
  });

  it("refuses a stale revision, another original and a busy Doc without touching the file", () => {
    const { paths, sha, file } = project();
    const before = readFileSync(file);
    expect(commitPdfAnnotationChange(paths, "pdf-1", { sha256: sha, rev: 5 }, add())).toEqual({
      kind: "rev_mismatch",
      rev: 0,
    });
    expect(
      commitPdfAnnotationChange(paths, "pdf-1", { sha256: "b".repeat(64), rev: 0 }, add())
    ).toEqual({
      kind: "document_changed",
    });
    expect(
      commitPdfAnnotationChange(paths, "pdf-1", { sha256: sha, rev: 0 }, add(), () => true)
    ).toEqual({
      kind: "busy",
    });
    expect(readFileSync(file)).toEqual(before);
  });

  it("skips when the build has nothing to write, and the revision does not move", () => {
    const { paths, sha, file } = project();
    const before = readFileSync(file);
    const result = commitPdfAnnotationChange(paths, "pdf-1", { sha256: sha, rev: 0 }, () => ({
      skip: "same",
    }));
    expect(result).toMatchObject({ kind: "skipped", value: "same" });
    expect(readFileSync(file)).toEqual(before);
  });

  it("a changed original is document_changed and a damaged sidecar is an error that keeps its bytes", () => {
    const { paths, sha, file, original } = project();
    const before = readFileSync(file);
    writeFileSync(original, Buffer.from("not the pinned bytes at all!"));
    expect(commitPdfAnnotationChange(paths, "pdf-1", { sha256: sha, rev: 0 }, add())).toEqual({
      kind: "document_changed",
    });
    expect(readFileSync(file)).toEqual(before);
    // restore the original bytes, damage the sidecar
    writeFileSync(original, Buffer.from("synthetic verified pdf"));
    expect(createHash("sha256").update(readFileSync(original)).digest("hex")).toBe(sha);
    const damaged = Buffer.from("{ not json");
    writeFileSync(file, damaged);
    expect(() =>
      commitPdfAnnotationChange(paths, "pdf-1", { sha256: sha, rev: 0 }, add())
    ).toThrow();
    expect(readFileSync(file)).toEqual(damaged);
  });

  it("a list that breaks the contract (a page outside the document, a duplicate id) writes nothing", () => {
    const { paths, sha, file } = project();
    const before = readFileSync(file);
    const outside = {
      id: "p",
      kind: "page_comment" as const,
      page_index: 9,
      body: "b",
      created_at: at,
      updated_at: at,
    };
    expect(() =>
      commitPdfAnnotationChange(paths, "pdf-1", { sha256: sha, rev: 0 }, () => ({
        next: [outside],
      }))
    ).toThrow();
    expect(() =>
      commitPdfAnnotationChange(paths, "pdf-1", { sha256: sha, rev: 0 }, () => ({
        next: [note("d"), note("d")],
      }))
    ).toThrow();
    expect(readFileSync(file)).toEqual(before);
  });

  it("refuses a list that changes what is immutable about a stored annotation (kind, creation time, page, text target)", () => {
    const { paths, sha, file } = project();
    expect(
      commitPdfAnnotationChange(paths, "pdf-1", { sha256: sha, rev: 0 }, () => ({
        next: [note("keep")],
      })).kind
    ).toBe("saved");
    const before = readFileSync(file);
    const bad = (change: (a: ReturnType<typeof note>) => object) => () =>
      commitPdfAnnotationChange(paths, "pdf-1", { sha256: sha, rev: 1 }, (current) => ({
        next: current.annotations.map((a) =>
          change(a as ReturnType<typeof note>)
        ) as PdfAnnotationsFile["annotations"],
      }));
    expect(bad((a) => ({ ...a, created_at: "2030-01-01T00:00:00.000Z" }))).toThrow(
      PdfAnnotationValidationError
    );
    expect(bad((a) => ({ ...a, kind: "page_comment", page_index: 0 }))).toThrow(
      PdfAnnotationValidationError
    );
    expect(readFileSync(file)).toEqual(before);
  });
});
