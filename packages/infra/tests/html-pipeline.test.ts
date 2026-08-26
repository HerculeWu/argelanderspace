/**
 * Offline smoke test of the wired `ingestHtml` (core pipeline + real infra
 * adapters): the page cache is pre-warmed with a synthetic A&A page (keyed by
 * the exact `sha1(url)[:16]` scheme the Python/infra fetcher shares), so the
 * real `Fetcher` serves the main page from disk and the pandoc-backed mathml
 * port is never exercised (no math on the page). Any network access fails the
 * test via the throwing fetchImpl.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ingestHtml } from "../src/html/pipeline.js";

const fetchImpl = (() => {
  throw new Error("network access is forbidden in this test");
}) as unknown as typeof fetch;

const DOI = "10.1051/0004-6361/209999999";
const REQUEST_URL = `https://doi.org/${DOI}`;
const FINAL_URL = "https://www.aanda.org/articles/aa/full_html/2099/01/aa99999-99/aa99999-99.html";

const PAGE = `<!DOCTYPE html>
<html><head>
<meta name="citation_title" content="A Wired Smoke Paper">
<meta name="citation_doi" content="${DOI}">
<meta name="citation_journal_title" content="Astronomy &amp; Astrophysics">
</head><body>
<div id="contenu">
<div id="head"><p>Abstract</p><p>Aims. Smoke-test the wired HTML pipeline.</p></div>
<h2 class="title">A Wired Smoke Paper</h2>
<h2 class="sec" id="S1">1. Introduction</h2>
<p>Body text with nothing to resolve.</p>
<h2 class="sec" id="references">References</h2>
</div>
</body></html>`;

describe("wired ingestHtml (core pipeline + infra adapters)", () => {
  test("warm .htmlcache + real Fetcher produce a Document offline", async () => {
    const outRoot = mkdtempSync(join(tmpdir(), "wired-html-"));
    const cacheDir = join(outRoot, ".htmlcache");
    mkdirSync(cacheDir, { recursive: true });
    const key = createHash("sha1").update(REQUEST_URL, "utf-8").digest("hex").slice(0, 16);
    writeFileSync(join(cacheDir, `${key}.html`), PAGE, "utf-8");
    writeFileSync(join(cacheDir, `${key}.url`), FINAL_URL, "utf-8");

    const doc = await ingestHtml(DOI, { outRoot, fetchImpl });

    expect(doc.doc_id).toBe("aa99999-99"); // derived from the final (cached) URL
    expect(doc.source?.type).toBe("html");
    expect(doc.source?.path).toBe(FINAL_URL);
    expect(doc.source?.publisher).toBe("EDP Sciences / A&A");
    expect(doc.meta?.title).toBe("A Wired Smoke Paper");
    const headings: string[] = [];
    for (const s of doc.structure ?? []) headings.push(s.heading ?? "");
    expect(headings).toEqual(["Abstract", "Introduction"]);

    const written = JSON.parse(
      readFileSync(join(outRoot, "aa99999-99", "aa99999-99.json"), "utf-8")
    ) as { doc_id?: string; stats?: { n_paragraphs?: number } };
    expect(written.doc_id).toBe(doc.doc_id);
    expect(written.stats?.n_paragraphs).toBe(2);
  });
});
