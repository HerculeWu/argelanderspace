/**
 * The PDF engine's font fallback (desktop-app ticket 28), on the real seam: the pinned PDFium engine in Node renders a
 * PDF whose CJK text uses a NON-embedded font. Without the fallback that text is blank; with it the CJK area has ink.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { PDF_FALLBACK_FONT_PACKAGES } from "@argelanderspace/contracts";
import { afterEach, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { JobRunner } from "../src/jobs.js";
import { fallbackFontPackageDir } from "../src/pdf-fonts.js";
import { renderPdfPageImage } from "../src/pdf-material.js";
import { createPdfiumEngine, type RgbaImage } from "../src/pdfium-shared.js";
import { makeDataDir, stubPipelines, stubSources } from "./helpers.js";
import { CJK_PDF, cjkPdf } from "./pdf-fixture.js";
import { decodePng } from "./png-decode.js";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Box = { x0: number; x1: number; y0: number; y1: number };

/** Dark pixels (luminance below half) of an RGBA image inside a PDF-point box, at `scale` pixels per point. */
function ink(
  image: { width: number; height: number; rgba: Uint8Array },
  box: Box,
  scale: number
): number {
  let dark = 0;
  const rowTop = Math.floor((CJK_PDF.height - box.y1) * scale);
  const rowBottom = Math.ceil((CJK_PDF.height - box.y0) * scale);
  for (let y = Math.max(0, rowTop); y < Math.min(image.height, rowBottom); y++)
    for (
      let x = Math.floor(box.x0 * scale);
      x < Math.min(image.width, Math.ceil(box.x1 * scale));
      x++
    ) {
      const at = (y * image.width + x) * 4;
      const lum =
        0.299 * (image.rgba[at] as number) +
        0.587 * (image.rgba[at + 1] as number) +
        0.114 * (image.rgba[at + 2] as number);
      if (lum < 128) dark++;
    }
  return dark;
}

/** The engine's own render, with or without the fallback (the `fontFallback: false` control). */
async function renderRaw(bytes: Buffer, fontFallback: boolean) {
  let raw: RgbaImage | undefined;
  type Doc = { pages: unknown[] };
  type Task<T> = { toPromise(): Promise<T> };
  const engine = await createPdfiumEngine<{
    openDocumentBuffer(f: { id: string; content: ArrayBuffer }): Task<Doc>;
    renderPage(d: Doc, p: unknown, o: object): Task<unknown>;
    closeDocument(d: Doc): Task<unknown>;
    destroy(): Task<unknown>;
  }>(
    (getData) => {
      raw = getData();
      return Promise.resolve(Buffer.alloc(0));
    },
    Date.now() + 60_000,
    { fontFallback }
  );
  try {
    const doc = await engine
      .openDocumentBuffer({ id: "cjk", content: Uint8Array.from(bytes).buffer })
      .toPromise();
    await engine
      .renderPage(doc, doc.pages[0], {
        scaleFactor: 2,
        dpr: 1,
        imageType: "image/png",
        withAnnotations: false,
      })
      .toPromise();
    await engine.closeDocument(doc).toPromise();
  } finally {
    await engine.destroy().toPromise();
  }
  if (!raw) throw new Error("no image");
  return { width: raw.width, height: raw.height, rgba: Uint8Array.from(raw.data) };
}

describe("non-embedded CJK text", () => {
  for (const ordering of ["GB1", "CNS1", "Japan1", "Korea1"] as const)
    test(`renders with ink through the product path (${ordering})`, async () => {
      const bytes = cjkPdf(ordering);
      const page = await renderPdfPageImage(bytes, hash(bytes), 0, 600);
      const image = decodePng(page.png);
      expect(image.width).toBe(600);
      expect(ink(image, CJK_PDF.latin, 2)).toBeGreaterThan(200);
      expect(ink(image, CJK_PDF.cjk, 2)).toBeGreaterThan(500);
    });

  test("control: the same page without the fallback leaves the CJK area blank (the check can fail)", async () => {
    const bytes = cjkPdf();
    const off = await renderRaw(bytes, false);
    const on = await renderRaw(bytes, true);
    expect(ink(off, CJK_PDF.latin, 2)).toBeGreaterThan(200);
    expect(ink(off, CJK_PDF.cjk, 2)).toBe(0);
    expect(ink(on, CJK_PDF.cjk, 2)).toBeGreaterThan(500);
  });
});

describe("the fallback table against the installed font packages", () => {
  test("versions, files and weights are the packages' own manifests, and every file is on disk", async () => {
    for (const pkg of PDF_FALLBACK_FONT_PACKAGES) {
      const dir = fallbackFontPackageDir(pkg.name);
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name: string;
        version: string;
      };
      expect(manifest.name).toBe(`@embedpdf/fonts-${pkg.name}`);
      expect(manifest.version).toBe(pkg.version);
      const { fonts } = (await import(pathToFileURL(join(dir, "dist/index.js")).href)) as {
        fonts: { file: string; weight: number; italic?: boolean }[];
      };
      expect(fonts.map((f) => ({ file: f.file, weight: f.weight }))).toEqual(pkg.files);
      expect(fonts.some((f) => f.italic)).toBe(false);
      for (const f of pkg.files) expect(existsSync(join(dir, "fonts", f.file))).toBe(true);
    }
  });

  test("the charsets are the engine's FontCharset values", async () => {
    const { FontCharset } = (await import("@embedpdf/engines/pdfium")) as unknown as {
      FontCharset: Record<string, number>;
    };
    expect(PDF_FALLBACK_FONT_PACKAGES.map((p) => p.charset)).toEqual([
      FontCharset.SHIFTJIS,
      FontCharset.HANGEUL,
      FontCharset.GB2312,
      FontCharset.CHINESEBIG5,
    ]);
  });
});

describe("the page's font route", () => {
  const dataDirs: string[] = [];
  afterEach(() => {
    for (const dir of dataDirs.splice(0)) rmSync(dirname(dir), { recursive: true, force: true });
  });
  async function app() {
    const dataDir = makeDataDir();
    dataDirs.push(dataDir);
    const { libraryPaths } = await import("@argelanderspace/core");
    const { statusDirFor } = await import("../src/deps.js");
    return createApp({
      paths: libraryPaths(dataDir),
      statusDir: statusDirFor(dataDir),
      makeSources: () => stubSources(),
      pipelines: stubPipelines(),
      runner: new JobRunner({ dir: join(dataDir, "jobs") }),
      broadcast: () => {},
      webDist: null,
    });
  }

  test("serves a font of the table, byte for byte, as an immutable font", async () => {
    const res = await (await app()).request("/api/pdf-fonts/sc/1.0.0/NotoSansHans-Regular.otf");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("font/otf");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const body = Buffer.from(await res.arrayBuffer());
    expect(
      body.equals(
        readFileSync(join(fallbackFontPackageDir("sc"), "fonts", "NotoSansHans-Regular.otf"))
      )
    ).toBe(true);
  });

  test("anything outside the table is 404 (other packages, versions, files, traversal)", async () => {
    const a = await app();
    for (const path of [
      "/api/pdf-fonts/sc/1.0.1/NotoSansHans-Regular.otf",
      "/api/pdf-fonts/latin/1.0.0/NotoSans-Regular.ttf",
      "/api/pdf-fonts/sc/1.0.0/LICENSE",
      "/api/pdf-fonts/sc/1.0.0/..%2Fpackage.json",
      "/api/pdf-fonts/sc/1.0.0/..%2F..%2F..%2Fpackage.json",
      "/api/pdf-fonts/sc/1.0.0",
      "/api/pdf-fonts/sc/1.0.0/NotoSansHans-Regular.otf/x",
    ]) {
      const res = await a.request(path);
      expect([path, res.status]).toEqual([path, 404]);
    }
  });
});
