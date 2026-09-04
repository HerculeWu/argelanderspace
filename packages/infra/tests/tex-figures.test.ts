/**
 * Figure materialization tests (Stage 5 MS1, `src/tex/figures.ts`).
 *
 * Raster/SVG passthrough, naming and degradation run unconditionally; the
 * vector conversions are gated on dvisvgm being on PATH (HAVE_PANDOC idiom).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { haveDvisvgm, materializeTexFigure, texFigureOutName } from "../src/tex/figures.js";

const FIXTURES = fileURLToPath(new URL("fixtures", import.meta.url));
const DVISVGM = haveDvisvgm();
if (!DVISVGM) console.warn("dvisvgm not on PATH — vector figure tests skipped");

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

describe("materializeTexFigure: passthrough + degradation (no dvisvgm needed)", () => {
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

describe("materializeTexFigure: dvisvgm vector conversion", () => {
  test.skipIf(!DVISVGM)("fig-vector.pdf → valid SVG", { timeout: 60_000 }, async () => {
    const destDir = await tmpDest();
    const r = await materializeTexFigure({
      src: join(FIXTURES, "fig-vector.pdf"),
      srcDir: FIXTURES,
      destDir,
    });
    expect(r).toEqual({ ok: true, file: "fig-vector__pdf.svg" });
    const svg = readFileSync(join(destDir, "fig-vector__pdf.svg"), "utf8");
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });

  test.skipIf(!DVISVGM)("fig-vector.eps → valid SVG", { timeout: 60_000 }, async () => {
    const destDir = await tmpDest();
    const r = await materializeTexFigure({
      src: join(FIXTURES, "fig-vector.eps"),
      srcDir: FIXTURES,
      destDir,
    });
    expect(r).toEqual({ ok: true, file: "fig-vector__eps.svg" });
    expect(readFileSync(join(destDir, "fig-vector__eps.svg"), "utf8")).toContain("<svg");
  });

  test.skipIf(!DVISVGM)(
    "a corrupt .pdf degrades instead of throwing",
    { timeout: 60_000 },
    async () => {
      const destDir = await tmpDest();
      const src = join(destDir, "bogus.pdf");
      writeFileSync(src, "this is not a PDF at all");
      const r = await materializeTexFigure({ src, srcDir: destDir, destDir });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("dvisvgm");
    }
  );
});
