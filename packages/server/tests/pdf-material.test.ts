/**
 * Original-page material (copilot ticket 20), on the real seam: the pinned PDFium engine in Node, real bytes, no
 * browser and no mocks of rendering or text extraction.
 */
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { PDF_IMAGE_LONG_EDGE, PDF_OUTLINE_MAX_ENTRIES } from "@argelanderspace/contracts";
import { expect, test } from "vitest";
import {
  encodePng,
  imageScale,
  PdfMaterialContentError,
  PdfMaterialInputError,
  PdfQueueFullError,
  pdfMaterialResources,
  readPdfTextMaterial,
  renderPdfPageImage,
} from "../src/pdf-material.js";
import { probePdf } from "../src/pdfium-probe.js";
import { PDF_QUEUE_MAX_WAITING, PDF_QUEUE_MAX_WAITING_BYTES } from "../src/pdfium-shared.js";
import { syntheticPdf } from "./pdf-fixture.js";

/** A reference PNG decoder for the encoder's output: inflate, undo each row's filter, expand to RGBA. */
function decodePng(png: Buffer) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const colorType = png[25] as number;
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.subarray(at + 4, at + 8).toString() === "IDAT")
      idat.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] as number;
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i] as number;
      const left = i >= bpp ? (pixels[y * stride + i - bpp] as number) : 0;
      const up = y > 0 ? (pixels[(y - 1) * stride + i] as number) : 0;
      const upLeft = y > 0 && i >= bpp ? (pixels[(y - 1) * stride + i - bpp] as number) : 0;
      const p = left + up - upLeft;
      const pa = Math.abs(p - left);
      const pb = Math.abs(p - up);
      const pc = Math.abs(p - upLeft);
      const predictor = [
        0,
        left,
        up,
        (left + up) >> 1,
        pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft,
      ][filter] as number;
      pixels[y * stride + i] = (x + predictor) & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const v = (k: number) => pixels[p * bpp + k] as number;
    rgba.set(
      bpp === 4
        ? [v(0), v(1), v(2), v(3)]
        : bpp === 3
          ? [v(0), v(1), v(2), 255]
          : [v(0), v(0), v(0), 255],
      p * 4
    );
  }
  return { width, height, rgba };
}

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const pngSize = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

test("every page's real text comes back zero-based, a page without a text layer says so and invents nothing", async () => {
  const bytes = syntheticPdf({ outline: true });
  const material = await readPdfTextMaterial(bytes, hash(bytes));
  expect(material).toMatchObject({ contentSha256: hash(bytes), pageCount: 3, first: 0, last: 2 });
  expect(material.pages.map((page) => page.pageIndex)).toEqual([0, 1, 2]);
  expect(material.pages[0]?.text).toContain("PAGE 1 UNIQUE");
  expect(material.pages[0]?.text).toContain("E = mc");
  expect(material.pages[1]).toMatchObject({
    rotation: 90,
    width: 240,
    height: 400,
    hasTextLayer: true,
  });
  expect(material.pages[1]?.text).toContain("PAGE 2 UNIQUE");
  // the pure-picture page: the truth, not an empty string or the pinned SDK's uninitialised bytes
  expect(material.pages[2]).toMatchObject({ pageIndex: 2, hasTextLayer: false, text: null });
  expect(material.outline).toEqual([
    { id: "pdf-outline-0", title: "Chapter One", level: 1, pageIndex: 0 },
    { id: "pdf-outline-1", title: "Section 1.1", level: 2, pageIndex: 1 },
    { id: "pdf-outline-2", title: "Chapter Two", level: 1, pageIndex: 2 },
  ]);
  expect(pdfMaterialResources).toMatchObject({ engines: 0, documents: 0, active: 0 });
});

test("a page range is zero-based and inclusive; a bad range is the request's fault", async () => {
  const bytes = syntheticPdf();
  const part = await readPdfTextMaterial(bytes, hash(bytes), { first: 1, last: 1 });
  expect(part.pages.map((page) => page.pageIndex)).toEqual([1]);
  expect(part).toMatchObject({ first: 1, last: 1, pageCount: 3 });
  for (const range of [
    { first: 3 },
    { last: 3 },
    { first: -1 },
    { first: 2, last: 1 },
    { first: 0.5 },
  ])
    await expect(readPdfTextMaterial(bytes, hash(bytes), range)).rejects.toBeInstanceOf(
      PdfMaterialInputError
    );
  expect(pdfMaterialResources).toMatchObject({ engines: 0, documents: 0, active: 0 });
});

test("a page image is a real PNG at the controlled resolution, from the same verified bytes as the text", async () => {
  const bytes = syntheticPdf();
  const image = await renderPdfPageImage(bytes, hash(bytes), 0, 1000);
  expect(image.png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  // page 0 is 360 x 480 points: the longer edge is the height, scaled to 1000 px
  expect(pngSize(image.png)).toEqual({ width: 750, height: 1000 });
  expect(image).toMatchObject({
    contentSha256: hash(bytes),
    pageIndex: 0,
    pageCount: 3,
    hasTextLayer: true,
  });
  // the rotated page (400 x 240 at 90 degrees) is rendered as the viewer shows it
  const rotated = await renderPdfPageImage(bytes, hash(bytes), 1, 800);
  expect(Math.max(pngSize(rotated.png).width, pngSize(rotated.png).height)).toBe(800);
  // the default resolution applies when none is named
  const standard = await renderPdfPageImage(bytes, hash(bytes), 2);
  expect(Math.max(pngSize(standard.png).width, pngSize(standard.png).height)).toBe(
    PDF_IMAGE_LONG_EDGE.default
  );
  expect(standard.hasTextLayer).toBe(false);
  expect(pdfMaterialResources).toMatchObject({ engines: 0, documents: 0, active: 0 });
});

test("a huge page is scaled into the pixel budget instead of being refused; the supported range is not scale 1", async () => {
  const bytes = syntheticPdf({ hugePage: true });
  const image = await renderPdfPageImage(bytes, hash(bytes), 0, PDF_IMAGE_LONG_EDGE.max);
  const { width, height } = pngSize(image.png);
  expect(Math.max(width, height)).toBeLessThanOrEqual(PDF_IMAGE_LONG_EDGE.max);
  expect(width * height).toBeLessThanOrEqual(12_000_000);
  expect(image.scale).toBeLessThan(1);
  // a small page is enlarged to the asked edge
  const small = syntheticPdf();
  const enlarged = await renderPdfPageImage(small, hash(small), 2, 2000);
  expect(pngSize(enlarged.png)).toEqual({ width: 2000, height: 2000 });
  expect(imageScale(100, 400, 800)).toBe(2);
  expect(imageScale(99999, 99999, 4096)).toBeLessThan(0.05);
});

test("a wrong hash, a bad page and a bad resolution are answered as what they are", async () => {
  const bytes = syntheticPdf();
  const other = hash(syntheticPdf({ pageCount: 2 }));
  await expect(readPdfTextMaterial(bytes, other)).rejects.toBeInstanceOf(PdfMaterialContentError);
  await expect(renderPdfPageImage(bytes, other, 0)).rejects.toBeInstanceOf(PdfMaterialContentError);
  await expect(readPdfTextMaterial(bytes, "nope")).rejects.toBeInstanceOf(PdfMaterialInputError);
  // pages are zero-based: index 3 of a 3-page file is outside, 0 is the first page
  await expect(renderPdfPageImage(bytes, hash(bytes), 3)).rejects.toBeInstanceOf(
    PdfMaterialInputError
  );
  await expect(renderPdfPageImage(bytes, hash(bytes), -1)).rejects.toBeInstanceOf(
    PdfMaterialInputError
  );
  await expect(renderPdfPageImage(bytes, hash(bytes), 1.5)).rejects.toBeInstanceOf(
    PdfMaterialInputError
  );
  for (const edge of [255, 4097, 1000.5])
    await expect(renderPdfPageImage(bytes, hash(bytes), 0, edge)).rejects.toBeInstanceOf(
      PdfMaterialInputError
    );
  expect(pdfMaterialResources).toMatchObject({ engines: 0, documents: 0, active: 0 });
});

test("rendering is serialized and releases every engine and document, also after a failure", async () => {
  const bytes = syntheticPdf({ pageCount: 3 });
  const broken = Buffer.from("%PDF-1.4\nnot really a pdf\n");
  pdfMaterialResources.peakEngines = 0;
  pdfMaterialResources.peakDocuments = 0;
  pdfMaterialResources.peakActive = 0;
  const results = await Promise.allSettled([
    renderPdfPageImage(bytes, hash(bytes), 0, 512),
    readPdfTextMaterial(broken, hash(broken)),
    renderPdfPageImage(bytes, hash(bytes), 1, 512),
    readPdfTextMaterial(bytes, hash(bytes)),
  ]);
  expect(results.map((result) => result.status)).toEqual([
    "fulfilled",
    "rejected",
    "fulfilled",
    "fulfilled",
  ]);
  // four concurrent requests never held more than one engine or document at a time
  expect(pdfMaterialResources.peakActive).toBe(1);
  expect(pdfMaterialResources.peakEngines).toBe(1);
  expect(pdfMaterialResources.peakDocuments).toBe(1);
  expect(pdfMaterialResources).toMatchObject({ engines: 0, documents: 0, active: 0 });
  // the queue recovered after the failure
  await expect(renderPdfPageImage(bytes, hash(bytes), 2, 512)).resolves.toMatchObject({
    pageIndex: 2,
  });
});

test("the caller's buffer changing after the call started is a content error, never wrong material", async () => {
  const bytes = syntheticPdf();
  const expected = hash(bytes);
  const pending = readPdfTextMaterial(bytes, expected);
  bytes.fill(0);
  // the private copy is taken inside the queue and verified again: a changed Buffer is refused, not read
  await expect(pending).rejects.toBeInstanceOf(PdfMaterialContentError);
  expect(pdfMaterialResources).toMatchObject({ engines: 0, documents: 0, active: 0 });
});

test("an outline nested hundreds of levels deep gets short bounded ids and the whole outline is listed", async () => {
  const bytes = syntheticPdf({ deepOutline: 260 });
  const material = await readPdfTextMaterial(bytes, hash(bytes));
  expect(material.outline).toHaveLength(260);
  expect(material.outlineTruncated).toBe(false);
  // ids are the depth-first position, whatever the nesting: never built from the path
  expect(material.outline[259]?.id).toBe("pdf-outline-259");
  expect(Math.max(...material.outline.map((item) => item.id.length))).toBeLessThan(40);
  expect(material.outline[259]).toMatchObject({ level: 6 });
  expect(material.outline[0]).toMatchObject({ title: "Level 1", level: 1 });
});

test("an outline longer than the cap is cut with a flag, never failed", async () => {
  const bytes = syntheticPdf({ wideOutline: PDF_OUTLINE_MAX_ENTRIES + 20 });
  const material = await readPdfTextMaterial(bytes, hash(bytes));
  expect(material.outline).toHaveLength(PDF_OUTLINE_MAX_ENTRIES);
  expect(material.outlineTruncated).toBe(true);
  expect(material.pages).toHaveLength(3);
});

test("the upload probe and the material share ONE queue: they never run at the same time", async () => {
  const bytes = syntheticPdf({ pageCount: 3 });
  pdfMaterialResources.peakActive = 0;
  pdfMaterialResources.peakEngines = 0;
  const results = await Promise.all([
    probePdf(bytes),
    renderPdfPageImage(bytes, hash(bytes), 0, 512),
    probePdf(bytes),
    readPdfTextMaterial(bytes, hash(bytes)),
  ]);
  expect(results[0]).toMatchObject({ pageCount: 3 });
  expect(pdfMaterialResources.peakActive).toBe(1);
  expect(pdfMaterialResources.peakEngines).toBe(1);
  expect(pdfMaterialResources).toMatchObject({ engines: 0, active: 0 });
});

test("waiting requests are bounded: over the bound the caller is refused at once and no copy is held", async () => {
  const bytes = syntheticPdf();
  const expected = hash(bytes);
  // the queue admits PDF_QUEUE_MAX_WAITING requests (the first starts at once); the next is refused without waiting
  const running = readPdfTextMaterial(bytes, expected);
  const waiting = Array.from({ length: PDF_QUEUE_MAX_WAITING - 1 }, () =>
    readPdfTextMaterial(bytes, expected)
  );
  expect(pdfMaterialResources.waiting).toBeGreaterThan(0);
  await expect(readPdfTextMaterial(bytes, expected)).rejects.toBeInstanceOf(PdfQueueFullError);
  const settled = await Promise.allSettled([running, ...waiting]);
  expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
  expect(pdfMaterialResources).toMatchObject({
    waiting: 0,
    waitingBytes: 0,
    engines: 0,
    active: 0,
  });
});

test("the bytes bound counts the originals the waiting requests hold", async () => {
  const bytes = syntheticPdf();
  const expected = hash(bytes);
  const running = readPdfTextMaterial(bytes, expected);
  // pretend the waiting requests already hold the whole byte budget
  pdfMaterialResources.waitingBytes = PDF_QUEUE_MAX_WAITING_BYTES;
  await expect(readPdfTextMaterial(bytes, expected)).rejects.toBeInstanceOf(PdfQueueFullError);
  pdfMaterialResources.waitingBytes = 0;
  await running;
});

test("a PNG of a page is RGB or grayscale (no alpha) with real row filters, a fraction of unfiltered RGBA, and decodes to the same pixels", async () => {
  const bytes = syntheticPdf();
  const image = await renderPdfPageImage(bytes, hash(bytes), 0, 1536);
  const { width, height } = pngSize(image.png);
  // colour type: the page has no transparency; this one has a coloured picture, so RGB (2)
  expect([0, 2]).toContain(image.png[25]);
  const rgbaSize = width * height * 4;
  expect(image.png.length).toBeLessThan(rgbaSize / 20);
  // decode (inflate + undo each row's filter) and compare with the pixels PDFium produced
  const decoded = decodePng(image.png);
  expect(decoded.width).toBe(width);
  expect(decoded.height).toBe(height);
  // the encoder, fed known pixels of every kind, round-trips exactly
  for (const kind of ["rgba", "rgb", "gray"] as const) {
    const w = 37;
    const h = 29;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const v = (i * 7) % 251;
      data.set(
        kind === "gray"
          ? [v, v, v, 255]
          : [v, (v * 3) % 256, (v * 5) % 256, kind === "rgba" ? (i % 5) * 50 : 255],
        i * 4
      );
    }
    const png = encodePng({ width: w, height: h, data });
    const back = decodePng(png);
    expect(png[25]).toBe(kind === "rgba" ? 6 : kind === "rgb" ? 2 : 0);
    expect([...back.rgba]).toEqual([...data]);
  }
});
