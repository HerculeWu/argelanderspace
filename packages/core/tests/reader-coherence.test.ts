import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoherentAnnotationsReadSchema, type TexDocIr } from "@argelanderspace/contracts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  annotationsArchiveDir,
  annotationsCurrentPath,
  docContentFingerprint,
  docContentProjection,
  ensureCurrentAnnotations,
  ensureCurrentAnnotationsWithDocument,
  saveAnnotationsFile,
} from "../src/annotations/store.js";

let dataDir: string;
let docDir: string;
let asset: string;
let ir: TexDocIr;
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const persist = () => fs.writeFileSync(join(docDir, "demo.json"), JSON.stringify(ir));
function section() {
  const first = ir.sections[0];
  if (!first) throw new Error("missing synthetic section");
  return first;
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(join(tmpdir(), "coherent-core-"));
  docDir = join(dataDir, "output", "demo");
  asset = join(docDir, "assets", "a.svg");
  fs.mkdirSync(join(docDir, "assets"), { recursive: true });
  fs.writeFileSync(asset, "asset A");
  ir = {
    version: 1,
    docId: "demo",
    sections: [
      {
        id: "s",
        level: 1,
        heading: "Heading",
        children: [],
        blocks: [
          { id: "p", type: "paragraph", segments: [{ type: "text", text: "Body" }] },
          { id: "f", type: "figure", imgPath: "a.svg" },
          { id: "t", type: "table", imgPath: "a.svg" },
          { id: "empty", type: "figure" },
        ],
      },
    ],
    refsManifest: [],
    bib: [],
    citationsByBlock: {},
    source: { type: "latex", origin: "/tmp/synthetic", main_tex: "main.tex" },
    meta: { title: "Synthetic", authors: ["Test Author"] },
  };
  persist();
});
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("coherent projection is the frozen legacy serialization; ephemeral, then idempotent", () => {
  const projection = [
    ["section", "s", 1, null, "Heading"],
    ["paragraph", "p", "Body"],
    ["figure", "f", null, null, null, null, digest("asset A")],
    ["table", "t", null, null, null, null, null, digest("asset A")],
    ["figure", "empty", null, null, null, null, null],
  ];
  expect(docContentProjection(ir, { docDir })).toEqual(projection);
  const expected = digest(JSON.stringify(projection));
  expect(expected).toBe("3c4b3ef0316c99101ed225a85dbcfe0bf3f06498cc588a65bf0dabdb3f10d653");
  const result = ensureCurrentAnnotationsWithDocument(dataDir, "demo");
  expect(result.file.content_fingerprint).toBe(expected);
  expect(docContentFingerprint(ir, { docDir })).toBe(expected);
  expect(result.assets).toEqual([{ imgPath: "a.svg", sha256: digest("asset A") }]);
  expect(result.ir).toEqual(ir);
  expect(CoherentAnnotationsReadSchema.parse({ version: 1, ...result }).ir.meta).toEqual(ir.meta);
  expect(fs.existsSync(annotationsCurrentPath(dataDir, "demo"))).toBe(false);
  saveAnnotationsFile(dataDir, "demo", { ...result.file, rev: 7 });
  expect(ensureCurrentAnnotationsWithDocument(dataDir, "demo").file.rev).toBe(7);
  expect(fs.existsSync(annotationsArchiveDir(dataDir, "demo"))).toBe(false);
});

test("manifest and repeated block hashes use ONE read buffer even if the path changes on read", () => {
  const expected = docContentFingerprint(ir, { docDir });
  const original = fs.readFileSync;
  let reads = 0;
  vi.spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof original>) => {
    const bytes = original(...args);
    if (String(args[0]) === asset) {
      reads += 1;
      fs.writeFileSync(asset, "asset B");
    }
    return bytes;
  }) as typeof original);
  syncBuiltinESMExports();
  const result = ensureCurrentAnnotationsWithDocument(dataDir, "demo");
  expect(reads).toBe(1);
  expect(result.file.content_fingerprint).toBe(expected);
  expect(result.assets).toEqual([{ imgPath: "a.svg", sha256: digest("asset A") }]);
  reads = 0;
  docContentFingerprint(ir, { docDir });
  expect(reads).toBe(2); // Legacy read counts deliberately remain unchanged.
});

test("metadata/size changes return new full IR with the same fingerprint", () => {
  const first = ensureCurrentAnnotationsWithDocument(dataDir, "demo");
  ir.meta.title = "Changed title";
  ir.title = "Changed render title";
  const block = ir.sections[0]?.blocks[1];
  if (block?.type === "figure") {
    block.imgWidth = 123;
    block.imgHeight = 456;
  }
  persist();
  const next = ensureCurrentAnnotationsWithDocument(dataDir, "demo");
  expect(next.file).toEqual(first.file);
  expect(next.ir).toEqual(ir);
  expect(next.ir).not.toEqual(first.ir);
});

test("server identity rejection precedes archive; legacy ensure keeps its prior behavior", () => {
  const first = ensureCurrentAnnotationsWithDocument(dataDir, "demo");
  saveAnnotationsFile(dataDir, "demo", first.file);
  const before = fs.readFileSync(annotationsCurrentPath(dataDir, "demo"));
  ir.docId = "different";
  section().heading = "Changed";
  persist();
  expect(() => ensureCurrentAnnotationsWithDocument(dataDir, "demo")).toThrow(/doc id mismatch/);
  expect(fs.readFileSync(annotationsCurrentPath(dataDir, "demo"))).toEqual(before);
  expect(fs.existsSync(annotationsArchiveDir(dataDir, "demo"))).toBe(false);
  expect(ensureCurrentAnnotations(dataDir, "demo").invalidated).toBe(true);
});

test("server rejects stable outside symlink while legacy hash/error rules remain frozen", () => {
  const expected = docContentFingerprint(ir, { docDir });
  const outside = join(dataDir, "outside.svg");
  fs.renameSync(asset, outside);
  fs.symlinkSync(outside, asset);
  expect(docContentFingerprint(ir, { docDir })).toBe(expected);
  expect(() => ensureCurrentAnnotationsWithDocument(dataDir, "demo")).toThrow(/symlink/);
  fs.unlinkSync(asset);
  expect(() => docContentFingerprint(ir, { docDir })).toThrow(
    `annotations fingerprint: cannot read asset "a.svg" (${asset}): ENOENT: no such file or directory, stat '${asset}'`
  );
});
