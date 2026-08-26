/**
 * mupdf (WASM) implementation of the core {@link PdfTextProvider} port —
 * replaces the PyMuPDF (`fitz`) text-layer reads in `bibgraph/ingest/textfix.py`.
 *
 * Validated byte-identical against PyMuPDF 1.27 by the Phase-0 spike
 * (`.kimi-code/memory/2026-08-26-mupdf-spike.md`):
 * - `pageText` = `page.toStructuredText().asText()` ≡ `page.get_text("text")`.
 * - `clippedText` = char-walk with a *quad-center-in-rect* filter ≡
 *   `page.get_text("text", clip=rect)` (the intersection filter is NOT
 *   equivalent — it pulls in edge-touching glyphs PyMuPDF excludes).
 * - `pageSize` = `page.getBounds()` (CropBox) width/height ≡ `page.rect`.
 *
 * mupdf-js objects pin WASM memory until `destroy()`ed, so every page/stext
 * is destroyed right after use and {@link close} destroys the document
 * (`applyTextfix` calls it in a `finally`).
 */

import { readFileSync } from "node:fs";
import type { PageRect, PdfTextProvider } from "@argelanderspace/core";
import * as mupdf from "mupdf";

/** Raw text layer of one already-loaded page (`page.get_text("text")`). */
export function pageTextOf(page: mupdf.Page): string {
  const st = page.toStructuredText();
  try {
    return st.asText();
  } finally {
    st.destroy();
  }
}

/**
 * `page.get_text("text", clip=rect)`: characters whose glyph quad *center*
 * lies inside `rect`, with a newline at each line that contributed a char.
 */
export function clippedTextOf(page: mupdf.Page, rect: PageRect): string {
  const st = page.toStructuredText();
  try {
    let text = "";
    let lineHas = false;
    st.walk({
      onChar(c, _origin, _font, _size, quad) {
        const cx = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
        const cy = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
        if (cx >= rect.x0 && cx <= rect.x1 && cy >= rect.y0 && cy <= rect.y1) {
          text += c;
          lineHas = true;
        }
      },
      endLine() {
        if (lineHas) {
          text += "\n";
          lineHas = false;
        }
      },
    });
    return text;
  } finally {
    st.destroy();
  }
}

/** Page size in points (CropBox width/height), like `page.rect`. */
export function pageSizeOf(page: mupdf.Page): { width: number; height: number } {
  const b = page.getBounds();
  return { width: b[2] - b[0], height: b[3] - b[1] };
}

/** Open a PDF through mupdf's WASM build (`fitz.open`). Throws on unreadable input. */
export function openMupdf(pdfPath: string): mupdf.Document {
  return mupdf.Document.openDocument(readFileSync(pdfPath), "pdf");
}

/** {@link PdfTextProvider} backed by mupdf. */
export class MupdfTextProvider implements PdfTextProvider {
  private readonly doc: mupdf.Document;
  private closed = false;

  constructor(pdfPath: string) {
    this.doc = openMupdf(pdfPath);
  }

  get pageCount(): number {
    return this.doc.countPages();
  }

  private page(pageIdx: number): mupdf.Page {
    if (this.closed) throw new Error("MupdfTextProvider is closed");
    return this.doc.loadPage(pageIdx);
  }

  pageSize(pageIdx: number): { width: number; height: number } {
    const page = this.page(pageIdx);
    try {
      return pageSizeOf(page);
    } finally {
      page.destroy();
    }
  }

  pageText(pageIdx: number): string {
    const page = this.page(pageIdx);
    try {
      return pageTextOf(page);
    } finally {
      page.destroy();
    }
  }

  clippedText(pageIdx: number, rect: PageRect): string {
    const page = this.page(pageIdx);
    try {
      return clippedTextOf(page, rect);
    } finally {
      page.destroy();
    }
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.doc.destroy();
    }
  }
}

/** Open `pdfPath` as a {@link PdfTextProvider} (textfix's entry point). */
export function openPdfTextProvider(pdfPath: string): PdfTextProvider {
  return new MupdfTextProvider(pdfPath);
}
