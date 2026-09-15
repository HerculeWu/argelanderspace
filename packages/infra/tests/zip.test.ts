/**
 * zip writer (Stage 10 M3): round-trip through our own dependency-free
 * extractor (`unzip.ts`) — bytes in, same bytes out, UTF-8 names kept.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { extractZip } from "../src/lib/unzip.js";
import { zipEntries } from "../src/lib/zip.js";

const dir = mkdtempSync(join(tmpdir(), "zip-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("zipEntries", () => {
  it("round-trips text and binary members through extractZip", () => {
    const tex = "\\documentclass{report}\n\\begin{document}\nHi 中文\n\\end{document}\n";
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x7f]);
    const zip = zipEntries([
      { name: "manuscript.tex", data: tex },
      { name: "references.bib", data: "@article{a, title={T}}\n" },
      { name: "assets/fig 1.png", data: png },
    ]);
    extractZip(zip, dir);
    expect(readFileSync(join(dir, "manuscript.tex"), "utf8")).toBe(tex);
    expect(readFileSync(join(dir, "references.bib"), "utf8")).toBe("@article{a, title={T}}\n");
    expect(new Uint8Array(readFileSync(join(dir, "assets/fig 1.png")))).toEqual(png);
  });

  it("writes a structurally valid archive (magic + counts)", () => {
    const zip = zipEntries([{ name: "a.txt", data: "a" }], new Date("2026-09-15T12:00:00Z"));
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const eocdAt = zip.length - 22;
    expect(zip.readUInt32LE(eocdAt)).toBe(0x06054b50);
    expect(zip.readUInt16LE(eocdAt + 10)).toBe(1);
  });

  it("an empty entry list is a valid empty archive", () => {
    const zip = zipEntries([]);
    expect(zip.length).toBe(22);
    extractZip(zip, dir); // must not throw
  });
});
