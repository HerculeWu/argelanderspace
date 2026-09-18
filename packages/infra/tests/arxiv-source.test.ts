/**
 * arXiv id/URL detection tests — port of `test_latex_arxiv_detection` from
 * `<repo>/tests/run_tests.py` (the functions under test live here in infra,
 * on the surviving acquisition layer `latex/arxiv-source.ts`).
 *
 * The pandoc-wired ingest smoke this file used to carry left with the pandoc
 * pipeline in MS3b; the new pipeline's end-to-end coverage lives in
 * `tex-*.test.ts` and the CLI smoke.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { arxivDocId, normArxiv } from "@argelanderspace/core";
import { describe, expect, test } from "vitest";
import {
  ArxivFetcher,
  ArxivPdfOnlyError,
  arxivId,
  docIdFor,
  extractArxivSource,
  looksLikeArxiv,
} from "../src/latex/arxiv-source.js";

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

describe("ArxivPdfOnlyError (Stage 15: typed, message unchanged)", () => {
  test("a PDF body (neither tar nor gzip) raises the typed PDF-only error", () => {
    const dest = mkdtempSync(join(tmpdir(), "untar-pdfonly-"));
    const pdf = new TextEncoder().encode("%PDF-1.7 fake pdf body");
    try {
      extractArxivSource(pdf, dest);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ArxivPdfOnlyError);
      expect((e as Error).message).toContain("PDF-only");
    }
  });

  test("a gzipped non-LaTeX single file raises the typed PDF-only error", () => {
    const dest = mkdtempSync(join(tmpdir(), "untar-pdfonly-"));
    const gz = gzipSync(new TextEncoder().encode("just some text, no documentclass here"));
    try {
      extractArxivSource(gz, dest);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ArxivPdfOnlyError);
      expect((e as Error).message).toContain("PDF-only");
    }
  });

  test("a gzipped LaTeX single file still unpacks fine", () => {
    const dest = mkdtempSync(join(tmpdir(), "untar-single-"));
    const gz = gzipSync(
      new TextEncoder().encode(
        "\\documentclass{article}\n\\begin{document}\nHi.\n\\end{document}\n"
      )
    );
    expect(() => extractArxivSource(gz, dest)).not.toThrow();
  });
});

describe("ArxivFetcher cache freshness (Stage 15: refresh must never read a stale tarball)", () => {
  const NEW = new TextEncoder().encode("NEW-TARBALL");

  test("useCache:true (default) reuses the cached file without a request", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "latexcache-"));
    writeFileSync(join(cacheDir, "2501.17225.tar.gz"), "OLD-TARBALL");
    let called = 0;
    const fetcher = new ArxivFetcher(cacheDir, {
      userAgent: "test",
      delay: 0,
      fetchImpl: async () => {
        called += 1;
        return new Response(NEW);
      },
    });
    const p = await fetcher.downloadEprint("2501.17225");
    expect(readFileSync(p, "utf8")).toBe("OLD-TARBALL");
    expect(called).toBe(0);
  });

  test("useCache:false always downloads fresh and overwrites the cache", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "latexcache-"));
    writeFileSync(join(cacheDir, "2501.17225.tar.gz"), "OLD-TARBALL");
    let called = 0;
    const fetcher = new ArxivFetcher(cacheDir, {
      userAgent: "test",
      useCache: false,
      delay: 0,
      fetchImpl: async () => {
        called += 1;
        return new Response(NEW);
      },
    });
    const p = await fetcher.downloadEprint("2501.17225");
    expect(called).toBe(1);
    expect(readFileSync(p, "utf8")).toBe("NEW-TARBALL"); // cache overwritten on success
  });
});

describe("doc id parity (Stage 15: core arxivDocId vs infra docIdFor, unversioned ids)", () => {
  test("they agree on the auto-ingest (unversioned) id space", () => {
    for (const id of ["2501.17225", "astro-ph/9707253", "1234.56789"]) {
      const norm = normArxiv(id);
      expect(norm).not.toBeNull();
      expect(arxivDocId(norm ?? "")).toBe(docIdFor(norm, null));
    }
    // the auto path strips the version: `ingest 2501.17225v2` (CLI, versioned
    // doc) is a DIFFERENT doc from the web's `arxiv-2501.17225`
    expect(docIdFor("2501.17225v2", null)).not.toBe(arxivDocId("2501.17225"));
  });
});
