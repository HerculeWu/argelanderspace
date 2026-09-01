/**
 * Vector-figure rasterization for the LaTeX pipeline
 * (`bibgraph/ingest_latex/assets.py` converter half): PDF pages → PNG via
 * mupdf (spike: MD5-identical to PyMuPDF at the same DPI — same renderer),
 * EPS/PS → PNG via Ghostscript on PATH.
 *
 * Port notes:
 * - `zoomFor` is `AssetResolver._zoom_for`: render at `dpi`, then shrink the
 *   zoom so the longest side never exceeds `maxPx`.
 * - Writes are atomic (`<dest>.part` → rename) like the Python converter.
 */

import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as mupdf from "mupdf";
import { findOnPath, runCapture } from "../lib/proc.js";

/** Page size in points (CropBox width/height), like `page.rect`. */
function pageSizeOf(page: mupdf.Page): { width: number; height: number } {
  const b = page.getBounds();
  return { width: b[2] - b[0], height: b[3] - b[1] };
}

/** Open a PDF through mupdf's WASM build (`fitz.open`). Throws on unreadable input. */
function openMupdf(pdfPath: string): mupdf.Document {
  return mupdf.Document.openDocument(readFileSync(pdfPath), "pdf");
}

export interface RasterOptions {
  /** Render DPI (Python `figure_dpi`, default 200). */
  dpi?: number;
  /** Longest-side cap in px (Python `figure_max_px`, default 2200). */
  maxPx?: number;
}

/** `AssetResolver._zoom_for` — DPI zoom, shrunk so longest side ≤ maxPx. */
export function zoomFor(wPt: number, hPt: number, dpi = 200, maxPx = 2200): number {
  let zoom = dpi / 72.0;
  const longest = Math.max(wPt, hPt) * zoom;
  if (longest > maxPx && Math.max(wPt, hPt) > 0) {
    zoom = maxPx / Math.max(wPt, hPt);
  }
  return zoom;
}

/**
 * Render one page of a vector PDF to PNG bytes at `dpi` (capped by `maxPx`).
 * `page.toPixmap([z,0,0,z,0,0], DeviceRGB, false)` → `pix.asPNG()` ≡
 * `page.get_pixmap(matrix=fitz.Matrix(z, z), alpha=False).tobytes("png")`.
 */
export function rasterizePdfPage(
  pdfPath: string,
  opts: RasterOptions & { page?: number } = {}
): Uint8Array {
  const doc = openMupdf(pdfPath);
  try {
    const page = doc.loadPage(opts.page ?? 0);
    try {
      const { width, height } = pageSizeOf(page);
      const z = zoomFor(width, height, opts.dpi ?? 200, opts.maxPx ?? 2200);
      const pix = page.toPixmap([z, 0, 0, z, 0, 0], mupdf.ColorSpace.DeviceRGB, false);
      try {
        return pix.asPNG();
      } finally {
        pix.destroy();
      }
    } finally {
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
}

/**
 * `AssetResolver._pdf_to_png`: page 0 of `src` → `dest` (atomic).
 * Returns false on an empty/unreadable PDF instead of throwing.
 */
export function pdfToPng(src: string, dest: string, opts: RasterOptions = {}): boolean {
  const doc = openMupdf(src);
  try {
    if (doc.countPages() === 0) return false;
    const page = doc.loadPage(0);
    try {
      const { width, height } = pageSizeOf(page);
      const z = zoomFor(width, height, opts.dpi ?? 200, opts.maxPx ?? 2200);
      const pix = page.toPixmap([z, 0, 0, z, 0, 0], mupdf.ColorSpace.DeviceRGB, false);
      try {
        const tmp = `${dest}.part`;
        writeFileSync(tmp, pix.asPNG());
        renameSync(tmp, dest);
      } finally {
        pix.destroy();
      }
    } finally {
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
  return existsNonEmpty(dest);
}

/**
 * `AssetResolver._eps_to_png`: EPS/PS → PNG via Ghostscript (external by
 * design — mupdf's WASM build has no PostScript interpreter). Returns false
 * (with a warning on `log`) when `gs` is absent or fails, never throws.
 */
export function epsToPng(
  src: string,
  dest: string,
  opts: { dpi?: number; gsPath?: string | null; log?: (msg: string) => void } = {}
): boolean {
  const gs = opts.gsPath !== undefined ? opts.gsPath : findOnPath("gs");
  if (!gs) {
    opts.log?.(`Ghostscript not found; cannot rasterise ${src}`);
    return false;
  }
  const tmp = `${dest}.part`;
  const proc = runCapture(
    [
      gs,
      "-q",
      "-dSAFER",
      "-dBATCH",
      "-dNOPAUSE",
      "-dEPSCrop",
      "-sDEVICE=png16m",
      `-r${opts.dpi ?? 200}`,
      `-sOutputFile=${tmp}`,
      resolve(src), // absolute path: never flag-like ('-…')
    ],
    { timeout: 120 }
  );
  if (proc.error || proc.status !== 0 || !existsNonEmpty(tmp)) {
    opts.log?.(`gs failed on ${src}: ${proc.error?.message ?? proc.stderr.slice(-200)}`);
    return false;
  }
  renameSync(tmp, dest);
  return existsNonEmpty(dest);
}

function existsNonEmpty(p: string): boolean {
  try {
    return statSync(p).size > 0;
  } catch {
    return false;
  }
}

/** (width, height) of a PNG from its IHDR — for tests and sanity checks. */
export function pngSize(png: Uint8Array): { width: number; height: number } {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.length < 24 || !sig.every((b, i) => png[i] === b)) {
    throw new Error("not a PNG");
  }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
