/**
 * The PDFium worker thread (shelf-followups 08): the pinned PDFium/EmbedPDF 2.15.1 engine runs here, not on the
 * service's event loop, because its calls are synchronous WebAssembly (drawing one page at longEdge 4096 held the
 * loop for more than a second). The main thread keeps everything else: the queue, the headroom check, the verified
 * snapshot, the deadline, the error classes (`pdfium-shared.ts`). One thread per engine: it starts with a fresh WASM
 * module and ends with it, so a stopped or timed-out engine takes its memory with it.
 *
 * This file is SELF-CONTAINED on purpose: it imports only Node built-ins and the `@embedpdf/*` runtime packages (no
 * relative module, no workspace package). So the same file runs from `src/` in the tests (Node strips its types), from
 * `dist/` after `tsc`, and next to the app's single-file bundle (`packages/app/scripts/copy-assets.mjs` copies it to
 * `dist/pdfium-worker.js`, where `pdfium-shared.ts` finds it). The PNG encoder lives here because the page is encoded
 * where it is drawn; `pdf-material.ts` re-exports it.
 *
 * Protocol (structured clone): the thread says `{ ready: true }` once the engine exists, or `{ failed }`; then each
 * `{ id, method, args, crop? }` is answered `{ id, value }` or `{ id, error }`. A page render answers
 * `{ png, width, height }` (the PNG bytes and the size of the image actually encoded).
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { crc32, deflateSync } from "node:zlib";

export const PDFIUM_WORKER_MARKER = "argelanderspace-pdfium-worker";

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}
export interface PdfRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** The engine methods the main thread may call (nothing else is forwarded). */
export const PDFIUM_WORKER_METHODS = [
  "openDocumentBuffer",
  "isEncrypted",
  "getPageTextRuns",
  "getPageGeometry",
  "extractText",
  "getBookmarks",
  "renderPage",
  "closeDocument",
  "destroy",
] as const;
export type PdfiumWorkerMethod = (typeof PDFIUM_WORKER_METHODS)[number];

/** The font fallback as plain data: the engine's font table and, for each key of it, the file on disk. */
export interface PdfiumWorkerFonts {
  fonts: Record<number, { url: string; weight: number; italic: boolean }[]>;
  files: Record<string, string>;
}
export interface PdfiumWorkerData {
  marker: typeof PDFIUM_WORKER_MARKER;
  fonts: PdfiumWorkerFonts | null;
}
export interface PdfiumWorkerRequest {
  id: number;
  method: PdfiumWorkerMethod;
  args: unknown[];
  /** renderPage only: the region of the rendered page to encode (fractions of the visible page). */
  crop?: PdfRegion;
}
/** An error as it crosses the thread boundary: its name, message and the engine's own `reason`, if any. */
export interface PdfiumWorkerError {
  name: string;
  message: string;
  reason?: unknown;
}

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

/** The pixels of a region (fractions of the rendered, visible page from its top-left); never empty, never outside. */
export function cropRgba(image: RgbaImage, region: PdfRegion): RgbaImage {
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

/** An error, or the engine's rejection, as plain data for the main thread. */
function describe(error: unknown): PdfiumWorkerError {
  if (error instanceof Error) {
    const reason = (error as { reason?: unknown }).reason;
    let plain: unknown;
    try {
      plain = reason === undefined ? undefined : structuredClone(reason);
    } catch {
      plain = undefined;
    }
    return {
      name: error.name,
      message: error.message,
      ...(plain !== undefined ? { reason: plain } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}

interface Task<T> {
  toPromise(): Promise<T>;
}
type EngineCall = (...args: unknown[]) => Task<unknown>;
interface PdfiumRuntime {
  PdfiumNative: new (wasm: unknown, options: { fontFallback: object | null }) => unknown;
  PdfEngine: new (
    native: unknown,
    options: { imageConverter: (getData: () => RgbaImage, type: string) => unknown }
  ) => Record<PdfiumWorkerMethod, EngineCall>;
}

async function startWorker(port: NonNullable<typeof parentPort>, data: PdfiumWorkerData) {
  let crop: PdfRegion | undefined;
  let encoded: { width: number; height: number } | undefined;
  let engine: Record<PdfiumWorkerMethod, EngineCall>;
  try {
    const wasm = await readFile(fileURLToPath(import.meta.resolve("@embedpdf/pdfium/pdfium.wasm")));
    const { init } = (await import("@embedpdf/pdfium")) as unknown as {
      init(options: { wasmBinary: ArrayBuffer }): Promise<unknown>;
    };
    const module = await init({ wasmBinary: Uint8Array.from(wasm).buffer });
    const runtime = (await import("@embedpdf/engines/pdfium")) as unknown as PdfiumRuntime;
    const fonts = data.fonts;
    const native = new runtime.PdfiumNative(module, {
      // Only keys of the table the main thread built are read, and only from the file it named for that key.
      fontFallback: fonts
        ? {
            fonts: fonts.fonts,
            fontLoader: (key: string): Uint8Array | null => {
              const file = Object.hasOwn(fonts.files, key) ? fonts.files[key] : undefined;
              if (!file) return null;
              try {
                return readFileSync(file);
              } catch {
                return null;
              }
            },
          }
        : null,
    });
    engine = new runtime.PdfEngine(native, {
      imageConverter: (getData, type) => {
        if (type !== "image/png") throw new Error("PNG only");
        const raw = getData();
        const out = crop ? cropRgba(raw, crop) : raw;
        encoded = { width: out.width, height: out.height };
        return Promise.resolve(encodePng(out));
      },
    });
  } catch (error) {
    port.postMessage({ failed: describe(error) });
    return;
  }
  port.on("message", async (request: PdfiumWorkerRequest) => {
    const { id, method } = request;
    try {
      if (!(PDFIUM_WORKER_METHODS as readonly string[]).includes(method))
        throw new Error("unknown PDF engine call");
      if (method === "renderPage") {
        crop = request.crop;
        encoded = undefined;
        const png = (await engine.renderPage(...request.args).toPromise()) as Buffer;
        if (!encoded) throw new Error("PDF page image was not produced");
        const bytes = new Uint8Array(png.buffer, png.byteOffset, png.byteLength);
        const own = bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
        port.postMessage({ id, value: { png: own, ...(encoded as object) } }, [
          own.buffer as ArrayBuffer,
        ]);
        return;
      }
      const value = await engine[method](...request.args).toPromise();
      port.postMessage({ id, value });
    } catch (error) {
      port.postMessage({ id, error: describe(error) });
    }
  });
  port.postMessage({ ready: true });
}

const data = workerData as Partial<PdfiumWorkerData> | null;
if (!isMainThread && parentPort && data?.marker === PDFIUM_WORKER_MARKER)
  void startWorker(parentPort, data as PdfiumWorkerData);
