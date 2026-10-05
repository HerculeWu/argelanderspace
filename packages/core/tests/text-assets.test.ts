import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyWork, type LibraryPaths, LibraryStore } from "../src/library/store.js";
import {
  addTextAsset,
  assetStem,
  readTextAsset,
  sniffImage,
  TextAssetError,
} from "../src/text-assets.js";
import { createTextDoc, readTextSource, saveTextSource } from "../src/text-docs.js";

// ---- tiny synthetic images (header + trailer are all the sniffer needs) ---------------------------------------------
function png(width = 4, height = 3, extra = 0): Buffer {
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
    Buffer.alloc(extra, 7),
    Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
  ]);
}
function jpeg(width = 5, height = 6): Buffer {
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(17, 0);
  sof[2] = 8;
  sof.writeUInt16BE(height, 3);
  sof.writeUInt16BE(width, 5);
  sof[7] = 3;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46]),
    Buffer.from([0xff, 0xc0]),
    sof,
    Buffer.from([0xff, 0xd9]),
  ]);
}
function webp(width = 7, height = 8): Buffer {
  const body = Buffer.alloc(18);
  body[0] = 0; // flags
  body.writeUIntLE(width - 1, 4, 3);
  body.writeUIntLE(height - 1, 7, 3);
  const chunk = Buffer.concat([
    Buffer.from("VP8X"),
    Buffer.from([10, 0, 0, 0]),
    body.subarray(0, 10),
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(4 + chunk.length);
  return Buffer.concat([Buffer.from("RIFF"), size, Buffer.from("WEBP"), chunk]);
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
function project(): { paths: LibraryPaths; docId: string } {
  const root = mkdtempSync(join(tmpdir(), "text-assets-"));
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
  const docId = createTextDoc(paths, { operationId: "op-aaaaaaaa", workId: "work:1" }).docId;
  return { paths, docId };
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("image sniffing by bytes (ticket 27)", () => {
  it("reads type and size from PNG, JPEG and WebP headers", () => {
    expect(sniffImage(png(40, 30))).toMatchObject({
      mediaType: "image/png",
      ext: "png",
      width: 40,
      height: 30,
    });
    expect(sniffImage(jpeg(50, 60))).toMatchObject({
      mediaType: "image/jpeg",
      ext: "jpg",
      width: 50,
      height: 60,
    });
    expect(sniffImage(webp(70, 80))).toMatchObject({
      mediaType: "image/webp",
      ext: "webp",
      width: 70,
      height: 80,
    });
  });

  it.each([
    ["an empty file", Buffer.alloc(0), "empty"],
    [
      "an SVG with a script",
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      "unsupported_type",
    ],
    ["an HTML page", Buffer.from("<html><script>1</script></html>"), "unsupported_type"],
    ["a GIF", Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;"), "unsupported_type"],
    ["a PDF", Buffer.from("%PDF-1.4\n"), "unsupported_type"],
    ["a truncated PNG", png().subarray(0, 30), "corrupt_image"],
    ["a PNG without its end", png().subarray(0, png().length - 5), "corrupt_image"],
    ["a truncated JPEG", jpeg().subarray(0, 10), "corrupt_image"],
    [
      "a JPEG whose bytes are cut before the end marker",
      Buffer.concat([jpeg().subarray(0, 12), Buffer.from([0xff, 0xd9])]),
      "corrupt_image",
    ],
    ["a truncated WebP", webp().subarray(0, 20), "corrupt_image"],
    ["a PNG of 40000x40000 pixels", png(40000, 40000), "too_many_pixels"],
    ["a PNG of 9000x9000 (81 MP) pixels", png(9000, 9000), "too_many_pixels"],
    ["a zero-sized PNG", png(0, 5), "corrupt_image"],
  ])("refuses %s", (_name, bytes, code) => {
    expect(() => sniffImage(bytes)).toThrow(expect.objectContaining({ code }));
  });

  it("refuses more than 20 MiB before looking at anything else", () => {
    expect(() => sniffImage(png(4, 3, 20 * 1024 * 1024))).toThrow(
      expect.objectContaining({ code: "too_large" })
    );
  });
});

describe("file names", () => {
  it("makes a safe stem and refuses paths", () => {
    expect(assetStem("Shear Profile (v2).PNG")).toBe("Shear-Profile-v2");
    expect(assetStem("图.png")).toBe("image");
    expect(assetStem(undefined)).toBe("image");
    for (const bad of [
      "../a.png",
      "a/b.png",
      "a\\b.png",
      ".hidden.png",
      "/etc/passwd",
      "C:evil.png",
      "a\0b.png",
      "..png",
    ])
      expect(() => assetStem(bad), bad).toThrow(expect.objectContaining({ code: "bad_name" }));
  });
});

describe("adding an asset to a text Doc (ticket 27)", () => {
  it("writes a controlled new file, bumps rev once and registers type, size and hash", () => {
    const { paths, docId } = project();
    const bytes = png(40, 30);
    const r = addTextAsset(paths, docId, { expectedRev: 0, bytes, filename: "Shear Profile.png" });
    expect(r.kind).toBe("added");
    if (r.kind !== "added") return;
    expect(r.asset).toEqual({
      name: `Shear-Profile-${sha(bytes).slice(0, 8)}.png`,
      sha256: sha(bytes),
      byte_length: bytes.length,
      media_type: "image/png",
      width: 40,
      height: 30,
    });
    expect(readTextSource(paths, docId)).toMatchObject({ rev: 1, assets: [r.asset] });
    expect(readFileSync(join(paths.outputDir, docId, "assets", r.asset.name))).toEqual(bytes);
    expect(readTextAsset(paths, docId, r.asset)).toEqual(bytes);
  });

  it("the extension comes from the bytes, not the name: a PNG called .svg or .jpg is stored as .png", () => {
    const { paths, docId } = project();
    const a = addTextAsset(paths, docId, { expectedRev: 0, bytes: png(), filename: "evil.svg" });
    expect(a.kind === "added" && a.asset.name.endsWith(".png")).toBe(true);
  });

  it("L2: re-uploading registered bytes whose file is gone or damaged restores the file (damaged bytes are kept aside), rev unchanged", () => {
    const { paths, docId } = project();
    const bytes = png(4, 3);
    const one = addTextAsset(paths, docId, { expectedRev: 0, bytes, filename: "fig.png" });
    if (one.kind !== "added") throw new Error("not added");
    const file = join(paths.outputDir, docId, "assets", one.asset.name);
    // intact: plainly reused
    const intact = addTextAsset(paths, docId, { expectedRev: 1, bytes });
    expect(intact).toMatchObject({ kind: "reused", restored: false });
    // missing: written again
    rmSync(file);
    const missing = addTextAsset(paths, docId, { expectedRev: 1, bytes });
    expect(missing).toMatchObject({ kind: "reused", restored: true });
    expect(readFileSync(file)).toEqual(bytes);
    // damaged: the bad bytes are moved aside, never deleted or overwritten, and the file is written again
    writeFileSync(file, "DAMAGED");
    const damaged = addTextAsset(paths, docId, { expectedRev: 1, bytes });
    expect(damaged).toMatchObject({ kind: "reused", restored: true });
    expect(readFileSync(file)).toEqual(bytes);
    const kept = readdirSync(join(paths.outputDir, docId, "assets")).filter((n) =>
      n.includes(".damaged-")
    );
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(paths.outputDir, docId, "assets", kept[0] as string), "utf8")).toBe(
      "DAMAGED"
    );
    expect(readTextSource(paths, docId).rev).toBe(1);
  });

  it("the same bytes again are reused without a new file or revision; a changed image is a NEW name and the old file stays", () => {
    const { paths, docId } = project();
    const one = addTextAsset(paths, docId, {
      expectedRev: 0,
      bytes: png(4, 3),
      filename: "fig.png",
    });
    const again = addTextAsset(paths, docId, {
      expectedRev: 1,
      bytes: png(4, 3),
      filename: "other-name.png",
    });
    expect(again.kind).toBe("reused");
    expect(readTextSource(paths, docId).rev).toBe(1);
    const next = addTextAsset(paths, docId, {
      expectedRev: 1,
      bytes: png(5, 3),
      filename: "fig.png",
    });
    expect(next.kind).toBe("added");
    if (one.kind !== "added" || next.kind !== "added") return;
    expect(next.asset.name).not.toBe(one.asset.name);
    expect(readdirSync(join(paths.outputDir, docId, "assets")).sort()).toEqual(
      [one.asset.name, next.asset.name].sort()
    );
    expect(readTextSource(paths, docId)).toMatchObject({ rev: 2 });
  });

  it("never overwrites an existing file: a pre-existing unregistered file of the target name stops the add", () => {
    const { paths, docId } = project();
    const bytes = png(4, 3);
    const name = `fig-${sha(bytes).slice(0, 8)}.png`;
    mkdirSync(join(paths.outputDir, docId, "assets"));
    writeFileSync(join(paths.outputDir, docId, "assets", name), "KEEP ME");
    expect(() =>
      addTextAsset(paths, docId, { expectedRev: 0, bytes, filename: "fig.png" })
    ).toThrow(expect.objectContaining({ code: "write_failed" }));
    expect(readFileSync(join(paths.outputDir, docId, "assets", name), "utf8")).toBe("KEEP ME");
    expect(readTextSource(paths, docId).rev).toBe(0);
  });

  it("a stale expectedRev is a conflict and writes nothing", () => {
    const { paths, docId } = project();
    saveTextSource(paths, docId, { expectedRev: 0, markdown: "x" });
    const r = addTextAsset(paths, docId, { expectedRev: 0, bytes: png() });
    expect(r.kind).toBe("conflict");
    expect(existsSync(join(paths.outputDir, docId, "assets"))).toBe(false);
  });

  it("a failing source write removes the image it just created (and the source keeps its bytes)", () => {
    const { paths, docId } = project();
    const sourceFile = join(paths.outputDir, docId, "text-source.json");
    const before = readFileSync(sourceFile);
    // the temp file cannot be created: a directory sits where `.tmp` must go
    mkdirSync(`${sourceFile}.tmp`);
    expect(() =>
      addTextAsset(paths, docId, { expectedRev: 0, bytes: png(), filename: "a.png" })
    ).toThrow(TextAssetError);
    expect(readFileSync(sourceFile)).toEqual(before);
    expect(readdirSync(join(paths.outputDir, docId, "assets"))).toEqual([]);
  });

  it("refuses a symlinked assets directory and hostile names", () => {
    const { paths, docId } = project();
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    dirs.push(outside);
    symlinkSync(outside, join(paths.outputDir, docId, "assets"));
    expect(() => addTextAsset(paths, docId, { expectedRev: 0, bytes: png() })).toThrow(
      expect.objectContaining({ code: "unsafe" })
    );
    expect(readdirSync(outside)).toEqual([]);
    const second = project();
    expect(() =>
      addTextAsset(second.paths, second.docId, {
        expectedRev: 0,
        bytes: png(),
        filename: "../../escape.png",
      })
    ).toThrow(expect.objectContaining({ code: "bad_name" }));
  });

  it("a registered asset whose file changed is detected by hash when read", () => {
    const { paths, docId } = project();
    const r = addTextAsset(paths, docId, { expectedRev: 0, bytes: png() });
    if (r.kind !== "added") throw new Error("not added");
    const file = join(paths.outputDir, docId, "assets", r.asset.name);
    chmodSync(file, 0o644);
    writeFileSync(file, png(9, 9));
    expect(() => readTextAsset(paths, docId, r.asset)).toThrow(
      expect.objectContaining({ code: "corrupt_image" })
    );
  });

  it("bounds the number of assets", () => {
    const { paths, docId } = project();
    for (let i = 0; i < 3; i += 1)
      addTextAsset(paths, docId, { expectedRev: i, bytes: png(10 + i, 3) });
    expect(readTextSource(paths, docId).assets).toHaveLength(3);
  });
});
