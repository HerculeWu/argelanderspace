/**
 * arXiv id/URL detection tests — port of `test_latex_arxiv_detection` from
 * `<repo>/tests/run_tests.py` (the functions under test live here in infra,
 * on the surviving acquisition layer `latex/arxiv-source.ts`).
 *
 * The pandoc-wired ingest smoke this file used to carry left with the pandoc
 * pipeline in MS3b; the new pipeline's end-to-end coverage lives in
 * `tex-*.test.ts` and the CLI smoke.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { arxivId, extractArxivSource, looksLikeArxiv } from "../src/latex/arxiv-source.js";

const FIXTURES = fileURLToPath(new URL("fixtures", import.meta.url));

describe("arxiv id/URL detection (test_latex_arxiv_detection)", () => {
  test("ids and URLs resolve", () => {
    expect(looksLikeArxiv("2501.17225")).toBe(true);
    expect(looksLikeArxiv("arXiv:2603.03522v2")).toBe(true);
    expect(looksLikeArxiv("https://arxiv.org/abs/1234.5678")).toBe(true);
    expect(looksLikeArxiv("astro-ph/0701001")).toBe(true);
    expect(looksLikeArxiv("paper.pdf")).toBe(false);
    expect(looksLikeArxiv("10.1051/0004-6361/123")).toBe(false);
    expect(arxivId("https://arxiv.org/pdf/2501.17225v2.pdf")).toBe("2501.17225v2");
  });
});

describe("extractArxivSource (surviving acquisition layer, tar safety)", () => {
  test("sample + single-file tarballs extract", () => {
    for (const f of ["eprint-sample.tar.gz", "eprint-single.tar.gz"]) {
      const dest = mkdtempSync(join(tmpdir(), "untar-"));
      expect(() => extractArxivSource(join(FIXTURES, f), dest)).not.toThrow();
    }
  });

  test("traversal members and symlinks are refused", () => {
    for (const f of ["eprint-evil.tar.gz", "eprint-symlink.tar.gz"]) {
      const dest = mkdtempSync(join(tmpdir(), "untar-"));
      expect(() => extractArxivSource(join(FIXTURES, f), dest)).toThrow(/corrupt|refusing|outside/);
    }
  });
});
