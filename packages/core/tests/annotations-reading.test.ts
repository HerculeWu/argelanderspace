/**
 * `readDocumentForReading` (copilot ticket 18): the background read behind the Copilot `reader` tool. It takes the
 * IR, the asset digests and the saved annotations in one pass like the server's coherent GET, but it is READ-ONLY:
 * no ensure, no archive, no new current, never the archive's content. Every data-protection branch of the
 * fingerprint contract is checked against disk bytes before and after.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnnotationsFile, TexDocIr } from "@argelanderspace/contracts";
import { describe, expect, it } from "vitest";
import {
  AnnotationsError,
  annotationsArchiveDir,
  annotationsCurrentPath,
  ensureCurrentAnnotations,
  readDocumentForReading,
} from "../src/annotations/store.js";

const DOC = "read-doc";
const tmp = () => mkdtempSync(join(tmpdir(), "annotations-reading-"));

const ir = (over: Partial<TexDocIr> = {}): TexDocIr => ({
  version: 1,
  docId: DOC,
  sections: [
    {
      id: "sec-1",
      level: 1,
      heading: "H",
      blocks: [
        { id: "p-1", type: "paragraph", segments: [{ type: "text", text: "Hello world" }] },
        { id: "fig-1", type: "figure", imgPath: "plot.svg" },
      ],
      children: [],
    },
  ],
  refsManifest: [],
  bib: [],
  citationsByBlock: {},
  source: { type: "latex", origin: "/tmp/src", main_tex: "main.tex" },
  meta: { title: "T" },
  ...over,
});
function write(dataDir: string, value: unknown, assets = true): string {
  const docDir = join(dataDir, "output", DOC);
  mkdirSync(join(docDir, "assets"), { recursive: true });
  writeFileSync(
    join(docDir, `${DOC}.json`),
    typeof value === "string" ? value : JSON.stringify(value)
  );
  if (assets) writeFileSync(join(docDir, "assets", "plot.svg"), "<svg>v1</svg>");
  return docDir;
}
const annotation = {
  id: "a_0000aaaa",
  target: { type: "document" as const },
  body: " my note ",
  created_at: "2026-09-10T10:00:00.000Z",
  updated_at: "2026-09-10T10:00:00.000Z",
};
function saveCurrent(dataDir: string, fingerprint: string, annotations = [annotation]): Buffer {
  const dir = join(dataDir, "annotations", DOC);
  mkdirSync(dir, { recursive: true });
  const file: AnnotationsFile = {
    version: 1,
    rev: 4,
    content_fingerprint: fingerprint,
    annotations,
  };
  writeFileSync(annotationsCurrentPath(dataDir, DOC), `${JSON.stringify(file, null, 2)}\n`);
  return readFileSync(annotationsCurrentPath(dataDir, DOC));
}
/** Every file under a directory with its bytes, to prove nothing was written, moved or created. */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[p.slice(root.length)] = readFileSync(p).toString("base64");
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof AnnotationsError ? error.code : "other";
  }
  return null;
};
const currentFingerprint = () => {
  // the fingerprint the document has now: a mismatching current is archived by ensure, so ask a scratch copy
  const scratch = tmp();
  write(scratch, ir());
  return ensureCurrentAnnotations(scratch, DOC).file.content_fingerprint;
};

describe("readDocumentForReading", () => {
  it("a matching current: the IR, the asset digests and the saved annotations of the same content, nothing written", () => {
    const dir = tmp();
    write(dir, ir());
    const fingerprint = currentFingerprint();
    saveCurrent(dir, fingerprint);
    const before = tree(dir);
    const read = readDocumentForReading(dir, DOC);
    expect(read.stale).toBe(false);
    expect(read.file.content_fingerprint).toBe(fingerprint);
    expect(read.file.rev).toBe(4);
    expect(read.file.annotations).toEqual([annotation]);
    expect(read.ir.docId).toBe(DOC);
    expect(read.assets).toEqual([
      { imgPath: "plot.svg", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    expect(tree(dir)).toEqual(before);
  });

  it("a different fingerprint is NOT archived: the old annotations are left out, current.json keeps its bytes, no archive appears", () => {
    const dir = tmp();
    write(dir, ir());
    const original = saveCurrent(dir, "e".repeat(64));
    const before = tree(dir);
    const read = readDocumentForReading(dir, DOC);
    expect(read.stale).toBe(true);
    expect(read.file.annotations).toEqual([]);
    expect(read.file.rev).toBe(0);
    expect(read.file.content_fingerprint).not.toBe("e".repeat(64));
    expect(readFileSync(annotationsCurrentPath(dir, DOC)).equals(original)).toBe(true);
    expect(existsSync(annotationsArchiveDir(dir, DOC))).toBe(false);
    expect(tree(dir)).toEqual(before);
  });

  it("never opens the archive: its notes are absent and its files unchanged", () => {
    const dir = tmp();
    write(dir, ir());
    saveCurrent(dir, currentFingerprint());
    const archive = annotationsArchiveDir(dir, DOC);
    mkdirSync(archive, { recursive: true });
    writeFileSync(
      join(archive, "20260901T000000000Z-ffffffff.json"),
      JSON.stringify({ annotations: [{ body: "ARCHIVED-SECRET" }] })
    );
    const before = tree(dir);
    const read = readDocumentForReading(dir, DOC);
    expect(JSON.stringify(read)).not.toContain("ARCHIVED-SECRET");
    expect(tree(dir)).toEqual(before);
  });

  it("no current.json: an empty file for the document, and nothing is created", () => {
    const dir = tmp();
    write(dir, ir());
    const before = tree(dir);
    const read = readDocumentForReading(dir, DOC);
    expect(read.stale).toBe(false);
    expect(read.file).toMatchObject({ rev: 0, annotations: [] });
    expect(existsSync(join(dir, "annotations"))).toBe(false);
    expect(tree(dir)).toEqual(before);
  });

  it("system errors are typed errors, never a mismatch, and leave every byte alone", () => {
    const missing = tmp();
    expect(codeOf(() => readDocumentForReading(missing, DOC))).toBe("not_found");

    const corrupt = tmp();
    write(corrupt, "{ not json");
    saveCurrent(corrupt, "e".repeat(64));
    let before = tree(corrupt);
    expect(codeOf(() => readDocumentForReading(corrupt, DOC))).toBe("corrupt_ir");
    expect(tree(corrupt)).toEqual(before);

    const legacy = tmp();
    write(legacy, { docId: DOC, sections: [] });
    expect(codeOf(() => readDocumentForReading(legacy, DOC))).toBe("corrupt_ir");

    const invalid = tmp();
    write(invalid, { ...ir(), sections: "nope" });
    expect(codeOf(() => readDocumentForReading(invalid, DOC))).toBe("corrupt_ir");

    const wrongId = tmp();
    write(wrongId, ir({ docId: "other" }));
    expect(codeOf(() => readDocumentForReading(wrongId, DOC))).toBe("corrupt_ir");

    const brokenStore = tmp();
    write(brokenStore, ir());
    mkdirSync(join(brokenStore, "annotations", DOC), { recursive: true });
    writeFileSync(annotationsCurrentPath(brokenStore, DOC), "{ broken");
    before = tree(brokenStore);
    expect(codeOf(() => readDocumentForReading(brokenStore, DOC))).toBe("corrupt_store");
    expect(tree(brokenStore)).toEqual(before);

    const noAsset = tmp();
    write(noAsset, ir(), false);
    saveCurrent(noAsset, "e".repeat(64));
    before = tree(noAsset);
    expect(codeOf(() => readDocumentForReading(noAsset, DOC))).toBe("fingerprint");
    expect(tree(noAsset)).toEqual(before);
    expect(existsSync(annotationsArchiveDir(noAsset, DOC))).toBe(false);
  });

  it("an IR that declares no image path has no assets (absence, not failure)", () => {
    const dir = tmp();
    write(dir, ir({ sections: [{ id: "sec-1", level: 1, blocks: [], children: [] }] }), false);
    expect(readDocumentForReading(dir, DOC).assets).toEqual([]);
  });
});
