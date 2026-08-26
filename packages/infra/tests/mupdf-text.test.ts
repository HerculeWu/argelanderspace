/**
 * mupdf text-layer provider (the PdfTextProvider port) vs the spike's
 * PyMuPDF ground truth: per-page char counts and byte-identical clipped text
 * (quad-center-in-rect filter ≡ `get_text("text", clip=rect)`).
 */

import { fileURLToPath } from "node:url";
import { hasTextLayer } from "@argelanderspace/core";
import { describe, expect, test } from "vitest";
import { MupdfTextProvider, openPdfTextProvider } from "../src/pdf/text-provider.js";

const FIXTURES = fileURLToPath(new URL("fixtures", import.meta.url));
const PDF_1610 = `${FIXTURES}/arxivpdf-1610.08981.pdf`;
const PDF_ADS = `${FIXTURES}/ads-1983ApJ...270..365M.pdf`;
const PDF_2603 = `${FIXTURES}/2603.03522.pdf`; // carries non-BMP math-italic glyphs

// Spike ground truth (text_py.py / text_js.mjs agree).
const CHARS_PER_PAGE_1610 = [5659, 5671, 6346, 6565, 4058, 2797];

describe("MupdfTextProvider (PdfTextProvider port)", () => {
  test("pageCount / pageSize", () => {
    const p = openPdfTextProvider(PDF_1610);
    try {
      expect(p.pageCount).toBe(23);
      expect(p.pageSize(0)).toEqual({ width: 612, height: 792 });
    } finally {
      p.close();
    }
  });

  test("pageText char counts match PyMuPDF get_text('text')", () => {
    const p = new MupdfTextProvider(PDF_1610);
    try {
      for (let i = 0; i < 6; i++) {
        expect(p.pageText(i).trim().length, `page ${i}`).toBe(CHARS_PER_PAGE_1610[i]);
      }
    } finally {
      p.close();
    }
  });

  test("clippedText is byte-identical to PyMuPDF clip= (real span bbox)", () => {
    const p = new MupdfTextProvider(PDF_1610);
    try {
      // page 2 (index 1), spike clip rects from a real mid-page span
      expect(p.clippedText(1, { x0: 101.58, y0: 75.36, x1: 112.1, y1: 85.32 })).toBe("an\n");
      expect(p.clippedText(1, { x0: 65.47, y0: 75.36, x1: 161.49, y1: 85.32 })).toBe(
        "chosing an optimal Υ\n"
      );
    } finally {
      p.close();
    }
  });

  test("clippedText preserves non-BMP code points (walk onChar 16-bit truncation workaround)", () => {
    const p = new MupdfTextProvider(PDF_2603);
    try {
      // page 3 (index 2), a U+1D454 MATHEMATICAL ITALIC SMALL G span (PyMuPDF
      // ground truth: clip of the span bbox is "𝑔\n"). Without the asJSON zip,
      // walk's onChar marshals the rune via String.fromCharCode → U+D454.
      expect(p.clippedText(2, { x0: 42.17, y0: 388.55, x1: 46.65, y1: 397.52 })).toBe("𝑔\n");
    } finally {
      p.close();
    }
  });

  test("core hasTextLayer over the provider (born-digital + ADS scan)", () => {
    const born = new MupdfTextProvider(PDF_1610);
    try {
      expect(hasTextLayer(born)).toBe(true);
    } finally {
      born.close();
    }
    const scan = new MupdfTextProvider(PDF_ADS);
    try {
      expect(scan.pageCount).toBe(6);
      expect(hasTextLayer(scan)).toBe(true); // the ADS scan carries an OCR text layer
    } finally {
      scan.close();
    }
  });
});
