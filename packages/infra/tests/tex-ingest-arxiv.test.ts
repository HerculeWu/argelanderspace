/**
 * Stage 15: `ingestArxivEprint` end-to-end — STUBBED network (fetchImpl
 * serves the fixture tarball) + REAL latexmk compile:
 *
 * - freshness (D16): a poisoned `.latexcache` tarball is never read, the
 *   fresh download overwrites it, and a refresh wipes the old `src/` tree
 *   before re-extracting;
 * - the pinned, unversioned doc id is used verbatim (attach/refresh
 *   idempotence);
 * - a PDF-only submission fails with the typed `ArxivPdfOnlyError` before
 *   any compile is attempted.
 *
 * Real compilations are gated on latexmk + pdflatex (tex-compile.test.ts
 * idiom); the failure test runs everywhere.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ArxivPdfOnlyError } from "../src/latex/arxiv-source.js";
import { haveLatexmk, haveTexEngine } from "../src/tex/compile.js";
import { ingestArxivEprint } from "../src/tex/ingest.js";

const FIXTURES = fileURLToPath(new URL("fixtures", import.meta.url));
const LATEX = haveLatexmk() && haveTexEngine("pdflatex");
if (!LATEX) console.warn("latexmk/pdflatex not on PATH — real-compile e-print test skipped");

describe.skipIf(!LATEX)("ingestArxivEprint (Stage 15, real compile)", () => {
  test("fresh download ignores + overwrites a stale cache; refresh re-extracts src", async () => {
    const outRoot = mkdtempSync(join(tmpdir(), "eprint-ingest-"));
    const docId = "arxiv-2501.17225";
    // poison cache + src: stale bytes must never be READ (D16)
    mkdirSync(join(outRoot, ".latexcache"), { recursive: true });
    writeFileSync(join(outRoot, ".latexcache", "2501.17225.tar.gz"), "STALE");
    mkdirSync(join(outRoot, docId, "src"), { recursive: true });
    writeFileSync(join(outRoot, docId, "src", "stale.tex"), "% stale tree\n");
    const sample = new Uint8Array(readFileSync(join(FIXTURES, "eprint-sample.tar.gz")));
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(sample);
    };
    const r1 = await ingestArxivEprint("2501.17225", { outRoot, docId, fetchImpl });
    expect(calls).toBe(1); // never the poisoned cache
    expect(r1.docId).toBe(docId);
    // the cache was overwritten with the fresh bytes
    expect(new Uint8Array(readFileSync(join(outRoot, ".latexcache", "2501.17225.tar.gz")))).toEqual(
      sample
    );
    // the stale src tree was wiped and re-extracted
    expect(existsSync(join(outRoot, docId, "src", "stale.tex"))).toBe(false);
    expect(existsSync(join(outRoot, docId, "src", "main.tex"))).toBe(true);
    // a real compile produced the stored IR
    expect(r1.ir.version).toBe(1);
    expect(r1.ir.sections.length).toBeGreaterThan(0);
    expect(existsSync(join(outRoot, docId, `${docId}.json`))).toBe(true);
    // refresh: downloads AGAIN (no cache read) and re-ingests in place
    const r2 = await ingestArxivEprint("2501.17225", { outRoot, docId, fetchImpl });
    expect(calls).toBe(2);
    expect(r2.docId).toBe(docId);
  }, 180_000);
});

describe("ingestArxivEprint failure typing (no compile needed)", () => {
  test("a PDF-only submission raises ArxivPdfOnlyError before compiling", async () => {
    const outRoot = mkdtempSync(join(tmpdir(), "eprint-pdfonly-"));
    const fetchImpl = async () => new Response(new TextEncoder().encode("%PDF-1.7 nope"));
    await expect(
      ingestArxivEprint("2501.17225", { outRoot, docId: "arxiv-2501.17225", fetchImpl })
    ).rejects.toBeInstanceOf(ArxivPdfOnlyError);
  }, 30_000);
});
