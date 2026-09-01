/**
 * `ingestLatexZip` (Stage 3.1 MS2): unpack a user-supplied LaTeX source zip
 * with `extractZip` into `<outRoot>/<docId>/src` and ingest it in directory
 * mode under the pinned doc id. Also covers the `acquireSource` docId
 * short-circuit the upload path relies on.
 *
 * The end-to-end half needs pandoc (same `HAVE_PANDOC` gating idiom as
 * arxiv-source.test.ts); the acquire half is pure fs.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ArxivFetcher, acquireSource } from "../src/latex/arxiv-source.js";
import { ASTRO_BIN_HINT, havePandoc } from "../src/latex/pandoc.js";
import { ingestLatexZip } from "../src/latex/pipeline.js";

const FIXTURES = fileURLToPath(new URL("fixtures", import.meta.url));

if (!havePandoc() && existsSync(`${ASTRO_BIN_HINT}/pandoc`)) {
  process.env.PATH = `${ASTRO_BIN_HINT}${delimiter}${process.env.PATH ?? ""}`;
}
const PANDOC = havePandoc();

/**
 * Build a minimal real zip (stored entries; CRC fields zeroed — `extractZip`
 * never verifies them). Keeps the tests free of any archiving dependency.
 */
function makeZip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 8); // method 0 = stored
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 10); // method
    central.writeUInt32LE(data.length, 20); // compressed size
    central.writeUInt32LE(data.length, 24); // uncompressed size
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42); // local header offset
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const count = Object.keys(entries).length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test("acquireSource: a fixed docId short-circuits docIdFor (directory mode)", async () => {
  const root = mkdtempSync(join(tmpdir(), "acquire-docid-"));
  const srcDir = join(root, "my-paper-src");
  writeFileSync(join(root, "main-src.tex"), "x"); // noise
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(
    join(srcDir, "main.tex"),
    "\\documentclass{article}\n\\begin{document}\nHi.\n\\end{document}\n"
  );
  const fetcher = new ArxivFetcher(join(root, "cache"), { userAgent: "test" });
  const src = await acquireSource(srcDir, join(root, "out"), {
    fetcher,
    docId: "upload-fixed-id-a1b2c3",
  });
  expect(src.docId).toBe("upload-fixed-id-a1b2c3");
  expect(src.srcDir).toBe(srcDir); // used in place
  expect(src.mainTex).toBe(join(srcDir, "main.tex"));
  // and the default path still derives from the directory basename
  const derived = await acquireSource(srcDir, join(root, "out"), { fetcher });
  expect(derived.docId).toBe("latex-my-paper-src");
});

describe.skipIf(!PANDOC)("ingestLatexZip (extractZip + directory-mode pipeline)", () => {
  test("unpacks under the pinned doc id and ingests; a re-upload overwrites", async () => {
    const root = mkdtempSync(join(tmpdir(), "latex-zip-"));
    const outRoot = join(root, "out");
    const docId = "upload-work-some-paper-012345";
    const tex = readFileSync(join(FIXTURES, "sample_latex.tex"), "utf8");
    const zipPath = join(root, "src.zip");
    writeFileSync(zipPath, makeZip({ "project/main.tex": tex }));

    const progress: string[] = [];
    const doc = await ingestLatexZip(zipPath, {
      outRoot,
      docId,
      config: { downloadAssets: false, useCache: false, requestDelay: 0 },
      onProgress: (m) => progress.push(m),
    });
    expect(doc.doc_id).toBe(docId);
    expect(doc.meta?.title ?? "").toContain("Sample LaTeX Paper");
    expect(progress).toEqual(["Ingesting LaTeX source"]);
    // the tree landed at <outRoot>/<docId>/src and the json next to it
    expect(existsSync(join(outRoot, docId, "src", "project", "main.tex"))).toBe(true);
    expect(existsSync(join(outRoot, docId, `${docId}.json`))).toBe(true);

    // a re-upload with a retitled source: same doc id, stale tree cleared
    writeFileSync(
      zipPath,
      makeZip({ "main.tex": tex.replace("A Sample LaTeX Paper", "A Retitled Paper v2") })
    );
    const doc2 = await ingestLatexZip(zipPath, {
      outRoot,
      docId,
      config: { downloadAssets: false, useCache: false, requestDelay: 0 },
    });
    expect(doc2.doc_id).toBe(docId);
    expect(doc2.meta?.title ?? "").toContain("Retitled Paper v2");
    // the first upload's nested path is gone (the src dir was cleared first)
    expect(existsSync(join(outRoot, docId, "src", "project"))).toBe(false);
    expect(existsSync(join(outRoot, docId, "src", "main.tex"))).toBe(true);
  });

  test("a zip without any .tex fails loudly", async () => {
    const root = mkdtempSync(join(tmpdir(), "latex-zip-notex-"));
    const zipPath = join(root, "src.zip");
    writeFileSync(zipPath, makeZip({ "README.md": "no tex here" }));
    await expect(
      ingestLatexZip(zipPath, { outRoot: join(root, "out"), docId: "upload-x-000000" })
    ).rejects.toThrow("no .tex file found");
  });
});
