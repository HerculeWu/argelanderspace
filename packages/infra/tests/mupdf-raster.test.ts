/**
 * Rasterization (mupdf for vector PDF, Ghostscript for EPS) + the
 * AssetResolver port of ingest_latex/assets.py. The 200-DPI page-1 render
 * of the fixture PDF is MD5-identical to PyMuPDF per the spike; here we pin
 * the dimensions and a non-trivial payload size.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { AssetResolver } from "../src/latex/assets.js";
import { findOnPath } from "../src/lib/proc.js";
import { epsToPng, pdfToPng, pngSize, rasterizePdfPage, zoomFor } from "../src/pdf/raster.js";

const FIXTURES = fileURLToPath(new URL("fixtures", import.meta.url));
const PDF_1610 = `${FIXTURES}/arxivpdf-1610.08981.pdf`;
const GS = findOnPath("gs");

describe("rasterizePdfPage / zoomFor / pngSize", () => {
  test("page 1 at 200 DPI → 1700×2200 PNG (spike value)", () => {
    const png = rasterizePdfPage(PDF_1610, { dpi: 200 });
    expect(pngSize(png)).toEqual({ width: 1700, height: 2200 });
    expect(png.length).toBeGreaterThan(100_000); // spike: 709,979 bytes
  });

  test("zoomFor caps the longest side at maxPx", () => {
    // Letter page at 200 DPI: longest side 792 * 2.778 = 2200 → not capped (>)
    expect(zoomFor(612, 792, 200, 2200)).toBeCloseTo(200 / 72, 9);
    // wide figure: 1000 * 2.778 = 2778 > 2200 → capped
    expect(zoomFor(1000, 500, 200, 2200)).toBeCloseTo(2.2, 9);
    // degenerate page: no cap division (max <= 0 guard)
    expect(zoomFor(0, 0, 200, 2200)).toBeCloseTo(200 / 72, 9);
  });

  test("pdfToPng writes a capped PNG atomically (no .part left)", () => {
    const dir = mkdtempSync(join(tmpdir(), "m2-raster-"));
    const dest = join(dir, "fig.png");
    expect(pdfToPng(`${FIXTURES}/fig-vector.pdf`, dest, { dpi: 200, maxPx: 2200 })).toBe(true);
    const { width, height } = pngSize(new Uint8Array(readFileSync(dest)));
    // 200×100 pt figure → 556×278 px at 200 DPI
    expect(width).toBeGreaterThanOrEqual(550);
    expect(width).toBeLessThanOrEqual(560);
    expect(height).toBeGreaterThanOrEqual(275);
    expect(height).toBeLessThanOrEqual(280);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });
});

describe("epsToPng (Ghostscript)", () => {
  test.skipIf(!GS)("rasterizes EPS via gs on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "m2-eps-"));
    const dest = join(dir, "fig.png");
    expect(epsToPng(`${FIXTURES}/fig-vector.eps`, dest, { dpi: 200 })).toBe(true);
    const { width, height } = pngSize(new Uint8Array(readFileSync(dest)));
    expect(width).toBeGreaterThan(500);
    expect(height).toBeGreaterThan(250);
  });

  test("returns false (never throws) when gs is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "m2-eps-"));
    expect(epsToPng(`${FIXTURES}/fig-vector.eps`, join(dir, "x.png"), { gsPath: null })).toBe(
      false
    );
  });
});

describe("AssetResolver (ingest_latex/assets.py)", () => {
  function makeSrcTree(): { srcDir: string; assetDir: string } {
    const root = mkdtempSync(join(tmpdir(), "m2-assets-"));
    const srcDir = join(root, "src");
    const assetDir = join(root, "assets");
    mkdirSync(join(srcDir, "figs"), { recursive: true });
    cpSync(`${FIXTURES}/fig-vector.pdf`, join(srcDir, "figs", "plot.pdf"));
    cpSync(`${FIXTURES}/fig-raster.png`, join(srcDir, "img.png"));
    cpSync(`${FIXTURES}/fig-vector.eps`, join(srcDir, "plot-eps.eps"));
    return { srcDir, assetDir };
  }

  test("extension-less arg resolves .pdf first and rasterizes it", () => {
    const { srcDir, assetDir } = makeSrcTree();
    const r = new AssetResolver(srcDir, assetDir, { dpi: 200 });
    // "img" finds img.png (copy-through); "figs/plot" finds plot.pdf
    expect(r.image("img")).toBe("img__png.png");
    expect(r.image("figs/plot")).toBe("figs__plot__pdf.png");
    expect(statSync(join(assetDir, "figs__plot__pdf.png")).size).toBeGreaterThan(0);
    // copy-through keeps the raster bytes identical
    expect(readFileSync(join(assetDir, "img__png.png"))).toEqual(
      readFileSync(`${FIXTURES}/fig-raster.png`)
    );
    // cached second call returns the same name
    expect(r.image("figs/plot")).toBe("figs__plot__pdf.png");
  });

  test("basename fallback finds figures anywhere in the tree", () => {
    const { srcDir, assetDir } = makeSrcTree();
    const r = new AssetResolver(srcDir, assetDir);
    expect(r.image("plot")).toBe("figs__plot__pdf.png");
  });

  test("missing / disabled / escaping figures resolve to undefined", () => {
    const { srcDir, assetDir } = makeSrcTree();
    const r = new AssetResolver(srcDir, assetDir);
    expect(r.image("no-such-figure")).toBeUndefined();
    expect(r.image("../../etc/passwd")).toBeUndefined();
    expect(r.image("")).toBeUndefined();
    const off = new AssetResolver(srcDir, assetDir, { enabled: false });
    expect(off.image("img")).toBeUndefined();
  });

  test.skipIf(!GS)("EPS figures rasterize through Ghostscript", () => {
    const { srcDir, assetDir } = makeSrcTree();
    const r = new AssetResolver(srcDir, assetDir, { dpi: 150 });
    expect(r.image("plot-eps")).toBe("plot-eps__eps.png");
    expect(
      pngSize(new Uint8Array(readFileSync(join(assetDir, "plot-eps__eps.png")))).width
    ).toBeGreaterThan(0);
  });
});
