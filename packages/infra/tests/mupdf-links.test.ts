/**
 * mupdf link-annotation extraction vs the spike's known-good values
 * (`.kimi-code/memory/2026-08-26-mupdf-spike.md`): per-page counts and sampled
 * destinations match PyMuPDF `page.get_links()` exactly.
 */

import { fileURLToPath } from "node:url";
import { linksOnPage } from "@argelanderspace/core";
import { describe, expect, test } from "vitest";
import { extractPdfLinks, hasPdfTextLayer } from "../src/pdf/links.js";

const FIXTURES = fileURLToPath(new URL("fixtures", import.meta.url));
const PDF_1610 = `${FIXTURES}/arxivpdf-1610.08981.pdf`;
const PDF_ADS = `${FIXTURES}/ads-1983ApJ...270..365M.pdf`;

// Spike ground truth (links_js.mjs / links_py.py agree per page).
const PER_PAGE_1610 = [
  99, 41, 53, 52, 40, 12, 6, 15, 28, 27, 29, 25, 42, 31, 60, 59, 57, 11, 127, 1, 42, 0, 0,
];

describe("extractPdfLinks (bibgraph/pdf_links.py)", () => {
  const pdfLinks = extractPdfLinks(PDF_1610);

  test("page count and per-page link counts match the spike", () => {
    expect(pdfLinks.nPages).toBe(23);
    expect(pdfLinks.pageSizes.length).toBe(23);
    expect(pdfLinks.pageSizes[0]).toEqual([612, 792]);
    for (let p = 0; p < PER_PAGE_1610.length; p++) {
      expect(linksOnPage(pdfLinks, p).length, `page ${p}`).toBe(PER_PAGE_1610[p]);
    }
    expect(pdfLinks.links.length).toBe(857); // 856 internal + 1 external
  });

  test("born-digital PDF has a text layer", () => {
    expect(pdfLinks.hasText).toBe(true);
  });

  test("named-destination resolution: cite.Bosma1978 → page 20 (spike sample)", () => {
    const link = pdfLinks.links.find((l) => l.pageIdx === 0 && l.destName === "cite.Bosma1978");
    expect(link).toBeDefined();
    expect(link?.kind).toBe("goto");
    expect(link?.destKind).toBe("cite");
    expect(link?.targetPage).toBe(20);
    // mupdf dest y is already top-left origin (spike: 38.508, 331.633 pts)
    const tp = link?.targetPoint;
    expect(tp).toBeDefined();
    const size = pdfLinks.pageSizes[20];
    expect(size).toBeDefined();
    if (tp && size) {
      expect(tp[0]).toBeCloseTo(38.508 / size[0], 4);
      expect(tp[1]).toBeCloseTo(331.633 / size[1], 4);
      expect(tp[1]).toBeGreaterThan(0);
      expect(tp[1]).toBeLessThan(1);
    }
  });

  test("percent-encoded dest names are decoded (A&A bibkeys)", () => {
    const encoded = pdfLinks.links.filter((l) => l.destName?.includes("&"));
    expect(encoded.length).toBeGreaterThan(0);
    expect(encoded[0]?.destName).toMatch(/^cite\.\d{4}A&A\.\.\./);
  });

  test("source rects are fractional [0,1]", () => {
    for (const l of pdfLinks.links) {
      for (const v of l.rect) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  test("the one remote-GoTo link is 'other' (PyMuPDF LINK_GOTOR), zero uri links", () => {
    // mupdf shows it as external `file:url.pdf#page=1&view=Fit`; PyMuPDF says GOTOR.
    expect(pdfLinks.links.filter((l) => l.kind === "uri").length).toBe(0);
    const other = pdfLinks.links.filter((l) => l.kind === "other");
    expect(other.length).toBe(1);
    expect(pdfLinks.links.filter((l) => l.kind === "goto").length).toBe(856);
  });

  test("ADS scan: no links, but carries its OCR text layer", () => {
    const ads = extractPdfLinks(PDF_ADS);
    expect(ads.nPages).toBe(6);
    expect(ads.links.length).toBe(0);
    expect(ads.hasText).toBe(true);
  });

  test("hasPdfTextLayer", () => {
    expect(hasPdfTextLayer(PDF_1610)).toBe(true);
    expect(hasPdfTextLayer(PDF_ADS)).toBe(true);
  });
});
