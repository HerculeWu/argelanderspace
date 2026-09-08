/**
 * Figure materialization tests (Stage 5 MS1, `src/tex/figures.ts`; vector
 * route amended to pdftocairo/gs after smoke R1).
 *
 * Raster/SVG passthrough, naming and degradation run unconditionally; the
 * vector conversions are gated on pdftocairo (poppler-utils) — plus gs
 * (ghostscript) for EPS — being on PATH (HAVE_PANDOC idiom).
 *
 * The vector fixtures are REAL matplotlib outputs, not hand-rolled trivial
 * drawings: `fig-text.pdf` carries a title/axis labels/tick numbers,
 * `fig-imshow.pdf` embeds a raster XObject, `fig-text.eps` is a
 * text-bearing EPS. Smoke R1 proved the trivial one-triangle fixture could
 * pass while the converter dropped all text and images on real figures —
 * the assertions below therefore count rendered glyph references and
 * embedded images, not just "is an SVG".
 */

import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  haveGhostscript,
  havePdftocairo,
  materializeTexFigure,
  texFigureOutName,
} from "../src/tex/figures.js";

const FIXTURES = fileURLToPath(new URL("fixtures", import.meta.url));
const PDFCAIRO = havePdftocairo();
const GS = haveGhostscript();
if (!PDFCAIRO) console.warn("pdftocairo not on PATH — vector figure tests skipped");
if (!GS) console.warn("gs not on PATH — EPS figure tests skipped");

/** pdftocairo renders text as glyph `<use xlink:href="#glyph-…">` references. */
function glyphUseCount(svg: string): number {
  return svg.split("<use").length - 1;
}

async function tmpDest(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tex-fig-"));
}

describe("texFigureOutName (assets/<stem>__<srcext> convention)", () => {
  test("relative path stem with __ separators + srcExt + suffix", () => {
    expect(texFigureOutName("/a/b", "/a/b/sub/fig.pdf", ".svg")).toBe("sub__fig__pdf.svg");
    expect(texFigureOutName("/a/b", "/a/b/fig.png", ".png")).toBe("fig__png.png");
    expect(texFigureOutName("/a/b", "/a/b/plot.svg", ".svg")).toBe("plot__svg.svg");
  });

  test("sources outside srcDir fall back to the basename", () => {
    expect(texFigureOutName("/a/b", "/elsewhere/fig.eps", ".svg")).toBe("fig__eps.svg");
  });
});

describe("materializeTexFigure: passthrough + degradation (no pdftocairo needed)", () => {
  test("raster passthrough is byte-identical", async () => {
    const destDir = await tmpDest();
    const src = join(FIXTURES, "fig-raster.png");
    const r = await materializeTexFigure({ src, srcDir: FIXTURES, destDir });
    expect(r).toEqual({ ok: true, file: "fig-raster__png.png" });
    expect(readFileSync(join(destDir, "fig-raster__png.png"))).toEqual(readFileSync(src));
  });

  test(".svg sources pass through unchanged", async () => {
    const destDir = await tmpDest();
    const svg = join(destDir, "in.svg");
    writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const r = await materializeTexFigure({ src: svg, srcDir: destDir, destDir });
    expect(r).toEqual({ ok: true, file: "in__svg.svg" });
    expect(readFileSync(join(destDir, "in__svg.svg"), "utf8")).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"/>'
    );
  });

  test("missing source degrades (never throws)", async () => {
    const r = await materializeTexFigure({
      src: join(FIXTURES, "does-not-exist.png"),
      srcDir: FIXTURES,
      destDir: await tmpDest(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not found");
  });

  test("paths escaping the source tree are refused", async () => {
    const r = await materializeTexFigure({
      src: "/etc/hostname",
      srcDir: FIXTURES,
      destDir: await tmpDest(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("escapes");
  });

  test("unsupported extensions degrade", async () => {
    const r = await materializeTexFigure({
      src: join(FIXTURES, "paper.tex"),
      srcDir: FIXTURES,
      destDir: await tmpDest(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("unsupported figure type");
  });
});

describe("materializeTexFigure: pdftocairo vector conversion (text-bearing fixtures)", () => {
  test.skipIf(!PDFCAIRO)(
    "fig-text.pdf → SVG with rendered text (glyph refs) and faithful viewBox",
    { timeout: 60_000 },
    async () => {
      const destDir = await tmpDest();
      const r = await materializeTexFigure({
        src: join(FIXTURES, "fig-text.pdf"),
        srcDir: FIXTURES,
        destDir,
      });
      expect(r).toEqual({ ok: true, file: "fig-text__pdf.svg" });
      const svg = readFileSync(join(destDir, "fig-text__pdf.svg"), "utf8");
      expect(svg).toContain("<svg");
      // text survives: title/labels/ticks are dozens of glyph references
      // (the smoke-R1 regression: dvisvgm passed the old trivial fixture
      // while emitting ZERO glyph refs on a real figure)
      expect(glyphUseCount(svg)).toBeGreaterThanOrEqual(20);
      // faithful page geometry: fixture is 3in × 2in = 216 × 144 pt
      expect(svg).toContain('viewBox="0 0 216 144"');
      // non-trivial drawing body, not an empty shell
      expect(svg.split("<path").length - 1).toBeGreaterThanOrEqual(10);
    }
  );

  test.skipIf(!PDFCAIRO)(
    "fig-imshow.pdf → SVG keeps the embedded raster image",
    { timeout: 60_000 },
    async () => {
      const destDir = await tmpDest();
      const r = await materializeTexFigure({
        src: join(FIXTURES, "fig-imshow.pdf"),
        srcDir: FIXTURES,
        destDir,
      });
      expect(r).toEqual({ ok: true, file: "fig-imshow__pdf.svg" });
      const svg = readFileSync(join(destDir, "fig-imshow__pdf.svg"), "utf8");
      expect(svg).toContain("<image");
      expect(glyphUseCount(svg)).toBeGreaterThanOrEqual(10);
    }
  );

  test.skipIf(!PDFCAIRO)(
    "a corrupt .pdf degrades instead of throwing",
    { timeout: 60_000 },
    async () => {
      const destDir = await tmpDest();
      const src = join(destDir, "bogus.pdf");
      writeFileSync(src, "this is not a PDF at all");
      const r = await materializeTexFigure({ src, srcDir: destDir, destDir });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("pdftocairo");
    }
  );
});

describe("materializeTexFigure: EPS two-step conversion (gs → pdftocairo)", () => {
  test.skipIf(!PDFCAIRO || !GS)(
    "fig-text.eps → SVG with rendered text",
    { timeout: 60_000 },
    async () => {
      const destDir = await tmpDest();
      const r = await materializeTexFigure({
        src: join(FIXTURES, "fig-text.eps"),
        srcDir: FIXTURES,
        destDir,
      });
      expect(r).toEqual({ ok: true, file: "fig-text__eps.svg" });
      const svg = readFileSync(join(destDir, "fig-text__eps.svg"), "utf8");
      expect(svg).toContain("<svg");
      expect(glyphUseCount(svg)).toBeGreaterThanOrEqual(20);
    }
  );

  test.skipIf(!PDFCAIRO || !GS)(
    "a corrupt .eps degrades instead of throwing",
    { timeout: 60_000 },
    async () => {
      const destDir = await tmpDest();
      const src = join(destDir, "bogus.eps");
      writeFileSync(src, "junk");
      const r = await materializeTexFigure({ src, srcDir: destDir, destDir });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/gs|pdftocairo/);
    }
  );
});
