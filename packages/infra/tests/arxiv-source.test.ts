/**
 * arXiv id/URL detection tests — port of `test_latex_arxiv_detection` from
 * `<repo>/tests/run_tests.py` (the functions under test live here in infra),
 * plus an offline smoke test of the wired `ingestLatex` (core pipeline + real
 * pandoc/acquisition/raster adapters) on a local .tex fixture.
 */

import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { arxivId, looksLikeArxiv } from "../src/latex/arxiv-source.js";
import { ASTRO_BIN_HINT, havePandoc } from "../src/latex/pandoc.js";
import { ingestLatex } from "../src/latex/pipeline.js";

const FIXTURES = fileURLToPath(new URL("fixtures", import.meta.url));

if (!havePandoc() && existsSync(`${ASTRO_BIN_HINT}/pandoc`)) {
  process.env.PATH = `${ASTRO_BIN_HINT}${delimiter}${process.env.PATH ?? ""}`;
}
const PANDOC = havePandoc();

test("arxiv id/URL detection (test_latex_arxiv_detection)", () => {
  expect(looksLikeArxiv("2501.17225")).toBe(true);
  expect(looksLikeArxiv("arXiv:2603.03522v2")).toBe(true);
  expect(looksLikeArxiv("https://arxiv.org/abs/1234.5678")).toBe(true);
  expect(looksLikeArxiv("astro-ph/0701001")).toBe(true);
  expect(looksLikeArxiv("paper.pdf")).toBe(false);
  expect(looksLikeArxiv("10.1051/0004-6361/123")).toBe(false);
  expect(arxivId("https://arxiv.org/pdf/2501.17225v2.pdf")).toBe("2501.17225v2");
});

describe.skipIf(!PANDOC)("wired ingestLatex (core pipeline + infra adapters)", () => {
  test("local .tex ingests offline end-to-end", async () => {
    const root = mkdtempSync(join(tmpdir(), "infra-latex-wiring-"));
    const src = join(root, "main.tex");
    cpSync(join(FIXTURES, "sample_latex.tex"), src);
    const doc = await ingestLatex(src, {
      outRoot: join(root, "out"),
      config: { downloadAssets: false, useCache: false, requestDelay: 0 },
      writeJson: true,
    });
    expect(doc.source?.type).toBe("latex");
    expect(doc.meta?.title ?? "").toContain("Sample LaTeX Paper");
    expect(doc.references?.length).toBe(2);
    // the written JSON exists at <out_root>/<doc_id>/<doc_id>.json
    const outJson = doc.meta?.output_path;
    expect(typeof outJson).toBe("string");
    expect(existsSync(outJson as string)).toBe(true);
  });
});
