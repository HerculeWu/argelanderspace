/**
 * mupdf implementation of `bibgraph/pdf_links.py::extract_links` / `has_text_layer`:
 * harvest the GoTo / URI link annotations MinerU drops, so citations and
 * cross-references resolve authoritatively on born-digital PDFs.
 *
 * Spike-validated adaptations from PyMuPDF (see the spike memory):
 * - No `kind` enum: `link.isExternal()` separates URI links; internal links
 *   carry a fragment URI (`#nameddest=cite.X`, `#page=N`).
 * - `#nameddest=` prefix stripped and the name `decodeURIComponent`d
 *   (mupdf percent-encodes dest names into the URI; PyMuPDF hands them raw).
 * - **No y-flip**: mupdf's `resolveLinkDestination` y is already top-left
 *   origin, so `pdf_links.py`'s `1.0 - ty/th` flip is dropped.
 * - Name-tree dests (`doc.resolve_names()` ≡ `loadNameTree("Dests")`) need no
 *   separate handling: `doc.resolveLinkDestination(link)` resolves through
 *   the name tree internally (spike: 338 entries, sampled dests match).
 *
 * Kind mapping: external (scheme-having URI) → "uri", except `file:`-schemed
 * externals, which are how mupdf represents remote GoTo/Launch actions
 * (PyMuPDF `LINK_GOTOR`/`LINK_LAUNCH`) → "other"; `#nameddest=<name>` →
 * "goto" with `destKind = classifyDest(name)` (PyMuPDF `LINK_NAMED`);
 * `#page=N` → "goto" with `destKind = "goto"` (PyMuPDF `LINK_GOTO`); any
 * other scheme-less URI → "other".
 *
 * Defensive divergence: an unresolvable destination (dest.page < 0) yields
 * `targetPage: undefined` where PyMuPDF stores `-1`; the consumers
 * (`resolvePoint`) treat both identically, and PdfLinks is never serialized.
 */

import {
  classifyDest,
  type FracRect,
  type LinkAnnot,
  type PdfLinks,
  parseUri,
} from "@argelanderspace/core";
import type * as mupdf from "mupdf";
import { openMupdf, pageSizeOf, pageTextOf } from "./text-provider.js";

/** Strip `#nameddest=` / bare-`#` and percent-decode a destination name. */
function destNameOf(uri: string): string | undefined {
  let name: string;
  if (uri.startsWith("#nameddest=")) name = uri.slice("#nameddest=".length);
  else if (uri.startsWith("#")) name = uri.slice(1);
  else return undefined;
  if (/^page=\d/.test(name)) return undefined; // "#page=N" — explicit goto, no name
  try {
    return decodeURIComponent(name);
  } catch {
    return name; // malformed % escape — PyMuPDF never decodes; keep the raw name
  }
}

/** Fractional target point of an internal link (top-left origin, no flip). */
function targetPointOf(
  doc: mupdf.Document,
  link: mupdf.Link
): {
  targetPage: number | undefined;
  targetPoint: readonly [number, number] | undefined;
} {
  let dest: ReturnType<mupdf.Document["resolveLinkDestination"]>;
  try {
    dest = doc.resolveLinkDestination(link);
  } catch {
    return { targetPage: undefined, targetPoint: undefined };
  }
  const page = dest.page;
  if (typeof page !== "number" || page < 0 || page >= doc.countPages()) {
    return { targetPage: undefined, targetPoint: undefined };
  }
  const x = dest.x;
  const y = dest.y;
  if (typeof x !== "number" || typeof y !== "number") {
    return { targetPage: page, targetPoint: undefined };
  }
  const target = doc.loadPage(page);
  try {
    const { width: tw, height: th } = pageSizeOf(target);
    if (tw <= 0 || th <= 0) return { targetPage: page, targetPoint: undefined };
    return { targetPage: page, targetPoint: [x / tw, y / th] };
  } finally {
    target.destroy();
  }
}

/** `pdf_links.extract_links(pdf_path)` — all link annots + text-layer probe. */
export function extractPdfLinks(pdfPath: string): PdfLinks {
  const doc = openMupdf(pdfPath);
  try {
    const nPages = doc.countPages();
    const pageSizes: Array<readonly [number, number]> = [];
    const links: LinkAnnot[] = [];
    let textChars = 0;
    let sampled = 0;
    for (let pno = 0; pno < nPages; pno++) {
      const page = doc.loadPage(pno);
      try {
        const { width: w, height: h } = pageSizeOf(page);
        pageSizes.push([w, h]);
        if (w <= 0 || h <= 0) continue;
        if (sampled < 6) {
          textChars += Array.from(pageTextOf(page).trim()).length;
          sampled += 1;
        }
        for (const ln of page.getLinks()) {
          const b = ln.getBounds();
          const rect: FracRect = [b[0] / w, b[1] / h, b[2] / w, b[3] / h];
          const uri = ln.getURI();
          if (ln.isExternal() && !uri.startsWith("file:")) {
            const { doi, arxivId } = parseUri(uri);
            links.push({ pageIdx: pno, rect, kind: "uri", uri, doi, arxivId });
          } else if (!ln.isExternal() && uri.startsWith("#")) {
            const destName = destNameOf(uri);
            const { targetPage, targetPoint } = targetPointOf(doc, ln);
            links.push({
              pageIdx: pno,
              rect,
              kind: "goto",
              targetPage,
              targetPoint,
              destName,
              destKind: destName !== undefined ? classifyDest(destName) : "goto",
            });
          } else {
            links.push({ pageIdx: pno, rect, kind: "other" });
          }
        }
      } finally {
        page.destroy();
      }
    }
    return { nPages, pageSizes, links, hasText: textChars / Math.max(1, sampled) > 80 };
  } finally {
    doc.destroy();
  }
}

/** `pdf_links.has_text_layer(pdf_path)` — cheap text-layer probe. */
export function hasPdfTextLayer(pdfPath: string): boolean {
  const doc = openMupdf(pdfPath);
  try {
    let chars = 0;
    const n = Math.min(doc.countPages(), 6);
    for (let i = 0; i < n; i++) {
      const page = doc.loadPage(i);
      try {
        chars += Array.from(pageTextOf(page).trim()).length;
      } finally {
        page.destroy();
      }
    }
    return chars / Math.max(1, n) > 80;
  } finally {
    doc.destroy();
  }
}
