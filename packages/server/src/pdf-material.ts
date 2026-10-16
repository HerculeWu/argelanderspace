/**
 * Original-page material of a PDF Doc, read in Node from the one verified byte buffer (copilot ticket 20): the real
 * extractable text of each page, the outline, and one page as a PNG image. No browser, no Canvas, no OCR, no second
 * PDF engine: the same pinned PDFium/EmbedPDF 2.15.1 the upload probe uses.
 *
 * Resource rules (unchanged limits: 50 MiB, 100 pages, 512 MiB headroom):
 *  - everything runs through the process-wide PDFium queue of `pdfium-shared.ts` (the upload/arXiv probe uses the
 *    same one), so only one PDFium instance/document exists at any time;
 *  - waiting requests are bounded (count and bytes): over the bound the caller gets `PdfQueueFullError`;
 *  - inside the queue (after the headroom check) the caller's Buffer is copied once and re-verified against the
 *    expected SHA-256, so both the text and the image of a request come from the same verified snapshot and later
 *    caller changes cannot leak in; a Buffer changed while waiting is a content error, never wrong material;
 *  - the document is closed and the engine destroyed in `finally`, also on failure and timeout;
 *  - page images are controlled by the LONGER edge in pixels and a pixel budget: the scale is derived from them,
 *    so a huge or tiny page is rendered at a sensible size instead of being refused.
 */
import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import {
  buildPdfTextTarget,
  PDF_IMAGE_LONG_EDGE,
  PDF_IMAGE_MAX_PIXELS,
  PDF_MAX_BYTES,
  PDF_MAX_PAGES,
  PDF_MIN_IN_FLIGHT_HEADROOM_BYTES,
  PDF_OUTLINE_MAX_ENTRIES,
  PDF_OUTLINE_TITLE_MAX,
  type PdfAnnotation,
  type PdfGeometryPage,
  type PdfOutlineItem,
  type PdfPageMaterial,
  type PdfTextPartInput,
  pdfGeometryLastChar,
  pdfRectsWithinSlice,
  TEXT_PDF_IMAGE_MAX_PIXELS,
} from "@argelanderspace/contracts";
import { availableMemory } from "./available-memory.js";
import {
  counted,
  createPdfiumEngine,
  type PdfiumTask,
  PdfQueueFullError,
  pdfiumResources,
  type RgbaImage,
  serialized,
  timed,
} from "./pdfium-shared.js";

export { PdfQueueFullError };
/** Resource counters (see `pdfium-shared.ts`): the probe and the material share them. */
export const pdfMaterialResources = pdfiumResources;

/** The request itself is wrong (bad page index, bad resolution); the original is not at fault. */
export class PdfMaterialInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfMaterialInputError";
  }
}
/** The bytes are not the original the caller expected. */
export class PdfMaterialContentError extends Error {
  constructor() {
    super("PDF content changed");
    this.name = "PdfMaterialContentError";
  }
}
export class PdfMaterialResourceError extends Error {
  constructor() {
    super("PDF processing requires at least 512 MiB of available memory headroom");
    this.name = "PdfMaterialResourceError";
  }
}

type Task<T> = PdfiumTask<T>;
interface Page {
  index: number;
  size: { width: number; height: number };
  rotation: number;
}
interface Doc {
  pageCount: number;
  pages: Page[];
}
interface Bookmark {
  title: string;
  target?: unknown;
  children?: Bookmark[];
}
interface Engine {
  openDocumentBuffer(file: { id: string; content: ArrayBuffer }): Task<Doc>;
  isEncrypted(document: Doc): Task<boolean>;
  getPageTextRuns(document: Doc, page: Page): Task<{ runs: unknown[] }>;
  getPageGeometry(document: Doc, page: Page): Task<PdfGeometryPage>;
  extractText(document: Doc, pageIndexes: number[]): Task<string>;
  getBookmarks(document: Doc): Task<{ bookmarks: Bookmark[] }>;
  renderPage(
    document: Doc,
    page: Page,
    options: { scaleFactor: number; dpr: number; imageType: string; withAnnotations: boolean }
  ): Task<Buffer>;
  closeDocument(document: Doc): Task<unknown>;
  destroy(): Task<unknown>;
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/**
 * A small PNG: Node's zlib is the encoder, no image dependency is added. A page with no transparency (every PDFium
 * page render) is written as 8-bit RGB, or as 8-bit grayscale when every pixel is grey, and each row uses the
 * adaptive filter (None/Sub/Up/Avg/Paeth, whichever leaves the smallest residual), so the bytes shrink a lot against
 * unfiltered RGBA. The result is what both the HTTP route and the model input carry, byte for byte.
 */
export function encodePng({ width, height, data }: RgbaImage): Buffer {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    data.length !== width * height * 4
  )
    throw new Error("invalid RGBA image");
  let opaque = true;
  let gray = true;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] !== 255) {
      opaque = false;
      break;
    }
    if (gray && (data[i] !== data[i + 1] || data[i] !== data[i + 2])) gray = false;
  }
  const colorType = !opaque ? 6 : gray ? 0 : 2;
  const bpp = colorType === 6 ? 4 : colorType === 0 ? 1 : 3;
  const stride = width * bpp;
  const raw = (y: number): Uint8Array => {
    const row = new Uint8Array(stride);
    const base = y * width * 4;
    for (let x = 0; x < width; x++) {
      const at = base + x * 4;
      if (bpp === 4)
        row.set([data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0, data[at + 3] ?? 0], x * 4);
      else if (bpp === 3) row.set([data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0], x * 3);
      else row[x] = data[at] ?? 0;
    }
    return row;
  };
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  const scanlines = Buffer.alloc(height * (stride + 1));
  let previous: Uint8Array = new Uint8Array(stride);
  const candidates = [0, 1, 2, 3].map(() => new Uint8Array(stride));
  const candidate4 = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const current = raw(y);
    const sub = candidates[0] as Uint8Array;
    const up = candidates[1] as Uint8Array;
    const avg = candidates[2] as Uint8Array;
    const pae = candidate4;
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? (current[i - bpp] as number) : 0;
      const above = previous[i] as number;
      const upLeft = i >= bpp ? (previous[i - bpp] as number) : 0;
      const cur = current[i] as number;
      sub[i] = (cur - left) & 255;
      up[i] = (cur - above) & 255;
      avg[i] = (cur - ((left + above) >> 1)) & 255;
      pae[i] = (cur - paeth(left, above, upLeft)) & 255;
    }
    const cost = (row: Uint8Array) => {
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const v = row[i] as number;
        sum += v < 128 ? v : 256 - v;
      }
      return sum;
    };
    const options: [number, Uint8Array][] = [
      [0, current],
      [1, sub],
      [2, up],
      [3, avg],
      [4, pae],
    ];
    let best = options[0] as [number, Uint8Array];
    let bestCost = cost(best[1]);
    for (const option of options.slice(1)) {
      const c = cost(option[1]);
      if (c < bestCost) {
        best = option;
        bestCost = c;
      }
    }
    scanlines[y * (stride + 1)] = best[0];
    scanlines.set(best[1], y * (stride + 1) + 1);
    previous = current;
  }
  const chunk = (type: string, body: Buffer) => {
    const typed = Buffer.concat([Buffer.from(type), body]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(body.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(typed));
    return Buffer.concat([size, typed, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Scale (render pixels per PDF point) that gives the longer edge `longEdge` pixels without exceeding the pixel
 * budget. A page of any size gets a usable scale; nothing is refused for being large or small.
 */
export function imageScale(width: number, height: number, longEdge: number): number {
  const byEdge = longEdge / Math.max(width, height);
  const byPixels = Math.sqrt(PDF_IMAGE_MAX_PIXELS / (width * height));
  return Math.min(byEdge, byPixels);
}

/** What the image converter of one request records (and the region it cuts out of the rendered page, if any). */
interface Captured {
  image?: { width: number; height: number };
  crop?: { x: number; y: number; width: number; height: number };
}

/** The pixels of a region (fractions of the rendered, visible page from its top-left); never empty, never outside. */
export function cropRgba(
  image: RgbaImage,
  region: { x: number; y: number; width: number; height: number }
): RgbaImage {
  const x0 = Math.min(image.width - 1, Math.max(0, Math.floor(region.x * image.width + 1e-9)));
  const y0 = Math.min(image.height - 1, Math.max(0, Math.floor(region.y * image.height + 1e-9)));
  const x1 = Math.min(
    image.width,
    Math.max(x0 + 1, Math.ceil((region.x + region.width) * image.width - 1e-9))
  );
  const y1 = Math.min(
    image.height,
    Math.max(y0 + 1, Math.ceil((region.y + region.height) * image.height - 1e-9))
  );
  const width = x1 - x0;
  const height = y1 - y0;
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const from = ((y0 + row) * image.width + x0) * 4;
    data.set(image.data.subarray(from, from + width * 4), row * width * 4);
  }
  return { width, height, data };
}

async function withEngine<T>(
  bytes: Buffer,
  expectedHash: string,
  work: (engine: Engine, document: Doc, captured: Captured) => Promise<T>
): Promise<T> {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > PDF_MAX_BYTES)
    throw new PdfMaterialInputError("PDF is empty or larger than 50 MiB");
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new PdfMaterialInputError("invalid PDF hash");
  if (sha256(bytes) !== expectedHash) throw new PdfMaterialContentError();
  return serialized(
    () =>
      counted(async () => {
        // Headroom first, THEN the one private copy: a waiting request holds no copy of its own.
        if ((await availableMemory()) < PDF_MIN_IN_FLIGHT_HEADROOM_BYTES)
          throw new PdfMaterialResourceError();
        const snapshot = Buffer.from(bytes);
        if (sha256(snapshot) !== expectedHash) throw new PdfMaterialContentError();
        const deadline = Date.now() + 60_000;
        const captured: Captured = {};
        const engine = await createPdfiumEngine<Engine>((getData, type) => {
          if (type !== "image/png") throw new Error("PNG only");
          const raw = getData();
          const out = captured.crop ? cropRgba(raw, captured.crop) : raw;
          captured.image = { width: out.width, height: out.height };
          return Promise.resolve(encodePng(out));
        }, deadline);
        let document: Doc | undefined;
        try {
          try {
            document = await timed(
              engine
                .openDocumentBuffer({
                  id: "pdf-material",
                  content: Uint8Array.from(snapshot).buffer,
                })
                .toPromise(),
              deadline
            );
          } catch {
            throw new Error("PDF could not be opened");
          }
          pdfiumResources.documents++;
          pdfiumResources.peakDocuments = Math.max(
            pdfiumResources.peakDocuments,
            pdfiumResources.documents
          );
          if (await engine.isEncrypted(document).toPromise())
            throw new Error("encrypted PDF is not supported");
          if (document.pageCount < 1 || document.pageCount > PDF_MAX_PAGES)
            throw new Error("PDF page count is outside the supported limit");
          return await timed(work(engine, document, captured), deadline);
        } finally {
          if (document) {
            await engine
              .closeDocument(document)
              .toPromise()
              .catch(() => undefined);
            pdfiumResources.documents--;
          }
          await engine
            .destroy()
            .toPromise()
            .catch(() => undefined);
          pdfiumResources.engines--;
        }
      }),
    { bytes: bytes.length }
  );
}

const ROTATIONS = [0, 90, 180, 270] as const;

function destinationPage(target: unknown, pageCount: number): number | null {
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;
  if (!record(target)) return null;
  const destination = record(target.destination)
    ? target.destination
    : record(target.action) && record(target.action.destination)
      ? target.action.destination
      : null;
  const page = destination?.pageIndex;
  return typeof page === "number" && Number.isInteger(page) && page >= 0 && page < pageCount
    ? page
    : null;
}

/**
 * The outline as a flat depth-first list. Ids are `pdf-outline-<n>` (n = depth-first position): short, stable and
 * bounded whatever the nesting, never built from the path. Walked with an explicit stack (no recursion depth limit),
 * titles are bounded, and past PDF_OUTLINE_MAX_ENTRIES entries the rest is dropped and `truncated` says so.
 */
function outlineOf(
  tree: Bookmark[],
  pageCount: number
): { items: PdfOutlineItem[]; truncated: boolean } {
  const items: PdfOutlineItem[] = [];
  const stack: { nodes: Bookmark[]; index: number; depth: number }[] = [
    { nodes: tree, index: 0, depth: 1 },
  ];
  let truncated = false;
  while (stack.length) {
    const frame = stack[stack.length - 1] as { nodes: Bookmark[]; index: number; depth: number };
    const node = frame.nodes[frame.index++];
    if (!node) {
      stack.pop();
      continue;
    }
    if (items.length >= PDF_OUTLINE_MAX_ENTRIES) {
      truncated = true;
      break;
    }
    items.push({
      id: `pdf-outline-${items.length}`,
      title: String(node.title ?? "").slice(0, PDF_OUTLINE_TITLE_MAX),
      level: Math.min(6, frame.depth),
      pageIndex: destinationPage(node.target, pageCount),
    });
    if (node.children?.length)
      stack.push({ nodes: node.children, index: 0, depth: frame.depth + 1 });
  }
  return { items, truncated };
}

export interface PdfTextMaterial {
  contentSha256: string;
  pageCount: number;
  /** The pages that were read (zero-based, inclusive). */
  first: number;
  last: number;
  pages: PdfPageMaterial[];
  outline: PdfOutlineItem[];
  /** The outline had more entries than PDF_OUTLINE_MAX_ENTRIES; the rest is not listed. */
  outlineTruncated: boolean;
}

/**
 * Real extractable text of pages `first..last` (default all) plus the outline. A page with no text runs has
 * `hasTextLayer: false` and `text: null`: the pinned SDK's `extractText` reads an uninitialised buffer for a
 * zero-character page, so it is only called when the page really has runs.
 */
export async function readPdfTextMaterial(
  bytes: Buffer,
  expectedHash: string,
  range: { first?: number; last?: number } = {}
): Promise<PdfTextMaterial> {
  return withEngine(bytes, expectedHash, async (engine, document) => {
    const count = document.pageCount;
    const first = range.first ?? 0;
    const last = range.last ?? count - 1;
    if (
      !Number.isInteger(first) ||
      !Number.isInteger(last) ||
      first < 0 ||
      last >= count ||
      first > last
    )
      throw new PdfMaterialInputError(
        `page range is outside 0..${count - 1} (pages are zero-based)`
      );
    const pages: PdfPageMaterial[] = [];
    for (let index = first; index <= last; index++) {
      const page = document.pages[index];
      if (!page) throw new Error("PDF page is missing");
      const rotation = ROTATIONS[page.rotation];
      if (
        rotation === undefined ||
        !Number.isFinite(page.size.width) ||
        !Number.isFinite(page.size.height) ||
        page.size.width <= 0 ||
        page.size.height <= 0
      )
        throw new Error("PDF page geometry is invalid");
      const { runs } = await engine.getPageTextRuns(document, page).toPromise();
      const hasTextLayer = runs.length > 0;
      const text = hasTextLayer ? await engine.extractText(document, [index]).toPromise() : null;
      pages.push({
        pageIndex: index,
        width: page.size.width,
        height: page.size.height,
        rotation,
        hasTextLayer,
        text,
      });
    }
    let outline: PdfOutlineItem[] = [];
    let outlineTruncated = false;
    try {
      const listed = outlineOf((await engine.getBookmarks(document).toPromise()).bookmarks, count);
      outline = listed.items;
      outlineTruncated = listed.truncated;
    } catch {
      // An unreadable outline is an empty outline; the pages themselves were read.
    }
    return {
      contentSha256: expectedHash,
      pageCount: count,
      first,
      last,
      pages,
      outline,
      outlineTruncated,
    };
  });
}

/**
 * `readPdfTextMaterial` of the WHOLE document, remembered per original (copilot ticket 24): the Copilot reads the
 * whole text with every message, and an immutable original does not need PDFium again for it. The key is the content
 * hash the caller expects and `bytes` must hash to it (checked here as `withEngine` does), so a different file can
 * never be served another file's text. Readers never mutate the result. At most two originals are kept.
 */
export async function readPdfTextMaterialCached(
  bytes: Buffer,
  expectedHash: string
): Promise<PdfTextMaterial> {
  if (Buffer.isBuffer(bytes) && /^[a-f0-9]{64}$/.test(expectedHash)) {
    const cached = textCache.get(expectedHash);
    if (cached && sha256(bytes) === expectedHash) {
      textCache.delete(expectedHash);
      textCache.set(expectedHash, cached);
      return cached;
    }
  }
  const material = await readPdfTextMaterial(bytes, expectedHash);
  textCache.set(expectedHash, material);
  while (textCache.size > TEXT_CACHE_ENTRIES) {
    const oldest = textCache.keys().next().value;
    if (oldest === undefined) break;
    textCache.delete(oldest);
  }
  return material;
}
const TEXT_CACHE_ENTRIES = 2;
const textCache = new Map<string, PdfTextMaterial>();

export interface PdfPageImage {
  contentSha256: string;
  pageIndex: number;
  pageCount: number;
  png: Buffer;
  width: number;
  height: number;
  hasTextLayer: boolean;
  scale: number;
}

/** One page as a PNG at a controlled resolution (longer edge in pixels), from the same verified snapshot as the text. */
export async function renderPdfPageImage(
  bytes: Buffer,
  expectedHash: string,
  pageIndex: number,
  longEdge: number = PDF_IMAGE_LONG_EDGE.default
): Promise<PdfPageImage> {
  if (
    !Number.isInteger(longEdge) ||
    longEdge < PDF_IMAGE_LONG_EDGE.min ||
    longEdge > PDF_IMAGE_LONG_EDGE.max
  )
    throw new PdfMaterialInputError(
      `longEdge must be an integer from ${PDF_IMAGE_LONG_EDGE.min} to ${PDF_IMAGE_LONG_EDGE.max}`
    );
  if (!Number.isInteger(pageIndex) || pageIndex < 0)
    throw new PdfMaterialInputError("pageIndex must be a zero-based non-negative integer");
  return withEngine(bytes, expectedHash, async (engine, document, captured) => {
    if (pageIndex >= document.pageCount)
      throw new PdfMaterialInputError(
        `pageIndex is outside 0..${document.pageCount - 1} (pages are zero-based)`
      );
    const page = document.pages[pageIndex];
    if (
      !page ||
      !Number.isFinite(page.size.width) ||
      !Number.isFinite(page.size.height) ||
      page.size.width <= 0 ||
      page.size.height <= 0
    )
      throw new Error("PDF page geometry is invalid");
    const { runs } = await engine.getPageTextRuns(document, page).toPromise();
    const scale = imageScale(page.size.width, page.size.height, longEdge);
    const png = await engine
      .renderPage(document, page, {
        scaleFactor: scale,
        dpr: 1,
        imageType: "image/png",
        withAnnotations: false,
      })
      .toPromise();
    if (!captured.image) throw new Error("PDF page image was not produced");
    return {
      contentSha256: expectedHash,
      pageIndex,
      pageCount: document.pageCount,
      png,
      width: captured.image.width,
      height: captured.image.height,
      hasTextLayer: runs.length > 0,
      scale,
    };
  });
}

export interface PdfRegionImage {
  contentSha256: string;
  pageIndex: number;
  pageCount: number;
  png: Buffer;
  width: number;
  height: number;
  scale: number;
  /** The region as asked (fractions of the visible page); null: the whole page. */
  region: { x: number; y: number; width: number; height: number } | null;
}

/**
 * One page, or one region of it, as a PNG for a text Doc's image asset (copilot ticket 29), from the same verified
 * snapshot and through the same single PDFium queue as every other page read. The scale gives the REGION's longer edge
 * `longEdge` pixels as far as the pixel budget of the whole rendered page allows (a tiny region of a big page is
 * rendered at the best scale the budget gives, never refused); the region is then cut out of the render. The page and
 * the region are only parameters of this one call: nothing about them is stored.
 */
export async function renderPdfRegionImage(
  bytes: Buffer,
  expectedHash: string,
  pageIndex: number,
  region: { x: number; y: number; width: number; height: number } | undefined,
  longEdge: number
): Promise<PdfRegionImage> {
  if (!Number.isInteger(pageIndex) || pageIndex < 0)
    throw new PdfMaterialInputError("pageIndex must be a zero-based non-negative integer");
  if (!Number.isInteger(longEdge) || longEdge < 1)
    throw new PdfMaterialInputError("longEdge must be a positive integer");
  return withEngine(bytes, expectedHash, async (engine, document, captured) => {
    if (pageIndex >= document.pageCount)
      throw new PdfMaterialInputError(
        `pageIndex is outside 0..${document.pageCount - 1} (pages are zero-based)`
      );
    const page = document.pages[pageIndex];
    if (
      !page ||
      !Number.isFinite(page.size.width) ||
      !Number.isFinite(page.size.height) ||
      page.size.width <= 0 ||
      page.size.height <= 0
    )
      throw new Error("PDF page geometry is invalid");
    const rect = region ?? { x: 0, y: 0, width: 1, height: 1 };
    const regionEdge = Math.max(rect.width * page.size.width, rect.height * page.size.height);
    const byEdge = longEdge / regionEdge;
    const byPixels = Math.sqrt(TEXT_PDF_IMAGE_MAX_PIXELS / (page.size.width * page.size.height));
    const scale = Math.min(byEdge, byPixels);
    captured.crop = region ? rect : undefined;
    const png = await engine
      .renderPage(document, page, {
        scaleFactor: scale,
        dpr: 1,
        imageType: "image/png",
        withAnnotations: false,
      })
      .toPromise();
    if (!captured.image) throw new Error("PDF page image was not produced");
    return {
      contentSha256: expectedHash,
      pageIndex,
      pageCount: document.pageCount,
      png,
      width: captured.image.width,
      height: captured.image.height,
      scale,
      region: region ?? null,
    };
  });
}

export type PdfTextTargetResult =
  | { ok: true; target: Extract<PdfAnnotation, { kind: "highlight" }>["target"] }
  | { ok: false; detail: string };

/**
 * The text target of a text annotation (copilot ticket 21), from REAL text of the verified original: each part's quote
 * is located in its page's extractable text (exactly once, or at the occurrence the caller names), the characters'
 * rectangles come from the engine's own page geometry through the same computation the Reader's selection uses
 * (`pdfRectsWithinSlice`, then `buildPdfTextTarget` with the Doc's stored page geometry), and the stored quote joins
 * the parts with a line break like a cross-page selection. Runs in the shared PDFium queue on the same verified
 * snapshot as the text material. A page without a text layer cannot have a text target; text and geometry that do not
 * line up are refused rather than guessed.
 */
export async function resolvePdfTextTarget(
  bytes: Buffer,
  expectedHash: string,
  parts: readonly PdfTextPartInput[],
  pageGeometry: ReadonlyArray<{ width: number; height: number; rotation: number }>
): Promise<PdfTextTargetResult> {
  return withEngine(bytes, expectedHash, async (engine, document): Promise<PdfTextTargetResult> => {
    const selection: { pageIndex: number; segmentRects: ReturnType<typeof pdfRectsWithinSlice> }[] =
      [];
    for (const part of parts) {
      if (part.pageIndex >= document.pageCount)
        return {
          ok: false,
          detail: `pageIndex ${part.pageIndex} is outside 0..${document.pageCount - 1} (pages are zero-based)`,
        };
      const page = document.pages[part.pageIndex];
      if (!page) throw new Error("PDF page is missing");
      const { runs } = await engine.getPageTextRuns(document, page).toPromise();
      if (runs.length === 0)
        return {
          ok: false,
          detail: `page ${part.pageIndex} has no text layer (hasTextLayer false): text cannot be selected on it. Use a rectangle or a page or document comment`,
        };
      const text = await engine.extractText(document, [part.pageIndex]).toPromise();
      const geometry = await engine.getPageGeometry(document, page).toPromise();
      if (pdfGeometryLastChar(geometry) + 1 !== text.length)
        return {
          ok: false,
          detail: `the text layer of page ${part.pageIndex} cannot be mapped to character positions, so no text annotation can be made on it; use a rectangle or a comment`,
        };
      const starts: number[] = [];
      for (let at = text.indexOf(part.quote); at !== -1; at = text.indexOf(part.quote, at + 1))
        starts.push(at);
      if (starts.length === 0)
        return {
          ok: false,
          detail: `the quote does not occur in the text of page ${part.pageIndex}; copy it exactly from that page's text in the reading (line breaks included)`,
        };
      if (part.occurrence === undefined && starts.length > 1)
        return {
          ok: false,
          detail: `the quote occurs ${starts.length} times in the text of page ${part.pageIndex}; give occurrence (0 to ${starts.length - 1}) or a longer quote that occurs once`,
        };
      const start = starts[part.occurrence ?? 0];
      if (start === undefined)
        return {
          ok: false,
          detail: `occurrence ${part.occurrence} does not exist: the quote occurs ${starts.length} time(s) in the text of page ${part.pageIndex}`,
        };
      const segmentRects = pdfRectsWithinSlice(geometry, start, start + part.quote.length - 1);
      if (segmentRects.length === 0)
        return {
          ok: false,
          detail: `the quote on page ${part.pageIndex} has no visible characters (only line breaks or spaces generated by the text layer)`,
        };
      selection.push({ pageIndex: part.pageIndex, segmentRects });
    }
    const quote = parts.map((part) => part.quote);
    if (quote.join("\n").trim() === "")
      return { ok: false, detail: "the quote is blank; nothing visible to anchor to" };
    // Node's PDFium reports the geometry of a page in the page as it is VIEWED (its /Rotate already applied, `size` is the
    // viewed size and the glyph boxes of a 90 degree page are tall and thin), which is exactly the visible-page frame
    // the sidecar stores. The conversion `buildPdfTextTarget` applies for a page's rotation is for geometry in the
    // unrotated frame, so here every page is normalised as it is viewed (rotation 0); applying it again would turn the
    // rectangles of a rotated page a second time.
    const target = buildPdfTextTarget(
      quote,
      selection,
      pageGeometry.map((page) => ({ width: page.width, height: page.height, rotation: 0 }))
    );
    if (!target)
      return {
        ok: false,
        detail:
          "the page geometry of the quoted text is not valid, so no text annotation can be made there; use a rectangle or a comment",
      };
    return { ok: true, target };
  });
}
