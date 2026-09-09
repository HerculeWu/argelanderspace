/**
 * Figure asset naming convention for the Stage 5 tex pipeline — owned by
 * core (the fuser predicts asset names; the infra `TexFigurePort` applies
 * the same convention mechanically). Mirrors the Stage 3.1 `outName`
 * (deleted with the old pipeline in MS3b; MS1 review N5: the "/" → "__"
 * encoding is not injective — `a/b.png` vs `a__b.png` collide — inherited,
 * not a regression).
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Raster/SVG passthrough extensions (the rest convert to SVG). */
export const TEX_FIGURE_RASTER_EXTS: ReadonlySet<string> = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
]);

/** Output suffix for a source extension: ".svg" for vector (pdf/eps), own ext else. */
export function texFigureOutSuffix(srcExt: string): string {
  const e = srcExt.toLowerCase();
  return e === ".pdf" || e === ".eps" ? ".svg" : e;
}

/**
 * Output basename for a figure source: relative-path stem with "__"
 * separators + `__<srcext>` + `suffix` — `fig.pdf` → `fig__pdf.svg`,
 * `fig.png` → `fig__png.png` — so a basename shared across extensions
 * can't collide onto one output file.
 */
export function texFigureOutName(srcDir: string, src: string, suffix: string): string {
  const rel = path.relative(srcDir, src);
  const relPath =
    rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : path.basename(src);
  const ext = path.extname(relPath);
  const stemmed = (ext ? relPath.slice(0, -ext.length) : relPath).split("/").join("__");
  const srcExt = path.extname(src).slice(1).toLowerCase() || "img";
  return `${stemmed}__${srcExt}${suffix}`;
}

// ---------------------------------------------------------------------------
// Materialized asset intrinsic size (Stage 6, jump accuracy)
// ---------------------------------------------------------------------------

/**
 * Intrinsic size (CSS px) of a materialized figure asset. For SVGs with
 * absolute root width/height (the only production-reachable shape — pdftocairo
 * always emits unitless absolute dims) this mirrors the browser's <img>
 * intrinsic-dimension rule exactly, including unit conversion. The viewBox
 * fallback is defensive only: browsers scale viewBox-only SVGs to the
 * container instead (so it does NOT mirror the browser there), and mixed
 * absolute/viewBox roots get both dims from the viewBox — both shapes can't
 * survive a real pdflatex compile as passthrough sources, so neither occurs
 * in practice. PNG dims come from the IHDR header; JPEG/GIF/WebP dims are
 * parsed best-effort from the file header (Stage 7 MS1: JPEG = SOF segment
 * scan, GIF = logical screen descriptor, WebP = VP8X/VP8/VP8L chunk). All
 * raster branches are defensive header peeks — undefined for malformed files
 * and unreadable paths (stub ports in tests may not write anything).
 */
export function texFigureAssetSize(filePath: string): { w: number; h: number } | undefined {
  try {
    const lower = filePath.toLowerCase();
    if (lower.endsWith(".svg")) return svgIntrinsicSize(fs.readFileSync(filePath, "utf8"));
    if (lower.endsWith(".png")) return pngIntrinsicSize(fs.readFileSync(filePath));
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
      return jpegIntrinsicSize(fs.readFileSync(filePath));
    }
    if (lower.endsWith(".gif")) return gifIntrinsicSize(fs.readFileSync(filePath));
    if (lower.endsWith(".webp")) return webpIntrinsicSize(fs.readFileSync(filePath));
    return undefined;
  } catch {
    return undefined;
  }
}

const SVG_TAG_RE = /<svg\b([^>]*)>/;

const UNIT_PX: Record<string, number> = {
  "": 1,
  px: 1,
  pt: 96 / 72,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
};

function svgAttr(attrs: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`).exec(attrs)?.[1];
}

function lengthToPx(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const m = /^([\d.]+)\s*(px|pt|pc|in|cm|mm)?$/.exec(v.trim());
  if (m === null) return undefined; // "%" etc. → viewBox fallback
  const n = Number.parseFloat(m[1] ?? "");
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n * (UNIT_PX[m[2] ?? ""] ?? 1);
}

function svgIntrinsicSize(text: string): { w: number; h: number } | undefined {
  const tag = SVG_TAG_RE.exec(text.slice(0, 4096));
  if (tag === null) return undefined;
  const attrs = tag[1] ?? "";
  let w = lengthToPx(svgAttr(attrs, "width"));
  let h = lengthToPx(svgAttr(attrs, "height"));
  if (w === undefined || h === undefined) {
    const parts = (svgAttr(attrs, "viewBox") ?? "")
      .trim()
      .split(/[\s,]+/)
      .map(Number.parseFloat);
    const vw = parts[2];
    const vh = parts[3];
    if (
      parts.length !== 4 ||
      vw === undefined ||
      vh === undefined ||
      ![vw, vh].every((n) => Number.isFinite(n) && n > 0)
    ) {
      return undefined;
    }
    w = vw;
    h = vh;
  }
  return { w: Math.round(w * 100) / 100, h: Math.round(h * 100) / 100 };
}

function pngIntrinsicSize(buf: Buffer): { w: number; h: number } | undefined {
  // 8-byte signature + 4-byte length + "IHDR" + u32 width + u32 height (BE)
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return undefined;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return undefined;
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  return w > 0 && h > 0 ? { w, h } : undefined;
}

// SOF markers (C0–CF) carry the frame dimensions, except these three which
// are not SOFs (DHT/JPG-reserved/DAC — see ITU T.81 table B.1).
const JPEG_NON_SOF: ReadonlySet<number> = new Set([0xc4, 0xc8, 0xcc]);

function jpegIntrinsicSize(buf: Buffer): { w: number; h: number } | undefined {
  // SOI, then a marker-segment walk until the first SOF (which always
  // precedes the entropy-coded data).
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;
  let off = 2;
  while (off + 1 < buf.length) {
    if (buf[off] !== 0xff) return undefined; // marker prefix expected
    let marker = buf[off + 1] as number;
    let skip = 2;
    while (marker === 0xff && off + skip < buf.length) {
      // fill bytes before the real marker
      marker = buf[off + skip] as number;
      skip += 1;
    }
    if (marker === 0xda) return undefined; // SOS: SOF must have come earlier
    if (
      marker === 0x01 ||
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      off += skip; // standalone markers carry no length field
      continue;
    }
    if (off + skip + 2 > buf.length) return undefined;
    const len = buf.readUInt16BE(off + skip);
    if (len < 2 || off + skip + len > buf.length) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf && !JPEG_NON_SOF.has(marker)) {
      if (len < 7) return undefined;
      const h = buf.readUInt16BE(off + skip + 3);
      const w = buf.readUInt16BE(off + skip + 5);
      return w > 0 && h > 0 ? { w, h } : undefined;
    }
    off += skip + len;
  }
  return undefined;
}

function gifIntrinsicSize(buf: Buffer): { w: number; h: number } | undefined {
  // 6-byte signature + logical screen descriptor: u16 width + u16 height (LE)
  if (buf.length < 10) return undefined;
  const sig = buf.toString("ascii", 0, 6);
  if (sig !== "GIF87a" && sig !== "GIF89a") return undefined;
  const w = buf.readUInt16LE(6);
  const h = buf.readUInt16LE(8);
  return w > 0 && h > 0 ? { w, h } : undefined;
}

function webpIntrinsicSize(buf: Buffer): { w: number; h: number } | undefined {
  // RIFF u32 size + "WEBP" + first chunk fourcc; chunk data starts at 20.
  if (buf.length < 21) return undefined;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") {
    return undefined;
  }
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    // canvas width/height: 24-bit LE minus one, at chunk-data offsets 4/7
    if (buf.length < 30) return undefined;
    const w = buf.readUIntLE(24, 3) + 1;
    const h = buf.readUIntLE(27, 3) + 1;
    return { w, h };
  }
  if (chunk === "VP8 ") {
    // lossy bitstream: 3-byte frame tag, 9d 01 2a start code, then 14-bit
    // width/height (LE, top two bits are the scale factor)
    if (buf.length < 30) return undefined;
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return undefined;
    const w = buf.readUInt16LE(26) & 0x3fff;
    const h = buf.readUInt16LE(28) & 0x3fff;
    return w > 0 && h > 0 ? { w, h } : undefined;
  }
  if (chunk === "VP8L") {
    // lossless: 0x2f signature, then packed 14-bit (width-1)/(height-1)
    if (buf.length < 25 || buf[20] !== 0x2f) return undefined;
    const bits = buf.readUInt32LE(21);
    const w = (bits & 0x3fff) + 1;
    const h = ((bits >> 14) & 0x3fff) + 1;
    return { w, h };
  }
  return undefined;
}
